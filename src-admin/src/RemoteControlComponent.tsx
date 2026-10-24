import React from 'react';

import { Box, ButtonBase, CircularProgress, MenuItem, Select, Tooltip, Typography } from '@mui/material';
import {
    Add,
    ArrowBack,
    FastForward,
    FastRewind,
    Home,
    Info,
    Input,
    KeyboardArrowDown,
    KeyboardArrowLeft,
    KeyboardArrowRight,
    KeyboardArrowUp,
    Menu,
    Palette,
    Pause,
    PlayArrow,
    PowerSettingsNew,
    Refresh,
    Remove,
    Stop,
    VolumeOff,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

/** How long a command may take before the remote reports that the instance does not answer, in ms */
const SEND_TIMEOUT = 15_000;

/** Keyboard keys that work while the remote has the focus */
const KEYBOARD: Record<string, string> = {
    ArrowUp: 'KEY_UP',
    ArrowDown: 'KEY_DOWN',
    ArrowLeft: 'KEY_LEFT',
    ArrowRight: 'KEY_RIGHT',
    Enter: 'KEY_ENTER',
    Backspace: 'KEY_RETURN',
    Escape: 'KEY_RETURN',
    Home: 'KEY_HOME',
    '+': 'KEY_VOLUP',
    '-': 'KEY_VOLDOWN',
    m: 'KEY_MUTE',
    ' ': 'KEY_PLAY',
};

/** What a press sends to the instance */
type Command =
    | { key: string }
    | { app: string }
    | { input: string }
    | { scene: string }
    | { power: boolean }
    | { artMode: boolean };

/** A TV as `devices` of the instance reports it */
interface TvInfo {
    name: string;
    displayName: string;
    api: string;
    frameTv: boolean;
    /** Keys of `TV_APPS` */
    apps: string[];
    /** Keys of `TV_INPUTS` */
    inputs: string[];
    /** `on`: the scene begins with ON, so it also starts while the TV is off */
    scenes: { id: string; name: string; on: boolean }[];
}

/** Names of the apps of `TV_APPS` */
const APP_NAMES: Record<string, string> = {
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
};

/** Names of the inputs of `TV_INPUTS` */
const INPUT_NAMES: Record<string, string> = {
    TV: 'TV',
    SAT: 'SAT',
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
};

/** Brand-like colors of the app buttons - text only, no logos */
const APP_COLORS: Record<string, string> = {
    YOUTUBE: '#ff0000',
    YOUTUBE_MUSIC: '#ff0000',
    NETFLIX: '#e50914',
    DISNEY_PLUS: '#113ccf',
    PRIME_VIDEO: '#00a8e1',
    APPLE_TV: '#000000',
    MAX: '#002be7',
    PARAMOUNT_PLUS: '#0064ff',
    DAZN: '#0c161c',
    WOW: '#2b2b2b',
    JOYN: '#e6007e',
    RTL_PLUS: '#000000',
    MAGENTA_TV: '#e20074',
    ARD_MEDIATHEK: '#003480',
    ZDF_MEDIATHEK: '#fa7d19',
    SPOTIFY: '#1db954',
    TWITCH: '#9146ff',
    PLEX: '#e5a00d',
    BROWSER: '#5f6368',
};

const COLORS = {
    body: 'linear-gradient(180deg, #2b2f36 0%, #1c1f24 100%)',
    key: '#3a3f47',
    keyHover: '#4a505a',
    keyActive: '#5b626e',
    text: '#e8eaed',
    textDim: '#9aa0a6',
    power: '#c62828',
    powerHover: '#e53935',
    art: '#8e6c3a',
    artHover: '#a5824c',
    ring: '#30343b',
    ok: '#454b54',
};

interface RemoteControlComponentState extends ConfigGenericState {
    /** TVs of the instance, `null` while asking */
    devices: TvInfo[] | null;
    /** Object name of the TV the remote controls */
    selected: string;
    /** Command that is being sent right now */
    busy: string | null;
    /** Text of the last error, empty if the last command went through */
    error: string;
    online: boolean | null;
    power: boolean | null;
    artMode: boolean | null;
}

/**
 * A remote control in the settings, so a user sees right away whether a TV answers.
 *
 * Every press goes as `sendTo` to the running instance (`remote`, `launchApp`, `input`, `runScene`,
 * `power`, `artMode`), which answers once the TV got it - or with an error that is shown below the
 * remote. It works with the TVs and scenes the running instance knows, not with unsaved settings.
 */
export default class RemoteControlComponent extends ConfigGeneric<ConfigGenericProps, RemoteControlComponentState> {
    private mounted = false;

    private subscribed: string[] = [];

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            devices: null,
            selected: '',
            busy: null,
            error: '',
            online: null,
            power: null,
            artMode: null,
        };
    }

    get target(): string {
        return `${this.props.oContext.adapterName}.${this.props.oContext.instance}`;
    }

    /**
     * The TV is known to be off: only the power key works then, the adapter rejects everything else.
     * While the state is unknown the keys stay usable.
     */
    get isOff(): boolean {
        return this.state.power === false || this.state.online === false;
    }

    get device(): TvInfo | undefined {
        return this.state.devices?.find(device => device.name === this.state.selected);
    }

    async componentDidMount(): Promise<void> {
        void super.componentDidMount();
        this.mounted = true;
        await this.loadDevices();
    }

    componentWillUnmount(): void {
        this.mounted = false;
        super.componentWillUnmount();
        this.unsubscribe();
    }

    async loadDevices(): Promise<void> {
        if (!this.props.alive) {
            this.setState({ devices: [] });
            return;
        }
        try {
            const response: { devices?: TvInfo[] } | null = await this.props.oContext.socket.sendTo(
                this.target,
                'devices',
                {},
            );
            const devices = response?.devices ?? [];
            if (!this.mounted) {
                return;
            }
            let selected = this.state.selected;
            if (!devices.some(device => device.name === selected)) {
                try {
                    selected = window.localStorage.getItem(`${this.target}.remote`) || '';
                } catch {
                    // no storage - take the first TV
                }
                if (!devices.some(device => device.name === selected)) {
                    selected = devices[0]?.name ?? '';
                }
            }
            this.setState({ devices }, () => this.select(selected));
        } catch {
            if (this.mounted) {
                this.setState({ devices: [] });
            }
        }
    }

    /** Show the TV and follow its power, online and Art Mode states */
    select(name: string): void {
        this.unsubscribe();
        this.setState({ selected: name, online: null, power: null, artMode: null, error: '' });
        try {
            window.localStorage.setItem(`${this.target}.remote`, name);
        } catch {
            // no storage - the first TV is shown next time
        }
        if (!name) {
            return;
        }
        this.subscribed = [
            `${this.target}.${name}.info.online`,
            `${this.target}.${name}.state.power`,
            `${this.target}.${name}.control.artMode`,
        ];
        for (const id of this.subscribed) {
            void this.props.oContext.socket.subscribeState(id, this.onStateChanged);
        }
    }

    unsubscribe(): void {
        for (const id of this.subscribed) {
            this.props.oContext.socket.unsubscribeState(id, this.onStateChanged);
        }
        this.subscribed = [];
    }

    onStateChanged = (id: string, state: ioBroker.State | null | undefined): void => {
        if (!this.mounted || !this.subscribed.includes(id)) {
            return;
        }
        const value = state ? !!state.val : null;
        if (id.endsWith('.info.online')) {
            this.setState({ online: value });
        } else if (id.endsWith('.state.power')) {
            this.setState({ power: value });
        } else {
            this.setState({ artMode: value });
        }
    };

    async send(name: string, command: Command): Promise<void> {
        if (this.state.busy || !this.props.alive || !this.state.selected) {
            return;
        }
        this.setState({ busy: name, error: '' });

        const device = this.state.selected;
        let request: [string, Record<string, unknown>];
        if ('key' in command) {
            request = ['remote', { device, key: command.key }];
        } else if ('app' in command) {
            request = ['launchApp', { device, app: command.app }];
        } else if ('input' in command) {
            request = ['input', { device, input: command.input }];
        } else if ('scene' in command) {
            request = ['runScene', { device, scene: command.scene }];
        } else if ('power' in command) {
            request = ['power', { device, on: command.power }];
        } else {
            request = ['artMode', { device, on: command.artMode }];
        }

        let error = '';
        try {
            const response = (await Promise.race([
                this.props.oContext.socket.sendTo(this.target, request[0], request[1]),
                new Promise(resolve =>
                    setTimeout(() => resolve({ error: I18n.t('custom_samsungtv_no_answer') }), SEND_TIMEOUT),
                ),
            ])) as { error?: string } | null;
            error = response?.error || '';
        } catch (e) {
            error = (e as Error).message || String(e);
        }

        if (this.mounted) {
            this.setState({ busy: null, error });
        }
    }

    async refreshApps(): Promise<void> {
        if (this.state.busy || !this.state.selected) {
            return;
        }
        this.setState({ busy: 'apps', error: '' });
        let error = '';
        try {
            const response: { apps?: string[]; error?: string } | null = await this.props.oContext.socket.sendTo(
                this.target,
                'apps',
                {
                    device: this.state.selected,
                    refresh: true,
                },
            );
            error = response?.error || '';
            const apps = response?.apps;
            if (apps && this.state.devices) {
                this.setState({
                    devices: this.state.devices.map(device =>
                        device.name === this.state.selected ? { ...device, apps } : device,
                    ),
                });
            }
        } catch (e) {
            error = (e as Error).message || String(e);
        }
        if (this.mounted) {
            this.setState({ busy: null, error });
        }
    }

    onKeyDown = (event: React.KeyboardEvent): void => {
        const key = KEYBOARD[event.key];
        if (key) {
            event.preventDefault();
            void this.send(key, { key });
        }
    };

    renderKey(
        name: string,
        command: Command,
        content: React.ReactNode,
        title: string,
        sx: Record<string, unknown> = {},
    ): React.JSX.Element {
        const busy = this.state.busy === name;
        return (
            <Tooltip
                title={title}
                placement="top"
                enterDelay={600}
            >
                <span>
                    <ButtonBase
                        aria-label={title}
                        disabled={
                            !this.props.alive ||
                            !this.state.selected ||
                            (!!this.state.busy && !busy) ||
                            (name !== 'power' && this.isOff)
                        }
                        onClick={() => void this.send(name, command)}
                        sx={{
                            width: 52,
                            height: 52,
                            borderRadius: '50%',
                            backgroundColor: COLORS.key,
                            color: COLORS.text,
                            boxShadow: '0 2px 4px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
                            transition: 'background-color 120ms, transform 80ms',
                            '&:hover': { backgroundColor: COLORS.keyHover },
                            '&:active': { backgroundColor: COLORS.keyActive, transform: 'scale(0.95)' },
                            '&.Mui-disabled': { opacity: 0.45 },
                            ...sx,
                        }}
                    >
                        {busy ? (
                            <CircularProgress
                                size={20}
                                sx={{ color: COLORS.text }}
                            />
                        ) : (
                            content
                        )}
                    </ButtonBase>
                </span>
            </Tooltip>
        );
    }

    /** One key of the remote control by its Samsung key code */
    code(code: string, content: React.ReactNode, title: string, sx?: Record<string, unknown>): React.JSX.Element {
        return this.renderKey(code, { key: code }, content, title, sx);
    }

    /** A vertical rocker like the volume and channel keys of a real remote */
    renderRocker(up: string, down: string, label: string, upTitle: string, downTitle: string): React.JSX.Element {
        const half = { width: 52, height: 52, backgroundColor: 'transparent', boxShadow: 'none' };
        return (
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    borderRadius: 26,
                    backgroundColor: COLORS.key,
                    boxShadow: '0 2px 4px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}
            >
                {this.code(up, up === 'KEY_VOLUP' ? <Add /> : <KeyboardArrowUp />, upTitle, half)}
                <Typography sx={{ fontSize: 11, fontWeight: 'bold', color: COLORS.textDim, letterSpacing: 1 }}>
                    {label}
                </Typography>
                {this.code(down, down === 'KEY_VOLDOWN' ? <Remove /> : <KeyboardArrowDown />, downTitle, half)}
            </Box>
        );
    }

    renderDpad(): React.JSX.Element {
        const arrow = { position: 'absolute', backgroundColor: 'transparent', boxShadow: 'none' };
        return (
            <Box
                sx={{
                    position: 'relative',
                    width: 190,
                    height: 190,
                    borderRadius: '50%',
                    backgroundColor: COLORS.ring,
                    boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.05)',
                    my: 1,
                }}
            >
                {this.code('KEY_UP', <KeyboardArrowUp fontSize="large" />, I18n.t('custom_samsungtv_up'), {
                    ...arrow,
                    top: 4,
                    left: 69,
                })}
                {this.code('KEY_DOWN', <KeyboardArrowDown fontSize="large" />, I18n.t('custom_samsungtv_down'), {
                    ...arrow,
                    bottom: 4,
                    left: 69,
                })}
                {this.code('KEY_LEFT', <KeyboardArrowLeft fontSize="large" />, I18n.t('custom_samsungtv_left'), {
                    ...arrow,
                    left: 4,
                    top: 69,
                })}
                {this.code('KEY_RIGHT', <KeyboardArrowRight fontSize="large" />, I18n.t('custom_samsungtv_right'), {
                    ...arrow,
                    right: 4,
                    top: 69,
                })}
                {this.code('KEY_ENTER', <span style={{ fontWeight: 'bold', fontSize: 16 }}>OK</span>, 'OK', {
                    position: 'absolute',
                    top: 55,
                    left: 55,
                    width: 80,
                    height: 80,
                    backgroundColor: COLORS.ok,
                })}
            </Box>
        );
    }

    /** A row of rounded text buttons: apps, inputs or scenes */
    renderPills(
        items: { id: string; label: React.ReactNode; title: string; command: Command; color?: string }[],
        columns: number,
    ): React.JSX.Element {
        return (
            <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 1, width: '100%' }}>
                {items.map(item => {
                    const busy = this.state.busy === item.id;
                    return (
                        <ButtonBase
                            key={item.id}
                            aria-label={item.title}
                            disabled={!this.props.alive || (!!this.state.busy && !busy) || this.isOff}
                            onClick={() => void this.send(item.id, item.command)}
                            sx={{
                                height: 34,
                                borderRadius: '17px',
                                backgroundColor: item.color ?? 'transparent',
                                border: item.color ? '1px solid rgba(255,255,255,0.12)' : `1px solid ${COLORS.textDim}`,
                                color: item.color ? '#ffffff' : COLORS.text,
                                fontSize: 12,
                                fontWeight: 'bold',
                                px: 1,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                                boxShadow: item.color
                                    ? '0 2px 4px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)'
                                    : 'none',
                                transition: 'filter 120ms, transform 80ms',
                                '&:hover': item.color
                                    ? { filter: 'brightness(1.15)' }
                                    : { backgroundColor: COLORS.keyHover },
                                '&:active': { transform: 'scale(0.96)' },
                                '&.Mui-disabled': { opacity: 0.45 },
                            }}
                        >
                            {busy ? (
                                <CircularProgress
                                    size={16}
                                    sx={{ color: item.color ? '#ffffff' : COLORS.text }}
                                />
                            ) : (
                                item.label
                            )}
                        </ButtonBase>
                    );
                })}
            </Box>
        );
    }

    renderApps(device: TvInfo): React.JSX.Element | null {
        if (device.api !== 'tizen' && device.api !== 'unknown') {
            return null;
        }
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, width: '100%' }}>
                {this.renderPills(
                    device.apps.map(key => ({
                        id: `app:${key}`,
                        label: APP_NAMES[key] ?? key,
                        title: APP_NAMES[key] ?? key,
                        command: { app: key },
                        color: APP_COLORS[key] ?? COLORS.key,
                    })),
                    2,
                )}
                <ButtonBase
                    onClick={() => void this.refreshApps()}
                    disabled={!this.props.alive || !!this.state.busy || this.isOff}
                    sx={{ color: COLORS.textDim, fontSize: 12, borderRadius: 1, px: 1, gap: 0.5 }}
                >
                    {this.state.busy === 'apps' ? (
                        <CircularProgress
                            size={12}
                            sx={{ color: COLORS.textDim }}
                        />
                    ) : (
                        <Refresh sx={{ fontSize: 14 }} />
                    )}
                    {I18n.t('custom_samsungtv_apps_reload')}
                </ButtonBase>
            </Box>
        );
    }

    renderStatus(): React.JSX.Element {
        const { online, power, artMode } = this.state;
        let color = '#5f6368';
        let text = I18n.t('custom_samsungtv_state_unknown');
        if (!this.props.alive) {
            text = I18n.t('custom_samsungtv_not_alive');
        } else if (online === false) {
            text = I18n.t('custom_samsungtv_state_offline');
        } else if (power === true && artMode) {
            color = '#c49a52';
            text = I18n.t('custom_samsungtv_state_art');
        } else if (power === true) {
            color = '#34a853';
            text = I18n.t('custom_samsungtv_state_on');
        } else if (power === false) {
            color = '#ea4335';
            text = I18n.t('custom_samsungtv_state_off');
        }
        return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, justifyContent: 'center' }}>
                <Box
                    sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: color,
                        boxShadow: power ? `0 0 6px ${color}` : 'none',
                    }}
                />
                <Typography sx={{ fontSize: 12, color: COLORS.textDim }}>{text}</Typography>
            </Box>
        );
    }

    renderSelector(): React.JSX.Element | null {
        const devices = this.state.devices ?? [];
        if (devices.length < 2) {
            return null;
        }
        return (
            <Select
                variant="standard"
                value={this.state.selected}
                onChange={event => this.select(event.target.value)}
                sx={{ minWidth: 220, mb: 2 }}
            >
                {devices.map(device => (
                    <MenuItem
                        key={device.name}
                        value={device.name}
                    >
                        {device.displayName}
                    </MenuItem>
                ))}
            </Select>
        );
    }

    renderItem(): React.JSX.Element {
        const { devices } = this.state;
        if (devices === null) {
            return (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                    <CircularProgress />
                </Box>
            );
        }
        const device = this.device;
        if (!device) {
            return (
                <Typography sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
                    {I18n.t(this.props.alive ? 'custom_samsungtv_no_tv' : 'custom_samsungtv_not_alive')}
                </Typography>
            );
        }

        const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' };
        const small = { width: 40, height: 40 };
        const { power, artMode } = this.state;
        // while the TV is off only power works, and the scenes that switch it on themselves
        const off = this.isOff;
        const scenes = off ? device.scenes.filter(scene => scene.on) : device.scenes;

        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', py: 2 }}>
                {this.renderSelector()}
                <Box
                    tabIndex={0}
                    onKeyDown={this.onKeyDown}
                    sx={{
                        width: 260,
                        px: 3,
                        py: 3,
                        borderRadius: '44px',
                        background: COLORS.body,
                        boxShadow: '0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        outline: 'none',
                        '&:focus-visible': { boxShadow: '0 0 0 2px #1976d2, 0 10px 30px rgba(0,0,0,0.45)' },
                    }}
                >
                    <Box sx={off ? { ...row, justifyContent: 'center' } : row}>
                        {this.renderKey(
                            'power',
                            { power: !power },
                            <PowerSettingsNew />,
                            I18n.t(power ? 'custom_samsungtv_power_off' : 'custom_samsungtv_power_on'),
                            { backgroundColor: COLORS.power, '&:hover': { backgroundColor: COLORS.powerHover } },
                        )}
                        {device.frameTv && !off
                            ? this.renderKey(
                                  'artMode',
                                  { artMode: !artMode },
                                  <Palette />,
                                  I18n.t(artMode ? 'custom_samsungtv_art_off' : 'custom_samsungtv_art_on'),
                                  {
                                      backgroundColor: artMode ? COLORS.artHover : COLORS.art,
                                      '&:hover': { backgroundColor: COLORS.artHover },
                                  },
                              )
                            : null}
                        {off ? null : this.code('KEY_SOURCE', <Input />, I18n.t('custom_samsungtv_source'))}
                    </Box>

                    {this.renderStatus()}

                    {off ? null : (
                        <>
                            {device.inputs.length
                                ? this.renderPills(
                                      device.inputs.map(key => ({
                                          id: `input:${key}`,
                                          label: INPUT_NAMES[key] ?? key,
                                          title: INPUT_NAMES[key] ?? key,
                                          command: { input: key },
                                      })),
                                      Math.min(device.inputs.length, 3),
                                  )
                                : null}

                            <Box sx={row}>
                                {this.code('KEY_MENU', <Menu />, I18n.t('custom_samsungtv_menu'))}
                                {this.code('KEY_INFO', <Info />, I18n.t('custom_samsungtv_info'))}
                            </Box>

                            {this.renderDpad()}

                            <Box sx={row}>
                                {this.code('KEY_RETURN', <ArrowBack />, I18n.t('custom_samsungtv_back'))}
                                {this.code('KEY_HOME', <Home />, I18n.t('custom_samsungtv_home'))}
                                {this.code('KEY_MUTE', <VolumeOff />, I18n.t('custom_samsungtv_mute'))}
                            </Box>

                            <Box sx={{ ...row, alignItems: 'stretch' }}>
                                {this.renderRocker(
                                    'KEY_VOLUP',
                                    'KEY_VOLDOWN',
                                    'VOL',
                                    I18n.t('custom_samsungtv_volume_up'),
                                    I18n.t('custom_samsungtv_volume_down'),
                                )}
                                {this.renderRocker(
                                    'KEY_CHUP',
                                    'KEY_CHDOWN',
                                    'CH',
                                    I18n.t('custom_samsungtv_channel_up'),
                                    I18n.t('custom_samsungtv_channel_down'),
                                )}
                            </Box>

                            <Box sx={{ ...row, gap: 0.5 }}>
                                {this.code(
                                    'KEY_REWIND',
                                    <FastRewind fontSize="small" />,
                                    I18n.t('custom_samsungtv_rewind'),
                                    small,
                                )}
                                {this.code(
                                    'KEY_PLAY',
                                    <PlayArrow fontSize="small" />,
                                    I18n.t('custom_samsungtv_play'),
                                    small,
                                )}
                                {this.code(
                                    'KEY_PAUSE',
                                    <Pause fontSize="small" />,
                                    I18n.t('custom_samsungtv_pause'),
                                    small,
                                )}
                                {this.code(
                                    'KEY_STOP',
                                    <Stop fontSize="small" />,
                                    I18n.t('custom_samsungtv_stop'),
                                    small,
                                )}
                                {this.code(
                                    'KEY_FF',
                                    <FastForward fontSize="small" />,
                                    I18n.t('custom_samsungtv_forward'),
                                    small,
                                )}
                            </Box>

                            {this.renderApps(device)}
                        </>
                    )}

                    {scenes.length
                        ? this.renderPills(
                              scenes.map(scene => ({
                                  id: `scene:${scene.id}`,
                                  label: (
                                      <>
                                          <PlayArrow sx={{ fontSize: 16, mr: 0.5 }} />
                                          {scene.name}
                                      </>
                                  ),
                                  title: scene.name,
                                  command: { scene: scene.id },
                              })),
                              1,
                          )
                        : null}

                    <Typography
                        sx={{
                            mt: 1,
                            fontSize: 13,
                            fontWeight: 'bold',
                            letterSpacing: 4,
                            color: COLORS.textDim,
                            userSelect: 'none',
                        }}
                    >
                        SAMSUNG
                    </Typography>
                </Box>

                <Typography
                    role="status"
                    sx={{
                        mt: 2,
                        minHeight: 24,
                        maxWidth: 420,
                        textAlign: 'center',
                        color: this.state.error ? 'error.main' : 'text.secondary',
                        fontSize: 14,
                    }}
                >
                    {this.state.error ||
                        I18n.t(this.isOff ? 'custom_samsungtv_switch_on_first' : 'custom_samsungtv_hint')}
                </Typography>
            </Box>
        );
    }
}
