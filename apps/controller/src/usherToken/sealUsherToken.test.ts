import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import { validatePayload } from '@overture-stack/usher-types';
import { compactDecrypt, decodeProtectedHeader } from 'jose';

import { applicationSubkeys, SUBKEY_LABELS } from '../applicationKeyRing/index.js';
import { sealUsherToken } from './sealUsherToken.js';
import type { VersionOnePayload } from './types.js';

const KEY_BYTES = randomBytes(32);

const KEY = applicationSubkeys(KEY_BYTES);

// A subkey as the Bridge derives it from an application key's bytes.
const bridgeSubkey = (label: string, keyBytes: Uint8Array = KEY_BYTES): Uint8Array =>
	new Uint8Array(hkdfSync('sha256', keyBytes, Buffer.alloc(0), label, 32));

// The Bridge's token key, derived under the label written here rather than read from the ring.
const TOKEN_SUBKEY = bridgeSubkey('usher/v1/token-encryption');

// A principal's payload holding values JSON must escape, in a subject and a resource identifier.
const SIGNED_IN: VersionOnePayload = {
	aud: 'arranger-test',
	exp: 1_767_225_900,
	generatedAt: 1_767_225_600,
	globalCategories: ['global.controlled'],
	iat: 1_767_225_600,
	iss: 'https://usher.example.org',
	payloadVersion: 1,
	permissions: {
		'étude « Nord » "A1"': {
			'global.controlled': { record: ['count'] },
			'global.unmarked': { record: ['count', 'view'] },
		},
	},
	resourceCategories: { 'étude « Nord » "A1"': [] },
	servedResources: ['étude « Nord » "A1"', 'STUDY-B2'],
	sub: 'subject "ana" \\  ',
};

const ANONYMOUS: VersionOnePayload = { ...SIGNED_IN, sub: null };

// How the Bridge's token reader decrypts: `dir` and A256GCM alone, and no decompression.
const DECRYPTION = {
	contentEncryptionAlgorithms: ['A256GCM'],
	keyManagementAlgorithms: ['dir'],
	maxDecompressedLength: 0,
};

const openedUnder = async (token: string, key: Uint8Array): Promise<unknown> =>
	JSON.parse(
		new TextDecoder('utf-8', { fatal: true }).decode((await compactDecrypt(token, key, DECRYPTION)).plaintext),
	) as unknown;

suite('sealing an Usher token', () => {
	test('gives a compact JWE whose protected header is exactly alg dir, enc A256GCM and typ usher+jwt, with no kid, zip or other member', async () => {
		const token = await sealUsherToken(SIGNED_IN, KEY);

		assert.deepEqual(decodeProtectedHeader(token), {
			alg: 'dir',
			enc: 'A256GCM',
			typ: 'usher+jwt',
		});
		assert.match(token, /^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/u);
	});

	test('draws a fresh 12-byte IV for every seal, so one payload sealed again repeats neither its IV nor its ciphertext', async () => {
		const tokens = await Promise.all(Array.from({ length: 16 }, () => sealUsherToken(SIGNED_IN, KEY)));

		const ivs = tokens.map((token) => token.split('.')[2] ?? '');
		const ciphertexts = tokens.map((token) => token.split('.')[3] ?? '');

		assert.deepEqual(
			ivs.map((iv) => Buffer.from(iv, 'base64url').length),
			Array.from({ length: 16 }, () => 12),
		);
		assert.equal(new Set(ivs).size, 16);
		assert.equal(new Set(ciphertexts).size, 16);
	});

	test("opens under the application's token subkey, as the bridge derives it, to the payload exactly, a null subject included", async () => {
		const opened = await Promise.all(
			[SIGNED_IN, ANONYMOUS].map(async (payload) =>
				openedUnder(await sealUsherToken(payload, KEY), TOKEN_SUBKEY),
			),
		);

		assert.deepEqual(opened, [SIGNED_IN, ANONYMOUS]);
		assert.deepEqual(
			opened.map((payload) => validatePayload(payload).success),
			[true, true],
		);
	});

	test("opens under no other key: neither the application key itself, nor any other subkey of it, nor another application's token subkey", async () => {
		const token = await sealUsherToken(SIGNED_IN, KEY);
		const otherKeys: readonly (readonly [string, Uint8Array])[] = [
			['the application key itself', new Uint8Array(KEY_BYTES)],
			...Object.entries(SUBKEY_LABELS)
				.filter(([use]) => use !== 'token')
				.map(([use, label]): readonly [string, Uint8Array] => [`the ${use} subkey`, bridgeSubkey(label)]),
			["another application's token subkey", bridgeSubkey('usher/v1/token-encryption', randomBytes(32))],
		];

		const refusals = await Promise.all(
			otherKeys.map(([description, key]) =>
				openedUnder(token, key).then(
					() => `${description} opened it`,
					(error: unknown) =>
						typeof error === 'object' && error !== null && 'code' in error ? error.code : error,
				),
			),
		);

		assert.deepEqual(
			refusals,
			otherKeys.map(() => 'ERR_JWE_DECRYPTION_FAILED'),
		);
		assert.equal(otherKeys.length, 6);
	});
});
