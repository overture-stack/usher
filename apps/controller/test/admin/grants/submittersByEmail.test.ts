import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	addSubmitter,
	type AdminResponse,
	answerGrant,
	assertRefused,
	assertRuleBroken,
	assertSucceeded,
	assertUnreadable,
	comparableRefusal,
	comparableSuccess,
	createGrant,
	internalDetailIn,
	PROBLEMS,
	removeSubmitter,
	revokeGrant,
} from '../../../testing/harness/admin.js';
import { startRelay } from '../../../testing/harness/containers.js';
import {
	ADDRESSES,
	type AddressSession,
	createdId,
	directoryClientOf,
	grantFor,
	OPEN_STUDY,
	rowCounts,
	sharedAddressRealm,
	SHOWN,
	type SignedIn,
	storedDecisions,
	type StoredGrant,
	storedGrants,
	STUDY_A1,
	STUDY_B2,
	UNKNOWN_STUDY,
	withAddressHarness,
} from '../../../testing/fixtures/grants.js';
import { internalIdsInStore, inTurn, seedAdministrator } from '../../../testing/harness/policy.js';
import { cleanupFor } from '../../../testing/harness/waiting.js';

const NOBODY = 'nobody@example.org';

// Signs the realm's administrator in and seeds them as one of Usher's administrators, since the store,
// not the token, decides who is one.
const signedInAdministrator = async (session: AddressSession): ReturnType<AddressSession['signIn']> => {
	const administrator = await session.signIn(ADDRESSES.administrator);
	await seedAdministrator(session.harness.clients.migration, {
		issuer: session.keycloak.issuer,
		subject: administrator.subject,
	});
	return administrator;
};

const liveSubmitterGrants = async (
	session: AddressSession,
	{ subject }: SignedIn,
	resource: string = STUDY_A1,
): Promise<readonly StoredGrant[]> =>
	(
		await storedGrants(session.harness, {
			holder: subject,
			resource,
			role: 'submitter',
		})
	).filter(({ revokedAt }) => revokedAt === null);

const addedBy = (
	session: AddressSession,
	caller: SignedIn,
	addresses: readonly string[],
	resource: string = STUDY_A1,
): Promise<readonly { address: string; answer: AdminResponse }[]> =>
	inTurn(addresses, async (address) => ({
		address,
		answer: await addSubmitter(session.caller(caller), resource, address),
	}));

const assertNamesNoInternalIdentifier = async (
	session: AddressSession,
	response: AdminResponse,
	what: string,
): Promise<void> => {
	const identifiers = await internalIdsInStore(session.harness.clients.migration);
	assert.ok(identifiers.length > 0, 'the store holds internal identifiers');
	assert.deepEqual(internalDetailIn(response.text, identifiers), [], `${what} carries nothing internal`);
};

const assertNoAccount = (answered: readonly { address: string; answer: AdminResponse }[]): void => {
	answered.forEach(({ address, answer }) => {
		assertRefused(answer, PROBLEMS.holderNotFound, JSON.stringify(address));
	});
};

