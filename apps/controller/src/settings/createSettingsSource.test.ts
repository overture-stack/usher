import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import { createSettingsSource } from './createSettingsSource.js';
import type { HeldSettings } from './readStoredSettings.js';
import type { SignInTokenMaximumHistory } from './signInTokenMaximum.js';

interface StoredRow {
	name: string;
	value: unknown;
}

interface FakeStore {
	generation: string;
	failGeneration: { code: string } | undefined;
	history: readonly { recordedAt: number; value: unknown }[];
	rows: readonly StoredRow[];
	settingsReads: number;
}

const HELD_ROWS: readonly StoredRow[] = [
	{ name: 'backChannelLogout', value: true },
	{ name: 'eventSource', value: 'usher' },
	{ name: 'firstUser', value: { realmRole: 'usher-first-user' } },
	{ name: 'grantAutoAccept', value: false },
	{ name: 'grantRateThreshold', value: { operationCount: 10, windowSeconds: 60 } },
	{ name: 'heartbeatMilliseconds', value: 10000 },
	{ name: 'issuer', value: 'https://access.example.org/usher' },
	{ name: 'noticePageLimit', value: 500 },
	{ name: 'noticeRereadMilliseconds', value: 2000 },
	{ name: 'retentionGraceSeconds', value: 60 },
	{ name: 'retentionMarginSeconds', value: 30 },
	{ name: 'selfGrantMaximumLifetimeSeconds', value: 86400 },
	{ name: 'signInTokenMaximumLifetimeSeconds', value: 300 },
	{ name: 'streamLimitPerAudience', value: 64 },
	{ name: 'streamMaximumLifetimeSeconds', value: 900 },
	{ name: 'streamQueueLimit', value: 1000 },
	{ name: 'submitterCategory', value: 'global.unmarked' },
	{ name: 'tokenLifetimeSeconds', value: 300 },
];

const withRow = (name: string, value: unknown): readonly StoredRow[] =>
	HELD_ROWS.map((row) => (row.name === name ? { name, value } : row));

const HELD_MAXIMUMS: SignInTokenMaximumHistory = [{ recordedAt: 100, seconds: 300 }];

const storeWith = (rows: readonly StoredRow[] = HELD_ROWS, generation = '1'): FakeStore => ({
	failGeneration: undefined,
	generation,
	history: [{ recordedAt: 100, value: 300 }],
	rows,
	settingsReads: 0,
});

// The reader the source queries: the generation as one statement, the rows as another.
const readerOf = (store: FakeStore) => ({
	query: async <Row extends object>(text: string): Promise<{ rows: readonly Row[] }> => {
		if (text.includes('settings_generation')) {
			if (store.failGeneration !== undefined) {
				throw Object.assign(new Error('the store failed'), store.failGeneration);
			}
			return { rows: [{ generation: store.generation } as unknown as Row] };
		}
		if (text.includes('change_records')) {
			return {
				rows: store.history.map(({ recordedAt, value }) => ({
					recordedAt,
					value,
				})) as unknown as readonly Row[],
			};
		}
		store.settingsReads += 1;
		return { rows: store.rows as unknown as readonly Row[] };
	},
});

const HELD_SETTINGS: HeldSettings = {
	backChannelLogout: true,
	eventSource: 'usher',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRateThreshold: { operationCount: 10, windowSeconds: 60 },
	heartbeatMilliseconds: 10000,
	issuer: 'https://access.example.org/usher',
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
};

interface LogLine {
	fields: unknown;
	message: string;
}

const logOf = (): { lines: LogLine[]; log: { error: (message: string, fields?: unknown) => void } } => {
	const lines: LogLine[] = [];
	return {
		lines,
		log: {
			error: (message: string, fields?: unknown): void => {
				lines.push({ fields, message });
			},
		},
	};
};

// Advances the mocked interval, then lets every read it began settle.
const elapse = async (context: TestContext, milliseconds: number): Promise<void> => {
	context.mock.timers.tick(milliseconds);
	await new Promise((resolve) => setImmediate(resolve));
};

// Holds what the start read, then starts the source, with its timer on mocked time.
const startedSource = (context: TestContext, store: FakeStore) => {
	context.mock.timers.enable({ apis: ['setInterval'] });
	const { lines, log } = logOf();
	const source = createSettingsSource({ log, reader: readerOf(store), schema: 'usher' });
	source.hold(HELD_SETTINGS, '1', HELD_MAXIMUMS);
	source.start();
	return { lines, source };
};

