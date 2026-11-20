import { createHash } from 'node:crypto';

import pg from 'pg';

import { createAuditTrail, type EventLog, type JsonValue, type TrailConnection } from '../eventLog/index.js';
import { canonicalJson, type Settings } from '../settings/index.js';
import type { MigrationOptions } from './types.js';

// The instance a seeding event names: the run's own, since no instance serves a migration.
const SEEDING_INSTANCE = 'schemaMigration';

// The seeding is bounded by the command's own limit on connecting and signing in, as its one bound.
const SEEDING_TIMEOUT_MILLISECONDS = 30_000;

/** Where a setting's value came from: the seed file a first run read, its default, or the migration that added it. */
export type SettingOrigin = 'default' | 'migration' | 'seedFile';

/** What a seeding event is written under: the clock, the log, the schema, and the event source it names. */
interface SeedingTrailOptions {
	clock: MigrationOptions['clock'];
	eventLog: Pick<EventLog, 'error' | 'writeEvent'>;
	eventSource: string;
	schema: string;
}

/** What seeding writes: the schema, every setting's value, the seed file's members and the event's log. */
interface SeedingOptions extends Omit<SeedingTrailOptions, 'eventSource'> {
	members: Readonly<Record<string, unknown>>;
	settings: Settings;
}

// One row per setting, each stamped with the moment of seeding, which names no actor.
const insertText = (schema: string, count: number): string =>
	`INSERT INTO ${pg.escapeIdentifier(schema)}.settings (name, value, changed_at) VALUES ${Array.from(
		{ length: count },
		(_, index) => `($${index * 2 + 1}, $${index * 2 + 2}::jsonb, now())`,
	).join(', ')}`;

// The audit trail a seeding writes its event through, as the system, on the schema migration role's connection.
const seedingTrail = (client: pg.Client, { clock, eventLog, eventSource, schema }: SeedingTrailOptions) => {
	const connection: TrailConnection = {
		query: (text, values) => client.query(text, values === undefined ? undefined : [...values]),
		release: () => undefined,
	};
	return createAuditTrail({
		eventLog,
		settings: {
			clock,
			databaseSchema: schema,
			eventSource,
			instanceName: SEEDING_INSTANCE,
			storeTimeoutMilliseconds: SEEDING_TIMEOUT_MILLISECONDS,
		},
		store: { connect: () => Promise.resolve(connection) },
	});
};

/**
 * Seeds every setting in one transaction the audit trail records as the system, stores the seed file's members
 * with their digest as the one seed row, and records the `settings.seeding` event in it, naming each setting's
 * value, `firstUser` included, and where each came from: the seed file where it names the setting, its default
 * otherwise. The transaction is bounded by the command's connection timeout, and the event's line is written
 * once it commits.
 *
 * @param client the schema migration role's connection, which holds the run's lock.
 * @param options the schema, the settings to seed, the members the seed file holds, the clock and the event log.
 */
export const seedSettings = async (client: pg.Client, options: SeedingOptions): Promise<void> => {
	const { clock, eventLog, members, schema, settings } = options;
	const trail = seedingTrail(client, { clock, eventLog, eventSource: settings.eventSource, schema });
	const entries = Object.entries(settings);
	const seededFrom = Object.fromEntries(
		entries.map(([name]): [string, SettingOrigin] => [name, Object.hasOwn(members, name) ? 'seedFile' : 'default']),
	);
	await trail.inTransaction(
		{ type: 'system' },
		async (transaction) => {
			await transaction.connection.query(
				insertText(schema, entries.length),
				entries.flatMap(([name, value]) => [name, JSON.stringify(value)]),
			);
			await transaction.connection.query(
				`INSERT INTO ${pg.escapeIdentifier(schema)}.settings_seed (singleton, content, digest, seeded_at) VALUES (true, $1::jsonb, $2, now())`,
				[JSON.stringify(members), createHash('sha256').update(canonicalJson(members)).digest()],
			);
			await transaction.record({
				data: { seededFrom, settings: JSON.parse(JSON.stringify(settings)) },
				severity: 'info',
				type: 'settings.seeding',
			});
		},
		{ timeoutMilliseconds: SEEDING_TIMEOUT_MILLISECONDS },
	);
};

/**
 * Records the `settings.seeding` event for settings that the migrations of a later run added to a seeded store:
 * the settings named, each with its stored value, and each marked `migration`. The migrations wrote the rows; this
 * writes only the event, as the system, in a transaction of its own.
 *
 * @param client the schema migration role's connection, which holds the run's lock.
 * @param options the schema, the names the migrations added, the clock and the event log.
 */
export const recordMigratedSettings = async (
	client: pg.Client,
	options: Omit<SeedingTrailOptions, 'eventSource'> & { names: readonly string[] },
): Promise<void> => {
	const { clock, eventLog, names, schema } = options;
	const stored = await client.query<{ name: string; value: JsonValue }>(
		`SELECT name, value FROM ${pg.escapeIdentifier(schema)}.settings WHERE name = ANY($1::text[]) ORDER BY name`,
		[[...names]],
	);
	const [source] = (
		await client.query<{ source: string }>(
			`SELECT value #>> '{}' AS source FROM ${pg.escapeIdentifier(schema)}.settings WHERE name = 'eventSource'`,
		)
	).rows;
	const trail = seedingTrail(client, { clock, eventLog, eventSource: source?.source ?? '', schema });
	const settings = Object.fromEntries(stored.rows.map(({ name, value }) => [name, value]));
	const seededFrom = Object.fromEntries(stored.rows.map(({ name }): [string, SettingOrigin] => [name, 'migration']));
	await trail.inTransaction(
		{ type: 'system' },
		async (transaction) => {
			await transaction.record({ data: { seededFrom, settings }, severity: 'info', type: 'settings.seeding' });
		},
		{ timeoutMilliseconds: SEEDING_TIMEOUT_MILLISECONDS },
	);
};
