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

// The settings this migration adds, each with its default.
const STEP_UP_DEFAULTS: Readonly<Record<string, unknown>> = {
	stepUpLevel: 'confirmation',
	stepUpWindowSeconds: 300,
};

const isStepUpSetting = (name: string): boolean => Object.hasOwn(STEP_UP_DEFAULTS, name);

// What a store seeded by the release before this one holds: every setting but the step-up's, with the
// values the harness gives them.
const BEFORE_STEP_UP: Readonly<Partial<Settings>> = Object.fromEntries(
	Object.entries(TEMPLATE_SETTINGS).filter(([name]) => !isStepUpSetting(name)),
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

suite('the step-up settings migration on a store the release before it left', () => {
	test('applies to it, giving both settings their defaults, changing no other setting or the seed row, and recording them as migration', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database, { target: '0019_creation_ids' });
		const owner = await database.connect('migration');
		const schema = pg.escapeIdentifier(database.schema);

		await owner.query('BEGIN');
		await owner.query(
			`SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true)`,
		);
		// One connection runs one query at a time, so the inserts run in turn, each after the one before.
		await Object.entries(BEFORE_STEP_UP).reduce<Promise<unknown>>(
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
			[JSON.stringify(BEFORE_STEP_UP), createHash('sha256').update(canonicalJson(BEFORE_STEP_UP)).digest()],
		);
		await owner.query('COMMIT');
		const before = await settingsHeld(owner, database.schema);
		const seedBefore = await seedRowHeld(owner, database.schema);

		await migrateDatabaseInProcess(database, { target: '0020_step_up_settings' });
		const applied = (await appliedMigrations(owner)).map(({ name }) => name);
		const after = await settingsHeld(owner, database.schema);
		const seedAfter = await seedRowHeld(owner, database.schema);
		const events = await seedingEvents(owner, database.schema);
		await owner.end();

		assert.equal(
			applied.some((name) => name.startsWith('0020_')),
			true,
		);
		assert.deepEqual(
			after.filter(({ name }) => isStepUpSetting(name)),
			Object.entries(STEP_UP_DEFAULTS).map(([name, value]) => ({ name, value })),
		);
		assert.deepEqual(
			after.filter(({ name }) => !isStepUpSetting(name)),
			before,
		);
		assert.deepEqual(seedAfter, seedBefore);
		assert.equal(events.length, 1);
		assert.deepEqual(events[0]?.data.settings, STEP_UP_DEFAULTS);
		assert.deepEqual(events[0]?.data.seededFrom, {
			stepUpLevel: 'migration',
			stepUpWindowSeconds: 'migration',
		});
	});
});
