import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	assertRefused,
	assertSucceeded,
	PROBLEMS,
	registerResource,
} from '../../testing/harness/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, auditRowTexts, dataOf, emittedType } from '../../testing/harness/auditEvents.js';
import { startDirectory } from '../../testing/peripherals/directory.js';
import { CAST, rowCounts } from '../../testing/fixtures/grants.js';
import { registration, registrationFixture } from '../../testing/fixtures/resources.js';
import { withHarness } from '../../testing/harness/harness.js';
import { inTurn, liveGrantId } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

// Two people the directory holds, neither of whom the store has met.
const OWNERS = [CAST.newcomer, CAST.spare];

suite("a registration's owners named by address, in the store", () => {
	test('commits an owner grant for each address under the subject of the account holding it, in the order named, the first its initialOwnerSubject, storing no address', async (context) => {
		const directory = await startDirectory({
			accounts: OWNERS.map(({ email, subject }) => ({ email, id: subject })),
		});
		cleanupFor(context).defer(() => directory.stop());
		await withHarness(
			{
				configuration: directory.configuration,
				fixture: registrationFixture(),
			},
			async (harness) => {
				const { migration } = harness.clients;

				const answer = await registerResource(
					await administratorCaller(harness),
					registration('STUDY-N1', {
						accessLevel: 'grant',
						owners: OWNERS.map(({ email }) => ({ email: email.toUpperCase() })),
					}),
				);

				assertSucceeded(answer, 'the registration naming two owners by address');
				const grantIds = await inTurn(OWNERS, ({ subject }) =>
					liveGrantId(migration, {
						category: null,
						holder: subject,
						resource: 'STUDY-N1',
						role: 'owner',
					}),
				);
				assert.equal(grantIds.length, 2);
				const events = (await auditRows(migration)).filter(
					({ data }) =>
						typeof data === 'object' && data !== null && Reflect.get(data, 'resourceId') === 'STUDY-N1',
				);
				assert.deepEqual(
					events
						.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.resourceRegistration))
						.map((event) => dataOf(event)['initialOwnerSubject']),
					[OWNERS[0]?.subject],
				);
				assert.deepEqual(
					events
						.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.grantCreation))
						.map((event) => dataOf(event)['granteeSubject']),
					OWNERS.map(({ subject }) => subject),
				);
				const texts = await auditRowTexts(migration);
				OWNERS.forEach(({ email }) => {
					assert.equal(
						texts.some((text) => text.toLowerCase().includes(email.toLowerCase())),
						false,
					);
				});
			},
			context,
		);
	});

	test('writes nothing of a registration naming an owner by an address no single account holds', async (context) => {
		const directory = await startDirectory({
			accounts: OWNERS.map(({ email, subject }) => ({ email, id: subject })),
		});
		cleanupFor(context).defer(() => directory.stop());
		await withHarness(
			{
				configuration: directory.configuration,
				fixture: registrationFixture(),
			},
			async (harness) => {
				const before = await rowCounts(harness);

				const answer = await registerResource(
					await administratorCaller(harness),
					registration('STUDY-N1', {
						accessLevel: 'grant',
						owners: [{ email: OWNERS[0]?.email ?? '' }, { email: 'nobody@example.org' }],
					}),
				);

				assertRefused(answer, PROBLEMS.holderNotFound, 'the registration');
				assert.deepEqual(await rowCounts(harness), before);
			},
			context,
		);
	});
});
