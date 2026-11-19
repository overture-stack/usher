import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import pg from 'pg';

import { StartRefusal } from '../failures/index.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
import { keyFingerprint } from './keyFingerprint.js';
import type { StoreSettings } from './types.js';

const NOW = Date.UTC(2026, 10, 18, 9, 30);

const freshKey = (): string => randomBytes(32).toString('base64url');

const SETTINGS: Pick<StoreSettings, 'clock' | 'databaseSchema' | 'keyEncryptionKey'> = {
	clock: { now: () => NOW },
	databaseSchema: 'usher',
	keyEncryptionKey: freshKey(),
};

interface Sent {
	text: string;
	values: readonly unknown[];
}

const storeError = (code: string): pg.DatabaseError =>
	Object.assign(new pg.DatabaseError('refused', 0, 'error'), { code });

// A client that never connects, keeping each statement as sent: a read answers the rows given and a
// write answers none, unless each fails as given.
const storeHolding = (
	rows: readonly { fingerprint: Buffer }[],
	{ readFailure, writeFailure }: { readFailure?: unknown; writeFailure?: unknown } = {},
): { connection: pg.ClientBase; sent: Sent[] } => {
	const sent: Sent[] = [];
	const query = async (text: string, values: readonly unknown[] = []) => {
		sent.push({ text, values });
		const reads = text.startsWith('SELECT');
		const failure = reads ? readFailure : writeFailure;
		if (failure === undefined) {
			return { rows: reads ? rows : [] };
		}
		throw failure;
	};
	return { connection: Object.assign(new pg.Client(), { query }), sent };
};

const refusalOf = (connection: pg.ClientBase): Promise<unknown> =>
	checkKeyEncryptionKey(connection, SETTINGS).then(
		() => 'started',
		(failure: unknown) => failure,
	);

suite('checking the key-encryption key at the start', () => {
	test("records the key's fingerprint under the name keyEncryptionKey, at the time the clock reads, when the store holds none", async () => {
		const { connection, sent } = storeHolding([]);

		await checkKeyEncryptionKey(connection, SETTINGS);

		assert.deepEqual(
			sent.map(({ values }) => values),
			[['keyEncryptionKey'], ['keyEncryptionKey', keyFingerprint(SETTINGS.keyEncryptionKey), new Date(NOW)]],
		);
	});

	test("starts, writing nothing, when the fingerprint recorded under the name keyEncryptionKey is the key's own", async () => {
		const { connection, sent } = storeHolding([{ fingerprint: keyFingerprint(SETTINGS.keyEncryptionKey) }]);

		await checkKeyEncryptionKey(connection, SETTINGS);

		assert.deepEqual(
			sent.map(({ values }) => values),
			[['keyEncryptionKey']],
		);
	});

	test("refuses the start, naming the key's variable, when the recorded fingerprint is another key's or of another length", async () => {
		const recorded = [keyFingerprint(freshKey()), keyFingerprint(SETTINGS.keyEncryptionKey).subarray(0, 16)];

		const refusals = await Promise.all(
			recorded.map((fingerprint) => refusalOf(storeHolding([{ fingerprint }]).connection)),
		);

		assert.deepEqual(
			refusals.map((refusal) => (refusal instanceof StartRefusal ? refusal.variables : refusal)),
			[['USHER_KEY_ENCRYPTION_KEY'], ['USHER_KEY_ENCRYPTION_KEY']],
		);
	});

	test("refuses the start, naming the key's variable, when the store holds no fingerprint and the database role may not record one", async () => {
		const refusal = await refusalOf(storeHolding([], { writeFailure: storeError('42501') }).connection);

		assert.ok(refusal instanceof StartRefusal);
		assert.deepEqual(refusal.variables, ['USHER_KEY_ENCRYPTION_KEY']);
	});

	test("refuses the start, naming the schema's variable, when the schema holds no migrated store", async () => {
		const refusal = await refusalOf(storeHolding([], { readFailure: storeError('42P01') }).connection);

		assert.ok(refusal instanceof StartRefusal);
		assert.deepEqual(refusal.variables, ['USHER_DATABASE_SCHEMA']);
	});
});
