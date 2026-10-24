import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { parseSourceMenu, sourceMenuKeys } from './sourceMenu';
import { statesOf, TV_INPUTS } from './tvValues';

describe('source menu', () => {
    it('parses the configured order', () => {
        assert.deepEqual(parseSourceMenu(' TV, hdmi 2;USB\n\nWorkspace '), ['TV', 'HDMI2', 'USB', 'WORKSPACE']);
        assert.deepEqual(parseSourceMenu(['TV', 'HDMI2']), ['TV', 'HDMI2']);
        assert.deepEqual(parseSourceMenu(undefined), []);
    });

    it('moves into the side bar, then (index + 2)x right and confirms', () => {
        const menu = ['TV', 'HDMI2', 'USB', 'WORKSPACE'];
        // confirmed on The Frame 2022: TV = 2x right, HDMI2 = 3x right
        assert.deepEqual(sourceMenuKeys(menu, 'TV'), [
            ...Array(8).fill('KEY_LEFT'),
            'KEY_RIGHT',
            'KEY_RIGHT',
            'KEY_ENTER',
        ]);
        const hdmi2 = sourceMenuKeys(menu, 'hdmi 2')!;
        assert.equal(hdmi2.filter(key => key === 'KEY_RIGHT').length, 3);
        assert.equal(sourceMenuKeys(menu, 'HDMI1'), null);
    });

    it('offers only the inputs of TV_INPUTS as states, in menu order', () => {
        assert.deepEqual(statesOf(TV_INPUTS, ['HDMI2', 'TV', 'WORKSPACE']), { HDMI2: 'HDMI 2', TV: 'TV' });
    });
});
