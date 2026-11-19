import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';

import pg from 'pg';

import { CA_FILE_CHANGED } from './caFile.js';
import {
	databaseCaFile,
	IDLE_CONNECTION_LOST,
	openStore,
	storeConnection,
	UNVERIFIED_CONNECTION_ALLOWED,
} from './connection.js';
import type { StoreLineFields } from './types.js';

suite('connecting to the store', () => {
	test("connects as the URL's role to its host, port and database, with the password from its own variable", () => {
		const connection = storeConnection({
			databasePassword: ' a password/@:% ',
			databaseUrl: 'postgres://usher_controller@db.example.org:6432/usher?sslmode=disable',
			storeTimeoutMilliseconds: 5000,
		});

		assert.deepEqual(
			{
				database: connection.database,
				host: connection.host,
				password: connection.password,
				port: connection.port,
				ssl: connection.ssl,
				user: connection.user,
			},
			{
				database: 'usher',
				host: 'db.example.org',
				password: ' a password/@:% ',
				port: 6432,
				ssl: false,
				user: 'usher_controller',
			},
		);
	});

	test('hands the driver no URL, whose own empty password would override the one given', () => {
		const connection = storeConnection({
			databasePassword: 'given',
			databaseUrl: 'postgres://usher_controller@127.0.0.1/usher',
			storeTimeoutMilliseconds: 5000,
		});

		assert.equal(connection.connectionString, undefined);
		assert.equal(connection.password, 'given');
	});

	test("limits the pool's wait for a connection, and on the server each statement and each wait inside a transaction, to the store timeout, over any the URL sets", () => {
		const connection = storeConnection({
			databasePassword: 'given',
			databaseUrl:
				'postgres://usher_controller@127.0.0.1/usher?connectionTimeoutMillis=0&statement_timeout=0&idle_in_transaction_session_timeout=0',
			storeTimeoutMilliseconds: 250,
		});

		assert.deepEqual(
			{
				connectionTimeoutMillis: connection.connectionTimeoutMillis,
				idleInTransaction: connection.idle_in_transaction_session_timeout,
				statement: connection.statement_timeout,
			},
			{
				connectionTimeoutMillis: 250,
				idleInTransaction: 250,
				statement: 250,
			},
		);
	});
});

suite("each of the store's pools", () => {
	test('holds at most the connections given, each limited alike', async () => {
		const pools = [1, 5, 10].map((connections) =>
			openStore(
				{
					databasePassword: 'given',
					databaseUrl: 'postgres://usher_controller@127.0.0.1/usher',
					storeTimeoutMilliseconds: 250,
				},
				{ error: () => undefined },
				connections,
			),
		);
		const held = pools.map(({ options }) => ({
			connectionTimeoutMillis: options.connectionTimeoutMillis,
			idleInTransaction: options.idle_in_transaction_session_timeout,
			max: options.max,
			statement: options.statement_timeout,
		}));
		await Promise.all(pools.map((pool) => pool.end()));

		assert.deepEqual(
			held,
			[1, 5, 10].map((max) => ({
				connectionTimeoutMillis: 250,
				idleInTransaction: 250,
				max,
				statement: 250,
			})),
		);
	});
});

suite("the store's idle connections", () => {
	const PASSWORD = 'a password/@:% only the store knows';
	const URL = 'postgres://usher_controller@db.example.org:6432/usher';

	const losses = async (errors: readonly Error[]): Promise<readonly [string, StoreLineFields][]> => {
		const written: [string, StoreLineFields][] = [];
		const pool = openStore(
			{
				databasePassword: PASSWORD,
				databaseUrl: URL,
				storeTimeoutMilliseconds: 5000,
			},
			{
				error: (message, fields) => {
					written.push([message, fields]);
				},
			},
			10,
		);
		errors.forEach((error) => pool.emit('error', error));
		await pool.end();
		return written;
	};

	test('writes each one lost at error, naming the failure by its code alone, never its message', async () => {
		const terminated = Object.assign(
			new pg.DatabaseError('terminating connection due to administrator command', 0, 'error'),
			{ code: '57P01', detail: 'a detail naming a value' },
		);
		const reset = Object.assign(new Error('read ECONNRESET'), {
			code: 'ECONNRESET',
		});
		const ended = new Error('Connection terminated unexpectedly');

		const written = await losses([terminated, reset, ended]);

		assert.deepEqual(written, [
			[IDLE_CONNECTION_LOST, { code: '57P01' }],
			[IDLE_CONNECTION_LOST, { code: 'ECONNRESET' }],
			[IDLE_CONNECTION_LOST, {}],
		]);
	});

	test("adds neither the store's password nor its URL to the line", async () => {
		const written = await losses([
			Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6432'), {
				code: 'ECONNREFUSED',
			}),
		]);
		const text = JSON.stringify(written);

		assert.equal(written.length, 1);
		assert.equal(text.includes(PASSWORD), false);
		assert.equal(text.includes(URL), false);
	});
});

