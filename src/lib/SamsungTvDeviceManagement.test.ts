/* eslint-disable @typescript-eslint/require-await -- the fakes mirror the async service and context APIs */
import assert from 'node:assert/strict';
import type { ActionContext, DeviceInfo, DeviceLoadContext } from '@iobroker/dm-utils';
import { describe, it } from 'mocha';
import { SamsungTvDeviceManagement, deviceForm, t, type ManagedDevice } from './SamsungTvDeviceManagement';

type TestContext = ActionContext &
    DeviceLoadContext<string> & {
        messages: Record<string, string>[];
        devices: DeviceInfo<string>[];
        totals: number[];
        readonly progressClosed: number;
    };

function createManager(service: Record<string, unknown> = {}): SamsungTvDeviceManagement {
    const manager = Object.create(SamsungTvDeviceManagement.prototype) as SamsungTvDeviceManagement;
    Object.assign(manager, { adapter: { namespace: 'samsungtv.0' } });
    manager.service = {
        getConfiguredDevices: () => [],
        getDiscoveredDevices: () => [],
        isConfigured: () => false,
        isDevicePaired: () => false,
        findDevice: () => null,
        suggestName: () => 'tv',
        getCapabilities: () => ({ inputs: {}, apps: {}, artMode: false }),
        ...service,
    } as unknown as SamsungTvDeviceManagement['service'];
    return manager;
}

function createContext(formResult?: Record<string, unknown>, confirmations: boolean[] = []): TestContext {
    const messages: Record<string, string>[] = [];
    const devices: DeviceInfo<string>[] = [];
    const totals: number[] = [];
    let progressClosed = 0;
    return {
        messages,
        devices,
        totals,
        get progressClosed() {
            return progressClosed;
        },
        setTotalDevices(total: number) {
            totals.push(total);
        },
        addDevice(device: DeviceInfo<string>) {
            devices.push(device);
        },
        async showMessage(message: ioBroker.StringOrTranslated) {
            messages.push(message as Record<string, string>);
        },
        async showForm() {
            return formResult;
        },
        // answers the questions in order, "no" once the list is used up
        async showConfirmation(message: ioBroker.StringOrTranslated) {
            messages.push(message as Record<string, string>);
            return confirmations.shift() ?? false;
        },
        async openProgress() {
            return {
                async close() {
                    progressClosed++;
                },
            };
        },
    } as unknown as TestContext;
}

