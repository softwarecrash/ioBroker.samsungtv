import { EventEmitter } from 'node:events';
import type { HjIdentity } from '../../types';
import { SamsungTvConnection } from './Connection/SamsungTvConnection';
import { SamsungTvPairing } from './Pairing/SamsungTvPairing';
import { SamsungTvEvents } from './SamsungTvEvents';

/** Static configuration of an H/J TV and of the pairing client */
export interface HjDeviceConfig {
    ip: string;
    appId?: string;
    userId?: string;
}

/** Device information as reported by the TV on port 8001 */
export interface HjDeviceInfo {
    id: string | undefined;
    deviceId: string | undefined;
    name: string | undefined;
}

/** The fields read from the TV's `/ms/1.0/` JSON response; the values are passed through untouched */
interface HjDeviceDescription {
    DeviceID?: string;
    DeviceName?: string;
}

export class SamsungTv {
    public config: HjDeviceConfig;
    public device: HjDeviceInfo | null;
    public pairing: SamsungTvPairing | null;
    public identity: HjIdentity | null;
    public connection: SamsungTvConnection | null;
    public eventEmitter: EventEmitter;

    /**
     *
     */
    public constructor(deviceConfig: HjDeviceConfig) {
        this.config = deviceConfig;
        this.device = null;
        this.pairing = null;
        this.identity = null;
        this.connection = null;
        this.eventEmitter = new EventEmitter();
    }

    // As I was new to the concept of promises, i have rewritten the init function to a more traditionell way, to help me understand the code better
    // however both functions do the same
    public async init2(): Promise<string> {
        const resp = await fetch(`http://${this.config.ip}:8001/ms/1.0/`);
        const json = (await resp.json()) as HjDeviceDescription;
        const deviceInfo = {
            id: json.DeviceID,
            deviceId: json.DeviceID,
            name: json.DeviceName,
        };
        this.device = deviceInfo;
        this.pairing = new SamsungTvPairing(this.config, this.device, this.eventEmitter);
        return 'init2 all is done';
    }

    /**
     *
     */
    public init(): Promise<HjDeviceInfo> {
        console.info('Initializing device configuration');
        return this.fetchDeviceInfo().then(device => {
            console.info('Initialization successful', device);
            this.device = device;
            this.pairing = new SamsungTvPairing(this.config, this.device, this.eventEmitter);
            return device;
        });
    }

    public fetchDeviceInfo(): Promise<HjDeviceInfo> {
        console.debug('Fetching device info');
        return fetch(`http://${this.config.ip}:8001/ms/1.0/`)
            .then(resp => {
                return resp.json() as Promise<HjDeviceDescription>;
            })
            .then(device => {
                console.debug('Received device info');
                const deviceInfo = {
                    id: device.DeviceID,
                    deviceId: device.DeviceID,
                    name: device.DeviceName,
                };
                console.debug('Device info: ', deviceInfo);
                return deviceInfo;
            });
    }

    /**
     *
     */
    public requestPin(): Promise<void> {
        return this.pairing!.requestPin().then(() => {
            console.debug('PIN showing at TV');
        });
    }

    public confirmPin(pin: string): Promise<HjIdentity> {
        return this.pairing!.confirmPin(pin).then(identity => {
            console.info('PIN confirmation succeeded. Identity: ', identity);

            this.identity = identity;
            return this.pairing!.hidePinConfirmation().then(() => {
                return identity;
            });
        });
    }

    public connect(): Promise<SamsungTvConnection | null> {
        this._assertPaired();

        // `identity` is set by confirmPin() or by the caller before connecting
        this.connection = new SamsungTvConnection(this.config, this.identity!, this.eventEmitter);
        return this.connection.connect().then(() => {
            return this.connection;
        });
    }

    public sendKey(keyCode: string): void {
        this._assertPaired();
        this._assertConnected();

        this.connection!.sendKey(keyCode);
    }

    /**
     *
     */
    public onConnected(listener: () => void): void {
        this.eventEmitter.on(SamsungTvEvents.CONNECTED, listener);
    }

    public _assertPaired(): void {
        if (!this.pairing!.isPaired()) {
            console.error('Pairing is required before connecting to the device.');
            throw Error('Pairing required');
        }
    }

    public _assertConnected(): void {
        if (this.connection === null) {
            console.error('Connection not established');
            throw Error('Connection not established');
        }

        if (!this.connection.isReady()) {
            console.error('Connection is established but not yet ready');
            throw Error('Connection not yet ready');
        }
    }
}
