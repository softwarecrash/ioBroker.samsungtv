'use strict';

// While a power command is in flight, polls keep reading the TV but only publish the
// requested value, or the measured one once the transition has timed out. Either ends it.
function acceptPowerUpdate(device, observed, now) {
    const transition = device.powerTransition;
    if (!transition) {
        return true;
    }
    if (observed === transition.target || now >= transition.until) {
        delete device.powerTransition;
        return true;
    }
    return false;
}

// Polls every `interval` ms until a poll ends the transition, `duration` ms have passed
// (or the deadline `until`, if given), or a newer power command replaces it. The last
// poll lands on the deadline.
function startPowerTransition(device, target, { poll, schedule, now, interval, duration, until }) {
    const transition = { target, until: until ?? now() + duration };
    device.powerTransition = transition;
    const next = () => Math.max(0, Math.min(interval, transition.until - now()));
    const tick = async () => {
        if (device.powerTransition !== transition) {
            return;
        }
        await poll();
        if (device.powerTransition === transition && now() < transition.until) {
            schedule(tick, next());
        }
    };
    schedule(tick, next());
}

// Sends a power command and starts the transition. Polls are held back from the moment
// the command arrives, because sending it can take a while, and the deadline counts from
// then too. By default the requested state is published once it has been sent; with
// `waitForTv` it is left to the poll that confirms it. If the command fails, one poll
// publishes the measured state. A newer command that arrives in the meantime takes over.
async function runPowerCommand(device, target, { setPower, publishPower, waitForTv, ...transitionOptions }) {
    const pending = { target, until: transitionOptions.now() + transitionOptions.duration };
    device.powerTransition = pending;
    try {
        await setPower();
    } catch (e) {
        if (device.powerTransition === pending) {
            delete device.powerTransition;
            await transitionOptions.poll();
        }
        throw e;
    }
    if (device.powerTransition !== pending) {
        return;
    }
    startPowerTransition(device, target, { ...transitionOptions, until: pending.until });
    if (!waitForTv) {
        await publishPower();
    }
}

module.exports = { acceptPowerUpdate, startPowerTransition, runPowerCommand };
