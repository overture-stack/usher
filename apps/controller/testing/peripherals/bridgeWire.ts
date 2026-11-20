import { hkdfSync, randomUUID, webcrypto } from 'node:crypto';

import type { BridgeEventData, Clock } from '@overture-stack/usher-bridge--express';
import {
	isLiteralValue,
	type NonEmpty,
	type Notice,
	PAYLOAD_MEMBER_NAMES,
	PAYLOAD_VERSION,
	type PermissionsPayload,
	type PollAnswer,
	validateNotice,
	validatePayload,
	validatePollAnswer,
} from '@overture-stack/usher-types';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { compactDecrypt, decodeProtectedHeader, jwtDecrypt, SignJWT } from 'jose';

// Every export below reproduces the Bridge's side of the wire from its source,
// under modules/bridge--express/src/core/, or modules/types/src/ for what usher-types keeps internal,
// because those functions are not exported. Each TSDoc names the file and function it follows; a
// change there is a change to copy here.

type CryptoKey = webcrypto.CryptoKey;

/** A reason the token reader rejects an Usher token, as the Bridge logs it. */
export type TokenRejectionReason = BridgeEventData['token.rejection']['reason'];

/** A reason the channel reader refuses a notice or a poll answer, as the Bridge logs it. */
export type MalformedReason = BridgeEventData['revocationChannel.malformed']['reason'];

/**
 * The HKDF label of each subkey derived from the application key. Follows `keys.ts`
 * `SUBKEY_LABELS`.
 */
export const SUBKEY_LABELS: Readonly<{
	channelAssertion: string;
	notice: string;
	pollAnswer: string;
	subjectTag: string;
	token: string;
}> = Object.freeze({
	channelAssertion: 'usher/v1/channel-assertion',
	notice: 'usher/v1/notice-encryption',
	pollAnswer: 'usher/v1/poll-answer',
	subjectTag: 'usher/v1/subject-tag',
	token: 'usher/v1/token-encryption',
});

/**
 * The application key's subkeys as the Bridge holds them after start. Follows `keys.ts`
 * `ApplicationKeys`.
 */
export interface ApplicationKeys {
	/** Signs the channel assertion: HMAC-SHA256. */
	channelAssertionKey: CryptoKey;

	/** Decrypts pushed notices: AES-GCM. */
	noticeKey: CryptoKey;

	/** Decrypts poll answers: AES-GCM. */
	pollAnswerKey: CryptoKey;

	/** Tags a subject the way principal notices name it: HMAC-SHA256. */
	subjectTagKey: CryptoKey;

	/** Decrypts the Usher token: AES-GCM. */
	tokenKey: CryptoKey;
}

const CANONICAL_KEY = /^[A-Za-z0-9_-]{43}$/u;

const EMPTY_SALT = new Uint8Array(0);

const AES_GCM: webcrypto.AesKeyGenParams = { length: 256, name: 'AES-GCM' };

const HMAC_SHA256: webcrypto.HmacImportParams = {
	hash: 'SHA-256',
	length: 256,
	name: 'HMAC',
};

const keyBytes = (key: string): Buffer => {
	const bytes = Buffer.from(key, 'base64url');
	if (CANONICAL_KEY.test(key) && bytes.toString('base64url') === key) {
		return bytes;
	}

	throw new RangeError('the application key is 43 base64url characters in canonical form');
};

const hkdf = (label: string): webcrypto.HkdfParams => ({
	hash: 'SHA-256',
	info: new TextEncoder().encode(label),
	name: 'HKDF',
	salt: EMPTY_SALT,
});

/**
 * Imports an application key as the Bridge does at start: once, as an HKDF-SHA256 base key from
 * which each subkey derives under its label in {@link SUBKEY_LABELS}, with an empty salt, the token
 * key among them as AES-GCM for decryption. The application key itself decrypts and signs nothing.
 * Every key is non-extractable. Follows `keys.ts` `importApplicationKey`.
 *
 * @param key 43 base64url characters in canonical form.
 * @throws {RangeError} for any other value.
 */
