import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { createStoreReader } from './createStoreReader.js';
import { StoreTimeout } from './storeTimeout.js';

const TIMEOUT_MILLISECONDS = 250;

interface Asked {
	text: string;
	values: unknown[] | undefined;
}

interface FakeReads {
	asked: Asked[];
	connections: number;
	pool: { connect(): Promise<pg.PoolClient> };

	/** Each release reaching the pool, true for a connection discarded. */
	releases: (boolean | Error | undefined)[];
}

// A pool whose every connection answers a statement as the test rules: with rows, a failure, or
// nothing until the connection is discarded, as a store that stopped answering does.
const fakeReads = (
	answer: 'answers' | 'fails' | 'stalls',
	failure = new Error('the statement was refused'),
): FakeReads => {
	const reads: FakeReads = {
		asked: [],
		connections: 0,
		pool: {
			connect: async () => {
				reads.connections += 1;
				const discarded: { end: () => void } = { end: () => undefined };
				const query = (text: string, values?: unknown[]) => {
					reads.asked.push({ text, values });
					if (answer === 'answers') {
						return Promise.resolve({ rows: [{ answered: true }] });
					}
					return answer === 'fails'
						? Promise.reject(failure)
						: new Promise((_resolve, reject) => {
								discarded.end = () => reject(new Error('Connection terminated'));
							});
				};
				const release = (destroy?: boolean | Error): void => {
					reads.releases.push(destroy);
					if (destroy === true) {
						discarded.end();
					}
				};
				// A client that never connects, its statements answered here: the client's overloads are more
				// than a fake can spell out.
				return Object.assign(new pg.Client(), { query, release });
			},
		},
		releases: [],
	};
	return reads;
};

suite("the store's reader", () => {
	test('runs each statement with its values on a connection of its own, returning the connection to the pool once answered', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const reads = fakeReads('answers');
		const reader = createStoreReader(reads.pool, TIMEOUT_MILLISECONDS);

		const first = await reader.query<{ answered: boolean }>('SELECT $1::text AS answered', ['a value']);
		const second = await reader.query('SELECT 1');

		assert.deepEqual(first.rows, [{ answered: true }]);
		assert.deepEqual(second.rows, [{ answered: true }]);
		assert.deepEqual(reads.asked, [
			{ text: 'SELECT $1::text AS answered', values: ['a value'] },
			{ text: 'SELECT 1', values: undefined },
		]);
		assert.equal(reads.connections, 2);
		assert.deepEqual(reads.releases, [undefined, undefined]);
	});

	test("discards the connection once its statement fails, throwing the store's failure", async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const refused = Object.assign(new Error('permission denied'), {
			code: '42501',
		});
		const reads = fakeReads('fails', refused);
		const reader = createStoreReader(reads.pool, TIMEOUT_MILLISECONDS);

		await assert.rejects(reader.query('SELECT 1'), (thrown) => thrown === refused);

		assert.deepEqual(reads.releases, [true]);
	});

	test('fails with StoreTimeout, discarding the connection, when the statement is not answered within the store timeout', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const reads = fakeReads('stalls');
		const reader = createStoreReader(reads.pool, TIMEOUT_MILLISECONDS);
		const outcome = reader.query('SELECT 1').then(
			() => 'answered',
			(failure: unknown) => failure,
		);
		await new Promise((resolve) => {
			setImmediate(resolve);
		});

		context.mock.timers.tick(TIMEOUT_MILLISECONDS);

		assert.ok((await outcome) instanceof StoreTimeout);
		assert.deepEqual(reads.releases, [true]);
	});
});
