const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

describe('adapter entry point', () => {
    it('exports an adapter factory for compact mode', () => {
        const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
        assert.match(source, /module\.exports = createAdapter/);
    });
});