export const importApplicationKey = async (key: string): Promise<ApplicationKeys> => {
	const bytes = keyBytes(key);
	try {
		const base = await webcrypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
		const derive = (
			label: string,
			algorithm: webcrypto.AesKeyGenParams | webcrypto.HmacImportParams,
			usage: webcrypto.KeyUsage,
		): Promise<CryptoKey> => webcrypto.subtle.deriveKey(hkdf(label), base, algorithm, false, [usage]);
		const [channelAssertionKey, noticeKey, pollAnswerKey, subjectTagKey, tokenKey] = await Promise.all([
			derive(SUBKEY_LABELS.channelAssertion, HMAC_SHA256, 'sign'),
			derive(SUBKEY_LABELS.notice, AES_GCM, 'decrypt'),
			derive(SUBKEY_LABELS.pollAnswer, AES_GCM, 'decrypt'),
			derive(SUBKEY_LABELS.subjectTag, HMAC_SHA256, 'sign'),
			derive(SUBKEY_LABELS.token, AES_GCM, 'decrypt'),
		]);

		return {
			channelAssertionKey,
			noticeKey,
			pollAnswerKey,
			subjectTagKey,
			tokenKey,
		};
	} finally {
		bytes.fill(0);
	}
};

/**
 * The bytes of a subkey derived from an application key as the Bridge derives each: HKDF-SHA256 over
 * the key's 32 bytes with an empty salt and the subkey's label, 32 bytes long. The Bridge's own keys
 * are non-extractable, so a test that must hold the bytes, to sign as the application or to read
 * under a key the Bridge never builds, derives them here. Follows `keys.ts` `importApplicationKey`.
 *
 * @param key the application key, 43 base64url characters.
 * @param label the subkey's label, from {@link SUBKEY_LABELS}.
 */
export const subkeyBytes = (key: string, label: string): Uint8Array =>
	new Uint8Array(hkdfSync('sha256', Buffer.from(key, 'base64url'), EMPTY_SALT, label, 32));

/**
 * The per-audience tag of a subject, as principal notices name it: HMAC-SHA256 of the subject under
 * the subject-tag subkey, encoded base64url without padding. Follows `keys.ts` `subjectTag`.
 *
 * @param keys the imported application key.
 * @param subject the subject the decrypted payload names.
 */
export const subjectTag = async (keys: ApplicationKeys, subject: string): Promise<string> =>
	Buffer.from(await webcrypto.subtle.sign('HMAC', keys.subjectTagKey, new TextEncoder().encode(subject))).toString(
		'base64url',
	);

/**
 * The audience every channel assertion names. Follows `channelAssertion.ts`
 * `CHANNEL_ASSERTION_AUDIENCE`.
 */
export const CHANNEL_ASSERTION_AUDIENCE = 'usher:controller';

/** The `typ` every channel assertion carries. Follows `channelAssertion.ts`. */
export const CHANNEL_ASSERTION_TYPE = 'usher-channel+jwt';

/** Seconds from a channel assertion's `iat` to its `exp`. Follows `channelAssertion.ts`. */
export const CHANNEL_ASSERTION_LIFETIME_S = 60;

/**
 * Creates a signer of channel assertions as the Bridge signs them: an HS256 JWS under the assertion
 * subkey, typed `usher-channel+jwt`, issued by the application for `usher:controller`, with a fresh
 * `jti` and an `exp` 60 s after its `iat`, and no `kid`. Follows `channelAssertion.ts`
 * `createChannelAssertion`.
 *
 * @param options the application's identifier, which is its audience; the assertion subkey; and the
 *   wall clock.
 */
export const createChannelAssertion = ({
	application,
	assertionKey,
	wallClock,
}: {
	application: string;
	assertionKey: CryptoKey;
	wallClock: Clock;
}): (() => Promise<string>) => {
	return () => {
		const issuedAt = Math.floor(wallClock.now() / 1000);
		return new SignJWT({})
			.setProtectedHeader({ alg: 'HS256', typ: CHANNEL_ASSERTION_TYPE })
			.setIssuer(application)
			.setAudience(CHANNEL_ASSERTION_AUDIENCE)
			.setIssuedAt(issuedAt)
			.setExpirationTime(issuedAt + CHANNEL_ASSERTION_LIFETIME_S)
			.setJti(randomUUID())
			.sign(assertionKey);
	};
};

/** What reading an Usher token resolves to. Follows `core.ts` `TokenReading`. */
export type TokenReading =
	{ kind: 'payload'; payload: PermissionsPayload } | { kind: 'rejected'; reason: TokenRejectionReason };

