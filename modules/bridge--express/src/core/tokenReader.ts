import { type NonEmpty, PAYLOAD_MEMBER_NAMES, PAYLOAD_VERSION, validatePayload } from '@overture-stack/usher-types';
import { compactDecrypt, decodeProtectedHeader, type JWTDecryptOptions, jwtDecrypt } from 'jose';

import type { Clock } from './clocks.js';
import type { TokenReader, TokenReading } from './core.js';
import type { BridgeEventData } from './events.js';
import type { CryptoKey } from './keys.js';

type TokenRejectionReason = BridgeEventData['token.rejection']['reason'];

const USHER_TOKEN_TYPE = 'usher+jwt';

/** The only protected header members allowed in an Usher token. */
const HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'enc', 'typ']);

/**
 * The most a token's `iat` can trail the Controller's clock when it is read: the Controller floors
 * its clock to whole seconds before it sets `iat`.
 */
const IAT_FLOOR_MS = 1_000;

/**
 * The checks both decryptions make, stated once: the key-management and content-encryption
 * algorithms allowed, and no decompression, which refuses a compressed token.
 */
const DECRYPTION_CHECKS = {
	contentEncryptionAlgorithms: ['A256GCM'],
	keyManagementAlgorithms: ['dir'],
	maxDecompressedLength: 0,
} satisfies JWTDecryptOptions;

/** jose's error codes, each mapped to a fixed reason code so no part of the error is passed on. */
const REASONS_BY_CODE: ReadonlyMap<unknown, TokenRejectionReason> = new Map([
	['ERR_JOSE_ALG_NOT_ALLOWED', 'algorithmNotAllowed'],
	['ERR_JOSE_NOT_SUPPORTED', 'headerUnsupported'],
	['ERR_JWE_DECRYPTION_FAILED', 'decryptionFailed'],
	['ERR_JWE_INVALID', 'tokenMalformed'],
	['ERR_JWT_CLAIM_VALIDATION_FAILED', 'claimRejected'],
	['ERR_JWT_EXPIRED', 'expired'],
	['ERR_JWT_INVALID', 'claimsNotObject'],
] as const);

/**
 * The validator for each readable payload version; a `Map`, so a `payloadVersion` named like an
 * `Object.prototype` member finds none.
 */
const READERS: ReadonlyMap<unknown, typeof validatePayload> = new Map([[PAYLOAD_VERSION, validatePayload]]);

/** Whether the default token reader holds a validator for payload version `version`. */
export const isReadablePayloadVersion = (version: number): boolean => READERS.has(version);

const rejected = (reason: TokenRejectionReason): TokenReading => ({
	kind: 'rejected',
	reason,
});

const protectedHeaderOf = (token: string): Readonly<Record<string, unknown>> | undefined => {
	try {
		return decodeProtectedHeader(token);
	} catch {
		return undefined;
	}
};

/** Why a protected header is refused before jose reads the token, or `undefined` when it is not. */
const headerRefusal = (header: Readonly<Record<string, unknown>> | undefined): TokenRejectionReason | undefined => {
	if (header === undefined) {
		return 'headerUnreadable';
	}
	if (header['typ'] !== USHER_TOKEN_TYPE) {
		return 'headerType';
	}
	return Object.keys(header).every((member) => HEADER_MEMBERS.has(member)) ? undefined : 'headerMember';
};

const ownValue = (error: unknown, member: string): unknown =>
	typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, member)?.value : undefined;

/**
 * Whether jose refused the `aud` value, read from the claim named by its claim-validation error. A
 * missing `aud` fails jose's presence check instead, as any missing member does, and stays
 * `claimRejected`.
 */
const isAudienceRefusal = (error: unknown): boolean =>
	ownValue(error, 'code') === 'ERR_JWT_CLAIM_VALIDATION_FAILED' &&
	ownValue(error, 'claim') === 'aud' &&
	ownValue(error, 'reason') === 'check_failed';

const reasonOf = (error: unknown): TokenRejectionReason =>
	isAudienceRefusal(error) ? 'audienceRejected' : (REASONS_BY_CODE.get(ownValue(error, 'code')) ?? 'unexpected');

/** What the default token reader needs. */
export interface TokenReaderOptions {
	audience: string;
	issuer: string;

	/** The payload versions accepted; a token of any other version is rejected. */
	payloadVersions: NonEmpty<number>;

	/** The application key's token subkey, derived for decryption alone. */
	tokenKey: CryptoKey;

	/**
	 * The clock for a token whose plaintext carries no finite numeric `iat`, which is then checked
	 * against the wall clock as before. A token that carries one is never read against this clock.
	 */
	wallClock: Clock;
}

/**
 * The latest the Controller's clock can be when a token is received, in milliseconds: its `iat`
 * plus the floor the Controller applied to it, plus the transit the token took to arrive.
 */
const controllerTimeAtReceiptMs = (iatSeconds: number, transitMs: number): number =>
	iatSeconds * 1000 + IAT_FLOOR_MS + transitMs;

