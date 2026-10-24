import path from 'node:path';
import type { AdapterInstance } from '@iobroker/adapter-core';
import {
    DeviceManagement,
    type ActionContext,
    type ConfigItemNumber,
    type ConfigItemPanel,
    type ConfigItemSelect,
    type ConfigItemText,
    type ControlState,
    type DeviceAction,
    type DeviceControl,
    type DeviceDetails,
    type DeviceInfo,
    type DeviceLoadContext,
    type DeviceRefreshResponse,
    type InstanceDetails,
    type InstanceRefreshResponse,
    type JsonFormData,
} from '@iobroker/dm-utils';

/** A configured or discovered TV as handed to the Device Manager by the adapter */
export interface ManagedDevice {
    id: string;
    name: string;
    displayName?: string;
    ip?: string;
    mac?: string;
    model?: string;
    api?: string;
    protocol?: string;
    port?: number | string;
    uuid?: string;
    source?: string | string[];
}

/**
 * Adapter functionality the Device Manager calls into. Every device passed to a callback was
 * obtained from `getConfiguredDevices`, `getDiscoveredDevices` or `findDevice` before.
 */
export interface DeviceManagementService<TDevice extends ManagedDevice = ManagedDevice> {
    getConfiguredDevices(): TDevice[];
    getDiscoveredDevices(): TDevice[];
    isConfigured(device: TDevice): boolean;
    isDevicePaired(device: TDevice): boolean;
    suggestName(device: TDevice): string;
    findDevice(id: string): TDevice | null | undefined;
    discover(): Promise<unknown[]>;
    addDevice(candidate: JsonFormData): Promise<unknown>;
    renameDevice(id: string, name: string): Promise<unknown>;
    removeDevice(id: string): Promise<unknown>;
    requestPin(device: TDevice): Promise<unknown>;
    confirmPin(device: TDevice, pin: string): Promise<unknown>;
    pairTizen(device: TDevice): Promise<unknown>;
    setTizenToken(device: TDevice, token: string): Promise<unknown>;
    /** Order of the source menu after SmartThings, e.g. `['TV', 'HDMI2']`; empty for direct input keys */
    getSourceMenu(device: TDevice): string[];
    setSourceMenu(device: TDevice, menu: string): Promise<unknown>;
    /** Send `KEY_INFO`, which shows a banner on the TV */
    sendTestKey(device: TDevice): Promise<unknown>;
    /** What the TV offers to control: inputs and apps as `common.states`, whether it has Art Mode */
    getCapabilities(device: TDevice): TvCapabilities;
    /** Execute a control of the device card: `power`, `volume`, `muted`, `source`, `launchApp` or `artMode` */
    control(device: TDevice, control: string, value: ControlState): Promise<unknown>;
}

/** What a TV offers to control in its device card */
export interface TvCapabilities {
    /** Inputs, e.g. `{ HDMI2: 'HDMI 2' }` */
    inputs: Record<string, string>;
    /** Apps, e.g. `{ YOUTUBE: 'YouTube' }` */
    apps: Record<string, string>;
    artMode: boolean;
}

/** A text in all admin languages */
export type TranslatedText = Record<ioBroker.Languages, string>;

