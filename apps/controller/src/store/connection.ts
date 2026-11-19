import type { ConnectionOptions } from 'node:tls';

import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { readCaFile } from './caFile.js';
import type { StoreConnectionSettings, StoreLog } from './types.js';

/** The line written by a start allowed a database connection that does not verify the server it reaches. */
export const UNVERIFIED_CONNECTION_ALLOWED = 'store.unverifiedConnectionAllowed';

/** The CA certificates for verifying a connection's server, read as the connection opens. */
export type CaCertificates = () => string | string[];

// TLS options whose CA certificates are read as each connection opens rather than once: for every
// connection's TLS handshake, the driver copies these options' own members into that handshake's
// options, so a getter among them is read at each one.
const readAtEachConnection = (ssl: ConnectionOptions, caCertificates: CaCertificates): ConnectionOptions =>
	Object.defineProperty({ ...ssl }, 'ca', {
		enumerable: true,
		get: caCertificates,
	});

/**
 * How the Controller connects to its store: the connection URL's settings, with the password from
 * its own variable and the store timeout's limits over them. The URL is parsed rather than handed to
 * the driver whole, since the driver lets a URL's own settings, its empty password included, override
 * any given beside it. The store timeout limits how long the pool waits to hand out a connection, and,
 * on the server, how long any one statement runs and how long a session waits idle inside a
 * transaction, so a statement or transaction whose client has gone holds its locks no longer than the
 * store timeout. Where CA certificates are given, every connection opening over TLS verifies its
 * server against them as they are read at that moment, not as they were when the URL was parsed.
 *
 * @param configuration the connection URL, the password and the store timeout.
 * @param caCertificates the CA certificates named by `sslrootcert`, read as each connection opens.
 */
export const storeConnection = (
	{ databasePassword, databaseUrl, storeTimeoutMilliseconds }: StoreConnectionSettings,
	caCertificates?: CaCertificates,
): pg.PoolConfig => {
	const parsed = parseIntoClientConfig(databaseUrl);
	const { ssl } = parsed;
	return {
		...parsed,
		...(caCertificates !== undefined && typeof ssl === 'object'
			? { ssl: readAtEachConnection(ssl, caCertificates) }
			: {}),
		connectionTimeoutMillis: storeTimeoutMilliseconds,
		idle_in_transaction_session_timeout: storeTimeoutMilliseconds,
		password: databasePassword,
		statement_timeout: storeTimeoutMilliseconds,
	};
};

/**
 * The CA file named in `sslrootcert` by the Controller's database URL, as the driver's own parser
 * reads it, read again as each connection opens, as {@link readCaFile} reads it, its lines naming
 * `USHER_DATABASE_URL`; none for a URL naming no CA file, whose connections verify against the
 * public CA certificates Node.js holds, if they verify at all.
 *
 * @param configuration the connection URL.
 * @param log where a change to the file, or its becoming unreadable, is written.
 */
export const databaseCaFile = (
	{ databaseUrl }: Pick<StoreConnectionSettings, 'databaseUrl'>,
	log: Pick<StoreLog, 'error' | 'warning'>,
): CaCertificates | undefined => {
	const parsed: Readonly<Record<string, unknown>> = {
		...parseIntoClientConfig(databaseUrl),
	};
	const path = parsed['sslrootcert'];
	return typeof path === 'string' && path !== ''
		? readCaFile(path, { log, variable: ENVIRONMENT_VARIABLES.databaseUrl })
		: undefined;
};

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
 * Opens one of the Controller's pools of store connections, holding at most the connections given and
 * connecting none until a query needs one, each connection limited as {@link storeConnection} gives,
 * so every pool carries the same limits, and verifying its server against the CA certificates given
 * as they are read when it opens. An idle connection lost, as when the store restarts, is written to
 * the log at error as {@link IDLE_CONNECTION_LOST}, naming the failure by its code where it has one,
 * and is replaced at the next query.
 *
 * @param configuration the connection URL, the password and the store timeout.
 * @param log where the loss is written.
 * @param connections the most connections the pool holds at once.
 * @param caCertificates the CA certificates named by `sslrootcert`, as {@link databaseCaFile} reads
 *   them.
 */
export const openStore = (
	configuration: StoreConnectionSettings,
	log: Pick<StoreLog, 'error'>,
	connections: number,
	caCertificates?: CaCertificates,
): pg.Pool => {
	const pool = new pg.Pool({
		...storeConnection(configuration, caCertificates),
		max: connections,
	});
	// Unheard, an idle connection's error would end the process.
	pool.on('error', (error) => {
		log.error(IDLE_CONNECTION_LOST, failureOf(error));
	});
	return pool;
};
