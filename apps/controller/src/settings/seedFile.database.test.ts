import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';

import type pg from 'pg';

import { canonicalJson } from './index.js';
import {
	migrateThroughCommand,
	schemaMigrationEnvironmentFor,
	spawnSchemaMigrationCommand,
} from '../../testing/harness/controller.js';
import { DATABASE_ROLES, type TestDatabase } from '../../testing/harness/database.js';
import { appliedMigrations, openEmptyDatabase } from '../../testing/fixtures/database.js';

const INFO_LEVEL = 30;

const WARNING_LEVEL = 40;

const ERROR_LEVEL = 50;

// The first run's file: a few members, the rest of the settings taking their defaults.
const FIRST_MEMBERS = {
	eventSource: 'https://usher.example.org/controller',
	firstUser: { realmRole: 'usher-first-user' },
	issuer: 'https://usher.example.org',
	noticePageLimit: 250,
	streamQueueLimit: 2000,
};

// A later file's text, written as given so its key order and whitespace are the test's own.
const writeSeedText = async (text: string): Promise<string> => {
	const folder = await mkdtemp(join(tmpdir(), 'usher-seed-later-'));
	const path = join(folder, 'seed.json');
	await writeFile(path, text);
	return path;
};

const migrateWith = (database: TestDatabase, seedFile: string): Promise<readonly unknown[]> =>
	migrateThroughCommand({
		databaseUrl: database.urlFor('migration'),
		runtimeRole: DATABASE_ROLES.runtime,
		schema: database.schema,
		seedFile,
	});

// The lines a run wrote, without their times, which no test can pin.
const withoutTimes = (lines: readonly unknown[]): readonly unknown[] =>
	lines.map((line) =>
		typeof line === 'object' && line !== null
			? Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'time'))
			: line,
	);

// A path holding a directory, so reading it fails with EISDIR, as a file the run cannot read does.
const unreadablePath = async (): Promise<string> => {
	const folder = await mkdtemp(join(tmpdir(), 'usher-seed-unreadable-'));
	const path = join(folder, 'seed.json');
	await mkdir(path);
	return path;
};

const storedSeedOf = async (owner: pg.ClientBase, schema: string) => {
	const { rows } = await owner.query<{ content: unknown; digest: Buffer; count: number }>(
		`SELECT content, digest, (SELECT count(*) FROM ${schema}.settings_seed)::int AS count FROM ${schema}.settings_seed`,
	);
	return rows;
};

const settingsOf = async (owner: pg.ClientBase, schema: string): Promise<unknown> => {
	const { rows } = await owner.query(`SELECT name, value, changed_by FROM ${schema}.settings ORDER BY name`);
	return rows;
};

suite('the seed file a first run reads, and a later run compares', () => {
	test("stores the seed file's own members, not the defaults filled in, with the SHA-256 of their canonical form as the digest, in one row", async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		const seedFile = await writeSeedText(JSON.stringify(FIRST_MEMBERS));

		await migrateWith(database, seedFile);

		const owner = await database.connect('migration');
		const rows = await storedSeedOf(owner, database.schema);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.count, 1);
		assert.deepEqual(rows[0]?.content, FIRST_MEMBERS);
		assert.deepEqual(rows[0]?.digest, createHash('sha256').update(canonicalJson(FIRST_MEMBERS)).digest());
	});

	test('writes one line at info, and changes nothing, on a later run whose file is identical to the first', async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		const first = await writeSeedText(JSON.stringify(FIRST_MEMBERS));
		await migrateWith(database, first);
		const owner = await database.connect('migration');
		const before = await settingsOf(owner, database.schema);

		const lines = await migrateWith(database, first);

		assert.deepEqual(withoutTimes(lines.slice(0, -1)), [
			{ level: INFO_LEVEL, message: 'settings.seedFileUnchanged', path: first },
		]);
		assert.deepEqual(await settingsOf(owner, database.schema), before);
	});

	test('writes one line at info, and changes nothing, on a later run whose file holds the same members in another key order and whitespace', async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		await migrateWith(database, await writeSeedText(JSON.stringify(FIRST_MEMBERS)));
		const owner = await database.connect('migration');
		const before = await settingsOf(owner, database.schema);
		const seedFile = await writeSeedText(
			'{\n\t"streamQueueLimit": 2000,\n\t"issuer": "https://usher.example.org",\n\t"noticePageLimit": 250,\n\t"firstUser": {"realmRole": "usher-first-user"},\n\t"eventSource": "https://usher.example.org/controller"\n}\n',
		);

		const lines = await migrateWith(database, seedFile);

		assert.deepEqual(withoutTimes(lines.slice(0, -1)), [
			{ level: INFO_LEVEL, message: 'settings.seedFileUnchanged', path: seedFile },
		]);
		assert.deepEqual(await settingsOf(owner, database.schema), before);
	});

	test('names each top-level key a later file changes, adds or removes, a structured key by its name alone, at warning, and never a value, changing nothing', async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		await migrateWith(database, await writeSeedText(JSON.stringify(FIRST_MEMBERS)));
		const owner = await database.connect('migration');
		const before = await settingsOf(owner, database.schema);
		const seedFile = await writeSeedText(
			JSON.stringify({
				eventSource: FIRST_MEMBERS.eventSource,
				firstUser: { realmRole: 'a-role-no-one-has' },
				grantAutoAccept: true,
				issuer: FIRST_MEMBERS.issuer,
				noticePageLimit: 314159,
			}),
		);

		const lines = await migrateWith(database, seedFile);

		assert.deepEqual(withoutTimes(lines.slice(0, -1)), [
			{
				added: ['grantAutoAccept'],
				changed: ['firstUser', 'noticePageLimit'],
				level: WARNING_LEVEL,
				message: 'settings.seedFileChanged',
				path: seedFile,
				removed: ['streamQueueLimit'],
			},
		]);
		assert.equal(JSON.stringify(lines).includes('a-role-no-one-has'), false);
		assert.equal(JSON.stringify(lines).includes('314159'), false);
		assert.deepEqual(await settingsOf(owner, database.schema), before);
	});

	test('refuses UPDATE, DELETE and TRUNCATE of the stored row, and a second row, for the schema migration role by its trigger, and the runtime role for lacking the privilege', async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		await migrateWith(database, await writeSeedText(JSON.stringify(FIRST_MEMBERS)));
		const table = `${database.schema}.settings_seed`;
		const insertSecond = `INSERT INTO ${table} (singleton, content, digest, seeded_at) VALUES (false, '{}', '\\x00', now())`;
		const attempts = [
			{ role: 'migration', statement: `UPDATE ${table} SET digest = digest`, refusal: /kept/u },
			{ role: 'migration', statement: `DELETE FROM ${table}`, refusal: /kept/u },
			{ role: 'migration', statement: `TRUNCATE ${table}`, refusal: /kept/u },
			{ role: 'migration', statement: insertSecond, refusal: /check constraint/u },
			{ role: 'runtime', statement: `UPDATE ${table} SET digest = digest`, refusal: /permission denied/u },
			{ role: 'runtime', statement: `DELETE FROM ${table}`, refusal: /permission denied/u },
			{ role: 'runtime', statement: `TRUNCATE ${table}`, refusal: /permission denied/u },
		] as const;

		const outcomes = [];
		for (const { role, statement, refusal } of attempts) {
			const client = await database.connect(role);
			const message = await client.query(statement).then(
				() => 'changed',
				(failure: Error) => failure.message,
			);
			outcomes.push({ matches: refusal.test(message), message: refusal.test(message) ? 'refused' : message });
		}

		assert.deepEqual(
			outcomes,
			attempts.map(() => ({ matches: true, message: 'refused' })),
		);
		const owner = await database.connect('migration');
		assert.equal((await storedSeedOf(owner, database.schema))[0]?.count, 1);
	});
});

