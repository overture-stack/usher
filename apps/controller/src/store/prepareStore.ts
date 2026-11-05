import type pg from 'pg';

import { StartRefusal } from '../startRefusal.js';
import { checkKeyEncryptionKey } from './keyEncryptionKeyCheck.js';
import { privilegeProblems, readHeldPrivileges } from './rolePrivileges.js';
import type { StoreSettings } from './types.js';

// Taken by every start for its transaction, so starts check and record one at a time; the migrations
// and the notice stream take keys of their own.
const START_LOCK = 8_617_207_003;

const checkStore = async (
  client: pg.ClientBase,
  settings: StoreSettings,
): Promise<void> => {
  await client.query('SELECT pg_advisory_xact_lock($1)', [START_LOCK]);
  const problems = privilegeProblems(
    await readHeldPrivileges(client, settings.databaseSchema),
  );
  if (problems.length > 0) {
    throw new StartRefusal(problems);
  }
  await checkKeyEncryptionKey(client, settings);
};

/**
 * Checks the store before the controller serves from it, in one transaction holding the lock every
 * start takes: the database role holds what the controller needs and nothing beyond, and the
 * key-encryption key is the one the store's first start recorded, recorded now when none is. A start
 * on a role that may only read writes nothing, and is refused only when it would have to.
 *
 * @param pool the controller's store connections.
 * @param settings the schema, the key-encryption key and the clock.
 * @throws {StartRefusal} naming the variable at fault, with nothing written.
 */
export const prepareStore = async (
  pool: pg.Pool,
  settings: StoreSettings,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await checkStore(client, settings);
    await client.query('COMMIT');
    client.release();
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
