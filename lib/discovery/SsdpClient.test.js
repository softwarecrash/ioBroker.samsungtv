'use strict';

const assert = require('node:assert/strict');
const { parseSsdpMessage } = require('./SsdpClient');

describe('SSDP response parser', () => {
    it('parses status and case-insensitive headers', () => {
        const response = parseSsdpMessage(
            Buffer.from(
                'HTTP/1.1 200 OK\r\n' +
                    'LOCATION: http://10.2.40.18:8001/api/v2/\r\n' +
                    'Server: Samsung-Linux/4.1 UPnP/1.0\r\n' +
                    'ST: urn:samsung.com:device:RemoteControlReceiver:1\r\n\r\n',
            ),
        );

        assert.equal(response.statusCode, 200);
        assert.equal(response.headers.LOCATION, 'http://10.2.40.18:8001/api/v2/');
        assert.equal(response.headers.SERVER, 'Samsung-Linux/4.1 UPnP/1.0');
        assert.equal(response.headers.ST, 'urn:samsung.com:device:RemoteControlReceiver:1');
    });

    it('rejects non-response packets', () => {
        assert.equal(parseSsdpMessage(Buffer.from('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\n\r\n')), null);
    });

    it('keeps colons inside header values', () => {
        const response = parseSsdpMessage(Buffer.from('HTTP/1.1 200 OK\r\nUSN: uuid:abc::upnp:rootdevice\r\n\r\n'));
        assert.equal(response.headers.USN, 'uuid:abc::upnp:rootdevice');
    });
});
