import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { grantStateOf, grantView } from './grantView.js';
import type { ViewedGrant } from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const at = (offsetMilliseconds: number): Date => new Date(NOW + offsetMilliseconds);

const PENDING: ViewedGrant = {
	category: 'global.controlled',
	decision: null,
	endedAt: null,
	expiresAt: null,
	grantedAt: at(-60_000),
	granterSubject: 'subject-ana',
	holderSubject: 'subject-cy',
	id: '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e',
	resource: 'STUDY-A1',
	revokedAt: null,
	revokerSubject: null,
	role: 'viewer',
	selfGrant: false,
};

const ACCEPTED = {
	capabilities: ['record.count', 'record.view'],
	decidedAt: at(-30_000),
	decision: 'accepted',
} as const;

suite('a grant as an answer shows it', () => {
	test('shows every member as a grant, people by subject, the holder with an account and no address, each instant in UTC with Z', () => {
		assert.deepEqual(grantView({ ...PENDING, decision: ACCEPTED, expiresAt: at(3_600_000) }, NOW), {
			category: 'global.controlled',
			decision: {
				capabilities: ['record.count', 'record.view'],
				decidedAt: '2026-11-12T11:59:30.000Z',
				decision: 'accepted',
			},
			expiresAt: '2026-11-12T13:00:00.000Z',
			grantedAt: '2026-11-12T11:59:00.000Z',
			grantedBy: { subject: 'subject-ana' },
			holder: { hasAccount: true, subject: 'subject-cy' },
			id: '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e',
			kind: 'grant',
			resource: 'STUDY-A1',
			revokedAt: null,
			revokedBy: null,
			role: 'viewer',
			selfGrant: false,
			state: 'accepted',
		});
	});

	test('shows a revocation by its instant and its revoker, and a grant on the whole resource with a null category', () => {
		const view = grantView(
			{
				...PENDING,
				category: null,
				revokedAt: at(-1000),
				revokerSubject: 'subject-administrator',
				role: 'owner',
			},
			NOW,
		);

		const member = (name: string): unknown =>
			typeof view === 'object' && view !== null ? Reflect.get(view, name) : undefined;

		assert.deepEqual(['category', 'revokedAt', 'revokedBy', 'state'].map(member), [
			null,
			'2026-11-12T11:59:59.000Z',
			{ subject: 'subject-administrator' },
			'revoked',
		]);
	});
});

suite('a grant as a listing shows it', () => {
	test("shows each person as the listing's naming shows them, and the capabilities given as its first member", () => {
		const view = grantView(
			{
				...PENDING,
				revokedAt: at(-1000),
				revokerSubject: 'subject-administrator',
			},
			NOW,
			{
				capabilities: [
					{
						description: null,
						displayName: 'View records',
						name: 'record.view',
					},
				],
				naming: {
					holder: (subject) => ({
						email: 'cy@example.org',
						hasAccount: true,
						subject,
					}),
					principal: (subject) => ({ name: `named ${subject}` }),
				},
			},
		);

		const member = (name: string): unknown =>
			typeof view === 'object' && view !== null ? Reflect.get(view, name) : undefined;
		assert.deepEqual(
			{
				capabilities: member('capabilities'),
				first: Object.keys(view ?? {})[0],
				grantedBy: member('grantedBy'),
				holder: member('holder'),
				revokedBy: member('revokedBy'),
			},
			{
				capabilities: [
					{
						description: null,
						displayName: 'View records',
						name: 'record.view',
					},
				],
				first: 'capabilities',
				grantedBy: { name: 'named subject-ana' },
				holder: {
					email: 'cy@example.org',
					hasAccount: true,
					subject: 'subject-cy',
				},
				revokedBy: { name: 'named subject-administrator' },
			},
		);
	});
});

suite("a grant's state", () => {
	test('is revoked once revoked, whatever its expiry and its latest decision', () => {
		assert.equal(
			grantStateOf(
				{
					...PENDING,
					decision: ACCEPTED,
					expiresAt: at(-1000),
					revokedAt: at(-500),
				},
				NOW,
			),
			'revoked',
		);
	});

	test('is expired once its expiry has passed or a grant on its terms replaced it, whatever its latest decision', () => {
		assert.deepEqual(
			[
				grantStateOf({ ...PENDING, decision: ACCEPTED, expiresAt: at(0) }, NOW),
				grantStateOf({ ...PENDING, endedAt: at(-1000), expiresAt: at(-2000) }, NOW),
			],
			['expired', 'expired'],
		);
	});

	test('is otherwise its latest decision, and pending while there is none', () => {
		assert.deepEqual(
			[
				grantStateOf(PENDING, NOW),
				grantStateOf({ ...PENDING, decision: ACCEPTED }, NOW),
				grantStateOf({ ...PENDING, decision: { ...ACCEPTED, decision: 'declined' } }, NOW),
			],
			['pending', 'accepted', 'declined'],
		);
	});
});
