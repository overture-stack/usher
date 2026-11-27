import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { administratorCaller, steppedUpSignIn, createSelfGrant, nominate } from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { CAST, CONTROLLED, grantsFixture, HOUR_MS, OPEN_STUDY, STUDY_A1 } from '../../testing/fixtures/grants.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { revokePrincipalInStore, userIdOf } from '../../testing/harness/policy.js';

const selfGrantOn = (resource: string) => ({
	categories: [CONTROLLED],
	expiresAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
	resource,
	role: 'viewer',
});

const selfCreations = async (harness: Harness): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(AUDIT_EVENT_TYPES.grantSelfCreation))
		.map(dataOf);

suite("an administrator's self-grant when nobody else could approve it", () => {
	test('is granted at once to the only live administrator, on a resource with no counted owner, marked as such', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const granted = await createSelfGrant(
				await administratorCaller(harness, { mint: steppedUpSignIn() }),
				selfGrantOn(OPEN_STUDY),
			);

			assert.equal(granted.status, 201);
			assert.deepEqual(
				(await selfCreations(harness)).map((data) => data['soleAdministrator']),
				[true],
			);
		});
	});

	test('counts no revoked administrator and no pending nomination as another who could approve', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const administrator = await administratorCaller(harness, { mint: steppedUpSignIn() });
			await administratorCaller(harness, { person: CAST.secondAdministrator });
			await revokePrincipalInStore(harness.clients.migration, {
				revokedBy: await userIdOf(harness.clients.migration, CAST.administrator.subject),
				userId: await userIdOf(harness.clients.migration, CAST.secondAdministrator.subject),
			});
			await nominate(administrator, { nominee: { subject: CAST.ownerOfA1.subject } });

			const granted = await createSelfGrant(administrator, selfGrantOn(OPEN_STUDY));

			assert.equal(granted.status, 201);
		});
	});

	test('stays a request while another live administrator could approve it, or the resource has a counted owner', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owned = await createSelfGrant(await administratorCaller(harness), selfGrantOn(STUDY_A1));
			await administratorCaller(harness, { person: CAST.secondAdministrator });
			const peered = await createSelfGrant(await administratorCaller(harness), selfGrantOn(OPEN_STUDY));

			assert.deepEqual(
				[owned, peered].map(({ status }) => status),
				[202, 202],
			);
			assert.deepEqual(
				(await selfCreations(harness)).map((data) => data['soleAdministrator']),
				[],
			);
		});
	});
});
