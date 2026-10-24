import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import {
    acceptPowerUpdate,
    startPowerTransition,
    type PowerTransitionHolder,
    type PowerTransitionOptions,
} from './powerTransitionTools';

interface Harness {
    time: number;
    timers: { fn: () => Promise<void>; at: number }[];
    polls: number;
    published: boolean[];
    device: PowerTransitionHolder;
    options: PowerTransitionOptions;
    runTimers: () => Promise<void>;
}

// Fake clock and timer queue; each poll reads the next scripted power value and records
// what it would publish, the way pollDevice does.
function createHarness(observations: boolean[]): Harness {
    const harness = { time: 0, timers: [], polls: 0, published: [], device: {} } as unknown as Harness;
    harness.options = {
        interval: 2000,
        duration: 30000,
        now: () => harness.time,
        schedule: (fn, delay) => harness.timers.push({ fn, at: harness.time + delay }),
        // eslint-disable-next-line @typescript-eslint/require-await -- mirrors the async pollDevice
        poll: async () => {
            const observed = observations[Math.min(harness.polls, observations.length - 1)]!;
            harness.polls++;
            if (acceptPowerUpdate(harness.device, observed, harness.time)) {
                harness.published.push(observed);
            }
        },
    };
    harness.runTimers = async () => {
        while (harness.timers.length) {
            harness.timers.sort((a, b) => a.at - b.at);
            const timer = harness.timers.shift()!;
            harness.time = timer.at;
            await timer.fn();
        }
    };
    return harness;
}

describe('power transition', () => {
    it('publishes every value when no transition is active', () => {
        assert.equal(acceptPowerUpdate({}, true, 0), true);
        assert.equal(acceptPowerUpdate({}, false, 0), true);
    });

    it('stops polling once the requested state is reached', async () => {
        const h = createHarness([false, false, true]);
        startPowerTransition(h.device, true, h.options);
        await h.runTimers();
        assert.equal(h.polls, 3);
        assert.deepEqual(h.published, [true]);
        assert.equal(h.device.powerTransition, undefined);
    });

    it('suppresses the opposite intermediate value for power off', async () => {
        const h = createHarness([true, true, false]);
        startPowerTransition(h.device, false, h.options);
        await h.runTimers();
        assert.deepEqual(h.published, [false]);
    });

    it('publishes the measured state once on timeout and stops', async () => {
        const h = createHarness([false]);
        startPowerTransition(h.device, true, h.options);
        await h.runTimers();
        assert.equal(h.polls, 15);
        assert.equal(h.time, 30000);
        assert.deepEqual(h.published, [false]);
        assert.equal(h.device.powerTransition, undefined);
    });

    it('suppresses overlapping regular polls during the transition', async () => {
        const h = createHarness([false, true]);
        startPowerTransition(h.device, true, h.options);
        h.time = 500;
        assert.equal(acceptPowerUpdate(h.device, false, h.time), false);
        await h.runTimers();
        assert.deepEqual(h.published, [true]);
    });

    it('lets a newer power command replace the active transition', async () => {
        const h = createHarness([true, true, false]);
        startPowerTransition(h.device, true, h.options);
        h.time = 1000;
        startPowerTransition(h.device, false, h.options);
        await h.runTimers();
        // The first transition's tick at 2 s sees it was replaced and polls nothing.
        assert.equal(h.polls, 3);
        assert.deepEqual(h.published, [false]);
        assert.equal(h.device.powerTransition, undefined);
    });
});
