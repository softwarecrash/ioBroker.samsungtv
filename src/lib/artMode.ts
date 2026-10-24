/*
 * Art Mode of The Frame over the websocket channel `com.samsung.art-app`.
 *
 * Samsung does not document this API; the protocol follows samsungtvws (art.py, async_art.py):
 *
 *   -> { method: 'ms.channel.emit', params: { event: 'art_app_request', to: 'host',
 *        data: JSON.stringify({ request, id, request_id, ...params }) } }
 *   <- { event: 'd2d_service_message', data: JSON.stringify({ event, request_id, value | status, ... }) }
 *
 * Checked on The Frame GQ55LS03BAUXZG (FW 1720.7, Art API 4.3.4.0): the answers are named like the request
 * (`get_artmode_status`, `set_artmode_status`) and carry the `request_id`. While switching, `get_artmode_status`
 * still reports the old value for a moment; the switch itself is reported with `art_mode_changed`, so setting
 * waits for that event. A few seconds after Wake-on-LAN the TV does not answer yet.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const ART_CHANNEL = 'com.samsung.art-app';

/** Wait for the answer to a status request, in ms */
const REQUEST_TIMEOUT = 5000;
/** Wait for `art_mode_changed` after switching, in ms */
const SWITCH_TIMEOUT = 10000;
/** Send the request this long after `ms.channel.connect` if the TV sends no `ms.channel.ready`, in ms */
const READY_FALLBACK = 1000;

/** The decoded `data` of a `d2d_service_message` */
interface ArtEvent {
    event?: string;
    request_id?: string;
    id?: string;
    value?: unknown;
    status?: unknown;
    error_code?: unknown;
    content_id?: unknown;
    matte_id?: unknown;
}

/** The artwork The Frame shows */
export interface Artwork {
    /** e.g. `MY_F0003` (own picture) or `SAM-S…` (Art Store) */
    contentId: string;
    /** Passe-partout, e.g. `shadowbox_polar`, `none` */
    matteId: string;
}

function parseArtEvent(raw: WebSocket.RawData): ArtEvent | null {
    let message: { event?: string; data?: unknown };
    try {
        message = JSON.parse(
            (Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)).toString('utf8'),
        ) as typeof message;
    } catch {
        return null;
    }
    if (message?.event === 'ms.channel.connect' || message?.event === 'ms.channel.ready') {
        return { event: message.event };
    }
    if (message?.event === 'ms.channel.unauthorized' || message?.event === 'ms.channel.timeOut') {
        return { event: message.event };
    }
    if (message?.event !== 'd2d_service_message') {
        return null;
    }
    if (typeof message.data === 'string') {
        try {
            return JSON.parse(message.data) as ArtEvent;
        } catch {
            return null;
        }
    }
    return (message.data as ArtEvent) ?? null;
}

/** `on`/`off` of an art event, `null` if it has none */
function artValue(data: ArtEvent): boolean | null {
    const value = data.value ?? data.status;
    return typeof value === 'string' ? value.toLowerCase() === 'on' : null;
}

/**
 * Build the URL of the art channel.
 *
 * @param ip address of the TV
 * @param token token of the pairing, empty if the TV needs none
 */
export function artChannelUrl(ip: string, token: string): string {
    const name = Buffer.from('ioBroker').toString('base64');
    let url = `wss://${ip}:8002/api/v2/channels/${ART_CHANNEL}?name=${name}`;
    if (token) {
        url += `&token=${encodeURIComponent(token)}`;
    }
    return url;
}

/**
 * An art channel that is already open (see `PersistentChannel`). While one is open, The Frame answers art requests
 * only there, not on a second connection.
 */
export interface OpenArtChannel {
    send(payload: Record<string, unknown>): void;
    on(event: 'message', listener: (message: { event?: string; data?: unknown }) => void): unknown;
    off(event: 'message', listener: (message: { event?: string; data?: unknown }) => void): unknown;
}

/** Where art requests go: the URL for a connection of their own, or an open channel */
export type ArtTarget = string | OpenArtChannel;

function artPayload(request: string, params: Record<string, unknown>, requestId: string): Record<string, unknown> {
    return {
        method: 'ms.channel.emit',
        params: {
            event: 'art_app_request',
            to: 'host',
            data: JSON.stringify({ request, ...params, id: requestId, request_id: requestId }),
        },
    };
}

