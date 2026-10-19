'use strict';

const assert = require('node:assert/strict');
const { shouldMigrateLegacySamsung } = require('./legacyMigrationTools');

describe('legacy Samsung migration', () => {
    it('runs only for the first samsungtv instance', () => {
        assert.equal(shouldMigrateLegacySamsung(0), true);
        assert.equal(shouldMigrateLegacySamsung('0'), true);
        assert.equal(shouldMigrateLegacySamsung(1), false);
        assert.equal(shouldMigrateLegacySamsung(undefined), false);
    });
});
