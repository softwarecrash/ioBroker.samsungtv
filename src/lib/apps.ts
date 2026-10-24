/*
 * Apps a Samsung Tizen TV can start, keyed like `TV_APPS`.
 *
 * Samsung documents no app IDs. These come from community lists (homebridge-samsung-tizen,
 * blog-razrabotchika/homebridge-samsung-tizen-applications); an app has a new ID on newer models now
 * and then, so every app lists all known IDs, newest first. The adapter asks the TV which of them is
 * installed - `GET /api/v2/applications/<id>` answers 200 or 404 - and uses the first one that is.
 *
 * Checked on a Samsung The Frame GQ55LS03BAUXZG (2022): YouTube, Netflix (3201907018807), Disney+
 * (3201901017640), Prime Video (3201910019365), Apple TV, Joyn, RTL+ (3201908018988), ARD Mediathek,
 * ZDF Mediathek, Spotify and Browser (3202010022079) are found and start with `POST`. The launch over the
 * websocket (`ed.apps.launch`) does nothing on that TV, so apps are started with the REST API first.
 */
import http from 'node:http';
import type { InstalledApp } from '../types';

/** Port of the REST API of the TV */
const REST_PORT = 8001;

/** Known app IDs per `TV_APPS` key, newest first */
export const SAMSUNG_APPS: Readonly<Record<string, { name: string; ids: string[] }>> = {
    YOUTUBE: { name: 'YouTube', ids: ['111299001912'] },
    NETFLIX: { name: 'Netflix', ids: ['3201907018807', '11101200001'] },
    DISNEY_PLUS: { name: 'Disney+', ids: ['3202204027038', '3202009021709', '3201901017640'] },
    PRIME_VIDEO: { name: 'Prime Video', ids: ['3201910019365', '3201512006785'] },
    APPLE_TV: { name: 'Apple TV', ids: ['3201807016597'] },
    MAX: { name: 'Max', ids: ['3202301029760', '3201601007230'] },
    PARAMOUNT_PLUS: { name: 'Paramount+', ids: ['3202110025305', '3201710014981'] },
    DAZN: { name: 'DAZN', ids: ['3201806016390'] },
    JOYN: { name: 'Joyn', ids: ['3201502001386'] },
    RTL_PLUS: { name: 'RTL+', ids: ['3201908018988', '3201909019211'] },
    MAGENTA_TV: { name: 'MagentaTV', ids: ['3201907018746'] },
    ARD_MEDIATHEK: { name: 'ARD Mediathek', ids: ['3201412000679'] },
    ZDF_MEDIATHEK: { name: 'ZDF Mediathek', ids: ['3201705012365'] },
    SPOTIFY: { name: 'Spotify', ids: ['3201606009684'] },
    TWITCH: { name: 'Twitch', ids: ['3202203026841'] },
    PLEX: { name: 'Plex', ids: ['3201512006963'] },
    BROWSER: { name: 'Browser', ids: ['3202010022079', '3201907018784', 'org.tizen.browser'] },
};

/**
 * One request to the app endpoint of the REST API. Resolves with the HTTP status (0 if the TV does not answer)
 * and the body. `agent: false`: the TV closes the connection after every answer, a keep-alive agent fails every
 * second request.
 */
function appRequestWithBody(
    ip: string,
    appId: string,
    method: 'GET' | 'POST' | 'DELETE',
    timeout = 3000,
): Promise<{ status: number; body: string }> {
    return new Promise(resolve => {
        const req = http.request(
            {
                host: ip,
                port: REST_PORT,
                path: `/api/v2/applications/${encodeURIComponent(appId)}`,
                method,
                timeout,
                agent: false,
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
                );
            },
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.end();
    });
}

async function appRequest(ip: string, appId: string, method: 'GET' | 'POST' | 'DELETE'): Promise<number> {
    return (await appRequestWithBody(ip, appId, method)).status;
}

/** State of an app: `running` it is started, `visible` it is in the foreground */
export interface AppStatus {
    running: boolean;
    visible: boolean;
}

/**
 * Ask the TV whether an app runs and is in the foreground.
 *
 * @param ip address of the TV
 * @param appId ID under which this TV knows the app
 * @returns the status, `null` if the TV does not answer or does not know the app
 */
export async function getAppStatus(ip: string, appId: string): Promise<AppStatus | null> {
    const { status, body } = await appRequestWithBody(ip, appId, 'GET');
    if (status !== 200) {
        return null;
    }
    try {
        const info = JSON.parse(body) as { running?: unknown; visible?: unknown };
        return { running: info.running === true, visible: info.visible === true };
    } catch {
        return null;
    }
}

/**
 * The app in the foreground, `''` if none of the given apps is.
 *
 * @param ip address of the TV
 * @param apps the apps found on the TV
 * @returns the key of the app, `null` if the TV does not answer
 */
export async function findVisibleApp(ip: string, apps: readonly InstalledApp[]): Promise<string | null> {
    const states = await Promise.all(apps.map(app => getAppStatus(ip, app.appId)));
    if (apps.length && states.every(state => state === null)) {
        return null;
    }
    return apps.find((_app, i) => states[i]?.visible)?.key ?? '';
}

/**
 * Ask the TV which of the known apps are installed.
 *
 * @param ip address of the TV
 * @returns the installed apps in the order of `SAMSUNG_APPS`, or `null` if the TV does not answer at all
 */
export async function findInstalledApps(ip: string): Promise<InstalledApp[] | null> {
    let answered = false;
    const found = await Promise.all(
        Object.entries(SAMSUNG_APPS).map(async ([key, app]) => {
            for (const appId of app.ids) {
                const status = await appRequest(ip, appId, 'GET');
                answered ||= status !== 0;
                if (status === 200) {
                    return { key, appId };
                }
            }
            return null;
        }),
    );
    return answered ? found.filter((app): app is InstalledApp => !!app) : null;
}

/** The REST API of the TV does not answer at all, e.g. a few seconds after waking up */
export class TvNotAnsweringError extends Error {
    constructor() {
        super('The TV does not answer. Is it switched on?');
        this.name = 'TvNotAnsweringError';
    }
}

/**
 * Start an app with the REST API.
 *
 * @param ip address of the TV
 * @param appId ID under which this TV knows the app
 */
export async function launchAppRest(ip: string, appId: string): Promise<void> {
    const status = await appRequest(ip, appId, 'POST');
    if (status === 0) {
        throw new TvNotAnsweringError();
    }
    if (status < 200 || status >= 300) {
        throw new Error(`The TV refused to start the app (HTTP ${status})`);
    }
}

/**
 * Close an app. The TV answers HTTP 500 for an app that does not run, so that is checked first.
 *
 * @param ip address of the TV
 * @param appId ID under which this TV knows the app
 * @returns `false` if the app did not run
 */
export async function closeAppRest(ip: string, appId: string): Promise<boolean> {
    const state = await getAppStatus(ip, appId);
    if (!state?.running) {
        return false;
    }
    const status = await appRequest(ip, appId, 'DELETE');
    if (status === 0) {
        throw new TvNotAnsweringError();
    }
    if (status < 200 || status >= 300) {
        throw new Error(`The TV refused to close the app (HTTP ${status})`);
    }
    return true;
}
