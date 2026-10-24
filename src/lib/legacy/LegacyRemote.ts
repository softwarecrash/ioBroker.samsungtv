import net from 'node:net';

const chr = String.fromCharCode;

function base64Encode(value: unknown): string {
    return Buffer.from(String(value)).toString('base64');
}

/** Identity of the controlling host as announced to the TV */
export interface LegacyRemoteHost {
    ip: string;
    mac: string;
    name: string;
}

/** Constructor options of {@link LegacyRemote}; everything except `ip` has a default */
export interface LegacyRemoteOptions {
    ip: string;
    appString?: string;
    tvAppString?: string;
    port?: number;
    timeout?: number;
    showDisconnectedLog?: boolean;
    host?: Partial<LegacyRemoteHost>;
}

/** Options after defaults have been applied */
export interface LegacyRemoteConfig extends Required<Omit<LegacyRemoteOptions, 'host'>> {
    host: LegacyRemoteHost;
}

/** Result callback of {@link LegacyRemote.send}: `false` on success, otherwise an error text */
export type LegacyRemoteCallback = (error: false | string) => void;

/**
 *
 */
export class LegacyRemote {
    public config: LegacyRemoteConfig;

    /**
     *
     */
    public constructor(config: LegacyRemoteOptions) {
        const merged = {
            appString: 'iphone..iapp.samsung',
            tvAppString: 'iphone.UN60D6000.iapp.samsung',
            port: 55000,
            timeout: 5000,
            showDisconnectedLog: false,
            host: {},
            ...config,
        };

        this.config = {
            ...merged,
            host: {
                ip: '127.0.0.1',
                mac: '00:00:00:00',
                name: 'ioBroker Samsung TV',
                ...merged.host,
            },
        };

        if (!this.config.ip) {
            throw new Error('TV IP address is required');
        }
    }

    /**
     *
     */
    public _socketChunkOne(): string {
        const ipEncoded = base64Encode(this.config.host.ip);
        const macEncoded = base64Encode(this.config.host.mac);

        const message =
            chr(0x64) +
            chr(0x00) +
            chr(ipEncoded.length) +
            chr(0x00) +
            ipEncoded +
            chr(macEncoded.length) +
            chr(0x00) +
            macEncoded +
            chr(base64Encode(this.config.host.name).length) +
            chr(0x00) +
            base64Encode(this.config.host.name);

        return (
            chr(0x00) +
            chr(this.config.appString.length) +
            chr(0x00) +
            this.config.appString +
            chr(message.length) +
            chr(0x00) +
            message
        );
    }

    /**
     *
     */
    public _socketChunkTwo(command: string): string {
        const message =
            chr(0x00) + chr(0x00) + chr(0x00) + chr(base64Encode(command).length) + chr(0x00) + base64Encode(command);

        return (
            chr(0x00) +
            chr(this.config.tvAppString.length) +
            chr(0x00) +
            this.config.tvAppString +
            chr(message.length) +
            chr(0x00) +
            message
        );
    }

    /**
     *
     */
    public send(command: string, done: LegacyRemoteCallback): void {
        if (!command) {
            throw new Error('Missing command');
        }

        const socket = net.connect(this.config.port, this.config.ip);
        socket.setTimeout(this.config.timeout);

        socket.on('connect', () => {
            socket.write(this._socketChunkOne());
            socket.write(this._socketChunkTwo(command));
            socket.end();
            socket.destroy();
            done(false);
        });

        if (this.config.showDisconnectedLog) {
            socket.on('close', () => {
                // optional log only
            });
        }

        socket.on('error', (error: NodeJS.ErrnoException) => {
            let errorMsg;
            if (error.code === 'EHOSTUNREACH' || error.code === 'ECONNREFUSED') {
                errorMsg = 'Legacy remote: Device is off or unreachable';
            } else {
                errorMsg = `Legacy remote: ${error.code || 'error'}`;
            }
            done(errorMsg);
        });

        socket.on('timeout', () => {
            done('Timeout');
        });
    }
}
