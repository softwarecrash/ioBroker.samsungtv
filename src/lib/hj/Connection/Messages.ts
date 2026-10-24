/** Minimal shape of a message: its payload must be convertible to a string for matching */
export interface MessageLike {
    data: { toString(): string };
}

/** Selects a handler either by exact payload text or by a predicate on the payload text */
export type MessageMatcher = string | ((data: string) => boolean);

/** Handles a matched message; the return value resolves the promise returned by {@link Messages.handle} */
export type MessageHandler<TMessage extends MessageLike> = (message: TMessage) => unknown;

interface MessageType<TMessage extends MessageLike> {
    matcher: (data: string) => boolean;
    handler: MessageHandler<TMessage>;
}

/**
 *
 */
export class Messages<TMessage extends MessageLike = MessageLike> {
    public messageTypes: MessageType<TMessage>[];

    public constructor() {
        this.messageTypes = [];
    }

    /**
     *
     */
    public on(matcher: MessageMatcher, handler: MessageHandler<TMessage>): void {
        if (typeof handler !== 'function') {
            throw Error('Message handler must be a function');
        }
        const _matcher = this._matcherPredicate(matcher);

        this.messageTypes.push({
            matcher: _matcher,
            handler,
        });
    }

    public handle(message: TMessage): Promise<unknown> {
        const handle = this.messageTypes.find(messageHandler => messageHandler.matcher(message.data.toString()));
        if (!handle) {
            console.debug(`unknown message received: ${String(message.data)}`);
            return new Promise<void>(resolve => resolve());
        }

        const { handler } = handle;

        return new Promise((resolve, reject) => {
            try {
                const resolvedMessage = handler(message);
                resolve(resolvedMessage);
            } catch (err) {
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrows whatever the handler threw
                reject(err);
            }
        });
    }

    /**
     *
     */
    public _matcherPredicate(matcher: MessageMatcher): (data: string) => boolean {
        if (typeof matcher === 'string') {
            return data => data === matcher;
        }

        if (typeof matcher === 'function') {
            return matcher;
        }

        throw Error(`Incompatible matcher type: ${typeof matcher}`);
    }
}
