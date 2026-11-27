import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import type { Settings } from '../../src/settings/index.js';
import { runningContainers } from './containerEnvironment.js';
import { type DedicatedContainer, startDedicatedPostgresql } from './containers.js';
import { migrate, type MigrationOptions } from './controller.js';
import { refuseOverlappingQueries } from './serialQueries.js';

// Every database suite and every held suite loads this module, through its harness or its clients, and the
// Controller's pools are pg clients too, so the refusal is installed for the whole process here.
refuseOverlappingQueries();

/** The two roles a deployment creates: the migration role owning the schema, and the Controller's runtime role. */
export type DatabaseRole = 'migration' | 'runtime';

/** Each role's name, as the tests and the Controller's configuration name it. */
export const DATABASE_ROLES: Readonly<Record<DatabaseRole, string>> = Object.freeze({
	migration: 'usher_migration',
	runtime: 'usher_controller',
});

/** The schema named for Usher, which the Controller's tables live in. */
export const USHER_SCHEMA = 'usher';

/**
 * A role that may read every table of a test database's schema and write nothing, which a
 * deployment does not create: the role a dry run of the EGO import completes under (the contract's
 * planned `importFromEgo`). It is created on a PostgreSQL the first time a test asks for it, beside
 * the deployment's two, and given read access to a database only when a test asks, through
 * {@link TestDatabase.readOnlyUrl}.
 */
export const READ_ONLY_ROLE = 'usher_read_only';

/** A template database: its name, its schema, and the migration that builds it once per run. */
export interface DatabaseTemplate {
	/** Builds the template, connecting under the migration role; it settles once its connections have closed. */
	migrate(options: MigrationOptions): Promise<void>;

	name: string;
	schema: string;
}

/**
 * The retention floor a template is migrated with: that of the harness's default configuration, a
 * 300 s token lifetime, a 60 s grace period and a 30 s margin. A test database needing another has
 * it set by the migrations, run again on its clone.
 */
export const TEMPLATE_RETENTION_FLOOR_SECONDS = 390;

/**
 * The settings every template's first run seeds: the harness's own issuer, event source and sign-in token
 * maximum, and the defaults the Controller's reader gives the rest. The maximum is seeded at the harness's
 * value rather than the reader's default, so a test's start writes no raise: a token minted before the
 * start is judged by the maximum the store held since its issue, as the store records it.
 */
export const TEMPLATE_SETTINGS: Settings = {
	backChannelLogout: true,
	eventSource: 'https://usher.example.org/controller',
	firstUser: { realmRole: 'usher-first-user' },
	grantAutoAccept: false,
	grantRules: [
		{
			resources: [
				{
					accessLevel: 'open',
					categories: [{ actions: ['count', 'view', 'export'], name: 'global.unmarked' }],
				},
			],
			to: 'everyone',
		},
		{
			resources: [
				{
					accessLevel: 'open',
					categories: [{ actions: ['count', 'view', 'export'], name: 'global.unmarked' }],
				},
				{
					accessLevel: 'registered',
					categories: [{ actions: ['count', 'view', 'export'], name: 'global.unmarked' }],
				},
			],
			to: 'signedIn',
		},
	],
	grantRateThreshold: { operationCount: 100, windowSeconds: 60 },
	heartbeatMilliseconds: 10000,
	issuer: 'https://usher.example.org',
	noticePageLimit: 500,
	noticeRereadMilliseconds: 2000,
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	selfGrantMaximumLifetimeSeconds: 86400,
	signInTokenMaximumLifetimeSeconds: 3600,
	stepUpLevel: 'confirmation',
	stepUpWindowSeconds: 300,
	streamLimitPerAudience: 64,
	streamMaximumLifetimeSeconds: 900,
	streamQueueLimit: 1000,
	submitterCategory: 'global.unmarked',
	tokenLifetimeSeconds: 300,
};

// The templates built for seeds other than TEMPLATE_SETTINGS, by the seed's JSON.
const seededTemplates = new Map<string, DatabaseTemplate>();

