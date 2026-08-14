'use strict';

const assert = require('node:assert/strict');
const { boundedSeconds } = require('./timerTools');

describe('timer tools', () => {
    it('uses fallback and enforces lower and upper bounds', () => {
        assert.equal(boundedSeconds(undefined, 30, 10, 3600), 30);
        assert.equal(boundedSeconds(1, 30, 10, 3600), 10);
        assert.equal(boundedSeconds(999999, 30, 10, 3600), 3600);
        assert.equal(boundedSeconds('45', 30, 10, 3600), 45);
    });
});
