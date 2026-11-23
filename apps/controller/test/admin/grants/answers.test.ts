import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	addSubmitter,
	administratorCaller,
	type AdminResponse,
	answerGrant,
	assertRefused,
	assertSucceeded,
	assertUnreadable,
	createGrant,
	createSelfGrant,
	internalDetailIn,
	personCaller,
	PROBLEMS,
	removeSubmitter,
	revokeGrant,
} from '../../../testing/harness/admin.js';
import { unusedPort } from '../../../testing/harness/controller.js';
import {
	answerNames,
	CAST,
	createdId,
	grantFor,
	grantsFixture,
	HOUR_MS,
	instantFromNow,
	racedAtTheGrantsTable,
	selfGrantUntil,
	SHOWN,
	STUDY_A1,
	STUDY_B2,
	uncategorizedGrantFor,
	UNKNOWN_STUDY,
} from '../../../testing/fixtures/grants.js';
import { withHarness } from '../../../testing/harness/harness.js';
import { internalIdsInStore } from '../../../testing/harness/policy.js';

interface Named {
	/** The holder's subject and the resource's externalId, which a success answer names. */
	names?: readonly string[];

	operation: string;
	outcome: 'refused' | 'succeeded';
	response: AdminResponse;
}

suite('naming people and resources in answers', () => {
	test('names holders by subject and resources by externalId in every answer, with no internal identifier', async () => {
		await withHarness({ fixture: grantsFixture() }, async (harness) => {
			const owner = await personCaller(harness, CAST.ownerOfA1);
			const administrator = await administratorCaller(harness);

			const consumer = await createGrant(owner, grantFor(CAST.recipient));
			const consumerId = createdId(consumer, "the owner's grant");
			const answers: readonly Named[] = [
				{
					names: [CAST.recipient.subject, STUDY_A1],
					operation: "an owner's grant",
					outcome: 'succeeded',
					response: consumer,
				},
				{
					names: [CAST.curator.subject, STUDY_A1],
					operation: 'a submitter grant',
					outcome: 'succeeded',
					response: await createGrant(administrator, uncategorizedGrantFor(CAST.curator, 'submitter')),
				},
				{
					names: [CAST.recipient.subject, STUDY_B2],
					operation: 'an owner grant',
					outcome: 'succeeded',
					response: await createGrant(
						administrator,
						uncategorizedGrantFor(CAST.recipient, 'owner', STUDY_B2),
					),
				},
				{
					names: [CAST.administrator.subject, STUDY_A1],
					operation: 'a self-grant',
					outcome: 'succeeded',
					response: await createSelfGrant(administrator, selfGrantUntil(instantFromNow(2 * HOUR_MS))),
				},
				{
					operation: 'an answer',
					outcome: 'succeeded',
					response: await answerGrant(await personCaller(harness, CAST.recipient), consumerId, {
						capabilities: SHOWN.viewer,
						decision: 'accept',
					}),
				},
				{
					operation: 'a grant already held',
					outcome: 'refused',
					response: await createGrant(owner, grantFor(CAST.recipient)),
				},
				{
					operation: 'a grant on an unknown resource',
					outcome: 'refused',
					response: await createGrant(owner, grantFor(CAST.recipient, { resource: UNKNOWN_STUDY })),
				},
				{
					operation: 'a grant expiring in the past',
					outcome: 'refused',
					response: await createGrant(
						owner,
						grantFor(CAST.recipient, {
							expiresAt: instantFromNow(-HOUR_MS),
							role: 'editor',
						}),
					),
				},
				{
					operation: "an administrator's consumer grant",
					outcome: 'refused',
					response: await createGrant(administrator, grantFor(CAST.recipient, { resource: STUDY_B2 })),
				},
				{
					operation: 'a revocation without authority',
					outcome: 'refused',
					response: await revokeGrant(await personCaller(harness, CAST.outsider), consumerId),
				},
				{
					operation: 'an addition by address with no directory',
					outcome: 'refused',
					response: await addSubmitter(administrator, STUDY_A1, CAST.recipient.email),
				},
				{
					operation: 'a removal by address with no directory',
					outcome: 'refused',
					response: await removeSubmitter(administrator, STUDY_A1, CAST.recipient.email),
				},
				{
					names: [CAST.recipient.subject, STUDY_A1],
					operation: 'a revocation',
					outcome: 'succeeded',
					response: await revokeGrant(administrator, consumerId),
				},
			];

			const identifiers = await internalIdsInStore(harness.clients.migration);
			assert.ok(identifiers.length > 0, 'the store holds internal identifiers');
			answers.forEach(({ names = [], operation, outcome, response }) => {
				if (outcome === 'succeeded') {
					assertSucceeded(response, operation);
				} else {
					assert.ok(response.status >= 400, `${operation} is refused`);
				}
				assert.deepEqual(
					internalDetailIn(response.text, identifiers),
					[],
					`${operation} carries nothing internal`,
				);
				names.forEach((name) => {
					assert.ok(answerNames(response, name), `${operation} names ${name}`);
				});
			});
		});
	});

	test('answers every refusal with its error code alone', async () => {
		const directory = {
			directoryClientId: 'usher-directory',
			directoryClientSecret: randomBytes(24).toString('base64url'),
			directoryRealm: 'overture',
			directoryUrl: `http://127.0.0.1:${await unusedPort()}`,
		};
		// Longer than the grants table hold racedAtTheGrantsTable takes: each creation waits it out rather than timing out.
		await withHarness(
			{ configuration: { ...directory, storeTimeoutMilliseconds: 15_000 }, fixture: grantsFixture() },
			async (harness) => {
				const owner = await personCaller(harness, CAST.ownerOfA1);

				const invalidJson = await createGrant(owner, grantFor(CAST.recipient), {
					body: `{"resource": "${STUDY_A1}",`,
				});
				const race = await racedAtTheGrantsTable(harness, 3, () =>
					createGrant(owner, grantFor(CAST.recipient)),
				);
				const unreachable = await addSubmitter(
					await administratorCaller(harness),
					STUDY_A1,
					CAST.recipient.email,
				);

				const lost = race.filter(({ status }) => status >= 300);
				assert.equal(lost.length, 2, 'two creations lose the race');
				assertUnreadable(invalidJson, 'an invalid body');
				lost.forEach((answer, index) => {
					assertRefused(answer, PROBLEMS.alreadyHolds, `losing creation ${index}`);
				});
				assertRefused(unreachable, PROBLEMS.directoryUnavailable, 'a directory unreachable');
				const identifiers = await internalIdsInStore(harness.clients.migration);
				[invalidJson, ...lost, unreachable].forEach((answer) => {
					assert.deepEqual(
						internalDetailIn(answer.text, identifiers),
						[],
						`an answer ${answer.status} carries nothing internal`,
					);
					[directory.directoryClientSecret, directory.directoryUrl.replace('http://', '')].forEach(
						(withheld) => {
							assert.ok(
								!answer.text.toLowerCase().includes(withheld.toLowerCase()),
								`an answer ${answer.status} carries what it must withhold`,
							);
						},
					);
				});
			},
		);
	});
});