/** Reads an Usher token, from its header to the payload validator. Follows `core.ts` `TokenReader`. */
export interface TokenReader {
	read(token: string): Promise<TokenReading>;
}

/** What the token reader needs. Follows `tokenReader.ts` `TokenReaderOptions`. */
export interface TokenReaderOptions {
	audience: string;
	issuer: string;
	payloadVersions: NonEmpty<number>;

	/** The application key's token subkey, derived for decryption alone. */
	tokenKey: CryptoKey;

	wallClock: Clock;
}

const USHER_TOKEN_TYPE = 'usher+jwt';

const TOKEN_HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'enc', 'typ']);

const REASONS_BY_CODE: ReadonlyMap<unknown, TokenRejectionReason> = new Map([
	['ERR_JOSE_ALG_NOT_ALLOWED', 'algorithmNotAllowed'],
	['ERR_JOSE_NOT_SUPPORTED', 'headerUnsupported'],
	['ERR_JWE_DECRYPTION_FAILED', 'decryptionFailed'],
	['ERR_JWE_INVALID', 'tokenMalformed'],
	['ERR_JWT_CLAIM_VALIDATION_FAILED', 'claimRejected'],
	['ERR_JWT_EXPIRED', 'expired'],
	['ERR_JWT_INVALID', 'claimsNotObject'],
] as const);

const PAYLOAD_READERS: ReadonlyMap<unknown, typeof validatePayload> = new Map([[PAYLOAD_VERSION, validatePayload]]);

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

const ownValue = (error: unknown, member: string): unknown =>
	typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, member)?.value : undefined;

const isAudienceRefusal = (error: unknown): boolean =>
	ownValue(error, 'code') === 'ERR_JWT_CLAIM_VALIDATION_FAILED' &&
	ownValue(error, 'claim') === 'aud' &&
	ownValue(error, 'reason') === 'check_failed';

const reasonOf = (error: unknown): TokenRejectionReason =>
	isAudienceRefusal(error) ? 'audienceRejected' : (REASONS_BY_CODE.get(ownValue(error, 'code')) ?? 'unexpected');

const readPayload = (payload: Readonly<Record<string, unknown>>, payloadVersions: readonly number[]): TokenReading => {
	const version = payload['payloadVersion'];
	const reader = payloadVersions.some((listed) => listed === version) ? PAYLOAD_READERS.get(version) : undefined;
	if (reader === undefined) {
		return rejected('payloadVersionUnlisted');
	}
	const result = reader(payload);
	return result.success ? { kind: 'payload', payload: result.payload } : rejected('payloadMalformed');
};

/**
 * Creates a token reader that reads an Usher token as the Bridge does. Before jose reads anything,
 * `typ` must be exactly `usher+jwt` and the protected header may carry only `alg`, `enc` and `typ`.
 * `jwtDecrypt` then runs with `dir` and A256GCM alone, no decompression, every payload member
 * required, the audience and issuer pinned, and a clock tolerance of 0 against the wall clock; the
 * payload goes to usher-types' `validatePayload` when its `payloadVersion` is one listed. Every
 * failure becomes the reason code the Bridge logs. Follows `tokenReader.ts` `createTokenReader`.
 *
 * @param options the audience, issuer and payload versions, the token key, and the wall clock.
 */
export const createTokenReader = ({
	audience,
	issuer,
	payloadVersions,
	tokenKey,
	wallClock,
}: TokenReaderOptions): TokenReader => ({
	read: async (token) => {
		const header = protectedHeaderOf(token);
		if (header === undefined) {
			return rejected('headerUnreadable');
		}
		if (header['typ'] !== USHER_TOKEN_TYPE) {
			return rejected('headerType');
		}
		if (!Object.keys(header).every((member) => TOKEN_HEADER_MEMBERS.has(member))) {
			return rejected('headerMember');
		}
		try {
			const { payload } = await jwtDecrypt(token, tokenKey, {
				audience,
				clockTolerance: 0,
				contentEncryptionAlgorithms: ['A256GCM'],
				currentDate: new Date(wallClock.now()),
				issuer,
				keyManagementAlgorithms: ['dir'],
				maxDecompressedLength: 0,
				requiredClaims: [...PAYLOAD_MEMBER_NAMES],
				typ: USHER_TOKEN_TYPE,
			});
			return readPayload(payload, payloadVersions);
		} catch (error) {
			return rejected(reasonOf(error));
		}
	},
});

