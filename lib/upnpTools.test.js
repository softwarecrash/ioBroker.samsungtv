'use strict';

const assert = require('node:assert/strict');
const {
    MASTER_CHANNEL_XML,
    buildSoapEnvelope,
    parseUpnpErrorCode,
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
});
