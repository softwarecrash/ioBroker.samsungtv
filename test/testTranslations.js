'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSON5 = require('json5');

describe('Admin translations', () => {
    const directory = path.join(__dirname, '..', 'admin', 'i18n');
    const translationFile = language => path.join(directory, `${language}.json`);
    const languages = ['de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
    const english = JSON.parse(fs.readFileSync(translationFile('en'), 'utf8'));
    const expectedKeys = Object.keys(english).sort();

    for (const language of languages) {
        it(`${language} contains the complete key set`, () => {
            const translation = JSON.parse(fs.readFileSync(translationFile(language), 'utf8'));
            assert.deepEqual(Object.keys(translation).sort(), expectedKeys);
            assert.equal(
                Object.values(translation).every(value => typeof value === 'string' && value.trim().length > 0),
                true,
            );
        });
    }

    it('contains every text used by JSONConfig', () => {
        const configPath = path.join(__dirname, '..', 'admin', 'jsonConfig.json5');
        const config = JSON5.parse(fs.readFileSync(configPath, 'utf8'));
        const translatedProperties = new Set(['label', 'text', 'title', 'help', 'tooltip', 'unit']);
        const keys = new Set();

        const visit = value => {
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (!value || typeof value !== 'object') {
                return;
            }
            for (const [property, child] of Object.entries(value)) {
                if (translatedProperties.has(property) && typeof child === 'string') {
                    keys.add(child);
                }
                visit(child);
            }
        };
        visit(config);

        assert.deepEqual([...keys].filter(key => !Object.hasOwn(english, key)).sort(), []);
    });
});
