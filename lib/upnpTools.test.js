'use strict';

const assert = require('node:assert/strict');
const {
    MASTER_CHANNEL_XML,
    RENDERING_CONTROL_FALLBACK_RETRY,
    RENDERING_CONTROL_LOOKUP_TTL,
    buildSoapEnvelope,
    normalizeAbsoluteMute,
    normalizeAbsoluteVolume,
    parseUpnpErrorCode,
    renderingControlRetryTimestamp,
    upnpErrorDescription,
    wellKnownRenderingControlUrl,
} = require('./upnpTools');

describe('upnp tools', () => {
    it('builds a RenderingControl SOAP envelope', () => {
        const envelope = buildSoapEnvelope(
            'SetVolume',
            `${MASTER_CHANNEL_XML}\n      <DesiredVolume>7</DesiredVolume>`,
        );
        assert.match(envelope, /<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">/);
        assert.match(envelope, /<InstanceID>0<\/InstanceID>/);
        assert.match(envelope, /<Channel>Master<\/Channel>/);
        assert.match(envelope, /<DesiredVolume>7<\/DesiredVolume>/);
        assert.match(envelope, /<\/u:SetVolume>/);
    });

    it('reads the error code out of a SOAP fault', () => {
        const fault = `<?xml version="1.0"?><s:Envelope><s:Body><s:Fault><detail><UPnPError>
            <errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription>
            </UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
        assert.equal(parseUpnpErrorCode(fault), 401);
        assert.equal(parseUpnpErrorCode('<errorCode>402</errorCode>'), 402);
    });

    it('returns null when the response carries no fault', () => {
        assert.equal(parseUpnpErrorCode('<CurrentVolume>12</CurrentVolume>'), null);
        assert.equal(parseUpnpErrorCode(undefined), null);
    });

    it('builds the well-known control URL', () => {
        assert.equal(
            wellKnownRenderingControlUrl('192.0.2.10'),
            'http://192.0.2.10:9197/upnp/control/RenderingControl1',
        );
        assert.equal(wellKnownRenderingControlUrl(''), '');
    });

    it('uses the standard descriptions for common UPnP faults', () => {
        assert.equal(upnpErrorDescription(401), 'Invalid Action');
        assert.equal(upnpErrorDescription(402), 'Invalid Args');
        assert.equal(upnpErrorDescription(501), 'Action Failed');
        assert.equal(upnpErrorDescription(600), '');
    });

    it('retries a failed fallback before the regular lookup cache expires', () => {
        const now = 1_000_000;
        const timestamp = renderingControlRetryTimestamp(now);
        assert.equal(now - timestamp, RENDERING_CONTROL_LOOKUP_TTL - RENDERING_CONTROL_FALLBACK_RETRY);
        assert.ok(now + RENDERING_CONTROL_FALLBACK_RETRY - timestamp >= RENDERING_CONTROL_LOOKUP_TTL);
    });

    it('normalizes absolute volume without turning empty values into zero', () => {
        assert.equal(normalizeAbsoluteVolume(12.6), 13);
        assert.equal(normalizeAbsoluteVolume('42'), 42);
        assert.equal(normalizeAbsoluteVolume(0), 0);
        assert.equal(normalizeAbsoluteVolume(''), null);
        assert.equal(normalizeAbsoluteVolume(null), null);
        assert.equal(normalizeAbsoluteVolume(true), null);
        assert.equal(normalizeAbsoluteVolume(101), null);
    });

    it('normalizes absolute mute values without treating the string false as true', () => {
        assert.equal(normalizeAbsoluteMute(true), true);
        assert.equal(normalizeAbsoluteMute('1'), true);
        assert.equal(normalizeAbsoluteMute(false), false);
        assert.equal(normalizeAbsoluteMute('false'), false);
        assert.equal(normalizeAbsoluteMute(''), null);
    });

    it('builds a SetMute SOAP envelope', () => {
        const envelope = buildSoapEnvelope('SetMute', `${MASTER_CHANNEL_XML}\n      <DesiredMute>1</DesiredMute>`);
        assert.match(envelope, /<u:SetMute /);
        assert.match(envelope, /<DesiredMute>1<\/DesiredMute>/);
    });
});