/**
 * The template a database seeded with the settings given is cloned from. A seed equal to
 * {@link TEMPLATE_SETTINGS} is the Controller's own template; any other gets a template of its own, built
 * once per distinct seed and cached, so tests sharing a seed share it. The fixed settings (`eventSource`,
 * `firstUser`, `issuer` and `stepUpLevel`) are kept as first seeded, so a test needing another value of one of them gets a
 * database seeded with it, and no test writes to a fixed row.
 *
 * @param settings the whole of the settings the template's first run seeds.
 */
export const templateSeededWith = (settings: Settings): DatabaseTemplate => {
	if (isDeepStrictEqual(settings, TEMPLATE_SETTINGS)) {
		return USHER_TEMPLATE;
	}
	const key = JSON.stringify(settings);
	const cached = seededTemplates.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const template: DatabaseTemplate = Object.freeze({
		migrate: (options: MigrationOptions) => migrate({ ...options, settings }),
		name: `usher_template_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
		schema: USHER_SCHEMA,
	});
	seededTemplates.set(key, template);
	return template;
};

/** What a test database is created with beyond its template; each has a default. */
export interface TestDatabaseOptions {
	/** The retention floor its migrations set: {@link TEMPLATE_RETENTION_FLOOR_SECONDS} by default. */
	retentionFloorSeconds?: number;

	/**
	 * The superuser URL of the PostgreSQL to create it on: the run's shared one by default, or one a
	 * test file started for its outage tests. Roles and the template are created there once, as on the
	 * shared one.
	 */
	superuserUrl?: string;
}

/** The template every test file's database is cloned from, migrated through the seam's `migrate`. */
export const USHER_TEMPLATE: DatabaseTemplate = Object.freeze({
	migrate: (options: MigrationOptions) => migrate(options),
	name: 'usher_template',
	schema: USHER_SCHEMA,
});

/** One test file's database, cloned from a migrated template. */
export interface TestDatabase {
	/** Ends every connection it opened, then drops the database, settling once both are done. */
	close(): Promise<void>;

	/**
	 * Opens a connection under a role, which {@link TestDatabase.close} ends. A connection lost while
	 * held, such as when a test stops a PostgreSQL of its own, fails the query made on it next rather
	 * than ending the test process.
	 */
	connect(role: DatabaseRole): Promise<pg.Client>;

	name: string;

	/**
	 * Gives {@link READ_ONLY_ROLE} `USAGE` on the schema and `SELECT` on every table it holds now,
	 * granted by the migration role, which owns them, creating the role on this PostgreSQL first if no
	 * test has, and settles to a connection URL under it, for a Controller started on it.
	 */
	readOnlyUrl(): Promise<string>;

	schema: string;

	/** A connection URL under a role, such as the Controller's `databaseUrl` for `runtime`. */
	urlFor(role: DatabaseRole): string;
}

// One key every harness process shares, so roles and templates are created once per run however
// many test files ask at the same time.
const SETUP_LOCK = 207_000_001;

const quoted = (identifier: string): string => pg.escapeIdentifier(identifier);

// A connection lost while it is held, as when a test stops a PostgreSQL of its own, is reported as an
// error event, which with no listener ends the whole test process; with one, the loss reaches the test
// as the query made on the connection next, which fails.
const openedClient = async (connectionString: string): Promise<pg.Client> => {
	const client = new pg.Client({ connectionString });
	client.on('error', () => undefined);
	await client.connect();
	return client;
};

// Each role's password is derived from the superuser's, which is made fresh for each run, so every
// test process derives the same one and nothing outside the run can.
const passwordFor = (superuserUrl: URL, roleName: string): string =>
	createHmac('sha256', superuserUrl.password).update(roleName).digest('base64url');

const rolePassword = (superuserUrl: URL, role: DatabaseRole): string => passwordFor(superuserUrl, DATABASE_ROLES[role]);

const urlAs = (superuserUrl: URL, roleName: string, database: string): string => {
	const url = new URL(superuserUrl);
	url.username = roleName;
	url.password = passwordFor(superuserUrl, roleName);
	url.pathname = `/${database}`;
	return url.href;
};

const roleUrl = (superuserUrl: URL, role: DatabaseRole, database: string): string =>
	urlAs(superuserUrl, DATABASE_ROLES[role], database);

const ensureRoles = async (superuser: pg.Client, superuserUrl: URL): Promise<void> => {
	const { rows } = await superuser.query<{ rolname: string }>(
		'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)',
		[Object.values(DATABASE_ROLES)],
	);
	const existing = new Set(rows.map(({ rolname }) => rolname));
	const roles: readonly DatabaseRole[] = ['migration', 'runtime'];
	// One role at a time: a second query issued on the superuser connection while one is in flight is refused.
	await roles
		.filter((role) => !existing.has(DATABASE_ROLES[role]))
		.reduce<Promise<unknown>>(
			(previous, role) =>
				previous.then(() =>
					superuser.query(
						`CREATE ROLE ${quoted(DATABASE_ROLES[role])} LOGIN PASSWORD ${pg.escapeLiteral(rolePassword(superuserUrl, role))}`,
					),
				),
			Promise.resolve(),
		);
};

const buildTemplate = async (superuser: pg.Client, superuserUrl: URL, template: DatabaseTemplate): Promise<void> => {
	await superuser.query(`CREATE DATABASE ${quoted(template.name)} OWNER ${quoted(DATABASE_ROLES.migration)}`);
	try {
		await template.migrate({
			databaseUrl: roleUrl(superuserUrl, 'migration', template.name),
			runtimeRole: DATABASE_ROLES.runtime,
			schema: template.schema,
			settings: TEMPLATE_SETTINGS,
		});
	} catch (error) {
		await superuser.query(`DROP DATABASE ${quoted(template.name)} WITH (FORCE)`);
		throw error;
	}
	await superuser.query(`ALTER DATABASE ${quoted(template.name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
};

// A database by the template's name that is not marked as a template was left by a process that
// stopped while building it, and is built again.
const ensureTemplate = async (superuser: pg.Client, superuserUrl: URL, template: DatabaseTemplate): Promise<void> => {
	const { rows } = await superuser.query<{ datistemplate: boolean }>(
		'SELECT datistemplate FROM pg_database WHERE datname = $1',
		[template.name],
	);
	const [existing] = rows;
	if (existing?.datistemplate === true) {
		return;
	}
	if (existing !== undefined) {
		await superuser.query(`DROP DATABASE ${quoted(template.name)} WITH (FORCE)`);
	}
	await buildTemplate(superuser, superuserUrl, template);
};

const withSuperuser = async <Result>(
	superuserUrl: URL,
	work: (superuser: pg.Client) => Promise<Result>,
): Promise<Result> => {
	const superuser = await openedClient(superuserUrl.href);
	try {
		return await work(superuser);
	} finally {
		await superuser.end();
	}
};

/**
 * Writes settings to a schema's store as its owner, in one transaction declaring the system as the actor,
 * so each change is recorded as the store records any other. A setting already holding the value given is
 * left alone, so a start that writes what the store holds writes nothing. The fixed settings refuse a change
 * (`eventSource`, `firstUser` and `issuer` are kept as first seeded), so a test varying one needs a database
 * of its own.
 *
 * @param client a connection under the schema's owner role.
 * @param schema the schema the settings table lives in.
 * @param settings each setting's name and value, as the JSON the store holds for it: a test may hold a value its
 *   setting refuses, to see the Controller refuse it.
 */
export const writeStoredSettings = async (
	client: pg.ClientBase,
	schema: string,
	settings: Readonly<Record<string, unknown>>,
): Promise<void> => {
	const names = Object.keys(settings);
	if (names.length === 0) {
		return;
	}
	// Read first: the store's statement-level trigger on the settings raises the generation for every statement
	// it runs, changed rows or none, so a statement is sent only for a value that differs.
	const { rows } = await client.query<{ name: string; value: unknown }>(
		`SELECT name, value FROM ${quoted(schema)}.settings WHERE name = ANY($1)`,
		[names],
	);
	const stored = new Map(rows.map(({ name, value }) => [name, value]));
	const changed = Object.entries(settings).filter(([name, value]) => !isDeepStrictEqual(stored.get(name), value));
	if (changed.length === 0) {
		return;
	}
	await client.query('BEGIN');
	try {
		await client.query("SELECT set_config('usher.actor_type', 'system', true)");
		for (const [name, value] of changed) {
			await client.query(
				`UPDATE ${quoted(schema)}.settings SET value = $2::jsonb, changed_at = now() WHERE name = $1 AND value IS DISTINCT FROM $2::jsonb`,
				[name, JSON.stringify(value)],
			);
		}
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	}
};

// A floor other than the template's is set on the clone by its schema owner, declaring the system as the
// actor: the three durations are set, the grace period and the margin to none, so the trigger on the settings
// sets the notice retention floor to the token lifetime alone.
const withFloor = async (
	superuserUrl: URL,
	name: string,
	template: DatabaseTemplate,
	retentionFloorSeconds: number,
): Promise<void> => {
	if (retentionFloorSeconds === TEMPLATE_RETENTION_FLOOR_SECONDS) {
		return;
	}
	const owner = new pg.Client({
		connectionString: roleUrl(superuserUrl, 'migration', name),
	});
	try {
		await owner.connect();
		await owner.query('BEGIN');
		await owner.query("SELECT set_config('usher.actor_type', 'system', true)");
		await owner.query(
			`UPDATE ${quoted(template.schema)}.settings SET value = to_jsonb($1::integer) WHERE name = 'tokenLifetimeSeconds'`,
			[retentionFloorSeconds],
		);
		await owner.query(
			`UPDATE ${quoted(template.schema)}.settings SET value = to_jsonb(0) WHERE name = 'retentionGraceSeconds'`,
		);
		await owner.query(
			`UPDATE ${quoted(template.schema)}.settings SET value = to_jsonb(0) WHERE name = 'retentionMarginSeconds'`,
		);
		await owner.query('COMMIT');
	} catch (error) {
		await owner.query('ROLLBACK').catch(() => undefined);
		await withSuperuser(superuserUrl, (superuser) => superuser.query(`DROP DATABASE ${quoted(name)} WITH (FORCE)`));
		throw error;
	} finally {
		await owner.end().catch(() => undefined);
	}
};

/**
 * Creates one test file's database: the two roles, once per run on each PostgreSQL; the template,
 * migrated once per run there when first asked for; then a fresh database cloned from it with
 * `CREATE DATABASE ... TEMPLATE`, and a retention floor other than the template's set on the clone by
 * updating its three duration settings as the schema owner. A template whose migration fails is dropped, and the failure is this
 * call's alone, so the test file asking gets that failure and every other file runs on. The
 * superuser does this work and is never handed out.
 *
 * @param template the template to clone; the Controller's own by default. Another is for the harness's
 *   own tests.
 * @param options the retention floor, and the PostgreSQL to create the database on.
 */
export const createTestDatabase = async (
	template: DatabaseTemplate = USHER_TEMPLATE,
	{
		retentionFloorSeconds = TEMPLATE_RETENTION_FLOOR_SECONDS,
		superuserUrl: givenSuperuserUrl = runningContainers().postgresql.url,
	}: TestDatabaseOptions = {},
): Promise<TestDatabase> => {
	const superuserUrl = new URL(givenSuperuserUrl);
	const name = `usher_test_${randomBytes(8).toString('hex')}`;
	await withSuperuser(superuserUrl, async (superuser) => {
		await superuser.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
		try {
			await ensureRoles(superuser, superuserUrl);
			await ensureTemplate(superuser, superuserUrl, template);
			await superuser.query(
				`CREATE DATABASE ${quoted(name)} TEMPLATE ${quoted(template.name)} OWNER ${quoted(DATABASE_ROLES.migration)}`,
			);
		} finally {
			await superuser.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]);
		}
	});
	await withFloor(superuserUrl, name, template, retentionFloorSeconds);

	const urlFor = (role: DatabaseRole): string => roleUrl(superuserUrl, role, name);
	const connections = new Set<pg.Client>();
	const readOnlyUrl = async (): Promise<string> => {
		await withSuperuser(superuserUrl, async (superuser) => {
			await superuser.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
			try {
				const { rows } = await superuser.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [READ_ONLY_ROLE]);
				if (rows.length === 0) {
					await superuser.query(
						`CREATE ROLE ${quoted(READ_ONLY_ROLE)} LOGIN PASSWORD ${pg.escapeLiteral(passwordFor(superuserUrl, READ_ONLY_ROLE))}`,
					);
				}
			} finally {
				await superuser.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]);
			}
		});
		const owner = await openedClient(urlFor('migration'));
		try {
			await owner.query(
				`GRANT USAGE ON SCHEMA ${quoted(template.schema)} TO ${quoted(READ_ONLY_ROLE)}; GRANT SELECT ON ALL TABLES IN SCHEMA ${quoted(template.schema)} TO ${quoted(READ_ONLY_ROLE)}`,
			);
		} finally {
			await owner.end();
		}
		return urlAs(superuserUrl, READ_ONLY_ROLE, name);
	};

	return {
		close: async () => {
			await Promise.all([...connections].map((client) => client.end()));
			connections.clear();
			await withSuperuser(superuserUrl, (superuser) =>
				superuser.query(`DROP DATABASE ${quoted(name)} WITH (FORCE)`),
			);
		},

		connect: async (role) => {
			const client = await openedClient(urlFor(role));
			connections.add(client);
			return client;
		},

		name,
		readOnlyUrl,
		schema: template.schema,
		urlFor,
	};
};

