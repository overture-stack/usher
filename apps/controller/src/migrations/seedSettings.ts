import { createHash } from 'node:crypto';

import pg from 'pg';

import { createAuditTrail, type EventLog, type TrailConnection } from '../eventLog/index.js';
import { canonicalJson, type Settings } from '../settings/index.js';
import type { MigrationOptions } from './types.js';

// The instance a seeding event names: the run's own, since no instance serves a migration.
const SEEDING_INSTANCE = 'schemaMigration';

// The seeding is bounded by the command's own limit on connecting and signing in, as its one bound.
const SEEDING_TIMEOUT_MILLISECONDS = 30_000;

/** What seeding writes: the schema, every setting's value, and where the event is written. */
interface SeedingOptions {
	clock: MigrationOptions['clock'];
	eventLog: Pick<EventLog, 'error' | 'writeEvent'>;
	members: Readonly<Record<string, unknown>>;
	schema: string;
	settings: Settings;
}

// One row per setting, each stamped with the moment of seeding, which names no actor.
const insertText = (schema: string, count: number): string =>
	`INSERT INTO ${pg.escapeIdentifier(schema)}.settings (name, value, changed_at) VALUES ${Array.from(
		{ length: count },
		(_, index) => `($${index * 2 + 1}, $${index * 2 + 2}::jsonb, now())`,
	).join(', ')}`;

/**
 * Seeds every setting in one transaction the audit trail records as the system, stores the seed file's members
 * with their digest as the one seed row, and records the `settings.seeding` event in it, naming each setting's
 * value, `firstUser` included. The transaction is bounded by the command's connection timeout, and the event's
 * line is written once it commits.
 *
 * @param client the schema migration role's connection, which holds the run's lock.
 * @param options the schema, the settings to seed, the members the seed file holds, the clock and the event log.
 */
export const seedSettings = async (client: pg.Client, options: SeedingOptions): Promise<void> => {
	const { clock, eventLog, members, schema, settings } = options;
	const connection: TrailConnection = {
		query: (text, values) => client.query(text, values === undefined ? undefined : [...values]),
		release: () => undefined,
	};
	const trail = createAuditTrail({
		eventLog,
		settings: {
			clock,
			databaseSchema: schema,
			eventSource: settings.eventSource,
			instanceName: SEEDING_INSTANCE,
			storeTimeoutMilliseconds: SEEDING_TIMEOUT_MILLISECONDS,
		},
		store: { connect: () => Promise.resolve(connection) },
	});
	const entries = Object.entries(settings);
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
				data: { settings: JSON.parse(JSON.stringify(settings)) },
				severity: 'info',
				type: 'settings.seeding',
			});
		},
		{ timeoutMilliseconds: SEEDING_TIMEOUT_MILLISECONDS },
	);
};
