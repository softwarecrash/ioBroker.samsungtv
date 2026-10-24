/*
 * The fixed values of the `tv` device type of @iobroker/type-detector and what they mean for a Samsung TV.
 *
 * `TV_KEYS`, `TV_APPS` and `TV_INPUTS` are copies of the lists of the type-detector (`src/tvValues.ts`,
 * ioBroker/ioBroker.type-detector#350). Replace them with the import once a release ships them. The keys
 * are binding: a state lists the keys it supports in `common.states`, consumers (widgets, devices,
 * Matter) show buttons and icons by them.
 */

/** Keys of a remote control, written to `media.key` */
export const TV_KEYS: Readonly<Record<string, string>> = Object.freeze({
    UP: 'Up',
    DOWN: 'Down',
    LEFT: 'Left',
    RIGHT: 'Right',
    SELECT: 'Select',
    BACK: 'Back',
    EXIT: 'Exit',
    HOME: 'Home',
    MENU: 'Menu',
    INFO: 'Info',
    GUIDE: 'Guide',
    CHANNEL_UP: 'Channel up',
    CHANNEL_DOWN: 'Channel down',
    NUMBER_0: '0',
    NUMBER_1: '1',
    NUMBER_2: '2',
    NUMBER_3: '3',
    NUMBER_4: '4',
    NUMBER_5: '5',
    NUMBER_6: '6',
    NUMBER_7: '7',
    NUMBER_8: '8',
    NUMBER_9: '9',
    PLAY: 'Play',
    PAUSE: 'Pause',
    STOP: 'Stop',
    REWIND: 'Rewind',
    FAST_FORWARD: 'Fast forward',
    RED: 'Red',
    GREEN: 'Green',
    YELLOW: 'Yellow',
    BLUE: 'Blue',
});

/** Apps a TV can start, written to `media.app` */
export const TV_APPS: Readonly<Record<string, string>> = Object.freeze({
    YOUTUBE: 'YouTube',
    YOUTUBE_MUSIC: 'YouTube Music',
    NETFLIX: 'Netflix',
    DISNEY_PLUS: 'Disney+',
    PRIME_VIDEO: 'Prime Video',
    APPLE_TV: 'Apple TV',
    MAX: 'Max',
    PARAMOUNT_PLUS: 'Paramount+',
    DAZN: 'DAZN',
    WOW: 'WOW',
    JOYN: 'Joyn',
    RTL_PLUS: 'RTL+',
    MAGENTA_TV: 'MagentaTV',
    ARD_MEDIATHEK: 'ARD Mediathek',
    ZDF_MEDIATHEK: 'ZDF Mediathek',
    SPOTIFY: 'Spotify',
    TWITCH: 'Twitch',
    PLEX: 'Plex',
    BROWSER: 'Browser',
});

/** Inputs a TV can switch to, written to `media.input` */
export const TV_INPUTS: Readonly<Record<string, string>> = Object.freeze({
    TV: 'TV',
    SAT: 'Satellite',
    HDMI1: 'HDMI 1',
    HDMI2: 'HDMI 2',
    HDMI3: 'HDMI 3',
    HDMI4: 'HDMI 4',
    USB: 'USB',
    AV: 'AV',
    COMPONENT: 'Component',
    SCART: 'SCART',
    OPTICAL: 'Optical',
    AUX: 'AUX',
});

/** Samsung key code per key of `TV_KEYS` */
export const TV_KEY_CODES: Readonly<Record<string, string>> = Object.freeze({
    UP: 'KEY_UP',
    DOWN: 'KEY_DOWN',
    LEFT: 'KEY_LEFT',
    RIGHT: 'KEY_RIGHT',
    SELECT: 'KEY_ENTER',
    BACK: 'KEY_RETURN',
    EXIT: 'KEY_EXIT',
    HOME: 'KEY_HOME',
    MENU: 'KEY_MENU',
    INFO: 'KEY_INFO',
    GUIDE: 'KEY_GUIDE',
    CHANNEL_UP: 'KEY_CHUP',
    CHANNEL_DOWN: 'KEY_CHDOWN',
    NUMBER_0: 'KEY_0',
    NUMBER_1: 'KEY_1',
    NUMBER_2: 'KEY_2',
    NUMBER_3: 'KEY_3',
    NUMBER_4: 'KEY_4',
    NUMBER_5: 'KEY_5',
    NUMBER_6: 'KEY_6',
    NUMBER_7: 'KEY_7',
    NUMBER_8: 'KEY_8',
    NUMBER_9: 'KEY_9',
    PLAY: 'KEY_PLAY',
    PAUSE: 'KEY_PAUSE',
    STOP: 'KEY_STOP',
    REWIND: 'KEY_REWIND',
    FAST_FORWARD: 'KEY_FF',
    RED: 'KEY_RED',
    GREEN: 'KEY_GREEN',
    YELLOW: 'KEY_YELLOW',
    // Samsung names the blue key "cyan"
    BLUE: 'KEY_CYAN',
});

/**
 * Direct key per input of `TV_INPUTS`, for TVs that switch with a key. Newer models (e.g. The Frame 2022)
 * ignore these keys; they switch over the source menu, see `sourceMenu.ts`.
 */
export const TV_INPUT_KEYS: Readonly<Record<string, string>> = Object.freeze({
    TV: 'KEY_TV',
    HDMI1: 'KEY_HDMI1',
    HDMI2: 'KEY_HDMI2',
    HDMI3: 'KEY_HDMI3',
    HDMI4: 'KEY_HDMI4',
    AV: 'KEY_AV1',
    COMPONENT: 'KEY_COMPONENT1',
});

/**
 * Pick the entries of a list of values in `common.states` form.
 *
 * @param all all values with their labels, e.g. `TV_APPS`
 * @param keys the supported keys, in the order they are shown
 */
export function statesOf(all: Readonly<Record<string, string>>, keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(keys.filter(key => all[key]).map(key => [key, all[key]!]));
}
