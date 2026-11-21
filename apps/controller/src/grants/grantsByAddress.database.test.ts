import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	addSubmitter,
	administratorCaller,
	assertRefused,
	assertSucceeded,
	comparableSuccess,
	createGrant,
	personCaller,
	PROBLEMS,
} from '../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	auditRows,
	auditRowTexts,
	dataOf,
	emittedType,
	FAULT_REASONS,
} from '../../testing/harness/auditEvents.js';
import { captureLog } from '../../testing/harness/controller.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import { CAST, grantFor, grantsFixture, rowCounts, storedGrants, STUDY_A1 } from '../../testing/fixtures/grants.js';
import { withHarness } from '../../testing/harness/harness.js';
import { usersWithSubject } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const NOBODY = 'nobody@example.org';

// The grant.creation rows the trail holds, each by its data and its severity.
const creationRows = async (
	client: Parameters<typeof auditRows>[0],
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(client))
		.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
		.map((row) => ({ ...dataOf(row), severity: row.severity }));

suite('a grant whose holder is named by address, in the store', () => {
	test('is written for an administrator under the subject of the account holding the address, its holder met under the trusted issuer, and no address stored', async (context) => {
		const directory = await startDirectory({
			accounts: [{ email: CAST.newcomer.email, id: CAST.newcomer.subject }],
		});
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: grantsFixture() }, async (harness) => {
			const client = harness.clients.migration;
			const before = await usersWithSubject(client, CAST.newcomer.subject);

			const added = await addSubmitter(
				await administratorCaller(harness),
				STUDY_A1,
				CAST.newcomer.email.toUpperCase(),
			);

			assertSucceeded(added, 'the addition');
			assert.equal(before, 0);
			assert.equal(await usersWithSubject(client, CAST.newcomer.subject), 1);
			assert.deepEqual(
				(await storedGrants(harness, { holder: CAST.newcomer.subject })).map(
					({ holderIssuer, resource, role }) => ({
						holderIssuer,
						resource,
						role,
					}),
				),
				[
					{
						holderIssuer: harness.configuration.identityProviderIssuer,
						resource: STUDY_A1,
						role: 'submitter',
					},
				],
			);
			const texts = await auditRowTexts(client);
			assert.equal(
				texts.some((text) => text.toLowerCase().includes(CAST.newcomer.email.toLowerCase())),
				false,
			);
		});
	});

	test("writes nothing of an owner's grant by an address no single account holds, answering it as one held is, and records its refusal", async (context) => {
		const directory = await startDirectory({
			accounts: [{ email: CAST.newcomer.email, id: CAST.newcomer.subject }],
		});
		cleanupFor(context).defer(() => directory.stop());
		await withHarness({ configuration: directory.configuration, fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const terms = grantFor(CAST.newcomer);
			const before = await rowCounts(harness);

			const unheld = await createGrant(owner, {
				...terms,
				holder: { email: NOBODY },
			});
			const afterUnheld = await rowCounts(harness);
			const held = await createGrant(owner, {
				...terms,
				holder: { email: CAST.newcomer.email },
			});

			assertSucceeded(held, 'the grant to an address an account holds');
			assert.deepEqual(comparableSuccess(unheld), comparableSuccess(held));
			assert.deepEqual(afterUnheld, before);
			assert.equal((await storedGrants(harness, { holder: CAST.newcomer.subject })).length, 1);
			assert.deepEqual(
				(await creationRows(harness.clients.migration)).map(({ granteeSubject, reason, result, severity }) => ({
					granteeSubject,
					reason,
					result,
					severity,
				})),
				[
					{
						granteeSubject: undefined,
						reason: PROBLEMS.holderNotFound.code,
						result: 'denied',
						severity: 'warning',
					},
					{
						granteeSubject: CAST.newcomer.subject,
						reason: undefined,
						result: 'succeeded',
						severity: 'info',
					},
				],
			);
		});
	});

	test('records a directory unable to answer as failed at error, writing nothing and naming neither its secret nor its host', async (context) => {
		const directory = await startDirectory({
			accounts: [{ email: CAST.newcomer.email, id: CAST.newcomer.subject }],
		});
		cleanupFor(context).defer(() => directory.stop());
		directory.failLookupsFrom(1);
		const log = captureLog();
		await withHarness(
			{
				configuration: { ...directory.configuration, logStream: log.stream },
				fixture: grantsFixture(),
			},
			async (harness) => {
				const before = await rowCounts(harness);

				const refused = await addSubmitter(await administratorCaller(harness), STUDY_A1, CAST.newcomer.email);

				assertRefused(refused, PROBLEMS.directoryUnavailable, 'the addition');
				assert.deepEqual(await rowCounts(harness), before);
				assert.deepEqual(
					(await creationRows(harness.clients.migration)).map(({ reason, result, severity }) => ({
						reason,
						result,
						severity,
					})),
					[
						{
							reason: FAULT_REASONS.directoryUnavailable,
							result: 'failed',
							severity: 'error',
						},
					],
				);
				const { host } = new URL(directory.configuration.directoryUrl);
				const shown = [refused.text, ...log.lines(), ...(await auditRowTexts(harness.clients.migration))].join(
					'\n',
				);
				[directory.configuration.directoryClientSecret, host].forEach((withheld) => {
					assert.equal(shown.includes(withheld), false);
				});
			},
		);
	});

	test('records an address operation with no directory configured as failed at warning, with no time to try again', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const before = await rowCounts(harness);

			const refused = await addSubmitter(await administratorCaller(harness), STUDY_A1, CAST.newcomer.email);

			assertRefused(refused, PROBLEMS.directoryNotConfigured, 'the addition');
			assert.equal(refused.headers.get('retry-after'), null);
			assert.deepEqual(await rowCounts(harness), before);
			assert.deepEqual(
				(await creationRows(harness.clients.migration)).map(({ reason, result, severity }) => ({
					reason,
					result,
					severity,
				})),
				[
					{
						reason: PROBLEMS.directoryNotConfigured.code,
						result: 'failed',
						severity: 'warning',
					},
				],
			);
		});
	});
});
