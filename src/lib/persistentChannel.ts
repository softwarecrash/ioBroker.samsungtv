/*
 * A websocket channel of a Tizen TV that stays open while the TV is on: keys go out without a new connection,
 * and the TV reports changes at once - a closed remote channel means off or power cut (~1 s in the prototype on
 * The Frame), the art channel sends art_mode_changed and image_selected.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** Wait for ms.channel.connect, in ms */
const CONNECT_TIMEOUT = 5000;

/** A message of a channel, JSON decoded; `data` of a d2d_service_message is decoded as well */
export interface ChannelMessage {
    event?: string;
    data?: unknown;
}

/**
 * Events: `message` (ChannelMessage), `close` ({ code, intentional }), `unauthorized` - the TV refused the token,
 * do not try again before pairing anew.
 */
export class PersistentChannel extends EventEmitter {
    private ws: WebSocket | null = null;
    private open = false;
    private closing = false;

    /**
     * @param url the channel URL with name and token, e.g. `wss://<ip>:8002/api/v2/channels/samsung.remote.control?…`
     * @param waitForReady wait for ms.channel.ready, not only ms.channel.connect: the art channel takes requests
     *   only then (as the prototype did; requests before it left the Art service of The Frame hanging)
     */
    constructor(
        private readonly url: string,
        private readonly waitForReady = false,
    ) {
        super();
    }

    get connected(): boolean {
        return this.open;
    }

    /** Connect; resolves once the TV accepted the channel (ms.channel.connect) */
    connect(): Promise<void> {
        if (this.ws) {
            return Promise.resolve();
        }
        this.closing = false;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url, {
                rejectUnauthorized: false,
                handshakeTimeout: CONNECT_TIMEOUT,
                perMessageDeflate: false,
            });
            this.ws = ws;
            let settled = false;
            const pending: { timer?: NodeJS.Timeout } = {};
            const fail = (error: Error): void => {
                if (!settled) {
                    settled = true;
                    clearTimeout(pending.timer);
                    reject(error);
                }
                ws.terminate();
            };
            pending.timer = setTimeout(
                () => fail(new Error(`Channel: no ${this.waitForReady ? 'ms.channel.ready' : 'ms.channel.connect'}`)),
                CONNECT_TIMEOUT,
            );
            ws.on('error', error => fail(error));
            ws.on('close', code => {
                clearTimeout(pending.timer);
                const wasOpen = this.open;
                this.open = false;
                this.ws = null;
                if (!settled) {
                    settled = true;
                    reject(new Error(`Channel closed before it was accepted (${code})`));
                } else if (wasOpen) {
                    this.emit('close', { code, intentional: this.closing });
                }
            });
            ws.on('message', raw => {
                const message = decode(raw);
                if (!message?.event) {
                    return;
                }
                if (message.event === 'ms.channel.unauthorized') {
                    this.emit('unauthorized');
                    return fail(new Error('Channel: unauthorized'));
                }
                if (message.event === 'ms.channel.timeOut') {
                    return fail(new Error('Channel: timeout'));
                }
                if (message.event === (this.waitForReady ? 'ms.channel.ready' : 'ms.channel.connect') && !settled) {
                    settled = true;
                    clearTimeout(pending.timer);
                    this.open = true;
                    resolve();
                    return;
                }
                this.emit('message', message);
            });
        });
    }

    /** Send one message; throws if the channel is not open */
    send(payload: Record<string, unknown>): void {
        if (!this.ws || !this.open) {
            throw new Error('Channel is not open');
        }
        this.ws.send(JSON.stringify(payload));
    }

    /** Close on purpose; `close` reports `intentional: true` */
    close(): void {
        this.closing = true;
        this.ws?.close();
    }
}

function decode(raw: WebSocket.RawData): ChannelMessage | null {
    try {
        const text = (Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)).toString(
            'utf8',
        );
        const message = JSON.parse(text) as ChannelMessage;
        if (message?.event === 'd2d_service_message' && typeof message.data === 'string') {
            try {
                message.data = JSON.parse(message.data);
            } catch {
                // keep the string
            }
        }
        return message;
    } catch {
        return null;
    }
}

/** Pause before the next connection attempt after `failures` failures in a row: 30 s, 60 s, … up to 10 min */
export function reconnectDelay(failures: number): number {
    return Math.min(600_000, 30_000 * 2 ** Math.max(0, failures - 1));
}
