import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Principal, QueryParameters } from '../managementApi/index.js';
import {
	cursorAfter,
	externalIdOfCursor,
	LISTING_PAGE_DEFAULT,
	LISTING_PAGE_MAXIMUM,
	readListingQuery,
} from './listingQuery.js';

const ADMINISTRATOR: Principal = Object.freeze({
	administrator: true,
	firstUser: false,
	subject: 'subject-administrator',
	tokenLifetimeSeconds: 310,
	type: 'human',
});

const PERSON: Principal = Object.freeze({
	administrator: false,
	firstUser: false,
	subject: 'subject-ana',
	tokenLifetimeSeconds: 310,
	type: 'human',
});

const read = (query: QueryParameters, principal: Principal = ADMINISTRATOR) => readListingQuery({ principal, query });

const outcomeOf = (reading: ReturnType<typeof read>): string =>
	reading.kind === 'refused' ? `${reading.problem.status} ${reading.problem.code}` : 'read';

suite("a listing's cursor", () => {
	test('names again the externalId it was written after, whatever its characters', () => {
		const externalIds = ['STUDY-A1', 'ÉTUDE-1', 'a', 'x'.repeat(128)];

		assert.deepEqual(
			externalIds.map((externalId) => externalIdOfCursor(cursorAfter(externalId))),
			externalIds,
		);
	});

	test('names nothing for text no listing wrote', () => {
		const cursors = [
			'',
			'not a cursor',
			'U1RVRFktQTE=',
			'U1RVRFktQTF',
			cursorAfter('A\u0000B'),
			Buffer.from([0xff, 0xfe]).toString('base64url'),
		];

		assert.deepEqual(
			cursors.map(externalIdOfCursor),
			cursors.map(() => undefined),
		);
	});
});

suite("reading the resource listing's query", () => {
	test('reads no query as the first page of the default size, retired resources left out', () => {
		assert.deepEqual(read([]), {
			input: {
				after: undefined,
				includeRetired: false,
				limit: LISTING_PAGE_DEFAULT,
			},
			kind: 'read',
		});
	});

	test("reads a page's cursor, its size, and an administrator asking for retired resources", () => {
		assert.deepEqual(
			read([
				['cursor', cursorAfter('STUDY-B2')],
				['limit', '2'],
				['includeRetired', 'true'],
			]),
			{
				input: { after: 'STUDY-B2', includeRetired: true, limit: 2 },
				kind: 'read',
			},
		);
		assert.deepEqual(read([['includeRetired', 'false']], PERSON), {
			input: {
				after: undefined,
				includeRetired: false,
				limit: LISTING_PAGE_DEFAULT,
			},
			kind: 'read',
		});
	});

	test('answers a page size above the most a page holds with the most', () => {
		const readings = [String(LISTING_PAGE_MAXIMUM + 1), '9'.repeat(400)].map((limit) => read([['limit', limit]]));

		assert.deepEqual(
			readings.map((reading) => (reading.kind === 'read' ? reading.input.limit : undefined)),
			[LISTING_PAGE_MAXIMUM, LISTING_PAGE_MAXIMUM],
		);
	});

	test('refuses a parameter not taken, one sent twice, or a value it cannot read 400 unreadableQuery', () => {
		const queries: QueryParameters[] = [
			[['page', '2']],
			[['includeRevoked', 'true']],
			[
				['limit', '2'],
				['limit', '3'],
			],
			[['cursor', 'not a cursor']],
			[['cursor', '']],
			[['limit', '']],
			[['limit', '1.5']],
			[['limit', '+2']],
			[['limit', 'ten']],
			[['includeRetired', '']],
			[['includeRetired', 'True']],
			[['includeRetired', '1']],
			[['includeRetired', 'toString']],
		];

		assert.deepEqual(
			queries.map((query) => outcomeOf(read(query))),
			queries.map(() => '400 unreadableQuery'),
		);
	});

	test('refuses anyone but a platform administrator asking for retired resources 403 administratorOnly', () => {
		assert.equal(outcomeOf(read([['includeRetired', 'true']], PERSON)), '403 administratorOnly');
	});

	test('refuses a page size of zero or below it 422 pageSizeTooSmall', () => {
		const limits = ['0', '-0', '-1', `-${'9'.repeat(400)}`];

		assert.deepEqual(
			limits.map((limit) => outcomeOf(read([['limit', limit]]))),
			limits.map(() => '422 pageSizeTooSmall'),
		);
	});

	test('judges a value it cannot read before the standing to ask for retired resources, and that before the page size', () => {
		assert.deepEqual(
			[
				read(
					[
						['includeRetired', 'true'],
						['limit', 'ten'],
					],
					PERSON,
				),
				read(
					[
						['includeRetired', 'true'],
						['limit', '0'],
					],
					PERSON,
				),
			].map(outcomeOf),
			['400 unreadableQuery', '403 administratorOnly'],
		);
	});
});
