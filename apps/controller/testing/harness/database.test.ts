import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import pg from 'pg';

import { runningContainers } from './containerEnvironment.js';
import { startDedicatedPostgresql } from './containers.js';
import type { MigrationOptions } from './controller.js';
import {
	blockedBackends,
	createDedicatedTestDatabase,
	createTestDatabase,
	DATABASE_ROLES,
	type DatabaseTemplate,
	holdTable,
	TEMPLATE_RETENTION_FLOOR_SECONDS,
	TEMPLATE_SETTINGS,
	templateSeededWith,
	untilBlocked,
	untilWaiting,
	USHER_SCHEMA,
	USHER_TEMPLATE,
	whileHolding,
	writerIsWaiting,
} from './database.js';

// The harness proves its cloning on a stand-in migration that builds one table and grants it to the
// runtime role, as the Controller's migrations do, so these tests need none of the Controller's
// schema.
const standInTemplate = (migrations: MigrationOptions[] = []): DatabaseTemplate => ({
	migrate: async (options) => {
		migrations.push(options);
		const postgres = new pg.Client({ connectionString: options.databaseUrl });
		await postgres.connect();
		try {
			const schema = pg.escapeIdentifier(options.schema);
			const runtimeRole = pg.escapeIdentifier(options.runtimeRole);
			await postgres.query(`CREATE SCHEMA ${schema}`);
			await postgres.query(`CREATE TABLE ${schema}.harness_marker (note text NOT NULL)`);
			await postgres.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
			await postgres.query(`GRANT SELECT ON ${schema}.harness_marker TO ${runtimeRole}`);
		} finally {
			await postgres.end();
		}
	},
	name: `harness_template_${randomBytes(6).toString('hex')}`,
	schema: USHER_SCHEMA,
});

const SHARED_TEMPLATE = standInTemplate();

const markerNotes = async (postgres: pg.Client): Promise<readonly string[]> => {
	const { rows } = await postgres.query<{ note: string }>('SELECT note FROM usher.harness_marker ORDER BY note');
	return rows.map(({ note }) => note);
};

const databaseCount = async (postgres: pg.Client, name: string): Promise<number | undefined> => {
	const { rows } = await postgres.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM pg_database WHERE datname = $1',
		[name],
	);
	return rows[0]?.count;
};

suite('a database for each test file', () => {
	test('migrates a template once, however many files ask for a database at the same time', async (context) => {
		const migrations: MigrationOptions[] = [];
		const template = standInTemplate(migrations);

		const databases = await Promise.all([
			createTestDatabase(template),
			createTestDatabase(template),
			createTestDatabase(template),
		]);
		context.after(() => Promise.all(databases.map((database) => database.close())));

		assert.equal(migrations.length, 1);
		assert.equal(new Set(databases.map(({ name }) => name)).size, 3);
	});

	test('hands the migration the migration role, the runtime role and the schema named for Usher, applying every migration', async (context) => {
		const migrations: MigrationOptions[] = [];
		const database = await createTestDatabase(standInTemplate(migrations));
		context.after(() => database.close());

		const [options] = migrations;

		assert.equal(new URL(options?.databaseUrl ?? 'postgres://').username, DATABASE_ROLES.migration);
		assert.equal(options?.runtimeRole, DATABASE_ROLES.runtime);
		assert.equal(options?.schema, 'usher');
		assert.equal(options?.target, undefined);
	});

	test("clones each file a database of its own, holding what the template's migration built", async (context) => {
		const [first, second] = await Promise.all([
			createTestDatabase(SHARED_TEMPLATE),
			createTestDatabase(SHARED_TEMPLATE),
		]);
		context.after(() => Promise.all([first.close(), second.close()]));
		const firstOwner = await first.connect('migration');
		const secondOwner = await second.connect('migration');

		await firstOwner.query("INSERT INTO usher.harness_marker (note) VALUES ('written in the first')");

		assert.deepEqual(await markerNotes(firstOwner), ['written in the first']);
		assert.deepEqual(await markerNotes(secondOwner), []);
	});

	test('connects under the migration role and the runtime role, neither of them a superuser', async (context) => {
		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());

		const identities = await Promise.all(
			(['migration', 'runtime'] as const).map(async (role) => {
				const postgres = await database.connect(role);
				const { rows } = await postgres.query<{
					role: string;
					superuser: boolean;
				}>('SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user');
				return rows[0];
			}),
		);

		assert.deepEqual(identities, [
			{ role: DATABASE_ROLES.migration, superuser: false },
			{ role: DATABASE_ROLES.runtime, superuser: false },
		]);
	});

	test('drops a database once it closes, ending its connections first', async (context) => {
		const [closing, remaining] = await Promise.all([
			createTestDatabase(SHARED_TEMPLATE),
			createTestDatabase(SHARED_TEMPLATE),
		]);
		context.after(() => remaining.close());
		await closing.connect('runtime');
		const observer = await remaining.connect('migration');

		await closing.close();

		assert.equal(await databaseCount(observer, closing.name), 0);
	});
});

