'use strict';

const assert = require('node:assert/strict');
const { SamsungTvDeviceManagement, deviceForm, t } = require('./SamsungTvDeviceManagement');

function createManager(service = {}) {
    const manager = Object.create(SamsungTvDeviceManagement.prototype);
    manager.adapter = { namespace: 'samsungtv.0' };
    manager.service = {
        getConfiguredDevices: () => [],
        getDiscoveredDevices: () => [],
        isConfigured: () => false,
        isDevicePaired: () => false,
        findDevice: () => null,
        suggestName: () => 'tv',
        ...service,
    };
    return manager;
}

function createContext(formResult) {
    const messages = [];
    let progressClosed = 0;
    return {
        messages,
        devices: [],
        totals: [],
        get progressClosed() {
            return progressClosed;
        },
        setTotalDevices(total) {
            this.totals.push(total);
        },
        addDevice(device) {
            this.devices.push(device);
        },
        async showMessage(message) {
            messages.push(message);
        },
        async showForm() {
            return formResult;
        },
        async openProgress() {
            return {
                async close() {
                    progressClosed++;
                },
            };
        },
    };
}

describe('Samsung TV device management', () => {
    it('provides translated responsive forms with API and protocol selects', () => {
        const schema = deviceForm({ name: 'Living room', ip: '192.0.2.10' });
        assert.equal(schema.items.name.sm, 6);
        assert.equal(schema.items.api.type, 'select');
        assert.equal(schema.items.protocol.type, 'select');
        assert.equal(schema.items.ip.type, 'text');
        assert.equal(schema.items.api.options[0].label.de, 'Automatisch');
    });

    it('loads configured devices and hides already configured discoveries', async () => {
        const configured = { id: 'one', name: 'living-room', displayName: 'Living room', api: 'tizen' };
        const manager = createManager({
            getConfiguredDevices: () => [configured],
            getDiscoveredDevices: () => [configured, { id: 'two', name: 'Bedroom', ip: '192.0.2.11' }],
            isConfigured: device => device.id === 'one',
        });
        const context = createContext();

        await manager.loadDevices(context);

        assert.deepEqual(context.totals, [2]);
        assert.deepEqual(
            context.devices.map(device => device.id),
            ['one', 'two'],
        );
        assert.equal(context.devices[0].group.key, 'configured');
        assert.equal(context.devices[1].group.key, 'discovered');
    });

    it('returns the instance refresh contract after discovery', async () => {
        const manager = createManager({ discover: async () => [{ id: 'one' }, { id: 'two' }] });
        const context = createContext();

        const result = await manager.discover(context);

        assert.deepEqual(result, { refresh: true });
        assert.equal(context.progressClosed, 0);
        assert.equal(context.messages[0].en, '2 TVs found.');
    });

    it('adds a device from the manual form', async () => {
        let added;
        const manager = createManager({
            addDevice: async device => {
                added = device;
            },
        });
        const context = createContext({ name: 'Bedroom', ip: '192.0.2.12', api: 'tizen', protocol: 'wss' });

        const result = await manager.manualAdd(context);

        assert.deepEqual(result, { refresh: true });
        assert.equal(added.name, 'Bedroom');
    });

    it('runs the H/J PIN pairing sequence without exposing the PIN in messages', async () => {
        const calls = [];
        const device = { id: 'hj-one', name: 'bedroom', ip: '192.0.2.13', api: 'hj' };
        const manager = createManager({
            findDevice: () => device,
            requestPin: async value => calls.push(['request', value.id]),
            confirmPin: async (value, pin) => calls.push(['confirm', value.id, pin]),
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
        let paired;
        const manager = createManager({
            findDevice: () => device,
            pairTizen: async value => {
                paired = value.id;
            },
        });
        const context = createContext();

        const result = await manager.pair(device.id, context);

        assert.equal(paired, 'tizen-one');
        assert.deepEqual(result, { refresh: 'devices' });
        assert.equal(context.progressClosed, 0);
    });

    it('renames and removes configured devices through the service', async () => {
        const calls = [];
        const device = { id: 'one', name: 'living-room', api: 'tizen' };
        const manager = createManager({
            findDevice: () => device,
            renameDevice: async (id, name) => calls.push(['rename', id, name]),
            removeDevice: async id => calls.push(['remove', id]),
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
