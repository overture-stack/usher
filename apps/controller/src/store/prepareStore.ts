import type pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type {
  Actor,
  AuditTrail,
  AuditTransaction,
  EventLog,
} from '../eventLog/index.js';
import { type StartProblem, StartRefusal } from '../failures/index.js';
import {
  type Migration,
  MIGRATION_UNKNOWN,
  migrationUnknownFields,
  unknownMigrations,
} from '../migrations/index.js';
import {
  CommitUnconfirmed,
  type StoreReader,
  StoreTimeout,
} from '../storeTimeout/index.js';
import { connectionProblemOf } from './connectionProblemOf.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
import {
  readRecordedMigrations,
  unknownMigrationsProblem,
} from './migrationRecord.js';
import {
  type GrantBeyondUse,
  grantsBeyondUse,
  privilegeProblems,
  readHeldPrivileges,
  writesTables,
} from './rolePrivileges.js';
import {
  readStatementLimits,
  statementLimitProblems,
} from './statementLimits.js';
import type { PreparedStore, StoreSettings } from './types.js';
import { writeSeededPolicy } from './writeSeededPolicy.js';

// Taken by every start for its transaction, so starts check and record one at a time; the migrations
// and the notice stream take keys of their own.
const START_LOCK = 8_617_207_003;

const SYSTEM: Actor = Object.freeze({ type: 'system' });

/** The line naming a grant the database role holds beyond the release's, which a start tolerates. */
export const GRANT_BEYOND_USE = 'store.grantBeyondUse';

