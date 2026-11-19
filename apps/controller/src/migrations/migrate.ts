import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import { SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { ControllerError, StartRefusal } from '../failures/index.js';
import {
  type Settings,
  readSeedFile,
  readSeedMembers,
} from '../settings/index.js';
import { compareSeed } from './compareSeed.js';
import {
  MIGRATIONS_REFUSE_TO_RUN,
  MigrationRefusal,
} from './migrationRefusal.js';
import { pendingMigrations } from './pendingMigrations.js';
import { readMigrations } from './readMigrations.js';
import { substituteNames } from './substituteNames.js';
import { seedSettings } from './seedSettings.js';
import type {
  AppliedMigration,
  Migration,
  MigrationNames,
  MigrationOptions,
  MigrationOutcome,
  SeedFile,
  SeedFileOutcome,
} from './types.js';

// Held by a run for its whole session, so two runs on one database apply each migration once. The
// notice stream takes a key of its own; the two never meet.
const MIGRATION_LOCK = 8_617_207_001;

const CONNECTION_TIMEOUT_MILLISECONDS = 30_000;

// A session waiting on a lock, or running a statement, learns that its client has gone only when it
// next answers, unless it checks. Checking every second, a run's session ends within a second of
// its connection closing, however the run ended, rolling back the migration in flight and releasing
// the run's lock.
const CLIENT_CHECK_MILLISECONDS = 1000;

const RECORD_TABLE = 'schema_migrations';

const SETTINGS_TABLE = 'settings';

const refusal = (rule: string): ControllerError =>
  new ControllerError(`${MIGRATIONS_REFUSE_TO_RUN}: ${rule}`);

const stoppedRun = (cause: unknown): ControllerError =>
  new ControllerError(
    'the run was stopped, and every migration it committed before the stop stays applied',
    { cause },
  );

const qualified = (schema: string, table: string): string =>
  `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;

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

// Decide H: the runtime role holds only the privileges the migrations and the run grant it, so it
// must be a role of its own that cannot act as the schema's owner.
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
// The Controller reads it before anything else in the schema, so every run grants the runtime role
// reading it, not only the run creating it.
const ensureRecord = async (
  client: pg.ClientBase,
  { runtimeRole, schema }: MigrationNames,
): Promise<void> => {
  const record = qualified(schema, RECORD_TABLE);
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${record} (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await client.query(
    `GRANT SELECT ON ${record} TO ${pg.escapeIdentifier(runtimeRole)}`,
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

// Whether the schema holds the settings table, which a migration creates and a first run seeds.
const settingsTablePresent = async (
  client: pg.ClientBase,
  schema: string,
): Promise<boolean> => {
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [qualified(schema, SETTINGS_TABLE)],
  );
  return rows[0]?.present === true;
};

// Whether the settings table holds any setting: a run is a first run, which seeds them, when it does not.
const settingsStored = async (
  client: pg.ClientBase,
  schema: string,
): Promise<boolean> => {
  if (!(await settingsTablePresent(client, schema))) {
    return false;
  }
  const stored = await client.query<{ stored: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${qualified(schema, SETTINGS_TABLE)}) AS stored`,
  );
  return stored.rows[0]?.stored === true;
};

// A refusal laid on the seed file, naming the variable that sets its path and never a value.
const seedRefusal = (rules: readonly string[]): StartRefusal =>
  new StartRefusal(
    rules.map((rule) => ({
      rule,
      variable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    })),
    MIGRATIONS_REFUSE_TO_RUN,
  );

// A first run seeds from the file it reads, so a file absent, unreadable, or one that breaks a rule, refuses the run
// before anything is written, naming the variable that sets its path and never a value.
const firstRunSeed = (
  file: SeedFile,
): { members: Readonly<Record<string, unknown>>; settings: Settings } => {
  if (file.kind === 'absent') {
    throw new MigrationRefusal('seedFile', 'is missing, which a first run needs');
  }
  if (file.kind === 'unreadable') {
    throw new MigrationRefusal('seedFile', `cannot be read (${file.reason})`);
  }
  const members = readSeedMembers(file.text);
  if (members.kind === 'refused') {
    throw seedRefusal([members.rule]);
  }
  const reading = readSeedFile(file.text);
  if (reading.kind === 'refused') {
    throw seedRefusal(reading.rules);
  }
  return { members: members.members, settings: reading.settings };
};

