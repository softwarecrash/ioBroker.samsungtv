'use strict';

const assert = require('node:assert/strict');
const { getPingArguments, normalizeMac, parseArpTable, parseMacFromArpOutput } = require('./networkTools');

describe('network tools', () => {
    it('uses platform-specific ping arguments', () => {
        assert.deepEqual(getPingArguments('linux', '192.0.2.10', 1200), ['-c', '1', '-W', '2', '192.0.2.10']);
        assert.deepEqual(getPingArguments('darwin', '192.0.2.10', 1200), ['-c', '1', '-W', '1200', '192.0.2.10']);
        assert.deepEqual(getPingArguments('win32', '192.0.2.10', 1200), ['-n', '1', '-w', '1200', '192.0.2.10']);
    });

    it('normalizes common MAC address formats', () => {
        assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
        assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff');
        assert.equal(normalizeMac('invalid'), '');
    });

    it('parses Linux, macOS and Windows ARP output', () => {
        const output = [
            '192.0.2.10 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE',
            '? (192.0.2.11) at aa:bb:cc:dd:ee:02 on en0 ifscope [ethernet]',
            '  192.0.2.12          aa-bb-cc-dd-ee-03     dynamic',
        ].join('\n');
        const table = parseArpTable(output);
        assert.equal(table.get('aa:bb:cc:dd:ee:01'), '192.0.2.10');
        assert.equal(table.get('aa:bb:cc:dd:ee:02'), '192.0.2.11');
        assert.equal(table.get('aa:bb:cc:dd:ee:03'), '192.0.2.12');
        assert.equal(parseMacFromArpOutput(output, '192.0.2.12'), 'aa:bb:cc:dd:ee:03');
    });
});
