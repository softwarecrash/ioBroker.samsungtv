import type { EventEmitter } from 'node:events';
import type { HjIdentity } from '../../../types';
import type { HjDeviceConfig, HjDeviceInfo } from '../SamsungTv';
import { SamsungTvEvents } from '../SamsungTvEvents';
import * as Encryption from './Encryption/';

/** JSON body of a pairing step response; the TV firmware versions differ in the spelling */
interface PairingStepResponse {
    auth_data?: unknown;
    authData?: unknown;
    auth_Data?: unknown;
}

/** Auth data of pairing step 1 */
interface HelloAuthData {
    GeneratorClientHello?: unknown;
    request_id?: unknown;
}

/** Auth data of pairing step 2 */
interface AckAuthData {
    ClientAckMsg?: unknown;
    session_id?: unknown;
}

const normalizeDeviceId = (value: string | undefined): string => {
    if (!value) {
        return '';
    }
    return String(value).replace(/^uuid:/i, '');
};

const buildPairingStepUri = (config: HjDeviceConfig, device: HjDeviceInfo, step: number): string => {
    const rawDevId = normalizeDeviceId(device.deviceId || device.id || '');
    const devId = encodeURIComponent(rawDevId);
    const appId = encodeURIComponent(config.appId || '');
    const path = `/ws/pairing?step=${step}&app_id=${appId}&device_id=${devId}`;
    return `http://${config.ip}:8080${path}`;
};

const _step0 = (config: HjDeviceConfig, device: HjDeviceInfo): Promise<void> => {
    console.info('Step 0: Start pairing');
    const uri = buildPairingStepUri(config, device, 0);
    return fetch(`${uri}&type=1`, {
        mode: 'no-cors',
    })
        .then(response => {
            console.debug('Step 0, responseStatus', response.status);
        })
        .catch(err => {
            console.error('Step 0, failed', err);
            throw Error('Failed to confirm step 0');
        });
};

const _verifyHelloAuthData = (authData: HelloAuthData): unknown => {
    console.debug('hello auth data', authData);
    if (Encryption.parseClientHello(authData.GeneratorClientHello as string) !== 0) {
        console.error('Invalid PIN Entered');
        throw Error('Invalid PIN entered');
    }

    console.debug('hello verified');
    return authData.request_id;
};

const _verifyAckAuthData = (authData: AckAuthData): AckAuthData => {
    console.debug('ack auth data', authData);

    const clientAck = Encryption.parseClientAcknowledge(authData.ClientAckMsg as string);
    console.debug('client ack', clientAck.toString());

    if (!clientAck) {
        throw Error('failed to acknowledge client');
    }

    return authData;
};

