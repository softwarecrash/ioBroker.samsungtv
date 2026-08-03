import type { AdapterNativeConfig } from '../../types';
import { normalizeDevices } from './normalization';

export const CURRENT_CONFIG_VERSION = 1;

const DEFAULT_CONFIG: AdapterNativeConfig = {
    schemaVersion: CURRENT_CONFIG_VERSION,
    devices: [],
    tokens: '',
    autoScan: true,
    autoScanInterval: 300,
    discoveryTimeout: 5,
    pollInterval: 30,
    enableSsdp: true,
    enableMdns: true,
    enableWol: true,
    mdnsServices: '_airplay._tcp,_samsung._tcp,_samsungtv._tcp,_samsungmsf._tcp,_samsungmsf2._tcp,_smartthings._tcp',
};

function numberSetting(value: unknown, fallback: number, minimum: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export interface MigrationResult {
    config: AdapterNativeConfig;
    changed: boolean;
    fromVersion: number;
}

export function migrateNativeConfig(input: unknown): MigrationResult {
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const fromVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
    const devices = normalizeDevices(raw.devices);
    const config: AdapterNativeConfig = {
        schemaVersion: CURRENT_CONFIG_VERSION,
        devices,
        tokens: typeof raw.tokens === 'string' ? raw.tokens : '',
        autoScan: booleanSetting(raw.autoScan, DEFAULT_CONFIG.autoScan),
        autoScanInterval: numberSetting(raw.autoScanInterval, DEFAULT_CONFIG.autoScanInterval, 30),
        discoveryTimeout: numberSetting(raw.discoveryTimeout, DEFAULT_CONFIG.discoveryTimeout, 2),
        pollInterval: numberSetting(raw.pollInterval, DEFAULT_CONFIG.pollInterval, 10),
        enableSsdp: booleanSetting(raw.enableSsdp, DEFAULT_CONFIG.enableSsdp),
        enableMdns: booleanSetting(raw.enableMdns, DEFAULT_CONFIG.enableMdns),
        enableWol: booleanSetting(raw.enableWol, DEFAULT_CONFIG.enableWol),
        mdnsServices:
            typeof raw.mdnsServices === 'string' && raw.mdnsServices.trim()
                ? raw.mdnsServices
                : DEFAULT_CONFIG.mdnsServices,
        migratedFromSamsung: raw.migratedFromSamsung === true || undefined,
    };

    const comparableInput = { ...raw, devices: normalizeDevices(raw.devices), schemaVersion: CURRENT_CONFIG_VERSION };
    return {
        config,
        changed: fromVersion !== CURRENT_CONFIG_VERSION || JSON.stringify(comparableInput) !== JSON.stringify(config),
        fromVersion,
    };
}