/** What reading a pushed notice resolves to. Follows `channelReader.ts` `NoticeReading`. */
export type NoticeReading = { kind: 'malformed'; reason: MalformedReason } | { kind: 'notice'; notice: Notice };

/** What reading a poll answer resolves to. Follows `channelReader.ts` `PollAnswerReading`. */
export type PollAnswerReading = { answer: PollAnswer; kind: 'answer' } | { kind: 'malformed'; reason: MalformedReason };

/**
 * Reads what the channel carries, from its header to the usher-types validator. Follows
 * `channelReader.ts` `ChannelReader`.
 */
export interface ChannelReader {
	readNotice(jwe: string): Promise<NoticeReading>;
	readPollAnswer(jwe: string): Promise<PollAnswerReading>;
}

/** What the channel reader needs. Follows `channelReader.ts` `ChannelReaderOptions`. */
export interface ChannelReaderOptions {
	/** Decrypts pushed notices: AES-GCM under the notice subkey. */
	noticeKey: CryptoKey;

	/** Decrypts poll answers: AES-GCM under the poll-answer subkey. */
	pollAnswerKey: CryptoKey;
}

/**
 * The notice versions the Bridge reads, listed on every push connection and every poll. Follows
 * `channelReader.ts` `NOTICE_VERSIONS`.
 */
export const NOTICE_VERSIONS: Readonly<NonEmpty<number>> = Object.freeze([1] as const);

/**
 * The request header listing the notice versions the Bridge reads, on the poll and the push alike.
 * Follows `poll.ts` `NOTICE_VERSIONS_HEADER`.
 */
export const NOTICE_VERSIONS_HEADER = 'usher-notice-versions';

const NOTICE_TYPE = 'usher-notice+jwt';

const POLL_ANSWER_TYPE = 'usher-poll+jwt';

const CHANNEL_HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'enc', 'typ']);

const PLAINTEXT = new TextDecoder('utf-8', { fatal: true });

const malformed = (reason: MalformedReason): { kind: 'malformed'; reason: MalformedReason } => ({
	kind: 'malformed',
	reason,
});

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null;

const namesUnlistedVersion = (value: unknown): boolean =>
	isObject(value) && Object.hasOwn(value, 'v') && !NOTICE_VERSIONS.some((listed) => listed === value['v']);

const decrypted = async (jwe: string, type: string, key: CryptoKey): Promise<{ value: unknown } | undefined> => {
	try {
		const header = decodeProtectedHeader(jwe);
		if (header.typ !== type || !Object.keys(header).every((member) => CHANNEL_HEADER_MEMBERS.has(member))) {
			return undefined;
		}
		const { plaintext } = await compactDecrypt(jwe, key, {
			contentEncryptionAlgorithms: ['A256GCM'],
			keyManagementAlgorithms: ['dir'],
			maxDecompressedLength: 0,
		});
		return { value: JSON.parse(PLAINTEXT.decode(plaintext)) as unknown };
	} catch {
		return undefined;
	}
};

/**
 * A compact JWE's plaintext as UTF-8 text, decrypted as the Bridge's channel reader decrypts a notice
 * or a poll answer: `dir` and A256GCM alone, no decompression, the plaintext decoded as strict UTF-8.
 * No header member is checked and nothing is validated, so a test can read what was written before
 * the Bridge's reader judges it. Follows `channelReader.ts` `createChannelReader`, its decryption.
 *
 * @param jwe the compact JWE.
 * @param key the key it should open under, such as a notice or poll-answer subkey.
 * @throws when it does not open under that key, or its plaintext is not UTF-8.
 */
export const plaintextOf = async (jwe: string, key: CryptoKey | Uint8Array): Promise<string> => {
	const { plaintext } = await compactDecrypt(jwe, key, {
		contentEncryptionAlgorithms: ['A256GCM'],
		keyManagementAlgorithms: ['dir'],
		maxDecompressedLength: 0,
	});
	return PLAINTEXT.decode(plaintext);
};