/** A test database on a PostgreSQL started for it alone, which its `close` also removes. */
export interface DedicatedTestDatabase extends TestDatabase {
	/** The PostgreSQL it lives on, which a test can pause, stop and restart. */
	postgresql: DedicatedContainer;
}

/**
 * Creates a migrated test database, with both roles, on a PostgreSQL started for it alone: for a test
 * holding more connections at once than the run's shared PostgreSQL can spare beside every other
 * file, for an outage test, or for a server setting. Its `close` drops the database, then removes the
 * PostgreSQL.
 *
 * @param template the template to clone; the Controller's own by default.
 * @param options the retention floor, and the server settings the PostgreSQL starts with, such as
 *   `{ track_commit_timestamp: 'on' }`.
 */
export const createDedicatedTestDatabase = async (
	template: DatabaseTemplate = USHER_TEMPLATE,
	{
		retentionFloorSeconds,
		settings = {},
	}: {
		retentionFloorSeconds?: number;
		settings?: Readonly<Record<string, string>>;
	} = {},
): Promise<DedicatedTestDatabase> => {
	const postgresql = await startDedicatedPostgresql(undefined, { settings });
	try {
		const database = await createTestDatabase(template, {
			...(retentionFloorSeconds === undefined ? {} : { retentionFloorSeconds }),
			superuserUrl: postgresql.container.url,
		});
		return {
			...database,
			close: async () => {
				try {
					await database.close();
				} finally {
					await postgresql.remove();
				}
			},
			postgresql,
		};
	} catch (error) {
		await postgresql.remove();
		throw error;
	}
};

