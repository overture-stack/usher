import type pg from 'pg';

import { StartRefusal } from '../startRefusal.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
import {
  type GrantBeyondUse,
  grantsBeyondUse,
  privilegeProblems,
  readHeldPrivileges,
} from './rolePrivileges.js';
import type { StoreLog, StoreSettings } from './types.js';

// Taken by every start for its transaction, so starts check and record one at a time; the migrations
// and the notice stream take keys of their own.
const START_LOCK = 8_617_207_003;

/** The line naming a grant the database role holds beyond the release's, which a start tolerates. */
export const GRANT_BEYOND_USE = 'store.grantBeyondUse';

// Checks the store, giving the grants beyond the release's that the start tolerates.
const checkStore = async (
  client: pg.ClientBase,
  settings: StoreSettings,
): Promise<readonly GrantBeyondUse[]> => {
  await client.query('SELECT pg_advisory_xact_lock($1)', [START_LOCK]);
  const held = await readHeldPrivileges(client, settings.databaseSchema);
  const problems = privilegeProblems(held);
  if (problems.length > 0) {
    throw new StartRefusal(problems);
  }
  await checkKeyEncryptionKey(client, settings);
  return grantsBeyondUse(held);
};

const checkedInTransaction = async (
  pool: pg.Pool,
  settings: StoreSettings,
): Promise<readonly GrantBeyondUse[]> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tolerated = await checkStore(client, settings);
    await client.query('COMMIT');
    client.release();
    return tolerated;
  } catch (error) {
    // A connection that cannot roll back is gone, and is dropped rather than returned to the pool.
    const rolledBack = await client.query('ROLLBACK').then(
      () => true,
      () => false,
    );
    client.release(!rolledBack);
    throw error;
  }
};

/**
 * Checks the store before the controller serves from it, in one transaction holding the lock every
 * start takes: the database role holds what the controller needs and nothing beyond, and the
 * key-encryption key is the one the store's first start recorded, recorded now when none is. A start
 * on a role that may only read writes nothing, and is refused only when it would have to. Once the
 * check commits, each grant the role holds beyond the release's, which the start tolerates, is
 * written to the log at warning as {@link GRANT_BEYOND_USE}, carrying its `privilege`, its `object`
 * and, for a grant on one column, its `column`, so a reader matches any of them without parsing a
 * sentence.
 *
 * @param pool the controller's store connections.
 * @param settings the schema, the key-encryption key and the clock.
 * @param log where each tolerated grant is written.
 * @throws {StartRefusal} naming the variable at fault, with nothing written.
 */
export const prepareStore = async (
  pool: pg.Pool,
  settings: StoreSettings,
  log: Pick<StoreLog, 'warning'>,
): Promise<void> => {
  const tolerated = await checkedInTransaction(pool, settings);
  tolerated.forEach(({ column, object, privilege }) => {
    log.warning(GRANT_BEYOND_USE, {
      ...(column === undefined ? {} : { column }),
      object,
      privilege,
    });
  });
};
