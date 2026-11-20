import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantChange } from './readGrantChange.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const outcomeOf = (body: Readonly<Record<string, unknown>>): unknown => {
	const reading = readGrantChange(body, NOW);
	return reading.kind === 'refused' ? [reading.problem.status, reading.problem.code] : reading.input;
};

suite("reading a grant's change", () => {
	test('reads an expiry as an instant, its removal as null, a role as sent, and an empty patch as changing nothing', () => {
		assert.deepEqual(
			[
				{ expiresAt: '2026-11-13T07:00:00-05:00' },
				{ expiresAt: null },
				{ role: 'curator' },
				{ expiresAt: '2026-11-13T12:00:00Z', role: 'Curator ' },
				{},
			].map(outcomeOf),
			[
				{ expiresAt: new Date(NOW + 86_400_000) },
				{ expiresAt: null },
				{ role: 'curator' },
				{ expiresAt: new Date(NOW + 86_400_000), role: 'Curator ' },
				{},
			],
		);
	});

	test('refuses a body by its shape 400: a member not taken, an expiry neither text nor null, or a role that is no string', () => {
		assert.deepEqual(
			[
				{ category: 'global.unmarked' },
				{ expiresAt: 7 },
				{ expiresAt: ['2026-11-13T12:00:00Z'] },
				{ role: null },
				{ holder: { subject: 'subject-cy' }, role: 'viewer' },
			].map(outcomeOf),
			[
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
				[400, 'unreadableBody'],
			],
		);
	});

	test('refuses an expiry that is no instant or not in the future, and the administrator role, 422', () => {
		assert.deepEqual(
			[
				{ expiresAt: '2026-11-13' },
				{ expiresAt: '2026-11-12T12:00:00Z' },
				{ expiresAt: '2026-11-12T11:00:00Z' },
				{ role: 'admin' },
			].map(outcomeOf),
			[
				[422, 'expiryNotAnInstant'],
				[422, 'expiryPassed'],
				[422, 'expiryPassed'],
				[422, 'administratorRoleNotGranted'],
			],
		);
	});
});