// The store's answering in time is a property of the store the URL names; the timeout is named in the
// rule, so a timeout set too low is still found from the refusal.
const UNANSWERED: StartProblem = {
  rule: `names a store that did not answer the start within the time ${ENVIRONMENT_VARIABLES.storeTimeoutMilliseconds} allows`,
  variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

// A start whose writes may or may not have committed cannot serve on them.
const UNCONFIRMED: StartProblem = {
  rule: `names a store that did not confirm the start's commit within the time ${ENVIRONMENT_VARIABLES.storeTimeoutMilliseconds} allows`,
  variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

interface Prepared {
  tolerated: readonly GrantBeyondUse[];
  writes: boolean;
}

// What the start's transaction is given beside its settings: the release's migrations, and where
// the migrations it refuses are written.
interface StartContext {
  log: Pick<EventLog, 'error'>;
  migrations: readonly Migration[];
}

// Refuses a store recording a migration this release does not know, read before any other table of
// the schema, since a later release may record what this one never reads.
const refuseUnknownMigrations = async (
  connection: pg.ClientBase,
  schema: string,
  { log, migrations }: StartContext,
): Promise<void> => {
  const unknown = unknownMigrations(
    migrations,
    await readRecordedMigrations(connection, schema),
  );
  if (unknown.length > 0) {
    log.error(MIGRATION_UNKNOWN, migrationUnknownFields(unknown, 'start'));
    throw new StartRefusal([unknownMigrationsProblem(unknown)]);
  }
};

// Checks the store and writes what a start writes, giving the grants beyond the release's that the
// start tolerates and whether the role writes.
const prepareInTransaction = async (
  transaction: AuditTransaction<pg.ClientBase>,
  settings: StoreSettings,
  context: StartContext,
): Promise<Prepared> => {
  const { connection } = transaction;
  await connection.query('SELECT pg_advisory_xact_lock($1)', [START_LOCK]);
  const limits = await readStatementLimits(connection);
  const held = await readHeldPrivileges(connection, settings.databaseSchema);
  const problems = [
    ...statementLimitProblems(limits, settings.storeTimeoutMilliseconds),
    ...privilegeProblems(held),
  ];
  if (problems.length > 0) {
    throw new StartRefusal(problems);
  }
  await refuseUnknownMigrations(connection, settings.databaseSchema, context);
  await checkKeyEncryptionKey(connection, settings);
  await writeSeededPolicy(transaction, settings);
  return { tolerated: grantsBeyondUse(held), writes: writesTables(held) };
};

// The refusal a failure of the start's transaction earns, or the failure itself when it is no fault of
// a variable's.
const refusalFor = (failure: unknown): unknown => {
  if (failure instanceof StoreTimeout) {
    return new StartRefusal([UNANSWERED]);
  }
  if (failure instanceof CommitUnconfirmed) {
    return new StartRefusal([UNCONFIRMED]);
  }
  const problem = connectionProblemOf(failure);
  return problem === undefined ? failure : new StartRefusal([problem]);
};

/**
 * Checks the store and writes what a start writes before the Controller serves from it, in one
 * transaction the audit trail holds as the system, taking first the lock every start takes, so
 * starts check and write one at a time. The database role must hold what the Controller needs and
 * nothing beyond, reading the record of applied migrations among what it needs. That record is read
 * before any other table of the schema and must hold no migration this release does not know: none
 * that `migrations` lacks, and none whose checksum differs from this release's file. A migration of
 * this release the record lacks is no such migration. Next, the key-encryption key must match its
 * fingerprint recorded at the store's first start, recorded now when none is. Then the start writes
 * the policy it seeds: the capability vocabulary and the seeded roles the store lacks, and the
 * digest of the baseline and the signed-in rule when it differs from the one recorded, with its
 * `baseline.change` event, whose line the trail writes once the transaction commits. A start on a
 * role that may only read writes nothing, and is refused only when it would have to. Once the
 * transaction commits, each grant the role holds beyond the release's, which the start tolerates,
 * is written to the log at warning as {@link GRANT_BEYOND_USE}, carrying its `privilege`, its
 * `object` and, for a grant on one column, its `column`, so a reader matches any of them without
 * parsing a sentence.
 *
 * The start is refused, naming the database URL, when its connection's session lacks either limit
 * the Controller sets to the store timeout, when the store does not answer the transaction within
 * the store timeout, or when it does not confirm the transaction's `COMMIT` within one more. It is
 * refused naming the schema's variable when the schema holds no record of applied migrations or the
 * role may not read it, the rule sending the operator to the schema migration command; and when the
 * record holds migrations this release does not know, the rule naming each and saying of each this
 * release holds that its checksum differs, once they are written at error as
 * {@link MIGRATION_UNKNOWN} with `refused` `start`. A recorded name is written only in migration
 * form, and any other as a fixed phrase. A store the start cannot reach or sign in to refuses it
 * too, naming the variable at fault by the failure's kind: the password for a password the store
 * refuses, the database URL otherwise.
 *
 * @param trail the audit trail over the Controller's store connections.
 * @param settings the schema, the key-encryption key, the baseline, the signed-in rule, the clock and
 *   the store timeout.
 * @param log where the migrations the start refuses, and each tolerated grant, are written.
 * @param migrations this release's migrations, as read from its migrations folder.
 * @returns whether the database role writes, so the instance serves writes.
 * @throws {StartRefusal} naming the variable at fault, with nothing written but for a `COMMIT` the
 *   store did not confirm.
 */
export const prepareStore = async <Connection extends pg.ClientBase>(
  trail: Pick<AuditTrail<Connection>, 'inTransaction'>,
  settings: StoreSettings,
  log: Pick<EventLog, 'error' | 'warning'>,
  migrations: readonly Migration[],
): Promise<PreparedStore> => {
  const { tolerated, writes } = await trail
    .inTransaction(SYSTEM, (transaction) =>
      prepareInTransaction(transaction, settings, { log, migrations }),
    )
    .catch((failure: unknown) => {
      throw refusalFor(failure);
    });
  tolerated.forEach(({ column, object, privilege }) => {
    log.warning(GRANT_BEYOND_USE, {
      ...(column === undefined ? {} : { column }),
      object,
      privilege,
    });
  });
  return { writes };
};

/**
 * Checks, at the Controller's start, that the store applies both of the Controller's limits to the
 * sessions of one more of its pools, as {@link prepareStore} checks them on the pool its transaction
 * runs on, so a pool reaching the store through a pooler that drops them is found before anything
 * listens. The limits are read in one statement, as a unit of its own within the store timeout.
 *
 * @param reader the pool's reader.
 * @param settings the store timeout each limit must equal.
 * @throws {StartRefusal} naming the database URL when either limit is missing or differs, or when
 *   the store does not answer within the store timeout; naming the variable at fault when the store
 *   cannot be reached or signed in to.
 * @throws any other failure of the read, as it was thrown.
 */
export const checkStatementLimits = async (
  reader: Pick<StoreReader, 'query'>,
  settings: Pick<StoreSettings, 'storeTimeoutMilliseconds'>,
): Promise<void> => {
  const limits = await readStatementLimits(reader).catch((failure: unknown) => {
    throw refusalFor(failure);
  });
  const problems = statementLimitProblems(
    limits,
    settings.storeTimeoutMilliseconds,
  );
  if (problems.length > 0) {
    throw new StartRefusal(problems);
  }
};
