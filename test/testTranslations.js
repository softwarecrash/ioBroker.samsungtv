'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Admin translations', () => {
    const directory = path.join(__dirname, '..', 'admin', 'src', 'i18n');
    const languages = ['de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
    const english = JSON.parse(fs.readFileSync(path.join(directory, 'en.json'), 'utf8'));
    const expectedKeys = Object.keys(english).sort();

    for (const language of languages) {
        it(`${language} contains the complete key set`, () => {
            const translation = JSON.parse(fs.readFileSync(path.join(directory, `${language}.json`), 'utf8'));
            assert.deepEqual(Object.keys(translation).sort(), expectedKeys);
            assert.equal(
                Object.values(translation).every(value => typeof value === 'string' && value.trim().length > 0),
                true,
            );
        });
    }
});
