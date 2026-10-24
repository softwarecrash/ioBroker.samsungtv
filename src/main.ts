import * as utils from '@iobroker/adapter-core';
import { Bonjour, type Browser, type Service } from 'bonjour-service';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import WebSocket from 'ws';

import { type DeviceManagementService, SamsungTvDeviceManagement } from './lib/SamsungTvDeviceManagement';
import {
    SAMSUNG_APPS,
    TvNotAnsweringError,
    closeAppRest,
    findInstalledApps,
    findVisibleApp,
    launchAppRest,
} from './lib/apps';
import { type ArtTarget, artChannelUrl, getArtMode, getCurrentArtwork, setArtMode } from './lib/artMode';
import { SsdpClient } from './lib/discovery/SsdpClient';
import { SamsungTv as SamsungHJ } from './lib/hj/SamsungTv';
import { LegacyRemote } from './lib/legacy/LegacyRemote';
import { shouldMigrateLegacySamsung } from './lib/legacyMigrationTools';
import { getPingArguments, normalizeMac, parseArpTable, parseMacFromArpOutput } from './lib/networkTools';
import { acceptPowerUpdate, startPowerTransition } from './lib/powerTransitionTools';
import { boundedSeconds } from './lib/timerTools';
import { type ChannelMessage, PersistentChannel, reconnectDelay } from './lib/persistentChannel';
import { parseScene, runScene, sceneDelay, sceneId, type SceneStep } from './lib/scenes';
import { YouTubeLounge, getYouTubeScreenId, parseYouTubeTarget, readDialDevice } from '@iobroker/youtube-lounge';
import { SOURCE_MENU_DELAY, SOURCE_MENU_KEY_GAP, parseSourceMenu, sourceMenuKeys } from './lib/sourceMenu';
import { evaluateTizenTokenMessage } from './lib/tizenTokenTools';
import { wakeOnLan } from './lib/wakeOnLan';
import { TV_APPS, TV_INPUTS, TV_INPUT_KEYS, TV_KEYS, TV_KEY_CODES, statesOf } from './lib/tvValues';
import {
    MASTER_CHANNEL_XML,
    RENDERING_CONTROL_LOOKUP_TTL,
    RENDERING_CONTROL_URN,
    buildSoapEnvelope,
    normalizeAbsoluteMute,
    normalizeAbsoluteVolume,
    parseUpnpErrorCode,
    renderingControlRetryTimestamp,
    upnpErrorDescription,
    wellKnownRenderingControlUrl,
} from './lib/upnpTools';
import type {
    DeviceInfoUpdate,
    DeviceStatus,
    DiscoveredDevice,
    HjIdentity,
    InstalledApp,
    RawConfiguredDevice,
    RuntimeDevice,
    TokenStore,
    TvApi,
    TvTransport,
} from './types';

/** A TV the Device Manager acts on: configured, or only discovered so far */
type AnyDevice = RuntimeDevice | DiscoveredDevice;

/** JSON or XML answered by a TV - every vendor and model year uses other keys */
type JsonObject = Record<string, unknown>;

/** A discovery candidate before it was probed */
interface DiscoveryCandidate {
    ip: string;
    source: string[];
    name?: string;
    usn?: string;
    location?: string;
    st?: string;
    server?: string;
    mdns?: string;
    renderingControlUrl?: string;
    renderingControlEventUrl?: string;
}

/** An active UPnP event subscription of a TV */
interface UpnpSubscription {
    sid: string;
    eventUrl: string;
    expiresAt: number;
    renewTimer?: ioBroker.Timeout;
}

/** What the UPnP device description tells about a TV */
interface UpnpDescription {
    friendlyName?: string;
    manufacturer?: string;
    modelName?: string;
    UDN: string;
    renderingControlUrl: string;
    renderingControlEventUrl: string;
}

const HJ_DEVICE_CONFIG = {
    appId: '721b6fce-4ee6-48ba-8045-955a539edadb',
    userId: '654321',
};

const WS_CONNECT_TIMEOUT = 5000;
const WS_SEND_DELAY = 200;
const PAIRING_TIMEOUT = 20000;
const HJ_INFO_TIMEOUT = 4000;
const NO_TOKEN = '__no_token__';
const MAX_POLL_INTERVAL_SECONDS = 3600;
const MAX_SCAN_INTERVAL_SECONDS = 86400;
const MAX_DISCOVERY_TIMEOUT_SECONDS = 60;
const UPNP_REQUEST_TIMEOUT = 1500;
const DEVICE_ERROR_QUALITY = 0x44;
const POWER_POLL_INTERVAL = 2000;
const POWER_POLL_DURATION = 30000;
/** How long switching on waits and repeats Wake-on-LAN, in ms: a TV that is still shutting down misses the packet */
const WAKE_DURATION = 60000;
/** How long an app start is repeated while the app API of the TV does not answer yet, in ms */
const APP_LAUNCH_RETRY = 20000;
/** Pause between two Wake-on-LAN packets while the TV stays unreachable, in ms */
const WOL_RETRY_INTERVAL = 10000;
/** How long KEY_POWER is held to switch The Frame off instead of to Art Mode, in ms */
const FRAME_POWER_OFF_HOLD = 3000;
/** The REST API of The Frame does not answer for up to ~30 s while an app starts: offline only after this many polls */
const OFFLINE_AFTER_FAILED_POLLS = 3;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const xmlParser = new XMLParser({ ignoreAttributes: false });

let adapter: utils.AdapterInstance;

let devicesById = new Map<string, RuntimeDevice>();
let devicesByName = new Map<string, RuntimeDevice>();
let devicesByMac = new Map<string, RuntimeDevice>();
const discoveredByIp = new Map<string, DiscoveredDevice>();
let tokens: TokenStore = { tizen: {}, hj: {} };
let configuredDevicesRaw: RawConfiguredDevice[] = [];
let pingUnavailable = false;

let pollTimer: ioBroker.Timeout | null | undefined;
let scanTimer: ioBroker.Timeout | null | undefined;
let registrySaveTimer: ioBroker.Timeout | null | undefined;
let registryWritePromise: Promise<void> = Promise.resolve();
let registryDirty = false;
let pollIntervalMs = 30000;
let scanIntervalMs = 300000;
let isUnloading = false;
/** Lounge sessions with the YouTube app, per TV */
const youtubeSessions = new Map<string, YouTubeLounge>();
let upnpNotifyServer: http.Server | null = null;
let upnpNotifyPort = 0;
const upnpSubscriptionsByDeviceId = new Map<string, UpnpSubscription>(); // deviceId -> { sid, eventUrl, renewTimer, expiresAt }
const upnpSidToDeviceId = new Map<string, string>(); // sid -> deviceId

/** The channels kept open to a TV while it is on */
interface DeviceChannels {
    remote?: PersistentChannel;
    art?: PersistentChannel;
    failures: number;
    nextAttempt: number;
    /** The TV refused the token; no new attempt before pairing anew */
    unauthorized: boolean;
    /** A connection attempt is running; two polls at the same time must not open two channels */
    connecting?: Promise<void>;
}

const channelsByDevice = new Map<string, DeviceChannels>();

/** The value as a string, or an empty string for anything else */
function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** The value as an object, or an empty object for anything else */
function asObject(value: unknown): JsonObject {
    return value && typeof value === 'object' ? (value as JsonObject) : {};
}

/** `ws` delivers a Buffer by default, but `RawData` allows more than that - normalize it to a string */
function rawDataToString(data: WebSocket.RawData): string {
    if (Buffer.isBuffer(data)) {
        return data.toString();
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString();
    }
    return Buffer.from(data).toString();
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function createAdapter(options: Partial<utils.AdapterOptions> = {}): utils.AdapterInstance {
    adapter = new utils.Adapter({
        ...options,
        name: 'samsungtv',
        ready: main,
        stateChange: onStateChange,
        message: onMessage,
        unload: onUnload,
    });
    return adapter;
}

async function onUnload(callback: () => void): Promise<void> {
    try {
        isUnloading = true;
        if (pollTimer) {
            adapter.clearTimeout(pollTimer);
            pollTimer = null;
        }
        if (scanTimer) {
            adapter.clearTimeout(scanTimer);
            scanTimer = null;
        }
        if (registrySaveTimer) {
            adapter.clearTimeout(registrySaveTimer);
            registrySaveTimer = null;
        }
        if (registryDirty) {
            await persistRegistry();
        }
        cleanupUpnpSubscriptions();
        stopUpnpNotifyServer();
        for (const device of devicesById.values()) {
            closeChannels(device);
        }
        for (const lounge of youtubeSessions.values()) {
            lounge.close();
        }
        callback();
    } catch {
        callback();
    }
}

function sanitizeName(name: unknown): string {
    if (!name || typeof name !== 'string') {
        return '';
    }
    const cleaned = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .replace(/--+/g, '-');
    return cleaned;
}

function ensureUniqueName(desired: string, existingSet: Set<string>, fallbackBase: string): string {
    const name = desired || fallbackBase || 'tv';
    if (!existingSet.has(name)) {
        return name;
    }
    let i = 2;
    while (existingSet.has(`${name}-${i}`)) {
        i++;
    }
    return `${name}-${i}`;
}

function normalizeId(id: unknown): string {
    if (!id || typeof id !== 'string') {
        return '';
    }
    return id
        .replace(/^uuid:/i, '')
        .replace(/^urn:uuid:/i, '')
        .trim();
}

function normalizeDeviceId(id: unknown): string {
    const norm = normalizeId(id);
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(norm)) {
        return normalizeMac(norm);
    }
    return norm;
}

function applyParsedTokens(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object') {
        return false;
    }
    const store = parsed as Partial<TokenStore>;
    tokens.tizen = store.tizen || {};
    tokens.hj = store.hj || {};
    return true;
}

async function loadTokensFromConfig(): Promise<void> {
    tokens = { tizen: {}, hj: {} };
    if (!adapter.config.tokens) {
        return;
    }
    if (typeof adapter.config.tokens !== 'string') {
        return;
    }
    try {
        const parsed: unknown = JSON.parse(adapter.config.tokens);
        if (applyParsedTokens(parsed)) {
            return;
        }
    } catch {
        // Older versions wrote encryptedNative fields without using updateConfig.
        // Read the stored value once and let ioBroker encrypt it correctly below.
    }

    try {
        const instance = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
        const storedTokens: unknown = instance && instance.native && instance.native.tokens;
        if (typeof storedTokens === 'string' && applyParsedTokens(JSON.parse(storedTokens))) {
            await adapter.updateConfig({ tokens: storedTokens });
            adapter.config.tokens = storedTokens;
            adapter.log.info('Migrated token storage to ioBroker encryptedNative format.');
            return;
        }
    } catch {
        // Report a generic error below without exposing token contents.
    }

    adapter.log.warn('Could not parse encrypted tokens from config.');
}

async function migrateLegacyConfigFromSamsung(): Promise<boolean> {
    if (adapter.name === 'samsung') {
        return false;
    }
    if (!shouldMigrateLegacySamsung(adapter.instance)) {
        return false;
    }
    if (adapter.config && adapter.config.migratedFromSamsung) {
        return false;
    }

    const hasDevices = Array.isArray(adapter.config.devices) && adapter.config.devices.length > 0;
    if (hasDevices) {
        return false;
    }

    let legacy: ioBroker.Object | null | undefined;
    try {
        legacy = await adapter.getForeignObjectAsync('system.adapter.samsung.0');
    } catch {
        legacy = null;
    }
    if (!legacy || !legacy.native) {
        return false;
    }

    const merged = { ...adapter.config, ...legacy.native, migratedFromSamsung: true };
    try {
        await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: merged });
        adapter.config = merged;
        adapter.log.info('Imported configuration from legacy samsung.0 adapter.');
        return true;
    } catch (e) {
        adapter.log.warn(`Could not import legacy samsung.0 config: ${errorMessage(e)}`);
        return false;
    }
}

function getTizenTokenRaw(deviceId: string): string {
    return (tokens.tizen && tokens.tizen[deviceId]) || '';
}

function getHjIdentity(deviceId: string): unknown {
    return (tokens.hj && tokens.hj[deviceId]) || null;
}

async function setInMemoryToken(deviceId: string, tokenValue: string): Promise<void> {
    if (!tokens.tizen) {
        tokens.tizen = {};
    }
    tokens.tizen[deviceId] = tokenValue;
    await persistRegistry();
}

async function setInMemoryHjIdentity(deviceId: string, identity: unknown): Promise<void> {
    if (!tokens.hj) {
        tokens.hj = {};
    }
    tokens.hj[deviceId] = identity;
    await persistRegistry();
}

function cloneConfigDevices(): RawConfiguredDevice[] {
    return JSON.parse(
        JSON.stringify(Array.isArray(adapter.config.devices) ? adapter.config.devices : []),
    ) as RawConfiguredDevice[];
}

function getRegistryPath(): string {
    return path.join(utils.getAbsoluteInstanceDataDir(adapter), 'device-registry.json');
}

async function loadPersistentRegistry(): Promise<void> {
    const registryPath = getRegistryPath();
    try {
        const stored = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
            version?: number;
            devices?: unknown;
            encryptedSecrets?: unknown;
        } | null;
        if (!stored || stored.version !== 1 || !Array.isArray(stored.devices)) {
            throw new Error('unsupported registry format');
        }
        configuredDevicesRaw = stored.devices as RawConfiguredDevice[];
        if (typeof stored.encryptedSecrets === 'string' && stored.encryptedSecrets) {
            const decrypted = adapter.decrypt(stored.encryptedSecrets);
            if (!applyParsedTokens(JSON.parse(decrypted))) {
                throw new Error('invalid encrypted secrets');
            }
        }
        adapter.log.debug(`Loaded persistent device registry with ${configuredDevicesRaw.length} devices.`);
        return;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            adapter.log.warn(`Could not load persistent device registry: ${errorMessage(e)}`);
        }
    }

    configuredDevicesRaw = cloneConfigDevices();
    await persistRegistry();
    if (configuredDevicesRaw.length) {
        adapter.log.info(`Migrated ${configuredDevicesRaw.length} configured TVs to the persistent device registry.`);
    }
}

async function persistRegistry(): Promise<void> {
    registryDirty = false;
    const registryPath = getRegistryPath();
    const temporaryPath = `${registryPath}.tmp`;
    const payload = JSON.stringify(
        {
            version: 1,
            devices: configuredDevicesRaw,
            encryptedSecrets: adapter.encrypt(JSON.stringify(tokens)),
        },
        null,
        2,
    );
    registryWritePromise = registryWritePromise.then(async () => {
        await fs.mkdir(path.dirname(registryPath), { recursive: true });
        await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryPath, registryPath);
    });
    try {
        await registryWritePromise;
    } catch (e) {
        registryDirty = true;
        adapter.log.warn(`Failed to persist device registry: ${errorMessage(e)}`);
        throw e;
    }
}

function getConfiguredDevices(): RuntimeDevice[] {
    const list = configuredDevicesRaw;
    const existingNames = new Set<string>();
    const result: RuntimeDevice[] = [];

    for (const raw of list) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const rawMac = normalizeMac(raw.mac || '');
        let id = normalizeId(raw.id || raw.uuid || raw.usn || '');
        if ((!id || looksLikeIp(id)) && rawMac) {
            id = rawMac;
        }
        if (!id) {
            id = normalizeId(raw.ip || '');
        }
        id = normalizeDeviceId(id);
        if (!id) {
            adapter.log.warn('Skipping device without stable id in config.');
            continue;
        }
        const rawName = raw.name || raw.friendlyName || raw.model || 'tv';
        const safeName = ensureUniqueName(
            sanitizeName(rawName) || `tv-${id.slice(0, 6)}`,
            existingNames,
            `tv-${id.slice(0, 6)}`,
        );
        existingNames.add(safeName);

        const device: RuntimeDevice = {
            id,
            name: safeName,
            displayName: raw.displayName || raw.friendlyName || rawName,
            ip: raw.ip || '',
            mac: normalizeMac(raw.mac || ''),
            model: raw.model || '',
            api: (raw.api || 'unknown') as TvApi,
            protocol: (raw.protocol || '') as TvTransport,
            port: raw.port || 0,
            uuid: raw.uuid || '',
            source: raw.source || 'config',
            renderingControlUrl: raw.renderingControlUrl || '',
            renderingControlEventUrl: raw.renderingControlEventUrl || '',
            tokenAuthSupport: typeof raw.tokenAuthSupport === 'boolean' ? raw.tokenAuthSupport : undefined,
            hjAvailable: typeof raw.hjAvailable === 'boolean' ? raw.hjAvailable : undefined,
            frameTv: raw.frameTv === true,
            sourceMenu: Array.isArray(raw.sourceMenu) ? raw.sourceMenu.map(String) : [],
            apps: Array.isArray(raw.apps) ? raw.apps : undefined,
        };
        result.push(device);
    }
    return result;
}

function rebuildDeviceMaps(devices: RuntimeDevice[]): void {
    devicesById = new Map();
    devicesByName = new Map();
    devicesByMac = new Map();
    for (const device of devices) {
        devicesById.set(device.id, device);
        devicesByName.set(device.name, device);
        if (device.mac) {
            devicesByMac.set(device.mac, device);
        }
    }
}

async function reloadConfiguredDevices(): Promise<RuntimeDevice[]> {
    const devices = getConfiguredDevices();
    await reconcileDeviceObjects(devices);
    rebuildDeviceMaps(devices);
    for (const device of devices) {
        await ensureDeviceObjects(device);
        await updateDeviceInfoStates(device);
    }
    return devices;
}

function configuredDeviceMatches(raw: RawConfiguredDevice, id: string): boolean {
    if (!raw || typeof raw !== 'object') {
        return false;
    }
    const rawId = normalizeDeviceId(normalizeId(raw.id || raw.uuid || raw.usn || raw.mac || raw.ip || ''));
    return rawId === normalizeDeviceId(id);
}

function findDiscoveredDevice(id: string): DiscoveredDevice | null {
    const normalizedId = normalizeDeviceId(id);
    return Array.from(discoveredByIp.values()).find(device => normalizeDeviceId(device.id) === normalizedId) || null;
}

function isConfiguredDevice(candidate: Partial<AnyDevice>): boolean {
    const id = normalizeDeviceId(candidate.id || '');
    const mac = normalizeMac(candidate.mac || '');
    return getConfiguredDevices().some(
        device =>
            (id && device.id === id) ||
            (mac && device.mac === mac) ||
            (!id && !mac && candidate.ip && device.ip === candidate.ip),
    );
}

function suggestDeviceName(candidate: Partial<AnyDevice> & { displayName?: string }): string {
    const used = new Set(getConfiguredDevices().map(device => device.name));
    const base =
        sanitizeName(candidate.name || candidate.displayName || candidate.model || 'tv') ||
        `tv-${normalizeDeviceId(candidate.id || '').slice(0, 6) || 'samsung'}`;
    return ensureUniqueName(base, used, 'tv-samsung');
}