/** The backends of the test's database waiting on a lock another transaction holds. */
export interface BlockedBackend {
	/** The backends holding what it waits for. */
	blockedBy: readonly number[];

	pid: number;
}

/**
 * The backends of the connection's database blocked on another transaction, whatever the lock: a
 * table's, or a row's, which waits on the other transaction's id and so names no database in
 * `pg_locks`. Each is found by backend through `pg_blocking_pids`.
 *
 * @param client a connection to the test's database.
 */
export const blockedBackends = async (client: pg.ClientBase): Promise<readonly BlockedBackend[]> => {
	const { rows } = await client.query<{ blocked_by: number[]; pid: number }>(
		'SELECT pid, pg_blocking_pids(pid) AS blocked_by FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 ORDER BY pid',
	);
	return rows.map(({ blocked_by, pid }) => ({ blockedBy: blocked_by, pid }));
};

/**
 * Settles once as many backends of the test's database as given are blocked on another transaction,
 * once the work settles, or at the deadline, whichever comes first, so a test never waits on time to
 * learn that a statement has reached a lock.
 *
 * @param client a connection to the test's database, itself blocked on nothing.
 * @param work the work expected to block.
 * @param options how many backends, 1 by default, and the deadline in milliseconds since the Unix
 *   epoch, 5 s from now by default.
 * @returns whether that many were seen blocked.
 */
