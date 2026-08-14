'use strict';

function normalizeMac(mac) {
    if (typeof mac !== 'string') {
        return '';
    }
    const compact = mac
        .trim()
        .toLowerCase()
        .replace(/[^0-9a-f]/g, '');
    if (compact.length !== 12) {
        return '';
    }
    return compact.match(/.{2}/g).join(':');
}

function getPingArguments(platform, ip, timeoutMs) {
    const timeout = Math.max(250, Math.min(60000, Number(timeoutMs) || 1000));
    if (platform === 'win32') {
        return ['-n', '1', '-w', String(timeout), ip];
    }
    if (platform === 'darwin') {
        return ['-c', '1', '-W', String(timeout), ip];
    }
    return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeout / 1000))), ip];
}

function parseMacFromArpOutput(output, ip) {
    if (typeof output !== 'string') {
        return '';
    }
    const lines = output.split(/\r?\n/);
    const matchingLine = lines.find(line => !ip || line.includes(ip));
    const candidates = matchingLine ? [matchingLine, ...lines] : lines;
    for (const line of candidates) {
        const match = line.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        if (match) {
            return normalizeMac(match[0]);
        }
    }
    return '';
}

function parseArpTable(output) {
    const result = new Map();
    if (typeof output !== 'string') {
        return result;
    }
    for (const line of output.split(/\r?\n/)) {
        const ipMatch = line.match(/(?:\(|^|\s)(\d{1,3}(?:\.\d{1,3}){3})(?:\)|\s)/);
        const macMatch = line.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        if (!ipMatch || !macMatch) {
            continue;
        }
        const mac = normalizeMac(macMatch[0]);
        if (mac) {
            result.set(mac, ipMatch[1]);
        }
    }
    return result;
}

module.exports = {
    getPingArguments,
    normalizeMac,
    parseArpTable,
    parseMacFromArpOutput,
};
