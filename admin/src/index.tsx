import React from 'react';
import { createRoot } from 'react-dom/client';
import { GenericApp, I18n } from '@iobroker/adapter-react-v5';
import type { GenericAppProps, GenericAppState } from '@iobroker/adapter-react-v5';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    MenuItem,
    Paper,
    Select,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '@mui/material';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinkIcon from '@mui/icons-material/Link';
import SearchIcon from '@mui/icons-material/Search';
import type { AdminStateResponse, PairResponse, TvApi, TvDevice, TvProtocol } from './types';
import en from './i18n/en.json';
import de from './i18n/de.json';
import es from './i18n/es.json';
import fr from './i18n/fr.json';
import it from './i18n/it.json';
import nl from './i18n/nl.json';
import pl from './i18n/pl.json';
import pt from './i18n/pt.json';
import ru from './i18n/ru.json';
import uk from './i18n/uk.json';
import zhCn from './i18n/zh-cn.json';

interface AppState extends GenericAppState {
    busy: boolean;
    discovered: TvDevice[];
    lastScan: number;
    paired: Record<string, boolean>;
    manualOpen: boolean;
    manual: TvDevice;
    pairDevice: TvDevice | null;
    pin: string;
}

const emptyDevice = (): TvDevice => ({
    id: '',
    name: '',
    ip: '',
    mac: '',
    model: '',
    api: 'unknown',
    protocol: '',
    port: 0,
});

function normalizeMac(value: string): string {
    const compact = value.toLowerCase().replace(/[^0-9a-f]/g, '');
    return compact.length === 12 ? compact.match(/.{2}/g)?.join(':') || '' : value.trim().toLowerCase();
}

function sanitizeName(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
}

class App extends GenericApp<GenericAppProps, AppState> {
    public constructor(props: GenericAppProps) {
        const settings: GenericAppProps = {
            ...props,
            adapterName: 'samsungtv',
            translations: { en, de, es, fr, it, nl, pl, pt, ru, uk, 'zh-cn': zhCn },
        };
        super(props, settings);
        this.state = {
            ...this.state,
            busy: false,
            discovered: [],
            lastScan: 0,
            paired: {},
            manualOpen: false,
            manual: emptyDevice(),
            pairDevice: null,
            pin: '',
        };
    }

    public override onPrepareLoad(settings: Record<string, unknown>): void {
        // Never decrypt or retain the encrypted backend-only secret payload in the browser.
        delete settings.tokens;
    }

    public override onConnectionReady(): void {
        super.onConnectionReady();
        void this.refreshAdminState();
    }

    private async command<T>(command: string, data: unknown = {}): Promise<T> {
        const response = await this.socket.sendTo(`${this.adapterName}.${this.instance}`, command, data);
        return ((response as { result?: T }).result ?? response) as T;
    }

    private get configuredDevices(): TvDevice[] {
        return Array.isArray(this.state.native.devices) ? (this.state.native.devices as TvDevice[]) : [];
    }

    private setDevices(devices: TvDevice[]): void {
        this.updateNativeValue('devices', devices);
    }

