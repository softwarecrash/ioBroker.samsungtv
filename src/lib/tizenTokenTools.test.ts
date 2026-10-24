import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { evaluateTizenTokenMessage } from './tizenTokenTools';

describe('Tizen token validation', () => {
    it('accepts a successful channel connection with the expected token', () => {
        assert.deepEqual(evaluateTizenTokenMessage({ event: 'ms.channel.connect', data: { token: '1234' } }, '1234'), {
            accepted: true,
        });
        assert.deepEqual(evaluateTizenTokenMessage({ event: 'ms.channel.ready' }, '1234'), { accepted: true });
    });

    it('rejects authorization failures and a different returned token', () => {
        assert.deepEqual(evaluateTizenTokenMessage({ event: 'ms.channel.unauthorized' }, '1234'), {
            accepted: false,
            error: 'Token rejected',
        });
        assert.deepEqual(evaluateTizenTokenMessage({ event: 'ms.channel.connect', data: { token: '5678' } }, '1234'), {
            accepted: false,
            error: 'Token changed',
        });
    });

    it('ignores unrelated messages without exposing the expected token', () => {
        assert.equal(evaluateTizenTokenMessage({ event: 'ed.unknown', data: { token: '1234' } }, '1234'), null);
        const result = evaluateTizenTokenMessage({ event: 'ms.error', data: { message: 'denied' } }, '1234');
        assert.equal(JSON.stringify(result).includes('1234'), false);
        assert.deepEqual(result, { accepted: false, error: 'Token rejected' });
    });
});
