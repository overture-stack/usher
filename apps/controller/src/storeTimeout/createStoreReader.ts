import type pg from 'pg';

import type { ConnectionPool, StoreReader } from './types.js';
import { withinStoreTimeout } from './withinStoreTimeout.js';

/**
 * Creates the reader the Controller reads the store through outside any transaction: each statement
 * runs as a unit of its own on a pooled connection, within the store timeout, as
 * {@link withinStoreTimeout} runs one. A connection is returned to the pool once its statement is
 * answered, and discarded once it fails or the timeout runs out.
 *
 * @param pool the Controller's pool of store connections.
 * @param timeoutMilliseconds the store timeout.
 */
export const createStoreReader = (
  pool: ConnectionPool<pg.PoolClient>,
  timeoutMilliseconds: number,
): StoreReader => ({
  query: <Row extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>> =>
    withinStoreTimeout(pool, timeoutMilliseconds, ({ connection }) =>
      connection.query<Row>(text, values === undefined ? values : [...values]),
    ),
});
