import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { startController } from '../../testing/harness/controller.js';
import { writeStoredSettings } from '../../testing/harness/database.js';
import { exchange, type Person } from '../../testing/harness/exchange.js';
import { withHarness } from '../../testing/harness/harness.js';

const APPLICATION = 'Sign-in token maximum history';

// Longer than the lowered maximum below, so a token of this lifetime is refused while the lowering holds the
// maximum it is judged by; the harness's own maximum is 3600 seconds.
const LIFETIME_SECONDS = 900;

const LOWERED_MAXIMUM_SECONDS = 600;

const RAISED_MAXIMUM_SECONDS = 3600;

// Issued instants are whole seconds, so each token is minted a second or more after the change before it,
// and every change is recorded at an instant the token's issue is unambiguously before or after.
const WHOLE_SECOND_MILLISECONDS = 1100;

const freshPerson = (): Person => ({
	email: 'sign-in-maximum@example.org',
	subject: randomUUID(),
});

suite('the sign-in token maximum judged over the changes the store records', () => {
	test('judges a token issued before a lowering by the lowered maximum, though a later raise restores the one in force, and accepts one issued after the raise', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			const application = harness.application(APPLICATION);
			const issuedBeforeLowering = await harness.tokens.signIn(freshPerson(), {
				application: APPLICATION,
				mint: { lifetimeSeconds: LIFETIME_SECONDS },
			});
			await delay(WHOLE_SECOND_MILLISECONDS);
			await harness.stopController();
			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				signInTokenMaximumLifetimeSeconds: LOWERED_MAXIMUM_SECONDS,
			});
			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				signInTokenMaximumLifetimeSeconds: RAISED_MAXIMUM_SECONDS,
			});
			await delay(WHOLE_SECOND_MILLISECONDS);
			const issuedAfterRaise = await harness.tokens.signIn(freshPerson(), {
				application: APPLICATION,
				mint: { lifetimeSeconds: LIFETIME_SECONDS },
			});
			const started = await startController(harness.configuration);
			try {
				const earlier = await exchange(started.url, { application, credential: issuedBeforeLowering });
				const later = await exchange(started.url, { application, credential: issuedAfterRaise });

				assert.equal(earlier.status, 403);
				assert.equal(later.status, 200);
			} finally {
				await started.stop();
			}
		});
	});
});
