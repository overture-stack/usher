import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantCreation } from './readGrantCreation.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const VIEWER = {
	category: 'global.controlled',
	holder: { subject: 'subject-cy' },
	resource: 'STUDY-A1',
	role: 'viewer',
};

const outcomeOf = (body: Readonly<Record<string, unknown>>): unknown => {
	const reading = readGrantCreation(body, NOW);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

const codesOf = (bodies: readonly Readonly<Record<string, unknown>>[]): unknown[] => bodies.map(outcomeOf);

suite("reading a grant's creation", () => {
	test('reads a grant naming its holder by subject, its category, and its expiry as an instant', () => {
		const read = outcomeOf({
			...VIEWER,
			expiresAt: '2026-12-01T07:00:00-05:00',
		});

		assert.deepEqual(read, {
			category: 'global.controlled',
			expiresAt: new Date(Date.UTC(2026, 11, 1, 12, 0, 0)),
			holder: { kind: 'subject', subject: 'subject-cy' },
			resource: 'STUDY-A1',
			role: 'viewer',
		});
	});

	test('reads a grant naming no category and no expiry, and one naming its holder by address', () => {
		assert.deepEqual(
			codesOf([
				{
					holder: { subject: 'subject-cy' },
					resource: 'STUDY-A1',
					role: 'owner',
				},
				{
					holder: { email: 'sub.bo@example.org' },
					resource: 'STUDY-A1',
					role: 'submitter',
				},
			]),
			[
				{
					category: undefined,
					expiresAt: undefined,
					holder: { kind: 'subject', subject: 'subject-cy' },
					resource: 'STUDY-A1',
					role: 'owner',
				},
				{
					category: undefined,
					expiresAt: undefined,
					holder: { email: 'sub.bo@example.org', kind: 'address' },
					resource: 'STUDY-A1',
					role: 'submitter',
				},
			],
		);
	});

	test('refuses 400 a body holding a member the operation does not take, lacking one it requires, or holding one of another type', () => {
		const unreadable = [
			{ ...VIEWER, startsAt: '2026-12-01T00:00:00Z' },
			{ ...VIEWER, actorId: 'subject-fen' },
			{ holder: VIEWER.holder, resource: 'STUDY-A1' },
			{ category: 'global.controlled', resource: 'STUDY-A1', role: 'viewer' },
			{ holder: VIEWER.holder, role: 'viewer' },
			{ ...VIEWER, expiresAt: 1_796_000_000 },
			{ ...VIEWER, category: null },
			{ ...VIEWER, resource: ['STUDY-A1'] },
			{ ...VIEWER, role: 7 },
			{ ...VIEWER, holder: 'subject-cy' },
			{ ...VIEWER, holder: { email: 7 } },
		];

		assert.deepEqual(
			codesOf(unreadable),
			unreadable.map(() => [400, 'unreadableBody']),
		);
	});

	test('refuses 422 a granter or a field category named, whatever it holds', () => {
		assert.deepEqual(
			codesOf([
				{ ...VIEWER, grantedBy: 'subject-dana' },
				{ ...VIEWER, grantedBy: { subject: 'subject-dana' } },
				{ ...VIEWER, fieldCategory: 'global.unmarked' },
			]),
			[
				[422, 'grantedByNotTaken'],
				[422, 'grantedByNotTaken'],
				[422, 'fieldCategoryNotTaken'],
			],
		);
	});

	test('refuses 422 a holder naming other than one person, and an address out of form', () => {
		assert.deepEqual(
			codesOf([
				{ ...VIEWER, holder: { group: 'study-a1-team' } },
				{ ...VIEWER, holder: { email: 'bo@' } },
			]),
			[
				[422, 'holderNotOnePerson'],
				[422, 'addressForm'],
			],
		);
	});

	test('refuses 422 the administrator role, which nobody grants', () => {
		assert.deepEqual(outcomeOf({ holder: VIEWER.holder, resource: 'STUDY-A1', role: 'admin' }), [
			422,
			'administratorRoleNotGranted',
		]);
	});

	test('refuses 422 an owner grant naming a category, and one given an expiry, whatever its form', () => {
		const owner = {
			holder: VIEWER.holder,
			resource: 'STUDY-A1',
			role: 'owner',
		};

		assert.deepEqual(
			codesOf([
				{ ...owner, category: 'global.controlled' },
				{ ...owner, expiresAt: '2026-12-01T00:00:00Z' },
				{ ...owner, expiresAt: 'tomorrow' },
			]),
			[
				[422, 'wholeResourceRole'],
				[422, 'ownerGrantsDoNotExpire'],
				[422, 'ownerGrantsDoNotExpire'],
			],
		);
	});

	test('refuses 422 an expiry that is no RFC 3339 instant with an offset, or names no day there is', () => {
		const notInstants = [
			'2026-12-01',
			'tomorrow',
			'2026-12-01T00:00:00',
			'2026-12-01 00:00:00Z',
			'2026-12-01T00:00:00z',
			'2026-12-01T00:00:00+0500',
			'2027-02-29T00:00:00Z',
			'2026-12-01T24:00:00Z',
			'2026-12-01T00:00:60Z',
			'2026-12-01T00:00:00+24:00',
			'',
		];

		assert.deepEqual(
			codesOf(notInstants.map((expiresAt) => ({ ...VIEWER, expiresAt }))),
			notInstants.map(() => [422, 'expiryNotAnInstant']),
		);
	});

	test('refuses 422 an expiry at or before the configured instant', () => {
		assert.deepEqual(
			codesOf(
				[NOW, NOW - 1000].map((instant) => ({
					...VIEWER,
					expiresAt: new Date(instant).toISOString(),
				})),
			),
			[
				[422, 'expiryPassed'],
				[422, 'expiryPassed'],
			],
		);
	});

	test('reads an expiry with fractional seconds, and one a second after the configured instant', () => {
		const read = codesOf([
			{ ...VIEWER, expiresAt: '2026-11-12T12:00:00.250Z' },
			{ ...VIEWER, expiresAt: '2026-11-12T12:00:01Z' },
		]);

		assert.deepEqual(
			read.map((input) =>
				typeof input === 'object' && input !== null && 'expiresAt' in input ? input.expiresAt : input,
			),
			[new Date(NOW + 250), new Date(NOW + 1000)],
		);
	});
});
