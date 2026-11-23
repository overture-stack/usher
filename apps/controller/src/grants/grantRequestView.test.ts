import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { grantRequestStateOf, grantRequestView } from './grantRequestView.js';
import type { ViewedGrantRequest } from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const at = (offsetMilliseconds: number): Date => new Date(NOW + offsetMilliseconds);

const PENDING: ViewedGrantRequest = {
	category: 'global.controlled',
	decidedAt: null,
	decision: null,
	expiresAt: at(3_600_000),
	grantId: null,
	holderSubject: 'subject-administrator',
	id: '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f',
	kind: 'selfGrant',
	requestedAt: at(-60_000),
	requestedBySubject: 'subject-administrator',
	resource: 'STUDY-A1',
	role: 'viewer',
};

suite('a grant request as an answer shows it', () => {
	test('shows every member as a grant request, its own kind apart, who asked for it by subject, each instant in UTC with Z', () => {
		assert.deepEqual(grantRequestView(PENDING, NOW), {
			category: 'global.controlled',
			decidedAt: null,
			expiresAt: '2026-11-12T13:00:00.000Z',
			grantId: null,
			holder: { hasAccount: true, subject: 'subject-administrator' },
			id: '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f',
			kind: 'grantRequest',
			requestKind: 'selfGrant',
			requestedAt: '2026-11-12T11:59:00.000Z',
			requestedBy: { subject: 'subject-administrator' },
			resource: 'STUDY-A1',
			role: 'viewer',
			state: 'pending',
		});
	});

	test("shows an orphaned resource's request by its kind, its holder apart from the one who asked", () => {
		const view = grantRequestView(
			{
				...PENDING,
				holderSubject: 'subject-cy',
				kind: 'orphanedResource',
			},
			NOW,
		);

		assert.deepEqual(
			['holder', 'requestKind', 'requestedBy'].map((name) =>
				typeof view === 'object' && view !== null ? Reflect.get(view, name) : undefined,
			),
			[{ hasAccount: true, subject: 'subject-cy' }, 'orphanedResource', { subject: 'subject-administrator' }],
		);
	});

	test('shows a granted request with its instant and the grant it wrote', () => {
		const view = grantRequestView(
			{
				...PENDING,
				decidedAt: at(-1000),
				decision: 'granted',
				grantId: '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e',
			},
			NOW,
		);

		assert.deepEqual(
			['decidedAt', 'grantId', 'state'].map((name) =>
				typeof view === 'object' && view !== null ? Reflect.get(view, name) : undefined,
			),
			['2026-11-12T11:59:59.000Z', '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e', 'granted'],
		);
	});

	test('is pending while undecided before its expiry, lapsed from its expiry on, and as decided once decided, whatever its expiry', () => {
		assert.deepEqual(
			[
				{ ...PENDING, expiresAt: at(1) },
				{ ...PENDING, expiresAt: at(0) },
				{ ...PENDING, expiresAt: at(-1) },
				{
					...PENDING,
					decidedAt: at(-2),
					decision: 'declined' as const,
					expiresAt: at(-1),
				},
				{
					...PENDING,
					decidedAt: at(-2),
					decision: 'granted' as const,
					expiresAt: at(-1),
					grantId: '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e',
				},
			].map((request) => grantRequestStateOf(request, NOW)),
			['pending', 'lapsed', 'lapsed', 'declined', 'granted'],
		);
	});
});
