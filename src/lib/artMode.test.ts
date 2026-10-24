import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'mocha';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { getArtMode, getCurrentArtwork, setArtMode } from './artMode';
import { PersistentChannel } from './persistentChannel';

/**
 * A fake art channel that answers like The Frame 2022: the answer is named like the request and carries
 * its request_id; a switch is reported with art_mode_changed after a moment.
 */
function startFakeTv(state: { artMode: boolean; sendReady: boolean }): Promise<WebSocketServer> {
    return new Promise(resolve => {
        const server = new WebSocketServer({ port: 0 });
        server.on('listening', () => resolve(server));
        server.on('connection', (socket: WebSocket) => {
            const emit = (data: Record<string, unknown>): void =>
                socket.send(JSON.stringify({ event: 'd2d_service_message', data: JSON.stringify(data) }));
            socket.send(JSON.stringify({ event: 'ms.channel.connect', data: {} }));
            if (state.sendReady) {
                socket.send(JSON.stringify({ event: 'ms.channel.ready', data: {} }));
            }
            socket.on('message', (raw: Buffer) => {
                const message = JSON.parse(raw.toString('utf8')) as { params: { data: string } };
                const request = JSON.parse(message.params.data) as {
                    request: string;
                    request_id: string;
                    value?: string;
                };
                if (request.request === 'get_current_artwork') {
                    emit({
                        event: 'get_current_artwork',
                        request_id: request.request_id,
                        content_id: 'MY_F0003',
                        matte_id: 'shadowbox_polar',
                    });
                } else if (request.request === 'get_artmode_status') {
                    emit({
                        event: 'get_artmode_status',
                        request_id: request.request_id,
                        value: state.artMode ? 'on' : 'off',
                    });
                } else if (request.request === 'set_artmode_status') {
                    // the old value right after the request, as the TV does
                    emit({
                        event: 'set_artmode_status',
                        request_id: request.request_id,
                        value: state.artMode ? 'on' : 'off',
                    });
                    setTimeout(() => {
                        state.artMode = request.value === 'on';
                        emit({ event: 'art_mode_changed', value: request.value });
                    }, 50);
                }
            });
        });
    });
}

describe('Art Mode', () => {
    const state = { artMode: false, sendReady: true };
    let server: WebSocketServer;
    let url: string;

    before(async () => {
        server = await startFakeTv(state);
        url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/channels/com.samsung.art-app`;
    });

    after(() => {
        server.clients.forEach((client: WebSocket) => client.terminate());
        server.close();
    });

    it('reads the status', async () => {
        state.artMode = true;
        assert.equal(await getArtMode(url), true);
        state.artMode = false;
        assert.equal(await getArtMode(url), false);
    });

    it('waits for art_mode_changed, not for the answer with the old value', async () => {
        state.artMode = false;
        assert.equal(await setArtMode(url, true), true);
        assert.equal(state.artMode, true);
    });

    it('reads the current artwork', async () => {
        assert.deepEqual(await getCurrentArtwork(url), { contentId: 'MY_F0003', matteId: 'shadowbox_polar' });
    });

    it('asks over an open channel; the TV answers only there while one is open', async () => {
        const channel = new PersistentChannel(url);
        await channel.connect();
        try {
            state.artMode = false;
            assert.equal(await setArtMode(channel, true), true);
            assert.equal(await getArtMode(channel), true);
            assert.deepEqual(await getCurrentArtwork(channel), { contentId: 'MY_F0003', matteId: 'shadowbox_polar' });
        } finally {
            channel.close();
        }
    });

    it('sends the request after ms.channel.connect if the TV sends no ms.channel.ready', async () => {
        state.sendReady = false;
        state.artMode = true;
        try {
            assert.equal(await getArtMode(url), true);
        } finally {
            state.sendReady = true;
        }
    });
});
