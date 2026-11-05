import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import type { StoreConnectionSettings, StoreLog } from './types.js';

/**
 * How the controller connects to its store: the connection URL's settings, with the password from
 * its own variable and the store timeout's limits over them. The URL is parsed rather than handed to
 * the driver whole, since the driver lets a URL's own settings, its empty password included, override
 * any given beside it. The store timeout limits how long the pool waits to hand out a connection, and,
 * on the server, how long any one statement runs and how long a session waits idle inside a
 * transaction, so a statement or transaction whose client has gone holds its locks no longer than the
 * store timeout.
 *
 * @param configuration the connection URL, the password and the store timeout.
 */
export const storeConnection = ({
  databasePassword,
  databaseUrl,
  storeTimeoutMilliseconds,
}: StoreConnectionSettings): pg.PoolConfig => ({
  ...parseIntoClientConfig(databaseUrl),
  connectionTimeoutMillis: storeTimeoutMilliseconds,
  idle_in_transaction_session_timeout: storeTimeoutMilliseconds,
  password: databasePassword,
  statement_timeout: storeTimeoutMilliseconds,
});

/** The line naming an idle connection the pool lost. */
export const IDLE_CONNECTION_LOST = 'store.idleConnectionLost';

// The failure by its code alone, a SQLSTATE or a system error's, where it carries one. A message is
// left out with every other member of the error, since a server's message or detail may hold a value
// from the store, and no database error text reaches a line.
const failureOf = (error: Error): Readonly<Record<string, string>> => {
  const code: unknown = 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? { code } : {};
};

/**
 * Opens the controller's pool of store connections, connecting none until a query needs one, each
 * connection limited as {@link storeConnection} gives. An idle connection lost, as when the store
 * restarts, is written to the log at error as {@link IDLE_CONNECTION_LOST}, naming the failure by its
 * code where it has one, and is replaced at the next query.
 *
 * @param configuration the connection URL, the password and the store timeout.
 * @param log where the loss is written.
 */
export const openStore = (
  configuration: StoreConnectionSettings,
  log: Pick<StoreLog, 'error'>,
): pg.Pool => {
  const pool = new pg.Pool(storeConnection(configuration));
  // Unheard, an idle connection's error would end the process.
  pool.on('error', (error) => {
    log.error(IDLE_CONNECTION_LOST, failureOf(error));
  });
  return pool;
};
