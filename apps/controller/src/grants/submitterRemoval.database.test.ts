import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertRefused,
	assertSucceeded,
	comparableRefusal,
	personCaller,
	PROBLEMS,
	removeSubmitter,
	SYSTEM_ASSIGNED_REASONS,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, dataOf, emittedType, FAULT_REASONS } from '../../testing/harness/auditEvents.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import { CAST, fixtureGrant, grantsFixture, storedGrants, STUDY_A1 } from '../../testing/fixtures/grants.js';
import { withHarness } from '../../testing/harness/harness.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const NOBODY = 'nobody@example.org';

// Cy's submitter grants on STUDY-A1 under two categories, and Cy's viewer grant there, each live;
// and Bo's submitter grant there.
const SUBMITTING = grantsFixture({
	grants: {
		boSubmits: fixtureGrant('curator', 'submitter', { category: 'unmarked' }),
		cySubmitsControlled: fixtureGrant('recipient', 'submitter'),
		cySubmitsUnmarked: fixtureGrant('recipient', 'submitter', {
			category: 'unmarked',
		}),
		cyViews: fixtureGrant('recipient', 'viewer'),
	},
});

// The directory's accounts: Cy and Bo, each holding their own address verified.
const ACCOUNTS = [CAST.recipient, CAST.curator].map(({ email, subject }) => ({
	email,
	id: subject,
}));

// The grant.revocation rows the trail holds, each by its data and its severity.
const revocationRows = async (
	client: Parameters<typeof auditRows>[0],
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(client))
		.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantRevocation))
		.map((row) => ({ ...dataOf(row), severity: row.severity }));

suite("a submitter's removal by address, in the store", () => {
	test("revokes every live submitter grant the account holding the address holds on the study, the caller its revoker, leaving the account's other grants and other submitters as they were", async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: SUBMITTING }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);

			const removed = await removeSubmitter(owner, STUDY_A1, CAST.recipient.email.toUpperCase());

			assertSucceeded(removed, 'the removal');
			assert.equal(removed.text, '');
			const held = await storedGrants(harness, { resource: STUDY_A1 });
			assert.deepEqual(
				held
					.filter(({ role }) => role !== 'owner' && role !== 'curator')
					.map(({ category, holderSubject, revokedAt, revokerSubject, role }) => ({
						category,
						holder: holderSubject,
						revoked: revokedAt !== null,
						revoker: revokerSubject,
						role,
					}))
					.toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
				[
					{
						category: 'global.controlled',
						holder: CAST.recipient.subject,
						revoked: false,
						revoker: null,
						role: 'viewer',
					},
					{
						category: 'global.controlled',
						holder: CAST.recipient.subject,
						revoked: true,
						revoker: CAST.ownerOfA1.subject,
						role: 'submitter',
					},
					{
						category: 'global.unmarked',
						holder: CAST.curator.subject,
						revoked: false,
						revoker: null,
						role: 'submitter',
					},
					{
						category: 'global.unmarked',
						holder: CAST.recipient.subject,
						revoked: true,
						revoker: CAST.ownerOfA1.subject,
						role: 'submitter',
					},
				].toSorted((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second))),
			);
			assert.deepEqual(
				(await revocationRows(harness.clients.migration)).map(
					({ granteeId, reason, result, role, severity }) => ({
						granteeId,
						reason,
						result,
						role,
						severity,
					}),
				),
				[1, 2].map(() => ({
					granteeId: CAST.recipient.subject,
					reason: SYSTEM_ASSIGNED_REASONS.unspecified,
					result: 'succeeded',
					role: 'submitter',
					severity: 'info',
				})),
			);
		});
	});

	test('revokes nothing for an address no single account holds, or for an account holding no live submitter grant there, answering an owner alike for both', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		await withHarness(
			{
				configuration: directory.configuration,
				fixture: grantsFixture({
					grants: { cyViews: fixtureGrant('recipient', 'viewer') },
				}),
			},
			async (harness) => {
				const owner = await personCaller(harness, CAST.ownerOfA1);
				const administrator = await administratorCaller(harness);

				const unheldToOwner = await removeSubmitter(owner, STUDY_A1, NOBODY);
				const notSubmitting = await removeSubmitter(owner, STUDY_A1, CAST.recipient.email);
				const unheldToAdministrator = await removeSubmitter(administrator, STUDY_A1, NOBODY);

				assertRefused(notSubmitting, PROBLEMS.doesNotHold, 'no submitter');
				assert.deepEqual(comparableRefusal(unheldToOwner), comparableRefusal(notSubmitting));
				assertRefused(unheldToAdministrator, PROBLEMS.holderNotFound, 'no account, to an administrator');
				assert.deepEqual(
					(await storedGrants(harness, { resource: STUDY_A1 })).filter(({ revokedAt }) => revokedAt !== null),
					[],
				);
				assert.deepEqual(
					(await revocationRows(harness.clients.migration)).map(({ reason, result, severity }) => ({
						reason,
						result,
						severity,
					})),
					[PROBLEMS.holderNotFound.code, PROBLEMS.doesNotHold.code, PROBLEMS.holderNotFound.code].map(
						(reason) => ({
							reason,
							result: 'denied',
							severity: 'warning',
						}),
					),
				);
			},
		);
	});

	test('records a directory unable to answer as failed at error, revoking nothing', async (context) => {
		const directory = await startDirectory({ accounts: ACCOUNTS });
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		await withHarness({ configuration: directory.configuration, fixture: SUBMITTING }, async (harness) => {
			const refused = await removeSubmitter(await administratorCaller(harness), STUDY_A1, CAST.recipient.email);

			assertRefused(refused, PROBLEMS.directoryUnavailable, 'the removal');
			assert.deepEqual(
				(await storedGrants(harness, { resource: STUDY_A1 })).filter(({ revokedAt }) => revokedAt !== null),
				[],
			);
			assert.deepEqual(
				(await revocationRows(harness.clients.migration)).map(({ reason, resourceId, result, severity }) => ({
					reason,
					resourceId,
					result,
					severity,
				})),
				[
					{
						reason: FAULT_REASONS.directoryUnavailable,
						resourceId: STUDY_A1,
						result: 'failed',
						severity: 'error',
					},
				],
			);
		});
	});
});
