import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	APPLICATION_KEY_REVOCATION_REASONS,
	assertSucceeded,
	revokeApplicationKey,
} from '../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	auditRows,
	awaitEventsOfType,
	eventsIn,
	ofType,
} from '../../testing/harness/auditEvents.js';
import { adjustableClock } from '../../testing/peripherals/clocks.js';
import { captureLog } from '../../testing/harness/controller.js';
import {
	anonymousExchange,
	APPLICATION_SUITE,
	heldBy,
	issued,
	PAST_THE_RELOAD_INTERVAL_MS,
	registered,
	RELOAD_WITHIN_MS,
} from '../../testing/fixtures/applications.js';
import { withHarness } from '../../testing/harness/harness.js';
import { alterEncryptedKey } from '../../testing/harness/policy.js';
import { eventually } from '../../testing/harness/waiting.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

suite('a stored application key that does not open, as the store records it', () => {
	test('is recorded once as applicationKey.unreadable, critical, as the system, while it stays unreadable, however many reloads find it so', async (context) => {
		const log = captureLog();
		const clock = adjustableClock();
		await withHarness(
			{
				...APPLICATION_SUITE,
				configuration: { clock: clock.clock, logStream: log.stream },
			},
			async (harness) => {
				const { migration } = harness.clients;
				const administrator = await administratorCaller(harness);
				const altered = await registered(administrator, {
					displayName: 'Altered in the store',
				});
				const intact = await registered(administrator, {
					displayName: 'Intact, its keys changed',
				});
				await alterEncryptedKey(migration, altered.key.id);
				const since = log.lines().length;

				clock.advance(PAST_THE_RELOAD_INTERVAL_MS);
				const refused = await eventually(
					async () => (await anonymousExchange(harness.url, heldBy(altered))).status === 401,
					RELOAD_WITHIN_MS,
				);
				await awaitEventsOfType(log, AUDIT_EVENT_TYPES.applicationKeyUnreadable, {
					since,
				});
				const another = await issued(administrator, intact.id);
				assertSucceeded(
					await revokeApplicationKey(administrator, intact.id, another.id, {
						reason: APPLICATION_KEY_REVOCATION_REASONS.retired,
					}),
					'the revocation',
				);
				const served = await anonymousExchange(harness.url, heldBy(intact));
				const logged = ofType(eventsIn(log, since), AUDIT_EVENT_TYPES.applicationKeyUnreadable);
				const recorded = (await auditRows(migration)).filter(
					({ type }) => type === `bio.overture.${AUDIT_EVENT_TYPES.applicationKeyUnreadable}`,
				);

				assert.equal(refused, true);
				assert.equal(served.status, 200);
				assert.equal(logged.length, 1);
				assert.deepEqual(
					recorded.map(({ data, severity }) => ({
						actorType: isRecord(data) ? data['actorType'] : undefined,
						applicationId: isRecord(data) ? data['applicationId'] : undefined,
						keyId: isRecord(data) ? data['keyId'] : undefined,
						severity,
					})),
					[
						{
							actorType: 'system',
							applicationId: altered.id,
							keyId: altered.key.id,
							severity: 'critical',
						},
					],
				);
			},
			context,
		);
	});
});
