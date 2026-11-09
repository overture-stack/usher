import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import { ControllerError } from '../failures/index.js';
import {
  MIGRATIONS_REFUSE_TO_RUN,
  MigrationRefusal,
} from './migrationRefusal.js';
import { pendingMigrations } from './pendingMigrations.js';
import { readMigrations } from './readMigrations.js';
import { substituteNames } from './substituteNames.js';
import type {
  AppliedMigration,
  Migration,
  MigrationNames,
  MigrationOptions,
  MigrationOutcome,
} from './types.js';

// Held by a run for its whole session, so two runs on one database apply each migration once. The
// notice stream takes a key of its own; the two never meet.
const MIGRATION_LOCK = 8_617_207_001;

/** The longest retention floor a run stores, in seconds: its column is an `integer`. */
export const LARGEST_RETENTION_FLOOR_SECONDS = 2_147_483_647;

const CONNECTION_TIMEOUT_MILLISECONDS = 30_000;

// A session waiting on a lock, or running a statement, learns that its client has gone only when it
// next answers, unless it checks. Checking every second, a run's session ends within a second of
// its connection closing, however the run ended, rolling back the migration in flight and releasing
// the run's lock.
const CLIENT_CHECK_MILLISECONDS = 1000;

const RECORD_TABLE = 'schema_migrations';

const RETENTION_TABLE = 'notice_retention';

const refusal = (rule: string): ControllerError =>
  new ControllerError(`${MIGRATIONS_REFUSE_TO_RUN}: ${rule}`);

const stoppedRun = (cause: unknown): ControllerError =>
  new ControllerError(
    'the run was stopped, and every migration it committed before the stop stays applied',
    { cause },
  );

