import assert from 'node:assert/strict';
import { after, before, suite, test } from 'node:test';

import pg from 'pg';

import { createTestDatabase, type TestDatabase } from './database.js';
import { OVERLAPPING_QUERY_REFUSAL, refuseOverlappingQueries } from './serialQueries.js';

/** What a query called back with: its error, if it failed, and its row count, if it did not. */
interface Settled {
	error: Error | undefined;
	rowCount: number | null | undefined;
}

const settledByCallback = (client: pg.ClientBase, text: string): Promise<Settled> =>
	new Promise((resolve) => {
		client.query(text, (error, result) => {
			resolve({ error: error ?? undefined, rowCount: result?.rowCount });
		});
	});

suite('refusing a query issued while an earlier one on its client is in flight', () => {
	let database: TestDatabase;

	before(async () => {
		refuseOverlappingQueries();
		database = await createTestDatabase();
	});

	after(async () => {
		await database.close();
	});

	test('refuses the second of two promise queries issued without waiting, while the first completes', async () => {
		const client = await database.connect('runtime');

		const first = client.query('SELECT 1 AS one');
		const second = client.query('SELECT 2 AS two');
		const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

		assert.equal(firstOutcome.status, 'fulfilled');
		assert.equal(secondOutcome.status, 'rejected');
		assert.equal(secondOutcome.reason?.message, OVERLAPPING_QUERY_REFUSAL);
	});

	test('refuses the second of two callback queries issued on one client checked out of a pool without waiting', async () => {
		const pool = new pg.Pool({ connectionString: database.urlFor('runtime') });
		const client = await pool.connect();

		const first = settledByCallback(client, 'SELECT 1 AS one');
		const second = settledByCallback(client, 'SELECT 2 AS two');
		const [firstSettled, secondSettled] = await Promise.all([first, second]);
		client.release();
		await pool.end();

		assert.equal(firstSettled.error, undefined);
		assert.equal(firstSettled.rowCount, 1);
		assert.equal(secondSettled.error?.message, OVERLAPPING_QUERY_REFUSAL);
	});

	test('lets two pool.query calls run at the same time, each on a client of its own', async () => {
		const pool = new pg.Pool({ connectionString: database.urlFor('runtime') });

		const outcomes = await Promise.all([pool.query('SELECT 1 AS one'), pool.query('SELECT 2 AS two')]);
		await pool.end();

		assert.deepEqual(
			outcomes.map(({ rowCount }) => rowCount),
			[1, 1],
		);
	});

	test('lets promise queries run one after another on a client', async () => {
		const client = await database.connect('runtime');

		const first = await client.query('SELECT 1 AS one');
		const second = await client.query('SELECT 2 AS two');

		assert.equal(first.rowCount, 1);
		assert.equal(second.rowCount, 1);
	});

	test('lets callback queries run one after another on a client', async () => {
		const pool = new pg.Pool({ connectionString: database.urlFor('runtime') });
		const client = await pool.connect();

		const first = await settledByCallback(client, 'SELECT 1 AS one');
		const second = await settledByCallback(client, 'SELECT 2 AS two');
		client.release();
		await pool.end();

		assert.equal(first.error, undefined);
		assert.equal(second.error, undefined);
	});

	test('frees the client once a query fails, so the next query on it runs', async () => {
		const client = await database.connect('runtime');

		await assert.rejects(client.query('SELEKT 1'));
		const next = await client.query('SELECT 1 AS one');

		assert.equal(next.rowCount, 1);
	});

	test('frees the client once a callback query fails, so the next query on it runs', async () => {
		const pool = new pg.Pool({ connectionString: database.urlFor('runtime') });
		const client = await pool.connect();

		const failed = await settledByCallback(client, 'SELEKT 1');
		const next = await settledByCallback(client, 'SELECT 1 AS one');
		client.release();
		await pool.end();

		assert.notEqual(failed.error, undefined);
		assert.equal(next.error, undefined);
	});

	test('wraps the query method once, however many times it is called', () => {
		refuseOverlappingQueries();
		const once = pg.Client.prototype.query;

		refuseOverlappingQueries();

		assert.equal(pg.Client.prototype.query, once);
	});
});