export const LANGUAGES: ioBroker.Languages[] = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const TRANSLATABLE_ERROR_KEYS = new Set(['Token rejected', 'Token changed', 'Token verification unavailable']);
const TV_ICON = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="#1689c9" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><rect x="2.5" y="4" width="19" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></g></svg>',
).toString('base64')}`;
// Mid grey so the key reads on both light and dark admin themes; an <img> cannot inherit the theme colour.
/** An icon as data URL; an <img> cannot follow the theme or the indicator color, so each state has its own */
function svgIcon(paths: string, color: string): string {
    return `data:image/svg+xml;base64,${Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${paths}</g></svg>`,
    ).toString('base64')}`;
}
const POWER_PATHS = '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>';
const VOLUME_PATHS = '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>';
const MUTED_PATHS = '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 5 6M22 9l-5 6"/>';
const POWER_OFF_ICON = svgIcon(POWER_PATHS, '#808080');
const POWER_ON_ICON = svgIcon(POWER_PATHS, '#2e7d32');
const VOLUME_ICON = svgIcon(VOLUME_PATHS, '#808080');
const MUTED_ICON = svgIcon(MUTED_PATHS, '#d32f2f');
const KEY_ICON = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="#808080" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M18 5l2 2"/></g></svg>',
).toString('base64')}`;

function loadTranslations(): Record<string, Record<string, string>> {
    const translations: Record<string, Record<string, string>> = {};
    for (const language of LANGUAGES) {
        try {
            // Loaded at runtime from <adapter>/admin/i18n (this file runs from build/lib/)
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            translations[language] = require(path.join(__dirname, '..', '..', 'admin', 'i18n', `${language}.json`));
        } catch {
            translations[language] = {};
        }
    }
    return translations;
}

const translations = loadTranslations();

export function t(key: string): TranslatedText {
    return Object.fromEntries(
        LANGUAGES.map(language => [language, translations[language]![key] || key]),
    ) as TranslatedText;
}

// The admin renders translated objects here as well, but dm-utils types these fields as plain strings.
function tString(key: string): string {
    return t(key) as unknown as string;
}

/** The add/edit form; the concrete item types let callers inspect single fields */
export type DeviceFormSchema = ConfigItemPanel & {
    items: {
        name: ConfigItemText;
        ip: ConfigItemText;
        mac: ConfigItemText;
        model: ConfigItemText;
        id: ConfigItemText;
        api: ConfigItemSelect;
        protocol: ConfigItemSelect;
        port: ConfigItemNumber;
    };
};

export function deviceForm(
    device: Partial<ManagedDevice> = {},
    options: { readOnlyIdentity?: boolean } = {},
): DeviceFormSchema {
    const readOnlyIdentity = options.readOnlyIdentity === true;
    return {
        type: 'panel',
        items: {
            name: {
                type: 'text',
                label: t('Name'),
                default: device.name || '',
                xs: 12,
                sm: 6,
                validator: '!!data.name && /^[a-zA-Z0-9 _-]+$/.test(data.name)',
                validatorErrorText: tString('Name validation error'),
                validatorNoSaveOnError: true,
            },
            ip: {
                type: 'text',
                label: t('IP address'),
                default: device.ip || '',
                disabled: readOnlyIdentity,
                validator: '!!data.ip || !!data.mac',
                validatorErrorText: tString('IP or MAC required'),
                validatorNoSaveOnError: true,
                xs: 12,
                sm: 6,
            },
            mac: {
                type: 'text',
                label: t('MAC address'),
                default: device.mac || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            model: {
                type: 'text',
                label: t('Model'),
                default: device.model || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            id: {
                type: 'text',
                label: t('Device ID'),
                default: device.id || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            api: {
                type: 'select',
                label: t('API'),
                default: device.api || 'unknown',
                options: [
                    { value: 'unknown', label: t('Automatic') },
                    { value: 'tizen', label: 'Tizen' },
                    { value: 'hj', label: 'Samsung H/J' },
                    { value: 'legacy', label: 'Samsung TCP' },
                ],
                xs: 12,
                sm: 6,
            },
            protocol: {
                type: 'select',
                label: t('Protocol'),
                default: device.protocol || '',
                options: [
                    { value: '', label: t('Automatic') },
                    { value: 'wss', label: 'WSS' },
                    { value: 'ws', label: 'WS' },
                    { value: 'tcp', label: 'TCP' },
                ],
                xs: 12,
                sm: 6,
            },
            port: {
                type: 'number',
                label: t('Port'),
                default: Number(device.port) || 0,
                min: 0,
                max: 65535,
                xs: 12,
                sm: 6,
            },
        },
    };
}

export class SamsungTvDeviceManagement<TDevice extends ManagedDevice = ManagedDevice> extends DeviceManagement {
    public service: DeviceManagementService<TDevice>;

    public constructor(adapter: AdapterInstance, service: DeviceManagementService<TDevice>) {
        super(adapter, true);
        this.service = service;
    }

    public override getInstanceInfo(): InstanceDetails {
        return {
            apiVersion: 'v3',
            communicationStateId: 'info.deviceManager',
            identifierLabel: 'ID',
            smallCards: false,
            actions: [
                {
                    id: 'discover',
                    icon: 'search',
                    title: t('Scan'),
                    description: t('Scan description'),
                    timeout: 120000,
                    handler: context => this.discover(context),
                },
                {
                    id: 'manual-add',
                    icon: 'add',
                    title: t('Manual add'),
                    description: t('Manual add description'),
                    handler: context => this.manualAdd(context),
                },
            ],
        };
    }

    // eslint-disable-next-line @typescript-eslint/require-await -- kept async: callers await it
    public override async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
        const configured = this.service.getConfiguredDevices();
        const configuredIds = new Set(configured.map(device => device.id));
        const discovered = this.service
            .getDiscoveredDevices()
            .filter(device => !configuredIds.has(device.id) && !this.service.isConfigured(device));
        const devices = [
            ...configured.map(device => this.configuredDeviceInfo(device)),
            ...discovered.map(device => this.discoveredDeviceInfo(device)),
        ];
        context.setTotalDevices(devices.length);
        for (const device of devices) {
            context.addDevice(device);
        }
    }

    public configuredDeviceInfo(device: TDevice): DeviceInfo<string> {
        const namespace = this.adapter.namespace;
        const paired = this.service.isDevicePaired(device);
        const actions: DeviceAction<string>[] = [
            {
                id: 'rename',
                icon: 'rename',
                description: t('Rename'),
                handler: (id, context) => this.rename(id, context),
            },
            {
                id: 'delete',
                icon: 'delete',
                color: 'error',
                description: t('Remove'),
                confirmation: t('Remove confirmation'),
                handler: id => this.remove(id),
            },
        ];
        if (device.api === 'tizen' || device.api === 'hj' || device.api === 'unknown') {
            actions.unshift({
                id: 'pair',
                icon: paired ? 'unpairDevice' : 'pairDevice',
                description: t(paired ? 'Pair again' : 'Pair'),
                timeout: 120000,
                handler: (id, context) => this.pair(id, context),
            });
        }
        if (device.api === 'tizen' || device.api === 'unknown') {
            actions.splice(1, 0, {
                id: 'set-token',
                icon: KEY_ICON,
                description: t('Set token'),
                handler: (id, context) => this.setToken(id, context),
            });
        }
        // triggered by the indicators of the status line, not shown as buttons
        actions.push(
            {
                id: 'power',
                icon: POWER_ON_ICON,
                description: t('Switch on or off'),
                timeout: 60000,
                handler: id => this.togglePower(id),
            },
            {
                id: 'volume',
                icon: VOLUME_ICON,
                description: t('Set the volume'),
                handler: (id, context) => this.setVolume(id, context),
            },
            {
                id: 'unmute',
                icon: MUTED_ICON,
                description: t('Switch the sound on'),
                handler: (id, context) => this.unmute(id, context),
            },
        );
        // before rename and delete
        actions.splice(actions.length - 5, 0, {
            id: 'test',
            icon: 'play',
            description: t('Test connection'),
            handler: (id, context) => this.test(id, context),
        });
        if (device.api === 'tizen' || device.api === 'unknown') {
            actions.splice(actions.length - 5, 0, {
                id: 'inputs',
                icon: 'settings',
                description: t('Inputs'),
                handler: (id, context) => this.inputs(id, context),
            });
        }
        return {
            id: device.id,
            identifier: device.mac || device.uuid || device.id,
            name: device.displayName || device.name,
            icon: TV_ICON,
            manufacturer: 'Samsung',
            model: device.model || t('Unknown'),
            connectionType: device.mac ? 'lan' : 'other',
            status: {
                connection: {
                    stateId: `${namespace}.${device.name}.info.online`,
                    mapping: { true: 'connected', false: 'disconnected' },
                },
            },
            controls: this.controlsOf(device),
            indicators: [
                // power, volume and mute right on the card: one click switches, the volume opens a slider
                {
                    id: 'power',
                    value: { stateId: `${namespace}.${device.name}.state.power` },
                    icon: POWER_OFF_ICON,
                    iconOn: POWER_ON_ICON,
                    color: 'inactive',
                    colorOn: 'ok',
                    levels: [
                        { value: true, text: t('On') },
                        { value: false, text: t('Off') },
                    ],
                    tooltip: t('Switch on or off'),
                    actionId: 'power',
                    hideIfEmpty: false,
                    order: 1,
                },
                {
                    id: 'volume',
                    value: { stateId: `${namespace}.${device.name}.state.volume` },
                    icon: VOLUME_ICON,
                    showValue: true,
                    unit: '%',
                    tooltip: t('Set the volume'),
                    actionId: 'volume',
                    hideIfEmpty: false,
                    order: 2,
                },
                {
                    id: 'muted',
                    value: { stateId: `${namespace}.${device.name}.state.muted` },
                    icon: MUTED_ICON,
                    color: 'error',
                    text: t('Muted'),
                    tooltip: t('Switch the sound on'),
                    actionId: 'unmute',
                    // only visible while muted
                    hideIfEmpty: true,
                    order: 3,
                },
                {
                    id: 'paired',
                    value: { stateId: `${namespace}.${device.name}.info.paired` },
                    icon: 'unpairDevice',
                    iconOn: 'pairDevice',
                    color: 'inactive',
                    colorOn: 'ok',
                    text: paired ? t('Paired') : t('Not paired'),
                    tooltip: t('Pairing status'),
                    hideIfEmpty: false,
                },
            ],
            actions,
            hasDetails: true,
            group: { key: 'configured', name: t('Added TVs'), icon: TV_ICON },
        };
    }

    /**
     * The controls of the device card: power, volume as a number, mute, input, app and Art Mode. Each one
     * shows its state of the `control` channel and writes through the adapter, like writing that state.
     */
    public controlsOf(device: TDevice): DeviceControl<string>[] {
        const base = `${this.adapter.namespace}.${device.name}.control`;
        const capabilities = this.service.getCapabilities(device);
        const handler = async (
            _deviceId: string,
            control: string,
            value: ControlState,
        ): Promise<ioBroker.State | { error: { code: number; message: string } }> => {
            try {
                await this.service.control(device, control, value);
            } catch (error) {
                return { error: { code: 500, message: error instanceof Error ? error.message : String(error) } };
            }
            return {
                val: value,
                ack: true,
                ts: Date.now(),
                lc: Date.now(),
                from: this.adapter.namespace,
            };
        };
        // the card asks for the current value when it shows a control; it is the state of the control channel
        const getStateHandler = async (
            _deviceId: string,
            control: string,
        ): Promise<ioBroker.State | { error: { code: number; message: string } }> => {
            const state = await this.adapter.getForeignStateAsync(`${base}.${control}`);
            return state ?? { val: null, ack: true, ts: Date.now(), lc: Date.now(), from: this.adapter.namespace };
        };
        const options = (values: Record<string, string>): { label: string; value: string }[] =>
            Object.entries(values).map(([value, label]) => ({ label, value }));

        const controls: DeviceControl<string>[] = [
            { id: 'power', type: 'switch', label: t('Power'), stateId: `${base}.power`, handler },
            {
                id: 'volume',
                type: 'slider',
                label: t('Volume'),
                stateId: `${base}.volume`,
                min: 0,
                max: 100,
                step: 1,
                unit: '%',
                controlDelay: 500,
                handler,
            },
            { id: 'muted', type: 'switch', label: t('Muted'), stateId: `${base}.muted`, handler },
        ];
        if (Object.keys(capabilities.inputs).length) {
            controls.push({
                id: 'source',
                type: 'select',
                label: t('Input'),
                stateId: `${base}.source`,
                options: options(capabilities.inputs),
                noTranslation: true,
                handler,
            });
        }
        if (Object.keys(capabilities.apps).length) {
            controls.push({
                id: 'launchApp',
                type: 'select',
                label: t('App'),
                stateId: `${base}.launchApp`,
                options: options(capabilities.apps),
                noTranslation: true,
                handler,
            });
        }
        if (capabilities.artMode) {
            controls.push({ id: 'artMode', type: 'switch', label: t('Art Mode'), stateId: `${base}.artMode`, handler });
        }
        return controls.map(control => ({ ...control, getStateHandler }));
    }

    /** The current value of a state of the TV, `null` if it has none */
    private async stateOf(device: TDevice, state: string): Promise<ioBroker.StateValue> {
        const value = await this.adapter.getForeignStateAsync(`${this.adapter.namespace}.${device.name}.${state}`);
        return value ? value.val : null;
    }

    /** Switch the TV on if it is off, off otherwise */
    public async togglePower(id: string): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (device) {
            await this.service.control(device, 'power', !(await this.stateOf(device, 'state.power')));
        }
        return { refresh: 'none' };
    }

    public async setVolume(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            return { refresh: 'devices' };
        }
        const current = Number(await this.stateOf(device, 'state.volume'));
        const data = await context.showForm(
            {
                type: 'panel',
                items: {
                    volume: {
                        type: 'slider',
                        label: t('Volume'),
                        min: 0,
                        max: 100,
                        step: 1,
                        unit: '%',
                        default: Number.isFinite(current) ? current : 0,
                        xs: 12,
                    },
                },
            },
            { title: t('Set the volume'), buttons: ['cancel', 'apply'] },
        );
        if (data) {
            try {
                await this.service.control(device, 'volume', Number(data.volume));
            } catch (error) {
                await context.showMessage(this.errorMessage('Volume failed', error));
            }
        }
        return { refresh: 'none' };
    }

    public async unmute(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (device) {
            try {
                await this.service.control(device, 'muted', false);
            } catch (error) {
                await context.showMessage(this.errorMessage('Volume failed', error));
            }
        }
        return { refresh: 'none' };
    }

    public discoveredDeviceInfo(device: TDevice): DeviceInfo<string> {
        return {
            id: device.id,
            identifier: device.mac || device.uuid || device.id,
            name: device.displayName || device.name || device.model || device.ip!,
            icon: TV_ICON,
            manufacturer: 'Samsung',
            model: device.model || t('Unknown'),
            connectionType: device.mac ? 'lan' : 'other',
            status: 'connected',
            indicators: [
                {
                    id: 'discovered',
                    icon: 'search',
                    color: 'info',
                    text: t('Discovered'),
                    tooltip: t('Discovered device'),
                    hideIfEmpty: false,
                },
            ],
            actions: [
                {
                    id: 'add',
                    icon: 'add',
                    title: t('Add'),
                    variant: 'contained',
                    description: t('Add discovered TV'),
                    handler: (id, context) => this.addDiscovered(id, context),
                },
            ],
            hasDetails: true,
            group: { key: 'discovered', name: t('Discovered TVs'), icon: 'search' },
        };
    }

    public override getDeviceDetails(id: string): DeviceDetails<string> | null {
        const device = this.service.findDevice(id);
        if (!device) {
            return null;
        }
        return {
            id,
            schema: {
                type: 'panel',
                items: {
                    ip: { type: 'staticInfo', label: t('IP address'), data: device.ip || '-' },
                    mac: { type: 'staticInfo', label: t('MAC address'), data: device.mac || '-' },
                    model: { type: 'staticInfo', label: t('Model'), data: device.model || '-' },
                    api: { type: 'staticInfo', label: t('API'), data: device.api || 'unknown' },
                    protocol: { type: 'staticInfo', label: t('Protocol'), data: device.protocol || '-' },
                    source: {
                        type: 'staticInfo',
                        label: t('Found via'),
                        data: Array.isArray(device.source) ? device.source.join(', ') : device.source || '-',
                    },
                },
            },
        };
    }

    public async discover(context: ActionContext): Promise<InstanceRefreshResponse> {
        try {
            const devices = await this.service.discover();
            const message = t(devices.length === 1 ? 'One TV found' : 'TVs found');
            await context.showMessage(
                Object.fromEntries(
                    LANGUAGES.map(language => [language, message[language].replace('%s', String(devices.length))]),
                ) as TranslatedText,
            );
            return { refresh: true };
        } catch (error) {
            await context.showMessage(this.errorMessage('Discovery failed', error));
            return { refresh: false };
        }
    }

    public async manualAdd(context: ActionContext): Promise<InstanceRefreshResponse> {
        const data = await context.showForm(deviceForm(), {
            title: t('Manual add'),
            buttons: ['cancel', 'apply'],
        });
        if (!data) {
            return { refresh: false };
        }
        let added: TDevice;
        try {
            added = (await this.service.addDevice(data)) as TDevice;
        } catch (error) {
            await context.showMessage(this.errorMessage('Add failed', error));
            return { refresh: false };
        }
        await this.setUp(added.id, context);
        return { refresh: true };
    }

    public async addDiscovered(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        const suggested = { ...device, name: this.service.suggestName(device) };
        const data = await context.showForm(deviceForm(suggested, { readOnlyIdentity: true }), {
            title: t('Add device'),
            buttons: ['cancel', 'apply'],
        });
        if (!data) {
            return { refresh: 'none' };
        }
        let added: TDevice;
        try {
            added = (await this.service.addDevice({ ...device, ...data, id: device.id })) as TDevice;
        } catch (error) {
            await context.showMessage(this.errorMessage('Add failed', error));
            return { refresh: 'none' };
        }
        await this.setUp(added.id, context);
        return { refresh: 'devices' };
    }

    /**
     * The setup assistant after adding a TV: pair it, check that a key arrives, and ask for the order of
     * the source menu. Every step can be skipped and is also available as an action of the TV.
     */
    public async setUp(id: string, context: ActionContext): Promise<void> {
        let device = this.service.findDevice(id);
        if (!device) {
            return;
        }
        if (
            (device.api === 'tizen' || device.api === 'hj' || device.api === 'unknown') &&
            !this.service.isDevicePaired(device) &&
            (await context.showConfirmation(t('Pair now?')))
        ) {
            if (!(await this.runPairing(device, context))) {
                return;
            }
        }
        // pairing may have changed the API from unknown to tizen
        device = this.service.findDevice(id) || device;
        if (await context.showConfirmation(t('Send a test key?'))) {
            await this.runTest(device, context);
        }
        if (device.api === 'tizen' && (await context.showConfirmation(t('Set up the inputs now?')))) {
            await this.runInputs(device, context);
        }
        await context.showMessage(t('Setup done'));
    }

    public async test(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        await this.runTest(device, context);
        return { refresh: 'none' };
    }

    /** Send the test key and ask whether the TV reacted */
    public async runTest(device: TDevice, context: ActionContext): Promise<void> {
        try {
            await this.service.sendTestKey(device);
        } catch (error) {
            await context.showMessage(this.errorMessage('Test failed', error));
            return;
        }
        if (!(await context.showConfirmation(t('Test key sent')))) {
            await context.showMessage(t('Test key not seen'));
        }
    }

    public async inputs(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        await this.runInputs(device, context);
        // the input list of the device card changes
        return { refresh: 'devices' };
    }

    /** Ask for the order of the source menu */
    public async runInputs(device: TDevice, context: ActionContext): Promise<void> {
        const data = await context.showForm(
            {
                type: 'panel',
                items: {
                    _help: { type: 'staticText', text: tString('Source menu help'), xs: 12 },
                    sourceMenu: {
                        type: 'text',
                        label: t('Source menu order'),
                        default: this.service.getSourceMenu(device).join(', '),
                        xs: 12,
                    },
                },
            },
            { title: t('Inputs'), buttons: ['cancel', 'apply'] },
        );
        if (!data) {
            return;
        }
        try {
            await this.service.setSourceMenu(device, String(data.sourceMenu ?? ''));
        } catch (error) {
            await context.showMessage(this.errorMessage('Save failed', error));
        }
    }

    public async rename(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            return { refresh: 'devices' };
        }
        const data = await context.showForm(
            {
                type: 'panel',
                items: {
                    name: {
                        type: 'text',
                        label: t('Name'),
                        default: device.name,
                        validator: '!!data.name && /^[a-zA-Z0-9 _-]+$/.test(data.name)',
                        validatorErrorText: tString('Name validation error'),
                        validatorNoSaveOnError: true,
                        xs: 12,
                    },
                },
            },
            { title: t('Rename'), buttons: ['cancel', 'apply'] },
        );
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.service.renameDevice(id, data.name);
            return { refresh: 'devices' };
        } catch (error) {
            await context.showMessage(this.errorMessage('Rename failed', error));
            return { refresh: 'none' };
        }
    }

    public async remove(id: string): Promise<DeviceRefreshResponse<string>> {
        await this.service.removeDevice(id);
        return { refresh: 'devices' };
    }

    public async pair(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        await this.runPairing(device, context);
        return { refresh: 'devices' };
    }

    /** Pair with the TV; `false` if it failed or was cancelled */
    public async runPairing(device: TDevice, context: ActionContext): Promise<boolean> {
        try {
            if (device.api === 'hj') {
                await this.service.requestPin(device);
                const data = await context.showForm(
                    {
                        type: 'panel',
                        items: {
                            pin: {
                                type: 'text',
                                label: t('Enter PIN'),
                                validator: '!!data.pin',
                                validatorNoSaveOnError: true,
                                xs: 12,
                            },
                        },
                    },
                    { title: t('Enter PIN'), buttons: ['cancel', 'apply'] },
                );
                if (!data) {
                    return false;
                }
                await this.service.confirmPin(device, String(data.pin));
            } else {
                // the TV asks only while the connection waits, so tell the user before
                await context.showMessage(t('Allow on the TV'));
                await this.service.pairTizen(device);
            }
            await context.showMessage(t('Paired'));
            return true;
        } catch (error) {
            await context.showMessage(this.errorMessage('Pairing failed', error));
            return false;
        }
    }

    public async setToken(id: string, context: ActionContext): Promise<DeviceRefreshResponse<string>> {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        const data = await context.showForm(
            {
                type: 'panel',
                items: {
                    token: {
                        type: 'password',
                        label: t('Token'),
                        validator: '!!data.token && !!data.token.trim()',
                        validatorNoSaveOnError: true,
                        xs: 12,
                    },
                },
            },
            { title: t('Set token'), buttons: ['cancel', 'apply'] },
        );
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.service.setTizenToken(device, String(data.token).trim());
            await context.showMessage(t('Token saved'));
            return { refresh: 'devices' };
        } catch (error) {
            await context.showMessage(this.errorMessage('Set token failed', error));
            return { refresh: 'none' };
        }
    }

    public errorMessage(prefix: string, error: unknown): TranslatedText {
        const translated = t(prefix);
        const detail = error instanceof Error ? error.message : String(error);
        const translatedDetail = TRANSLATABLE_ERROR_KEYS.has(detail) ? t(detail) : null;
        return Object.fromEntries(
            LANGUAGES.map(language => [
                language,
                `${translated[language]}: ${translatedDetail ? translatedDetail[language] : detail}`,
            ]),
        ) as TranslatedText;
    }
}
