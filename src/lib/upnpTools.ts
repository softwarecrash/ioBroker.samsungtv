export const RENDERING_CONTROL_URN = 'urn:schemas-upnp-org:service:RenderingControl:1';

// Samsung TVs expose RenderingControl on a fixed endpoint. SSDP is answered by some
// models and completely ignored by others, so the well-known URL is needed as a fallback.
export const WELL_KNOWN_PORT = 9197;
export const WELL_KNOWN_CONTROL_PATH = '/upnp/control/RenderingControl1';
export const RENDERING_CONTROL_LOOKUP_TTL = 300000;
export const RENDERING_CONTROL_FALLBACK_RETRY = 15000;

export const MASTER_CHANNEL_XML = '      <InstanceID>0</InstanceID>\n      <Channel>Master</Channel>';

export function buildSoapEnvelope(action: string, innerXml: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${RENDERING_CONTROL_URN}">
${innerXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

/**
 * Reads the UPnP error code out of a SOAP fault body.
 * 401 means "invalid action" and is what Samsung TVs return for a client that is not on
 * the TV subnet; 402 means the argument was out of range.
 *
 * @param text SOAP response body
 * @returns the UPnP error code, or null when the body carries no fault
 */
export function parseUpnpErrorCode(text: unknown): number | null {
    if (typeof text !== 'string') {
        return null;
    }
    const match = text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i);
    if (!match) {
        return null;
    }
    const parsed = parseInt(match[1]!, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

export function wellKnownRenderingControlUrl(ip: unknown): string {
    if (!ip || typeof ip !== 'string') {
        return '';
    }
    return `http://${ip}:${WELL_KNOWN_PORT}${WELL_KNOWN_CONTROL_PATH}`;
}

export function renderingControlRetryTimestamp(now = Date.now()): number {
    return now - RENDERING_CONTROL_LOOKUP_TTL + RENDERING_CONTROL_FALLBACK_RETRY;
}

export function upnpErrorDescription(code: number | null): string {
    switch (code) {
        case 401:
            return 'Invalid Action';
        case 402:
            return 'Invalid Args';
        case 501:
            return 'Action Failed';
        default:
            return '';
    }
}

export function normalizeAbsoluteVolume(value: unknown): number | null {
    if (value === null || value === undefined || typeof value === 'boolean') {
        return null;
    }
    if (typeof value === 'string' && !value.trim()) {
        return null;
    }
    const target = Math.round(Number(value));
    return Number.isFinite(target) && target >= 0 && target <= 100 ? target : null;
}

export function normalizeAbsoluteMute(value: unknown): boolean | null {
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    if (value === false || value === 0 || value === 'false' || value === '0') {
        return false;
    }
    return null;
}