suite("the CA file a connection's server is verified against", () => {
	const ISSUED = '-----BEGIN CERTIFICATE-----\nissued\n-----END CERTIFICATE-----\n';
	const REISSUED = '-----BEGIN CERTIFICATE-----\nreissued\n-----END CERTIFICATE-----\n';

	const caFileIn = async (context: TestContext): Promise<string> => {
		const folder = await mkdtemp(join(tmpdir(), 'usher-store-ca-'));
		context.after(() => rm(folder, { force: true, recursive: true }));
		const path = join(folder, 'root.crt');
		await writeFile(path, ISSUED);
		return path;
	};

	// The TLS options of one connection's handshake, as the driver builds them from the pool's: a copy
	// of their own members, taken as the connection opens.
	const handshakeOptionsOf = (connection: pg.PoolConfig): Readonly<Record<string, unknown>> => ({
		...Object(connection.ssl),
	});

	test('is read again as each connection opens, a reissued certificate taken by the next one and the change written once', async (context) => {
		const path = await caFileIn(context);
		const written: [string, StoreLineFields][] = [];
		const log = {
			error: (message: string, fields: StoreLineFields) => {
				written.push([message, fields]);
			},
			warning: (message: string, fields: StoreLineFields) => {
				written.push([message, fields]);
			},
		};
		const settings = {
			databasePassword: 'given',
			databaseUrl: `postgres://usher_controller@db.example.org/usher?sslmode=verify-full&sslrootcert=${path}`,
			storeTimeoutMilliseconds: 5000,
		};
		const connection = storeConnection(settings, databaseCaFile(settings, log));

		const before = handshakeOptionsOf(connection)['ca'];
		await writeFile(path, REISSUED);
		const after = [handshakeOptionsOf(connection)['ca'], handshakeOptionsOf(connection)['ca']];

		assert.equal(before, ISSUED);
		assert.deepEqual(after, [REISSUED, REISSUED]);
		assert.deepEqual(written, [[CA_FILE_CHANGED, { variable: 'USHER_DATABASE_URL' }]]);
	});

	test("keeps every other TLS setting the URL gives, its client certificate's file read once as the driver reads it", async (context) => {
		const path = await caFileIn(context);
		const settings = {
			databasePassword: 'given',
			databaseUrl: `postgres://usher_controller@db.example.org/usher?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=${path}`,
			storeTimeoutMilliseconds: 5000,
		};
		const connection = storeConnection(settings, () => REISSUED);

		const options = handshakeOptionsOf(connection);

		assert.equal(options['ca'], REISSUED);
		assert.equal(typeof options['checkServerIdentity'], 'function');
	});

	test('is none for a URL naming no CA file, nor for one that connects without TLS', () => {
		const log = { error: () => undefined, warning: () => undefined };
		const unnamed = databaseCaFile(
			{
				databaseUrl: 'postgres://usher_controller@db.example.org/usher?sslmode=verify-full',
			},
			log,
		);
		const plain = storeConnection(
			{
				databasePassword: 'given',
				databaseUrl: 'postgres://usher_controller@127.0.0.1/usher',
				storeTimeoutMilliseconds: 5000,
			},
			() => ISSUED,
		);

		assert.equal(unnamed, undefined);
		assert.equal(plain.ssl, undefined);
	});

	test("is read by every pool opened with it, as each of the pool's connections opens", async (context) => {
		const path = await caFileIn(context);
		const settings = {
			databasePassword: 'given',
			databaseUrl: `postgres://usher_controller@db.example.org/usher?sslmode=verify-full&sslrootcert=${path}`,
			storeTimeoutMilliseconds: 5000,
		};
		const reads: string[] = [];
		const pool = openStore(settings, { error: () => undefined }, 1, () => {
			reads.push('read');
			return ISSUED;
		});

		const options = { ...Object(pool.options.ssl) };
		await pool.end();

		assert.equal(options['ca'], ISSUED);
		assert.deepEqual(reads, ['read']);
	});

	test("names the line a start allowing an unverified connection writes, as the store's other lines are named", () => {
		assert.equal(UNVERIFIED_CONNECTION_ALLOWED, 'store.unverifiedConnectionAllowed');
	});
});
