import type { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { HjIdentity } from '../../../types';
import * as Encryption from '../Pairing/Encryption/';
import type { HjDeviceConfig } from '../SamsungTv';
import { SamsungTvEvents } from '../SamsungTvEvents';
import { Messages } from './Messages';

/** A raw socket.io frame received from the TV, together with the context needed to answer it */
interface SocketMessage {
    socket: WebSocket;
    identity: HjIdentity;
    data: Buffer;
}

/** What a message handler returns when the frame should be re-emitted on the event emitter */
interface EmittedEvent {
    event: string;
    value: unknown;
}

const buildEmitMessage = (name: string, payload: unknown): string => {
    console.debug(`buildEmitMessage: ${name}, payload: ${JSON.stringify(payload)}`);
    return `5::/com.samsung.companion:${JSON.stringify({
        name: name,
        args: [payload],
    })}`;
};

const messages = new Messages<SocketMessage>();

messages.on('1::', message => {
    const { socket, identity } = message;
    console.debug('SOCKET MESSAGE:  1::/com.samsung.companion');

    socket.send('1::/com.samsung.companion');

    socket.send(
        buildEmitMessage(
            'registerPush',
            Encryption.encryptData(identity.aesKey, identity.sessionId, {
                eventType: 'EMP',
                plugin: 'SecondTV',
            }),
        ),
    );

    socket.send(
        buildEmitMessage(
            'registerPush',
            Encryption.encryptData(identity.aesKey, identity.sessionId, {
                eventType: 'EMP',
                plugin: 'RemoteControl',
            }),
        ),
    );

    socket.send(
        buildEmitMessage(
            'callCommon',
            Encryption.encryptData(identity.aesKey, identity.sessionId, {
                method: 'POST',
                body: {
                    plugin: 'NNavi',
                    api: 'GetDUID',
                    version: '1.000',
                },
            }),
        ),
    );
});

// keep-alive
messages.on('2::', message => {
    const { socket, data } = message;
    console.debug(`keep-alive: ${String(data)}`);

    socket.send('2::');
});

messages.on(
    data => data.toString().startsWith('5::/com.samsung.companion:'),
    (message): EmittedEvent | undefined => {
        const { identity, data } = message;
        console.debug('SOCKET MESSAGE:  5::/com.samsung.companion:');

        // JSON.parse converts the sliced buffer to a string, String() makes that explicit
        const event = JSON.parse(String(data.slice('5::/com.samsung.companion:'.length))) as {
            name?: unknown;
            args?: unknown;
        };
        console.debug(`Handle Event: ${String(event.name)}`);
        if (event.name !== 'receiveCommon') {
            return;
        }

        try {
            console.debug(`receiveCommon: ${String(event.args)}`);
            const decrypted = JSON.parse(Encryption.decryptData(identity.aesKey, event.args as string)) as {
                plugin?: unknown;
                api?: unknown;
                result?: unknown;
            };
            console.debug('decrypted: ', decrypted);
            if (decrypted.plugin === 'NNavi' && decrypted.api === 'GetDUID') {
                console.info(`GetDUID: ${String(decrypted.result)}: ${decrypted.api}`);

                return {
                    event: SamsungTvEvents.DUID,
                    value: decrypted.result,
                };
            }
        } catch (error) {
            console.error('handleEvent : unable to decrypt data', error);
            // todo: probably pairing failed, request pairing here
            throw Error('Unable to handleEvent');
        }
    },
);

const handshake = (config: HjDeviceConfig): Promise<string | undefined> => {
    return fetch(`http://${config.ip}:8000/socket.io/1`)
        .then(res => res.text())
        .then(body => {
            const handshake = body.split(':');
            console.debug(`Handshake: ${handshake[0]}`);
            return handshake[0];
        });
};

const onMessageEmitter = (socket: WebSocket, identity: HjIdentity, data: Buffer, eventEmitter: EventEmitter): void => {
    const message = {
        socket,
        identity,
        data,
    };

    const shouldEmitEvent = (resolved: unknown): resolved is EmittedEvent => {
        return typeof resolved === 'object' && Object.prototype.hasOwnProperty.call(resolved, 'event');
    };

    messages
        .handle(message)
        .then(resolved => {
            if (shouldEmitEvent(resolved)) {
                eventEmitter.emit(resolved.event, resolved.value);
            }
        })
        .catch((err: Error) => {
            console.error('Error while handling message', err.message);
        });
};

const openSocket = (
    config: HjDeviceConfig,
    identity: HjIdentity,
    eventEmitter: EventEmitter,
): Promise<WebSocket | undefined> => {
    return fetch(`http://${config.ip}:8000/common/1.0.0/service/startService?appID=com.samsung.companion`)
        .then(() => handshake(config))
        .then(mask => {
            console.info('Opening new websocket');
            const socket = new WebSocket(`ws://${config.ip}:8000/socket.io/1/websocket/${mask}`);

            if (!socket) {
                console.error('unable to connect to device.');
                throw Error('unable');
            }

            socket.on('open', () => {
                eventEmitter.emit(SamsungTvEvents.CONNECTING);
            });

            socket.on('message', data => {
                // with the default binaryType 'nodebuffer', ws always delivers a Buffer
                onMessageEmitter(socket, identity, data as Buffer, eventEmitter);
            });

            socket.on('close', () => {
                eventEmitter.emit(SamsungTvEvents.DISCONNECTED);
            });

            socket.on('error', err => {
                console.error('An error has occurred with the socket connection', err.message);
            });

            return socket;
        })
        .catch((err: Error) => {
            console.error('Error while creating socket', err.message);
            return undefined;
        });
};

/**
 *
 */
export class SamsungTvConnection {
    public config: HjDeviceConfig;
    public identity: HjIdentity;
    public eventEmitter: EventEmitter;
    /** `undefined` when opening the socket failed, `null` before connecting and after a disconnect */
    public socket: WebSocket | null | undefined;
    public duid: unknown;
    public ready: boolean;

    /**
     *
     */
    public constructor(deviceConfig: HjDeviceConfig, identity: HjIdentity, eventEmitter: EventEmitter) {
        this.config = deviceConfig;
        this.identity = identity;
        this.eventEmitter = eventEmitter;
        this.socket = null;
        this.duid = null;
        this.ready = false;

        this._initializeEvents();
    }

    public _initializeEvents(): void {
        this.eventEmitter.on(SamsungTvEvents.DUID, (duid: unknown) => {
            this.duid = duid;

            if (this.isReady() && !this.ready) {
                this.ready = true;
                this.eventEmitter.emit(SamsungTvEvents.CONNECTED);
            }
        });

        this.eventEmitter.on(SamsungTvEvents.DISCONNECTED, () => {
            this.ready = false;
            this.socket = null;
        });
    }

    /**
     *
     */
    public connect(): Promise<void> {
        return openSocket(this.config, this.identity, this.eventEmitter).then(socket => {
            console.info('Connection established');
            this.socket = socket;
            return new Promise<void>(resolve => {
                this.eventEmitter.once(SamsungTvEvents.CONNECTED, () => {
                    resolve();
                });
            });
        });
    }

    /**
     *
     */
    public sendKey(keyCode: string, keyType?: string): void {
        if (!this.isReady()) {
            throw Error('Connection not established');
        }

        const type = keyType || 'Click';

        // isReady() guarantees an open socket here
        this.socket!.send(
            buildEmitMessage(
                'callCommon',
                Encryption.encryptData(this.identity.aesKey, this.identity.sessionId, {
                    method: 'POST',
                    body: {
                        plugin: 'RemoteControl',
                        version: '1.000',
                        api: 'SendRemoteKey',
                        param1: this.duid,
                        param2: type,
                        param3: keyCode,
                        param4: 'false',
                    },
                }),
            ),
        );
    }

    public isReady(): boolean {
        return this.socket != null && this.duid != null;
    }
}
