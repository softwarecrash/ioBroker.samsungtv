import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { shouldMigrateLegacySamsung } from './legacyMigrationTools';

describe('legacy Samsung migration', () => {
    it('runs only for the first samsungtv instance', () => {
        assert.equal(shouldMigrateLegacySamsung(0), true);
        assert.equal(shouldMigrateLegacySamsung('0'), true);
        assert.equal(shouldMigrateLegacySamsung(1), false);
        assert.equal(shouldMigrateLegacySamsung(undefined), false);
    });
});
