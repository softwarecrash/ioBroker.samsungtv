import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'mocha';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { type ChannelMessage, PersistentChannel, reconnectDelay } from './persistentChannel';

function startFakeTv(behaviour: { refuse: boolean }): Promise<{ server: WebSocketServer; received: string[] }> {
    const received: string[] = [];
    return new Promise(resolve => {
        const server = new WebSocketServer({ port: 0 });
        server.on('listening', () => resolve({ server, received }));
        server.on('connection', (socket: WebSocket) => {
            if (behaviour.refuse) {
                socket.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
                return;
            }
            socket.send(JSON.stringify({ event: 'ms.channel.connect', data: { clients: [] } }));
            socket.on('message', (raw: Buffer) => {
                received.push(raw.toString('utf8'));
                // an art event as the TV sends it: data is a JSON string
                socket.send(
                    JSON.stringify({
                        event: 'd2d_service_message',
                        data: JSON.stringify({ event: 'art_mode_changed', value: 'on' }),
                    }),
                );
            });
        });
    });
}

describe('persistent channel', () => {
    const behaviour = { refuse: false };
    let tv: { server: WebSocketServer; received: string[] };
    let url: string;

    before(async () => {
        tv = await startFakeTv(behaviour);
        url = `ws://127.0.0.1:${(tv.server.address() as AddressInfo).port}/api/v2/channels/samsung.remote.control`;
    });

    after(() => {
        tv.server.clients.forEach(client => client.terminate());
        tv.server.close();
    });

    it('connects, sends and decodes the events of the TV', async () => {
        const channel = new PersistentChannel(url);
        await channel.connect();
        assert.equal(channel.connected, true);
        const message = new Promise<ChannelMessage>(resolve => channel.once('message', resolve));
        channel.send({ method: 'ms.remote.control', params: { DataOfCmd: 'KEY_HOME' } });
        assert.deepEqual((await message).data, { event: 'art_mode_changed', value: 'on' });
        assert.match(tv.received.at(-1)!, /KEY_HOME/);
        const closed = new Promise<{ intentional: boolean }>(resolve => channel.once('close', resolve));
        channel.close();
        assert.equal((await closed).intentional, true);
        assert.equal(channel.connected, false);
    });

    it('waits for ms.channel.ready if asked to', async function () {
        this.timeout(8000);
        // the fake TV of this test never sends ready
        const channel = new PersistentChannel(url, true);
        await assert.rejects(channel.connect(), /no ms.channel/);
    });

    it('reports a close by the TV as not intentional', async () => {
        const channel = new PersistentChannel(url);
        await channel.connect();
        const closed = new Promise<{ intentional: boolean }>(resolve => channel.once('close', resolve));
        tv.server.clients.forEach(client => client.terminate());
        assert.equal((await closed).intentional, false);
    });

    it('reports a refused token', async () => {
        behaviour.refuse = true;
        try {
            const channel = new PersistentChannel(url);
            const unauthorized = new Promise<void>(resolve => channel.once('unauthorized', resolve));
            await assert.rejects(channel.connect(), /unauthorized/);
            await unauthorized;
        } finally {
            behaviour.refuse = false;
        }
    });

    it('waits longer after every failure, at most 10 minutes', () => {
        assert.deepEqual([1, 2, 3, 10].map(reconnectDelay), [30_000, 60_000, 120_000, 600_000]);
    });
});
