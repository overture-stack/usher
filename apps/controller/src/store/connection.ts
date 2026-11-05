import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import type { ControllerConfiguration } from '../configuration/index.js';
import type { StoreLog } from './types.js';

/**
 * How the controller connects to its store: the connection URL's settings, with the password from
 * its own variable over them. The URL is parsed rather than handed to the driver whole, since the
 * driver lets a URL's own settings, its empty password included, override any given beside it.
 *
 * @param configuration the connection URL and the password.
 */
export const storeConnection = ({
  databasePassword,
  databaseUrl,
}: Pick<
  ControllerConfiguration,
  'databasePassword' | 'databaseUrl'
>): pg.PoolConfig => ({
  ...parseIntoClientConfig(databaseUrl),
  password: databasePassword,
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
 * Opens the controller's pool of store connections, connecting none until a query needs one. An idle
 * connection lost, as when the store restarts, is written to the log at error as
 * {@link IDLE_CONNECTION_LOST}, naming the failure by its code where it has one, and is replaced at
 * the next query.
 *
 * @param configuration the connection URL and the password.
 * @param log where the loss is written.
 */
export const openStore = (
  configuration: Pick<
    ControllerConfiguration,
    'databasePassword' | 'databaseUrl'
  >,
  log: Pick<StoreLog, 'error'>,
): pg.Pool => {
  const pool = new pg.Pool(storeConnection(configuration));
  // Unheard, an idle connection's error would end the process.
  pool.on('error', (error) => {
    log.error(IDLE_CONNECTION_LOST, failureOf(error));
  });
  return pool;
};
