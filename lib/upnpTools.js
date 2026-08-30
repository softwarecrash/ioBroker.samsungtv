'use strict';

const RENDERING_CONTROL_URN = 'urn:schemas-upnp-org:service:RenderingControl:1';

// Samsung TVs expose RenderingControl on a fixed endpoint. SSDP is answered by some
// models and completely ignored by others, so the well-known URL is needed as a fallback.
const WELL_KNOWN_PORT = 9197;
const WELL_KNOWN_CONTROL_PATH = '/upnp/control/RenderingControl1';
const RENDERING_CONTROL_LOOKUP_TTL = 300000;
const RENDERING_CONTROL_FALLBACK_RETRY = 15000;

const MASTER_CHANNEL_XML = '      <InstanceID>0</InstanceID>\n      <Channel>Master</Channel>';

function buildSoapEnvelope(action, innerXml) {
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
 * @param {string} text SOAP response body
 * @returns {number|null} the UPnP error code, or null when the body carries no fault
 */
function parseUpnpErrorCode(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const match = text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i);
    if (!match) {
        return null;
    }
    const parsed = parseInt(match[1], 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function wellKnownRenderingControlUrl(ip) {
    if (!ip || typeof ip !== 'string') {
        return '';
    }
    return `http://${ip}:${WELL_KNOWN_PORT}${WELL_KNOWN_CONTROL_PATH}`;
}

function renderingControlRetryTimestamp(now = Date.now()) {
    return now - RENDERING_CONTROL_LOOKUP_TTL + RENDERING_CONTROL_FALLBACK_RETRY;
}

function upnpErrorDescription(code) {
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

function normalizeAbsoluteVolume(value) {
    if (value === null || value === undefined || typeof value === 'boolean') {
        return null;
    }
    if (typeof value === 'string' && !value.trim()) {
        return null;
    }
    const target = Math.round(Number(value));
    return Number.isFinite(target) && target >= 0 && target <= 100 ? target : null;
}

function normalizeAbsoluteMute(value) {
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    if (value === false || value === 0 || value === 'false' || value === '0') {
        return false;
    }
    return null;
}

module.exports = {
    MASTER_CHANNEL_XML,
    RENDERING_CONTROL_FALLBACK_RETRY,
    RENDERING_CONTROL_LOOKUP_TTL,
    RENDERING_CONTROL_URN,
    WELL_KNOWN_CONTROL_PATH,
    WELL_KNOWN_PORT,
    buildSoapEnvelope,
    normalizeAbsoluteMute,
    normalizeAbsoluteVolume,
    parseUpnpErrorCode,
    renderingControlRetryTimestamp,
    upnpErrorDescription,
    wellKnownRenderingControlUrl,
};
