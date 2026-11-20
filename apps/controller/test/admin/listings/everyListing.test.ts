import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	type AdminResponse,
	assertCredentialRefused,
	assertSucceeded,
	assertUnavailable,
	INCLUDING_REVOKED,
	listOwnGrants,
	listPersonGrants,
	listResourceGrants,
	listResources,
	managementRouteOfOperation,
	mediaTypeOf,
	readResource,
} from '../../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	awaitEventsOfType,
	credentialRefusalsElsewhere,
	EXCHANGE_REFUSAL_REASONS,
	eventsIn,
	managementTokenRefusal,
	managementTokenRefusalsIn,
} from '../../../testing/harness/auditEvents.js';
import { startRelay } from '../../../testing/harness/containers.js';
import { captureLog } from '../../../testing/harness/controller.js';
import { PEOPLE } from '../../../testing/harness/exchange.js';
import {
	AUTHENTICATION_POLICY,
	CAST,
	fileRealm,
	type ListingWorld,
	listingPolicy,
	startListingWorld,
	startStandInHarness,
	STUDIES,
	wholeSecondNow,
} from '../../../testing/fixtures/listings.js';
import { internalIdsInStore } from '../../../testing/harness/policy.js';
import { cleanupFor, nowSeconds } from '../../../testing/harness/waiting.js';

const realm = fileRealm();

const PERSON_TO_ADMINISTRATOR = "a person's grants, to an administrator";

interface NamedAnswer {
	answer: AdminResponse;
	name: string;
}

const answered = async (
	requests: Readonly<Record<string, () => Promise<AdminResponse>>>,
): Promise<readonly NamedAnswer[]> =>
	Promise.all(
		Object.entries(requests).map(async ([name, request]) => ({
			answer: await request(),
			name,
		})),
	);

const everyListing = async (world: ListingWorld): Promise<readonly NamedAnswer[]> => {
	const administrator = await world.caller('administrator');
	const owner = await world.caller('ana');
	const holder = await world.caller('bo');
	return answered({
		"a holder's own grants": () => listOwnGrants(holder),
		[PERSON_TO_ADMINISTRATOR]: () => listPersonGrants(administrator, CAST.bo),
		"a person's grants, to an owner": () => listPersonGrants(owner, CAST.bo),
		'a resource, to an administrator': () => readResource(administrator, STUDIES.a1),
		'a resource, to an owner': () => readResource(owner, STUDIES.a1),
		"a resource's grants, revoked ones included, to an administrator": () =>
			listResourceGrants(administrator, STUDIES.a1, INCLUDING_REVOKED),
		"a resource's grants, to an owner": () => listResourceGrants(owner, STUDIES.a1),
		"an administrator's own grants": () => listOwnGrants(administrator),
		'the resources, to an administrator': () => listResources(administrator),
		'the resources, to an owner': () => listResources(owner),
	});
};

