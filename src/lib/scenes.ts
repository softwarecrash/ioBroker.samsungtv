/*
 * Scenes: a named sequence of keys, apps, inputs and pauses the user configures in the settings, e.g.
 * `HOME, YOUTUBE, WAIT 3000, OK` - open YouTube and confirm the account selection.
 *
 * A step is
 * - a key: a key of `TV_KEYS` (`HOME`, `SELECT`, `BACK`, `NUMBER_1`, ...), a short alias (`OK`, `ENTER`,
 *   `VOLUP`, `0`...`9`) or a Samsung key code (`KEY_HOME`)
 * - an app: a key of `TV_APPS` (`YOUTUBE`, `NETFLIX`, ...)
 * - an input: a key of `TV_INPUTS` (`HDMI2`, `TV`, ...)
 * - a pause: `WAIT 2000` (milliseconds)
 * - `ON`: switch the TV on and wait until it is on; only this step works while the TV is off, so a scene
 *   that starts with it can be started from standby
 * - `CLOSE YOUTUBE`: close an app
 * - `HOLD POWER 3000`: hold a key for the given ms (1000 if omitted)
 * - `YOUTUBE:<video, playlist, channel or URL>`: play it in the YouTube app, see `parseYouTubeTarget`
 * separated by commas, semicolons or new lines; case and spaces do not matter.
 */
import { TV_APPS, TV_INPUTS, TV_KEY_CODES } from './tvValues';
import { parseYouTubeTarget } from '@iobroker/youtube-lounge';

/** Short names a user is likely to type, in addition to the keys of `TV_KEYS` */
const KEY_ALIASES: Readonly<Record<string, string>> = {
    OK: 'KEY_ENTER',
    ENTER: 'KEY_ENTER',
    RETURN: 'KEY_RETURN',
    SOURCE: 'KEY_SOURCE',
    POWER: 'KEY_POWER',
    MUTE: 'KEY_MUTE',
    VOLUP: 'KEY_VOLUP',
    VOLUME_UP: 'KEY_VOLUP',
    VOLDOWN: 'KEY_VOLDOWN',
    VOLUME_DOWN: 'KEY_VOLDOWN',
    CHUP: 'KEY_CHUP',
    CHDOWN: 'KEY_CHDOWN',
    FF: 'KEY_FF',
    TOOLS: 'KEY_TOOLS',
};

/** Longest pause a step may ask for, in ms */
const MAX_WAIT = 60_000;

export type SceneStep =
    | { type: 'on' }
    | { type: 'key'; key: string }
    | { type: 'hold'; key: string; ms: number }
    | { type: 'close'; app: string }
    | { type: 'youtube'; target: string }
    | { type: 'app'; app: string }
    | { type: 'input'; input: string }
    | { type: 'wait'; ms: number };

/** One row of the scene table of the settings */
export interface SceneConfig {
    /** Name of the scene, also its state ID `<tv>.scenes.<name>` */
    name: string;
    /** Name of the TV (its object ID) the scene belongs to; empty for all TVs */
    device?: string;
    steps: string;
    /** Pause between two steps in ms */
    delay?: number | string;
}

/** The Samsung key code of a key name, alias, digit or code; `null` if it is none */
function keyCodeOf(name: string): string | null {
    if (/^KEY_[A-Z0-9_]+$/.test(name)) {
        return name;
    }
    if (/^\d$/.test(name)) {
        return `KEY_${name}`;
    }
    return TV_KEY_CODES[name] ?? KEY_ALIASES[name] ?? null;
}

/**
 * Turn the steps of a scene into a list of actions.
 *
 * @param steps the text of the scene, e.g. `HOME, YOUTUBE, WAIT 3000, OK`
 * @throws {Error} naming the first step that is not understood
 */
export function parseScene(steps: string): SceneStep[] {
    const result: SceneStep[] = [];
    for (const raw of String(steps ?? '').split(/[,\n;]/)) {
        // the IDs of YouTube are case sensitive
        const youtube = /^youtube\s*:\s*(.+)$/i.exec(raw.trim())?.[1];
        if (youtube) {
            parseYouTubeTarget(youtube);
            result.push({ type: 'youtube', target: youtube });
            continue;
        }
        const token = raw.trim().toUpperCase().replace(/\s+/g, ' ');
        if (!token) {
            continue;
        }
        const wait = /^(?:WAIT|PAUSE|SLEEP) ?(\d+)$/.exec(token);
        if (wait) {
            result.push({ type: 'wait', ms: Math.min(Number(wait[1]), MAX_WAIT) });
            continue;
        }
        const hold = /^HOLD (\S+?)(?: (\d+))?$/.exec(token);
        const holdKey = hold ? keyCodeOf(hold[1]!) : null;
        if (holdKey) {
            result.push({ type: 'hold', key: holdKey, ms: Math.min(Number(hold![2] ?? 1000), MAX_WAIT) });
            continue;
        }
        const close = /^CLOSE (.+)$/.exec(token)?.[1]?.replace(/ /g, '_');
        if (close && TV_APPS[close]) {
            result.push({ type: 'close', app: close });
            continue;
        }
        const name = token.replace(/ /g, '_');
        const key = keyCodeOf(name);
        if (name === 'ON' || name === 'POWER_ON') {
            result.push({ type: 'on' });
        } else if (key) {
            result.push({ type: 'key', key });
        } else if (TV_APPS[name]) {
            result.push({ type: 'app', app: name });
        } else if (TV_INPUTS[name]) {
            result.push({ type: 'input', input: name });
        } else {
            throw new Error(`Unknown step "${raw.trim()}"`);
        }
    }
    return result;
}

/** State ID of a scene below `<tv>.scenes`, with only the characters ioBroker allows in an ID */
export function sceneId(name: string): string {
    return String(name ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Pause between two steps in ms, 500 if the setting is missing or invalid */
export function sceneDelay(delay: unknown): number {
    const value = Number(delay);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_WAIT) : 500;
}

/** What running a scene needs from the adapter */
export interface SceneRunner {
    /** Switch the TV on and resolve once it is on */
    powerOn: () => Promise<void>;
    sendKey: (key: string) => Promise<void>;
    holdKey: (key: string, ms: number) => Promise<void>;
    closeApp: (app: string) => Promise<void>;
    youtube: (target: string) => Promise<void>;
    launchApp: (app: string) => Promise<void>;
    selectInput: (input: string) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
}

/**
 * Run the steps one after the other, with `delay` ms between two of them.
 *
 * @param steps parsed steps
 * @param delay pause between two steps in ms
 * @param runner the actions of the adapter
 */
export async function runScene(steps: SceneStep[], delay: number, runner: SceneRunner): Promise<void> {
    for (const [i, step] of steps.entries()) {
        if (i > 0 && delay > 0) {
            await runner.sleep(delay);
        }
        if (step.type === 'on') {
            await runner.powerOn();
        } else if (step.type === 'key') {
            await runner.sendKey(step.key);
        } else if (step.type === 'hold') {
            await runner.holdKey(step.key, step.ms);
        } else if (step.type === 'close') {
            await runner.closeApp(step.app);
        } else if (step.type === 'youtube') {
            await runner.youtube(step.target);
        } else if (step.type === 'app') {
            await runner.launchApp(step.app);
        } else if (step.type === 'input') {
            await runner.selectInput(step.input);
        } else {
            await runner.sleep(step.ms);
        }
    }
}
