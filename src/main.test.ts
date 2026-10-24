import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

describe('adapter entry point', () => {
    it('exports an adapter factory for compact mode', () => {
        // the compiled entry point next to this compiled test, build/main.js
        const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
        assert.match(source, /module\.exports = createAdapter/);
    });
});
