import type { ConfiguredDevice, TvApi, TvTransport } from '../../types';

export function sanitizeName(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
}

export function normalizeId(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/^urn:uuid:/i, '')
        .replace(/^uuid:/i, '')
        .trim();
}

export function normalizeMac(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const compact = value
        .trim()
        .toLowerCase()
        .replace(/[^0-9a-f]/g, '');
    if (compact.length !== 12) {
        return '';
    }
    return compact.match(/.{2}/g)?.join(':') ?? '';
}

export function normalizeDeviceId(value: unknown): string {
    const id = normalizeId(value);
    return normalizeMac(id) || id;
}

export function ensureUniqueName(desired: string, used: Set<string>, fallback = 'tv'): string {
    const base = desired || fallback;
    if (!used.has(base)) {
        return base;
    }
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) {
        suffix += 1;
    }
    return `${base}-${suffix}`;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function boolValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function apiValue(value: unknown): TvApi {
    return value === 'tizen' || value === 'hj' || value === 'legacy' ? value : 'unknown';
}

function transportValue(value: unknown): TvTransport {
    return value === 'ws' || value === 'wss' || value === 'tcp' ? value : '';
}

export function normalizeDevices(input: unknown): ConfiguredDevice[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const usedNames = new Set<string>();
    const usedIds = new Set<string>();
    const result: ConfiguredDevice[] = [];

    for (const entry of input) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const raw = entry as Record<string, unknown>;
        const mac = normalizeMac(raw.mac);
        let id = normalizeDeviceId(raw.id ?? raw.uuid ?? raw.usn);
        if (!id || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(id)) {
            id = mac || normalizeDeviceId(raw.ip);
        }
        if (!id || usedIds.has(id)) {
            continue;
        }

        const displayName = stringValue(raw.displayName || raw.name || raw.friendlyName || raw.model) || 'TV';
        const fallback = `tv-${id.slice(0, 6)}`;
        const name = ensureUniqueName(sanitizeName(raw.name || displayName) || fallback, usedNames, fallback);
        usedIds.add(id);
        usedNames.add(name);
        result.push({
            id,
            name,
            displayName,
            ip: stringValue(raw.ip),
            mac,
            model: stringValue(raw.model),
            api: apiValue(raw.api),
            protocol: transportValue(raw.protocol),
            port: typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : 0,
            uuid: stringValue(raw.uuid),
            source: stringValue(raw.source) || 'config',
            renderingControlUrl: stringValue(raw.renderingControlUrl) || undefined,
            renderingControlEventUrl: stringValue(raw.renderingControlEventUrl) || undefined,
            tokenAuthSupport: boolValue(raw.tokenAuthSupport),
            hjAvailable: boolValue(raw.hjAvailable),
        });
    }
    return result;
}
