import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { problem } from '../http/index.js';
import { pageOf, type PageRules, readPageQuery } from './pageQuery.js';
import { PROBLEMS } from './problems.js';
import type { Principal, QueryParameters } from './types.js';

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

const WITHHELD_REFUSAL = problem(
	'administratorOnly',
	403,
	'For platform administrators alone',
	'Hidden entries are listed to platform administrators alone.',
);

// A listing whose cursors are a key behind the prefix `after:`.
const RULES: PageRules = Object.freeze({
	afterOf: (cursor: string) => (cursor.startsWith('after:') ? cursor.slice('after:'.length) : undefined),
	defaultSize: 50,
	maximumSize: 500,
});

const WITH_WITHHELD: PageRules = Object.freeze({
	...RULES,
	withheld: { parameter: 'includeHidden', refusal: WITHHELD_REFUSAL },
});

const read = (query: QueryParameters, rules: PageRules = RULES, principal: Principal = ADMINISTRATOR) =>
	readPageQuery({ principal, query }, rules);

const outcomeOf = (reading: ReturnType<typeof read>): unknown =>
	reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;

suite("reading a listing's page query", () => {
	test('reads no query as the first page of the default size, withholding what the listing withholds, and a cursor and a size as sent', () => {
		assert.deepEqual(
			[
				read([]),
				read([
					['cursor', 'after:STUDY-A1'],
					['limit', '2'],
				]),
			].map(outcomeOf),
			[
				{ after: undefined, includesWithheld: false, limit: 50 },
				{ after: 'STUDY-A1', includesWithheld: false, limit: 2 },
			],
		);
	});

	test('answers a page size above the most a page holds with the most', () => {
		assert.deepEqual(
			['501', '9'.repeat(400)].map((limit) => outcomeOf(read([['limit', limit]]))),
			[
				{ after: undefined, includesWithheld: false, limit: 500 },
				{ after: undefined, includesWithheld: false, limit: 500 },
			],
		);
	});

	test('refuses a parameter not taken, one sent twice, a cursor no page named, or a size that is no whole number 400 unreadableQuery', () => {
		const queries: QueryParameters[] = [
			[['offset', '3']],
			[['includeHidden', 'true']],
			[
				['limit', '2'],
				['limit', '3'],
			],
			[['cursor', 'not a cursor']],
			[['limit', '']],
			[['limit', 'three']],
			[['limit', '1.5']],
		];

		assert.deepEqual(
			queries.map((query) => outcomeOf(read(query))),
			queries.map(() => [400, 'unreadableQuery']),
		);
	});

	test('names the parameters a listing takes when refusing one it does not', () => {
		const details = [RULES, WITH_WITHHELD].map((rules) => {
			const reading = read([['offset', '3']], rules);
			return reading.kind === 'refused' ? reading.problem.detail : undefined;
		});

		assert.deepEqual(details, [
			'The query names a parameter this operation does not take: it takes cursor and limit alone.',
			'The query names a parameter this operation does not take: it takes cursor, includeHidden and limit alone.',
		]);
	});

	test("refuses a page size of zero or below it 422 with the management API's one pageSizeTooSmall", () => {
		const limits = ['0', '-0', '-1', `-${'9'.repeat(400)}`];

		const refusals = limits.map((limit) => read([['limit', limit]]));

		assert.deepEqual(
			refusals.map((reading) => (reading.kind === 'refused' ? reading.problem : undefined)),
			limits.map(() => PROBLEMS.pageSizeTooSmall),
		);
		assert.deepEqual([PROBLEMS.pageSizeTooSmall.status, PROBLEMS.pageSizeTooSmall.code], [422, 'pageSizeTooSmall']);
	});

	test('includes the withheld entries for a platform administrator sending the parameter true, and for nobody sending it false or leaving it out', () => {
		assert.deepEqual(
			[
				read([['includeHidden', 'true']], WITH_WITHHELD),
				read([['includeHidden', 'false']], WITH_WITHHELD),
				read([['includeHidden', 'false']], WITH_WITHHELD, PERSON),
				read([], WITH_WITHHELD, PERSON),
			].map(outcomeOf),
			[
				{ after: undefined, includesWithheld: true, limit: 50 },
				{ after: undefined, includesWithheld: false, limit: 50 },
				{ after: undefined, includesWithheld: false, limit: 50 },
				{ after: undefined, includesWithheld: false, limit: 50 },
			],
		);
	});

	test("refuses anyone but a platform administrator sending the parameter true with the listing's own refusal, and any value but true or false 400", () => {
		const refused = read([['includeHidden', 'true']], WITH_WITHHELD, PERSON);

		assert.equal(refused.kind === 'refused' ? refused.problem : undefined, WITHHELD_REFUSAL);
		assert.deepEqual(
			['TRUE', '1', ''].map((value) => outcomeOf(read([['includeHidden', value]], WITH_WITHHELD))),
			[
				[400, 'unreadableQuery'],
				[400, 'unreadableQuery'],
				[400, 'unreadableQuery'],
			],
		);
	});

	test('judges a value it cannot read before the standing to ask for withheld entries, and that before the page size', () => {
		assert.deepEqual(
			[
				read(
					[
						['includeHidden', 'true'],
						['limit', 'ten'],
					],
					WITH_WITHHELD,
					PERSON,
				),
				read(
					[
						['includeHidden', 'true'],
						['limit', '0'],
					],
					WITH_WITHHELD,
					PERSON,
				),
			].map(outcomeOf),
			[
				[400, 'unreadableQuery'],
				[403, 'administratorOnly'],
			],
		);
	});
});

suite("cutting a listing's page", () => {
	const cursorOf = (entry: string): string => `after:${entry}`;

	test('answers the entries up to the page size, and the cursor after the last when more were read', () => {
		assert.deepEqual(pageOf(['a', 'b', 'c'], 2, cursorOf), {
			entries: ['a', 'b'],
			next: 'after:b',
		});
	});

	test('names no next page when no more were read than the page holds, an empty page among them', () => {
		assert.deepEqual(
			[pageOf(['a', 'b'], 2, cursorOf), pageOf([], 2, cursorOf)],
			[
				{ entries: ['a', 'b'], next: null },
				{ entries: [], next: null },
			],
		);
	});
});