// A later run compares the file it reads with the members the first run stored, changing nothing. A file that cannot
// be read, or is not one JSON object, is named in the outcome and never refuses the run.
const compareLaterSeed = async (
  client: pg.ClientBase,
  schema: string,
  file: SeedFile,
): Promise<SeedFileOutcome> => {
  if (file.kind === 'absent') {
    return { kind: 'absent' };
  }
  if (file.kind === 'unreadable') {
    return { kind: 'unreadable', reason: file.reason };
  }
  const members = readSeedMembers(file.text);
  return members.kind === 'refused'
    ? { kind: 'invalid', problem: members.rule }
    : compareSeed(client, schema, members.members);
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
  seed: () => Promise<SeedFile>;
  clock: MigrationOptions['clock'];
  eventLog: MigrationOptions['eventLog'];
  known: readonly Migration[];
  runtimeRole: string;
  schema: string;
  target: string | undefined;
  timeoutMilliseconds: number;
}

const migrateOn = async (
  client: pg.Client,
  {
    seed,
    clock,
    eventLog,
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
    const firstRun = !(await settingsStored(client, schema));
    const file = await seed();
    const loaded = firstRun ? firstRunSeed(file) : undefined;
    await ensureRecord(client, { runtimeRole, schema });
    await pending.reduce<Promise<void>>(async (earlier, migration) => {
      await earlier;
      await applyMigration(client, migration, { runtimeRole, schema });
    }, Promise.resolve());
    if (loaded !== undefined && (await settingsTablePresent(client, schema))) {
      await seedSettings(client, {
        clock,
        eventLog,
        members: loaded.members,
        schema,
        settings: loaded.settings,
      });
      return {
        applied: pending.map(({ name }) => name),
        seedFile: { kind: 'seeded' },
        settingsSeeded: true,
      };
    }
    const seedFile: SeedFileOutcome = firstRun
      ? { kind: 'absent' }
      : await compareLaterSeed(client, schema, file);
    return {
      applied: pending.map(({ name }) => name),
      seedFile,
      settingsSeeded: false,
    };
  } finally {
    signal?.removeEventListener('abort', stop);
    await client.end();
  }
};

/**
 * Applies the Controller's migrations to a database, through the target when one is named: the
 * schema migration command's work. Every refusal comes before anything is written. The run refuses
 * when no store answers at the URL within the connection timeout, when the runtime role does not
 * exist or could act as the schema's owner, when another role owns the schema, when the target
 * names no migration, and when the database records a migration this release does not hold, or
 * holds changed. Then it creates the record of applied migrations when the schema lacks one, and
 * grants the runtime role reading it, which the Controller's start requires. A target already
 * passed applies nothing. Each migration commits with its record, so a failure keeps every
 * migration before it. On a first run, one that finds no settings in the schema, the run reads the
 * seed file before writing anything, and seeds every setting once its migrations have applied, storing the
 * file's members as the seed row, with the event recording the seeding. A later run reads the file when one is at
 * its path and compares its members with the stored ones, changing nothing, so on an up-to-date database it
 * changes nothing but the record's grant. A later run's file that cannot be read, or is not one JSON object, is named
 * in the outcome and never refuses the run. It settles once its connection has closed.
 * The URL is parsed rather than handed to the driver whole, since the driver lets a URL's own
 * settings, its empty password included, override any given beside it. Connecting and signing in
 * are limited by the connection timeout; statements are not. The run's session checks every second
 * that its connection is open, so once it closes, by a stop or by the process ending, the session
 * ends too, rolling back the migration in flight and releasing the run's lock.
 *
 * @param options the schema migration role's connection URL and password, the connection timeout,
 *   the seed file's reader, the clock and the event log, the runtime role, the schema, the signal
 *   stopping the run, and the target.
 * @returns the migrations the run applied, by name, and whether it seeded the settings.
 * @throws {MigrationRefusal} laid on the URL when no store answered within the connection timeout,
 *   or on the runtime role or the schema at fault; otherwise naming the rule broken, or the migration
 *   that failed with the database's error as its cause, or the driver's own failure to connect. Once
 *   the signal aborts, whatever the run met, an error saying the run was stopped, with what it met
 *   as its cause.
 */
export const migrate = async (
  options: MigrationOptions,
): Promise<MigrationOutcome> => {
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
        seed: options.seed,
        clock: options.clock,
        eventLog: options.eventLog,
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