// A setting's value as text, read from its row of the settings table.
const settingOf = async (postgres: pg.Client, name: string): Promise<string | undefined> => {
	const { rows } = await postgres.query<{ value: string }>(
		"SELECT value #>> '{}' AS value FROM usher.settings WHERE name = $1",
		[name],
	);
	return rows[0]?.value;
};

const floorOf = async (postgres: pg.Client): Promise<number | undefined> => {
	const { rows } = await postgres.query<{ floor_seconds: number }>(
		'SELECT floor_seconds FROM usher.notice_retention',
	);
	return rows[0]?.floor_seconds;
};

const databaseNamed = async (superuserUrl: string, name: string): Promise<number | undefined> => {
	const superuser = new pg.Client({ connectionString: superuserUrl });
	await superuser.connect();
	try {
		return await databaseCount(superuser, name);
	} finally {
		await superuser.end();
	}
};

suite('the retention floor a database is created with', () => {
	test('sets a clone floor through the three durations its store holds, leaving the template and other clones at theirs', async (context) => {
		const lowered = await createTestDatabase(USHER_TEMPLATE, {
			retentionFloorSeconds: 120,
		});
		const usual = await createTestDatabase(USHER_TEMPLATE);
		context.after(() => Promise.all([lowered.close(), usual.close()]));
		const loweredOwner = await lowered.connect('migration');

		assert.deepEqual(
			{
				grace: await settingOf(loweredOwner, 'retentionGraceSeconds'),
				margin: await settingOf(loweredOwner, 'retentionMarginSeconds'),
				token: await settingOf(loweredOwner, 'tokenLifetimeSeconds'),
			},
			{ grace: '0', margin: '0', token: '120' },
		);
		assert.equal(await floorOf(loweredOwner), 120);
		assert.equal(await floorOf(await usual.connect('migration')), TEMPLATE_RETENTION_FLOOR_SECONDS);
	});
});

suite("a database on a test file's own PostgreSQL", () => {
	test('creates the roles, the template and the database there, and nothing on the shared one', async (context) => {
		const dedicated = await startDedicatedPostgresql();
		const holder: {
			database?: Awaited<ReturnType<typeof createTestDatabase>>;
		} = {};
		context.after(async () => {
			await holder.database?.close();
			await dedicated.remove();
		});

		holder.database = await createTestDatabase(standInTemplate(), {
			superuserUrl: dedicated.container.url,
		});
		const { database } = holder;
		const identities = await Promise.all(
			(['migration', 'runtime'] as const).map(async (role) => {
				const postgres = await database.connect(role);
				const { rows } = await postgres.query<{ role: string }>('SELECT current_user AS role');
				return { notes: await markerNotes(postgres), role: rows[0]?.role };
			}),
		);

		assert.deepEqual(identities, [
			{ notes: [], role: DATABASE_ROLES.migration },
			{ notes: [], role: DATABASE_ROLES.runtime },
		]);
		assert.equal(new URL(database.urlFor('runtime')).port, new URL(dedicated.container.url).port);
		assert.equal(await databaseNamed(dedicated.container.url, database.name), 1);
		assert.equal(await databaseNamed(runningContainers().postgresql.url, database.name), 0);
	});
});

suite('a database migrated on a PostgreSQL started for it alone', () => {
	test('carries the server settings asked for, and removes its PostgreSQL when it closes', async (context) => {
		const dedicated = await createDedicatedTestDatabase(standInTemplate(), {
			settings: { track_commit_timestamp: 'on' },
		});
		const closing = { done: false };
		context.after(async () => {
			if (!closing.done) {
				await dedicated.close();
			}
		});
		const owner = await dedicated.connect('migration');
		const { rows } = await owner.query<{ track_commit_timestamp: string }>('SHOW track_commit_timestamp');
		const ownPort = new URL(dedicated.postgresql.container.url).port;

		closing.done = true;
		await dedicated.close();
		const afterClose = new pg.Client({
			connectionString: dedicated.postgresql.container.url,
			connectionTimeoutMillis: 1000,
		});
		const reached = await afterClose.connect().then(
			async () => {
				await afterClose.end();
				return true;
			},
			() => false,
		);

		assert.equal(rows[0]?.track_commit_timestamp, 'on');
		assert.equal(new URL(dedicated.urlFor('runtime')).port, ownPort);
		assert.equal(reached, false);
	});
});