suite('the seed file a run cannot read or parse', () => {
	test("refuses a first run whose seed file cannot be read, naming USHER_SEED_FILE with the system's reason, writing nothing, and writes one line at error with the path and the reason", async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		const seedFile = await unreadablePath();

		const answer = await spawnSchemaMigrationCommand(
			schemaMigrationEnvironmentFor({
				databaseUrl: database.urlFor('migration'),
				runtimeRole: DATABASE_ROLES.runtime,
				schema: database.schema,
				seedFile,
			}),
		);

		assert.notEqual(answer.exitCode, 0);
		const lines = answer.stdout
			.split('\n')
			.filter((line) => line !== '')
			.map((line): unknown => JSON.parse(line));
		assert.deepEqual(withoutTimes(lines), [
			{ level: ERROR_LEVEL, message: 'settings.seedFileUnreadable', path: seedFile, reason: 'EISDIR' },
		]);
		assert.match(answer.stderr, /USHER_SEED_FILE/u);
		assert.match(answer.stderr, /cannot be read \(EISDIR\)/u);
		assert.equal(answer.stderr.includes('illegal operation'), false);
		assert.deepEqual(await appliedMigrations(await database.connect('migration')), []);
	});

	test('writes one line at warning on a later run whose seed file cannot be read, succeeds, and changes neither the settings nor the stored seed', async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		await migrateWith(database, await writeSeedText(JSON.stringify(FIRST_MEMBERS)));
		const owner = await database.connect('migration');
		const before = await settingsOf(owner, database.schema);
		const seedBefore = await storedSeedOf(owner, database.schema);
		const seedFile = await unreadablePath();

		const lines = await migrateWith(database, seedFile);

		assert.deepEqual(withoutTimes(lines.slice(0, -1)), [
			{ level: WARNING_LEVEL, message: 'settings.seedFileUnreadable', path: seedFile, reason: 'EISDIR' },
		]);
		assert.deepEqual(await settingsOf(owner, database.schema), before);
		assert.deepEqual(await storedSeedOf(owner, database.schema), seedBefore);
	});

	test("writes one line at warning naming the problem on a later run whose seed file is not one JSON object, succeeds, changes nothing, and never names the file's content", async (context: TestContext) => {
		const database = await openEmptyDatabase(context);
		await migrateWith(database, await writeSeedText(JSON.stringify(FIRST_MEMBERS)));
		const owner = await database.connect('migration');
		const before = await settingsOf(owner, database.schema);
		const cases = [
			{ problem: 'is not JSON', text: 'not JSON, holding marker-value-41' },
			{ problem: 'is not one object of settings', text: '["marker-value-42"]' },
			{ problem: 'is not one object of settings', text: '42' },
		] as const;

		const outputs: string[] = [];
		for (const { problem, text } of cases) {
			const seedFile = await writeSeedText(text);

			const lines = await migrateWith(database, seedFile);

			assert.deepEqual(withoutTimes(lines.slice(0, -1)), [
				{ level: WARNING_LEVEL, message: 'settings.seedFileInvalid', path: seedFile, problem },
			]);
			outputs.push(JSON.stringify(lines));
		}
		assert.equal(
			outputs.some((output) => output.includes('marker-value')),
			false,
		);
		assert.deepEqual(await settingsOf(owner, database.schema), before);
	});
});