suite('adding and removing a submitter by email', () => {
	const realm = sharedAddressRealm();

	test('adds a submitter by email as a grant at the submitter role', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);

			const added = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertSucceeded(added, 'adding the submitter');
			await assertNamesNoInternalIdentifier(session, added, 'the addition');
			assert.deepEqual(
				(await liveSubmitterGrants(session, submitter)).map(({ category, granterSubject, holderIssuer }) => ({
					category,
					granter: granterSubject,
					issuer: holderIssuer,
				})),
				[
					{
						category: session.harness.configuration.submitterCategory,
						granter: administrator.subject,
						issuer: session.keycloak.issuer,
					},
				],
			);
		});
	});

	test('finds an account by its exact address', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);
			const before = await rowCounts(session.harness);

			const nearMisses = await addedBy(session, administrator, [
				ADDRESSES.submitter.replace(/\.org$/u, ''),
				ADDRESSES.submitter.slice(1),
			]);
			const after = await rowCounts(session.harness);
			const exact = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertNoAccount(nearMisses);
			assert.deepEqual(after, before);
			assertSucceeded(exact, 'the exact address');
			const submitters = await storedGrants(session.harness, {
				resource: STUDY_A1,
				role: 'submitter',
			});
			assert.deepEqual(
				submitters.map(({ holderSubject }) => holderSubject),
				[submitter.subject],
			);
		});
	});

	test('finds an account by its address in any letter case', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);

			const added = await addSubmitter(session.caller(administrator), STUDY_A1, 'Sub.Bo@Example.ORG');

			assertSucceeded(added, 'the address in other letter case');
			assert.equal((await liveSubmitterGrants(session, submitter)).length, 1);
		});
	});

	test('reads search wildcards in an address as literal characters', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);
			const before = await rowCounts(session.harness);

			const wildcards = await addedBy(session, administrator, [
				's*@example.org',
				'*@example.org',
				'%@example.org',
				'_ub.bo@example.org',
			]);
			const after = await rowCounts(session.harness);
			const literal = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertNoAccount(wildcards);
			assert.deepEqual(after, before);
			assertSucceeded(literal, 'the address itself');
			assert.equal((await liveSubmitterGrants(session, submitter)).length, 1);
		});
	});

	test('finds an account whose address holds non-ASCII or plus-addressed text', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const accounts = await inTurn([ADDRESSES.nonAscii, ADDRESSES.plusAddressed], async (address) => ({
				address,
				account: await session.signIn(address),
			}));
			const before = await rowCounts(session.harness);

			const unheld = await addedBy(session, administrator, ['bo@example.org']);
			const after = await rowCounts(session.harness);
			const found = await addedBy(
				session,
				administrator,
				accounts.map(({ address }) => address),
			);

			assertNoAccount(unheld);
			assert.deepEqual(after, before);
			found.forEach(({ address, answer }) => {
				assertSucceeded(answer, `adding ${address}`);
			});
			const holders = await inTurn(
				accounts,
				async ({ account }) => (await liveSubmitterGrants(session, account)).length,
			);
			assert.deepEqual(holders, [1, 1]);
		});
	});

	test('binds a grant by email only to an account holding that address verified', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const before = await rowCounts(session.harness);

			const unverified = await addedBy(session, administrator, [ADDRESSES.unverified]);
			const after = await rowCounts(session.harness);
			const verified = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertNoAccount(unverified);
			assert.deepEqual(after, before);
			assertSucceeded(verified, 'a verified address');
		});
	});

	test('grants by email to an account that is disabled', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const paused = await session.signIn(ADDRESSES.disabledLater);
			await session.keycloak.disableUser(ADDRESSES.disabledLater);

			const added = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.disabledLater);

			assertSucceeded(added, 'adding a disabled account');
			assert.equal((await liveSubmitterGrants(session, paused)).length, 1);
		});
	});

	test('answers an address no account holds with the no-account error', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const before = await rowCounts(session.harness);

			const unheld = await addedBy(session, administrator, [NOBODY]);
			const after = await rowCounts(session.harness);
			const held = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertNoAccount(unheld);
			assert.deepEqual(after, before);
			assertSucceeded(held, 'an address an account holds');
		});
	});

	test("answers an owner's addition alike whether or not an account holds the address", async () => {
		await withAddressHarness(realm, async (session) => {
			const submitter = await session.signIn(ADDRESSES.submitter);
			const owner = session.caller(session.owner);
			const before = await rowCounts(session.harness);

			const unheld = await addSubmitter(owner, STUDY_A1, NOBODY);
			const after = await rowCounts(session.harness);
			const held = await addSubmitter(owner, STUDY_A1, ADDRESSES.submitter);

			assertSucceeded(held, 'an address an account holds');
			assert.deepEqual(comparableSuccess(unheld), comparableSuccess(held));
			assert.deepEqual(after, before);
			assert.equal((await liveSubmitterGrants(session, submitter)).length, 1);
		});
	});

	test('binds no grant to an address several accounts hold', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const before = await rowCounts(session.harness);

			const shared = await addedBy(session, administrator, [ADDRESSES.duplicated]);
			const after = await rowCounts(session.harness);
			const single = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertNoAccount(shared);
			assert.deepEqual(after, before);
			assertSucceeded(single, 'an address one account holds');
		});
	});

	test('answers as unavailable while the directory cannot be reached', async (context) => {
		const scope = cleanupFor(context);
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const directory = session.keycloak.directoryFor(directoryClientOf(session.options));
			const relay = await startRelay(directory.directoryUrl, {
				protocol: 'http',
			});
			scope.defer(() => relay.stop());
			await session.harness.restart({
				directoryUrl: relay.url.replace(/\/$/u, ''),
			});
			const add = (address: string): Promise<AdminResponse> =>
				addSubmitter(session.caller(administrator), STUDY_A1, address);

			await relay.cut();
			const beforeOutage = await rowCounts(session.harness);
			const whileCut = await add(ADDRESSES.submitter);
			const afterOutage = await rowCounts(session.harness);
			await relay.setMode({ kind: 'pass' });
			const onceRestored = await add(ADDRESSES.submitter);
			await session.harness.restart({
				directoryClientSecret: 'not-the-directory-secret',
			});
			const beforeRefusal = await rowCounts(session.harness);
			const underRefusedCredential = await add(ADDRESSES.nearMissPrefixed);
			const afterRefusal = await rowCounts(session.harness);
			await session.harness.restart({
				directoryClientSecret: directory.directoryClientSecret,
			});
			const underCredential = await add(ADDRESSES.nearMissPrefixed);

			assertRefused(whileCut, PROBLEMS.directoryUnavailable, 'the directory cut off');
			assert.deepEqual(afterOutage, beforeOutage);
			assertSucceeded(onceRestored, 'adding once the directory answers again');
			assertRefused(
				underRefusedCredential,
				PROBLEMS.directoryUnavailable,
				"the directory refusing the controller's credential",
			);
			assert.deepEqual(afterRefusal, beforeRefusal);
			assertSucceeded(underCredential, 'adding under the right credential');
		});
	});

	test("accepts an address only in an address's form", async (context) => {
		const scope = cleanupFor(context);
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const relay = await startRelay(
				session.keycloak.directoryFor(directoryClientOf(session.options)).directoryUrl,
				{ protocol: 'http' },
			);
			scope.defer(() => relay.stop());
			await session.harness.restart({
				directoryUrl: relay.url.replace(/\/$/u, ''),
			});
			const caller = session.caller(administrator);
			const malformed = [
				'',
				'bo',
				'bo@',
				'sub.bo',
				` ${ADDRESSES.submitter}`,
				`${ADDRESSES.submitter} `,
				`${ADDRESSES.submitter}\n`,
				'a@example.org,b@example.org',
			];
			await relay.cut();
			const before = await rowCounts(session.harness);

			const additions = await inTurn(malformed, async (address) => ({
				answer: await addSubmitter(caller, STUDY_A1, address),
				name: `adding ${JSON.stringify(address)}`,
			}));
			const listed = await addSubmitter(caller, STUDY_A1, ADDRESSES.submitter, {
				extraMembers: {
					holder: { email: ['a@example.org', 'b@example.org'] },
				},
			});
			const removal = await removeSubmitter(caller, STUDY_A1, ` ${ADDRESSES.submitter}`);
			const after = await rowCounts(session.harness);
			await relay.setMode({ kind: 'pass' });
			const wellFormed = await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			[...additions, { answer: removal, name: 'removing an address with a space' }].forEach(
				({ answer, name }) => {
					assertRuleBroken(answer, name);
				},
			);
			assertUnreadable(listed, 'two addresses as a list');
			assert.deepEqual(after, before);
			assertSucceeded(wellFormed, 'a well-formed address');
		});
	});

	test('answers an addition of someone already in the study with the already-holds error', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);
			const add = (): Promise<AdminResponse> =>
				addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);
			const answer = async (decision: 'accepted' | 'rejected'): Promise<void> => {
				const [grant] = await liveSubmitterGrants(session, submitter);
				const grantId = grant?.id ?? assert.fail('no grant holds the subject');
				assertSucceeded(
					await answerGrant(session.caller(submitter), grantId, {
						capabilities: SHOWN.submitter,
						decision,
					}),
					`the submitter's answer ${decision}`,
				);
			};
			assertSucceeded(await add(), 'the first addition');

			const whilePending = await add();
			await answer('accepted');
			const whileAccepted = await add();
			await answer('rejected');
			const whileDeclined = await add();

			[whilePending, whileAccepted, whileDeclined].forEach((again, index) => {
				assertRefused(again, PROBLEMS.alreadyHolds, `addition ${index + 2}`);
			});
			assert.equal(
				(
					await storedGrants(session.harness, {
						holder: submitter.subject,
						role: 'submitter',
					})
				).length,
				1,
			);
		});
	});

	test('removes a submitter by email by revoking their submitter grant', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);
			assertSucceeded(
				await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter),
				'the addition',
			);
			const [added] = await liveSubmitterGrants(session, submitter);

			const removed = await removeSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			assertSucceeded(removed, 'the removal');
			await assertNamesNoInternalIdentifier(session, removed, 'the removal');
			const [revoked] = await storedGrants(session.harness, {
				id: added?.id ?? assert.fail('the addition wrote no grant'),
			});
			assert.notEqual(revoked?.revokedAt, null);
			assert.equal(revoked?.revokerSubject, administrator.subject);
		});
	});

	test('answers a removal of someone not in the study with the does-not-hold error', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const submitter = await session.signIn(ADDRESSES.submitter);
			const remove = (): Promise<AdminResponse> =>
				removeSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter);

			const neverAdded = await remove();
			assertSucceeded(
				await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter),
				'the addition',
			);
			const firstRemoval = await remove();
			const afterRevocation = await remove();
			const viewerId = createdId(
				await createGrant(session.caller(session.owner), grantFor(submitter)),
				"the owner's viewer grant",
			);
			const withViewerGrant = await remove();

			assertSucceeded(firstRemoval, 'removing a submitter');
			[
				{ answer: neverAdded, name: 'never added' },
				{ answer: afterRevocation, name: 'already removed' },
				{ answer: withViewerGrant, name: 'holding a viewer grant alone' },
			].forEach(({ answer, name }) => {
				assertRefused(answer, PROBLEMS.doesNotHold, name);
			});
			const [viewer] = await storedGrants(session.harness, { id: viewerId });
			assert.equal(viewer?.revokedAt, null);
		});
	});

	test('removes a submitter whose account was deleted, by their grant', async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			const leaving = await session.signIn(ADDRESSES.removedLater);
			assertSucceeded(
				await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.removedLater),
				'the addition',
			);
			const [added] = await liveSubmitterGrants(session, leaving);
			await session.keycloak.deleteUser(ADDRESSES.removedLater);

			const byAddress = await removeSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.removedLater);
			const stillLive = await liveSubmitterGrants(session, leaving);
			const byId = await revokeGrant(
				session.caller(administrator),
				added?.id ?? assert.fail('the addition wrote no grant'),
			);

			assertRefused(byAddress, PROBLEMS.holderNotFound, 'the deleted address');
			assert.equal(stillLive.length, 1);
			assertSucceeded(byId, 'revoking the grant by its id');
			assert.deepEqual(await liveSubmitterGrants(session, leaving), []);
		});
	});

	test('answers a caller without authority on the study the same way whatever the address', async () => {
		await withAddressHarness(realm, async (session) => {
			const outsider = session.caller(await session.signIn(ADDRESSES.outsider));
			const studies = [
				{ resource: STUDY_A1, seen: false },
				{ resource: UNKNOWN_STUDY, seen: false },
				{ resource: OPEN_STUDY, seen: true },
			];
			const before = await rowCounts(session.harness);

			const answers = await inTurn(
				studies.flatMap(({ resource, seen }) =>
					[ADDRESSES.submitter, NOBODY].flatMap((address) =>
						['add', 'remove'].map((operation) => ({
							address,
							operation,
							resource,
							seen,
						})),
					),
				),
				async ({ address, operation, resource, seen }) => ({
					answer:
						operation === 'add'
							? await addSubmitter(outsider, resource, address)
							: await removeSubmitter(outsider, resource, address),
					group: `${operation} on a study ${seen ? 'seen' : 'unseen'}`,
					name: `${operation} ${address} on ${resource}`,
					seen,
				}),
			);
			const after = await rowCounts(session.harness);
			const byAdministrator = await addSubmitter(
				session.caller(await signedInAdministrator(session)),
				STUDY_A1,
				ADDRESSES.submitter,
			);

			answers.forEach(({ answer, name, seen }) => {
				assertRefused(answer, seen ? PROBLEMS.noAuthorityOnResource : PROBLEMS.resourceNotFound, name);
			});
			[...new Set(answers.map(({ group }) => group))].forEach((group) => {
				const [first, ...rest] = answers.filter((answered) => answered.group === group);
				if (first === undefined) {
					return assert.fail(`nothing was sent to ${group}`);
				}
				rest.forEach(({ answer, name }) => {
					assert.deepEqual(comparableRefusal(answer), comparableRefusal(first.answer), name);
				});
			});
			assert.deepEqual(after, before);
			assertSucceeded(byAdministrator, "an administrator's addition");
		});
	});

	test('lets an owner add and remove submitters on their own study only', async () => {
		await withAddressHarness(realm, async (session) => {
			const submitter = await session.signIn(ADDRESSES.submitter);
			const owner = session.caller(session.owner);

			const added = await addSubmitter(owner, STUDY_A1, ADDRESSES.submitter);
			const [grant] = await liveSubmitterGrants(session, submitter);
			const removed = await removeSubmitter(owner, STUDY_A1, ADDRESSES.submitter);
			const onOther = await addSubmitter(owner, STUDY_B2, ADDRESSES.submitter);
			const onUnknown = await addSubmitter(owner, UNKNOWN_STUDY, ADDRESSES.submitter);

			assertSucceeded(added, 'adding on their own study');
			assert.equal(grant?.granterSubject, session.owner.subject);
			assertSucceeded(removed, 'removing on their own study');
			const [revoked] = await storedGrants(session.harness, {
				id: grant?.id ?? assert.fail('the addition wrote no grant'),
			});
			assert.equal(revoked?.revokerSubject, session.owner.subject);
			assertRefused(onOther, PROBLEMS.resourceNotFound, 'another study');
			assert.deepEqual(comparableRefusal(onOther), comparableRefusal(onUnknown));
			assert.deepEqual(await liveSubmitterGrants(session, submitter, STUDY_B2), []);
		});
	});

	test("writes a submitter's grant under the subject the account's tokens carry", async () => {
		await withAddressHarness(realm, async (session) => {
			const administrator = await signedInAdministrator(session);
			assertSucceeded(
				await addSubmitter(session.caller(administrator), STUDY_A1, ADDRESSES.submitter),
				'the addition',
			);
			const submitter = await session.signIn(ADDRESSES.submitter);
			const [grant] = await liveSubmitterGrants(session, submitter);
			const grantId = grant?.id ?? assert.fail('no grant holds the subject');

			const accepted = await answerGrant(session.caller(submitter), grantId, {
				capabilities: SHOWN.submitter,
				decision: 'accepted',
			});

			assertSucceeded(accepted, "the submitter's acceptance");
			assert.deepEqual(
				(await storedDecisions(session.harness, grantId)).map(({ decision, deciderSubject }) => ({
					decider: deciderSubject,
					decision,
				})),
				[{ decider: submitter.subject, decision: 'accepted' }],
			);
		});
	});
});
