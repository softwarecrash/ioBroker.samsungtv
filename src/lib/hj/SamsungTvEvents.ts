export const SamsungTvEvents = {
    PAIRED: 'paired',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    DUID: 'duid',
} as const;

/** Name of an event emitted on the shared H/J event emitter */
export type SamsungTvEvent = (typeof SamsungTvEvents)[keyof typeof SamsungTvEvents];
