import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** SSDP response headers, keyed by the upper-cased header name */
export type SsdpHeaders = Record<string, string>;

/** A parsed SSDP (HTTP over UDP) response */
export interface SsdpResponse {
    headers: SsdpHeaders;
    statusCode: number;
}

/** Events emitted by {@link SsdpClient} */
export interface SsdpClientEvents {
    response: [headers: SsdpHeaders, statusCode: number, rinfo: dgram.RemoteInfo];
}

export function parseSsdpMessage(message: Buffer): SsdpResponse | null {
    const lines = message.toString('utf8').split(/\r?\n/);
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(lines.shift() || '');
    if (!statusMatch) {
        return null;
    }

    const headers: SsdpHeaders = {};
    for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            continue;
        }
        const name = line.slice(0, separator).trim().toUpperCase();
        const value = line.slice(separator + 1).trim();
        if (name && value) {
            headers[name] = value;
        }
    }

    return { headers, statusCode: Number(statusMatch[1]) };
}

function getIpv4Addresses(): string[] {
    const addresses: string[] = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses.length ? [...new Set(addresses)] : ['0.0.0.0'];
}

export class SsdpClient extends EventEmitter<SsdpClientEvents> {
    private readonly sockets = new Set<dgram.Socket>();
    private stopped = false;

    public search(searchTarget = 'ssdp:all'): void {
        this.stop();
        this.stopped = false;

        const payload = Buffer.from(
            [
                'M-SEARCH * HTTP/1.1',
                `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
                'MAN: "ssdp:discover"',
                'MX: 2',
                `ST: ${searchTarget}`,
                '',
                '',
            ].join('\r\n'),
        );

        for (const address of getIpv4Addresses()) {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.sockets.add(socket);

            socket.on('message', (message, rinfo) => {
                const response = parseSsdpMessage(message);
                if (response) {
                    this.emit('response', response.headers, response.statusCode, rinfo);
                }
            });
            socket.on('error', () => {
                this.closeSocket(socket);
            });
            socket.bind(0, address, () => {
                if (this.stopped) {
                    this.closeSocket(socket);
                    return;
                }
                try {
                    if (address !== '0.0.0.0') {
                        socket.setMulticastInterface(address);
                    }
                    socket.setMulticastTTL(2);
                    socket.send(payload, SSDP_PORT, SSDP_ADDRESS, error => {
                        if (error) {
                            this.closeSocket(socket);
                        }
                    });
                } catch {
                    this.closeSocket(socket);
                }
            });
        }
    }

    public closeSocket(socket: dgram.Socket): void {
        this.sockets.delete(socket);
        try {
            socket.close();
        } catch {
            // Socket may already be closed after a network error.
        }
    }

    public stop(): void {
        this.stopped = true;
        for (const socket of [...this.sockets]) {
            this.closeSocket(socket);
        }
    }
}