function normalizeManagedDevice(candidate: RawConfiguredDevice): RawConfiguredDevice & RuntimeDevice {
    const mac = normalizeMac(candidate.mac || '');
    const id = normalizeDeviceId(candidate.id || candidate.uuid || candidate.usn || mac || candidate.ip || '');
    if (!id) {
        throw new Error('A stable device ID, MAC address, or IP address is required');
    }
    if (!candidate.ip && !mac) {
        throw new Error('An IP or MAC address is required');
    }
    const name = sanitizeName(candidate.name || candidate.displayName || candidate.model || '');
    if (!name) {
        throw new Error('A device name is required');
    }
    return {
        ...candidate,
        id,
        name,
        displayName: candidate.displayName || candidate.name || candidate.model || name,
        ip: candidate.ip || '',
        mac,
        model: candidate.model || '',
        api: (candidate.api || 'unknown') as TvApi,
        protocol: (candidate.protocol || '') as TvTransport,
        port: Number(candidate.port) || 0,
        uuid: candidate.uuid || '',
        source: candidate.source || 'manual',
    };
}

async function addManagedDevice(candidate: RawConfiguredDevice): Promise<RuntimeDevice> {
    const device = normalizeManagedDevice(candidate);
    if (isConfiguredDevice(device)) {
        throw new Error('This TV is already configured');
    }
    const usedNames = new Set(getConfiguredDevices().map(entry => entry.name));
    if (usedNames.has(device.name)) {
        throw new Error('This device name is already in use');
    }
    configuredDevicesRaw = [...configuredDevicesRaw, device];
    await persistRegistry();
    await reloadConfiguredDevices();
    return device;
}

async function renameManagedDevice(id: string, requestedName: string): Promise<void> {
    const name = sanitizeName(requestedName || '');
    if (!name) {
        throw new Error('A device name is required');
    }
    const existing = getConfiguredDevices();
    if (existing.some(device => device.id !== normalizeDeviceId(id) && device.name === name)) {
        throw new Error('This device name is already in use');
    }
    let found = false;
    for (const raw of configuredDevicesRaw) {
        if (configuredDeviceMatches(raw, id)) {
            raw.name = name;
            raw.displayName = requestedName;
            found = true;
            break;
        }
    }
    if (!found) {
        throw new Error('Unknown device');
    }
    await persistRegistry();
    await reloadConfiguredDevices();
}

async function removeManagedDevice(id: string): Promise<void> {
    const normalizedId = normalizeDeviceId(id);
    const before = configuredDevicesRaw;
    const after = before.filter(raw => !configuredDeviceMatches(raw, normalizedId));
    if (after.length === before.length) {
        throw new Error('Unknown device');
    }
    configuredDevicesRaw = after;
    if (tokens.tizen) {
        delete tokens.tizen[normalizedId];
    }
    if (tokens.hj) {
        delete tokens.hj[normalizedId];
    }
    await persistRegistry();
    await reloadConfiguredDevices();
}

async function pairManagedTizen(device: AnyDevice): Promise<void> {
    await storeManagedTizenToken(device, await pairTizen(device));
}

async function setManagedTizenToken(device: AnyDevice, token: string): Promise<void> {
    await validateTizenToken(device, token);
    await storeManagedTizenToken(device, token);
}

async function storeManagedTizenToken(device: AnyDevice, token: string): Promise<void> {
    await setInMemoryToken(device.id, token);
    channelsByDevice.delete(device.id);
    if (device.api !== 'tizen') {
        device.api = 'tizen';
        for (const raw of configuredDevicesRaw) {
            if (configuredDeviceMatches(raw, device.id)) {
                raw.api = 'tizen';
            }
        }
        await persistRegistry();
    }
    await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
}

async function confirmManagedHjPin(device: AnyDevice, pin: string): Promise<void> {
    const identity = await hjConfirmPin(device, pin);
    await setInMemoryHjIdentity(device.id, identity);
    await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
}

function createDeviceManagementService(): DeviceManagementService<AnyDevice> {
    return {
        getConfiguredDevices,
        getDiscoveredDevices: () => Array.from(discoveredByIp.values()),
        isConfigured: isConfiguredDevice,
        isDevicePaired,
        suggestName: suggestDeviceName,
        findDevice: (id: string) => devicesById.get(normalizeDeviceId(id)) || findDiscoveredDevice(id),
        discover: () => performDiscovery(false),
        addDevice: addManagedDevice,
        renameDevice: renameManagedDevice,
        removeDevice: removeManagedDevice,
        requestPin: hjRequestPin,
        confirmPin: confirmManagedHjPin,
        pairTizen: pairManagedTizen,
        setTizenToken: setManagedTizenToken,
        getSourceMenu: device => devicesById.get(device.id)?.sourceMenu || [],
        setSourceMenu: async (device, menu) => {
            const configured = configuredDeviceOf(device);
            updateRegistryDevice(configured, { sourceMenu: parseSourceMenu(menu) });
            await persistRegistry();
            await ensureDeviceObjects(configured);
        },
        sendTestKey: device => sendKey(configuredDeviceOf(device), 'KEY_INFO'),
        getCapabilities: device => {
            const configured = devicesById.get(device.id);
            return configured
                ? { inputs: inputStatesOf(configured), apps: appStatesOf(configured), artMode: !!configured.frameTv }
                : { inputs: {}, apps: {}, artMode: false };
        },
        control: async (device, control, value) => {
            const configured = configuredDeviceOf(device);
            const value_ = value === null ? '' : value;
            await handleControl(configured, `${configured.name}.control.${control}`, control, value_);
        },
    };
}

/** The configured TV behind a device of the Device Manager */
function configuredDeviceOf(device: AnyDevice): RuntimeDevice {
    const configured = devicesById.get(device.id);
    if (!configured) {
        throw new Error('Unknown device');
    }
    return configured;
}

function scheduleRegistrySave(): void {
    if (isUnloading) {
        return;
    }
    registryDirty = true;
    if (registrySaveTimer) {
        adapter.clearTimeout(registrySaveTimer);
    }
    registrySaveTimer = adapter.setTimeout(async () => {
        registrySaveTimer = null;
        try {
            await persistRegistry();
            adapter.log.debug('Persisted updated device registry.');
        } catch {
            // persistRegistry logs the generic failure without exposing data.
        }
    }, 1500);
}

function updateConfigDeviceFromDiscovery(match: Partial<RuntimeDevice> | null, info: DeviceInfoUpdate): void {
    if (!adapter.config) {
        return;
    }
    const list = configuredDevicesRaw;
    if (!list.length) {
        return;
    }

    let updated = false;
    const infoId = normalizeDeviceId(info.id || '');
    const infoMac = normalizeMac(info.mac || '');
    const infoIp = info.ip || '';

    for (const dev of list) {
        if (!dev || typeof dev !== 'object') {
            continue;
        }
        const devId = normalizeDeviceId(normalizeId(dev.id || dev.uuid || dev.usn || dev.ip || dev.mac || ''));
        const devMac = normalizeMac(dev.mac || '');
        const devIp = dev.ip || '';
        const isMatch =
            (infoId && devId && infoId === devId) ||
            (infoMac && devMac && infoMac === devMac) ||
            (!infoId && !infoMac && infoIp && devIp && infoIp === devIp) ||
            (match && match.id && devId && match.id === devId);
        if (!isMatch) {
            continue;
        }

        if (info.ip && dev.ip !== info.ip) {
            dev.ip = info.ip;
            updated = true;
        }
        if (info.mac && !dev.mac) {
            dev.mac = info.mac;
            updated = true;
        }
        if (info.api && info.api !== 'unknown' && dev.api !== info.api) {
            dev.api = info.api;
            updated = true;
        }
        if (info.protocol && dev.protocol !== info.protocol) {
            dev.protocol = info.protocol;
            updated = true;
        }
        if (info.port && dev.port !== info.port) {
            dev.port = info.port;
            updated = true;
        }
        if (info.renderingControlUrl && dev.renderingControlUrl !== info.renderingControlUrl) {
            dev.renderingControlUrl = info.renderingControlUrl;
            updated = true;
        }
        if (info.renderingControlEventUrl && dev.renderingControlEventUrl !== info.renderingControlEventUrl) {
            dev.renderingControlEventUrl = info.renderingControlEventUrl;
            updated = true;
        }
        if (typeof info.hjAvailable === 'boolean' && dev.hjAvailable !== info.hjAvailable) {
            dev.hjAvailable = info.hjAvailable;
            updated = true;
        }
        if (typeof info.tokenAuthSupport === 'boolean' && dev.tokenAuthSupport !== info.tokenAuthSupport) {
            dev.tokenAuthSupport = info.tokenAuthSupport;
            updated = true;
        }
    }

    if (updated) {
        scheduleRegistrySave();
    }
}

