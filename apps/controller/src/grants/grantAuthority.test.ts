import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { ResourceStanding } from '../resourceStanding/index.js';
import { grantAuthority, selfGrantAuthority } from './grantAuthority.js';
import type { GrantAuthority, GrantAuthorityQuestion, SelfGrantAuthority } from './types.js';

const standing = (over: Partial<ResourceStanding> = {}): ResourceStanding => ({
	accessLevel: 'grant',
	countedOwner: false,
	externalId: 'STUDY-A1',
	holder: false,
	id: '00000000-0000-4000-8000-000000000001',
	retired: false,
	suppressed: false,
	...over,
});

const OWNER = standing({ countedOwner: true, holder: true });

const asked = (over: Partial<GrantAuthorityQuestion>): GrantAuthorityQuestion => ({
	administrator: false,
	holderIsCaller: false,
	role: 'viewer',
	standing: OWNER,
	...over,
});

// What a decision comes to, as its kind, the code answered, and the reason its event records.
const outcomeOf = (authority: GrantAuthority): readonly unknown[] =>
	authority.kind === 'issue'
		? ['issue']
		: [
				'refuse',
				authority.problem.status,
				authority.problem.code,
				authority.recordedReason ?? authority.problem.code,
			];

const decided = (over: Partial<GrantAuthorityQuestion>): readonly unknown[] => outcomeOf(grantAuthority(asked(over)));

suite("deciding a grant's authority", () => {
	test("issues a counted owner's grant of any role on their resource, owner included", () => {
		assert.deepEqual(
			['viewer', 'curator', 'submitter', 'owner'].map((role) => decided({ role })),
			[['issue'], ['issue'], ['issue'], ['issue']],
		);
	});

	test("issues a platform administrator's submitter and owner grants on any resource they may see, owned or not", () => {
		assert.deepEqual(
			['submitter', 'owner'].flatMap((role) =>
				[standing(), standing({ accessLevel: 'open' })].map((seen) =>
					decided({ administrator: true, role, standing: seen }),
				),
			),
			[['issue'], ['issue'], ['issue'], ['issue']],
		);
	});

	test("refuses a platform administrator's grant of any other role 403 administratorGrantsNoConsumerAccess, alike whether or not the resource exists", () => {
		const refused = ['viewer', 'editor', 'curator', 'reviewer'].flatMap((role) =>
			[OWNER, undefined].map((seen) => decided({ administrator: true, role, standing: seen })),
		);

		assert.deepEqual(
			refused,
			refused.map(() => [
				'refuse',
				403,
				'administratorGrantsNoConsumerAccess',
				'administratorGrantsNoConsumerAccess',
			]),
		);
	});

	test('refuses a platform administrator naming themself an owner 403 administratorSelfOwnership, ahead of every other rule', () => {
		assert.deepEqual(
			[OWNER, undefined].map((seen) =>
				decided({
					administrator: true,
					holderIsCaller: true,
					role: 'owner',
					standing: seen,
				}),
			),
			[
				['refuse', 403, 'administratorSelfOwnership', 'administratorSelfOwnership'],
				['refuse', 403, 'administratorSelfOwnership', 'administratorSelfOwnership'],
			],
		);
	});

	test('refuses a principal naming themself 422 selfNamed, an administrator at a consumer role included, ahead of the refusal of consumer access', () => {
		assert.deepEqual(
			[
				decided({ holderIsCaller: true }),
				decided({ administrator: true, holderIsCaller: true }),
				decided({ holderIsCaller: true, role: 'owner' }),
				decided({ holderIsCaller: true, standing: undefined }),
			],
			[
				['refuse', 422, 'selfNamed', 'selfNamed'],
				['refuse', 422, 'selfNamed', 'selfNamed'],
				['refuse', 422, 'selfNamed', 'selfNamed'],
				['refuse', 422, 'selfNamed', 'selfNamed'],
			],
		);
	});

	test('refuses a resource that does not exist, and a retired one, 404 resourceNotFound, recorded as not found', () => {
		assert.deepEqual(
			[
				decided({ standing: undefined }),
				decided({ standing: { ...OWNER, retired: true } }),
				decided({
					administrator: true,
					role: 'owner',
					standing: standing({ retired: true }),
				}),
			],
			[
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
			],
		);
	});

	test('refuses a principal who may not see the resource 404 resourceNotFound, recorded as a refusal of authority', () => {
		assert.deepEqual(decided({ standing: standing() }), [
			'refuse',
			404,
			'resourceNotFound',
			'noAuthorityOnResource',
		]);
	});

	test('refuses a principal who may see the resource and owns it not 403 noAuthorityOnResource: a holder, a pending owner, or anyone on an open or registered one', () => {
		const seenWithoutAuthority = [
			standing({ holder: true }),
			standing({ accessLevel: 'open' }),
			standing({ accessLevel: 'registered', holder: true }),
		];

		assert.deepEqual(
			seenWithoutAuthority.map((seen) => decided({ standing: seen })),
			seenWithoutAuthority.map(() => ['refuse', 403, 'noAuthorityOnResource', 'noAuthorityOnResource']),
		);
	});
});

// What a self-grant's authority comes to, as its kind, the code answered, and the reason its event
// records.
const selfOutcomeOf = (authority: SelfGrantAuthority): readonly unknown[] =>
	authority.kind === 'refuse'
		? [
				'refuse',
				authority.problem.status,
				authority.problem.code,
				authority.recordedReason ?? authority.problem.code,
			]
		: [authority.kind];

const selfDecided = (administrator: boolean, seen: ResourceStanding | undefined): readonly unknown[] =>
	selfOutcomeOf(selfGrantAuthority({ administrator, standing: seen }));

suite("deciding a self-grant's authority", () => {
	test('issues a counted owner the grant on their own resource at once, a platform administrator among them', () => {
		assert.deepEqual([selfDecided(false, OWNER), selfDecided(true, OWNER)], [['issue'], ['issue']]);
	});

	test('takes a platform administrator who does not own the resource as asking for the grant, on any resource they may see', () => {
		const seen = [
			standing(),
			standing({ accessLevel: 'open' }),
			standing({ holder: true }),
			standing({ suppressed: true }),
		];

		assert.deepEqual(
			seen.map((standingSeen) => selfDecided(true, standingSeen)),
			seen.map(() => ['request']),
		);
	});

	test('refuses a resource that does not exist, or a retired one, 404 resourceNotFound, to an administrator and an owner alike', () => {
		assert.deepEqual(
			[
				selfDecided(true, undefined),
				selfDecided(false, undefined),
				selfDecided(true, standing({ retired: true })),
				selfDecided(false, { ...OWNER, retired: true }),
			],
			[
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
				['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
			],
		);
	});

	test('refuses a principal who may not see the resource as for one that does not exist, recording a refusal of authority, and one who may see it and owns it not 403 noAuthorityOnResource', () => {
		assert.deepEqual(
			[
				selfDecided(false, standing()),
				selfDecided(false, standing({ holder: true })),
				selfDecided(false, standing({ accessLevel: 'open' })),
			],
			[
				['refuse', 404, 'resourceNotFound', 'noAuthorityOnResource'],
				['refuse', 403, 'noAuthorityOnResource', 'noAuthorityOnResource'],
				['refuse', 403, 'noAuthorityOnResource', 'noAuthorityOnResource'],
			],
		);
	});
});
