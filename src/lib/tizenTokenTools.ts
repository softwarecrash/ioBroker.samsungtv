/** Result of checking one Tizen channel message against the expected token */
export interface TizenTokenResult {
    accepted: boolean;
    error?: string;
}

/** The parts of a Tizen channel message that are inspected here; everything is untrusted input */
interface TizenChannelMessage {
    event?: unknown;
    data?: {
        token?: unknown;
        data?: {
            token?: unknown;
        };
    };
}

export function evaluateTizenTokenMessage(rawMessage: unknown, expectedToken: string): TizenTokenResult | null {
    if (!rawMessage || typeof rawMessage !== 'object') {
        return null;
    }
    const message = rawMessage as TizenChannelMessage;
    if (
        message.event === 'ms.channel.timeOut' ||
        message.event === 'ms.channel.unauthorized' ||
        message.event === 'ms.channel.error'
    ) {
        return { accepted: false, error: 'Token rejected' };
    }
    if (message.event === 'ms.error') {
        return { accepted: false, error: 'Token rejected' };
    }
    if (message.event !== 'ms.channel.connect' && message.event !== 'ms.channel.ready') {
        return null;
    }
    const returnedToken = message?.data?.token || message?.data?.data?.token || '';
    if (returnedToken && returnedToken !== expectedToken) {
        return { accepted: false, error: 'Token changed' };
    }
    return { accepted: true };
}
