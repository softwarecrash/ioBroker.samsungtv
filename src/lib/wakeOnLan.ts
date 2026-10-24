/*
 * Wake-on-LAN without the limits of a single broadcast address.
 *
 * The magic packet goes to the directed broadcast address of every IPv4 interface of the host (e.g.
 * 192.168.1.255) and to 255.255.255.255, three times. A host with several interfaces (docker, VPN)
 * sends 255.255.255.255 out of one of them only, often not the one the TV is on; this way switched
 * The Frame 2022 on reliably over WLAN within ~6 s. The TV needs "Power On with Mobile" (Settings >
 * General > Network > Expert Settings).
 */
import dgram from 'node:dgram';
import os from 'node:os';

const MAC_PATTERN =
    /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

/**
 * The magic packet: 6 times 0xFF and 16 times the MAC address, 102 bytes.
 *
 * @param mac MAC address with or without separators
 * @throws {TypeError} if the MAC address is malformed
 */
export function createMagicPacket(mac: string): Buffer {
    const match = MAC_PATTERN.exec(String(mac ?? '').trim());
    if (!match) {
        throw new TypeError(`Invalid MAC address "${mac}"`);
    }
    const bytes = Buffer.from(match.slice(1).join(''), 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) {
        bytes.copy(packet, 6 + i * 6);
    }
    return packet;
}

/** A network interface as `os.networkInterfaces()` reports it */
interface InterfaceAddress {
    family: string | number;
    address: string;
    netmask: string;
    internal: boolean;
}

/**
 * The directed broadcast addresses of all active IPv4 interfaces, and 255.255.255.255.
 *
 * @param interfaces the interfaces of the host, `os.networkInterfaces()` if not given
 */
export function broadcastAddresses(
    interfaces: Record<string, InterfaceAddress[] | undefined> = os.networkInterfaces(),
): string[] {
    const result = new Set<string>();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            const ipv4 = entry.family === 'IPv4' || entry.family === 4;
            if (!ipv4 || entry.internal || !entry.netmask || entry.address.startsWith('169.254.')) {
                continue;
            }
            const ip = entry.address.split('.').map(Number);
            const mask = entry.netmask.split('.').map(Number);
            result.add(ip.map((octet, i) => (octet & mask[i]!) | (~mask[i]! & 255)).join('.'));
        }
    }
    result.add('255.255.255.255');
    return [...result];
}

/**
 * Send the magic packet to all broadcast addresses, `repeat` times.
 *
 * @param mac MAC address of the TV
 * @param options what to send
 * @param options.port UDP port, 9 by default
 * @param options.repeat how often the packet is sent, 3 by default
 * @param options.interval pause between two repetitions in ms, 100 by default
 * @param options.addresses where to send it; all broadcast addresses of the host by default
 * @param options.ip address of the device: the packet goes there first. The Frame 2022 in deep standby over WLAN
 *   ignored broadcasts but woke up on a packet to its address
 * @returns the addresses the packet was sent to
 */
export async function wakeOnLan(
    mac: string,
    options: { port?: number; repeat?: number; interval?: number; addresses?: string[]; ip?: string } = {},
): Promise<string[]> {
    const { port = 9, repeat = 3, interval = 100 } = options;
    const packet = createMagicPacket(mac);
    const broadcasts = options.addresses?.length ? options.addresses : broadcastAddresses();
    const targets = options.ip ? [options.ip, ...broadcasts.filter(address => address !== options.ip)] : broadcasts;
    const socket = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(() => {
                socket.setBroadcast(true);
                resolve();
            });
        });
        for (let i = 0; i < repeat; i++) {
            // one unreachable address (e.g. a docker bridge that is down) must not stop the others
            await Promise.all(
                targets.map(
                    address => new Promise<void>(resolve => socket.send(packet, port, address, () => resolve())),
                ),
            );
            if (i < repeat - 1) {
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }
    } finally {
        socket.close();
    }
    return targets;
}
