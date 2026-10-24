import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'mocha';
import { broadcastAddresses, createMagicPacket, wakeOnLan } from './wakeOnLan';

describe('Wake-on-LAN', () => {
    it('builds the magic packet', () => {
        const packet = createMagicPacket('1c:86:9a:69:a2:fa');
        assert.equal(packet.length, 102);
        assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff');
        assert.equal(packet.subarray(6, 12).toString('hex'), '1c869a69a2fa');
        assert.equal(packet.subarray(96).toString('hex'), '1c869a69a2fa');
        assert.deepEqual(createMagicPacket('1C-86-9A-69-A2-FA'), packet);
        assert.throws(() => createMagicPacket('1c:86:9a'), /Invalid MAC address/);
    });

    it('sends to the broadcast address of every interface, not only to 255.255.255.255', () => {
        assert.deepEqual(
            broadcastAddresses({
                lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
                eth0: [
                    { family: 'IPv4', address: '192.168.1.129', netmask: '255.255.255.0', internal: false },
                    { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
                ],
                docker0: [{ family: 4, address: '172.17.0.1', netmask: '255.255.0.0', internal: false }],
                apipa: [{ family: 'IPv4', address: '169.254.3.4', netmask: '255.255.0.0', internal: false }],
            }),
            ['192.168.1.255', '172.17.255.255', '255.255.255.255'],
        );
    });

    it('sends the packet the given number of times', async () => {
        const receiver = dgram.createSocket('udp4');
        const received: Buffer[] = [];
        receiver.on('message', message => received.push(message));
        await new Promise<void>(resolve => receiver.bind(0, '127.0.0.1', () => resolve()));
        try {
            const { port } = receiver.address();
            const targets = await wakeOnLan('1c:86:9a:69:a2:fa', {
                port,
                repeat: 2,
                interval: 10,
                addresses: ['127.0.0.1'],
            });
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.deepEqual(targets, ['127.0.0.1']);
            assert.equal(received.length, 2);
            // the address of the device comes first, the broadcasts follow
            const both = await wakeOnLan('1c:86:9a:69:a2:fa', {
                port,
                repeat: 1,
                addresses: ['127.255.255.255'],
                ip: '127.0.0.1',
            });
            assert.deepEqual(both, ['127.0.0.1', '127.255.255.255']);
            assert.deepEqual(received[0], createMagicPacket('1c:86:9a:69:a2:fa'));
        } finally {
            receiver.close();
        }
    });
});
