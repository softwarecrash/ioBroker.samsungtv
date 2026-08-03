export type TvApi = 'unknown' | 'tizen' | 'hj' | 'legacy';
export type TvProtocol = '' | 'ws' | 'wss' | 'tcp';

export interface TvDevice {
    id: string;
    name: string;
    displayName?: string;
    ip: string;
    mac: string;
    model: string;
    api: TvApi;
    protocol: TvProtocol;
    port: number;
    uuid?: string;
    source?: string | string[];
    paired?: boolean;
}

export interface AdminStateResponse {
    ok: boolean;
    error?: string;
    devices: TvDevice[];
    discovered: TvDevice[];
    lastScan: number;
}

export interface PairResponse {
    ok: boolean;
    paired?: boolean;
    needsPin?: boolean;
    error?: string;
}
