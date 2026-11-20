import pg from 'pg';

import type { StoreReader } from '../storeTimeout/index.js';
import type { UsedAssertions } from './types.js';

/**
 * Creates the record of the channel assertions presented to the notice stream. The store holds it, so
 * an assertion opens at most one stream across every Controller instance sharing that store. Each
 * record is one insert, ignoring a conflict, run within the store timeout; it answers whether the insert
 * wrote the row, and rejects when the store does not answer. A row is deleted by the retention sweep
 * once its assertion has stopped being accepted for longer than the clock tolerance.
 *
 * @param store the reader every statement runs through, within the store timeout.
 * @param schema the Controller's schema.
 */
export const createUsedAssertions = (store: StoreReader, schema: string): UsedAssertions => {
	const insert = `INSERT INTO ${pg.escapeIdentifier(schema)}.used_channel_assertions (application_id, assertion_id, accepted_until)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING`;
	return {
		record: async (applicationId, id, acceptedUntil) => {
			const { rowCount } = await store.query(insert, [applicationId, id, new Date(acceptedUntil)]);
			return rowCount === 1;
		},
	};
};