export const untilBlocked = async (
	client: pg.ClientBase,
	work: Promise<unknown>,
	{ count = 1, deadline = Date.now() + 5000 }: { count?: number; deadline?: number } = {},
): Promise<boolean> => {
	if ((await blockedBackends(client)).length >= count) {
		return true;
	}
	if (Date.now() > deadline) {
		return false;
	}
	const outcome = await Promise.race([
		work.then(
			() => 'settled',
			() => 'settled',
		),
		delay(20).then(() => 'pending'),
	]);
	return outcome === 'pending'
		? untilBlocked(client, work, { count, deadline })
		: (await blockedBackends(client)).length >= count;
};

/** A table held under a lock by the test, so a computation reading it waits until it is released. */
export interface HeldTable {
	/** The backend holding the lock. */
	holderPid: number;

	/** Ends the lock's transaction, letting every waiting read go on. */
	release(): Promise<void>;
}

/**
 * Takes an `ACCESS EXCLUSIVE` lock on a table in a transaction of its own, as the migration role,
 * which owns it: every read of it waits until {@link HeldTable.release}. The connection is the test
 * database's, so it ends with the database.
 *
 * @param database the test's database.
 * @param table a table, such as an entry of `POLICY_TABLES`.
 */
export const holdTable = async (database: TestDatabase, table: { name: string }): Promise<HeldTable> => {
	const holder = await database.connect('migration');
	await holder.query('BEGIN');
	await holder.query(`LOCK TABLE ${quoted(database.schema)}.${quoted(table.name)} IN ACCESS EXCLUSIVE MODE`);
	const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
	return {
		holderPid: rows[0]?.pid ?? 0,
		release: async () => {
			await holder.query('COMMIT');
		},
	};
};