async function checkLegacyObjects(): Promise<void> {
    const namespaces = [adapter.namespace];
    if (adapter.name !== 'samsung') {
        namespaces.push('samsung.0');
    }
    const legacyIds: string[] = [];
    for (const ns of namespaces) {
        legacyIds.push(`${ns}.Power`, `${ns}.command`, `${ns}.control`, `${ns}.apps`, `${ns}.config`);
    }
    try {
        const found: string[] = [];
        for (const id of legacyIds) {
            const obj = await adapter.getForeignObjectAsync(id);
            if (obj) {
                found.push(id);
            }
        }
        if (found.length) {
            adapter.log.warn(
                `Legacy Samsung adapter objects detected in the same namespace. ` +
                    `Please remove or migrate old objects to avoid conflicts. Found: ${found.join(', ')}`,
            );
        }
        if (adapter.name !== 'samsung') {
            try {
                const legacyInstance = await adapter.getForeignObjectAsync('system.adapter.samsung.0');
                if (legacyInstance) {
                    adapter.log.info(
                        'Legacy adapter instance samsung.0 detected. Disable/remove it after migration to avoid confusion.',
                    );
                }
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }
}

async function reconcileDeviceObjects(devices: RuntimeDevice[]): Promise<void> {
    const startKey = `${adapter.namespace}.`;
    const endKey = `${adapter.namespace}.香`;
    let view: { rows: { id: string; value: ioBroker.Object | null }[] } | null;
    try {
        view = await adapter.getObjectViewAsync('system', 'device', { startkey: startKey, endkey: endKey });
    } catch {
        view = null;
    }

    const deviceObjects: { _id: string; obj: ioBroker.Object }[] = [];
    if (view && view.rows) {
        for (const row of view.rows) {
            if (row.value && row.value.type === 'device') {
                deviceObjects.push({ _id: row.id, obj: row.value });
            }
        }
    } else {
        try {
            const objs = await adapter.getForeignObjectsAsync(`${adapter.namespace}.*`);
            for (const id of Object.keys(objs)) {
                const obj = objs[id];
                if (obj && obj.type === 'device') {
                    deviceObjects.push({ _id: id, obj });
                }
            }
        } catch {
            // ignore
        }
    }

    const byId = new Map(devices.map(d => [d.id, d]));
    const byName = new Map(devices.map(d => [d.name, d]));

    for (const entry of deviceObjects) {
        const objId = entry._id;
        const obj = entry.obj || ({} as ioBroker.Object);
        const nativeId = obj.native && obj.native.deviceId ? normalizeDeviceId(obj.native.deviceId) : '';
        let match: RuntimeDevice | undefined | null = null;
        if (nativeId && byId.has(nativeId)) {
            match = byId.get(nativeId);
        } else {
            const name = objId.startsWith(`${adapter.namespace}.`) ? objId.slice(adapter.namespace.length + 1) : '';
            if (name && byName.has(name)) {
                match = byName.get(name);
            }
        }

        if (match) {
            const desiredPrefix = `${adapter.namespace}.${match.name}`;
            if (!obj.native) {
                obj.native = {};
            }
            if (obj.native.deviceId !== match.id) {
                try {
                    obj.native.deviceId = match.id;
                    await adapter.setForeignObjectAsync(objId, { ...obj, _id: objId } as ioBroker.SettableObject);
                } catch (e) {
                    adapter.log.warn(`Failed to update deviceId for ${objId}: ${errorMessage(e)}`);
                }
            }
            if (objId !== desiredPrefix) {
                adapter.log.info(`Renaming device objects ${objId} -> ${desiredPrefix}`);
                await renamePrefix(objId, desiredPrefix);
            }
            continue;
        }

        adapter.log.info(`Removing stale device objects ${objId}`);
        await deletePrefix(objId);
    }
}

async function deletePrefix(prefix: string): Promise<void> {
    if (!prefix) {
        return;
    }
    try {
        await adapter.delForeignObjectAsync(prefix, { recursive: true });
        return;
    } catch {
        // ignore, fallback below
    }
    let objs: Record<string, ioBroker.Object> = {};
    try {
        objs = await adapter.getForeignObjectsAsync(`${prefix}.*`);
    } catch {
        objs = {};
    }
    const allIds = Object.keys(objs);
    allIds.push(prefix);
    for (const oldId of allIds.sort((a, b) => b.length - a.length)) {
        try {
            await adapter.delForeignObjectAsync(oldId, { recursive: false });
        } catch {
            // ignore
        }
    }
}

async function renamePrefix(oldPrefix: string, newPrefix: string): Promise<void> {
    if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) {
        return;
    }
    const objs = await adapter.getForeignObjectsAsync(`${oldPrefix}.*`);
    const allIds = Object.keys(objs);
    allIds.push(oldPrefix); // include root device object

    // Create new objects first
    for (const oldId of allIds) {
        const obj = oldId === oldPrefix ? await adapter.getForeignObjectAsync(oldId) : objs[oldId];
        if (!obj) {
            continue;
        }
        const newId = oldId.replace(oldPrefix, newPrefix);
        const newObj = { ...obj, _id: newId } as ioBroker.SettableObject;
        try {
            await adapter.setForeignObjectAsync(newId, newObj);
            if (obj.type === 'state') {
                const state = await adapter.getForeignStateAsync(oldId);
                if (state) {
                    await adapter.setForeignStateAsync(newId, state);
                }
            }
        } catch (e) {
            adapter.log.warn(`Failed to create renamed object ${newId}: ${errorMessage(e)}`);
        }
    }

    // Delete old objects (recursive cleanup to avoid empty folders)
    await deletePrefix(oldPrefix);
}

async function ensureDeviceObjects(device: RuntimeDevice): Promise<void> {
    const base = device.name;
    await adapter.setObjectNotExistsAsync(base, {
        type: 'device',
        common: { name: device.displayName || device.name },
        native: { deviceId: device.id },
    });

    await adapter.setObjectNotExistsAsync(`${base}.info`, {
        type: 'channel',
        common: { name: 'Info' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync(`${base}.state`, {
        type: 'channel',
        common: { name: 'State' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync(`${base}.control`, {
        type: 'channel',
        common: { name: 'Control' },
        native: {},
    });

    await ensureState(`${base}.info.id`, 'Stable ID', 'string', 'info.serial', device.id, true);
    await ensureState(`${base}.info.ip`, 'IP', 'string', 'info.ip', device.ip || '', true);
    await ensureState(`${base}.info.mac`, 'MAC', 'string', 'info.mac', device.mac || '', true);
    await ensureState(`${base}.info.model`, 'Model', 'string', 'info.model', device.model || '', true);
    await ensureState(`${base}.info.uuid`, 'UUID', 'string', 'text', device.uuid || '', true);
    await ensureState(`${base}.info.api`, 'API', 'string', 'text', device.api || '', true);
    await ensureState(`${base}.info.lastSeen`, 'Last Seen', 'number', 'value.time', 0, true);
    await ensureState(`${base}.info.paired`, 'Paired', 'boolean', 'indicator', false, true);
    await ensureState(`${base}.info.online`, 'Online', 'boolean', 'indicator.reachable', false, true);
    // the same, inverted, in the role the device types of the type-detector look for (UNREACH)
    await ensureState(`${base}.info.unreach`, 'Unreachable', 'boolean', 'indicator.maintenance.unreach', true, true);
    await ensureState(`${base}.info.tokenAuthSupport`, 'Token Auth Support', 'boolean', 'indicator', false, true);
    await removeStateIfExists(`${base}.info.remoteAvailable`);
    await removeStateIfExists(`${base}.info.hjAvailable`);

    await ensureState(`${base}.state.power`, 'Power', 'boolean', 'sensor.switch', false, true);
    await ensureState(`${base}.state.volume`, 'Volume', 'number', 'value.volume', 0, true, {
        min: 0,
        max: 100,
        unit: '%',
    });
    // not media.mute: with its default role the type-detector takes a state as MUTE even if it is read-only,
    // and would control the TV through this mirror instead of control.muted
    await ensureState(`${base}.state.muted`, 'Muted', 'boolean', 'indicator', false, true);
    if (device.api === 'tizen') {
        // not media.app: the type-detector would take this read-only state as the APP to control
        await ensureState(`${base}.state.app`, 'App in the foreground', 'string', 'text', '', true, {
            states: appStatesOf(device),
        });
    } else {
        await removeStateIfExists(`${base}.state.app`);
    }
    await removeStateIfExists(`${base}.state.source`);

    // The control channel is a `tv` of the type-detector: switch.power and media.key are required, the
    // fixed values of media.key, media.app and media.input are listed in common.states. key, launchApp
    // and source keep accepting Samsung codes (KEY_HOME, app IDs) as before.
    await ensureState(`${base}.control.power`, 'Power', 'boolean', 'switch.power', false, false);
    await ensureState(`${base}.control.wol`, 'Wake', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.key`, 'Key', 'string', 'media.key', '', false, { states: { ...TV_KEYS } });
    await ensureState(`${base}.control.volumeUp`, 'Volume Up', 'boolean', 'button.volume.up', false, false);
    await ensureState(`${base}.control.volumeDown`, 'Volume Down', 'boolean', 'button.volume.down', false, false);
    await ensureState(`${base}.control.mute`, 'Mute', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.channelUp`, 'Channel Up', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.channelDown`, 'Channel Down', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.home`, 'Home', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.launchApp`, 'Launch App', 'string', 'media.app', '', false, {
        states: appStatesOf(device),
    });
    if (device.api === 'tizen') {
        await ensureState(`${base}.control.closeApp`, 'Close App', 'string', 'text', '', false, {
            states: appStatesOf(device),
        });
        // a video ID, playlist, channel or YouTube URL, or play / pause / next / previous
        await ensureState(`${base}.control.youtube`, 'Play on YouTube', 'string', 'text', '', false);
    } else {
        await removeStateIfExists(`${base}.control.closeApp`);
        await removeStateIfExists(`${base}.control.youtube`);
    }
    await ensureState(`${base}.control.source`, 'Source', 'string', 'media.input', '', false, {
        states: inputStatesOf(device),
    });
    await ensureState(`${base}.control.volume`, 'Volume', 'number', 'level.volume', 0, false, {
        min: 0,
        max: 100,
        unit: '%',
    });
    await ensureState(`${base}.control.muted`, 'Muted', 'boolean', 'media.mute', false, false);
    if (device.frameTv) {
        await ensureState(`${base}.control.artMode`, 'Art Mode', 'boolean', 'switch.mode.art', false, false);
        await ensureState(`${base}.state.artwork`, 'Artwork', 'string', 'text', '', true);
    } else {
        await removeStateIfExists(`${base}.control.artMode`);
        await removeStateIfExists(`${base}.state.artwork`);
    }
    await ensureSceneStates(device);
}

/** The apps of `media.app`: those found on the TV, all known ones until the TV was asked */
function appStatesOf(device: RuntimeDevice): Record<string, string> {
    if (device.api !== 'tizen' && device.api !== 'unknown') {
        return {};
    }
    return statesOf(TV_APPS, device.apps ? device.apps.map(app => app.key) : Object.keys(SAMSUNG_APPS));
}

/** The inputs of `media.input`: those of the configured source menu, otherwise those with a direct key */
function inputStatesOf(device: RuntimeDevice): Record<string, string> {
    const menu = device.sourceMenu || [];
    return statesOf(TV_INPUTS, menu.length ? menu : Object.keys(TV_INPUT_KEYS));
}

/** The scenes of the settings that belong to this TV, keyed by their state ID */
function scenesOf(device: RuntimeDevice): Map<string, { name: string; steps: SceneStep[]; delay: number }> {
    const scenes = new Map<string, { name: string; steps: SceneStep[]; delay: number }>();
    for (const scene of Array.isArray(adapter.config.scenes) ? adapter.config.scenes : []) {
        const id = sceneId(scene?.name);
        if (!id || (scene.device && scene.device !== device.name)) {
            continue;
        }
        try {
            scenes.set(id, { name: scene.name.trim(), steps: parseScene(scene.steps), delay: sceneDelay(scene.delay) });
        } catch (e) {
            adapter.log.warn(`Scene "${scene.name}" ignored: ${errorMessage(e)}`);
        }
    }
    return scenes;
}

/** One button per scene in `<tv>.scenes`; buttons of removed scenes are deleted */
async function ensureSceneStates(device: RuntimeDevice): Promise<void> {
    const scenes = scenesOf(device);
    const channel = `${device.name}.scenes`;
    const existing = await adapter.getObjectViewAsync('system', 'state', {
        startkey: `${adapter.namespace}.${channel}.`,
        endkey: `${adapter.namespace}.${channel}.香`,
    });
    for (const row of existing.rows) {
        if (!scenes.has(row.id.split('.').pop()!)) {
            await removeStateIfExists(row.id.slice(adapter.namespace.length + 1));
        }
    }
    if (!scenes.size) {
        try {
            await adapter.delObjectAsync(channel);
        } catch {
            // not there
        }
        return;
    }
    await adapter.setObjectNotExistsAsync(channel, { type: 'channel', common: { name: 'Scenes' }, native: {} });
    for (const [id, scene] of scenes) {
        await ensureState(`${channel}.${id}`, scene.name, 'boolean', 'button', false, false);
    }
}

async function ensureState(
    id: string,
    name: string,
    type: ioBroker.CommonType,
    role: string,
    def: ioBroker.StateValue | undefined,
    readOnly: boolean,
    extra: Partial<ioBroker.StateCommon> = {},
): Promise<void> {
    const common: ioBroker.StateCommon = {
        name,
        type,
        role,
        read: !role.startsWith('button'),
        write: !readOnly,
        def,
        ...extra,
    };
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common,
        native: {},
    });
    // Keep adapter-owned metadata current when roles evolve between versions.
    await adapter.extendObjectAsync(id, { common });
    if (extra.states) {
        // extendObject merges `states`, so values that are gone (an uninstalled app) would stay
        const obj = await adapter.getObjectAsync(id);
        if (obj && JSON.stringify(obj.common.states) !== JSON.stringify(extra.states)) {
            obj.common.states = extra.states;
            await adapter.setObjectAsync(id, obj);
        }
    }
    if (def !== undefined) {
        const existing = await adapter.getStateAsync(id);
        if (existing === null || existing === undefined) {
            await adapter.setStateAsync(id, def, true);
        }
    }
}

async function removeStateIfExists(id: string): Promise<void> {
    try {
        const obj = await adapter.getObjectAsync(id);
        if (!obj) {
            return;
        }
        try {
            await adapter.delStateAsync(id);
        } catch {
            // ignore
        }
        await adapter.delObjectAsync(id);
    } catch {
        // ignore
    }
}

async function main(): Promise<void> {
    isUnloading = false;
    (
        adapter as utils.AdapterInstance & { samsungTvDeviceManagement?: SamsungTvDeviceManagement<AnyDevice> }
    ).samsungTvDeviceManagement = new SamsungTvDeviceManagement(adapter, createDeviceManagementService());
    await migrateLegacyConfigFromSamsung();
    await loadTokensFromConfig();
    await loadPersistentRegistry();
    await checkLegacyObjects();

    await reloadConfiguredDevices();

    adapter.subscribeStates('*.control.*');
    adapter.subscribeStates('*.scenes.*');

    pollIntervalMs = boundedSeconds(adapter.config.pollInterval, 30, 10, MAX_POLL_INTERVAL_SECONDS) * 1000;
    await pollDevices();
    schedulePoll();

    if (adapter.config.autoScan) {
        scanIntervalMs = boundedSeconds(adapter.config.autoScanInterval, 300, 30, MAX_SCAN_INTERVAL_SECONDS) * 1000;
        await performDiscovery(true);
        scheduleScan();
    }
}

function schedulePoll(): void {
    if (isUnloading) {
        return;
    }
    pollTimer = adapter.setTimeout(async () => {
        pollTimer = null;
        try {
            await pollDevices();
        } catch (e) {
            adapter.log.warn(`Scheduled polling failed: ${errorMessage(e)}`);
        } finally {
            schedulePoll();
        }
    }, pollIntervalMs);
}

function scheduleScan(): void {
    if (isUnloading) {
        return;
    }
    scanTimer = adapter.setTimeout(async () => {
        scanTimer = null;
        try {
            await performDiscovery(true);
        } catch (e) {
            adapter.log.warn(`Scheduled discovery failed: ${errorMessage(e)}`);
        } finally {
            scheduleScan();
        }
    }, scanIntervalMs);
}

async function updateDeviceInfoStates(device: AnyDevice): Promise<void> {
    const base = device.name;
    await adapter.setStateAsync(`${base}.info.ip`, device.ip || '', true);
    await adapter.setStateAsync(`${base}.info.mac`, device.mac || '', true);
    await adapter.setStateAsync(`${base}.info.model`, device.model || '', true);
    await adapter.setStateAsync(`${base}.info.uuid`, device.uuid || '', true);
    await adapter.setStateAsync(`${base}.info.api`, device.api || '', true);
    await adapter.setStateAsync(`${base}.info.paired`, isDevicePaired(device), true);
    if (typeof device.tokenAuthSupport === 'boolean') {
        await adapter.setStateAsync(`${base}.info.tokenAuthSupport`, device.tokenAuthSupport, true);
    }
}

function isDevicePaired(device: Pick<RuntimeDevice, 'api' | 'id' | 'tokenAuthSupport'>): boolean {
    if (device.api === 'tizen') {
        const token = (tokens.tizen && tokens.tizen[device.id]) || '';
        if (!token) {
            return false;
        }
        if (token === NO_TOKEN && device.tokenAuthSupport === true) {
            return false;
        }
        return true;
    }
    if (device.api === 'hj') {
        return !!getHjIdentity(device.id);
    }
    return false;
}

async function pollDevices(): Promise<void> {
    for (const device of devicesById.values()) {
        await pollDevice(device);
    }
}

async function pollDevice(device: RuntimeDevice): Promise<void> {
    try {
        const status = await checkDeviceStatus(device);
        if (!status.online && (await adapter.getStateAsync(`${device.name}.info.online`))?.val === true) {
            device.failedPolls = (device.failedPolls ?? 0) + 1;
            if (!device.channelLost && device.failedPolls < OFFLINE_AFTER_FAILED_POLLS) {
                adapter.log.debug(`${device.name} does not answer (${device.failedPolls}), keeping its state for now`);
                return;
            }
        }
        device.failedPolls = 0;
        device.channelLost = false;
        const audio = resolveAudioStates(device, status);
        await adapter.setStateAsync(`${device.name}.info.online`, status.online, true);
        await adapter.setStateAsync(`${device.name}.info.unreach`, !status.online, true);
        if (acceptPowerUpdate(device, status.power, Date.now())) {
            await adapter.setStateAsync(`${device.name}.state.power`, status.power, true);
            await adapter.setStateAsync(`${device.name}.control.power`, status.power, true);
        }
        await adapter.setStateAsync(`${device.name}.state.volume`, audio.volume, true);
        await adapter.setStateAsync(`${device.name}.state.muted`, audio.muted, true);
        if (typeof audio.volume === 'number') {
            await adapter.setStateAsync(`${device.name}.control.volume`, audio.volume, true);
        }
        if (typeof audio.muted === 'boolean') {
            await adapter.setStateAsync(`${device.name}.control.muted`, audio.muted, true);
        }

        if (status.online) {
            ensureUpnpEventSubscription(device).catch(e =>
                adapter.log.debug(`UPnP subscribe failed for ${device.name}: ${errorMessage(e)}`),
            );
        }
        maintainChannels(device, status.online && status.power).catch(e =>
            adapter.log.debug(`Channels of ${device.name}: ${errorMessage(e)}`),
        );
        await pollArtMode(device, status.online && status.power);
        await pollVisibleApp(device, status.online && status.power);
        if (status.online && status.power && device.api === 'tizen' && !device.apps) {
            lookUpApps(device).catch(e =>
                adapter.log.debug(`App lookup failed for ${device.name}: ${errorMessage(e)}`),
            );
        }
    } catch {
        // ignore
    }
}

/**
 * Keep the remote channel (and the art channel of The Frame) open while the TV is on, close them when it is off.
 * Never without a token: the TV would ask the user to allow the connection.
 */
async function maintainChannels(device: RuntimeDevice, on: boolean): Promise<void> {
    if (device.api !== 'tizen') {
        return;
    }
    if (!on) {
        closeChannels(device);
        return;
    }
    let entry = channelsByDevice.get(device.id);
    if (!entry) {
        entry = { failures: 0, nextAttempt: 0, unauthorized: false };
        channelsByDevice.set(device.id, entry);
    }
    const token = tizenTokenOf(device);
    if (
        entry.connecting ||
        entry.unauthorized ||
        (!token && device.tokenAuthSupport !== false) ||
        Date.now() < entry.nextAttempt
    ) {
        return entry.connecting;
    }
    entry.connecting = connectChannels(device, entry, token).finally(() => (entry.connecting = undefined));
    return entry.connecting;
}

async function connectChannels(device: RuntimeDevice, entry: DeviceChannels, token: string): Promise<void> {
    try {
        if (!entry.remote?.connected) {
            entry.remote = openChannel(device, entry, buildTizenWsCandidates(device, token, ['v2'])[0]!);
            await entry.remote.connect();
            adapter.log.debug(`Remote channel of ${device.name} open`);
        }
        if (device.frameTv && !entry.art?.connected) {
            entry.art = openChannel(device, entry, artChannelUrl(device.ip, token), true);
            await entry.art.connect();
            adapter.log.debug(`Art channel of ${device.name} open`);
        }
        entry.failures = 0;
    } catch (e) {
        entry.failures++;
        entry.nextAttempt = Date.now() + reconnectDelay(entry.failures);
        adapter.log.debug(`Channel of ${device.name} not open (${errorMessage(e)}), next attempt later`);
    }
}

function openChannel(
    device: RuntimeDevice,
    entry: DeviceChannels,
    url: string,
    waitForReady = false,
): PersistentChannel {
    const channel = new PersistentChannel(url, waitForReady);
    channel.on('close', ({ intentional }: { intentional: boolean }) => {
        if (!intentional && !isUnloading) {
            // off or power cut: look now instead of at the next poll
            device.channelLost = true;
            adapter.log.debug(`${device.name} closed a channel`);
            scheduleDevicePoll(device, 1000);
        }
    });
    channel.on('unauthorized', () => {
        entry.unauthorized = true;
        adapter.log.warn(`${device.name} refused the token, please pair again`);
    });
    channel.on('message', (message: ChannelMessage) => {
        handleArtEvent(device, message).catch(e =>
            adapter.log.debug(`Art event of ${device.name}: ${errorMessage(e)}`),
        );
    });
    return channel;
}

/** Events of the art channel: Art Mode switched, another picture, standby */
async function handleArtEvent(device: RuntimeDevice, message: ChannelMessage): Promise<void> {
    if (message.event !== 'd2d_service_message' || !message.data || typeof message.data !== 'object') {
        return;
    }
    const data = message.data as { event?: string; value?: unknown; status?: unknown; content_id?: unknown };
    if (data.event === 'art_mode_changed' && !(device.artSwitchUntil && Date.now() < device.artSwitchUntil)) {
        const value = data.value ?? data.status;
        if (typeof value === 'string') {
            await adapter.setStateAsync(`${device.name}.control.artMode`, value.toLowerCase() === 'on', true);
        }
    } else if (
        (data.event === 'image_selected' || data.event === 'slideshow_image_changed') &&
        typeof data.content_id === 'string'
    ) {
        await adapter.setStateAsync(`${device.name}.state.artwork`, data.content_id, true);
    } else if (data.event === 'go_to_standby') {
        scheduleDevicePoll(device, 2000);
    }
}

function closeChannels(device: RuntimeDevice): void {
    const entry = channelsByDevice.get(device.id);
    entry?.remote?.close();
    entry?.art?.close();
    if (entry) {
        entry.remote = entry.art = undefined;
    }
}

/** Read which of the found apps is in the foreground into `state.app` */
async function pollVisibleApp(device: RuntimeDevice, on: boolean): Promise<void> {
    if (device.api !== 'tizen' || !device.apps) {
        return;
    }
    const app = on ? await findVisibleApp(device.ip, device.apps) : '';
    if (app !== null) {
        await adapter.setStateAsync(`${device.name}.state.app`, app, true);
    }
}

/** The token for a websocket channel of a Tizen TV, empty if it needs none */
function tizenTokenOf(device: RuntimeDevice): string {
    const token = getTizenTokenRaw(device.id);
    return token === NO_TOKEN ? '' : token || '';
}

/** Art requests go over the open art channel if there is one; The Frame answers only there then */
function artTargetOf(device: RuntimeDevice): ArtTarget {
    const channel = channelsByDevice.get(device.id)?.art;
    return channel?.connected ? channel : artChannelUrl(device.ip, tizenTokenOf(device));
}

/** Read the Art Mode of a The Frame into `control.artMode`; off while the TV is off */
async function pollArtMode(device: RuntimeDevice, on: boolean): Promise<void> {
    if (!device.frameTv || (device.artSwitchUntil && Date.now() < device.artSwitchUntil)) {
        return;
    }
    let artMode = false;
    if (on) {
        try {
            artMode = await getArtMode(artTargetOf(device));
        } catch (e) {
            adapter.log.debug(`Art Mode of ${device.name} not readable: ${errorMessage(e)}`);
            return;
        }
    }
    await adapter.setStateAsync(`${device.name}.control.artMode`, artMode, true);
    if (on) {
        try {
            const artwork = await getCurrentArtwork(artTargetOf(device));
            await adapter.setStateAsync(`${device.name}.state.artwork`, artwork.contentId, true);
        } catch (e) {
            adapter.log.debug(`Artwork of ${device.name} not readable: ${errorMessage(e)}`);
        }
    }
}

/** Switch the Art Mode; the poll leaves `control.artMode` alone meanwhile, the TV reports the old value */
async function setArtModeOf(device: RuntimeDevice, on: boolean): Promise<void> {
    if (!device.frameTv) {
        throw new Error(`${device.name} has no Art Mode`);
    }
    const target = artTargetOf(device);
    device.artSwitchUntil = Date.now() + 20000;
    try {
        // the TV reports no art_mode_changed if nothing changes
        if ((await getArtMode(target)) !== on) {
            await setArtMode(target, on);
            if (!on) {
                // off leaves the TV in the art selection; the source menu opens on the last input
                await sendKey(device, 'KEY_SOURCE');
                await sleep(SOURCE_MENU_DELAY);
                await sendKey(device, 'KEY_ENTER');
            }
        }
    } finally {
        device.artSwitchUntil = 0;
    }
    await adapter.setStateAsync(`${device.name}.control.artMode`, on, true);
    adapter.log.debug(`Art Mode of ${device.name} ${on ? 'on' : 'off'}`);
}

/** Note whether the TV is a The Frame; the Art Mode state is created or removed accordingly */
async function applyFrameTvSupport(device: RuntimeDevice, info: unknown): Promise<void> {
    const value = asObject(asObject(info).device).FrameTVSupport;
    if (value === undefined) {
        return;
    }
    const frameTv = value === true || value === 'true';
    if (frameTv !== device.frameTv) {
        updateRegistryDevice(device, { frameTv });
        await ensureDeviceObjects(device);
    }
}

/** Ask the TV which of the known apps are installed and offer those in `control.launchApp` */
async function lookUpApps(device: RuntimeDevice): Promise<InstalledApp[]> {
    if (device.appLookupRunning) {
        return device.apps || [];
    }
    device.appLookupRunning = true;
    try {
        const apps = await findInstalledApps(device.ip);
        if (!apps) {
            throw new Error('The TV does not answer. Is it switched on?');
        }
        adapter.log.debug(`Apps found on ${device.name}: ${apps.map(app => app.key).join(', ') || '-'}`);
        updateRegistryDevice(device, { apps });
        await ensureDeviceObjects(device);
        return apps;
    } finally {
        device.appLookupRunning = false;
    }
}

/** Store settings and findings of a TV in its registry entry */
function updateRegistryDevice(
    device: RuntimeDevice,
    patch: Pick<RawConfiguredDevice, 'frameTv' | 'sourceMenu' | 'apps'>,
): void {
    for (const raw of configuredDevicesRaw) {
        if (configuredDeviceMatches(raw, device.id)) {
            Object.assign(raw, patch);
        }
    }
    Object.assign(device, patch);
    scheduleRegistrySave();
}

function resolveAudioStates(
    device: RuntimeDevice,
    status: DeviceStatus,
): { volume: number | null; muted: boolean | null } {
    if (!device || !status || typeof status !== 'object') {
        return { volume: null, muted: null };
    }
    const now = Date.now();
    const previousVolume = typeof device.lastKnownVolume === 'number' ? device.lastKnownVolume : null;
    let volume = typeof status.volume === 'number' && Number.isFinite(status.volume) ? status.volume : null;
    let muted = typeof status.muted === 'boolean' ? status.muted : null;

    if (typeof device.expectedVolumeUntil === 'number' && now >= device.expectedVolumeUntil) {
        delete device.expectedVolume;
        delete device.expectedVolumeUntil;
    }

    if (status.volumeSource === 'upnp' && typeof volume === 'number') {
        if (
            typeof device.expectedVolume === 'number' &&
            typeof device.expectedVolumeUntil === 'number' &&
            now < device.expectedVolumeUntil
        ) {
            if (volume === device.expectedVolume) {
                device.volumeTelemetryReliable = true;
            } else {
                device.volumeTelemetryReliable = false;
            }
        }
        if (volume > 0) {
            // Seeing a non-zero value is a strong sign that telemetry is usable.
            device.volumeTelemetryReliable = true;
        }
    }

    if (status.volumeSource === 'upnp' && device.volumeTelemetryReliable === false) {
        // Do not override with known-bad telemetry.
        volume = previousVolume;
    } else if (status.volumeSource === 'upnp' && device.api === 'tizen' && device.volumeTelemetryReliable !== true) {
        // Many Tizen models report 0 via UPnP even though volume is not 0.
        if (volume === 0) {
            volume = previousVolume;
        }
    }

    if (volume !== null) {
        device.lastKnownVolume = volume;
    }

    if (typeof device.expectedMutedUntil === 'number' && now >= device.expectedMutedUntil) {
        delete device.expectedMuted;
        delete device.expectedMutedUntil;
    }

    if (status.mutedSource === 'upnp' && typeof muted === 'boolean') {
        if (
            typeof device.expectedMuted === 'boolean' &&
            typeof device.expectedMutedUntil === 'number' &&
            now < device.expectedMutedUntil
        ) {
            if (muted === device.expectedMuted) {
                device.mutedTelemetryReliable = true;
            } else {
                device.mutedTelemetryReliable = false;
            }
        }

        if (muted === true) {
            // Seeing "true" at least once is a strong sign that telemetry is usable for this model.
            device.mutedTelemetryReliable = true;
        }
    }

    if (status.mutedSource === 'upnp' && device.mutedTelemetryReliable === false) {
        // Do not override with known-bad telemetry.
        muted = typeof device.lastKnownMuted === 'boolean' ? device.lastKnownMuted : null;
    }

    if (status.mutedSource === 'upnp' && device.api === 'tizen' && device.mutedTelemetryReliable !== true) {
        // Many Tizen models never report mute=true via UPnP. Treat mute=false as unknown unless proven reliable.
        if (muted === false) {
            muted = typeof device.lastKnownMuted === 'boolean' ? device.lastKnownMuted : null;
        }
    }

    if (status.mutedSource === 'upnp' && muted === false && device.lastKnownMuted === true) {
        const holdUntil = device.mutedShadowUntil || 0;
        if (now < holdUntil) {
            muted = true;
        }
    }

    if (muted !== null) {
        device.lastKnownMuted = muted;
    }

    return { volume, muted };
}

function scheduleDevicePoll(device: RuntimeDevice, delayMs: number): void {
    if (!device) {
        return;
    }
    const delay = Math.max(500, delayMs || 0);
    adapter.setTimeout(() => pollDevice(device), delay);
}

function extractPowerState(info: unknown): string {
    if (!info || typeof info !== 'object') {
        return '';
    }
    const record = info as JsonObject;
    const device = asObject(record.device || record);
    const candidates = [
        device.PowerState,
        device.powerState,
        device.powerstate,
        record.PowerState,
        record.powerState,
        record.powerstate,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim().toLowerCase();
        }
    }
    return '';
}

function interpretPowerState(value: string): boolean | null {
    if (!value) {
        return null;
    }
    const v = value.toLowerCase();
    if (['on', 'active', 'wake', 'awake'].includes(v)) {
        return true;
    }
    if (['standby', 'off', 'inactive', 'sleep'].includes(v)) {
        return false;
    }
    return null;
}

function extractVolumeValue(info: unknown): number | null {
    if (!info || typeof info !== 'object') {
        return null;
    }
    const record = info as JsonObject;
    const device = asObject(record.device || record);
    const candidates = [
        device.volume,
        device.Volume,
        device.currentVolume,
        device.CurrentVolume,
        record.volume,
        record.Volume,
        record.currentVolume,
        record.CurrentVolume,
    ];
    for (const value of candidates) {
        const parsed = parseInt(value as string, 10);
        if (!Number.isNaN(parsed)) {
            return Math.max(0, Math.min(100, parsed));
        }
    }
    return null;
}

function normalizeMutedValue(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes', 'muted'].includes(v)) {
            return true;
        }
        if (['0', 'false', 'off', 'no', 'unmuted'].includes(v)) {
            return false;
        }
    }
    return null;
}

function extractMutedValue(info: unknown): boolean | null {
    if (!info || typeof info !== 'object') {
        return null;
    }
    const record = info as JsonObject;
    const device = asObject(record.device || record);
    const candidates = [
        device.mute,
        device.Mute,
        device.muted,
        device.Muted,
        device.currentMute,
        device.CurrentMute,
        record.mute,
        record.Mute,
        record.muted,
        record.Muted,
        record.currentMute,
        record.CurrentMute,
    ];
    for (const value of candidates) {
        const normalized = normalizeMutedValue(value);
        if (typeof normalized === 'boolean') {
            return normalized;
        }
    }
    return null;
}

function applyAudioFieldsFromInfo(info: unknown, status: DeviceStatus): void {
    if (!status || typeof status !== 'object') {
        return;
    }
    const volume = extractVolumeValue(info);
    if (typeof volume === 'number') {
        status.volume = volume;
        status.volumeSource = 'api';
    }
    const muted = extractMutedValue(info);
    if (typeof muted === 'boolean') {
        status.muted = muted;
        status.mutedSource = 'api';
    }
}

async function enrichAudioStatus(device: RuntimeDevice, status: DeviceStatus): Promise<void> {
    if (!status || !status.online) {
        return;
    }
    if (typeof status.volume === 'number' && typeof status.muted === 'boolean') {
        return;
    }
    const upnpAudio = await readUpnpAudioStatus(device);
    if (!upnpAudio) {
        return;
    }
    if (typeof status.volume !== 'number' && typeof upnpAudio.volume === 'number') {
        status.volume = upnpAudio.volume;
        status.volumeSource = 'upnp';
    }
    if (typeof status.muted !== 'boolean' && typeof upnpAudio.muted === 'boolean') {
        status.muted = upnpAudio.muted;
        status.mutedSource = 'upnp';
    }
}

async function checkDeviceStatus(device: RuntimeDevice): Promise<DeviceStatus> {
    if (!device.ip) {
        await refreshIpFromMac(device);
        if (!device.ip) {
            return { online: false, power: false, volume: null, muted: null };
        }
    }

    let status = await checkDeviceStatusWithIp(device);
    if (!status.online && device.mac) {
        const updated = await refreshIpFromMac(device);
        if (updated) {
            status = await checkDeviceStatusWithIp(device);
        }
    }
    return status;
}

/** The MAC address a Tizen device info reports (`wifiMac`, also on LAN) */
function macFromTizenInfo(info: unknown): string {
    const device = asObject(asObject(info).device);
    return normalizeMac(asString(device.wifiMac) || asString(device.mac) || '');
}

async function checkDeviceStatusWithIp(device: RuntimeDevice): Promise<DeviceStatus> {
    if (!device.ip) {
        return { online: false, power: false, volume: null, muted: null };
    }

    if (device.api === 'tizen') {
        const info = await fetchTizenInfo(device.ip, device.protocol || 'wss', device.port || 8002, 1500);
        if (info) {
            const powerState = extractPowerState(info);
            const power = interpretPowerState(powerState);
            const status: DeviceStatus = {
                online: true,
                power: power === null ? true : power,
                volume: null,
                muted: null,
            };
            applyAudioFieldsFromInfo(info, status);
            await applyFrameTvSupport(device, info);
            if (!device.mac) {
                const mac = macFromTizenInfo(info);
                if (mac) {
                    device.mac = mac;
                    devicesByMac.set(device.mac, device);
                    await updateDeviceInfoStates(device);
                }
            }
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
        // fallback to 8001
        const info2 = await fetchTizenInfo(device.ip, 'ws', 8001, 1500);
        if (info2) {
            const powerState = extractPowerState(info2);
            const power = interpretPowerState(powerState);
            const status: DeviceStatus = {
                online: true,
                power: power === null ? true : power,
                volume: null,
                muted: null,
            };
            applyAudioFieldsFromInfo(info2, status);
            await applyFrameTvSupport(device, info2);
            if (!device.mac) {
                const mac = macFromTizenInfo(info2);
                if (mac) {
                    device.mac = mac;
                    devicesByMac.set(device.mac, device);
                    await updateDeviceInfoStates(device);
                }
            }
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
    } else if (device.api === 'hj') {
        const info = await fetchHjInfo(device.ip, 1500);
        if (info) {
            const powerState = extractPowerState(info);
            const power = interpretPowerState(powerState);
            const status: DeviceStatus = {
                online: true,
                power: power === null ? true : power,
                volume: null,
                muted: null,
            };
            applyAudioFieldsFromInfo(info, status);
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
        const pingOk = await pingHost(device.ip, 1200);
        if (pingOk === true) {
            const status: DeviceStatus = { online: true, power: false, volume: null, muted: null };
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
        const ok = await checkPort(device.ip, 8000, 1000);
        if (ok) {
            const status: DeviceStatus = { online: true, power: false, volume: null, muted: null };
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
    } else if (device.api === 'legacy') {
        const ok = await checkPort(device.ip, 55000, 1500);
        if (ok) {
            const status: DeviceStatus = { online: true, power: true, volume: null, muted: null };
            markSeen(device);
            await enrichAudioStatus(device, status);
            return status;
        }
    }

    // generic fallback: ping port 8001
    const okGeneric = await checkPort(device.ip, 8001, 1000);
    if (okGeneric) {
        const status: DeviceStatus = { online: true, power: true, volume: null, muted: null };
        markSeen(device);
        await enrichAudioStatus(device, status);
        return status;
    }
    return { online: false, power: false, volume: null, muted: null };
}

function markSeen(device: RuntimeDevice): void {
    const ts = Date.now();
    void adapter.setState(`${device.name}.info.lastSeen`, ts, true);
}

function onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state || state.ack) {
        return;
    }
    const parts = id.split('.');
    if (parts.length < 5) {
        return;
    }
    if (`${parts[0]}.${parts[1]}` !== adapter.namespace) {
        return;
    }

    const deviceName = parts[2] as string;
    const channel = parts[3];
    const command = parts[4] as string;

    if (channel !== 'control' && channel !== 'scenes') {
        return;
    }

    const device = devicesByName.get(deviceName);
    if (!device) {
        adapter.log.warn(`Unknown device for stateChange: ${deviceName}`);
        return;
    }

    if (channel === 'scenes') {
        if (isTruthyValue(state.val)) {
            runSceneOf(device, command)
                .catch(e =>
                    e instanceof TvOffError
                        ? adapter.log.info(e.message)
                        : adapter.log.warn(`Scene ${command} of ${device.name} failed: ${errorMessage(e)}`),
                )
                .then(() => adapter.setStateAsync(id, false, true))
                .catch(() => {
                    // the instance is stopping
                });
        }
        return;
    }

    handleControl(device, id, command, state.val).catch(e => {
        if (e instanceof TvOffError) {
            adapter.log.info(e.message);
            return restoreControlState(device, id, command);
        }
        adapter.log.warn(`Failed to execute ${command} for ${device.name}: ${errorMessage(e)}`);
    });
}

/** A command other than switching on was sent while the TV is off */
class TvOffError extends Error {
    constructor(device: RuntimeDevice, command: string) {
        super(`${device.displayName || device.name} is off - ${command} ignored, switch it on first`);
        this.name = 'TvOffError';
    }
}

/** Commands that work while the TV is off */
const COMMANDS_WHILE_OFF = new Set(['power', 'wol']);

/**
 * Let a command through only while the TV is on. The polled state may be up to one poll interval old -
 * the TV may just have been switched on with its own remote - so an "off" is checked with the TV once more.
 */
async function requirePowerOn(device: RuntimeDevice, command: string): Promise<void> {
    if ((await adapter.getStateAsync(`${device.name}.state.power`))?.val === true) {
        return;
    }
    await pollDevice(device);
    if ((await adapter.getStateAsync(`${device.name}.state.power`))?.val !== true) {
        throw new TvOffError(device, command);
    }
}

/** Put a control state that was written while the TV is off back to what is true */
async function restoreControlState(device: RuntimeDevice, id: string, command: string): Promise<void> {
    const mirrored: Record<string, string> = { volume: 'state.volume', muted: 'state.muted' };
    let value: ioBroker.StateValue;
    if (mirrored[command]) {
        value = (await adapter.getStateAsync(`${device.name}.${mirrored[command]}`))?.val ?? null;
    } else if (command === 'key' || command === 'launchApp' || command === 'source') {
        value = '';
    } else {
        // buttons and Art Mode
        value = false;
    }
    await adapter.setStateAsync(id, value, true);
}

/**
 * Commands of the admin pages (remote control tab, scene table). Answers `{ error }` on failure; never with
 * `result`, which admin would show in an alert. `dm:` commands belong to the Device Manager.
 */
function onMessage(obj: ioBroker.Message): void {
    if (!obj?.callback || !obj.command || obj.command.startsWith('dm:')) {
        return;
    }
    void handleMessage(obj.command, asObject(obj.message))
        .catch(e => ({ error: errorMessage(e) }))
        .then(response => adapter.sendTo(obj.from, obj.command, response, obj.callback));
}

async function handleMessage(command: string, message: JsonObject): Promise<unknown> {
    if (command === 'listDevices') {
        // options of a selectSendTo
        const options = Array.from(devicesById.values()).map(device => ({
            label: device.displayName || device.name,
            value: device.name,
        }));
        return message.withAll ? [{ label: 'All TVs', value: '' }, ...options] : options;
    }
    if (command === 'devices') {
        return {
            devices: Array.from(devicesById.values()).map(device => ({
                name: device.name,
                displayName: device.displayName || device.name,
                api: device.api,
                frameTv: !!device.frameTv,
                apps: Object.keys(appStatesOf(device)),
                inputs: Object.keys(inputStatesOf(device)),
                scenes: Array.from(scenesOf(device)).map(([id, scene]) => ({
                    id,
                    name: scene.name,
                    on: scene.steps[0]?.type === 'on',
                })),
            })),
        };
    }

    if (command === 'testScene') {
        // the play key of a row of the scene table: the steps as they are typed, not yet saved
        let steps: SceneStep[];
        try {
            steps = parseScene(asString(message.steps));
        } catch (e) {
            return { error: errorMessage(e) };
        }
        if (!steps.length) {
            return { error: 'The scene has no steps' };
        }
        const name = asString(message.device);
        const targets = name ? [devicesByName.get(name)] : Array.from(devicesById.values());
        if (!targets.length || targets.some(target => !target)) {
            return { error: `Unknown TV ${name}` };
        }
        for (const target of targets as RuntimeDevice[]) {
            await runSceneSteps(target, {
                name: asString(message.name) || 'test',
                steps,
                delay: sceneDelay(message.delay),
            });
        }
        return {};
    }

    const device = devicesByName.get(asString(message.device));
    if (!device) {
        return { error: `Unknown TV ${asString(message.device)}` };
    }
    // the remote control tab: everything but power needs the TV on; the list of known apps does not
    if (command !== 'power' && (command !== 'apps' || message.refresh)) {
        await requirePowerOn(device, command);
    }
    switch (command) {
        case 'remote': {
            const key = normalizeKeyInput(message.key);
            if (!key) {
                return { error: `Unknown key ${asString(message.key)}` };
            }
            await sendKey(device, key);
            return {};
        }
        case 'launchApp':
            await launchAppOf(device, asString(message.app));
            return {};
        case 'closeApp':
            await closeAppOf(device, asString(message.app));
            return {};
        case 'youtube':
            await playYouTube(device, asString(message.target));
            return {};
        case 'input':
            await selectSource(device, asString(message.input));
            return {};
        case 'apps':
            if (message.refresh) {
                await lookUpApps(device);
            }
            return { apps: Object.keys(appStatesOf(device)) };
        case 'runScene':
            await runSceneOf(device, asString(message.scene));
            return {};
        case 'power':
            await handleControl(device, `${device.name}.control.power`, 'power', !!message.on);
            return {};
        case 'artMode':
            await setArtModeOf(device, !!message.on);
            return {};
        default:
            return { error: `Unknown command ${command}` };
    }
}

/** Scenes that are running, per TV, so that a second press does not interleave the keys */
const runningScenes = new Set<string>();

/** Run a scene of the settings on a TV */
async function runSceneOf(device: RuntimeDevice, id: string): Promise<void> {
    const scene = scenesOf(device).get(id);
    if (!scene) {
        throw new Error(`Unknown scene ${id}`);
    }
    await runSceneSteps(device, scene);
}

/** Run the steps of a scene, saved or only typed into the settings, on a TV */
async function runSceneSteps(
    device: RuntimeDevice,
    scene: { name: string; steps: SceneStep[]; delay: number },
): Promise<void> {
    if (runningScenes.has(device.id)) {
        throw new Error('Another scene is still running on this TV');
    }
    // a scene that begins with ON switches the TV on itself
    if (scene.steps[0]?.type !== 'on') {
        await requirePowerOn(device, `scene ${scene.name}`);
    }
    runningScenes.add(device.id);
    try {
        adapter.log.debug(`Scene ${scene.name} on ${device.name}: ${scene.steps.length} steps`);
        await runScene(scene.steps, scene.delay, {
            powerOn: () => switchOnAndWait(device),
            holdKey: (key, ms) => holdKey(device, key, ms),
            closeApp: app => closeAppOf(device, app),
            youtube: target => playYouTube(device, target),
            sendKey: key => sendKey(device, key),
            launchApp: app => launchAppOf(device, app),
            selectInput: input => selectSource(device, input),
            sleep,
        });
    } finally {
        runningScenes.delete(device.id);
    }
}

/** Switch the TV on and wait until it reports so, at most `WAKE_DURATION` */
async function switchOnAndWait(device: RuntimeDevice): Promise<void> {
    await handleControl(device, `${device.name}.control.power`, 'power', true);
    await device.wakeTask;
    const until = Date.now() + WAKE_DURATION;
    while (Date.now() < until) {
        if ((await checkDeviceStatus(device)).power) {
            await adapter.setStateAsync(`${device.name}.state.power`, true, true);
            return;
        }
        await sleep(POWER_POLL_INTERVAL);
    }
    throw new Error(`${device.displayName || device.name} did not switch on`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => adapter.setTimeout(resolve, ms));
}

async function handleControl(
    device: RuntimeDevice,
    id: string,
    command: string,
    value: ioBroker.StateValue,
): Promise<void> {
    if (!COMMANDS_WHILE_OFF.has(command)) {
        await requirePowerOn(device, command);
    }
    switch (command) {
        case 'power':
            await setPower(device, !!value);
            // Poll every 2 s for up to 30 s until the TV reports the new state, without
            // publishing the old state in between.
            startPowerTransition(device, !!value, {
                poll: () => pollDevice(device),
                schedule: (fn: () => void, delay: number) => adapter.setTimeout(fn, delay),
                now: Date.now,
                interval: POWER_POLL_INTERVAL,
                duration: POWER_POLL_DURATION,
            });
            await adapter.setStateAsync(id, !!value, true);
            await adapter.setStateAsync(`${device.name}.state.power`, !!value, true);
            return;
        case 'wol':
            if (adapter.config.enableWol && device.mac) {
                sendWol(device);
                await adapter.setStateAsync(id, false, true);
            }
            return;
        case 'key':
            if (typeof value === 'string' && value.trim()) {
                const key = normalizeKeyInput(value);
                if (key) {
                    await sendKey(device, key);
                }
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'volumeUp':
            return sendVolumeStep(device, id, 'KEY_VOLUP', 1, value);
        case 'volumeDown':
            return sendVolumeStep(device, id, 'KEY_VOLDOWN', -1, value);
        case 'mute':
            return sendMuteToggle(device, id, value);
        case 'volume':
            return setAbsoluteVolume(device, id, value);
        case 'muted':
            return setAbsoluteMute(device, id, value);
        case 'channelUp':
            return sendButton(device, id, 'KEY_CHUP', value);
        case 'channelDown':
            return sendButton(device, id, 'KEY_CHDOWN', value);
        case 'home':
            return sendButton(device, id, 'KEY_HOME', value);
        case 'launchApp':
            if (typeof value === 'string' && value.trim()) {
                await launchAppOf(device, value.trim());
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'closeApp':
            if (typeof value === 'string' && value.trim()) {
                await closeAppOf(device, value.trim());
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'youtube':
            if (typeof value === 'string' && value.trim()) {
                try {
                    await playYouTube(device, value.trim());
                } finally {
                    await adapter.setStateAsync(id, '', true);
                }
            }
            return;
        case 'source':
            if (typeof value === 'string' && value.trim()) {
                await selectSource(device, value.trim());
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'artMode':
            return setArtModeOf(device, isTruthyValue(value));
        default:
            return;
    }
}

async function sendButton(device: RuntimeDevice, id: string, key: string, value: ioBroker.StateValue): Promise<void> {
    if (!key) {
        return;
    }
    if (isTruthyValue(value)) {
        await sendKey(device, key);
        await adapter.setStateAsync(id, false, true);
    }
}

async function sendVolumeStep(
    device: RuntimeDevice,
    id: string,
    key: string,
    delta: number,
    value: ioBroker.StateValue,
): Promise<void> {
    if (!isTruthyValue(value)) {
        return;
    }
    await sendKey(device, key);
    await adapter.setStateAsync(id, false, true);

    const state = await adapter.getStateAsync(`${device.name}.state.volume`);
    const current =
        state && typeof state.val === 'number' && Number.isFinite(state.val)
            ? state.val
            : typeof device.lastKnownVolume === 'number'
              ? device.lastKnownVolume
              : null;
    if (current !== null) {
        const next = Math.max(0, Math.min(100, current + delta));
        device.lastKnownVolume = next;
        device.expectedVolume = next;
        device.expectedVolumeUntil = Date.now() + 12000;
        await adapter.setStateAsync(`${device.name}.state.volume`, next, true);
    }
    scheduleDevicePoll(device, 1200);
}

async function sendMuteToggle(device: RuntimeDevice, id: string, value: ioBroker.StateValue): Promise<void> {
    if (!isTruthyValue(value)) {
        return;
    }
    await sendKey(device, 'KEY_MUTE');
    await adapter.setStateAsync(id, false, true);

    const state = await adapter.getStateAsync(`${device.name}.state.muted`);
    const current =
        state && typeof state.val === 'boolean'
            ? state.val
            : typeof device.lastKnownMuted === 'boolean'
              ? device.lastKnownMuted
              : false;
    const next = !current;
    device.lastKnownMuted = next;
    device.expectedMuted = next;
    device.expectedMutedUntil = Date.now() + 12000;
    // Keep optimistic mute result for a short period, because some TVs always report false via UPnP.
    device.mutedShadowUntil = Date.now() + 120000;
    await adapter.setStateAsync(`${device.name}.state.muted`, next, true);
    scheduleDevicePoll(device, 1200);
}

async function setAbsoluteVolume(device: RuntimeDevice, id: string, value: ioBroker.StateValue): Promise<void> {
    const target = normalizeAbsoluteVolume(value);
    if (target === null) {
        adapter.log.warn(`Ignoring out of range volume "${String(value)}" for ${device.name}`);
        return;
    }

    try {
        await upnpSetRenderingControlValue(device, 'SetVolume', `      <DesiredVolume>${target}</DesiredVolume>`);
    } catch (e) {
        await adapter.setStateAsync(id, { val: target, ack: true, q: DEVICE_ERROR_QUALITY });
        throw e;
    }

    device.lastKnownVolume = target;
    device.expectedVolume = target;
    device.expectedVolumeUntil = Date.now() + 12000;
    device.volumeTelemetryReliable = true;
    await adapter.setStateAsync(id, target, true);
    await adapter.setStateAsync(`${device.name}.state.volume`, target, true);
    scheduleDevicePoll(device, 1200);
}

async function setAbsoluteMute(device: RuntimeDevice, id: string, value: ioBroker.StateValue): Promise<void> {
    const target = normalizeAbsoluteMute(value);
    if (target === null) {
        adapter.log.warn(`Ignoring invalid mute value for ${device.name}`);
        return;
    }

    try {
        await upnpSetRenderingControlValue(device, 'SetMute', `      <DesiredMute>${target ? 1 : 0}</DesiredMute>`);
    } catch (e) {
        await adapter.setStateAsync(id, { val: target, ack: true, q: DEVICE_ERROR_QUALITY });
        throw e;
    }

    device.lastKnownMuted = target;
    device.expectedMuted = target;
    device.expectedMutedUntil = Date.now() + 12000;
    device.mutedTelemetryReliable = true;
    await adapter.setStateAsync(id, target, true);
    await adapter.setStateAsync(`${device.name}.state.muted`, target, true);
    scheduleDevicePoll(device, 1200);
}

function isTruthyValue(val: unknown): boolean {
    return val === true || val === 1 || val === 'true';
}

function normalizeKeyInput(input: unknown): string {
    if (!input || typeof input !== 'string') {
        return '';
    }
    const raw = input.trim();
    if (!raw) {
        return '';
    }
    const upper = raw.toUpperCase();
    if (upper.startsWith('KEY_')) {
        return upper;
    }
    // the keys of TV_KEYS, e.g. SELECT, CHANNEL_UP, NUMBER_5
    const code = TV_KEY_CODES[upper.replace(/\s+/g, '_')];
    if (code) {
        return code;
    }

    const normalized = raw.toLowerCase().replace(/\s+/g, '');
    const map: Record<string, string> = {
        up: 'KEY_UP',
        arrowup: 'KEY_UP',
        down: 'KEY_DOWN',
        arrowdown: 'KEY_DOWN',
        left: 'KEY_LEFT',
        arrowleft: 'KEY_LEFT',
        right: 'KEY_RIGHT',
        arrowright: 'KEY_RIGHT',
        enter: 'KEY_ENTER',
        ok: 'KEY_ENTER',
        back: 'KEY_RETURN',
        return: 'KEY_RETURN',
        home: 'KEY_HOME',
        source: 'KEY_SOURCE',
        menu: 'KEY_MENU',
        info: 'KEY_INFO',
        guide: 'KEY_GUIDE',
        exit: 'KEY_EXIT',
        volup: 'KEY_VOLUP',
        volumeup: 'KEY_VOLUP',
        voldown: 'KEY_VOLDOWN',
        volumedown: 'KEY_VOLDOWN',
        mute: 'KEY_MUTE',
        chup: 'KEY_CHUP',
        channelup: 'KEY_CHUP',
        chdown: 'KEY_CHDOWN',
        channeldown: 'KEY_CHDOWN',
        play: 'KEY_PLAY',
        pause: 'KEY_PAUSE',
        stop: 'KEY_STOP',
        rewind: 'KEY_REWIND',
        ff: 'KEY_FF',
        fastforward: 'KEY_FF',
        record: 'KEY_REC',
        red: 'KEY_RED',
        green: 'KEY_GREEN',
        yellow: 'KEY_YELLOW',
        blue: 'KEY_BLUE',
        0: 'KEY_0',
        1: 'KEY_1',
        2: 'KEY_2',
        3: 'KEY_3',
        4: 'KEY_4',
        5: 'KEY_5',
        6: 'KEY_6',
        7: 'KEY_7',
        8: 'KEY_8',
        9: 'KEY_9',
    };

    return map[normalized] || upper;
}

async function setPower(device: RuntimeDevice, on: boolean): Promise<void> {
    const status = await checkDeviceStatus(device);
    adapter.log.debug(
        `Power request for ${device.name}: target=${on} api=${device.api} online=${status.online} power=${status.power}`,
    );
    if (on) {
        if (status.power) {
            // The Frame reports "on" in Art Mode as well; switching on means showing TV again
            if (device.frameTv && (await adapter.getStateAsync(`${device.name}.control.artMode`))?.val === true) {
                await setArtModeOf(device, false);
            }
            return;
        }
        if (device.api === 'hj') {
            if (adapter.config.enableWol && device.mac) {
                sendWol(device);
                scheduleDevicePoll(device, 6000);
                schedulePowerFallback(device, true, 'KEY_POWER', 8000);
                return;
            }
            if (status.online) {
                try {
                    await sendKey(device, 'KEY_POWERON');
                    scheduleDevicePoll(device, 4000);
                    schedulePowerFallback(device, true, 'KEY_POWER', 6000);
                    return;
                } catch {
                    try {
                        await sendKey(device, 'KEY_POWER');
                        scheduleDevicePoll(device, 4000);
                        return;
                    } catch {
                        // fallback to WOL
                    }
                }
            }
        } else {
            // Wake-on-LAN first, also while the TV still answers in standby: on The Frame 2022 it switches
            // the TV on within ~6 s, while KEY_POWER in standby once left the TV in deep standby. KEY_POWER
            // follows only if the TV is not on after 10 s.
            if (adapter.config.enableWol && device.mac) {
                sendWol(device);
                scheduleDevicePoll(device, 6000);
                schedulePowerFallback(device, true, 'KEY_POWER', 10000);
                scheduleWolRetries(device, Date.now() + WAKE_DURATION);
                if (device.frameTv) {
                    device.wakeTask = showTvAfterWake(device)
                        .catch(e => adapter.log.warn(`${device.name} stays in Art Mode: ${errorMessage(e)}`))
                        .finally(() => (device.wakeTask = undefined));
                }
                return;
            }
            if (status.online) {
                try {
                    await sendKey(device, 'KEY_POWER');
                    scheduleDevicePoll(device, 4000);
                    return;
                } catch {
                    // fallback to WOL
                }
            }
        }
        if (adapter.config.enableWol && device.mac) {
            sendWol(device);
        } else if (!status.online) {
            adapter.log.warn(
                `${device.name} does not answer and cannot be switched on: ${
                    device.mac ? 'Wake-on-LAN is disabled in the settings' : 'its MAC address is unknown'
                }`,
            );
        }
        scheduleDevicePoll(device, 6000);
        return;
    }
    if (status.power) {
        if (device.api === 'hj') {
            try {
                await sendKey(device, 'KEY_POWER');
                scheduleDevicePoll(device, 3000);
                schedulePowerFallback(device, false, 'KEY_POWEROFF', 5000);
                return;
            } catch {
                await sendKey(device, 'KEY_POWER');
                scheduleDevicePoll(device, 3000);
                return;
            }
        }
        if (device.frameTv && device.api === 'tizen') {
            // a short KEY_POWER may only switch The Frame to Art Mode; held for 3 s it switches it off
            await holdKey(device, 'KEY_POWER', FRAME_POWER_OFF_HOLD);
            scheduleDevicePoll(device, 5000);
            return;
        }
        await sendKey(device, 'KEY_POWER');
        scheduleDevicePoll(device, 3000);
    }
}

/** Hold a key for `ms`; only Tizen TVs know press and release, the others get a click */
async function holdKey(device: RuntimeDevice, key: string, ms: number): Promise<void> {
    if (device.api !== 'tizen') {
        return sendKey(device, key);
    }
    await tizenSend(
        device,
        ['Press', 'Release'].map(Cmd => ({
            method: 'ms.remote.control',
            params: { Cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
        })),
        ms,
    );
    markSeen(device);
}

/** Send the magic packet; logs where it went, never throws */
function sendWol(device: RuntimeDevice): void {
    wakeOnLan(device.mac, { ip: device.ip || undefined })
        .then(targets =>
            adapter.log.info(`Wake-on-LAN for ${device.name} (${device.mac}) sent to ${targets.join(', ')}`),
        )
        .catch(e => adapter.log.warn(`Wake-on-LAN for ${device.name} failed: ${errorMessage(e)}`));
}

/** Send Wake-on-LAN again every 10 s while the TV stays unreachable, until it is on or `until` */
function scheduleWolRetries(device: RuntimeDevice, until: number): void {
    adapter.setTimeout(async () => {
        try {
            const status = await checkDeviceStatus(device);
            if (status.power || isUnloading || Date.now() > until) {
                return;
            }
            if (!status.online) {
                sendWol(device);
            }
            scheduleWolRetries(device, until);
        } catch {
            // the next poll shows the state
        }
    }, WOL_RETRY_INTERVAL);
}

/** The Frame wakes up in Art Mode; switching on means TV, so leave Art Mode once the TV is on */
async function showTvAfterWake(device: RuntimeDevice): Promise<void> {
    const until = Date.now() + WAKE_DURATION;
    while (!(await checkDeviceStatus(device)).power) {
        if (Date.now() > until) {
            return;
        }
        await sleep(POWER_POLL_INTERVAL);
    }
    // the art channel answers only a few seconds after waking up
    for (let attempt = 1; ; attempt++) {
        try {
            if (await getArtMode(artTargetOf(device))) {
                await setArtModeOf(device, false);
            }
            return;
        } catch (e) {
            if (attempt === 5) {
                throw e;
            }
            await sleep(2000);
        }
    }
}

function schedulePowerFallback(device: RuntimeDevice, targetOn: boolean, fallbackKey: string, delayMs: number): void {
    if (!device) {
        return;
    }
    const delay = Math.max(1000, delayMs || 0);
    adapter.setTimeout(async () => {
        try {
            const status = await checkDeviceStatus(device);
            if (targetOn && status.power) {
                return;
            }
            if (!targetOn && !status.power) {
                return;
            }
            if (!status.online) {
                return;
            }
            adapter.log.debug(`Power fallback for ${device.name}: key=${fallbackKey}`);
            await sendKey(device, fallbackKey);
            scheduleDevicePoll(device, 3000);
        } catch {
            // ignore
        }
    }, delay);
}

async function sendKey(device: RuntimeDevice, key: string): Promise<void> {
    if (device.api === 'tizen') {
        try {
            await tizenSendKey(device, key);
            markSeen(device);
            return;
        } catch (e) {
            if (isTizenRemoteUnsupported(e)) {
                const hjOk = device.hjAvailable === true || (await checkPort(device.ip, 8000, 1500));
                if (hjOk) {
                    device.hjAvailable = true;
                    device.api = 'hj';
                    adapter.log.warn(`Tizen remote unsupported for ${device.name}, switching to HJ`);
                    await updateDeviceInfoStates(device);
                    updateConfigDeviceFromDiscovery(device, {
                        id: device.id,
                        ip: device.ip,
                        mac: device.mac,
                        api: 'hj',
                        hjAvailable: true,
                    });
                    await hjSendKey(device, key);
                    markSeen(device);
                    return;
                }
            }
            throw e;
        }
    } else if (device.api === 'hj') {
        await hjSendKey(device, key);
    } else if (device.api === 'legacy') {
        await legacySendKey(device, key);
    } else {
        // try tizen first
        try {
            await tizenSendKey(device, key);
        } catch (e) {
            if (isTizenRemoteUnsupported(e)) {
                const hjOk = await checkPort(device.ip, 8000, 1500);
                if (hjOk) {
                    device.hjAvailable = true;
                    device.api = 'hj';
                    adapter.log.warn(`Tizen remote unsupported for ${device.name}, switching to HJ`);
                    await updateDeviceInfoStates(device);
                    updateConfigDeviceFromDiscovery(device, {
                        id: device.id,
                        ip: device.ip,
                        mac: device.mac,
                        api: 'hj',
                        hjAvailable: true,
                    });
                    await hjSendKey(device, key);
                    markSeen(device);
                    return;
                }
            }
            await legacySendKey(device, key);
        }
    }
    markSeen(device);
}

function isTizenRemoteUnsupported(err: unknown): boolean {
    if (!err || !(err as Error).message) {
        return false;
    }
    // Known issue kept 1:1 from the JavaScript version: `\\.` matches a backslash, so only
    // "unrecognized method value" is ever recognized.
    return /unrecognized method value|ms\\.remote\\.control/i.test((err as Error).message);
}

async function legacySendKey(device: RuntimeDevice, key: string): Promise<void> {
    if (!device.ip) {
        throw new Error('No IP');
    }
    await new Promise<void>((resolve, reject) => {
        const remote = new LegacyRemote({ ip: device.ip });
        // LegacyRemote reports an error as a string
        remote.send(key, err => (err ? reject(new Error(err)) : resolve()));
    });
}

async function hjSendKey(device: RuntimeDevice, key: string): Promise<void> {
    if (!device.ip) {
        throw new Error('No IP');
    }
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    const identity = getHjIdentity(device.id);
    if (!identity) {
        throw new Error('Not paired (HJ)');
    }
    // stored by confirmManagedHjPin() from SamsungTv.confirmPin()
    tv.identity = identity as HjIdentity;
    if (tv.pairing) {
        tv.pairing.identity = identity as HjIdentity;
    }
    try {
        await tv.connect();
        const powerKeys = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
        if (tv.connection && powerKeys.has(key)) {
            tv.connection.sendKey(key, 'Press');
            await new Promise<void>(resolve => adapter.setTimeout(resolve, 150));
            tv.connection.sendKey(key, 'Release');
            adapter.log.debug(`HJ sendKey ${key} (press/release) to ${device.name}`);
        } else {
            tv.sendKey(key);
            adapter.log.debug(`HJ sendKey ${key} to ${device.name}`);
        }
    } catch (e) {
        adapter.log.debug(`HJ sendKey failed (${key}) for ${device.name}: ${errorMessage(e)}`);
        await tv.connect();
        const powerKeys = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
        if (tv.connection && powerKeys.has(key)) {
            tv.connection.sendKey(key, 'Press');
            await new Promise<void>(resolve => adapter.setTimeout(resolve, 150));
            tv.connection.sendKey(key, 'Release');
            adapter.log.debug(`HJ sendKey retry ${key} (press/release) to ${device.name}`);
        } else {
            tv.sendKey(key);
            adapter.log.debug(`HJ sendKey retry ${key} to ${device.name}`);
        }
    }
}

async function launchApp(device: RuntimeDevice, appId: string): Promise<void> {
    if (device.api !== 'tizen') {
        adapter.log.warn(`launchApp only supported for Tizen devices (${device.name})`);
        return;
    }
    await tizenSend(device, {
        method: 'ms.channel.emit',
        params: {
            event: 'ed.apps.launch',
            to: 'host',
            data: {
                action_type: 'NATIVE_LAUNCH',
                appId,
            },
        },
    });
    markSeen(device);
}

/**
 * Start an app: a key of `TV_APPS` (`YOUTUBE`) or an app ID of the TV. Over the REST API first - the
 * websocket launch does nothing on newer TVs (The Frame 2022) - and over the websocket if REST fails.
 */
async function launchAppOf(device: RuntimeDevice, app: string): Promise<void> {
    if (device.api !== 'tizen') {
        adapter.log.warn(`launchApp only supported for Tizen devices (${device.name})`);
        return;
    }
    const key = app.toUpperCase();
    let appIds = [app];
    if (TV_APPS[key]) {
        const found = device.apps?.find(entry => entry.key === key);
        appIds = found ? [found.appId] : SAMSUNG_APPS[key]?.ids || [];
        if (!appIds.length) {
            throw new Error(`No app ID of ${TV_APPS[key]} is known`);
        }
        if (device.apps && !found) {
            throw new Error(`${TV_APPS[key]} is not installed on ${device.name}`);
        }
    }
    let restError: unknown;
    // right after waking up the TV reports "on" but its app API answers only some seconds later
    const until = Date.now() + APP_LAUNCH_RETRY;
    for (;;) {
        for (const appId of appIds) {
            try {
                await launchAppRest(device.ip, appId);
                markSeen(device);
                return;
            } catch (e) {
                restError = e;
            }
        }
        if (!(restError instanceof TvNotAnsweringError) || Date.now() > until) {
            break;
        }
        await sleep(2000);
    }
    adapter.log.debug(`REST app launch failed on ${device.name} (${errorMessage(restError)}), trying the websocket`);
    await launchApp(device, appIds[0]!);
}

/**
 * Play a video, playlist or the uploads of a channel in the YouTube app, or send play / pause / next / previous.
 * Goes over the YouTube Lounge API of Google (`@iobroker/youtube-lounge`), the only way the TV accepts.
 */
async function playYouTube(device: RuntimeDevice, input: string): Promise<void> {
    if (device.api !== 'tizen') {
        throw new Error(`YouTube is only supported for Tizen devices (${device.name})`);
    }
    const target = parseYouTubeTarget(input);
    let lounge = youtubeSessions.get(device.id);
    if (!lounge?.screen) {
        lounge = new YouTubeLounge({ name: 'ioBroker' });
        await lounge.pairWithScreenId(await youtubeScreenId(device));
        youtubeSessions.set(device.id, lounge);
    }
    // Google takes commands also while the app is not open, and they get lost
    if (!(await lounge.waitForScreen(3000))) {
        await launchAppOf(device, 'YOUTUBE');
        if (!(await lounge.waitForScreen(30_000))) {
            throw new Error(`The YouTube app of ${device.name} did not open`);
        }
    }
    // an expired token or session is renewed by the lounge itself
    await lounge.play(target);
    adapter.log.debug(`YouTube on ${device.name}: ${target.kind}`);
    markSeen(device);
}

/** The screen of the YouTube app; the app reports it over DIAL, so it is started if it does not answer */
async function youtubeScreenId(device: RuntimeDevice): Promise<string> {
    // the DIAL description of Samsung TVs names the app URL; port 8080 if it does not answer
    const appUrl =
        (await readDialDevice(`http://${device.ip}:7678/nservice/`))?.appUrl ?? `http://${device.ip}:8080/ws/app/`;
    let screenId = await getYouTubeScreenId(appUrl);
    for (let attempt = 0; !screenId && attempt < 5; attempt++) {
        if (attempt === 0) {
            await launchAppOf(device, 'YOUTUBE');
        }
        await sleep(2000);
        screenId = await getYouTubeScreenId(appUrl);
    }
    if (!screenId) {
        throw new Error(`The YouTube app of ${device.name} does not report its screen`);
    }
    return screenId;
}

/** Close an app: a key of `TV_APPS` (`YOUTUBE`) or an app ID of the TV */
async function closeAppOf(device: RuntimeDevice, app: string): Promise<void> {
    if (device.api !== 'tizen') {
        adapter.log.warn(`closeApp only supported for Tizen devices (${device.name})`);
        return;
    }
    const key = app.toUpperCase();
    const appId = TV_APPS[key] ? device.apps?.find(entry => entry.key === key)?.appId : app;
    if (!appId) {
        throw new Error(`${TV_APPS[key]} is not installed on ${device.name}`);
    }
    if (!(await closeAppRest(device.ip, appId))) {
        adapter.log.debug(`${app} does not run on ${device.name}`);
    }
    markSeen(device);
    scheduleDevicePoll(device, 1500);
}

/**
 * Switch the input: a key of `TV_INPUTS` (`HDMI2`) or a Samsung key code. With a configured source menu
 * over the menu, otherwise with the direct key (`KEY_HDMI2`), which newer TVs ignore.
 */
async function selectSource(device: RuntimeDevice, source: string): Promise<void> {
    const name = source.toUpperCase().replace(/\s+/g, '');
    const menuKeys = name.startsWith('KEY_') ? null : sourceMenuKeys(device.sourceMenu || [], name);
    if (menuKeys) {
        await sendKey(device, 'KEY_SOURCE');
        await sleep(SOURCE_MENU_DELAY);
        await sendKeys(device, menuKeys, SOURCE_MENU_KEY_GAP);
        return;
    }
    if (device.sourceMenu?.length && TV_INPUTS[name]) {
        throw new Error(`${TV_INPUTS[name]} is not in the source menu of ${device.name}`);
    }
    await sendKey(device, name.startsWith('KEY_') ? name : TV_INPUT_KEYS[name] || `KEY_${name}`);
}

/** Send several keys with a pause in between; a Tizen TV gets them over one connection */
async function sendKeys(device: RuntimeDevice, keys: string[], gap: number): Promise<void> {
    if (device.api === 'tizen') {
        await tizenSend(
            device,
            keys.map(key => ({
                method: 'ms.remote.control',
                params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
            })),
            gap,
        );
        markSeen(device);
        return;
    }
    for (const [i, key] of keys.entries()) {
        if (i) {
            await sleep(gap);
        }
        await sendKey(device, key);
    }
}

async function tizenSendKey(device: RuntimeDevice, key: string): Promise<void> {
    try {
        await tizenSend(device, {
            method: 'ms.remote.control',
            params: {
                Cmd: 'Click',
                DataOfCmd: key,
                Option: 'false',
                TypeOfRemote: 'SendRemoteKey',
            },
        });
    } catch (e) {
        if (isTizenRemoteUnsupported(e)) {
            throw new Error('Tizen remote unsupported');
        }
        throw e;
    }
}

/** Send one or several messages over one connection, `gap` ms apart */
async function tizenSend(device: RuntimeDevice, payload: JsonObject | JsonObject[], gap?: number): Promise<void> {
    const tokenRaw = getTizenTokenRaw(device.id);
    const token = tokenRaw === NO_TOKEN ? '' : tokenRaw;
    if (device.tokenAuthSupport === true && !token) {
        throw new Error('Not paired (Tizen)');
    }
    const channel = channelsByDevice.get(device.id)?.remote;
    if (channel?.connected) {
        try {
            for (const [i, message] of (Array.isArray(payload) ? payload : [payload]).entries()) {
                if (i) {
                    await sleep(gap ?? WS_SEND_DELAY);
                }
                channel.send(message);
            }
            return;
        } catch (e) {
            adapter.log.debug(`Open channel of ${device.name} failed (${errorMessage(e)}), connecting anew`);
        }
    }
    const urlCandidates = buildTizenWsCandidates(device, token, ['v2', 'v3']);
    let lastError: Error | undefined;
    for (const url of urlCandidates) {
        try {
            await tizenWsRequest(url, payload, gap);
            return;
        } catch (e) {
            lastError = e as Error;
        }
    }
    throw lastError || new Error('Tizen WS failed');
}

function buildTizenWsCandidates(
    device: Pick<RuntimeDevice, 'ip' | 'protocol' | 'port' | 'tokenAuthSupport'>,
    token: string,
    apiVersions: string | string[] = ['v2'],
): string[] {
    const nameBase64 = Buffer.from('ioBroker').toString('base64');
    const candidates: string[] = [];
    const added = new Set<string>();
    const versions = Array.isArray(apiVersions) ? apiVersions : [apiVersions];
    const add = (protocol: string, port: number, apiVersion: string): void => {
        const key = `${protocol}:${port}:${apiVersion}`;
        if (added.has(key)) {
            return;
        }
        added.add(key);
        let url = `${protocol}://${device.ip}:${port}/api/${apiVersion}/channels/samsung.remote.control?name=${nameBase64}`;
        if (token && token !== NO_TOKEN) {
            url += `&token=${encodeURIComponent(token)}`;
        }
        candidates.push(url);
    };

    // a TV with token authentication accepts the remote only on 8002; trying 8001 first costs ~2.5 s per key
    if (device.tokenAuthSupport) {
        for (const v of versions) {
            add('wss', 8002, v);
        }
    }
    if (device.protocol && device.port) {
        for (const v of versions) {
            add(device.protocol, device.port, v);
        }
    }
    for (const v of versions) {
        add('wss', 8002, v);
        add('ws', 8001, v);
    }
    return candidates;
}

function isTizenDenyEvent(eventName: unknown): boolean {
    return (
        eventName === 'ms.channel.timeOut' ||
        eventName === 'ms.channel.unauthorized' ||
        eventName === 'ms.channel.error'
    );
}

/** A message of the Tizen remote control websocket */
interface TizenWsMessage {
    event?: string;
    data?: { message?: string; token?: string; data?: { token?: string } };
}

async function tizenWsRequest(
    url: string,
    payload: JsonObject | JsonObject[],
    gap: number = WS_SEND_DELAY,
): Promise<void> {
    const payloads = Array.isArray(payload) ? payload : [payload];
    return new Promise((resolve, reject) => {
        const safeUrl = url.replace(/token=[^&]+/i, 'token=***');
        const ws = new WebSocket(url, buildTizenWsOptions(url));
        const timeout = adapter.setTimeout(
            () => {
                ws.terminate();
                reject(new Error('WebSocket timeout'));
            },
            WS_CONNECT_TIMEOUT + payloads.length * gap,
        );

        ws.on('error', err => {
            adapter.clearTimeout(timeout);
            adapter.log.debug(`WS error: ${safeUrl}: ${err.message}`);
            reject(err);
        });

        let sent = false;
        ws.on('message', (data: WebSocket.RawData) => {
            let message: TizenWsMessage;
            try {
                message = JSON.parse(rawDataToString(data)) as TizenWsMessage;
            } catch {
                return;
            }
            if (isTizenDenyEvent(message.event)) {
                adapter.clearTimeout(timeout);
                ws.close();
                return reject(new Error(`Tizen WS denied: ${message.event}`));
            }
            if (message.event === 'ms.error') {
                adapter.clearTimeout(timeout);
                ws.close();
                const msg = message?.data?.message || 'Tizen error';
                return reject(new Error(`Tizen error: ${msg}`));
            }
            if ((message.event === 'ms.channel.connect' || message.event === 'ms.channel.ready') && !sent) {
                sent = true;
                const sendNext = (index: number): void => {
                    try {
                        ws.send(JSON.stringify(payloads[index]));
                    } catch (e) {
                        adapter.clearTimeout(timeout);
                        ws.close();
                        return reject(e instanceof Error ? e : new Error(String(e)));
                    }
                    if (index + 1 < payloads.length) {
                        adapter.setTimeout(() => sendNext(index + 1), gap);
                        return;
                    }
                    adapter.setTimeout(() => {
                        adapter.clearTimeout(timeout);
                        ws.close();
                        resolve();
                    }, WS_SEND_DELAY);
                };
                adapter.setTimeout(() => sendNext(0), WS_SEND_DELAY);
            }
        });

        ws.on('open', () => {
            adapter.log.debug(`WS connected: ${safeUrl}`);
        });

        ws.on('close', (code, reason) => {
            adapter.log.debug(`WS closed: ${safeUrl} code=${code} reason=${reason ? reason.toString() : ''}`);
        });
    });
}

function buildTizenWsOptions(url: string): WebSocket.ClientOptions {
    try {
        const parsed = new URL(url);
        const originScheme = parsed.protocol === 'wss:' ? 'https' : 'http';
        const origin = `${originScheme}://${parsed.host}`;
        return {
            rejectUnauthorized: false,
            handshakeTimeout: WS_CONNECT_TIMEOUT,
            perMessageDeflate: false,
            headers: {
                Origin: origin,
                'User-Agent': 'iobroker.samsungtv',
            },
        };
    } catch {
        return { rejectUnauthorized: false, handshakeTimeout: WS_CONNECT_TIMEOUT, perMessageDeflate: false };
    }
}

async function validateTizenToken(device: AnyDevice, token: string): Promise<void> {
    if (!device || !device.ip) {
        throw new Error('No IP');
    }
    const urls = buildTizenWsCandidates(device, token, ['v2', 'v3']);
    let lastError: Error | undefined;
    for (const url of urls) {
        try {
            await validateTizenTokenWithUrl(url, token);
            adapter.log.debug(`Tizen token verified for ${device.name}`);
            return;
        } catch (e) {
            lastError = e as Error;
        }
    }
    throw lastError || new Error('Token verification unavailable');
}

function validateTizenTokenWithUrl(url: string, expectedToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const safeUrl = url.replace(/token=[^&]+/i, 'token=***');
        const ws = new WebSocket(url, buildTizenWsOptions(url));
        const pending: { done: boolean; timeout?: ioBroker.Timeout } = { done: false };
        const finish = (error?: Error): void => {
            if (pending.done) {
                return;
            }
            pending.done = true;
            adapter.clearTimeout(pending.timeout);
            try {
                ws.close();
            } catch {
                // ignore
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        pending.timeout = adapter.setTimeout(() => {
            try {
                ws.terminate();
            } catch {
                // ignore
            }
            finish(new Error('Token verification unavailable'));
        }, WS_CONNECT_TIMEOUT);

        ws.on('error', (error: NodeJS.ErrnoException) => {
            const kind = error.code || error.name || 'error';
            adapter.log.debug(`Token verification WS error: ${safeUrl}: ${kind}`);
            finish(new Error('Token verification unavailable'));
        });
        ws.on('close', () => {
            if (!pending.done) {
                finish(new Error('Token verification unavailable'));
            }
        });
        ws.on('message', (data: WebSocket.RawData) => {
            let message: unknown;
            try {
                message = JSON.parse(rawDataToString(data));
            } catch {
                return;
            }
            const result = evaluateTizenTokenMessage(message, expectedToken);
            if (result) {
                finish(result.accepted ? undefined : new Error(result.error));
            }
        });
    });
}

async function pairTizen(device: AnyDevice): Promise<string> {
    adapter.log.debug(`Pairing (Tizen) started for ${device.name} (${device.ip})`);
    await refreshTizenCapabilities(device);
    const urls = buildTizenWsCandidates(device, '', ['v2', 'v3']);

    let lastError: Error | undefined;
    for (const url of urls) {
        try {
            const token = await pairTizenWithUrl(url);
            const scheme = url.startsWith('wss://') ? 'wss' : 'ws';
            const apiVersion = url.includes('/api/v3/') ? 'v3' : 'v2';
            if (token === NO_TOKEN) {
                adapter.log.debug(
                    `Pairing (Tizen) succeeded without token for ${device.name} via ${scheme} ${apiVersion}`,
                );
            } else {
                adapter.log.debug(`Pairing (Tizen) succeeded for ${device.name} via ${scheme} ${apiVersion}`);
            }
            if (token === NO_TOKEN && device.tokenAuthSupport === true) {
                throw new Error('Token required but not granted by TV');
            }
            return token;
        } catch (e) {
            const scheme = url.startsWith('wss://') ? 'wss' : 'ws';
            const apiVersion = url.includes('/api/v3/') ? 'v3' : 'v2';
            adapter.log.debug(
                `Pairing (Tizen) failed for ${device.name} via ${scheme} ${apiVersion}: ${errorMessage(e)}`,
            );
            lastError = e as Error;
        }
    }
    if (
        lastError &&
        // Known issue kept 1:1 from the JavaScript version: `\\.` matches a backslash, so only
        // "Pairing timeout" is ever recognized here.
        /Pairing timeout|ms\\.channel\\.timeOut|ms\\.channel\\.unauthorized/.test(lastError.message || '')
    ) {
        adapter.log.warn(
            'Pairing failed: no prompt/authorization from TV. Check Device Connection Manager > Access Notification, clear the Device List, and ensure same subnet.',
        );
    }
    throw lastError || new Error('Pairing failed');
}

async function pairTizenWithUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, buildTizenWsOptions(url));
        let done = false;
        const timeout = adapter.setTimeout(() => {
            ws.terminate();
            if (done) {
                return;
            }
            done = true;
            reject(new Error('Pairing timeout'));
        }, PAIRING_TIMEOUT);

        ws.on('error', err => {
            if (done) {
                return;
            }
            done = true;
            adapter.clearTimeout(timeout);
            adapter.log.debug(`Pairing WS error: ${err.message}`);
            reject(err);
        });

        ws.on('open', () => {
            adapter.log.debug('Pairing WS connected');
        });

        ws.on('close', (code, reason) => {
            if (done) {
                return;
            }
            adapter.log.debug(`Pairing WS closed code=${code} reason=${reason ? reason.toString() : ''}`);
        });

        ws.on('message', (data: WebSocket.RawData) => {
            let message: TizenWsMessage;
            try {
                message = JSON.parse(rawDataToString(data)) as TizenWsMessage;
            } catch {
                return;
            }
            if (isTizenDenyEvent(message.event)) {
                if (done) {
                    return;
                }
                done = true;
                adapter.clearTimeout(timeout);
                ws.close();
                return reject(new Error(`Tizen WS denied: ${message.event}`));
            }
            if (message.event === 'ms.channel.connect') {
                if (done) {
                    return;
                }
                done = true;
                adapter.clearTimeout(timeout);
                const token = message?.data?.token || message?.data?.data?.token || '';
                ws.close();
                if (!token) {
                    return resolve(NO_TOKEN);
                }
                resolve(token);
            }
        });
    });
}

async function hjRequestPin(device: AnyDevice): Promise<void> {
    adapter.log.debug(`Pairing (HJ) PIN requested for ${device.name} (${device.ip})`);
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    await tv.requestPin();
}

async function hjConfirmPin(device: AnyDevice, pin: string): Promise<HjIdentity> {
    if (!pin) {
        throw new Error('Missing PIN');
    }
    adapter.log.debug(`Pairing (HJ) confirm PIN for ${device.name} (${device.ip})`);
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    const identity = await tv.confirmPin(pin);
    adapter.log.debug(`Pairing (HJ) succeeded for ${device.name}`);
    return identity;
}

async function performDiscovery(updateKnownDevices: boolean, timeoutOverride?: number): Promise<DiscoveredDevice[]> {
    const timeout =
        boundedSeconds(timeoutOverride || adapter.config.discoveryTimeout, 5, 2, MAX_DISCOVERY_TIMEOUT_SECONDS) * 1000;
    const discovered: DiscoveryCandidate[] = [];

    adapter.log.debug(
        `Discovery started (ssdp=${!!adapter.config.enableSsdp}, mdns=${!!adapter.config.enableMdns}, timeout=${timeout / 1000}s)`,
    );

    let ssdpCount = 0;
    let mdnsCount = 0;

    if (adapter.config.enableSsdp) {
        const ssdp = await discoverSsdp(timeout);
        ssdpCount = ssdp.length;
        adapter.log.debug(`SSDP discovery finished: ${ssdpCount} candidates`);
        discovered.push(...ssdp);
    }

    if (adapter.config.enableMdns) {
        const mdns = await discoverMdns(timeout);
        mdnsCount = mdns.length;
        adapter.log.debug(`mDNS discovery finished: ${mdnsCount} candidates`);
        discovered.push(...mdns);
    }

    const byIp = new Map<string, DiscoveryCandidate>();
    for (const entry of discovered) {
        if (!entry.ip) {
            continue;
        }
        const existing = byIp.get(entry.ip) || { ip: entry.ip, source: [] };
        existing.source = Array.from(new Set([...(existing.source || []), ...(entry.source || [])]));
        byIp.set(entry.ip, { ...existing, ...entry });
    }

    const results: DiscoveredDevice[] = [];
    for (const entry of byIp.values()) {
        const info = await probeDevice(entry.ip, entry);
        if (info) {
            results.push(info);
            discoveredByIp.set(entry.ip, info);

            if (updateKnownDevices) {
                const macKey = normalizeMac(info.mac || '');
                const match = devicesById.get(info.id) || (macKey ? devicesByMac.get(macKey) : null);
                if (match) {
                    if (info.ip && match.ip !== info.ip) {
                        match.ip = info.ip;
                    }
                    if (info.mac && !match.mac) {
                        match.mac = macKey;
                        devicesByMac.set(match.mac, match);
                    }
                    if (info.model && !match.model) {
                        match.model = info.model;
                    }
                    // a probe that did not answer in time reports `unknown`; it must not replace a known API
                    if (info.api && info.api !== 'unknown') {
                        match.api = info.api;
                    }
                    match.protocol = info.protocol || match.protocol;
                    match.port = info.port || match.port;
                    match.renderingControlUrl = info.renderingControlUrl || match.renderingControlUrl;
                    match.renderingControlEventUrl = info.renderingControlEventUrl || match.renderingControlEventUrl;
                    if (typeof info.tokenAuthSupport === 'boolean') {
                        match.tokenAuthSupport = info.tokenAuthSupport;
                    }
                    if (typeof info.hjAvailable === 'boolean') {
                        match.hjAvailable = info.hjAvailable;
                    }
                    await updateDeviceInfoStates(match);
                    updateConfigDeviceFromDiscovery(match, info);
                }
            }
        }
    }

    adapter.log.debug(
        `Discovery finished: ssdp=${ssdpCount}, mdns=${mdnsCount}, unique=${byIp.size}, probed=${results.length}`,
    );
    return results;
}

/** SSDP header, read case-insensitively the way the JavaScript version did */
function ssdpHeader(headers: Record<string, string | undefined>, name: string): string {
    const lower = name.toLowerCase();
    const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
    return headers[name.toUpperCase()] || headers[capitalized] || headers[lower] || '';
}

async function discoverSsdp(timeoutMs: number): Promise<DiscoveryCandidate[]> {
    return new Promise(resolve => {
        const results: DiscoveryCandidate[] = [];
        const client = new SsdpClient();
        client.on(
            'response',
            (headers: Record<string, string | undefined>, _statusCode: number, rinfo: dgram.RemoteInfo) => {
                const server = ssdpHeader(headers, 'SERVER');
                const st = ssdpHeader(headers, 'ST');
                const usn = ssdpHeader(headers, 'USN');
                const location = ssdpHeader(headers, 'LOCATION');
                if (!/samsung/i.test(`${server} ${st} ${usn}`)) {
                    return;
                }

                adapter.log.debug(
                    `SSDP response: ip=${rinfo.address} st=${st || '-'} usn=${usn || '-'} server=${server || '-'}`,
                );

                results.push({
                    ip: rinfo.address,
                    usn,
                    location,
                    st,
                    server,
                    source: ['ssdp'],
                });
            },
        );
        client.search('ssdp:all');
        adapter.setTimeout(() => {
            client.stop();
            resolve(results);
        }, timeoutMs);
    });
}

async function discoverMdns(timeoutMs: number): Promise<DiscoveryCandidate[]> {
    const services = (adapter.config.mdnsServices || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/^_/, ''));

    if (!services.length) {
        return [];
    }

    adapter.log.debug(`mDNS discovery started for services: ${services.join(', ')}`);

    const bonjour = new Bonjour();
    const results = new Map<string, DiscoveryCandidate>();
    const browsers: Browser[] = [];

    for (const svc of services) {
        const [type] = svc.split('.');
        const browser = bonjour.find({ type: type as string, protocol: 'tcp' }, (service: Service) => {
            const name = (service.name || '').toLowerCase();
            const txt = asObject(service.txt);
            const manufacturer = (asString(txt.manufacturer) || asString(txt.mf) || '').toLowerCase();
            if (!name.includes('samsung') && !manufacturer.includes('samsung') && !svc.includes('samsung')) {
                return;
            }
            const addresses = Array.isArray(service.addresses) ? service.addresses : [];
            for (const ip of addresses) {
                if (!ip || ip.includes(':')) {
                    continue;
                } // ignore IPv6 for now
                adapter.log.debug(
                    `mDNS service: ${svc} name=${service.name || '-'} ip=${ip} manufacturer=${manufacturer || '-'}`,
                );
                results.set(ip, { ip, name: service.name, source: ['mdns'], mdns: svc });
            }
        });
        browsers.push(browser);
    }

    return new Promise(resolve => {
        adapter.setTimeout(() => {
            for (const browser of browsers) {
                try {
                    browser.stop();
                } catch {
                    // ignore
                }
            }
            bonjour.destroy();
            resolve(Array.from(results.values()));
        }, timeoutMs);
    });
}

function parseTokenAuthSupport(info: unknown): boolean | undefined {
    const record = asObject(info);
    const device = asObject(record.device || record);
    const raw =
        device.TokenAuthSupport ??
        device.tokenAuthSupport ??
        device.tokenAuthSupported ??
        record.TokenAuthSupport ??
        record.tokenAuthSupport ??
        record.tokenAuthSupported;
    if (typeof raw === 'boolean') {
        return raw;
    }
    if (typeof raw === 'string') {
        return raw.toLowerCase() === 'true';
    }
    return undefined;
}

function isLikelyHjSeries(result: Pick<DiscoveredDevice, 'model' | 'uuid'>): boolean {
    const modelName = (result.model || '').toUpperCase();
    const code = (result.uuid || '').toUpperCase();
    const combined = `${modelName} ${code}`;
    // Known issue kept 1:1 from the JavaScript version: the doubled backslashes make `\\b` and
    // `\\d` match a literal backslash, so the first three patterns never match.
    if (/\\b1[45]_/.test(combined)) {
        return true;
    }
    if (/\\b[A-Z]{2}\\d{2}[HJ][A-Z]?\\d*/.test(modelName)) {
        return true;
    }
    if (/\\b(?:UE|GQ|QE)\\d{2}J/.test(modelName)) {
        return true;
    }
    if (modelName.includes('JU') || modelName.includes('JS')) {
        return true;
    }
    return false;
}

function applyHjInfo(result: DiscoveredDevice, info: JsonObject): void {
    result.name = result.name || asString(info.DeviceName) || '';
    result.model = result.model || asString(info.ModelName) || asString(info.Model) || '';
    result.uuid = result.uuid || asString(info.UDN) || asString(info.DUID) || asString(info.DeviceID) || '';
    if (!result.id) {
        result.id = normalizeId(asString(info.DeviceID) || asString(info.DUID) || asString(info.UDN) || '');
    }
}

async function probeDevice(ip: string, seed: DiscoveryCandidate): Promise<DiscoveredDevice | null> {
    adapter.log.debug(`Probing device ${ip}`);
    const result: DiscoveredDevice = {
        ip,
        source: seed.source || [],
        name: seed.name || '',
        model: '',
        api: 'unknown',
        protocol: '',
        port: 0,
        uuid: '',
        id: '',
        mac: '',
        renderingControlUrl: seed.renderingControlUrl || '',
        renderingControlEventUrl: seed.renderingControlEventUrl || '',
    };

    // try tizen https
    const tizenSecure = await fetchTizenInfo(ip, 'wss', 8002, 2000);
    if (tizenSecure) {
        result.api = 'tizen';
        result.protocol = 'wss';
        result.port = 8002;
        applyTizenInfo(result, tizenSecure);
        adapter.log.debug(`Probe result ${ip}: api=tizen protocol=wss port=8002`);
    }

    // try tizen http if not found
    if (result.api !== 'tizen') {
        const tizen = await fetchTizenInfo(ip, 'ws', 8001, 2000);
        if (tizen) {
            result.api = 'tizen';
            result.protocol = 'ws';
            result.port = 8001;
            applyTizenInfo(result, tizen);
            adapter.log.debug(`Probe result ${ip}: api=tizen protocol=ws port=8001`);
        }
    }

    // try HJ info (used later for API decision)
    const hj = await fetchHjInfo(ip, HJ_INFO_TIMEOUT);
    if (hj) {
        result.hjAvailable = true;
        applyHjInfo(result, hj);
    }

    // try UPnP description
    if (seed.location) {
        const desc = await fetchUpnpDescription(seed.location, 2000);
        if (desc) {
            if (!result.model) {
                result.model = desc.modelName || '';
            }
            if (!result.name) {
                result.name = desc.friendlyName || '';
            }
            if (!result.uuid && desc.UDN) {
                result.uuid = desc.UDN;
            }
            if (!result.renderingControlUrl && desc.renderingControlUrl) {
                result.renderingControlUrl = desc.renderingControlUrl;
            }
            if (!result.renderingControlEventUrl && desc.renderingControlEventUrl) {
                result.renderingControlEventUrl = desc.renderingControlEventUrl;
            }
            adapter.log.debug(`UPnP description for ${ip}: model=${result.model || '-'} name=${result.name || '-'}`);
        }
    }

    if (!result.id) {
        result.id = normalizeId(result.uuid || seed.usn || seed.st || seed.ip || '');
    }

    if (!result.name) {
        result.name = `tv-${result.id.slice(0, 6)}`;
    }

    const mac = await getMacForIp(ip);
    if (mac) {
        result.mac = mac;
    }
    if (mac && (!result.id || looksLikeIp(result.id))) {
        result.id = mac;
    }

    // decide API after UPnP/model info
    const hjSeries = isLikelyHjSeries(result);
    adapter.log.debug(
        `HJ check ${ip}: model=${result.model || '-'} uuid=${result.uuid || '-'} hjSeries=${hjSeries} hjAvailable=${result.hjAvailable}`,
    );
    if (result.api === 'unknown' || hjSeries) {
        if (!result.hjAvailable && hjSeries) {
            const hjPort = await checkPort(ip, 8000, 1200);
            if (hjPort) {
                result.hjAvailable = true;
            }
        }
        if (hjSeries) {
            if (!result.hjAvailable) {
                adapter.log.warn(`Model suggests H/J-series but HJ port not reachable for ${ip}; forcing HJ`);
            }
            result.api = 'hj';
            result.port = 8000;
            result.protocol = 'ws';
            adapter.log.debug(`Probe result ${ip}: api=hj protocol=ws port=8000`);
        } else if (result.hjAvailable) {
            result.api = 'hj';
            result.port = 8000;
            result.protocol = 'ws';
            adapter.log.debug(`Probe result ${ip}: api=hj protocol=ws port=8000`);
        }
    }

    if (result.id) {
        adapter.log.debug(
            `Probe result ${ip}: id=${result.id || '-'} mac=${result.mac || '-'} model=${result.model || '-'} api=${result.api}`,
        );
        return result;
    }

    adapter.log.debug(`Probe failed for ${ip}`);
    return null;
}

function applyTizenInfo(result: AnyDevice, info: JsonObject): void {
    const device = asObject(info.device || info);
    result.name = result.name || asString(device.name) || asString(info.name) || '';
    result.model = asString(device.modelName) || asString(device.model) || result.model || '';
    result.uuid = asString(device.id) || asString(device.udn) || asString(device.uuid) || result.uuid || '';
    result.id = normalizeId(
        asString(device.id) || asString(device.udn) || asString(device.uuid) || asString(info.id) || result.id || '',
    );
    result.mac = normalizeMac(asString(device.wifiMac) || asString(device.mac) || result.mac || '');
    const tokenAuthSupport = parseTokenAuthSupport(info);
    if (typeof tokenAuthSupport === 'boolean') {
        result.tokenAuthSupport = tokenAuthSupport;
    }
}

async function fetchTizenInfo(
    ip: string,
    protocol: string,
    port: number,
    timeoutMs: number,
): Promise<JsonObject | null> {
    const url = `${protocol === 'wss' ? 'https' : 'http'}://${ip}:${port}/api/v2/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs, { agent: protocol === 'wss' ? httpsAgent : undefined });
        if (!res) {
            return null;
        }
        return res;
    } catch {
        return null;
    }
}

async function refreshTizenCapabilities(device: AnyDevice): Promise<void> {
    if (!device || !device.ip) {
        return;
    }
    const info =
        (await fetchTizenInfo(device.ip, 'wss', 8002, 2000)) || (await fetchTizenInfo(device.ip, 'ws', 8001, 2000));
    if (!info) {
        return;
    }
    applyTizenInfo(device, info);
    await updateDeviceInfoStates(device);
}

async function fetchHjInfo(ip: string, timeoutMs: number): Promise<JsonObject | null> {
    const url = `http://${ip}:8001/ms/1.0/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs);
        if (!res) {
            return null;
        }
        return res;
    } catch {
        return null;
    }
}

async function fetchUpnpDescription(url: string, timeoutMs: number): Promise<UpnpDescription | null> {
    try {
        const controller = new AbortController();
        const timer = adapter.setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, { signal: controller.signal });
        adapter.clearTimeout(timer);
        if (!resp.ok) {
            return null;
        }
        const text = await resp.text();
        const xml = asObject(xmlParser.parse(text));
        const device = asObject(asObject(xml.root).device || xml.device);
        const serviceList = asObject(device.serviceList).service;
        const services: unknown[] = Array.isArray(serviceList) ? serviceList : serviceList ? [serviceList] : [];
        let renderingControlUrl = '';
        let renderingControlEventUrl = '';
        for (const entry of services) {
            const svc = asObject(entry);
            const st = asString(svc.serviceType);
            if (!/RenderingControl/i.test(st)) {
                continue;
            }
            renderingControlUrl = buildAbsoluteUrl(url, asString(svc.controlURL));
            renderingControlEventUrl = buildAbsoluteUrl(url, asString(svc.eventSubURL));
            if (renderingControlUrl) {
                break;
            }
        }
        return {
            friendlyName: device.friendlyName as string | undefined,
            manufacturer: device.manufacturer as string | undefined,
            modelName: device.modelName as string | undefined,
            UDN: normalizeId(device.UDN || ''),
            renderingControlUrl,
            renderingControlEventUrl,
        };
    } catch {
        return null;
    }
}

function buildAbsoluteUrl(baseUrl: string, pathOrUrl: string): string {
    if (!pathOrUrl) {
        return '';
    }
    try {
        return new URL(pathOrUrl, baseUrl).href;
    } catch {
        return '';
    }
}

async function readUpnpAudioStatus(
    device: RuntimeDevice,
): Promise<{ volume: number | null; muted: boolean | null } | null> {
    if (!device || !device.ip) {
        return null;
    }
    const controlUrl = await getRenderingControlUrl(device);
    if (!controlUrl) {
        return null;
    }

    const [volume, muted] = await Promise.all([
        upnpGetRenderingControlValue(controlUrl, 'GetVolume', 'CurrentVolume'),
        upnpGetRenderingControlValue(controlUrl, 'GetMute', 'CurrentMute'),
    ]);

    if (volume === null && muted === null) {
        return null;
    }

    return {
        volume: typeof volume === 'number' ? Math.max(0, Math.min(100, volume)) : null,
        muted: typeof muted === 'number' ? muted !== 0 : null,
    };
}

function deriveRenderingControlEventUrl(controlUrl: string): string {
    if (!controlUrl) {
        return '';
    }
    try {
        const url = new URL(controlUrl);
        if (url.pathname.includes('/upnp/control/')) {
            url.pathname = url.pathname.replace('/upnp/control/', '/upnp/event/');
            return url.href;
        }
    } catch {
        // ignore
    }
    return '';
}

async function ensureRenderingControlUrls(device: RuntimeDevice): Promise<void> {
    if (!device || !device.ip) {
        return;
    }

    if (device.renderingControlUrl && !device.renderingControlEventUrl) {
        const derived = deriveRenderingControlEventUrl(device.renderingControlUrl);
        if (derived) {
            device.renderingControlEventUrl = derived;
            updateConfigDeviceFromDiscovery(device, {
                id: device.id,
                ip: device.ip,
                mac: device.mac,
                renderingControlEventUrl: derived,
            });
        }
    }

    if (device.renderingControlUrl && device.renderingControlEventUrl) {
        return;
    }

    const discovered = discoveredByIp.get(device.ip);
    if (discovered) {
        let changed = false;
        if (!device.renderingControlUrl && discovered.renderingControlUrl) {
            device.renderingControlUrl = discovered.renderingControlUrl;
            changed = true;
        }
        if (!device.renderingControlEventUrl && discovered.renderingControlEventUrl) {
            device.renderingControlEventUrl = discovered.renderingControlEventUrl;
            changed = true;
        }
        if (changed) {
            updateConfigDeviceFromDiscovery(device, {
                id: device.id,
                ip: device.ip,
                mac: device.mac,
                renderingControlUrl: device.renderingControlUrl,
                renderingControlEventUrl: device.renderingControlEventUrl,
            });
        }
    }

    if (device.renderingControlUrl && device.renderingControlEventUrl) {
        return;
    }

    const now = Date.now();
    if (device._renderingControlLookupTs && now - device._renderingControlLookupTs < RENDERING_CONTROL_LOOKUP_TTL) {
        return;
    }
    device._renderingControlLookupTs = now;

    let location = await discoverSsdpLocationForIp(device.ip, 'urn:schemas-upnp-org:service:RenderingControl:1', 1200);
    if (!location) {
        location = await discoverSsdpLocationForIp(device.ip, 'urn:schemas-upnp-org:device:MediaRenderer:1', 1200);
    }
    if (!location) {
        location = await discoverSsdpLocationForIp(device.ip, 'ssdp:all', 1200);
    }
    if (!location) {
        await useWellKnownRenderingControlWithRetry(device);
        return;
    }

    const desc = await fetchUpnpDescription(location, 1500);
    if (!desc) {
        await useWellKnownRenderingControlWithRetry(device);
        return;
    }
    if (desc.renderingControlUrl) {
        device.renderingControlUrl = desc.renderingControlUrl;
    }
    if (desc.renderingControlEventUrl) {
        device.renderingControlEventUrl = desc.renderingControlEventUrl;
    }
    if (device.renderingControlUrl && !device.renderingControlEventUrl) {
        const derived = deriveRenderingControlEventUrl(device.renderingControlUrl);
        if (derived) {
            device.renderingControlEventUrl = derived;
        }
    }
    if (device.renderingControlUrl || device.renderingControlEventUrl) {
        updateConfigDeviceFromDiscovery(device, {
            id: device.id,
            ip: device.ip,
            mac: device.mac,
            renderingControlUrl: device.renderingControlUrl,
            renderingControlEventUrl: device.renderingControlEventUrl,
        });
    }
    if (!device.renderingControlUrl) {
        await useWellKnownRenderingControlWithRetry(device);
    }
}

async function useWellKnownRenderingControlWithRetry(device: RuntimeDevice): Promise<boolean> {
    const found = await useWellKnownRenderingControl(device);
    if (!found) {
        device._renderingControlLookupTs = renderingControlRetryTimestamp();
    }
    return found;
}

/**
 * Last resort when SSDP yields nothing: adopt the well-known endpoint if it answers.
 *
 * @param device the device record
 * @returns true when the endpoint was adopted
 */
async function useWellKnownRenderingControl(device: RuntimeDevice): Promise<boolean> {
    const controlUrl = await probeWellKnownRenderingControl(device);
    if (!controlUrl) {
        return false;
    }

    device.renderingControlUrl = controlUrl;
    device.renderingControlEventUrl = deriveRenderingControlEventUrl(controlUrl);
    updateConfigDeviceFromDiscovery(device, {
        id: device.id,
        ip: device.ip,
        mac: device.mac,
        renderingControlUrl: device.renderingControlUrl,
        renderingControlEventUrl: device.renderingControlEventUrl,
    });
    return true;
}

/**
 * Probes http://<ip>:9197/upnp/control/RenderingControl1 directly.
 * The port is closed while the TV is in standby, so a miss is not conclusive and the
 * caller retries on a later poll.
 *
 * @param device the device record
 * @returns the control URL when the TV answered, otherwise an empty string
 */
async function probeWellKnownRenderingControl(device: RuntimeDevice): Promise<string> {
    const controlUrl = wellKnownRenderingControlUrl(device.ip);
    if (!controlUrl) {
        return '';
    }

    const response = await upnpSoapRequest(controlUrl, 'GetVolume', MASTER_CHANNEL_XML);
    if (!response) {
        return '';
    }
    if (response.ok) {
        adapter.log.debug(`RenderingControl found at the well-known endpoint for ${device.name}`);
        return controlUrl;
    }
    if (parseUpnpErrorCode(response.text) === 401) {
        adapter.log.debug(
            `${device.name} refused the RenderingControl probe with upnp:401 Invalid Action. ` +
                'The endpoint may not support this action; network or hospitality restrictions are also possible.',
        );
    }
    return '';
}

async function getRenderingControlUrl(device: RuntimeDevice): Promise<string> {
    await ensureRenderingControlUrls(device);
    return device.renderingControlUrl || '';
}

async function getRenderingControlEventUrl(device: RuntimeDevice): Promise<string> {
    await ensureRenderingControlUrls(device);
    return device.renderingControlEventUrl || '';
}

async function discoverSsdpLocationForIp(ip: string, searchTarget: string, timeoutMs: number): Promise<string> {
    if (!ip) {
        return '';
    }
    return new Promise(resolve => {
        const client = new SsdpClient();
        let done = false;
        const finish = (value: string): void => {
            if (done) {
                return;
            }
            done = true;
            try {
                client.stop();
            } catch {
                // ignore
            }
            resolve(value || '');
        };
        client.on(
            'response',
            (headers: Record<string, string | undefined>, _statusCode: number, rinfo: dgram.RemoteInfo) => {
                if (!rinfo || rinfo.address !== ip) {
                    return;
                }
                const location = ssdpHeader(headers, 'LOCATION');
                if (location) {
                    finish(location);
                }
            },
        );
        client.search(searchTarget || 'ssdp:all');
        adapter.setTimeout(() => finish(''), timeoutMs || 1000);
    });
}

function stopUpnpNotifyServer(): void {
    if (!upnpNotifyServer) {
        return;
    }
    try {
        upnpNotifyServer.close();
    } catch {
        // ignore
    }
    upnpNotifyServer = null;
    upnpNotifyPort = 0;
}

function cleanupUpnpSubscriptions(): void {
    for (const [deviceId, sub] of upnpSubscriptionsByDeviceId.entries()) {
        if (sub && sub.renewTimer) {
            adapter.clearTimeout(sub.renewTimer);
        }
        if (sub && sub.sid) {
            upnpSidToDeviceId.delete(sub.sid);
        }
        if (sub && sub.eventUrl && sub.sid) {
            upnpUnsubscribe(sub.eventUrl, sub.sid).catch(() => undefined);
        }
        upnpSubscriptionsByDeviceId.delete(deviceId);
    }
    upnpSidToDeviceId.clear();
}

async function ensureUpnpNotifyServer(): Promise<void> {
    if (upnpNotifyServer) {
        return;
    }

    const server = http.createServer((req, res) => {
        if (!req || req.method !== 'NOTIFY') {
            res.writeHead(200);
            res.end('ok');
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            handleUpnpNotify(req, body).catch(() => undefined);
            res.writeHead(200);
            res.end();
        });
    });
    upnpNotifyServer = server;

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => {
            const addr = server.address();
            upnpNotifyPort = addr && typeof addr === 'object' ? addr.port : 0;
            resolve();
        });
    });
    adapter.log.debug(`UPnP notify server listening on port ${upnpNotifyPort}`);
}

