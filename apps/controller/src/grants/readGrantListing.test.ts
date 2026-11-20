import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { Principal, QueryParameters } from '../managementApi/index.js';
import { cursorAfterId } from './idCursor.js';
import {
	GRANT_PAGE_DEFAULT,
	GRANT_PAGE_MAXIMUM,
	readGrantListing,
	readPersonGrantListing,
} from './readGrantListing.js';

const ADMINISTRATOR: Principal = Object.freeze({
	administrator: true,
	subject: 'subject-administrator',
	firstUser: false,
	tokenLifetimeSeconds: 3600,
	type: 'human',
});

const PERSON: Principal = Object.freeze({
	administrator: false,
	subject: 'subject-ana',
	firstUser: false,
	tokenLifetimeSeconds: 3600,
	type: 'human',
});

const GRANT_ID = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const read = (query: QueryParameters, principal: Principal = ADMINISTRATOR) => readGrantListing({ principal, query });

const outcomeOf = (reading: ReturnType<typeof read> | ReturnType<typeof readPersonGrantListing>): unknown =>
	reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;

suite("reading a grant listing's query", () => {
	test('reads no query as the first page of the default size, revoked grants left out, and a cursor, a size and revoked grants asked for as sent', () => {
		assert.deepEqual(
			[
				read([]),
				read([
					['cursor', cursorAfterId(GRANT_ID)],
					['includeRevoked', 'true'],
					['limit', String(GRANT_PAGE_MAXIMUM + 1)],
				]),
			].map(outcomeOf),
			[
				{ after: undefined, includeRevoked: false, limit: GRANT_PAGE_DEFAULT },
				{ after: GRANT_ID, includeRevoked: true, limit: GRANT_PAGE_MAXIMUM },
			],
		);
	});

	test('refuses revoked grants to anyone but a platform administrator 403 administratorOnly, saying they are for administrators alone', () => {
		const refused = read([['includeRevoked', 'true']], PERSON);

		assert.deepEqual(outcomeOf(refused), [403, 'administratorOnly']);
		assert.match(
			refused.kind === 'refused' ? refused.problem.detail : '',
			/Revoked grants are listed to platform administrators alone/u,
		);
		assert.deepEqual(outcomeOf(read([['includeRevoked', 'false']], PERSON)), {
			after: undefined,
			includeRevoked: false,
			limit: GRANT_PAGE_DEFAULT,
		});
	});

	test('refuses a parameter not taken, a cursor no grant listing wrote, and a page size below 1, as every listing does', () => {
		assert.deepEqual(
			[read([['includeRetired', 'true']]), read([['cursor', 'not a cursor']]), read([['limit', '0']])].map(
				outcomeOf,
			),
			[
				[400, 'unreadableQuery'],
				[400, 'unreadableQuery'],
				[422, 'pageSizeTooSmall'],
			],
		);
	});
});

suite("reading a person's grant listing", () => {
	test('reads the address as given beside the query', () => {
		assert.deepEqual(
			outcomeOf(
				readPersonGrantListing(
					{ email: 'Sub.Bo@Example.org' },
					{ principal: ADMINISTRATOR, query: [['includeRevoked', 'true']] },
				),
			),
			{
				after: undefined,
				email: 'Sub.Bo@Example.org',
				includeRevoked: true,
				limit: GRANT_PAGE_DEFAULT,
			},
		);
	});

	test("judges the body before the query: a body it cannot read 400, an address out of an address's form 422 addressForm, then the query", () => {
		const owner = (body: Readonly<Record<string, unknown>> | undefined, query: QueryParameters) =>
			readPersonGrantListing(body, { principal: PERSON, query });

		assert.deepEqual(
			[
				owner(undefined, [['includeRevoked', 'true']]),
				owner({ email: 'bo' }, [['includeRevoked', 'true']]),
				owner({ email: 'bo@example.org' }, [['includeRevoked', 'true']]),
				owner({ email: 'bo@example.org' }, [['limit', '0']]),
			].map(outcomeOf),
			[
				[400, 'unreadableBody'],
				[422, 'addressForm'],
				[403, 'administratorOnly'],
				[422, 'pageSizeTooSmall'],
			],
		);
	});
});
