import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Principal, QueryParameters } from '../managementApi/index.js';
import { cursorAfterId } from './idCursor.js';
import { readGrantRequestListing, REQUEST_PAGE_DEFAULT, REQUEST_PAGE_MAXIMUM } from './readGrantRequestListing.js';

const PERSON: Principal = Object.freeze({
	administrator: false,
	firstUser: false,
	subject: 'subject-ana',
	tokenLifetimeSeconds: 300,
	type: 'human',
});

const REQUEST_ID = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const read = (query: QueryParameters) => readGrantRequestListing({ principal: PERSON, query });

const outcomeOf = (reading: ReturnType<typeof read>): unknown =>
	reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;

suite("reading the grant request listing's query", () => {
	test('reads no query as the first page of the default size, and a cursor and a size as sent', () => {
		assert.deepEqual(
			[
				read([]),
				read([
					['cursor', cursorAfterId(REQUEST_ID)],
					['limit', '2'],
				]),
			].map(outcomeOf),
			[
				{ after: undefined, limit: REQUEST_PAGE_DEFAULT },
				{ after: REQUEST_ID, limit: 2 },
			],
		);
	});

	test('answers a page size above the most a page holds with the most', () => {
		assert.deepEqual(
			[String(REQUEST_PAGE_MAXIMUM + 1), '9'.repeat(400)].map((limit) => outcomeOf(read([['limit', limit]]))),
			[
				{ after: undefined, limit: REQUEST_PAGE_MAXIMUM },
				{ after: undefined, limit: REQUEST_PAGE_MAXIMUM },
			],
		);
	});

	test('refuses a parameter not taken, one sent twice, or a value it cannot read 400 unreadableQuery, and a size below 1 422 pageSizeTooSmall', () => {
		const queries: QueryParameters[] = [
			[['includeRetired', 'true']],
			[['state', 'pending']],
			[
				['limit', '2'],
				['limit', '3'],
			],
			[['cursor', 'not a cursor']],
			[['limit', '']],
			[['limit', '1.5']],
			[['limit', '0']],
			[['limit', '-3']],
		];

		assert.deepEqual(queries.map(read).map(outcomeOf), [
			[400, 'unreadableQuery'],
			[400, 'unreadableQuery'],
			[400, 'unreadableQuery'],
			[400, 'unreadableQuery'],
			[400, 'unreadableQuery'],
			[400, 'unreadableQuery'],
			[422, 'pageSizeTooSmall'],
			[422, 'pageSizeTooSmall'],
		]);
	});
});