suite('the settings source', () => {
	test('holds the settings the start read, without the grant rules', (context) => {
		const { source } = startedSource(context, storeWith());
		assert.deepEqual(source.current(), HELD_SETTINGS);
	});

	test('reads nothing while the generation is unchanged', async (context) => {
		const store = storeWith();
		const { source } = startedSource(context, store);
		await elapse(context, 6000);
		assert.equal(store.settingsReads, 0);
		await source.stop();
	});

	test('reads every setting but the grant rules when the generation changes on a tick', async (context) => {
		const store = storeWith(withRow('noticePageLimit', 250), '2');
		const { source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.equal(store.settingsReads, 1);
		assert.equal(source.current().noticePageLimit, 250);
		await source.stop();
	});

	test('keeps the last valid value of a row that breaks its rule, and writes a line naming the setting and its rule', async (context) => {
		const store = storeWith(withRow('noticePageLimit', 0), '2');
		const { lines, source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.equal(source.current().noticePageLimit, 500);
		assert.deepEqual(lines, [
			{
				fields: { rule: 'is not a whole number of at least 1', setting: 'noticePageLimit' },
				message: 'settings.storedInvalid',
			},
		]);
		await source.stop();
	});

	test('writes the line for an invalid row once per generation, and reads again only at the next generation', async (context) => {
		const store = storeWith(withRow('noticePageLimit', 0), '2');
		const { lines, source } = startedSource(context, store);
		await elapse(context, 2000);
		await elapse(context, 2000);
		assert.equal(lines.length, 1);
		assert.equal(store.settingsReads, 1);
		store.rows = withRow('noticePageLimit', 250);
		store.generation = '3';
		await elapse(context, 2000);
		assert.equal(source.current().noticePageLimit, 250);
		assert.equal(lines.length, 1);
		await source.stop();
	});

	test('never quotes a stored value in the line for an invalid row', async (context) => {
		const store = storeWith(withRow('submitterCategory', 'stored-value-not-quoted'), '2');
		const { lines, source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.equal(JSON.stringify(lines).includes('stored-value-not-quoted'), false);
		await source.stop();
	});

	test('writes settings.readFailed at error with the failure code, and keeps the settings held', async (context) => {
		const store = storeWith();
		store.failGeneration = { code: '57014' };
		const { lines, source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.deepEqual(lines, [{ fields: { code: '57014' }, message: 'settings.readFailed' }]);
		assert.deepEqual(source.current(), HELD_SETTINGS);
		await source.stop();
	});

	test('re-arms its timer at the new noticeRereadMilliseconds when that setting changes', async (context) => {
		const store = storeWith(withRow('noticeRereadMilliseconds', 500), '2');
		const { source } = startedSource(context, store);
		await elapse(context, 2000);
		const readsAtChange = store.settingsReads;
		store.generation = '3';
		await elapse(context, 500);
		assert.equal(store.settingsReads, readsAtChange + 1);
		await source.stop();
	});

	test('reads nothing once stopped', async (context) => {
		const store = storeWith(withRow('noticePageLimit', 250), '2');
		const { source } = startedSource(context, store);
		await source.stop();
		await elapse(context, 10000);
		assert.equal(store.settingsReads, 0);
	});

	test('keeps the grant rules out of the settings it holds', (context) => {
		const { source } = startedSource(context, storeWith());
		assert.equal(Object.hasOwn(source.current(), 'grantRules'), false);
	});

	test('holds the history of the sign-in token maximum the start read', (context) => {
		const { source } = startedSource(context, storeWith());
		assert.deepEqual(source.maximumHistory(), HELD_MAXIMUMS);
	});

	test('rereads the history of the sign-in token maximum with the settings when the generation changes', async (context) => {
		const store = storeWith();
		store.history = [
			{ recordedAt: 100, value: 300 },
			{ recordedAt: 1000, value: 600 },
		];
		store.generation = '2';
		const { source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.deepEqual(source.maximumHistory(), [
			{ recordedAt: 100, seconds: 300 },
			{ recordedAt: 1000, seconds: 600 },
		]);
		await source.stop();
	});

	test('keeps the held history, and writes a line naming the setting, when a history row breaks its rule', async (context) => {
		const store = storeWith();
		store.history = [{ recordedAt: 100, value: 0 }];
		store.generation = '2';
		const { lines, source } = startedSource(context, store);
		await elapse(context, 2000);
		assert.deepEqual(source.maximumHistory(), HELD_MAXIMUMS);
		assert.deepEqual(lines, [
			{
				fields: { rule: 'is not a whole number of at least 1', setting: 'signInTokenMaximumLifetimeSeconds' },
				message: 'settings.storedInvalid',
			},
		]);
		await source.stop();
	});
});
