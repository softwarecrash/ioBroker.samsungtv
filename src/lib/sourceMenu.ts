/*
 * Switching the input over the source menu.
 *
 * Newer Samsung TVs ignore the direct input keys (`KEY_HDMI1`...); checked on The Frame GQ55LS03BAUXZG
 * (2022). They switch over the panel "Connected devices" that `KEY_SOURCE` opens:
 *
 *   KEY_SOURCE -> pause -> 8x KEY_LEFT (focus safely in the side bar)
 *   -> (index + 2)x KEY_RIGHT (1x into the panel onto SmartThings, 1x per entry up to the target) -> KEY_ENTER
 *
 * The panel lists only connected inputs, in an order the TV does not report locally, so the user configures
 * it per TV: the entries after SmartThings, e.g. `TV, HDMI2, USB, WORKSPACE`. Confirmed on that TV from the
 * home screen, from live TV and from YouTube.
 */

/** Pause after `KEY_SOURCE` until the panel is open, in ms */
export const SOURCE_MENU_DELAY = 1500;
/** Pause between two keys of the sequence, in ms */
export const SOURCE_MENU_KEY_GAP = 150;
/** `KEY_LEFT` presses that bring the focus into the side bar from anywhere in the panel */
const SOURCE_MENU_LEFT = 8;

/**
 * Parse the configured order of the source menu.
 *
 * @param text the entries after SmartThings, separated by commas, semicolons or new lines, e.g. `TV, HDMI 2, USB`
 * @returns the entries in upper case without spaces, e.g. `['TV', 'HDMI2', 'USB']`
 */
export function parseSourceMenu(text: unknown): string[] {
    if (Array.isArray(text)) {
        return parseSourceMenu(text.join(','));
    }
    return (typeof text === 'string' ? text : '')
        .split(/[,\n;]/)
        .map(entry => entry.trim().toUpperCase().replace(/\s+/g, ''))
        .filter(entry => !!entry);
}

/**
 * The keys after `KEY_SOURCE` and the pause that select an entry of the source menu.
 *
 * @param menu the parsed menu order, see `parseSourceMenu`
 * @param input the entry to select, e.g. `HDMI2`
 * @returns the keys, or `null` if the entry is not in the menu
 */
export function sourceMenuKeys(menu: readonly string[], input: string): string[] | null {
    const index = menu.indexOf(String(input).toUpperCase().replace(/\s+/g, ''));
    if (index < 0) {
        return null;
    }
    return [
        ...Array<string>(SOURCE_MENU_LEFT).fill('KEY_LEFT'),
        ...Array<string>(index + 2).fill('KEY_RIGHT'),
        'KEY_ENTER',
    ];
}
