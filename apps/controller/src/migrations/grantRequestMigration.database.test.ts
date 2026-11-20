import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { suite, test } from 'node:test';

import pg from 'pg';

import { TEMPLATE_SETTINGS } from '../../testing/harness/database.js';
import {
	appliedMigrations,
	migrateDatabaseInProcess,
	openEmptyDatabase,
	selectRows,
} from '../../testing/fixtures/database.js';
import { canonicalJson, type Settings } from '../settings/index.js';

const SELF_GRANT_SETTING = 'selfGrantMaximumLifetimeSeconds';

const SELF_GRANT_DEFAULT_SECONDS = 86_400;

// The setting the grant operations migration adds, which the release at f7913299 did not hold.
const LATER_SETTING = 'grantRateThreshold';

// What the release at f7913299 seeded: every setting but the self-grant lifetime and the grant rate's threshold,
// the values the harness gives its fixed settings and the defaults for the rest.
const PRE_RELEASE_SETTINGS: Readonly<Partial<Settings>> = Object.fromEntries(
	Object.entries(TEMPLATE_SETTINGS).filter(([name]) => name !== SELF_GRANT_SETTING && name !== LATER_SETTING),
);

const settingsHeld = (owner: pg.ClientBase, schema: string) =>
	selectRows<{ name: string; value: unknown }>(
		owner,
		`SELECT name, value FROM ${pg.escapeIdentifier(schema)}.settings ORDER BY name`,
	);

const seedRowHeld = (owner: pg.ClientBase, schema: string) =>
	selectRows<{ content: unknown; digest: Buffer; seeded_at: string }>(
		owner,
		`SELECT content, digest, seeded_at::text FROM ${pg.escapeIdentifier(schema)}.settings_seed`,
	);

const seedingEvents = (owner: pg.ClientBase, schema: string) =>
	selectRows<{ data: { seededFrom: Record<string, string>; settings: Record<string, unknown> } }>(
		owner,
		`SELECT data FROM ${pg.escapeIdentifier(schema)}.audit_log WHERE type = 'bio.overture.settings.seeding' ORDER BY occurred_at, id`,
	);

suite('the grant requests migration on a store the release at f7913299 left', () => {
	test('applies to it, giving the new setting its default, changing no other setting or the seed row, and recording the setting as migration', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database, { target: '0008_settings' });
		const owner = await database.connect('migration');
		const schema = pg.escapeIdentifier(database.schema);

		await owner.query('BEGIN');
		await owner.query(
			`SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true)`,
		);
		// One connection runs one query at a time, so the inserts run in turn, each after the one before.
		await Object.entries(PRE_RELEASE_SETTINGS).reduce<Promise<unknown>>(
			(previous, [name, value]) =>
				previous.then(() =>
					owner.query(
						`INSERT INTO ${schema}.settings (name, value, changed_at) VALUES ($1, $2::jsonb, now())`,
						[name, JSON.stringify(value)],
					),
				),
			Promise.resolve(),
		);
		await owner.query(
			`INSERT INTO ${schema}.settings_seed (singleton, content, digest, seeded_at) VALUES (true, $1::jsonb, $2, now())`,
			[
				JSON.stringify(PRE_RELEASE_SETTINGS),
				createHash('sha256').update(canonicalJson(PRE_RELEASE_SETTINGS)).digest(),
			],
		);
		await owner.query('COMMIT');
		const before = await settingsHeld(owner, database.schema);
		const seedBefore = await seedRowHeld(owner, database.schema);

		await migrateDatabaseInProcess(database, { target: '0009_grant_requests' });
		const applied = (await appliedMigrations(owner)).map(({ name }) => name);
		const after = await settingsHeld(owner, database.schema);
		const seedAfter = await seedRowHeld(owner, database.schema);
		const events = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.equal(
			applied.some((name) => name.startsWith('0009_')),
			true,
		);
		assert.deepEqual(
			after.filter(({ name }) => name === SELF_GRANT_SETTING),
			[{ name: SELF_GRANT_SETTING, value: SELF_GRANT_DEFAULT_SECONDS }],
		);
		assert.deepEqual(
			after.filter(({ name }) => name !== SELF_GRANT_SETTING),
			before,
		);
		assert.deepEqual(seedAfter, seedBefore);
		assert.equal(events.length, 1);
		assert.deepEqual(events[0]?.data.settings, { [SELF_GRANT_SETTING]: SELF_GRANT_DEFAULT_SECONDS });
		assert.deepEqual(events[0]?.data.seededFrom, { [SELF_GRANT_SETTING]: 'migration' });
	});
});
