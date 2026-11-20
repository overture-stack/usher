import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { judgeGrantChange } from './judgeGrantChange.js';
import type { GrantChangeJudgement, GrantChangeQuestion, StoredRole } from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const HOUR_MS = 3_600_000;

const DAY_SECONDS = 86_400;

const at = (offsetMilliseconds: number): Date => new Date(NOW + offsetMilliseconds);

const role = (name: string, plane: 'control' | 'data', capabilities: readonly string[]): StoredRole => ({
	capabilities,
	id: `role-${name}`,
	name,
	plane,
});

const CREATOR = role('creator', 'data', ['record.create']);

const VIEWER = role('viewer', 'data', ['record.count', 'record.export', 'record.view']);

const CURATOR = role('curator', 'data', [
	'record.count',
	'record.create',
	'record.delete',
	'record.export',
	'record.update',
	'record.view',
]);

const SUBMITTER = role('submitter', 'data', ['record.create', 'record.update']);

const OWNER = role('owner', 'control', ['grant.create', 'resource.view']);

const STEWARD = role('steward', 'control', ['resource.view']);

const ROLES: Readonly<Record<string, StoredRole>> = {
	creator: CREATOR,
	curator: CURATOR,
	owner: OWNER,
	steward: STEWARD,
	submitter: SUBMITTER,
	viewer: VIEWER,
};

// A viewer grant ending in a day, judged at NOW for a counted owner of its resource who does not
// hold it.
const asked = (over: Partial<GrantChangeQuestion> = {}): GrantChangeQuestion => ({
	authority: 'owner',
	change: {},
	current: {
		endedAt: null,
		expiresAt: at(24 * HOUR_MS),
		revokedAt: null,
		role: VIEWER,
		selfGrantSince: null,
	},
	holderIsCaller: false,
	maximumSeconds: DAY_SECONDS,
	newRole: undefined,
	now: at(0),
	...over,
});

const changedTo = (
	change: GrantChangeQuestion['change'],
	over: Partial<GrantChangeQuestion> = {},
): GrantChangeQuestion =>
	asked({
		change,
		newRole: change.role === undefined ? undefined : ROLES[change.role],
		...over,
	});

const outcomeOf = (judgement: GrantChangeJudgement): unknown =>
	judgement.kind === 'refuse'
		? [judgement.problem.status, judgement.problem.code]
		: [judgement.endMoved, judgement.roleMoved];

const judged = (question: GrantChangeQuestion): unknown => outcomeOf(judgeGrantChange(question));

