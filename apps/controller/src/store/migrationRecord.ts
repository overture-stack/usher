import pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { ControllerError, type StartProblem } from '../failures/index.js';
import type {
  AppliedMigration,
  UnknownMigration,
} from '../migrations/index.js';
import type { StoreReader } from '../storeTimeout/index.js';
import { MIGRATION_RECORD } from './rolePrivileges.js';

const UNDEFINED_TABLE = '42P01';

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Readiness's probe failing to read the record of applied migrations: the schema holds none, or the
 * database role may not read it. Its `code` is the cause readiness names it by; its message names
 * no value.
 */
export class MigrationRecordUnreadable extends ControllerError {
  readonly code = 'migrationRecordUnreadable';

  override readonly name = 'MigrationRecordUnreadable';

  constructor(options?: ErrorOptions) {
    super('the record of applied migrations cannot be read', options);
  }
}

// The record as one JSON array of each migration's name and checksum, in the order of their names,
// so it travels in one column beside anything else a statement reads.
const recordedMigrations = (schema: string): string =>
  `(SELECT coalesce(json_agg(json_build_object('checksum', checksum, 'name', name) ORDER BY name COLLATE "C"), '[]'::json) FROM ${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(MIGRATION_RECORD)})`;

const isUnreadableRecord = (failure: unknown): boolean =>
  failure instanceof pg.DatabaseError &&
  (failure.code === UNDEFINED_TABLE || failure.code === INSUFFICIENT_PRIVILEGE);

/**
 * Reads the migrations the schema records as applied, in the order of their names.
 *
 * @param connection the connection, or the pool's reader, to read on.
 * @param schema the controller's schema.
 * @throws {MigrationRecordUnreadable} when the store gives no answer.
 * @throws any failure of the statement, as it was thrown.
 */
export const readRecordedMigrations = async (
  connection: Pick<StoreReader, 'query'>,
  schema: string,
): Promise<readonly AppliedMigration[]> => {
  const [answer] = (
    await connection.query<{ recorded: AppliedMigration[] }>(
      `SELECT ${recordedMigrations(schema)} AS recorded`,
    )
  ).rows;
  if (answer === undefined) {
    throw new MigrationRecordUnreadable();
  }
  return answer.recorded;
};

/** What readiness's probe read of the store. */
export interface StoreProbeAnswer {
  /** Whether the session reads as read-only: true for any answer but `off`. */
  readOnly: boolean;

  /** The migrations the schema records as applied, in the order of their names. */
  recorded: readonly AppliedMigration[];
}

/**
 * Asks the store readiness's one statement: whether the session reads as read-only, and the
 * migrations the schema records as applied. Any answer but `off` reads as read-only, so a store
 * whose answer cannot be read never passes.
 *
 * @param reader the pool's reader, of readiness's own pool.
 * @param schema the controller's schema.
 * @throws {MigrationRecordUnreadable} when the schema holds no record, the database role may not
 *   read it, or the store gives no answer.
 * @throws any other failure of the statement, as it was thrown.
 */
export const readStoreProbe = async (
  reader: Pick<StoreReader, 'query'>,
  schema: string,
): Promise<StoreProbeAnswer> => {
  const { rows } = await reader
    .query<{ readOnly: string; recorded: AppliedMigration[] }>(
      `SELECT current_setting('transaction_read_only') AS "readOnly", ${recordedMigrations(schema)} AS recorded`,
    )
    .catch((failure: unknown) => {
      throw isUnreadableRecord(failure)
        ? new MigrationRecordUnreadable({ cause: failure })
        : failure;
    });
  const [answer] = rows;
  if (answer === undefined) {
    throw new MigrationRecordUnreadable();
  }
  return { readOnly: answer.readOnly !== 'off', recorded: answer.recorded };
};

const describedMigration = ({
  checksumDiffers,
  name,
}: UnknownMigration): string =>
  checksumDiffers ? `${name} (its checksum differs from this release's)` : name;

/**
 * The rule a start breaks while its database records migrations this release does not know, laid on
 * the schema's variable and naming each, saying of each this release holds that its checksum
 * differs.
 *
 * @param unknown the migrations, at least one, each named as a line may write it.
 */
export const unknownMigrationsProblem = (
  unknown: readonly UnknownMigration[],
): StartProblem => ({
  rule: `names a schema recording migrations this release does not know: ${unknown.map(describedMigration).join(', ')}`,
  variable: ENVIRONMENT_VARIABLES.databaseSchema,
});
