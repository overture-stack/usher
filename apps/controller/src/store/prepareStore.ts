import type pg from 'pg';

import type { Actor, AuditTrail, AuditTransaction } from '../eventLog/index.js';
import { StartRefusal } from '../startRefusal.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
import {
  type GrantBeyondUse,
  grantsBeyondUse,
  privilegeProblems,
  readHeldPrivileges,
} from './rolePrivileges.js';
import type { StoreLog, StoreSettings } from './types.js';
import { writeSeededPolicy } from './writeSeededPolicy.js';

// Taken by every start for its transaction, so starts check and record one at a time; the migrations
// and the notice stream take keys of their own.
const START_LOCK = 8_617_207_003;

const SYSTEM: Actor = Object.freeze({ type: 'system' });

/** The line naming a grant the database role holds beyond the release's, which a start tolerates. */
export const GRANT_BEYOND_USE = 'store.grantBeyondUse';

// Checks the store and writes what a start writes, giving the grants beyond the release's that the
// start tolerates.
const prepareInTransaction = async (
  transaction: AuditTransaction<pg.ClientBase>,
  settings: StoreSettings,
): Promise<readonly GrantBeyondUse[]> => {
  const { connection } = transaction;
  await connection.query('SELECT pg_advisory_xact_lock($1)', [START_LOCK]);
  const held = await readHeldPrivileges(connection, settings.databaseSchema);
  const problems = privilegeProblems(held);
  if (problems.length > 0) {
    throw new StartRefusal(problems);
  }
  await checkKeyEncryptionKey(connection, settings);
  await writeSeededPolicy(transaction, settings);
  return grantsBeyondUse(held);
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
 * @param trail the audit trail over the controller's store connections.
 * @param settings the schema, the key-encryption key, the baseline, the signed-in rule and the clock.
 * @param log where each tolerated grant is written.
 * @throws {StartRefusal} naming the variable at fault, with nothing written.
 */
export const prepareStore = async <Connection extends pg.ClientBase>(
  trail: Pick<AuditTrail<Connection>, 'inTransaction'>,
  settings: StoreSettings,
  log: Pick<StoreLog, 'warning'>,
): Promise<void> => {
  const tolerated = await trail.inTransaction(SYSTEM, (transaction) =>
    prepareInTransaction(transaction, settings),
  );
  tolerated.forEach(({ column, object, privilege }) => {
    log.warning(GRANT_BEYOND_USE, {
      ...(column === undefined ? {} : { column }),
      object,
      privilege,
    });
  });
};