describe('Samsung TV device management', () => {
    it('provides translated responsive forms with API and protocol selects', () => {
        const schema = deviceForm({ name: 'Living room', ip: '192.0.2.10' });
        assert.equal(schema.items.name.sm, 6);
        assert.equal(schema.items.api.type, 'select');
        assert.equal(schema.items.protocol.type, 'select');
        assert.equal(schema.items.ip.type, 'text');
        assert.equal((schema.items.api.options[0]?.label as Record<string, string>).de, 'Automatisch');
    });

    it('loads configured devices and hides already configured discoveries', async () => {
        const configured = { id: 'one', name: 'living-room', displayName: 'Living room', api: 'tizen' };
        const manager = createManager({
            getConfiguredDevices: () => [configured],
            getDiscoveredDevices: () => [configured, { id: 'two', name: 'Bedroom', ip: '192.0.2.11' }],
            isConfigured: (device: ManagedDevice) => device.id === 'one',
        });
        const context = createContext();

        await manager.loadDevices(context);

        assert.deepEqual(context.totals, [2]);
        assert.deepEqual(
            context.devices.map(device => device.id),
            ['one', 'two'],
        );
        assert.equal(context.devices[0]?.group?.key, 'configured');
        assert.equal(context.devices[1]?.group?.key, 'discovered');
    });

    it('returns the instance refresh contract after discovery', async () => {
        const manager = createManager({ discover: async () => [{ id: 'one' }, { id: 'two' }] });
        const context = createContext();

        const result = await manager.discover(context);

        assert.deepEqual(result, { refresh: true });
        assert.equal(context.progressClosed, 0);
        assert.equal(context.messages[0]?.en, '2 TVs found.');
    });

    it('adds a device from the manual form', async () => {
        let added: Record<string, unknown> | undefined;
        const manager = createManager({
            addDevice: async (device: Record<string, unknown>) => {
                added = { ...device, id: 'bedroom-id' };
                return added;
            },
            findDevice: () => added,
        });
        const context = createContext({ name: 'Bedroom', ip: '192.0.2.12', api: 'tizen', protocol: 'wss' });

        const result = await manager.manualAdd(context);

        assert.deepEqual(result, { refresh: true });
        assert.equal(added?.name, 'Bedroom');
        // the setup assistant asks for every step; all of them skipped here
        assert.deepEqual(
            context.messages.map(message => message.en),
            [t('Pair now?').en, t('Send a test key?').en, t('Set up the inputs now?').en, t('Setup done').en],
        );
    });

    it('pairs, tests and sets up the inputs with the setup assistant', async () => {
        const calls: unknown[][] = [];
        const device = { id: 'tizen-new', name: 'kitchen', ip: '192.0.2.20', api: 'tizen' };
        const manager = createManager({
            findDevice: () => device,
            pairTizen: async (value: ManagedDevice) => calls.push(['pair', value.id]),
            sendTestKey: async (value: ManagedDevice) => calls.push(['test', value.id]),
            getSourceMenu: () => [],
            setSourceMenu: async (value: ManagedDevice, menu: string) => calls.push(['inputs', value.id, menu]),
        });
        // pair: yes, test key: yes, seen on the TV: yes, inputs: yes
        const context = createContext({ sourceMenu: 'TV, HDMI2' }, [true, true, true, true]);

        await manager.setUp(device.id, context);

        assert.deepEqual(calls, [
            ['pair', 'tizen-new'],
            ['test', 'tizen-new'],
            ['inputs', 'tizen-new', 'TV, HDMI2'],
        ]);
        const texts = context.messages.map(message => message.en);
        // the hint comes before the TV asks
        assert.ok(texts.indexOf(t('Allow on the TV').en) < texts.indexOf(t('Paired').en));
        assert.equal(texts.at(-1), t('Setup done').en);
    });

    it('stops the setup assistant when pairing fails', async () => {
        const device = { id: 'tizen-new', name: 'kitchen', ip: '192.0.2.20', api: 'tizen' };
        let tested = false;
        const manager = createManager({
            findDevice: () => device,
            pairTizen: async () => {
                throw new Error('Pairing timeout');
            },
            sendTestKey: async () => {
                tested = true;
            },
        });
        const context = createContext(undefined, [true, true, true]);

        await manager.setUp(device.id, context);

        assert.equal(tested, false);
        assert.equal(context.messages.at(-1)?.en, `${t('Pairing failed').en}: Pairing timeout`);
    });

    it('runs the H/J PIN pairing sequence without exposing the PIN in messages', async () => {
        const calls: unknown[][] = [];
        const device = { id: 'hj-one', name: 'bedroom', ip: '192.0.2.13', api: 'hj' };
        const manager = createManager({
            findDevice: () => device,
            requestPin: async (value: ManagedDevice) => calls.push(['request', value.id]),
            confirmPin: async (value: ManagedDevice, pin: string) => calls.push(['confirm', value.id, pin]),
        });
        const context = createContext({ pin: '1234' });

        const result = await manager.pair(device.id, context);

        assert.deepEqual(calls, [
            ['request', 'hj-one'],
            ['confirm', 'hj-one', '1234'],
        ]);
        assert.deepEqual(result, { refresh: 'devices' });
        assert.equal(context.progressClosed, 0);
        assert.equal(JSON.stringify(context.messages).includes('1234'), false);
    });

    it('pairs Tizen devices and refreshes the device list', async () => {
        const device = { id: 'tizen-one', name: 'living-room', ip: '192.0.2.14', api: 'tizen' };
        let paired: string | undefined;
        const manager = createManager({
            findDevice: () => device,
            pairTizen: async (value: ManagedDevice) => {
                paired = value.id;
            },
        });
        const context = createContext();

        const result = await manager.pair(device.id, context);

        assert.equal(paired, 'tizen-one');
        assert.deepEqual(result, { refresh: 'devices' });
        assert.equal(context.progressClosed, 0);
    });

    it('validates and stores a manually entered Tizen token without exposing it in messages', async () => {
        const device = { id: 'tizen-two', name: 'bar', ip: '192.0.2.15', api: 'tizen' };
        let stored: string[] | undefined;
        const manager = createManager({
            findDevice: () => device,
            setTizenToken: async (value: ManagedDevice, token: string) => {
                stored = [value.id, token];
            },
        });
        const context = createContext({ token: '  12345678  ' });

        const result = await manager.setToken(device.id, context);

        assert.deepEqual(stored, ['tizen-two', '12345678']);
        assert.deepEqual(result, { refresh: 'devices' });
        assert.equal(JSON.stringify(context.messages).includes('12345678'), false);
        const actions = manager.configuredDeviceInfo(device).actions?.map(action => action.id);
        assert.deepEqual(actions, [
            'pair',
            'set-token',
            'test',
            'inputs',
            'rename',
            'delete',
            'power',
            'volume',
            'unmute',
        ]);
        const hjActions = manager.configuredDeviceInfo({ ...device, api: 'hj' }).actions?.map(action => action.id);
        assert.equal(hjActions?.includes('set-token'), false);
    });

    it('shows translated token validation errors without exposing the token', async () => {
        const device = { id: 'tizen-three', name: 'office', ip: '192.0.2.16', api: 'tizen' };
        const manager = createManager({
            findDevice: () => device,
            setTizenToken: async () => {
                throw new Error('Token rejected');
            },
        });
        const context = createContext({ token: 'secret-token' });

        const result = await manager.setToken(device.id, context);

        assert.deepEqual(result, { refresh: 'none' });
        assert.equal(
            context.messages[0]?.de,
            'Token konnte nicht gesetzt werden: Der Token ist ungültig oder wurde vom TV abgelehnt.',
        );
        assert.equal(JSON.stringify(context.messages).includes('secret-token'), false);
    });

    it('controls power, volume, mute, input, app and Art Mode from the device card', async () => {
        const calls: unknown[][] = [];
        const device = { id: 'frame', name: 'living-room', api: 'tizen' };
        const manager = createManager({
            getCapabilities: () => ({
                inputs: { TV: 'TV', HDMI2: 'HDMI 2' },
                apps: { YOUTUBE: 'YouTube' },
                artMode: true,
            }),
            control: async (value: ManagedDevice, control: string, state: unknown) =>
                calls.push([value.id, control, state]),
        });

        const controls = manager.configuredDeviceInfo(device).controls ?? [];

        assert.deepEqual(
            controls.map(control => [control.id, control.type, control.stateId]),
            [
                ['power', 'switch', 'samsungtv.0.living-room.control.power'],
                ['volume', 'slider', 'samsungtv.0.living-room.control.volume'],
                ['muted', 'switch', 'samsungtv.0.living-room.control.muted'],
                ['source', 'select', 'samsungtv.0.living-room.control.source'],
                ['launchApp', 'select', 'samsungtv.0.living-room.control.launchApp'],
                ['artMode', 'switch', 'samsungtv.0.living-room.control.artMode'],
            ],
        );
        assert.deepEqual(controls[3]?.options, [
            { label: 'TV', value: 'TV' },
            { label: 'HDMI 2', value: 'HDMI2' },
        ]);
        const volume = controls[1]!;
        const result = (await volume.handler!(device.id, 'volume', 25, undefined as never)) as ioBroker.State;
        assert.equal(result.val, 25);
        assert.deepEqual(calls, [['frame', 'volume', 25]]);

        // every control can report its current value, the card asks for it when it opens
        assert.ok(controls.every(control => typeof control.getStateHandler === 'function'));
        Object.assign(manager, {
            adapter: {
                namespace: 'samsungtv.0',
                getForeignStateAsync: async (id: string) =>
                    id === 'samsungtv.0.living-room.control.source' ? { val: 'HDMI2', ack: true } : null,
            },
        });
        const source = (await controls[3].getStateHandler!(device.id, 'source', undefined as never)) as ioBroker.State;
        assert.equal(source.val, 'HDMI2');
        const missing = (await controls[0]!.getStateHandler!(device.id, 'power', undefined as never)) as ioBroker.State;
        assert.equal(missing.val, null);
    });

    it('switches the TV on and off with a click on the power indicator', async () => {
        const calls: unknown[][] = [];
        const device = { id: 'frame', name: 'living-room', api: 'tizen' };
        let power: boolean | null = false;
        const manager = createManager({
            findDevice: () => device,
            control: async (value: ManagedDevice, control: string, state: unknown) =>
                calls.push([value.id, control, state]),
        });
        Object.assign(manager, {
            adapter: {
                namespace: 'samsungtv.0',
                getForeignStateAsync: async (id: string) =>
                    id === 'samsungtv.0.living-room.state.power' ? { val: power } : null,
            },
        });
        const info = manager.configuredDeviceInfo(device);
        assert.equal(info.indicators?.find(indicator => indicator.id === 'power')?.actionId, 'power');

        await manager.togglePower(device.id);
        power = true;
        await manager.togglePower(device.id);

        assert.deepEqual(calls, [
            ['frame', 'power', true],
            ['frame', 'power', false],
        ]);
    });

    it('reports a failed control as an error of the device card', async () => {
        const device = { id: 'frame', name: 'living-room', api: 'tizen' };
        const manager = createManager({
            control: async () => {
                throw new Error('The TV does not answer');
            },
        });
        const power = manager.configuredDeviceInfo(device).controls?.[0];
        const result = (await power!.handler!(device.id, 'power', true, undefined as never)) as {
            error: { message: string };
        };
        assert.equal(result.error.message, 'The TV does not answer');
    });

    it('renames and removes configured devices through the service', async () => {
        const calls: unknown[][] = [];
        const device = { id: 'one', name: 'living-room', api: 'tizen' };
        const manager = createManager({
            findDevice: () => device,
            renameDevice: async (id: string, name: string) => calls.push(['rename', id, name]),
            removeDevice: async (id: string) => calls.push(['remove', id]),
        });

        assert.deepEqual(await manager.rename(device.id, createContext({ name: 'Living room 2' })), {
            refresh: 'devices',
        });
        assert.deepEqual(await manager.remove(device.id), { refresh: 'devices' });
        assert.deepEqual(calls, [
            ['rename', 'one', 'Living room 2'],
            ['remove', 'one'],
        ]);
    });

    it('falls back to the key when a translation is unavailable', () => {
        assert.equal(t('Not a translation').en, 'Not a translation');
    });
});
