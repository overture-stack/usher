import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import type { ControllerConfiguration } from '../configuration/index.js';

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

/**
 * Opens the controller's pool of store connections, connecting none until a query needs one.
 *
 * @param configuration the connection URL and the password.
 */
export const openStore = (
  configuration: Pick<
    ControllerConfiguration,
    'databasePassword' | 'databaseUrl'
  >,
): pg.Pool => {
  const pool = new pg.Pool(storeConnection(configuration));
  // An idle connection lost, as when the store restarts, is replaced at the next query; unheard, its
  // error would end the process instead.
  pool.on('error', () => undefined);
  return pool;
};
