export type TvApi = 'tizen' | 'hj' | 'legacy' | 'unknown';
export type TvTransport = 'ws' | 'wss' | 'tcp' | '';

export interface ConfiguredDevice {
    id: string;
    name: string;
    displayName: string;
    ip: string;
    mac: string;
    model: string;
    api: TvApi;
    protocol: TvTransport;
    port: number;
    uuid: string;
    source: string;
    renderingControlUrl?: string;
    renderingControlEventUrl?: string;
    tokenAuthSupport?: boolean;
    hjAvailable?: boolean;
}

export interface AdapterNativeConfig {
    schemaVersion: number;
    devices: unknown[];
    tokens: string;
    autoScan: boolean;
    autoScanInterval: number;
    discoveryTimeout: number;
    pollInterval: number;
    enableSsdp: boolean;
    enableMdns: boolean;
    enableWol: boolean;
    mdnsServices: string;
    migratedFromSamsung?: boolean;
}

export interface HjIdentity {
    aesKey: string;
    sessionId: string;
}

export interface SecretPayload {
    version: 1;
    tizen: Record<string, string>;
    hj: Record<string, unknown>;
}
