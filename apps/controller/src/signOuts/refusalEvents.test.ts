import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { logoutTokenRefusalEvent, logoutTokenRefusalTallyEvent } from './refusalEvents.js';

suite("a refused logout token's events", () => {
	test('records a verified token refused anyway at warning, naming its reason, the request and the subject it names as refusedSubject', () => {
		const event = logoutTokenRefusalEvent({
			reason: 'otherAudience',
			sourceIp: '192.0.2.10',
			subject: 'subject-ana',
		});

		assert.deepEqual(event, {
			data: {
				reason: 'otherAudience',
				result: 'denied',
				refusedSubject: 'subject-ana',
				sourceIp: '192.0.2.10',
			},
			severity: 'warning',
			type: 'logoutToken.refusal',
		});
	});

	test('leaves the subject out, never empty or null, for a token naming none it may name', () => {
		const event = logoutTokenRefusalEvent({
			reason: 'namesNoOne',
			sourceIp: '192.0.2.10',
			subject: undefined,
		});

		assert.deepEqual(event.data, {
			reason: 'namesNoOne',
			result: 'denied',
			sourceIp: '192.0.2.10',
		});
	});

	test('names no subject for a token that did not verify', () => {
		const event = logoutTokenRefusalEvent({
			reason: 'invalidSignature',
			sourceIp: '192.0.2.10',
			subject: undefined,
		});

		assert.deepEqual(event.data, {
			reason: 'invalidSignature',
			result: 'denied',
			sourceIp: '192.0.2.10',
		});
	});

	test('records a closed window at warning: its reason, its count, the instants of its first and latest refusals, and the opening event it closes as windowId', () => {
		const openedAt = Date.UTC(2026, 10, 18, 9, 0, 0);

		const event = logoutTokenRefusalTallyEvent({
			count: 3,
			firstSeenAt: openedAt,
			lastSeenAt: openedAt + 90_000,
			reason: 'invalidSignature',
			windowId: '0f4c1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b',
		});

		assert.deepEqual(event, {
			data: {
				count: 3,
				firstSeenAt: '2026-11-18T09:00:00.000Z',
				lastSeenAt: '2026-11-18T09:01:30.000Z',
				reason: 'invalidSignature',
				windowId: '0f4c1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b',
			},
			severity: 'warning',
			type: 'logoutToken.refusalTally',
		});
	});

	test('leaves windowId out of a closed window, never empty or null, when its opening event did not commit', () => {
		const openedAt = Date.UTC(2026, 10, 18, 9, 0, 0);

		const event = logoutTokenRefusalTallyEvent({
			count: 1,
			firstSeenAt: openedAt,
			lastSeenAt: openedAt,
			reason: 'otherIssuer',
		});

		assert.equal(Object.hasOwn(event.data, 'windowId'), false);
	});
});