async function getLocalIpForTarget(targetIp: string): Promise<string> {
    if (!targetIp) {
        return '';
    }
    return new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => {
            try {
                socket.close();
            } catch {
                // ignore
            }
            resolve('');
        });
        socket.connect(1900, targetIp, () => {
            let addr = '';
            try {
                addr = socket.address().address;
            } catch {
                addr = '';
            }
            try {
                socket.close();
            } catch {
                // ignore
            }
            resolve(addr || '');
        });
    });
}

function getFirstLocalIp(): string {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        const entries = nets[name] || [];
        for (const entry of entries) {
            if (!entry || entry.family !== 'IPv4') {
                continue;
            }
            if (entry.internal) {
                continue;
            }
            return entry.address;
        }
    }
    return '';
}

function decodeXmlEntities(text: unknown): string {
    if (!text || typeof text !== 'string') {
        return '';
    }
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function parseUpnpLastChange(body: unknown): { volume: number | null; muted: boolean | null } {
    if (!body || typeof body !== 'string') {
        return { volume: null, muted: null };
    }
    const lastChangeMatch = body.match(/<LastChange>([\s\S]*?)<\/LastChange>/i);
    if (!lastChangeMatch || !lastChangeMatch[1]) {
        return { volume: null, muted: null };
    }
    const lastChange = decodeXmlEntities(lastChangeMatch[1]);

    // Example: <Volume channel="Master" val="6"/>
    const volMatch = lastChange.match(/<Volume[^>]*channel=["']Master["'][^>]*val=["'](\d+)["']/i);
    const muteMatch = lastChange.match(/<Mute[^>]*channel=["']Master["'][^>]*val=["'](\d+)["']/i);
    const volume = volMatch?.[1] ? parseInt(volMatch[1], 10) : null;
    const muteNum = muteMatch?.[1] ? parseInt(muteMatch[1], 10) : null;
    return {
        volume: volume !== null && Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : null,
        muted: muteNum !== null && Number.isFinite(muteNum) ? muteNum !== 0 : null,
    };
}

async function handleUpnpNotify(req: http.IncomingMessage, body: string): Promise<void> {
    const sid = (req.headers && (req.headers.sid as string | undefined)) || '';
    if (!sid) {
        return;
    }
    const deviceId = upnpSidToDeviceId.get(sid);
    if (!deviceId) {
        return;
    }
    const device = devicesById.get(deviceId);
    if (!device) {
        return;
    }
    const { volume, muted } = parseUpnpLastChange(body);
    if (typeof volume === 'number' && Number.isFinite(volume)) {
        device.lastKnownVolume = volume;
        await adapter.setStateAsync(`${device.name}.state.volume`, volume, true);
    }
    if (typeof muted === 'boolean') {
        device.lastKnownMuted = muted;
        await adapter.setStateAsync(`${device.name}.state.muted`, muted, true);
    }
    await adapter.setStateAsync(`${device.name}.info.online`, true, true);
    await adapter.setStateAsync(`${device.name}.info.unreach`, false, true);
    markSeen(device);
    adapter.log.debug(`UPnP notify for ${device.name}: volume=${volume ?? '-'} muted=${muted ?? '-'}`);
}

function dropUpnpSubscription(deviceId: string): void {
    const sub = upnpSubscriptionsByDeviceId.get(deviceId);
    if (!sub) {
        return;
    }
    if (sub.renewTimer) {
        adapter.clearTimeout(sub.renewTimer);
    }
    upnpSubscriptionsByDeviceId.delete(deviceId);
    if (sub.sid) {
        upnpSidToDeviceId.delete(sub.sid);
    }
    if (sub.eventUrl && sub.sid) {
        upnpUnsubscribe(sub.eventUrl, sub.sid).catch(() => undefined);
    }
}

async function ensureUpnpEventSubscription(device: RuntimeDevice): Promise<void> {
    if (!device || device.api !== 'hj' || !device.ip) {
        return;
    }
    await ensureUpnpNotifyServer();
    if (!upnpNotifyPort) {
        return;
    }
    const eventUrl = await getRenderingControlEventUrl(device);
    if (!eventUrl) {
        return;
    }

    const existing = upnpSubscriptionsByDeviceId.get(device.id);
    const now = Date.now();
    if (
        existing &&
        existing.sid &&
        existing.eventUrl === eventUrl &&
        typeof existing.expiresAt === 'number' &&
        now < existing.expiresAt - 20000
    ) {
        return;
    }

    if (existing) {
        dropUpnpSubscription(device.id);
    }

    const localIp = (await getLocalIpForTarget(device.ip)) || getFirstLocalIp();
    if (!localIp) {
        return;
    }
    const callbackUrl = `http://${localIp}:${upnpNotifyPort}/upnp-notify`;
    const sub = await upnpSubscribe(eventUrl, callbackUrl);
    if (!sub || !sub.sid) {
        return;
    }
    upnpSidToDeviceId.set(sub.sid, device.id);

    const timeoutSec = sub.timeoutSec || 300;
    const expiresAt = Date.now() + timeoutSec * 1000;
    const renewDelay = Math.max(30000, Math.floor(timeoutSec * 0.8) * 1000);
    const renewTimer = adapter.setTimeout(() => renewUpnpSubscription(device.id), renewDelay);

    upnpSubscriptionsByDeviceId.set(device.id, { sid: sub.sid, eventUrl, expiresAt, renewTimer });
    adapter.log.debug(`UPnP subscribed for ${device.name}: sid=${sub.sid} timeout=${timeoutSec}s`);
}

async function renewUpnpSubscription(deviceId: string): Promise<void> {
    const sub = upnpSubscriptionsByDeviceId.get(deviceId);
    if (!sub || !sub.sid || !sub.eventUrl) {
        return;
    }
    try {
        const timeoutSec = (await upnpRenew(sub.eventUrl, sub.sid)) || 300;
        sub.expiresAt = Date.now() + timeoutSec * 1000;
        const renewDelay = Math.max(30000, Math.floor(timeoutSec * 0.8) * 1000);
        sub.renewTimer = adapter.setTimeout(() => renewUpnpSubscription(deviceId), renewDelay);
        upnpSubscriptionsByDeviceId.set(deviceId, sub);
        adapter.log.debug(`UPnP renewed for ${deviceId}: sid=${sub.sid} timeout=${timeoutSec}s`);
    } catch (e) {
        adapter.log.debug(`UPnP renew failed for ${deviceId}: ${errorMessage(e)}`);
        dropUpnpSubscription(deviceId);
    }
}

function requestTimeoutToSeconds(value: unknown, defaultSeconds: number): number {
    if (!value || typeof value !== 'string') {
        return defaultSeconds;
    }
    // Known issue kept 1:1 from the JavaScript version: `\\d` matches a backslash followed by
    // "d", so the timeout of the TV is never read and `defaultSeconds` is used.
    const match = value.match(/Second-(\\d+)/i);
    const parsed = match && match[1] ? parseInt(match[1], 10) : NaN;
    return Number.isFinite(parsed) ? parsed : defaultSeconds;
}

/** Options of an `http.request` to a UPnP event URL */
function upnpEventRequestOptions(
    eventUrl: string,
    method: string,
    headers: Record<string, string>,
): http.RequestOptions {
    const url = new URL(eventUrl);
    return {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 80,
        path: url.pathname + (url.search || ''),
        method,
        headers,
    };
}

async function upnpSubscribe(eventUrl: string, callbackUrl: string): Promise<{ sid: string; timeoutSec: number }> {
    const options = upnpEventRequestOptions(eventUrl, 'SUBSCRIBE', {
        CALLBACK: `<${callbackUrl}>`,
        NT: 'upnp:event',
        TIMEOUT: 'Second-300',
    });

    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            res.resume();
            const sid = (res.headers.sid as string | undefined) || '';
            const statusCode = res.statusCode || 0;
            if (!sid || statusCode < 200 || statusCode >= 300) {
                return reject(new Error(`SUBSCRIBE failed (status ${statusCode})`));
            }
            const timeoutSec = requestTimeoutToSeconds(res.headers.timeout, 300);
            resolve({ sid, timeoutSec });
        });
        req.on('error', reject);
        req.end();
    });
}

async function upnpRenew(eventUrl: string, sid: string): Promise<number> {
    const options = upnpEventRequestOptions(eventUrl, 'SUBSCRIBE', {
        SID: sid,
        TIMEOUT: 'Second-300',
    });

    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            res.resume();
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
                return reject(new Error(`SUBSCRIBE renew failed (status ${statusCode})`));
            }
            resolve(requestTimeoutToSeconds(res.headers.timeout, 300));
        });
        req.on('error', reject);
        req.end();
    });
}

