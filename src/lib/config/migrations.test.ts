import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'mocha';
import { migrateNativeConfig } from './migrations';
import { normalizeMac } from './normalization';
import { SecretStore } from './SecretStore';

describe('configuration migration', () => {
    it('migrates the 0.0.25 fixture without changing stable identities', () => {
        const fixture = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../../../test/fixtures/native-config-v0.0.25.json'), 'utf8'),
        );
        const result = migrateNativeConfig(fixture);
        const devices = result.config.devices as Array<Record<string, unknown>>;

        assert.equal(result.fromVersion, 0);
        assert.equal(result.config.schemaVersion, 1);
        assert.equal(devices.length, 2);
        assert.equal(devices[0]?.id, '11111111-2222-3333-4444-555555555555');
        assert.equal(devices[0]?.name, 'samsung-living-room');
        assert.equal(devices[0]?.mac, 'aa:bb:cc:dd:ee:01');
        assert.equal(devices[1]?.api, 'hj');
    });

    it('normalizes common MAC address formats', () => {
        assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
        assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff');
        assert.equal(normalizeMac('invalid'), '');
    });

    it('bounds timer settings to safe ranges', () => {
        const result = migrateNativeConfig({
            autoScanInterval: Number.MAX_SAFE_INTEGER,
            discoveryTimeout: 999999,
            pollInterval: 999999,
        });
        assert.equal(result.config.autoScanInterval, 86400);
        assert.equal(result.config.discoveryTimeout, 60);
        assert.equal(result.config.pollInterval, 3600);
    });
});

describe('secret store', () => {
    it('never exposes mutable secret internals and preserves old payloads', () => {
        const store = new SecretStore('{"tizen":{"tv-1":"123"},"hj":{"tv-2":{"sessionId":"7"}}}');
        assert.equal(store.getTizenToken('tv-1'), '123');
        assert.equal(store.hasHjIdentity('tv-2'), true);
        assert.deepEqual(JSON.parse(store.serialize()), {
            version: 1,
            tizen: { 'tv-1': '123' },
            hj: { 'tv-2': { sessionId: '7' } },
        });
    });
});
