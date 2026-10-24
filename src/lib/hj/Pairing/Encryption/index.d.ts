/**
 * Typings for the vendored, untouched H/J pairing crypto in `index.js`.
 *
 * This file also keeps the vendored JavaScript out of the TypeScript program: tsc would otherwise
 * re-emit it with a `"use strict"` prologue, which breaks `asmcrypto.js` at load time.
 * The JavaScript files have to be copied verbatim next to the compiled code instead.
 */

/** Builds the step 1 `GeneratorServerHello` hex string for the given user ID and PIN */
export function generateServerHello(userId: string, pin: string): string;

/** Verifies the TV's step 1 `GeneratorClientHello` hex string; returns 0 on success, -1 otherwise */
export function parseClientHello(data: string): number;

/** Builds the step 2 `ServerAckMsg` hex string */
export function generateServerAcknowledge(): string;

/** Verifies the TV's step 2 `ClientAckMsg` hex string */
export function parseClientAcknowledge(data: string): boolean;

/** The negotiated AES key as hex string, or null before a successful {@link parseClientHello} */
export function getKey(): string | null;

/** Encrypts a JSON-serializable payload for the socket.io channel */
export function encryptData(
    aesKey: string,
    sessionKey: string | number,
    data: unknown,
): { body: string; Session_Id: number };

/** Decrypts a socket.io channel payload (a JSON array of bytes) to its JSON text */
export function decryptData(aesKey: string, data: string): string;