/**
 * Creates a channel reader that reads a pushed notice or a poll answer as the Bridge does: `typ`
 * exactly `usher-notice+jwt` or `usher-poll+jwt` and only `alg`, `enc` and `typ` in the protected
 * header, then `compactDecrypt` under each one's own subkey with `dir` and A256GCM alone and no
 * decompression, then usher-types' `validateNotice` or `validatePollAnswer`. A notice in a version
 * not listed in {@link NOTICE_VERSIONS}, alone or inside a poll answer, is `versionUnlisted`; every
 * other failure is `noticeUnreadable` or `answerUnreadable`. Follows `channelReader.ts`
 * `createChannelReader`.
 *
 * @param options the notice and poll-answer subkeys.
 */
export const createChannelReader = ({ noticeKey, pollAnswerKey }: ChannelReaderOptions): ChannelReader => ({
	readNotice: async (jwe) => {
		const read = await decrypted(jwe, NOTICE_TYPE, noticeKey);
		if (read === undefined) {
			return malformed('noticeUnreadable');
		}
		if (namesUnlistedVersion(read.value)) {
			return malformed('versionUnlisted');
		}
		const result = validateNotice(read.value);
		return result.success ? { kind: 'notice', notice: result.notice } : malformed('noticeUnreadable');
	},

	readPollAnswer: async (jwe) => {
		const read = await decrypted(jwe, POLL_ANSWER_TYPE, pollAnswerKey);
		if (read === undefined) {
			return malformed('answerUnreadable');
		}
		const notices =
			isObject(read.value) && Object.hasOwn(read.value, 'notices') ? read.value['notices'] : undefined;
		if (Array.isArray(notices) && notices.some(namesUnlistedVersion)) {
			return malformed('versionUnlisted');
		}
		const result = validatePollAnswer(read.value);
		return result.success ? { answer: result.answer, kind: 'answer' } : malformed('answerUnreadable');
	},
});

/**
 * The most characters the parser buffers across chunks before the stream is malformed. Follows
 * `push.ts` `PUSH_BUFFER_CHARACTERS`.
 */
export const PUSH_BUFFER_CHARACTERS: number = 64 * 1024;

/** What one read of a notice stream's body gives. */
export type EventStreamRead =
	{ events: readonly EventSourceMessage[]; kind: 'events' } | { kind: 'ended' } | { kind: 'overflow' };

/** Reads a notice stream's body chunk by chunk, as the Bridge's push does. */
export interface EventStreamReader {
	/** Cancels the body, settling once it is cancelled. */
	cancel(): Promise<void>;

	/**
	 * Reads one chunk: the events it completed, in order and possibly none; `ended` once the body
	 * ends; or `overflow` once the parser would buffer more than {@link PUSH_BUFFER_CHARACTERS}.
	 */
	read(): Promise<EventStreamRead>;
}

/**
 * Creates a reader of `GET /notices/stream`'s body as the Bridge's push reads it: each chunk decoded
 * as streamed UTF-8 and fed to eventsource-parser with a `maxBufferSize` of
 * {@link PUSH_BUFFER_CHARACTERS}, an overflow ending the stream as malformed. Follows `push.ts`
 * `createPush`, its `read`.
 *
 * @param body the response body.
 */
export const createEventStreamReader = (body: ReadableStream<Uint8Array>): EventStreamReader => {
	const pending: EventSourceMessage[] = [];
	const overflow = { seen: false };
	const parser = createParser({
		maxBufferSize: PUSH_BUFFER_CHARACTERS,
		onError: (error) => {
			if (error.type === 'max-buffer-size-exceeded') {
				overflow.seen = true;
			}
		},
		onEvent: (event) => pending.push(event),
	});
	const decoder = new TextDecoder();
	const reader = body.getReader();

	return {
		cancel: () => reader.cancel(),

		read: async () => {
			const { done, value } = await reader.read();
			if (done) {
				return { kind: 'ended' };
			}
			parser.feed(decoder.decode(value, { stream: true }));
			if (overflow.seen) {
				return { kind: 'overflow' };
			}
			return { events: pending.splice(0), kind: 'events' };
		},
	};
};

/**
 * Whether a value can name a resource in the payload contract: a non-empty string other than
 * `__proto__`, holding no marker Arranger reads specially. Follows `modules/types/src/sqonPrimitives.ts`
 * `isUsableResource`, which usher-types does not export, on its exported `isLiteralValue`.
 *
 * @param value any value.
 */
export const isUsableResource = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value !== '__proto__' && isLiteralValue(value);