/** The `iat`, in seconds, of a token whose plaintext is a JSON object with a finite numeric one. */
const issuedAtOf = (plaintext: Uint8Array): number | undefined => {
	try {
		const claims: unknown = JSON.parse(new TextDecoder().decode(plaintext));
		const iat = ownValue(claims, 'iat');
		return typeof iat === 'number' && Number.isFinite(iat) ? iat : undefined;
	} catch {
		return undefined;
	}
};

const readPayload = (
	payload: Readonly<Record<string, unknown>>,
	payloadVersions: readonly number[],
	transitMs: number,
): TokenReading => {
	const version = payload['payloadVersion'];
	const reader = payloadVersions.some((listed) => listed === version) ? READERS.get(version) : undefined;
	if (reader === undefined) {
		return rejected('payloadVersionUnlisted');
	}
	const result = reader(payload);
	return result.success
		? {
				kind: 'payload',
				payload: result.payload,
				remainingMs: result.payload.exp * 1000 - controllerTimeAtReceiptMs(result.payload.iat, transitMs),
			}
		: rejected('payloadMalformed');
};

/**
 * Creates the default token reader. Its `read` decrypts an Usher token with `tokenKey` and returns
 * the validated payload, with the time left on it, or a rejection carrying a fixed reason code and
 * nothing else: no error, message or payload content. `read` never throws.
 *
 * A token's `exp` is measured against the Controller's clock, not the Bridge's. The Controller sets
 * `iat` to its clock floored to whole seconds, so at receipt its clock is at most `iat` plus one
 * second plus the `transitMs` the token took to arrive. The reader takes that bound as the time, and
 * never a later one, so a token is never read as living longer than it does on the Controller's
 * clock. The Bridge's own clock can run ahead of or behind the Controller's, and the reader does
 * not read it: the bound is the only time the token is read against.
 *
 * Decryption runs twice. The bound needs `iat`, which is known only once the token is decrypted,
 * while jose decrypts and checks `exp` in one call against a `currentDate` given before it starts.
 * So the first decryption, with the same algorithms and no decompression as the second, is used for
 * nothing but the plaintext's `iat`, and the second checks the token against the bound. A plaintext with no
 * finite numeric `iat` is checked against the wall clock instead, so it is rejected with the reason
 * it always was. The `expired` reason means `exp` is at or before the bound, and the sign-in token's
 * own `exp` is the identity provider's clock, which the core reads against the Bridge's wall clock
 * with its local tolerance, outside this measurement.
 *
 * A token is rejected with:
 *
 * - `headerUnreadable` when its protected header cannot be read;
 * - `headerType` when its `typ` is not exactly `usher+jwt`;
 * - `headerMember` when its protected header carries a member other than `alg`, `enc` and `typ`,
 *   which includes `zip`, so a compressed token is refused before decryption;
 * - `algorithmNotAllowed` when it is not `dir` with A256GCM;
 * - `headerUnsupported` when it uses a feature unsupported by jose;
 * - `tokenMalformed` when it is not a well-formed compact JWE;
 * - `decryptionFailed` when it does not decrypt under `tokenKey`;
 * - `claimsNotObject` when its plaintext is not a JSON object;
 * - `audienceRejected` when its `aud` is not `audience`;
 * - `expired` when its `exp` is at or before the Controller's latest possible time at receipt;
 * - `claimRejected` for any other claim failure, such as an `iss` other than `issuer`, an `nbf` in
 *   the future or a missing payload member;
 * - `payloadVersionUnlisted` when its `payloadVersion` is not in `payloadVersions`, or has no
 *   validator;
 * - `payloadMalformed` when its payload fails validation;
 * - `unexpected` for any other failure.
 */
export const createTokenReader = ({
	audience,
	issuer,
	payloadVersions,
	tokenKey,
	wallClock,
}: TokenReaderOptions): TokenReader => {
	const decrypted = async (token: string, transitMs: number): Promise<TokenReading> => {
		try {
			// Both decryptions take `DECRYPTION_CHECKS`, the same algorithm allowlists and compression
			// refusal. The first's result is used for nothing but its `iat`; the second is the checked read.
			const { plaintext } = await compactDecrypt(token, tokenKey, DECRYPTION_CHECKS);
			const issuedAt = issuedAtOf(plaintext);
			const currentDate = new Date(
				issuedAt === undefined ? wallClock.now() : controllerTimeAtReceiptMs(issuedAt, transitMs),
			);
			const { payload } = await jwtDecrypt(token, tokenKey, {
				...DECRYPTION_CHECKS,
				audience,
				clockTolerance: 0,
				currentDate,
				issuer,
				requiredClaims: [...PAYLOAD_MEMBER_NAMES],
				typ: USHER_TOKEN_TYPE,
			});
			return readPayload(payload, payloadVersions, transitMs);
		} catch (error) {
			return rejected(reasonOf(error));
		}
	};

	return {
		read: async (token, { transitMs }) => {
			const refusal = headerRefusal(protectedHeaderOf(token));
			return refusal === undefined ? decrypted(token, transitMs) : rejected(refusal);
		},
	};
};