    private async refreshAdminState(): Promise<void> {
        try {
            const response = await this.command<AdminStateResponse>('getAdminState');
            if (!response.ok) {
                throw new Error(response.error || 'Could not load adapter state');
            }
            const paired = Object.fromEntries(response.devices.map(device => [device.id, Boolean(device.paired)]));
            this.setState({ discovered: response.discovered, lastScan: response.lastScan, paired });
        } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        }
    }

    private async scan(): Promise<void> {
        this.setState({ busy: true });
        try {
            const response = await this.command<AdminStateResponse>('discover', {
                timeout: Number(this.state.native.discoveryTimeout) || 5,
            });
            if (!response.ok) {
                throw new Error(response.error || 'Discovery failed');
            }
            await this.refreshAdminState();
        } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        } finally {
            this.setState({ busy: false });
        }
    }

    private isConfigured(candidate: TvDevice): boolean {
        const mac = normalizeMac(candidate.mac || '');
        return this.configuredDevices.some(
            device =>
                (candidate.id && device.id === candidate.id) ||
                (mac && normalizeMac(device.mac || '') === mac) ||
                (!candidate.id && !mac && candidate.ip && device.ip === candidate.ip),
        );
    }

    private addDevice(candidate: TvDevice): void {
        const id = candidate.id || normalizeMac(candidate.mac) || candidate.ip;
        if (!id || this.isConfigured({ ...candidate, id })) {
            return;
        }
        const baseName = sanitizeName(candidate.name || candidate.displayName || candidate.model || 'tv') || 'tv';
        const used = new Set(this.configuredDevices.map(device => device.name));
        let name = baseName;
        for (let suffix = 2; used.has(name); suffix += 1) {
            name = `${baseName}-${suffix}`;
        }
        this.setDevices([...this.configuredDevices, { ...candidate, id, name, mac: normalizeMac(candidate.mac) }]);
        this.setState({ manualOpen: false, manual: emptyDevice() });
    }

    private async removeDevice(device: TvDevice): Promise<void> {
        this.setDevices(this.configuredDevices.filter(entry => entry.id !== device.id));
        try {
            await this.command('forgetDeviceSecret', { id: device.id });
        } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        }
    }

    private async pair(device: TvDevice, pin?: string): Promise<void> {
        this.setState({ busy: true });
        try {
            const response = await this.command<PairResponse>('pair', { id: device.id, device, pin });
            if (!response.ok) {
                throw new Error(response.error || I18n.t('Pairing failed'));
            }
            if (response.needsPin) {
                this.setState({ pairDevice: device, pin: '' });
            } else {
                this.setState({ pairDevice: null, pin: '' });
                await this.refreshAdminState();
                this.showToast(I18n.t('Paired'));
            }
        } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        } finally {
            this.setState({ busy: false });
        }
    }

    private updateSetting(key: string, value: unknown): void {
        this.updateNativeValue(key, value);
    }

    private renderSettings(): React.ReactNode {
        const native = this.state.native;
        return (
            <Paper
                variant="outlined"
                sx={{ p: 2 }}
            >
                <Typography
                    variant="h6"
                    sx={{ mb: 1.5 }}
                >
                    {I18n.t('Settings')}
                </Typography>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(280px, 1fr))' },
                        gap: 2,
                    }}
                >
                    <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
                        <Typography
                            variant="subtitle1"
                            fontWeight={600}
                            sx={{ mb: 1.5 }}
                        >
                            {I18n.t('Scan schedule')}
                        </Typography>
                        <Stack spacing={1.5}>
                            <FormControlLabel
                                sx={{ m: 0, minHeight: 40 }}
                                control={
                                    <Checkbox
                                        checked={Boolean(native.autoScan)}
                                        onChange={event => this.updateSetting('autoScan', event.target.checked)}
                                    />
                                }
                                label={I18n.t('Auto scan')}
                            />
                            <TextField
                                fullWidth
                                size="small"
                                type="number"
                                disabled={!native.autoScan}
                                label={I18n.t('Auto scan interval')}
                                value={native.autoScanInterval ?? 300}
                                slotProps={{ htmlInput: { min: 30, step: 30 } }}
                                onChange={event => this.updateSetting('autoScanInterval', Number(event.target.value))}
                            />
                            <TextField
                                fullWidth
                                size="small"
                                type="number"
                                label={I18n.t('Poll interval')}
                                value={native.pollInterval ?? 30}
                                slotProps={{ htmlInput: { min: 10, step: 5 } }}
                                onChange={event => this.updateSetting('pollInterval', Number(event.target.value))}
                            />
                        </Stack>
                    </Box>
                    <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
                        <Typography
                            variant="subtitle1"
                            fontWeight={600}
                            sx={{ mb: 1.5 }}
                        >
                            {I18n.t('Discovery methods')}
                        </Typography>
                        <Stack spacing={0.5}>
                            <TextField
                                fullWidth
                                size="small"
                                type="number"
                                label={I18n.t('Discovery timeout')}
                                value={native.discoveryTimeout ?? 5}
                                slotProps={{ htmlInput: { min: 2, step: 1 } }}
                                onChange={event => this.updateSetting('discoveryTimeout', Number(event.target.value))}
                                sx={{ mb: 1 }}
                            />
                            <FormControlLabel
                                sx={{ m: 0, minHeight: 40 }}
                                control={
                                    <Checkbox
                                        checked={Boolean(native.enableSsdp)}
                                        onChange={event => this.updateSetting('enableSsdp', event.target.checked)}
                                    />
                                }
                                label={I18n.t('Enable SSDP')}
                            />
                            <FormControlLabel
                                sx={{ m: 0, minHeight: 40 }}
                                control={
                                    <Checkbox
                                        checked={Boolean(native.enableMdns)}
                                        onChange={event => this.updateSetting('enableMdns', event.target.checked)}
                                    />
                                }
                                label={I18n.t('Enable mDNS')}
                            />
                            <FormControlLabel
                                sx={{ m: 0, minHeight: 40 }}
                                control={
                                    <Checkbox
                                        checked={Boolean(native.enableWol)}
                                        onChange={event => this.updateSetting('enableWol', event.target.checked)}
                                    />
                                }
                                label={I18n.t('Enable Wake-on-LAN')}
                            />
                        </Stack>
                    </Box>
                </Box>
            </Paper>
        );
    }

    private renderDeviceTable(devices: TvDevice[], discovered: boolean): React.ReactNode {
        const visible = discovered ? devices.filter(device => !this.isConfigured(device)) : devices;
        return (
            <TableContainer
                component={Paper}
                variant="outlined"
            >
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{I18n.t('Name')}</TableCell>
                            <TableCell>{I18n.t('IP address')}</TableCell>
                            <TableCell>{I18n.t('Model')}</TableCell>
                            <TableCell>{I18n.t('API')}</TableCell>
                            <TableCell>{discovered ? I18n.t('Found via') : I18n.t('Paired')}</TableCell>
                            <TableCell align="right" />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {!visible.length && (
                            <TableRow>
                                <TableCell colSpan={6}>
                                    {I18n.t(discovered ? 'No discovered devices' : 'No added devices')}
                                </TableCell>
                            </TableRow>
                        )}
                        {visible.map(device => (
                            <TableRow
                                key={`${device.id}-${device.ip}`}
                                hover
                            >
                                <TableCell>
                                    {discovered ? (
                                        device.displayName || device.name || device.model
                                    ) : (
                                        <TextField
                                            size="small"
                                            variant="standard"
                                            value={device.name}
                                            onChange={event =>
                                                this.setDevices(
                                                    this.configuredDevices.map(entry =>
                                                        entry.id === device.id
                                                            ? { ...entry, name: sanitizeName(event.target.value) }
                                                            : entry,
                                                    ),
                                                )
                                            }
                                        />
                                    )}
                                </TableCell>
                                <TableCell>{device.ip}</TableCell>
                                <TableCell>{device.model || '-'}</TableCell>
                                <TableCell>{device.api}</TableCell>
                                <TableCell>
                                    {discovered ? (
                                        Array.isArray(device.source) ? (
                                            device.source.join(', ')
                                        ) : (
                                            device.source || '-'
                                        )
                                    ) : (
                                        <Chip
                                            size="small"
                                            color={this.state.paired[device.id] ? 'success' : 'default'}
                                            label={I18n.t(this.state.paired[device.id] ? 'Paired' : 'Not paired')}
                                        />
                                    )}
                                </TableCell>
                                <TableCell align="right">
                                    <Stack
                                        direction="row"
                                        spacing={0.5}
                                        justifyContent="flex-end"
                                    >
                                        {discovered ? (
                                            <Button
                                                size="small"
                                                startIcon={<AddIcon />}
                                                onClick={() => this.addDevice(device)}
                                            >
                                                {I18n.t('Add')}
                                            </Button>
                                        ) : (
                                            <>
                                                <Button
                                                    size="small"
                                                    startIcon={<LinkIcon />}
                                                    onClick={() => void this.pair(device)}
                                                >
                                                    {I18n.t('Pair')}
                                                </Button>
                                                <Button
                                                    color="error"
                                                    size="small"
                                                    startIcon={<DeleteOutlineIcon />}
                                                    onClick={() => void this.removeDevice(device)}
                                                >
                                                    {I18n.t('Remove')}
                                                </Button>
                                            </>
                                        )}
                                    </Stack>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        );
    }

    private renderManualDialog(): React.ReactNode {
        const device = this.state.manual;
        const set = (patch: Partial<TvDevice>): void => this.setState({ manual: { ...device, ...patch } });
        return (
            <Dialog
                open={this.state.manualOpen}
                onClose={() => this.setState({ manualOpen: false })}
                fullWidth
                maxWidth="md"
            >
                <DialogTitle>{I18n.t('Manual add')}</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, pt: 1 }}>
                        <TextField
                            required
                            label={I18n.t('Name')}
                            value={device.name}
                            onChange={event => set({ name: event.target.value })}
                        />
                        <TextField
                            required
                            label={I18n.t('IP address')}
                            value={device.ip}
                            onChange={event => set({ ip: event.target.value.trim() })}
                        />
                        <TextField
                            label={I18n.t('MAC address')}
                            value={device.mac}
                            onChange={event => set({ mac: event.target.value })}
                        />
                        <TextField
                            label={I18n.t('Model')}
                            value={device.model}
                            onChange={event => set({ model: event.target.value })}
                        />
                        <TextField
                            label={I18n.t('Device ID')}
                            value={device.id}
                            onChange={event => set({ id: event.target.value.trim() })}
                        />
                        <Select
                            value={device.api}
                            onChange={event => set({ api: event.target.value as TvApi })}
                        >
                            <MenuItem value="unknown">{I18n.t('Unknown')}</MenuItem>
                            <MenuItem value="tizen">Tizen</MenuItem>
                            <MenuItem value="hj">Samsung H/J</MenuItem>
                            <MenuItem value="legacy">Samsung TCP</MenuItem>
                        </Select>
                        <Select
                            value={device.protocol}
                            onChange={event => set({ protocol: event.target.value as TvProtocol })}
                        >
                            <MenuItem value="">{I18n.t('Unknown')}</MenuItem>
                            <MenuItem value="wss">WSS</MenuItem>
                            <MenuItem value="ws">WS</MenuItem>
                            <MenuItem value="tcp">TCP</MenuItem>
                        </Select>
                        <TextField
                            type="number"
                            label={I18n.t('Port')}
                            value={device.port || ''}
                            onChange={event => set({ port: Number(event.target.value) || 0 })}
                        />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => this.setState({ manualOpen: false })}>{I18n.t('Cancel')}</Button>
                    <Button
                        variant="contained"
                        disabled={!device.name || (!device.ip && !device.mac)}
                        onClick={() => this.addDevice(device)}
                    >
                        {I18n.t('Add device')}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    public override render(): React.JSX.Element {
        if (!this.state.loaded) {
            return (
                <StyledEngineProvider injectFirst>
                    <ThemeProvider theme={this.state.theme}>
                        <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', color: 'text.primary' }}>
                            <CircularProgress sx={{ m: 3 }} />
                        </Box>
                    </ThemeProvider>
                </StyledEngineProvider>
            );
        }
        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', color: 'text.primary', pb: 8 }}>
                        <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1500, mx: 'auto' }}>
                            <Stack
                                direction="row"
                                spacing={1.5}
                                alignItems="center"
                                sx={{ mb: 2 }}
                            >
                                <Box
                                    component="img"
                                    src="samsung.svg"
                                    alt="Samsung"
                                    sx={{ width: 84, maxHeight: 38 }}
                                />
                                <Typography variant="h5">{I18n.t('Samsung TV')}</Typography>
                            </Stack>
                            <Stack spacing={2}>
                                {this.renderSettings()}
                                <Box>
                                    <Stack
                                        direction="row"
                                        alignItems="center"
                                        justifyContent="space-between"
                                        sx={{ mb: 1 }}
                                    >
                                        <Box>
                                            <Typography variant="h6">{I18n.t('Discovery')}</Typography>
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                            >
                                                {I18n.t('Last scan')}:{' '}
                                                {this.state.lastScan
                                                    ? new Date(this.state.lastScan).toLocaleString()
                                                    : '-'}
                                            </Typography>
                                        </Box>
                                        <Button
                                            variant="contained"
                                            startIcon={
                                                this.state.busy ? (
                                                    <CircularProgress
                                                        size={16}
                                                        color="inherit"
                                                    />
                                                ) : (
                                                    <SearchIcon />
                                                )
                                            }
                                            disabled={this.state.busy}
                                            onClick={() => void this.scan()}
                                        >
                                            {I18n.t(this.state.busy ? 'Scanning' : 'Scan')}
                                        </Button>
                                    </Stack>
                                    {this.renderDeviceTable(this.state.discovered, true)}
                                </Box>
                                <Box>
                                    <Stack
                                        direction="row"
                                        alignItems="center"
                                        justifyContent="space-between"
                                        sx={{ mb: 1 }}
                                    >
                                        <Typography variant="h6">{I18n.t('Added TVs')}</Typography>
                                        <Button
                                            startIcon={<AddIcon />}
                                            onClick={() => this.setState({ manualOpen: true, manual: emptyDevice() })}
                                        >
                                            {I18n.t('Manual add')}
                                        </Button>
                                    </Stack>
                                    {this.renderDeviceTable(this.configuredDevices, false)}
                                </Box>
                                <Alert severity="info">{I18n.t('Stable identity note')}</Alert>
                            </Stack>
                        </Box>
                        {this.renderManualDialog()}
                        <Dialog
                            open={Boolean(this.state.pairDevice)}
                            onClose={() => this.setState({ pairDevice: null, pin: '' })}
                        >
                            <DialogTitle>{I18n.t('Enter PIN')}</DialogTitle>
                            <DialogContent>
                                <TextField
                                    autoFocus
                                    value={this.state.pin}
                                    onChange={event => this.setState({ pin: event.target.value })}
                                    sx={{ mt: 1 }}
                                />
                            </DialogContent>
                            <DialogActions>
                                <Button onClick={() => this.setState({ pairDevice: null, pin: '' })}>
                                    {I18n.t('Cancel')}
                                </Button>
                                <Button
                                    variant="contained"
                                    disabled={!this.state.pin}
                                    onClick={() =>
                                        this.state.pairDevice && void this.pair(this.state.pairDevice, this.state.pin)
                                    }
                                >
                                    {I18n.t('Pair')}
                                </Button>
                            </DialogActions>
                        </Dialog>
                        {this.renderSaveCloseButtons()}
                        {this.renderHelperDialogs()}
                    </Box>
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}

window.adapterName = 'samsungtv';
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