async function upnpUnsubscribe(eventUrl: string, sid: string): Promise<void> {
    const options = upnpEventRequestOptions(eventUrl, 'UNSUBSCRIBE', {
        SID: sid,
    });

    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            res.resume();
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
                return reject(new Error(`UNSUBSCRIBE failed (status ${statusCode})`));
            }
            resolve();
        });
        req.on('error', reject);
        req.end();
    });
}

async function upnpSoapRequest(
    controlUrl: string,
    action: string,
    innerXml: string,
    timeoutMs = UPNP_REQUEST_TIMEOUT,
): Promise<{ ok: boolean; status: number; text: string } | null> {
    const controller = new AbortController();
    const timer = adapter.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(controlUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                SOAPACTION: `"${RENDERING_CONTROL_URN}#${action}"`,
            },
            body: buildSoapEnvelope(action, innerXml),
            signal: controller.signal,
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
    } catch {
        return null;
    } finally {
        adapter.clearTimeout(timer);
    }
}

async function upnpGetRenderingControlValue(
    controlUrl: string,
    action: string,
    tagName: string,
): Promise<number | null> {
    const response = await upnpSoapRequest(controlUrl, action, MASTER_CHANNEL_XML);
    if (!response || !response.ok) {
        return null;
    }
    const match = response.text.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'i'));
    if (!match || !match[1]) {
        return null;
    }
    const parsed = parseInt(match[1], 10);
    return Number.isNaN(parsed) ? null : parsed;
}

