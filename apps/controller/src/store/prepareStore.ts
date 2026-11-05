import type pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { Actor, AuditTrail, AuditTransaction } from '../eventLog/index.js';
import { type StartProblem, StartRefusal } from '../startRefusal.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import { connectionProblemOf } from './connectionProblems.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
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
import type { PreparedStore, StoreLog, StoreSettings } from './types.js';
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

// Checks the store and writes what a start writes, giving the grants beyond the release's that the
// start tolerates and whether the role writes.
const prepareInTransaction = async (
  transaction: AuditTransaction<pg.ClientBase>,
  settings: StoreSettings,
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
 * Checks the store and writes what a start writes before the controller serves from it, in one
 * transaction the audit trail holds as the system, taking first the lock every start takes, so starts
 * check and write one at a time. The database role must hold what the controller needs and nothing
 * beyond, and the key-encryption key must be the one the store's first start recorded, recorded now
 * when none is. Then the start writes the policy it seeds: the capability vocabulary and the seeded
 * roles the store lacks, and the digest of the baseline and the signed-in rule when it differs from the
 * one recorded, with its `baseline.change` event, whose line the trail writes once the transaction
 * commits. A start on a role that may only read writes nothing, and is refused only when it would have
 * to. Once the transaction commits, each grant the role holds beyond the release's, which the start
 * tolerates, is written to the log at warning as {@link GRANT_BEYOND_USE}, carrying its `privilege`,
 * its `object` and, for a grant on one column, its `column`, so a reader matches any of them without
 * parsing a sentence.
 *
 * The start is refused, naming the database URL, when its connection's session lacks either limit the
 * controller sets to the store timeout, when the store does not answer the transaction within the
 * store timeout, or when it does not confirm the transaction's `COMMIT` within one more. A store the
 * start cannot reach or sign in to refuses it too, naming the variable at fault by the failure's
 * kind: the password for a password the store refuses, the database URL otherwise.
 *
 * @param trail the audit trail over the controller's store connections.
 * @param settings the schema, the key-encryption key, the baseline, the signed-in rule, the clock and
 *   the store timeout.
 * @param log where each tolerated grant is written.
 * @returns whether the database role writes, so the instance serves writes.
 * @throws {StartRefusal} naming the variable at fault, with nothing written but for a `COMMIT` the
 *   store did not confirm.
 */
export const prepareStore = async <Connection extends pg.ClientBase>(
  trail: Pick<AuditTrail<Connection>, 'inTransaction'>,
  settings: StoreSettings,
  log: Pick<StoreLog, 'warning'>,
): Promise<PreparedStore> => {
  const { tolerated, writes } = await trail
    .inTransaction(SYSTEM, (transaction) =>
      prepareInTransaction(transaction, settings),
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
