import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { readReadiness } from '../../test-support/admin.js';
import { jsonObjectOf } from '../../test-support/auditEvents.js';
import { captureLog, ENVIRONMENT_VARIABLES, type LogCapture } from '../../test-support/controller.js';
import { DATABASE_ROLES, USHER_SCHEMA } from '../../test-support/database.js';
import { appliedMigrations } from '../../test-support/fixtures/database.js';
import { type Harness, startHarness, takeSnapshot } from '../../test-support/harness.js';
import { inTurn, POLICY_TABLES, qualified } from '../../test-support/policy.js';
import { SCHEDULING_SLACK_MS } from '../../test-support/vendoredBridge.js';
import { cleanupFor, eventually } from '../../test-support/waiting.js';

const { schemaMigrations } = POLICY_TABLES;

/** The line naming the migrations a database records that the release does not know. */
const MIGRATION_UNKNOWN = 'schema.migrationUnknown';

/** The lines the Controller writes as its readiness changes. */
const READINESS_LINES = Object.freeze({
	lost: 'readiness.lost',
	restored: 'readiness.restored',
});

/** The phrase naming a recorded migration whose name is not in migration form. */
const NOT_IN_MIGRATION_FORM = 'a name not in migration form';

// The log stream's numbering of error, which the line naming unknown migrations is written at.
const ERROR_LEVEL = 50;

/** How long the Controller reuses one answer of the store's to readiness: a constant of its own. */
const STORE_PROBE_INTERVAL_MS = 1000;

// Long enough for readiness to probe the store again and answer, on a loaded machine.
const SETTLES_MS = 3 * STORE_PROBE_INTERVAL_MS + SCHEDULING_SLACK_MS;

// A migration of a later release, and a recorded name no release's migration has.
const LATER_RELEASE = '0999_later_release';

const OUT_OF_FORM = "Later Release'; DROP TABLE grants; --";

const LATER_CHECKSUM = 'e5'.repeat(32);

const CHANGED_CHECKSUM = 'f6'.repeat(32);

const RECORD = qualified(schemaMigrations);

const RUNTIME_ROLE = pg.escapeIdentifier(DATABASE_ROLES.runtime);

// A harness whose Controller has started, writing its lines to the log given, stopped once the test
// has ended.
const startedHarness = async (context: TestContext, log: LogCapture): Promise<Harness> => {
	const harness = await startHarness({
		applications: [],
		configuration: { logStream: log.stream },
	});
	cleanupFor(context).defer(() => harness.stop());
	return harness;
};

const recordMigration = async (client: pg.ClientBase, name: string, checksum: string): Promise<void> => {
	const { columns } = schemaMigrations;
	await client.query(`INSERT INTO ${RECORD} (${columns.name}, ${columns.checksum}) VALUES ($1, $2)`, [
		name,
		checksum,
	]);
};

const forgetMigration = async (client: pg.ClientBase, name: string): Promise<void> => {
	await client.query(`DELETE FROM ${RECORD} WHERE ${schemaMigrations.columns.name} = $1`, [name]);
};

// What a start threw, or nothing when it started.
const startFailure = (starting: Promise<void>): Promise<unknown> =>
	starting.then(
		() => undefined,
		(failure: unknown) => failure,
	);

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

// The lines written from a mark on that name unknown migrations or a change of readiness, each
// without its time.
const recordLines = (log: LogCapture, since: number = 0): readonly Readonly<Record<string, unknown>>[] =>
	log
		.lines()
		.slice(since)
		.map(jsonObjectOf)
		.filter(
			({ message }) =>
				message === MIGRATION_UNKNOWN ||
				message === READINESS_LINES.lost ||
				message === READINESS_LINES.restored,
		)
		.map(({ time: _time, ...line }) => line);

// Whether readiness answers the status given before the time it takes to settle has passed.
const turnsTo = (harness: Harness, status: number): Promise<boolean> =>
	eventually(async () => (await readReadiness(harness.url)).status === status, SETTLES_MS, 20);

