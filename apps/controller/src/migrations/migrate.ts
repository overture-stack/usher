import pg from 'pg';

import { pendingMigrations } from './pendingMigrations.js';
import { readMigrations } from './readMigrations.js';
import { substituteNames } from './substituteNames.js';
import type {
  AppliedMigration,
  Migration,
  MigrationNames,
  MigrationOptions,
} from './types.js';

// Held by a run for its whole session, so two runs on one database apply each migration once. The
// notice stream takes a key of its own; the two never meet.
const MIGRATION_LOCK = 8_617_207_001;

// The retention floor's column is an `integer`.
const LARGEST_FLOOR_SECONDS = 2_147_483_647;

const RECORD_TABLE = 'schema_migrations';

const RETENTION_TABLE = 'notice_retention';

const refusal = (rule: string): Error =>
  new Error(`the migrations refuse to run: ${rule}`);

const qualified = (schema: string, table: string): string =>
  `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;

const checkedFloor = (seconds: number): number => {
  if (
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= LARGEST_FLOOR_SECONDS
  ) {
    return seconds;
  }
  throw refusal(
    `retentionFloorSeconds must be a whole number of seconds from 1 to ${LARGEST_FLOOR_SECONDS}`,
  );
};

const checkedName = (option: string, name: string): string => {
  if (name !== '') {
    return name;
  }
  throw refusal(`${option} must name an identifier`);
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
  throw refusal(
    role === undefined
      ? `the runtime role ${runtimeRole} does not exist; it is created before the migrations run`
      : `the runtime role ${runtimeRole} could act as the schema's owner; it must be neither the migration role, nor a member of it, nor a superuser`,
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
  throw refusal(
    `the schema ${schema} belongs to another role; the migration role must own it`,
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
    throw new Error(
      `the migration ${migration.name} failed, and none of it was applied`,
      { cause: error },
    );
  }
};

// Run again on an up-to-date database, this is all a run changes, and only when the floor differs.
const storeRetentionFloor = async (
  client: pg.ClientBase,
  schema: string,
  floorSeconds: number,
): Promise<void> => {
  const retention = qualified(schema, RETENTION_TABLE);
  const { rows } = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [retention],
  );
  if (rows[0]?.present === true) {
    await client.query(
      `INSERT INTO ${retention} AS stored (floor_seconds) VALUES ($1)
         ON CONFLICT (singleton) DO UPDATE SET floor_seconds = excluded.floor_seconds
         WHERE stored.floor_seconds IS DISTINCT FROM excluded.floor_seconds`,
      [floorSeconds],
    );
  }
};

/**
 * Applies the controller's migrations to a database, through the target when one is named: the
 * migration command's work. Every refusal comes before anything is written. The run refuses when
 * the runtime role does not exist or could act as the schema's owner, when another role owns the
 * schema, when the target names no migration, and when the database records a migration this release
 * does not hold, or holds changed. A target already passed applies nothing. Each migration commits
 * with its record, so a failure keeps every migration before it. Last, the run stores the retention
 * floor, which is all a run on an up-to-date database changes. It settles once its connection has
 * closed.
 *
 * @param options the migration role's connection URL, the retention floor, the runtime role, the
 *   schema and the target.
 * @throws naming the rule broken, or the migration that failed with the database's error as its cause.
 */
export const migrate = async (options: MigrationOptions): Promise<void> => {
  const floorSeconds = checkedFloor(options.retentionFloorSeconds);
  const runtimeRole = checkedName('runtimeRole', options.runtimeRole);
  const schema = checkedName('schema', options.schema);
  const known = await readMigrations();
  const client = new pg.Client({ connectionString: options.databaseUrl });
  // A connection lost mid-run fails the query made on it next; unheard, its error event would end the
  // process instead.
  client.on('error', () => undefined);
  await client.connect();
  try {
    // Ending the session releases the lock, however the run ends.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await refuseUnsafeRuntimeRole(client, runtimeRole);
    await refuseForeignSchema(client, schema);
    const pending = pendingMigrations(
      known,
      await appliedMigrations(client, schema),
      options.target,
    );
    await ensureRecord(client, schema);
    await pending.reduce<Promise<void>>(async (earlier, migration) => {
      await earlier;
      await applyMigration(client, migration, { runtimeRole, schema });
    }, Promise.resolve());
    await storeRetentionFloor(client, schema, floorSeconds);
  } finally {
    await client.end();
  }
};
