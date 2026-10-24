import React from 'react';

import { Autocomplete, Box, Chip, CircularProgress, IconButton, TextField, Tooltip } from '@mui/material';
import { Edit, EditOff, ErrorOutlined, PlayArrow } from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

/** One entry of the step list */
interface StepOption {
    /** What is written into the scene, e.g. `YOUTUBE` */
    value: string;
    label: string;
    group: string;
}

/** A TV as `devices` of the instance reports it */
interface TvInfo {
    name: string;
    apps: string[];
    inputs: string[];
}

/** Keys of `TV_KEYS` of the type-detector with their labels */
const KEYS: Record<string, string> = {
    HOME: 'Home',
    BACK: 'Back',
    EXIT: 'Exit',
    MENU: 'Menu',
    INFO: 'Info',
    GUIDE: 'Guide',
    UP: 'Up',
    DOWN: 'Down',
    LEFT: 'Left',
    RIGHT: 'Right',
    OK: 'OK',
    SOURCE: 'Source',
    VOLUP: 'Volume +',
    VOLDOWN: 'Volume -',
    MUTE: 'Mute',
    CHANNEL_UP: 'Channel +',
    CHANNEL_DOWN: 'Channel -',
    PLAY: 'Play',
    PAUSE: 'Pause',
    STOP: 'Stop',
    REWIND: 'Rewind',
    FAST_FORWARD: 'Fast forward',
    RED: 'Red',
    GREEN: 'Green',
    YELLOW: 'Yellow',
    BLUE: 'Blue',
    0: '0',
    1: '1',
    2: '2',
    3: '3',
    4: '4',
    5: '5',
    6: '6',
    7: '7',
    8: '8',
    9: '9',
};