suite('seeing a statement wait on a lock', () => {
	test("sees a backend blocked on another transaction's row lock, which names no database in pg_locks", async (context) => {
		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());
		const [holder, waiter, observer] = await Promise.all([
			database.connect('migration'),
			database.connect('migration'),
			database.connect('migration'),
		]);
		await holder.query("INSERT INTO usher.harness_marker (note) VALUES ('locked')");
		await holder.query('BEGIN');
		await holder.query("UPDATE usher.harness_marker SET note = 'held'");
		const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;

		const waiting = waiter.query("UPDATE usher.harness_marker SET note = 'waited'");
		const blocked = await untilBlocked(observer, waiting);
		const backends = await blockedBackends(observer);
		await holder.query('COMMIT');
		await waiting;

		assert.equal(blocked, true);
		assert.deepEqual(
			backends.map(({ blockedBy }) => blockedBy),
			[[holderPid]],
		);
		assert.deepEqual(await blockedBackends(observer), []);
		assert.equal(
			await untilBlocked(observer, Promise.resolve(), {
				deadline: Date.now() + 100,
			}),
			false,
		);
	});

	test('holds a table so a read of it waits until released, and sees that read wait', async (context) => {
		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());
		const [reader, observer] = await Promise.all([database.connect('runtime'), database.connect('migration')]);

		const held = await holdTable(database, { name: 'harness_marker' });
		const reading = reader.query('SELECT count(*) FROM usher.harness_marker');
		await untilWaiting(observer, { name: 'harness_marker' }, reading);
		const whileHeld = await blockedBackends(observer);
		await held.release();
		await reading;

		assert.deepEqual(
			whileHeld.map(({ blockedBy }) => blockedBy),
			[[held.holderPid]],
		);
	});
});

suite('a writer held part way through its writes', () => {
	test('sees a transaction that wrote one table wait on another held, and neither a read nor a writer that has not reached it', async (context) => {
		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());
		const [writer, reader, observer] = await Promise.all([
			database.connect('migration'),
			database.connect('migration'),
			database.connect('migration'),
		]);
		await observer.query('CREATE TABLE usher.harness_other (note text)');
		const marker = { name: 'harness_marker' };
		const other = { name: 'harness_other' };

		const seen = await whileHolding(database, other, async () => {
			const reading = reader.query('SELECT count(*) FROM usher.harness_other');
			await untilWaiting(observer, other, reading);
			const whileReading = await writerIsWaiting(observer, other);
			await writer.query('BEGIN');
			await writer.query("INSERT INTO usher.harness_marker VALUES ('written')");
			const writing = writer.query("INSERT INTO usher.harness_other VALUES ('waits')");
			await untilBlocked(observer, writing, { count: 2 });
			return {
				marker: await writerIsWaiting(observer, marker),
				other: await writerIsWaiting(observer, other),
				reading,
				whileReading,
				writing,
			};
		});
		await seen.reading;
		await seen.writing;
		await writer.query('COMMIT');
		const afterRelease = await writerIsWaiting(observer, marker);

		assert.deepEqual(
			{
				afterRelease,
				marker: seen.marker,
				other: seen.other,
				whileReading: seen.whileReading,
			},
			{ afterRelease: false, marker: true, other: false, whileReading: false },
		);
	});

	test('lets the table go once the work fails, and throws its failure', async (context) => {
		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());
		const reader = await database.connect('migration');

		await assert.rejects(
			whileHolding(database, { name: 'harness_marker' }, () => Promise.reject(new Error('the work failed'))),
			{ message: 'the work failed' },
		);
		const { rows } = await reader.query<{ count: string }>('SELECT count(*) FROM usher.harness_marker');

		assert.equal(rows[0]?.count, '0');
	});
});

suite('a template whose migration fails', () => {
	test("fails that file's database with the migration's error, leaving no template behind and the run able to go on", async (context) => {
		const failing: DatabaseTemplate = {
			migrate: async () => {
				throw new Error('the template migration failed');
			},
			name: `failing_template_${randomBytes(6).toString('hex')}`,
			schema: USHER_SCHEMA,
		};

		await assert.rejects(createTestDatabase(failing), {
			message: 'the template migration failed',
		});

		const database = await createTestDatabase(SHARED_TEMPLATE);
		context.after(() => database.close());
		const observer = await database.connect('migration');

		assert.equal(await databaseCount(observer, failing.name), 0);
	});
});

suite('the template a seeded database is cloned from', () => {
	test("is the Controller's own for the template's seed, and one shared template for each other seed", () => {
		const seeded = { ...TEMPLATE_SETTINGS, issuer: 'https://elsewhere.example.org' };
		const sameSeed = { ...TEMPLATE_SETTINGS, issuer: 'https://elsewhere.example.org' };

		assert.equal(templateSeededWith(TEMPLATE_SETTINGS), USHER_TEMPLATE);
		assert.notEqual(templateSeededWith(seeded), USHER_TEMPLATE);
		assert.equal(templateSeededWith(seeded), templateSeededWith(sameSeed));
		assert.notEqual(templateSeededWith(seeded).name, USHER_TEMPLATE.name);
	});
});