/** Like `artRequest`, over an open channel */
function artRequestOnChannel<T>(
    channel: OpenArtChannel,
    request: string,
    params: Record<string, unknown>,
    done: (data: ArtEvent, requestId: string) => T | undefined,
    timeout: number,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const listener = (message: { event?: string; data?: unknown }): void => {
            if (message.event !== 'd2d_service_message' || !message.data || typeof message.data !== 'object') {
                return;
            }
            const data = message.data as ArtEvent;
            if (data.event === 'error' && (data.request_id ?? data.id) === requestId) {
                finish(new Error(`Art Mode: ${request} failed`));
                return;
            }
            const result = done(data, requestId);
            if (result !== undefined) {
                finish(null, result);
            }
        };
        const timer = setTimeout(() => finish(new Error(`Art Mode: no answer to ${request}`)), timeout);
        function finish(error: Error | null, result?: T): void {
            clearTimeout(timer);
            channel.off('message', listener);
            if (error) {
                reject(error);
            } else {
                resolve(result as T);
            }
        }
        channel.on('message', listener);
        try {
            channel.send(artPayload(request, params, requestId));
        } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/** Send an art request to `target`: over the open channel, or over a connection of its own */
function artRequestTo<T>(
    target: ArtTarget,
    request: string,
    params: Record<string, unknown>,
    done: (data: ArtEvent, requestId: string) => T | undefined,
    timeout: number,
): Promise<T> {
    return typeof target === 'string'
        ? artRequest(target, request, params, done, timeout)
        : artRequestOnChannel(target, request, params, done, timeout);
}

/**
 * Send one art request and wait until `done` accepts an event.
 *
 * @param url URL of the art channel, see `artChannelUrl`
 * @param request name of the request, e.g. `get_artmode_status`
 * @param params further fields of the request
 * @param done called with every art event and the request ID; returns the result once it is there
 * @param timeout how long to wait, in ms
 */
function artRequest<T>(
    url: string,
    request: string,
    params: Record<string, unknown>,
    done: (data: ArtEvent, requestId: string) => T | undefined,
    timeout: number,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const ws = new WebSocket(url, {
            rejectUnauthorized: false,
            handshakeTimeout: timeout,
            perMessageDeflate: false,
        });
        let finished = false;
        let sent = false;
        const timers: { answer?: NodeJS.Timeout; ready?: NodeJS.Timeout } = {};
        const finish = (error: Error | null, result?: T): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timers.answer);
            clearTimeout(timers.ready);
            ws.terminate();
            if (error) {
                reject(error);
            } else {
                resolve(result as T);
            }
        };
        timers.answer = setTimeout(() => finish(new Error(`Art Mode: no answer to ${request}`)), timeout);
        const send = (): void => {
            if (sent) {
                return;
            }
            sent = true;
            ws.send(JSON.stringify(artPayload(request, params, requestId)));
        };

        ws.on('error', error => finish(error));
        ws.on('close', () => finish(new Error(`Art Mode: connection closed before the answer to ${request}`)));
        ws.on('message', raw => {
            const data = parseArtEvent(raw);
            if (!data?.event) {
                return;
            }
            if (data.event === 'ms.channel.unauthorized' || data.event === 'ms.channel.timeOut') {
                return finish(new Error(`Art Mode: ${data.event}`));
            }
            if (data.event === 'ms.channel.ready') {
                return send();
            }
            if (data.event === 'ms.channel.connect') {
                timers.ready = setTimeout(send, READY_FALLBACK);
                return;
            }
            if (data.event === 'error' && (data.request_id ?? data.id) === requestId) {
                return finish(
                    new Error(
                        `Art Mode: ${request} failed (${typeof data.error_code === 'string' || typeof data.error_code === 'number' ? data.error_code : 'unknown'})`,
                    ),
                );
            }
            const result = done(data, requestId);
            if (result !== undefined) {
                finish(null, result);
            }
        });
    });
}

/**
 * Read whether the Art Mode is on.
 *
 * @param target URL of the art channel (see `artChannelUrl`) or the open channel
 */
export function getArtMode(target: ArtTarget): Promise<boolean> {
    return artRequestTo(
        target,
        'get_artmode_status',
        {},
        (data, requestId) => ((data.request_id ?? data.id) === requestId ? (artValue(data) ?? undefined) : undefined),
        REQUEST_TIMEOUT,
    );
}

/**
 * Read the artwork The Frame shows (or would show in Art Mode).
 *
 * @param target URL of the art channel (see `artChannelUrl`) or the open channel
 */
export function getCurrentArtwork(target: ArtTarget): Promise<Artwork> {
    return artRequestTo(
        target,
        'get_current_artwork',
        {},
        (data, requestId) =>
            (data.request_id ?? data.id) === requestId && typeof data.content_id === 'string'
                ? { contentId: data.content_id, matteId: typeof data.matte_id === 'string' ? data.matte_id : '' }
                : undefined,
        REQUEST_TIMEOUT,
    );
}

/**
 * Switch the Art Mode and wait until the TV reports the switch with `art_mode_changed`.
 *
 * @param target URL of the art channel (see `artChannelUrl`) or the open channel
 * @param on `true` to switch it on
 */
export function setArtMode(target: ArtTarget, on: boolean): Promise<boolean> {
    return artRequestTo(
        target,
        'set_artmode_status',
        { value: on ? 'on' : 'off' },
        data => (data.event === 'art_mode_changed' && artValue(data) === on ? on : undefined),
        SWITCH_TIMEOUT,
    );
}
