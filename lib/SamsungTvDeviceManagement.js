'use strict';

const path = require('node:path');
const { DeviceManagement } = require('@iobroker/dm-utils');

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const TV_ICON = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="#1689c9" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><rect x="2.5" y="4" width="19" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></g></svg>',
).toString('base64')}`;

function loadTranslations() {
    const translations = {};
    for (const language of LANGUAGES) {
        try {
            translations[language] = require(path.join('..', 'admin', 'i18n', `${language}.json`));
        } catch {
            translations[language] = {};
        }
    }
    return translations;
}

const translations = loadTranslations();

function t(key) {
    return Object.fromEntries(LANGUAGES.map(language => [language, translations[language][key] || key]));
}

function deviceForm(device = {}, options = {}) {
    const readOnlyIdentity = options.readOnlyIdentity === true;
    return {
        type: 'panel',
        items: {
            name: {
                type: 'text',
                label: t('Name'),
                default: device.name || '',
                xs: 12,
                sm: 6,
                validator: '!!data.name && /^[a-zA-Z0-9 _-]+$/.test(data.name)',
                validatorErrorText: t('Name validation error'),
                validatorNoSaveOnError: true,
            },
            ip: {
                type: 'text',
                label: t('IP address'),
                default: device.ip || '',
                disabled: readOnlyIdentity,
                validator: '!!data.ip || !!data.mac',
                validatorErrorText: t('IP or MAC required'),
                validatorNoSaveOnError: true,
                xs: 12,
                sm: 6,
            },
            mac: {
                type: 'text',
                label: t('MAC address'),
                default: device.mac || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            model: {
                type: 'text',
                label: t('Model'),
                default: device.model || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            id: {
                type: 'text',
                label: t('Device ID'),
                default: device.id || '',
                disabled: readOnlyIdentity,
                xs: 12,
                sm: 6,
            },
            api: {
                type: 'select',
                label: t('API'),
                default: device.api || 'unknown',
                options: [
                    { value: 'unknown', label: t('Automatic') },
                    { value: 'tizen', label: 'Tizen' },
                    { value: 'hj', label: 'Samsung H/J' },
                    { value: 'legacy', label: 'Samsung TCP' },
                ],
                xs: 12,
                sm: 6,
            },
            protocol: {
                type: 'select',
                label: t('Protocol'),
                default: device.protocol || '',
                options: [
                    { value: '', label: t('Automatic') },
                    { value: 'wss', label: 'WSS' },
                    { value: 'ws', label: 'WS' },
                    { value: 'tcp', label: 'TCP' },
                ],
                xs: 12,
                sm: 6,
            },
            port: {
                type: 'number',
                label: t('Port'),
                default: Number(device.port) || 0,
                min: 0,
                max: 65535,
                xs: 12,
                sm: 6,
            },
        },
    };
}

class SamsungTvDeviceManagement extends DeviceManagement {
    constructor(adapter, service) {
        super(adapter, true);
        this.service = service;
    }

    getInstanceInfo() {
        return {
            apiVersion: 'v3',
            communicationStateId: 'info.deviceManager',
            identifierLabel: 'ID',
            smallCards: true,
            actions: [
                {
                    id: 'discover',
                    icon: 'search',
                    title: t('Scan'),
                    description: t('Scan description'),
                    timeout: 120000,
                    handler: context => this.discover(context),
                },
                {
                    id: 'manual-add',
                    icon: 'add',
                    title: t('Manual add'),
                    description: t('Manual add description'),
                    handler: context => this.manualAdd(context),
                },
            ],
        };
    }

    async loadDevices(context) {
        const configured = this.service.getConfiguredDevices();
        const configuredIds = new Set(configured.map(device => device.id));
        const discovered = this.service
            .getDiscoveredDevices()
            .filter(device => !configuredIds.has(device.id) && !this.service.isConfigured(device));
        const devices = [
            ...configured.map(device => this.configuredDeviceInfo(device)),
            ...discovered.map(device => this.discoveredDeviceInfo(device)),
        ];
        context.setTotalDevices(devices.length);
        for (const device of devices) {
            context.addDevice(device);
        }
    }

    configuredDeviceInfo(device) {
        const namespace = this.adapter.namespace;
        const paired = this.service.isDevicePaired(device);
        const actions = [
            {
                id: 'rename',
                icon: 'rename',
                description: t('Rename'),
                handler: (id, context) => this.rename(id, context),
            },
            {
                id: 'delete',
                icon: 'delete',
                color: 'error',
                description: t('Remove'),
                confirmation: t('Remove confirmation'),
                handler: id => this.remove(id),
            },
        ];
        if (device.api === 'tizen' || device.api === 'hj' || device.api === 'unknown') {
            actions.unshift({
                id: 'pair',
                icon: paired ? 'unpairDevice' : 'pairDevice',
                description: t(paired ? 'Pair again' : 'Pair'),
                timeout: 120000,
                handler: (id, context) => this.pair(id, context),
            });
        }
        return {
            id: device.id,
            identifier: device.mac || device.uuid || device.id,
            name: device.displayName || device.name,
            icon: TV_ICON,
            manufacturer: 'Samsung',
            model: device.model || t('Unknown'),
            connectionType: device.mac ? 'lan' : 'other',
            status: {
                connection: {
                    stateId: `${namespace}.${device.name}.info.online`,
                    mapping: { true: 'connected', false: 'disconnected' },
                },
            },
            indicators: [
                {
                    id: 'paired',
                    value: { stateId: `${namespace}.${device.name}.info.paired` },
                    icon: 'unpairDevice',
                    iconOn: 'pairDevice',
                    color: 'inactive',
                    colorOn: 'ok',
                    text: paired ? t('Paired') : t('Not paired'),
                    tooltip: t('Pairing status'),
                    hideIfEmpty: false,
                },
            ],
            actions,
            hasDetails: true,
            group: { key: 'configured', name: t('Added TVs'), icon: TV_ICON },
        };
    }

    discoveredDeviceInfo(device) {
        return {
            id: device.id,
            identifier: device.mac || device.uuid || device.id,
            name: device.displayName || device.name || device.model || device.ip,
            icon: TV_ICON,
            manufacturer: 'Samsung',
            model: device.model || t('Unknown'),
            connectionType: device.mac ? 'lan' : 'other',
            status: 'connected',
            indicators: [
                {
                    id: 'discovered',
                    icon: 'search',
                    color: 'info',
                    text: t('Discovered'),
                    tooltip: t('Discovered device'),
                    hideIfEmpty: false,
                },
            ],
            actions: [
                {
                    id: 'add',
                    icon: 'add',
                    title: t('Add'),
                    variant: 'contained',
                    description: t('Add discovered TV'),
                    handler: (id, context) => this.addDiscovered(id, context),
                },
            ],
            hasDetails: true,
            group: { key: 'discovered', name: t('Discovered TVs'), icon: 'search' },
        };
    }

    getDeviceDetails(id) {
        const device = this.service.findDevice(id);
        if (!device) {
            return null;
        }
        return {
            id,
            schema: {
                type: 'panel',
                items: {
                    ip: { type: 'staticInfo', label: t('IP address'), data: device.ip || '-' },
                    mac: { type: 'staticInfo', label: t('MAC address'), data: device.mac || '-' },
                    model: { type: 'staticInfo', label: t('Model'), data: device.model || '-' },
                    api: { type: 'staticInfo', label: t('API'), data: device.api || 'unknown' },
                    protocol: { type: 'staticInfo', label: t('Protocol'), data: device.protocol || '-' },
                    source: {
                        type: 'staticInfo',
                        label: t('Found via'),
                        data: Array.isArray(device.source) ? device.source.join(', ') : device.source || '-',
                    },
                },
            },
        };
    }

    async discover(context) {
        try {
            const devices = await this.service.discover();
            const message = t(devices.length === 1 ? 'One TV found' : 'TVs found');
            await context.showMessage(
                Object.fromEntries(
                    LANGUAGES.map(language => [language, message[language].replace('%s', devices.length)]),
                ),
            );
            return { refresh: true };
        } catch (error) {
            await context.showMessage(this.errorMessage('Discovery failed', error));
            return { refresh: false };
        }
    }

    async manualAdd(context) {
        const data = await context.showForm(deviceForm(), {
            title: t('Manual add'),
            buttons: ['cancel', 'apply'],
        });
        if (!data) {
            return { refresh: false };
        }
        try {
            await this.service.addDevice(data);
            return { refresh: true };
        } catch (error) {
            await context.showMessage(this.errorMessage('Add failed', error));
            return { refresh: false };
        }
    }

    async addDiscovered(id, context) {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        const suggested = { ...device, name: this.service.suggestName(device) };
        const data = await context.showForm(deviceForm(suggested, { readOnlyIdentity: true }), {
            title: t('Add device'),
            buttons: ['cancel', 'apply'],
        });
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.service.addDevice({ ...device, ...data, id: device.id });
            return { refresh: 'devices' };
        } catch (error) {
            await context.showMessage(this.errorMessage('Add failed', error));
            return { refresh: 'none' };
        }
    }

    async rename(id, context) {
        const device = this.service.findDevice(id);
        if (!device) {
            return { refresh: 'devices' };
        }
        const data = await context.showForm(
            {
                type: 'panel',
                items: {
                    name: {
                        type: 'text',
                        label: t('Name'),
                        default: device.name,
                        validator: '!!data.name && /^[a-zA-Z0-9 _-]+$/.test(data.name)',
                        validatorErrorText: t('Name validation error'),
                        validatorNoSaveOnError: true,
                        xs: 12,
                    },
                },
            },
            { title: t('Rename'), buttons: ['cancel', 'apply'] },
        );
        if (!data) {
            return { refresh: 'none' };
        }
        try {
            await this.service.renameDevice(id, data.name);
            return { refresh: 'devices' };
        } catch (error) {
            await context.showMessage(this.errorMessage('Rename failed', error));
            return { refresh: 'none' };
        }
    }

    async remove(id) {
        await this.service.removeDevice(id);
        return { refresh: 'devices' };
    }

    async pair(id, context) {
        const device = this.service.findDevice(id);
        if (!device) {
            await context.showMessage(t('Unknown device'));
            return { refresh: 'devices' };
        }
        try {
            if (device.api === 'hj') {
                await this.service.requestPin(device);
                const data = await context.showForm(
                    {
                        type: 'panel',
                        items: {
                            pin: {
                                type: 'text',
                                label: t('Enter PIN'),
                                validator: '!!data.pin',
                                validatorNoSaveOnError: true,
                                xs: 12,
                            },
                        },
                    },
                    { title: t('Enter PIN'), buttons: ['cancel', 'apply'] },
                );
                if (!data) {
                    return { refresh: 'none' };
                }
                await this.service.confirmPin(device, String(data.pin));
            } else {
                await this.service.pairTizen(device);
            }
            await context.showMessage(t('Paired'));
            return { refresh: 'devices' };
        } catch (error) {
            await context.showMessage(this.errorMessage('Pairing failed', error));
            return { refresh: 'devices' };
        }
    }

    errorMessage(prefix, error) {
        const translated = t(prefix);
        const detail = error instanceof Error ? error.message : String(error);
        return Object.fromEntries(LANGUAGES.map(language => [language, `${translated[language]}: ${detail}`]));
    }
}

module.exports = { LANGUAGES, SamsungTvDeviceManagement, deviceForm, t };