suite("judging a grant's change", () => {
	test("gives the grant's end and role after the change, each as it was where the change leaves it", () => {
		const judgement = judgeGrantChange(changedTo({ expiresAt: at(48 * HOUR_MS), role: 'curator' }));
		const roleOnly = judgeGrantChange(changedTo({ role: 'curator' }));

		assert.deepEqual(judgement.kind === 'change' ? [judgement.expiresAt, judgement.role.name] : judgement, [
			at(48 * HOUR_MS),
			'curator',
		]);
		assert.deepEqual(roleOnly.kind === 'change' ? [roleOnly.expiresAt, roleOnly.role.name] : roleOnly, [
			at(24 * HOUR_MS),
			'curator',
		]);
	});

	test('tells an end moved later or removed from one moved earlier, and a role widened from one narrowed or kept', () => {
		assert.deepEqual(
			[
				changedTo({ expiresAt: at(48 * HOUR_MS) }),
				changedTo({ expiresAt: null }),
				changedTo({ expiresAt: at(HOUR_MS) }),
				changedTo({ expiresAt: at(24 * HOUR_MS) }),
				changedTo(
					{ expiresAt: at(HOUR_MS) },
					{
						current: { ...asked().current, expiresAt: null },
					},
				),
				changedTo({ expiresAt: at(HOUR_MS) }, { current: { ...asked().current, expiresAt: at(-HOUR_MS) } }),
				changedTo({ role: 'curator' }),
				changedTo({ role: 'viewer' }, { current: { ...asked().current, role: CURATOR } }),
				changedTo({ role: 'viewer' }),
				changedTo({ role: 'submitter' }),
				changedTo({}),
			].map(judged),
			[
				['later', 'kept'],
				['later', 'kept'],
				['earlier', 'kept'],
				['kept', 'kept'],
				['earlier', 'kept'],
				['later', 'kept'],
				['kept', 'wider'],
				['kept', 'narrower'],
				['kept', 'kept'],
				['kept', 'wider'],
				['kept', 'kept'],
			],
		);
	});

	test('refuses a revoked grant 409 doesNotHold, and one replaced by a newer grant 409 grantReplaced, ahead of every rule', () => {
		assert.deepEqual(
			[
				changedTo(
					{ role: 'reviewer' },
					{
						current: {
							...asked().current,
							endedAt: at(-HOUR_MS),
							revokedAt: at(-HOUR_MS),
						},
					},
				),
				changedTo(
					{ role: 'reviewer' },
					{
						current: {
							...asked().current,
							endedAt: at(-HOUR_MS),
							expiresAt: at(-2 * HOUR_MS),
						},
					},
				),
			].map(judged),
			[
				[409, 'doesNotHold'],
				[409, 'grantReplaced'],
			],
		);
	});

	test('refuses a role the instance does not define, and one of the other plane, 422', () => {
		const owned = { ...asked().current, expiresAt: null, role: OWNER };

		assert.deepEqual(
			[
				changedTo({ role: 'reviewer' }),
				changedTo({ role: 'owner' }),
				changedTo({ role: 'viewer' }, { current: owned }),
				changedTo({ role: 'steward' }, { current: owned }),
			].map(judged),
			[
				[422, 'unknownRole'],
				[422, 'roleInOtherPlane'],
				[422, 'roleInOtherPlane'],
				['kept', 'narrower'],
			],
		);
	});

	test('refuses an expiry on an owner grant 422 ownerGrantsDoNotExpire', () => {
		const owned = { ...asked().current, expiresAt: null, role: OWNER };

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(HOUR_MS) }, { current: owned }),
				changedTo({ expiresAt: null }, { current: owned }),
			].map(judged),
			[
				[422, 'ownerGrantsDoNotExpire'],
				['kept', 'kept'],
			],
		);
	});

	test("holds a self-grant's end within the longest self-grant life of its request, and keeps its expiry", () => {
		const selfGranted = {
			...asked().current,
			expiresAt: at(2 * HOUR_MS),
			selfGrantSince: at(-2 * HOUR_MS),
		};

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(22 * HOUR_MS) }, { current: selfGranted }),
				changedTo({ expiresAt: at(22 * HOUR_MS + 1000) }, { current: selfGranted }),
				changedTo({ expiresAt: null }, { current: selfGranted }),
				changedTo({ role: 'curator' }, { current: selfGranted }),
				changedTo({ expiresAt: at(48 * HOUR_MS) }),
			].map(judged),
			[
				['later', 'kept'],
				[422, 'selfGrantTooLong'],
				[422, 'selfGrantExpiryRequired'],
				['kept', 'wider'],
				['later', 'kept'],
			],
		);
	});

	test("lets a platform administrator reduce any grant, and extend or widen only someone else's submitter or owner grant into a submitter or an owner role, refusing anything more 403 administratorGrantsNoConsumerAccess", () => {
		const administrator = { authority: 'administrator' as const };
		const submitting = { ...asked().current, role: SUBMITTER };
		const owned = { ...asked().current, expiresAt: null, role: OWNER };

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(HOUR_MS) }, administrator),
				changedTo(
					{ role: 'viewer' },
					{
						...administrator,
						current: { ...asked().current, role: CURATOR },
					},
				),
				changedTo({ expiresAt: at(48 * HOUR_MS) }, administrator),
				changedTo({ expiresAt: null }, administrator),
				changedTo({ role: 'curator' }, administrator),
				changedTo(
					{ expiresAt: at(48 * HOUR_MS) },
					{
						...administrator,
						current: submitting,
					},
				),
				changedTo(
					{ role: 'curator' },
					{
						...administrator,
						current: submitting,
					},
				),
				changedTo({ role: 'steward' }, { ...administrator, current: owned }),
			].map(judged),
			[
				['earlier', 'kept'],
				['kept', 'narrower'],
				[403, 'administratorGrantsNoConsumerAccess'],
				[403, 'administratorGrantsNoConsumerAccess'],
				[403, 'administratorGrantsNoConsumerAccess'],
				['later', 'kept'],
				[403, 'administratorGrantsNoConsumerAccess'],
				['kept', 'narrower'],
			],
		);
	});

	test('refuses a platform administrator extending, removing the end of, or widening a grant they hold 403 selfWideningNotPermitted, whatever its role and after the 422 rules, and lets them end it earlier or narrow it', () => {
		const ownGrant = {
			authority: 'administrator' as const,
			holderIsCaller: true,
		};
		const submitting = {
			...ownGrant,
			current: { ...asked().current, role: SUBMITTER },
		};
		const selfGranted = {
			...ownGrant,
			current: {
				...asked().current,
				expiresAt: at(2 * HOUR_MS),
				selfGrantSince: at(-2 * HOUR_MS),
			},
		};

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(48 * HOUR_MS) }, submitting),
				changedTo({ expiresAt: null }, submitting),
				changedTo({ role: 'curator' }, submitting),
				changedTo({ expiresAt: at(HOUR_MS) }, submitting),
				changedTo({ role: 'creator' }, submitting),
				changedTo({ expiresAt: at(48 * HOUR_MS) }, ownGrant),
				changedTo({ expiresAt: at(22 * HOUR_MS) }, selfGranted),
				changedTo({ expiresAt: at(22 * HOUR_MS + 1000) }, selfGranted),
				changedTo({ expiresAt: null }, selfGranted),
			].map(judged),
			[
				[403, 'selfWideningNotPermitted'],
				[403, 'selfWideningNotPermitted'],
				[403, 'selfWideningNotPermitted'],
				['earlier', 'kept'],
				['kept', 'narrower'],
				[403, 'selfWideningNotPermitted'],
				[403, 'selfWideningNotPermitted'],
				[422, 'selfGrantTooLong'],
				[422, 'selfGrantExpiryRequired'],
			],
		);
	});

	test("holds a counted owner extending or widening a grant they hold to an expiry within the longest self-grant life of the change's instant, and limits neither an earlier end nor a narrower role", () => {
		const ownGrant = { holderIsCaller: true, now: at(6 * HOUR_MS) };
		const endless = {
			...ownGrant,
			current: { ...asked().current, expiresAt: null },
		};

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(30 * HOUR_MS) }, ownGrant),
				changedTo({ expiresAt: at(30 * HOUR_MS + 1000) }, ownGrant),
				changedTo({ expiresAt: null }, ownGrant),
				changedTo({ role: 'curator' }, ownGrant),
				changedTo({ role: 'curator' }, endless),
				changedTo(
					{ role: 'curator' },
					{
						...ownGrant,
						current: { ...asked().current, expiresAt: at(30 * HOUR_MS + 1000) },
					},
				),
				changedTo(
					{ expiresAt: at(48 * HOUR_MS) },
					{
						...ownGrant,
						current: { ...asked().current, expiresAt: at(72 * HOUR_MS) },
					},
				),
				changedTo({ role: 'viewer' }, { ...endless, current: { ...endless.current, role: CURATOR } }),
			].map(judged),
			[
				['later', 'kept'],
				[422, 'selfGrantTooLong'],
				[422, 'selfGrantExpiryRequired'],
				['kept', 'wider'],
				[422, 'selfGrantExpiryRequired'],
				[422, 'selfGrantTooLong'],
				['earlier', 'kept'],
				['kept', 'narrower'],
			],
		);
	});

	test("holds a counted owner's own self-grant within the longest self-grant life of its request", () => {
		const selfGranted = {
			current: {
				...asked().current,
				expiresAt: at(2 * HOUR_MS),
				selfGrantSince: at(-2 * HOUR_MS),
			},
			holderIsCaller: true,
		};

		assert.deepEqual(
			[
				changedTo({ expiresAt: at(22 * HOUR_MS) }, selfGranted),
				changedTo({ expiresAt: at(22 * HOUR_MS + 1000) }, selfGranted),
			].map(judged),
			[
				['later', 'kept'],
				[422, 'selfGrantTooLong'],
			],
		);
	});

	test('puts no limit on a counted owner extending or widening a grant someone else holds', () => {
		assert.deepEqual(
			[
				changedTo({ expiresAt: at(72 * HOUR_MS) }),
				changedTo({ expiresAt: null }),
				changedTo({ role: 'curator' }, { current: { ...asked().current, expiresAt: null } }),
			].map(judged),
			[
				['later', 'kept'],
				['later', 'kept'],
				['kept', 'wider'],
			],
		);
	});
});
