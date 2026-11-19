import type pg from 'pg';

import type { AuditTransaction } from '../eventLog/index.js';
import { seedVocabulary } from './seedVocabulary.js';
import type { SeededPolicySettings } from './types.js';

/**
 * Writes the policy every start seeds from code: the capability vocabulary and the seeded roles the store
 * lacks. A store holding all of them is written nothing. Run it in a transaction the audit trail holds as
 * the system, while holding the lock every start takes.
 *
 * @param transaction the transaction, its actor declared.
 * @param settings the schema and the clock.
 * @throws {StartRefusal} naming the database URL's variable when something must be written and the
 *   database role may not write it.
 */
export const writeSeededPolicy = async (
	transaction: AuditTransaction<pg.ClientBase>,
	settings: SeededPolicySettings,
): Promise<void> => {
	await seedVocabulary(transaction.connection, settings.databaseSchema);
};