const _step1HelloServer = (config: HjDeviceConfig, device: HjDeviceInfo, pin: string): Promise<unknown> => {
    console.info('Step 1: Saying hello to the server');
    const serverHello = Encryption.generateServerHello(config.userId as string, pin);
    console.debug('Generated serverHello', serverHello);

    const uri = buildPairingStepUri(config, device, 1);
    return fetch(uri, {
        method: 'POST',
        body: JSON.stringify({
            auth_Data: {
                auth_type: 'SPC',
                GeneratorServerHello: serverHello,
            },
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    })
        .then(res => res.text().then(text => ({ status: res.status, text })))
        .then(({ status, text }) => {
            if (!text) {
                throw Error(`Empty response from TV (status ${status})`);
            }
            let json: PairingStepResponse;
            try {
                json = JSON.parse(text);
            } catch (e) {
                throw Error(`Invalid JSON response from TV (status ${status}): ${text.slice(0, 120)}`);
            }
            return json;
        })
        .then(res => {
            const authData = res.auth_data || res.authData || res.auth_Data || null;
            if (authData === null || typeof authData === 'undefined') {
                throw Error('Missing auth_data in response');
            }
            if (typeof authData === 'string') {
                if (!authData.trim()) {
                    throw Error('Empty auth_data in response (wrong PIN or device_id)');
                }
                return JSON.parse(authData) as HelloAuthData;
            }
            return authData;
        })
        .then(authData => _verifyHelloAuthData(authData));
};

const _step2AckServer = (config: HjDeviceConfig, device: HjDeviceInfo, requestId: unknown): Promise<HjIdentity> => {
    console.info('Step 2: Acknowledging');
    const serverAck = Encryption.generateServerAcknowledge();
    console.debug(`generatedServerAcknowledge: ${serverAck}`);

    const uri = buildPairingStepUri(config, device, 2);
    return fetch(uri, {
        method: 'POST',
        body: JSON.stringify({
            auth_Data: {
                auth_type: 'SPC',
                request_id: requestId,
                ServerAckMsg: serverAck,
            },
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    })
        .then(res => res.text().then(text => ({ status: res.status, text })))
        .then(({ status, text }) => {
            if (!text) {
                throw Error(`Empty response from TV (status ${status})`);
            }
            let json: PairingStepResponse;
            try {
                json = JSON.parse(text);
            } catch (e) {
                throw Error(`Invalid JSON response from TV (status ${status}): ${text.slice(0, 120)}`);
            }
            return json;
        })
        .then(res => {
            const authData = res.auth_data || res.authData || res.auth_Data || null;
            if (authData === null || typeof authData === 'undefined') {
                throw Error('Missing auth_data in response');
            }
            if (typeof authData === 'string') {
                if (!authData.trim()) {
                    throw Error('Empty auth_data in response (wrong PIN or device_id)');
                }
                return JSON.parse(authData) as AckAuthData;
            }
            return authData;
        })
        .then(authData => _verifyAckAuthData(authData))
        .then(authData => {
            const identity: HjIdentity = {
                // stored exactly as the TV sent it
                sessionId: authData.session_id as string,
                // set by the successful parseClientHello() in step 1
                aesKey: Encryption.getKey() as string,
            };

            console.debug('identity', identity);
            return identity;
        });
};

export class SamsungTvPairing {
    public device: HjDeviceInfo;
    public config: HjDeviceConfig;
    public eventEmitter: EventEmitter;
    public identity: HjIdentity | null;

    public constructor(deviceConfig: HjDeviceConfig, deviceInfo: HjDeviceInfo, eventEmitter: EventEmitter) {
        this.device = deviceInfo;
        this.config = deviceConfig;
        this.eventEmitter = eventEmitter;
        this.identity = null;
    }

    /**
     *
     */
    public requestPin(): Promise<void> {
        // `cache` is accepted by Node's fetch but missing from its RequestInit typings
        return fetch(`http://${this.config.ip}:8080/ws/apps/CloudPINPage`, {
            method: 'POST',
            mode: 'no-cors',
            cache: 'default',
        } as RequestInit)
            .then(res => res.text())
            .then(text => {
                const match = /<state[^>]*>([\s\S]*?)<\/state>/.exec(text);
                if (match && match[1]) {
                    return match[1].toUpperCase() !== 'STOPPED';
                }
                return true;
            })
            .then(() => _step0(this.config, this.device))
            .catch(err => {
                console.error('Failed to require PIN', err);
                throw Error('Failed to require PIN');
            });
    }

    /**
     *
     */
    public confirmPin(pin: string): Promise<HjIdentity> {
        console.log('Confirming pin', pin);
        return _step1HelloServer(this.config, this.device, pin)
            .then(requestId => _step2AckServer(this.config, this.device, requestId))
            .then(identity => {
                this.identity = identity;
                this.eventEmitter.emit(SamsungTvEvents.PAIRED, identity);
                return identity;
            });
    }

    public hidePinConfirmation(): Promise<Response> {
        return fetch(`http://${this.config.ip}:8080/ws/apps/CloudPINPage/run`, {
            method: 'DELETE',
        });
    }

    public isPaired(): boolean {
        return this.identity !== null;
    }
}