async function upnpSetRenderingControlValue(device: RuntimeDevice, action: string, valueXml: string): Promise<void> {
    const controlUrl = await getRenderingControlUrl(device);
    if (!controlUrl) {
        throw new Error('No RenderingControl endpoint known for this TV');
    }

    const response = await upnpSoapRequest(controlUrl, action, `${MASTER_CHANNEL_XML}\n${valueXml}`, 2000);
    if (!response) {
        throw new Error(`${action} did not answer (the TV is probably in standby)`);
    }
    if (response.ok) {
        return;
    }

    const code = parseUpnpErrorCode(response.text);
    if (code === 401) {
        throw new Error(
            `${action} failed (upnp:401 ${upnpErrorDescription(code)}). ` +
                'The endpoint may not support this action; network or hospitality restrictions are also possible.',
        );
    }
    if (code === 402) {
        throw new Error(`${action} rejected the arguments (upnp:402 ${upnpErrorDescription(code)})`);
    }
    const description = upnpErrorDescription(code);
    const errorDetails = code === null ? '' : `, upnp:${code}${description ? ` ${description}` : ''}`;
    throw new Error(`${action} failed (HTTP ${response.status}${errorDetails})`);
}

/**
 * GET a JSON document. `agent` is kept from the JavaScript version, which passed it to the global
 * `fetch` - that ignores the option, so HTTPS requests to the self-signed certificate of a TV fail.
 */