/** Apps of `TV_APPS` */
const APPS: Record<string, string> = {
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

/** Inputs of `TV_INPUTS` */
const INPUTS: Record<string, string> = {
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

const WAITS = [500, 1000, 2000, 3000, 5000, 10000];

/** Split the scene text the way the adapter does */
function splitSteps(text: string): string[] {
    return String(text ?? '')
        .split(/[,\n;]/)
        .map(step => step.trim())
        .filter(step => !!step);
}

/** The step in the form the list uses: upper case, spaces as underscores, pauses as `WAIT <ms>` */
function normalize(step: string): string {
    const token = step.trim().toUpperCase().replace(/\s+/g, ' ');
    const wait = /^(?:WAIT|PAUSE|SLEEP) ?(\d+)$/.exec(token);
    return wait ? `WAIT ${wait[1]}` : token.replace(/ /g, '_');
}

interface SceneStepsComponentState extends ConfigGenericState {
    /** TVs of the instance, to offer only their apps and inputs */
    devices: TvInfo[] | null;
    /** Show the plain text instead of the chips */
    raw: boolean;
    /** Text typed into the list */
    input: string;
    /** The scene is being played on the TV */
    playing: boolean;
    /** Why the last play failed, empty if it went through */
    playError: string;
}

/**
 * The steps of a scene as chips, with a list to add a step from: switching on, keys, the apps and
 * inputs of the TV of this row, and pauses. The value stays the plain text the adapter parses, e.g.
 * `ON, YOUTUBE, WAIT 3000, OK`, and can still be edited as text.
 */
export default class SceneStepsComponent extends ConfigGeneric<ConfigGenericProps, SceneStepsComponentState> {
    private mounted = false;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = { ...this.state, devices: null, raw: false, input: '', playing: false, playError: '' };
    }

    async componentDidMount(): Promise<void> {
        void super.componentDidMount();
        this.mounted = true;
        if (!this.props.alive) {
            return;
        }
        try {
            const response: { devices?: TvInfo[] } | null = await this.props.oContext.socket.sendTo(
                `${this.props.oContext.adapterName}.${this.props.oContext.instance}`,
                'devices',
                {},
            );
            if (this.mounted) {
                this.setState({ devices: response?.devices ?? [] });
            }
        } catch {
            // the full lists are offered then
        }
    }

    componentWillUnmount(): void {
        this.mounted = false;
        super.componentWillUnmount();
    }

    /** The attribute of the table row this component edits, `steps` */
    get stepsAttr(): string {
        return this.props.attr ?? 'steps';
    }

    get steps(): string[] {
        return splitSteps(ConfigGeneric.getValue(this.props.data, this.stepsAttr) as string);
    }

    setSteps(steps: string[]): void {
        void this.onChange(this.stepsAttr, steps.join(', '));
    }

    /** All steps that can be picked, grouped; apps and inputs of the TV of this row if it is known */
    get options(): StepOption[] {
        const device = this.state.devices?.find(entry => entry.name === this.props.data?.device);
        // a scene for all TVs: everything any TV offers
        const all = this.state.devices?.length && !this.props.data?.device ? this.state.devices : null;
        const apps = device?.apps ?? (all ? [...new Set(all.flatMap(entry => entry.apps))] : Object.keys(APPS));
        const inputs = device?.inputs ?? (all ? [...new Set(all.flatMap(entry => entry.inputs))] : Object.keys(INPUTS));

        const group = (name: string): string => I18n.t(`custom_samsungtv_steps_${name}`);
        return [
            { value: 'ON', label: I18n.t('custom_samsungtv_steps_on'), group: group('power') },
            ...apps.map(key => ({ value: key, label: APPS[key] ?? key, group: group('apps') })),
            ...apps.map(key => ({
                value: `CLOSE ${key}`,
                label: I18n.t('custom_samsungtv_steps_close', APPS[key] ?? key),
                group: group('apps'),
            })),
            ...inputs.map(key => ({ value: key, label: INPUTS[key] ?? key, group: group('inputs') })),
            ...Object.entries(KEYS).map(([value, label]) => ({ value, label, group: group('keys') })),
            ...WAITS.map(ms => ({
                value: `WAIT ${ms}`,
                label: I18n.t('custom_samsungtv_steps_wait', ms / 1000),
                group: group('pauses'),
            })),
        ];
    }

    /** The label of a step for its chip, `null` if the adapter does not know it */
    labelOf(step: string, options: StepOption[]): string | null {
        const youtube = /^youtube\s*:\s*(.+)$/i.exec(step.trim())?.[1];
        if (youtube) {
            return `YouTube: ${youtube}`;
        }
        const value = normalize(step);
        const option = options.find(entry => normalize(entry.value) === value);
        if (option) {
            return option.label;
        }
        if (/^WAIT \d+$/.test(value)) {
            return I18n.t('custom_samsungtv_steps_wait', Number(value.slice(5)) / 1000);
        }
        const close = /^CLOSE_(.+)$/.exec(value)?.[1];
        if (close && APPS[close]) {
            return I18n.t('custom_samsungtv_steps_close', APPS[close]);
        }
        const hold = /^HOLD_(.+?)(?:_(\d+))?$/.exec(value);
        if (hold) {
            const key = options.find(entry => entry.value === hold[1])?.label ?? String(hold[1]);
            return I18n.t('custom_samsungtv_steps_hold', key, Number(hold[2] ?? 1000) / 1000);
        }
        if (/^KEY_[A-Z0-9_]+$/.test(value) || /^NUMBER_\d$/.test(value) || APPS[value] || INPUTS[value]) {
            return value;
        }
        return null;
    }

    /** Play the steps as they are typed - not yet saved - on the TV of this row, or on all TVs */
    async play(): Promise<void> {
        this.setState({ playing: true, playError: '' });
        let playError = '';
        try {
            const response: { error?: string } | null = await this.props.oContext.socket.sendTo(
                `${this.props.oContext.adapterName}.${this.props.oContext.instance}`,
                'testScene',
                {
                    name: this.props.data?.name,
                    device: this.props.data?.device ?? '',
                    steps: ConfigGeneric.getValue(this.props.data, this.stepsAttr),
                    delay: this.props.data?.delay,
                },
            );
            playError = response?.error ?? '';
        } catch (e) {
            playError = (e as Error).message || String(e);
        }
        if (this.mounted) {
            this.setState({ playing: false, playError });
        }
    }

    renderPlay(): React.JSX.Element {
        const { playing, playError } = this.state;
        return (
            <Tooltip
                title={
                    playError || I18n.t(this.props.alive ? 'custom_samsungtv_steps_play' : 'custom_samsungtv_not_alive')
                }
            >
                <span>
                    <IconButton
                        size="small"
                        color={playError ? 'error' : 'primary'}
                        disabled={!this.props.alive || playing || !this.steps.length}
                        onClick={() => void this.play()}
                    >
                        {playing ? (
                            <CircularProgress size={18} />
                        ) : playError ? (
                            <ErrorOutlined fontSize="small" />
                        ) : (
                            <PlayArrow fontSize="small" />
                        )}
                    </IconButton>
                </span>
            </Tooltip>
        );
    }

    add(value: string): void {
        const step = value.trim();
        if (step) {
            this.setSteps([...this.steps, step]);
        }
        this.setState({ input: '' });
    }

    renderItem(): React.JSX.Element {
        const steps = this.steps;
        const options = this.options;
        if (this.state.raw) {
            return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    <TextField
                        variant="standard"
                        fullWidth
                        value={(ConfigGeneric.getValue(this.props.data, this.stepsAttr) as string) ?? ''}
                        error={!steps.length}
                        placeholder="ON, YOUTUBE, WAIT 3000, OK"
                        onChange={event => void this.onChange(this.stepsAttr, event.target.value)}
                    />
                    {this.renderPlay()}
                    <Tooltip title={I18n.t('custom_samsungtv_steps_list')}>
                        <IconButton
                            size="small"
                            onClick={() => this.setState({ raw: false })}
                        >
                            <EditOff fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Box>
            );
        }

        return (
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, width: '100%' }}>
                {steps.map((step, index) => {
                    const label = this.labelOf(step, options);
                    return (
                        <Chip
                            // the same step may occur twice, e.g. OK, OK
                            key={`${index}_${step}`}
                            size="small"
                            label={label ?? step}
                            color={label === null ? 'error' : normalize(step) === 'ON' ? 'success' : 'default'}
                            title={label === null ? I18n.t('custom_samsungtv_steps_unknown') : normalize(step)}
                            onDelete={() => this.setSteps(steps.filter((_, i) => i !== index))}
                        />
                    );
                })}
                <Autocomplete<StepOption, false, false, true>
                    freeSolo
                    size="small"
                    sx={{ minWidth: 200, flexGrow: 1 }}
                    options={options}
                    groupBy={option => option.group}
                    getOptionLabel={option => (typeof option === 'string' ? option : option.label)}
                    renderOption={(props, option) => {
                        const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & { key: string };
                        return (
                            <li
                                key={key}
                                {...rest}
                            >
                                {option.label}
                                {option.label !== option.value ? (
                                    <span style={{ marginLeft: 8, opacity: 0.5, fontSize: 12 }}>{option.value}</span>
                                ) : null}
                            </li>
                        );
                    }}
                    inputValue={this.state.input}
                    value={null}
                    onInputChange={(_event, input, reason) => reason !== 'reset' && this.setState({ input })}
                    onChange={(_event, option) => {
                        if (option) {
                            this.add(typeof option === 'string' ? option : option.value);
                        }
                    }}
                    renderInput={params => (
                        <TextField
                            {...params}
                            variant="standard"
                            error={!steps.length}
                            placeholder={I18n.t('custom_samsungtv_steps_add')}
                        />
                    )}
                />
                {this.renderPlay()}
                <Tooltip title={I18n.t('custom_samsungtv_steps_text')}>
                    <IconButton
                        size="small"
                        onClick={() => this.setState({ raw: true })}
                    >
                        <Edit fontSize="small" />
                    </IconButton>
                </Tooltip>
            </Box>
        );
    }
}
