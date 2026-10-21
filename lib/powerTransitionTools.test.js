'use strict';

const assert = require('node:assert/strict');
const { acceptPowerUpdate, startPowerTransition, runPowerCommand } = require('./powerTransitionTools');

// Fake clock and timer queue; each poll reads the next scripted power value and records
// what it would publish, the way pollDevice does. `power` and `control` mirror
// state.power and control.power; the TV starts off.
function createHarness(observations) {
    const harness = {
        time: 0,
        timers: [],
        polls: 0,
        published: [],
        device: {},
        power: false,
        control: { val: false, ack: true },
    };
    const publish = value => {
        harness.published.push(value);
        harness.power = value;
        harness.control = { val: value, ack: true };
    };
    harness.options = {
        interval: 2000,
        duration: 30000,
        now: () => harness.time,
        schedule: (fn, delay) => harness.timers.push({ fn, at: harness.time + delay }),
        poll: async () => {
            const observed = observations[Math.min(harness.polls, observations.length - 1)];
            harness.polls++;
            if (acceptPowerUpdate(harness.device, observed, harness.time)) {
                publish(observed);
            }
        },
    };
    // A user write to control.power (ack: false), handled by runPowerCommand.
    harness.command = (target, { waitForTv = false, fail = false, sent = Promise.resolve() } = {}) => {
        harness.control = { val: target, ack: false };
        return runPowerCommand(harness.device, target, {
            ...harness.options,
            setPower: async () => {
                await sent;
                if (fail) {
                    throw new Error('TV unreachable');
                }
            },
            publishPower: async () => publish(target),
            waitForTv,
        });
    };
    harness.runTimers = async () => {
        while (harness.timers.length) {
            harness.timers.sort((a, b) => a.at - b.at);
            const timer = harness.timers.shift();
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

describe('power command', () => {
    it('publishes the requested state straight away by default', async () => {
        const h = createHarness([false, true]);
        await h.command(true);
        assert.equal(h.power, true);
        assert.deepEqual(h.control, { val: true, ack: true });
        await h.runTimers();
        // The poll that still saw the TV off was held back.
        assert.deepEqual(h.published, [true, true]);
    });

    it('waits for the TV to confirm before publishing in confirmed mode', async () => {
        const h = createHarness([false, true]);
        await h.command(true, { waitForTv: true });
        assert.equal(h.power, false);
        assert.deepEqual(h.control, { val: true, ack: false });
        await h.runTimers();
        assert.equal(h.polls, 2);
        assert.deepEqual(h.published, [true]);
        assert.equal(h.power, true);
        assert.deepEqual(h.control, { val: true, ack: true });
    });

    it('reconciles both states with the measured state on timeout in confirmed mode', async () => {
        const h = createHarness([false]);
        await h.command(true, { waitForTv: true });
        await h.runTimers();
        assert.equal(h.time, 30000);
        assert.deepEqual(h.published, [false]);
        assert.equal(h.power, false);
        assert.deepEqual(h.control, { val: false, ack: true });
        assert.equal(h.device.powerTransition, undefined);
    });

    it('reconciles both states with the measured state when the command fails', async () => {
        const h = createHarness([false]);
        await h.command(true, { waitForTv: true });
        h.time = 1000;
        await assert.rejects(h.command(true, { waitForTv: true, fail: true }), /TV unreachable/);
        assert.deepEqual(h.published, [false]);
        assert.deepEqual(h.control, { val: false, ack: true });
        assert.equal(h.device.powerTransition, undefined);
        // The earlier command's burst sees its transition is gone and stops.
        await h.runTimers();
        assert.equal(h.polls, 1);
    });

    it('lets a newer command replace a pending one in confirmed mode', async () => {
        const h = createHarness([false]);
        await h.command(true, { waitForTv: true });
        h.time = 1000;
        await h.command(false, { waitForTv: true });
        assert.deepEqual(h.control, { val: false, ack: false });
        await h.runTimers();
        // Only the newer command's burst polls, and the TV never showed as on.
        assert.equal(h.polls, 1);
        assert.deepEqual(h.published, [false]);
        assert.deepEqual(h.control, { val: false, ack: true });
        assert.equal(h.device.powerTransition, undefined);
    });

    it('holds back polls while the command is still being sent in confirmed mode', async () => {
        const h = createHarness([true, false]);
        let markSent;
        const command = h.command(false, { waitForTv: true, sent: new Promise(resolve => (markSent = resolve)) });
        // A regular poll arrives before setPower has returned.
        h.power = true;
        await h.options.poll();
        assert.deepEqual(h.published, []);
        assert.deepEqual(h.control, { val: false, ack: false });
        markSent();
        await command;
        await h.runTimers();
        assert.deepEqual(h.published, [false]);
        assert.deepEqual(h.control, { val: false, ack: true });
    });

    it('caps the transition at 30 s from the command even when sending is slow', async () => {
        const h = createHarness([false]);
        let markSent;
        const command = h.command(true, { waitForTv: true, sent: new Promise(resolve => (markSent = resolve)) });
        // setPower takes 21 s, as it can on an H/J TV.
        h.time = 21000;
        markSent();
        await command;
        await h.runTimers();
        // Polls at 23, 25, 27 and 29 s, and a last one on the 30 s deadline.
        assert.equal(h.polls, 5);
        assert.equal(h.time, 30000);
        assert.deepEqual(h.published, [false]);
        assert.deepEqual(h.control, { val: false, ack: true });
        assert.equal(h.device.powerTransition, undefined);
    });

    it('ignores an earlier command that finishes after a newer one', async () => {
        const h = createHarness([false]);
        let markSent;
        const earlier = h.command(true, { sent: new Promise(resolve => (markSent = resolve)) });
        await h.command(false, { waitForTv: true });
        markSent();
        await earlier;
        // The earlier command neither publishes its state nor replaces the newer transition.
        assert.deepEqual(h.published, []);
        assert.equal(h.device.powerTransition.target, false);
        await h.runTimers();
        assert.deepEqual(h.published, [false]);
    });
});
