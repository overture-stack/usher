import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'node:test';

import pg from 'pg';

import { TEMPLATE_SETTINGS } from '../../testing/harness/database.js';
import {
	migrateDatabase,
	migrateDatabaseInProcess,
	openEmptyDatabase,
	selectRows,
} from '../../testing/fixtures/database.js';

const SELF_GRANT_SETTING = 'selfGrantMaximumLifetimeSeconds';

const GRANT_RATE_SETTING = 'grantRateThreshold';

/** The names of every setting the store holds, in name order. */
const settingNames = (owner: pg.ClientBase, schema: string) =>
	selectRows<{ name: string }>(owner, `SELECT name FROM ${pg.escapeIdentifier(schema)}.settings ORDER BY name`).then(
		(rows) => rows.map(({ name }) => name),
	);

/** Every settings.seeding event the audit log holds, in the order it was recorded. */
const seedingEvents = (owner: pg.ClientBase, schema: string) =>
	selectRows<{ data: { seededFrom: Record<string, string>; settings: Record<string, unknown> } }>(
		owner,
		`SELECT data FROM ${pg.escapeIdentifier(schema)}.audit_log WHERE type = 'bio.overture.settings.seeding' ORDER BY occurred_at, id`,
	);

/** A seed file holding every setting but the named ones, which take their defaults. */
const seedFileWithout = async (omitted: readonly string[]): Promise<string> => {
	const folder = await mkdtemp(join(tmpdir(), 'usher-seed-'));
	const path = join(folder, 'seed.json');
	const members = Object.fromEntries(Object.entries(TEMPLATE_SETTINGS).filter(([name]) => !omitted.includes(name)));
	await writeFile(path, JSON.stringify(members));
	return path;
};

suite('seeding the settings, and recording what each setting was seeded from', () => {
	test('a first run to an earlier target seeds nothing, and the next full run seeds every setting', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database, { target: '0010_grant_operations' });
		const owner = await database.connect('migration');

		assert.deepEqual(await settingNames(owner, database.schema), []);
		assert.deepEqual(await seedingEvents(owner, database.schema), []);

		await migrateDatabaseInProcess(database);
		const names = await settingNames(owner, database.schema);
		const events = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.equal(names.length, Object.keys(TEMPLATE_SETTINGS).length);
		assert.ok(names.includes(SELF_GRANT_SETTING));
		assert.ok(names.includes(GRANT_RATE_SETTING));
		assert.equal(events.length, 1);
	});

	test("a first run on an empty store seeds the grant rate's threshold with its default, as any other setting", async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabase(database, { seedFile: await seedFileWithout([GRANT_RATE_SETTING]) });
		const owner = await database.connect('migration');
		const [threshold] = await selectRows<{ value: unknown }>(
			owner,
			`SELECT value FROM ${pg.escapeIdentifier(database.schema)}.settings WHERE name = $1`,
			[GRANT_RATE_SETTING],
		);
		const [event] = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.deepEqual(threshold, { value: { operationCount: 10, windowSeconds: 60 } });
		assert.equal(event?.data.seededFrom[GRANT_RATE_SETTING], 'default');
	});

	test('a later run that adds no setting records no settings.seeding event', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database);
		await migrateDatabaseInProcess(database);
		const owner = await database.connect('migration');
		const events = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.equal(events.length, 1);
	});

	test('a first run records each setting the seed file names as seedFile, and every other as default', async (context) => {
		const database = await openEmptyDatabase(context);
		const seedFile = await seedFileWithout([SELF_GRANT_SETTING, 'noticePageLimit']);
		await migrateDatabase(database, { seedFile });
		const owner = await database.connect('migration');
		const events = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.equal(events.length, 1);
		const [event] = events;
		assert.ok(event);
		const { seededFrom, settings } = event.data;
		assert.deepEqual(Object.keys(settings).sort(), Object.keys(TEMPLATE_SETTINGS).sort());
		assert.deepEqual(Object.keys(seededFrom).sort(), Object.keys(settings).sort());
		assert.equal(seededFrom[SELF_GRANT_SETTING], 'default');
		assert.equal(seededFrom['noticePageLimit'], 'default');
		assert.equal(seededFrom['issuer'], 'seedFile');
		assert.equal(seededFrom['firstUser'], 'seedFile');
	});
});