suite("the controller's start over its database's record of applied migrations", () => {
	test("refuses to start while its database records a migration this release does not know, naming the schema's variable and each migration, one changed since it was applied as such and a name out of migration form by a fixed phrase, writing nothing and showing no checksum or recorded value", async (context) => {
		const log = captureLog();
		const harness = await startedHarness(context, log);
		const migration = harness.clients.migration;
		const first = (await appliedMigrations(migration))[0] ?? assert.fail('the record holds nothing');
		const firstName = first.name;
		await harness.stopController();
		await migration.query(
			`UPDATE ${RECORD} SET ${schemaMigrations.columns.checksum} = $1 WHERE ${schemaMigrations.columns.name} = $2`,
			[CHANGED_CHECKSUM, firstName],
		);
		await recordMigration(migration, LATER_RELEASE, LATER_CHECKSUM);
		await recordMigration(migration, OUT_OF_FORM, LATER_CHECKSUM);
		const before = await takeSnapshot(harness);
		const mark = log.lines().length;

		const refusal = await startFailure(harness.startController());

		assert.equal(
			messageOf(refusal),
			`the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseSchema} names a schema recording migrations this release does not know: ${firstName} (its checksum differs from this release's), ${LATER_RELEASE}, ${NOT_IN_MIGRATION_FORM}`,
		);
		assert.deepEqual(recordLines(log, mark), [
			{
				level: ERROR_LEVEL,
				message: MIGRATION_UNKNOWN,
				migrations: [
					{ checksumDiffers: true, name: firstName },
					{ name: LATER_RELEASE },
					{ name: NOT_IN_MIGRATION_FORM },
				],
				refused: 'start',
			},
		]);
		const shown = JSON.stringify([messageOf(refusal), log.lines()]);
		assert.deepEqual(
			[CHANGED_CHECKSUM, LATER_CHECKSUM, first.checksum, OUT_OF_FORM].filter((value) => shown.includes(value)),
			[],
		);
		assert.deepEqual(await takeSnapshot(harness), before);
	});

	test("refuses to start on a schema whose record of applied migrations the database role may not read, or holding none, naming the schema's variable and the schema migration command", async (context) => {
		const harness = await startedHarness(context, captureLog());
		const migration = harness.clients.migration;
		await harness.stopController();

		await migration.query(`REVOKE SELECT ON ${RECORD} FROM ${RUNTIME_ROLE}`);
		const unreadable = await startFailure(harness.startController());
		await migration.query(`DROP TABLE ${RECORD}`);
		const absent = await startFailure(harness.startController());

		assert.deepEqual([unreadable, absent].map(messageOf), [
			`the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseSchema} names a schema whose record of applied migrations, ${schemaMigrations.name}, the database role may not read: run the schema migration command, which grants the runtime role reading it`,
			`the controller refuses to start: ${ENVIRONMENT_VARIABLES.databaseSchema} names a schema holding no record of applied migrations, ${schemaMigrations.name}: run the schema migration command, which creates it`,
		]);
	});
});

suite("the controller's readiness over its database's record of applied migrations", () => {
	test('reports itself unready while its database records a migration this release does not know, writing schema.migrationUnknown once each time it turns unready for that reason, and ready again once it records none', async (context) => {
		const log = captureLog();
		const harness = await startedHarness(context, log);
		const migration = harness.clients.migration;
		const before = await readReadiness(harness.url);

		await recordMigration(migration, LATER_RELEASE, LATER_CHECKSUM);
		const unready = await turnsTo(harness, 503);
		const probedAgain = await inTurn([1, 2, 3], async () => {
			await delay(STORE_PROBE_INTERVAL_MS);
			return (await readReadiness(harness.url)).status;
		});
		await forgetMigration(migration, LATER_RELEASE);
		const ready = await turnsTo(harness, 200);
		await recordMigration(migration, LATER_RELEASE, LATER_CHECKSUM);
		const unreadyAgain = await turnsTo(harness, 503);
		await forgetMigration(migration, LATER_RELEASE);
		const readyAgain = await turnsTo(harness, 200);

		assert.equal(before.status, 200);
		assert.deepEqual(
			{ probedAgain, ready, readyAgain, unready, unreadyAgain },
			{
				probedAgain: [503, 503, 503],
				ready: true,
				readyAgain: true,
				unready: true,
				unreadyAgain: true,
			},
		);
		const turn = [
			{
				cause: 'migrationUnknown',
				level: 40,
				message: READINESS_LINES.lost,
			},
			{
				level: ERROR_LEVEL,
				message: MIGRATION_UNKNOWN,
				migrations: [{ name: LATER_RELEASE }],
				refused: 'readiness',
			},
			{ level: 30, message: READINESS_LINES.restored },
		];
		assert.deepEqual(recordLines(log), [...turn, ...turn]);
	});

	test('reports itself unready, naming the record unreadable, while the database role may not read the record of applied migrations or the schema holds none, and ready again once it can read one', async (context) => {
		const log = captureLog();
		const harness = await startedHarness(context, log);
		const migration = harness.clients.migration;
		const aside = pg.escapeIdentifier(`${schemaMigrations.name}_aside`);

		await migration.query(`REVOKE SELECT ON ${RECORD} FROM ${RUNTIME_ROLE}`);
		const unreadable = await turnsTo(harness, 503);
		await migration.query(`GRANT SELECT ON ${RECORD} TO ${RUNTIME_ROLE}`);
		const readable = await turnsTo(harness, 200);
		await migration.query(`ALTER TABLE ${RECORD} RENAME TO ${aside}`);
		const absent = await turnsTo(harness, 503);
		await migration.query(
			`ALTER TABLE ${pg.escapeIdentifier(USHER_SCHEMA)}.${aside} RENAME TO ${pg.escapeIdentifier(schemaMigrations.name)}`,
		);
		const present = await turnsTo(harness, 200);

		assert.deepEqual(
			{ absent, present, readable, unreadable },
			{ absent: true, present: true, readable: true, unreadable: true },
		);
		const turn = [
			{
				cause: 'migrationRecordUnreadable',
				level: 40,
				message: READINESS_LINES.lost,
			},
			{ level: 30, message: READINESS_LINES.restored },
		];
		assert.deepEqual(recordLines(log), [...turn, ...turn]);
	});
});