suite('what every listing answers', () => {
	test("requires a valid sign-in token on every listing, recording an expired token's first refusal with its route and counting every later one in its window", async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const log = captureLog();
		const harness = await startStandInHarness(scope, started, AUTHENTICATION_POLICY, { logStream: log.stream });
		const now = nowSeconds();
		const valid = await administratorCaller(harness);
		const expired = await administratorCaller(harness, {
			mint: { claims: { exp: now - 60, iat: now - 360 } },
		});
		const listings: readonly (readonly [string, (caller: AdminCaller) => Promise<AdminResponse>])[] = [
			['the resources', (caller) => listResources(caller)],
			["the open resource's details", (caller) => readResource(caller, STUDIES.c3)],
			["a resource's grants", (caller) => listResourceGrants(caller, STUDIES.c3)],
			["a person's grants", (caller) => listPersonGrants(caller, CAST.holdsNothing)],
			["the caller's own grants", (caller) => listOwnGrants(caller)],
		];

		const routes = await Promise.all(listings.map(([, listing]) => managementRouteOfOperation(listing)));
		const since = log.lines().length;

		const answers = await Promise.all(
			listings.map(async ([name, listing]) => ({
				expired: await listing(expired),
				name,
				none: await listing(harness.caller(null)),
				valid: await listing(valid),
			})),
		);
		const refusals = managementTokenRefusalsIn(
			await awaitEventsOfType(log, AUDIT_EVENT_TYPES.managementTokenRefusal, {
				count: 1,
				since,
			}),
		);

		answers.forEach(({ expired: withExpired, name, none, valid: withValid }) => {
			assertSucceeded(withValid, `${name} with a valid token`);
			const refused: readonly (readonly [string, AdminResponse])[] = [
				['no token', none],
				['an expired token', withExpired],
			];
			refused.forEach(([credential, answer]) => {
				assertCredentialRefused(answer, `${name} with ${credential}`);
			});
		});
		// The listings run together, so the refusal recorded is that of whichever ran first.
		const [recorded] = refusals;
		assert.deepEqual(
			refusals,
			routes
				.filter(({ method, route }) => method === recorded?.method && route === recorded?.route)
				.slice(0, 1)
				.map((route) =>
					managementTokenRefusal(route, EXCHANGE_REFUSAL_REASONS.expiredToken, PEOPLE.administrator.subject),
				),
		);
		assert.deepEqual(credentialRefusalsElsewhere(eventsIn(log, since)), []);
	});

	test('names resources by externalId and people by subject, with no internal identifier', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const given = await startListingWorld(scope, started, {
			policy: listingPolicy(started, wholeSecondNow()),
		});
		const internal = await internalIdsInStore(given.harness.clients.migration);

		const answers = await everyListing(given);

		answers.forEach(({ answer, name }) => {
			assertSucceeded(answer, name);
			internal.forEach((id) => {
				assert.ok(!answer.text.toLowerCase().includes(id), `${name} carries an internal identifier`);
			});
		});
		const everything = answers.map(({ answer }) => answer.text).join('\n');
		assert.ok(everything.includes(STUDIES.a1));
		assert.ok(everything.includes(given.realm.subject('bo')));
	});

	test('carries no address stored by Usher', async (context) => {
		const scope = cleanupFor(context);
		const started = await realm();
		const relay = await startRelay(started.directory.directoryUrl);
		scope.defer(() => relay.stop());
		const given = await startListingWorld(scope, started, {
			configuration: { directoryUrl: relay.url.replace(/\/$/u, '') },
			policy: listingPolicy(started, wholeSecondNow()),
		});
		const resolved = [...Object.values(CAST), ...given.realm.resolvedNames];

		const reachable = await everyListing(given);
		await relay.cut();
		const unreachable = await everyListing(given);

		reachable.forEach(({ answer, name }) => {
			assertSucceeded(answer, `${name} with the directory reachable`);
		});
		const byAdministrator = reachable.find(({ name }) => name === 'the resources, to an administrator');
		assert.ok(byAdministrator?.answer.text.includes(CAST.bo));
		const earlierAnswers = new Map(reachable.map(({ answer, name }) => [name, answer]));
		unreachable.forEach(({ answer, name }) => {
			const earlier = earlierAnswers.get(name);
			if (earlier === undefined) {
				throw new Error(`${name} was not asked with the directory reachable`);
			}
			const neededTheDirectory = resolved.some((value) => earlier.text.includes(value));
			if (neededTheDirectory) {
				assertUnavailable(answer, name, 'directoryUnavailable');
				return;
			}
			assert.deepEqual(
				{
					body: answer.body,
					mediaType: mediaTypeOf(answer),
					status: answer.status,
				},
				{
					body: earlier.body,
					mediaType: mediaTypeOf(earlier),
					status: earlier.status,
				},
				name,
			);
		});
		const byAddress = unreachable.find(({ name }) => name === PERSON_TO_ADMINISTRATOR);
		if (byAddress === undefined) {
			throw new Error(`${PERSON_TO_ADMINISTRATOR} was not asked`);
		}
		assertUnavailable(byAddress.answer, PERSON_TO_ADMINISTRATOR, 'directoryUnavailable');
	});
});