const qualified = (schema: string, table: string): string =>
  `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;

const checkedFloor = (seconds: number): number => {
  if (
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= LARGEST_RETENTION_FLOOR_SECONDS
  ) {
    return seconds;
  }
  throw refusal(
    `retentionFloorSeconds must be a whole number of seconds from 1 to ${LARGEST_RETENTION_FLOOR_SECONDS}`,
  );
};

const checkedName = (option: string, name: string): string => {
  if (name !== '') {
    return name;
  }
  throw refusal(`${option} must name an identifier`);
};

/** The oldest PostgreSQL release the schema migrations run on, as `server_version_num` numbers it. */
export const OLDEST_SUPPORTED_SERVER_VERSION = 150_000;

/**
 * Refuses a run on a PostgreSQL server older than {@link OLDEST_SUPPORTED_SERVER_VERSION}, laying the
 * refusal on the URL that names it, before the run sets anything on its session.
 *
 * @param client a connected client.
 * @throws {MigrationRefusal} laid on the database URL, for a server older than the oldest supported.
 */
export const refuseUnsupportedServer = async (client: {
  query(text: string): Promise<{ rows: readonly { version: number }[] }>;
}): Promise<void> => {
  const { rows } = await client.query(
    "SELECT current_setting('server_version_num')::int AS version",
  );
  if ((rows[0]?.version ?? 0) >= OLDEST_SUPPORTED_SERVER_VERSION) {
    return;
  }
  throw new MigrationRefusal(
    'databaseUrl',
    'names a PostgreSQL server older than 15, the oldest Usher supports',
  );
};

// Decide H: the runtime role holds only the privileges the migrations grant it, so it must be a role
// of its own that cannot act as the schema's owner.
const refuseUnsafeRuntimeRole = async (
  client: pg.ClientBase,
  runtimeRole: string,
): Promise<void> => {
  const { rows } = await client.query<{ standsApart: boolean }>(
    'SELECT NOT pg_has_role(rolname, current_user, \'MEMBER\') AND NOT rolsuper AS "standsApart" FROM pg_roles WHERE rolname = $1',
    [runtimeRole],
  );
  const [role] = rows;
  if (role?.standsApart === true) {
    return;
  }
  throw new MigrationRefusal(
    'runtimeRole',
    role === undefined
      ? 'names a role that does not exist; it is created before the migrations run'
      : "names a role that could act as the schema's owner; it must be neither the schema migration role, nor a member of it, nor a superuser",
  );
};

const refuseForeignSchema = async (
  client: pg.ClientBase,
  schema: string,
): Promise<void> => {
  const { rows } = await client.query<{ ownedOrAbsent: boolean }>(
    'SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1 AND pg_get_userbyid(nspowner) <> current_user) AS "ownedOrAbsent"',
    [schema],
  );
  if (rows[0]?.ownedOrAbsent === true) {
    return;
  }
  throw new MigrationRefusal(
    'schema',
    'names a schema another role owns; the schema migration role must own it',
  );
};

const appliedMigrations = async (
  client: pg.ClientBase,
  schema: string,
): Promise<readonly AppliedMigration[]> => {
  const record = qualified(schema, RECORD_TABLE);
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [record],
  );
  if (rows[0]?.present === true) {
    const applied = await client.query<AppliedMigration>(
      `SELECT name, checksum FROM ${record} ORDER BY name COLLATE "C"`,
    );
    return applied.rows;
  }
  return [];
};

// The record is the runner's rather than a migration's, since it says which migrations have run.
const ensureRecord = async (
  client: pg.ClientBase,
  schema: string,
): Promise<void> => {
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, RECORD_TABLE)} (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
};

// Decide G: each migration runs in a transaction of its own, which records it, so a migration and
// its record commit together or not at all. The statements resolve their names in the schema, and
// the functions they create keep that search path, with the temporary schema last.
const applyMigration = async (
  client: pg.ClientBase,
  migration: Migration,
  names: MigrationNames,
): Promise<void> => {
  await client.query('BEGIN');
  try {
    await client.query(
      `SET LOCAL search_path TO ${pg.escapeIdentifier(names.schema)}, pg_temp`,
    );
    await client.query(substituteNames(migration.sql, names));
    await client.query(
      `INSERT INTO ${qualified(names.schema, RECORD_TABLE)} (name, checksum) VALUES ($1, $2)`,
      [migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    // A rollback failing too means the connection is gone, which ends the transaction anyway.
    await client.query('ROLLBACK').catch(() => undefined);
    throw new ControllerError(
      `the migration ${migration.name} failed, and none of it was applied`,
      { cause: error },
    );
  }
};

// Run again on an up-to-date database, this is all a run changes, and only when the floor differs. The
// floor is stored once the migration creating its table has applied, and the answer is whether it was.
const storeRetentionFloor = async (
  client: pg.ClientBase,
  schema: string,
  floorSeconds: number,
): Promise<boolean> => {
  const retention = qualified(schema, RETENTION_TABLE);
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [retention],
  );
  const present = rows[0]?.present === true;
  if (present) {
    await client.query(
      `INSERT INTO ${retention} AS stored (floor_seconds) VALUES ($1)
         ON CONFLICT (singleton) DO UPDATE SET floor_seconds = excluded.floor_seconds
         WHERE stored.floor_seconds IS DISTINCT FROM excluded.floor_seconds`,
      [floorSeconds],
    );
  }
  return present;
};

// The driver ends an attempt past its connection timeout with an error carrying no code, told from
// any other failure only by its message. So the run keeps a deadline of its own beside the driver's,
// set just before it for the same span and so passing first, and a failure to connect once it has
// passed is refused, laid on the URL.
const connectWithin = async (
  client: pg.Client,
  timeoutMilliseconds: number,
): Promise<void> => {
  const deadline = { passed: false };
  const timer = setTimeout(() => {
    deadline.passed = true;
  }, timeoutMilliseconds);
  try {
    await client.connect();
  } catch (failure) {
    throw deadline.passed
      ? new MigrationRefusal(
          'databaseUrl',
          `names an address at which no store answered within ${timeoutMilliseconds / 1000} seconds`,
        )
      : failure;
  } finally {
    clearTimeout(timer);
  }
};

interface RunSettings {
  floorSeconds: number;
  known: readonly Migration[];
  runtimeRole: string;
  schema: string;
  target: string | undefined;
  timeoutMilliseconds: number;
}

const migrateOn = async (
  client: pg.Client,
  {
    floorSeconds,
    known,
    runtimeRole,
    schema,
    target,
    timeoutMilliseconds,
  }: RunSettings,
  signal: AbortSignal | undefined,
): Promise<MigrationOutcome> => {
  await connectWithin(client, timeoutMilliseconds);
  // Ending the connection is the stop: whatever statement is in flight fails, and the session ends.
  const stop = (): void => {
    client.end().catch(() => undefined);
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    await refuseUnsupportedServer(client);
    await client.query(
      `SET client_connection_check_interval = ${CLIENT_CHECK_MILLISECONDS}`,
    );
    // Ending the session releases the lock, however the run ends.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await refuseUnsafeRuntimeRole(client, runtimeRole);
    await refuseForeignSchema(client, schema);
    const pending = pendingMigrations(
      known,
      await appliedMigrations(client, schema),
      target,
    );
    await ensureRecord(client, schema);
    await pending.reduce<Promise<void>>(async (earlier, migration) => {
      await earlier;
      await applyMigration(client, migration, { runtimeRole, schema });
    }, Promise.resolve());
    const stored = await storeRetentionFloor(client, schema, floorSeconds);
    return {
      applied: pending.map(({ name }) => name),
      ...(stored ? { retentionFloorSeconds: floorSeconds } : {}),
    };
  } finally {
    signal?.removeEventListener('abort', stop);
    await client.end();
  }
};

/**
 * Applies the controller's migrations to a database, through the target when one is named: the
 * schema migration command's work. Every refusal comes before anything is written. The run refuses
 * when no store answers at the URL within the connection timeout, when the runtime role does not
 * exist or could act as the schema's owner, when another role owns the schema, when the target
 * names no migration, and when the database records a migration this release does not hold, or
 * holds changed. A target already passed applies nothing. Each migration commits with its record,
 * so a failure keeps every migration before it. Last, the run stores the retention floor, which is
 * all a run on an up-to-date database changes. It settles once its connection has closed. The URL
 * is parsed rather than handed to the driver whole, since the driver lets a URL's own settings, its
 * empty password included, override any given beside it. Connecting and signing in are limited by
 * the connection timeout; statements are not. The run's session checks every second that its
 * connection is open, so once it closes, by a stop or by the process ending, the session ends too,
 * rolling back the migration in flight and releasing the run's lock.
 *
 * @param options the schema migration role's connection URL and password, the connection timeout,
 *   the retention floor, the runtime role, the schema, the signal stopping the run, and the target.
 * @returns the migrations the run applied, by name, and the retention floor it stored.
 * @throws {MigrationRefusal} laid on the URL when no store answered within the connection timeout,
 *   or on the runtime role or the schema at fault; otherwise naming the rule broken, or the migration
 *   that failed with the database's error as its cause, or the driver's own failure to connect. Once
 *   the signal aborts, whatever the run met, an error saying the run was stopped, with what it met
 *   as its cause.
 */
export const migrate = async (
  options: MigrationOptions,
): Promise<MigrationOutcome> => {
  const floorSeconds = checkedFloor(options.retentionFloorSeconds);
  const runtimeRole = checkedName('runtimeRole', options.runtimeRole);
  const schema = checkedName('schema', options.schema);
  const timeoutMilliseconds =
    options.connectionTimeoutMilliseconds ?? CONNECTION_TIMEOUT_MILLISECONDS;
  const known = await readMigrations();
  const { signal } = options;
  const client = new pg.Client({
    ...parseIntoClientConfig(options.databaseUrl),
    connectionTimeoutMillis: timeoutMilliseconds,
    ...(options.databasePassword === undefined
      ? {}
      : { password: options.databasePassword }),
  });
  // A connection lost mid-run fails the query made on it next; unheard, its error event would end the
  // process instead.
  client.on('error', () => undefined);
  try {
    signal?.throwIfAborted();
    return await migrateOn(
      client,
      {
        floorSeconds,
        known,
        runtimeRole,
        schema,
        target: options.target,
        timeoutMilliseconds,
      },
      signal,
    );
  } catch (failure) {
    throw signal?.aborted === true ? stoppedRun(failure) : failure;
  }
};
