import type { SecretPayload } from '../../types';

export class SecretStore {
    private readonly payload: SecretPayload;

    public constructor(serialized: unknown) {
        this.payload = SecretStore.parse(serialized);
    }

    public hasTizenToken(deviceId: string, tokenAuthSupport?: boolean): boolean {
        const token = this.payload.tizen[deviceId];
        return Boolean(token && !(token === '__no_token__' && tokenAuthSupport));
    }

    public hasHjIdentity(deviceId: string): boolean {
        return Boolean(this.payload.hj[deviceId]);
    }

    public getTizenToken(deviceId: string): string {
        return this.payload.tizen[deviceId] ?? '';
    }

    public getHjIdentity(deviceId: string): unknown {
        return this.payload.hj[deviceId] ?? null;
    }

    public setTizenToken(deviceId: string, token: string): void {
        this.payload.tizen[deviceId] = token;
    }

    public setHjIdentity(deviceId: string, identity: unknown): void {
        this.payload.hj[deviceId] = identity;
    }

    public remove(deviceId: string): void {
        delete this.payload.tizen[deviceId];
        delete this.payload.hj[deviceId];
    }

    public serialize(): string {
        return JSON.stringify(this.payload);
    }

    public static parse(serialized: unknown): SecretPayload {
        if (typeof serialized !== 'string' || !serialized) {
            return { version: 1, tizen: {}, hj: {} };
        }
        try {
            const raw = JSON.parse(serialized) as Record<string, unknown>;
            return {
                version: 1,
                tizen: SecretStore.stringRecord(raw.tizen),
                hj: SecretStore.objectRecord(raw.hj),
            };
        } catch {
            return { version: 1, tizen: {}, hj: {} };
        }
    }

    private static stringRecord(value: unknown): Record<string, string> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
    }

    private static objectRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    }
}
