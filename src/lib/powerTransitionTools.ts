/** A power command in flight: the requested state and when to give up waiting for it */
export interface PowerTransition {
    target: boolean;
    until: number;
}

/** Anything that can carry a power transition, normally the runtime device record */
export interface PowerTransitionHolder {
    powerTransition?: PowerTransition;
}

/** Injected clock, timer and poll used by {@link startPowerTransition} */
export interface PowerTransitionOptions {
    poll: () => Promise<unknown>;
    schedule: (fn: () => Promise<void>, delay: number) => unknown;
    now: () => number;
    interval: number;
    duration: number;
}

// While a power command is in flight, polls keep reading the TV but only publish the
// requested value, or the measured one once the transition has timed out. Either ends it.
export function acceptPowerUpdate(device: PowerTransitionHolder, observed: unknown, now: number): boolean {
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

// Polls every `interval` ms until a poll ends the transition, `duration` ms have passed,
// or a newer power command replaces it.
export function startPowerTransition(
    device: PowerTransitionHolder,
    target: boolean,
    { poll, schedule, now, interval, duration }: PowerTransitionOptions,
): void {
    const transition: PowerTransition = { target, until: now() + duration };
    device.powerTransition = transition;
    const tick = async (): Promise<void> => {
        if (device.powerTransition !== transition) {
            return;
        }
        await poll();
        if (device.powerTransition === transition && now() < transition.until) {
            schedule(tick, interval);
        }
    };
    schedule(tick, interval);
}
