'use strict';

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const os = require('node:os');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

function parseSsdpMessage(message) {
    const lines = message.toString('utf8').split(/\r?\n/);
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(lines.shift() || '');
    if (!statusMatch) {
        return null;
    }

    const headers = {};
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

function getIpv4Addresses() {
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses.length ? [...new Set(addresses)] : ['0.0.0.0'];
}

class SsdpClient extends EventEmitter {
    constructor() {
        super();
        this.sockets = new Set();
        this.stopped = false;
    }

    search(searchTarget = 'ssdp:all') {
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

    closeSocket(socket) {
        this.sockets.delete(socket);
        try {
            socket.close();
        } catch {
            // Socket may already be closed after a network error.
        }
    }

    stop() {
        this.stopped = true;
        for (const socket of [...this.sockets]) {
            this.closeSocket(socket);
        }
    }
}

module.exports = { SsdpClient, parseSsdpMessage };
