import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { GRANT_PROBLEMS } from './grantProblems.js';
import { readSelfGrantCreation } from './readSelfGrantCreation.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const HOUR_MS = 3_600_000;

const DAY_SECONDS = 86_400;

const instant = (offsetMilliseconds: number): string => new Date(NOW + offsetMilliseconds).toISOString();

const VIEWER = {
	categories: ['global.controlled'],
	expiresAt: instant(2 * HOUR_MS),
	resource: 'STUDY-A1',
	role: 'viewer',
};

const outcomeOf = (
	body: Readonly<Record<string, unknown>>,
	{ administrator = false, maximumSeconds = DAY_SECONDS }: { administrator?: boolean; maximumSeconds?: number } = {},
): unknown => {
	const reading = readSelfGrantCreation(body, {
		administrator,
		maximumSeconds,
		now: NOW,
	});
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite("reading a self-grant's creation", () => {
	test('reads the resource, the role, the categories and the expiry as an instant, every text as given', () => {
		assert.deepEqual(
			outcomeOf({
				...VIEWER,
				expiresAt: '2026-11-12T09:00:00-05:00',
				resource: 'Study A1 ',
			}),
			{
				categories: ['global.controlled'],
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				resource: 'Study A1 ',
				role: 'viewer',
			},
		);
		assert.deepEqual(
			outcomeOf({
				expiresAt: VIEWER.expiresAt,
				resource: 'STUDY-A1',
				role: 'submitter',
			}),
			{
				categories: undefined,
				expiresAt: new Date(NOW + 2 * HOUR_MS),
				resource: 'STUDY-A1',
				role: 'submitter',
			},
		);
	});

	test('refuses a body by its shape 400 first: a member not taken, a required one missing, a null expiry, or text that is no string', () => {
		const { expiresAt: _expiry, ...withoutExpiry } = VIEWER;
		const { role: _role, ...withoutRole } = VIEWER;

		assert.deepEqual(
			[
				{ ...VIEWER, grantedBy: { subject: 'subject-cy' } },
				{ ...VIEWER, fieldCategory: 'global.unmarked' },
				withoutExpiry,
				{ ...VIEWER, expiresAt: null },
				withoutRole,
				{ ...VIEWER, resource: ['STUDY-A1'] },
				{ ...VIEWER, categories: 7 },
				{ ...VIEWER, categories: [] },
				{ ...VIEWER, category: 'global.controlled' },
				{ ...VIEWER, expiresAt: null, holder: { subject: 'subject-cy' } },
			].map((body) => outcomeOf(body)),
			[
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
			],
		);
	});

	test("refuses the body's own rules 422 in turn: a holder, the administrator role, an expiry that is no instant, not in the future, or past the longest self-grant life", () => {
		assert.deepEqual(
			[
				{ ...VIEWER, holder: { subject: 'subject-cy' } },
				{ ...VIEWER, holder: 'anyone', role: 'admin' },
				{ ...VIEWER, role: 'admin' },
				{ ...VIEWER, expiresAt: '2026-11-12 14:00:00Z' },
				{ ...VIEWER, expiresAt: '2026-02-30T12:00:00Z' },
				{ ...VIEWER, expiresAt: instant(0) },
				{ ...VIEWER, expiresAt: instant(-HOUR_MS) },
				{ ...VIEWER, expiresAt: instant(DAY_SECONDS * 1000 + 1) },
			].map((body) => outcomeOf(body)),
			[
				[422, 'holderNotTaken'],
				[422, 'holderNotTaken'],
				[422, 'administratorRoleNotGranted'],
				[422, 'expiryNotAnInstant'],
				[422, 'expiryNotAnInstant'],
				[422, 'expiryPassed'],
				[422, 'expiryPassed'],
				[422, 'selfGrantTooLong'],
			],
		);
	});

	test("takes an expiry at the longest self-grant life of the request's instant exactly, under the configured maximum", () => {
		const atLongest = outcomeOf({
			...VIEWER,
			expiresAt: instant(DAY_SECONDS * 1000),
		});
		const underFourHours = [4, 5].map((hours) =>
			outcomeOf({ ...VIEWER, expiresAt: instant(hours * HOUR_MS) }, { maximumSeconds: 4 * 3600 }),
		);

		assert.deepEqual(atLongest, {
			...VIEWER,
			expiresAt: new Date(NOW + DAY_SECONDS * 1000),
		});
		assert.deepEqual(underFourHours, [
			{ ...VIEWER, expiresAt: new Date(NOW + 4 * HOUR_MS) },
			[422, 'selfGrantTooLong'],
		]);
	});

	test('refuses a platform administrator naming the owner role 403 administratorSelfOwnership once the body keeps its rules, and anyone else naming it reads on', () => {
		const owner = {
			expiresAt: VIEWER.expiresAt,
			resource: 'STUDY-A1',
			role: 'owner',
		};

		assert.deepEqual(
			[
				outcomeOf(owner, { administrator: true }),
				outcomeOf({ ...owner, expiresAt: instant(-HOUR_MS) }, { administrator: true }),
				outcomeOf(owner),
			],
			[
				[403, 'administratorSelfOwnership'],
				[422, 'expiryPassed'],
				{
					...owner,
					categories: undefined,
					expiresAt: new Date(NOW + 2 * HOUR_MS),
				},
			],
		);
	});
	test('refuses 422 a category named twice, in any letter case, naming the first repeat by its place', () => {
		const reading = readSelfGrantCreation(
			{ ...VIEWER, categories: ['global.controlled', 'Global.CONTROLLED'] },
			{ administrator: false, maximumSeconds: DAY_SECONDS, now: NOW },
		);

		assert.deepEqual(reading.kind === 'refused' && reading.problem, {
			...GRANT_PROBLEMS.duplicateCategory,
			categoryIndex: 1,
		});
	});
});