/**
 * Settles once some backend of the test's database is blocked, once the work settles, or after 5 s,
 * whichever comes first: {@link untilBlocked} for one backend, its signature kept for a held table.
 *
 * @param client a connection to the test's database, itself blocked on nothing.
 * @param _table the table held, which names what the work is expected to wait for.
 * @param work the work expected to wait for it.
 * @param deadline milliseconds since the Unix epoch.
 */
export const untilWaiting = async (
	client: pg.ClientBase,
	_table: { name: string },
	work: Promise<unknown>,
	deadline: number = Date.now() + 5000,
): Promise<void> => {
	await untilBlocked(client, work, { deadline });
};

/**
 * Runs work while a table is held under the test's lock ({@link holdTable}), so whatever reaches it
 * waits, and lets it go once the work settles, whether or not it succeeded.
 *
 * @param database the test's database, which holds the table.
 * @param table a table, such as an entry of `POLICY_TABLES`.
 * @param work what runs while the table is held.
 */
export const whileHolding = async <Result>(
	database: TestDatabase,
	table: { name: string },
	work: () => Promise<Result>,
): Promise<Result> => {
	const held = await holdTable(database, table);
	try {
		return await work();
	} finally {
		await held.release();
	}
};

/**
 * Whether some transaction on the connection's database has written to one table and now waits on
 * another's lock: a writer part way through its writes, held there, as opposed to a read waiting on
 * the same lock, or a writer waiting before it reached that table. A transaction that has inserted,
 * updated or deleted in a table holds its `RowExclusiveLock` until it ends.
 *
 * @param client a connection to the test's database, itself waiting on nothing.
 * @param table the table written, such as an entry of `POLICY_TABLES`.
 * @param schema the table's schema: the one named for Usher by default.
 */
export const writerIsWaiting = async (
	client: pg.ClientBase,
	table: { name: string },
	schema: string = USHER_SCHEMA,
): Promise<boolean> => {
	const { rows } = await client.query<{ count: number }>(
		`SELECT count(*)::int AS count
       FROM pg_locks held
       JOIN pg_class relation ON relation.oid = held.relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = $2
        AND held.mode = 'RowExclusiveLock'
        AND held.granted
        AND cardinality(pg_blocking_pids(held.pid)) > 0`,
		[schema, table.name],
	);
	return (rows[0]?.count ?? 0) > 0;
};