async function fetchWithTimeout(
    url: string,
    timeoutMs: number,
    options: RequestInit & { agent?: https.Agent } = {},
): Promise<JsonObject | null> {
    const controller = new AbortController();
    const timer = adapter.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        if (!resp.ok) {
            return null;
        }
        return (await resp.json()) as JsonObject;
    } catch {
        return null;
    } finally {
        adapter.clearTimeout(timer);
    }
}

async function checkPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result: boolean): void => {
            if (done) {
                return;
            }
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
        socket.connect(port, ip, () => finish(true));
    });
}

function pingHost(ip: string, timeoutMs: number): Promise<boolean | null> {
    if (pingUnavailable) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const timeout = Math.max(250, Math.min(60000, Number(timeoutMs) || 1000));
        const args = getPingArguments(process.platform, ip, timeout);
        execFile('ping', args, { timeout: timeout + 500 }, err => {
            if (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    pingUnavailable = true;
                    adapter.log.debug('ping command not available; skipping ICMP power checks.');
                    return resolve(null);
                }
                return resolve(false);
            }
            resolve(true);
        });
    });
}

function execFileOutput(command: string, args: string[], timeoutMs = 2500): Promise<string> {
    return new Promise(resolve => {
        execFile(command, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
}

async function getMacForIp(ip: string): Promise<string> {
    if (!ip) {
        return '';
    }
    const commands: [string, string[]][] =
        process.platform === 'win32'
            ? [['arp', ['-a', ip]]]
            : [
                  ['ip', ['neigh', 'show', ip]],
                  ['arp', ['-n', ip]],
              ];
    for (const [command, args] of commands) {
        const output = await execFileOutput(command, args);
        const mac = parseMacFromArpOutput(output, ip);
        if (mac) {
            return mac;
        }
    }
    return '';
}

function looksLikeIp(value: unknown): boolean {
    if (!value || typeof value !== 'string') {
        return false;
    }
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim());
}

let arpCache: { ts: number; map: Map<string, string> } = { ts: 0, map: new Map() };

async function refreshIpFromMac(device: RuntimeDevice): Promise<boolean> {
    if (!device || !device.mac) {
        return false;
    }
    const mac = normalizeMac(device.mac);
    const ip = await getIpForMac(mac);
    if (ip && ip !== device.ip) {
        device.ip = ip;
        await updateDeviceInfoStates(device);
        adapter.log.debug(`IP updated for ${device.name} via MAC ${mac}: ${ip}`);
        return true;
    }
    return false;
}

async function getIpForMac(mac: string): Promise<string> {
    if (!mac) {
        return '';
    }
    const table = await getArpTable();
    return table.get(normalizeMac(mac)) || '';
}

async function getArpTable(): Promise<Map<string, string>> {
    const now = Date.now();
    if (now - arpCache.ts < 10000 && arpCache.map.size) {
        return arpCache.map;
    }

    const commands: [string, string[]][] =
        process.platform === 'win32'
            ? [['arp', ['-a']]]
            : [
                  ['ip', ['neigh']],
                  ['arp', ['-an']],
              ];
    let map = new Map<string, string>();
    for (const [command, args] of commands) {
        map = parseArpTable(await execFileOutput(command, args));
        if (map.size > 0) {
            break;
        }
    }

    arpCache = { ts: now, map };
    return map;
}

if (require.main !== module) {
    module.exports = createAdapter;
} else {
    createAdapter();
}
