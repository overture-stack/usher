import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import {
	type AdminCaller,
	administratorCaller,
	managementRouteOfOperation,
	readApplication,
} from '../../testing/harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	auditRows,
	emittedType,
	EXCHANGE_REFUSAL_REASONS,
	managementTokenRefusal,
	REFUSED_SUBJECT_MEMBER,
} from '../../testing/harness/auditEvents.js';
import { exchange, type Person, type WireResponse } from '../../testing/harness/exchange.js';
import { type Harness, suiteHarness } from '../../testing/harness/harness.js';

const APPLICATION = 'Sign-in token lifetime';

// Below the harness's own maximum, so the limit judged is the one this suite configures, and above the
// lifetime of the tokens the harness mints for itself by default, so the harness still registers its
// application.
const MAXIMUM_LIFETIME_SECONDS = 900;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// Someone the store has never met, so each test reads only the events naming its own person.
const freshPerson = (): Person => ({
	email: 'lifetime@example.org',
	subject: randomUUID(),
});

const exchangeOf = (harness: Harness, credential: string): Promise<WireResponse> =>
	exchange(harness.url, {
		application: harness.application(APPLICATION),
		credential,
	});

// The data of every event of one type the trail holds naming a refused subject.
const refusalsNaming = async (
	harness: Harness,
	type: AuditEventType,
	subject: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration)).flatMap(({ data, type: rowType }) =>
		rowType === emittedType(type) && isRecord(data) && data[REFUSED_SUBJECT_MEMBER] === subject ? [data] : [],
	);

suite("a sign-in or management token's lifetime, against the configured maximum", () => {
	const shared = suiteHarness({
		applications: [APPLICATION],
		configuration: {
			signInTokenMaximumLifetimeSeconds: MAXIMUM_LIFETIME_SECONDS,
		},
	});

	test('issues for a sign-in token living exactly the maximum, and refuses one living a second longer 403, recording it denied as excessiveLifetime naming its subject, its actor anonymous', async () => {
		const harness = await shared();
		const person = freshPerson();
		const signIn = (lifetimeSeconds: number): Promise<string> =>
			harness.tokens.signIn(person, {
				application: APPLICATION,
				mint: { lifetimeSeconds },
			});
		const [atTheMaximum, pastTheMaximum] = await Promise.all([
			signIn(MAXIMUM_LIFETIME_SECONDS),
			signIn(MAXIMUM_LIFETIME_SECONDS + 1),
		]);

		const issued = await exchangeOf(harness, atTheMaximum);
		const refused = await exchangeOf(harness, pastTheMaximum);
		const denials = await refusalsNaming(harness, AUDIT_EVENT_TYPES.tokenExchange, person.subject);

		assert.deepEqual([issued.status, refused.status], [200, 403]);
		assert.deepEqual(
			denials.map((data) => ({
				actorId: data['actorId'],
				actorType: data['actorType'],
				reason: data['reason'],
				result: data['result'],
			})),
			[
				{
					actorId: null,
					actorType: 'anonymous',
					reason: EXCHANGE_REFUSAL_REASONS.excessiveLifetime,
					result: 'denied',
				},
			],
		);
	});

	test('answers a management token living exactly the maximum, and refuses one living a second longer 401, recording a managementToken.refusal as excessiveLifetime naming its subject', async () => {
		const harness = await shared();
		const person = freshPerson();
		const { id } = harness.application(APPLICATION);
		const operation = await managementRouteOfOperation((recorded) => readApplication(recorded, id));
		const callerFor = (lifetimeSeconds: number): Promise<AdminCaller> =>
			administratorCaller(harness, { mint: { lifetimeSeconds }, person });
		const [atTheMaximum, pastTheMaximum] = await Promise.all([
			callerFor(MAXIMUM_LIFETIME_SECONDS),
			callerFor(MAXIMUM_LIFETIME_SECONDS + 1),
		]);

		const answered = await readApplication(atTheMaximum, id);
		const refused = await readApplication(pastTheMaximum, id);
		const refusals = await refusalsNaming(harness, AUDIT_EVENT_TYPES.managementTokenRefusal, person.subject);

		assert.deepEqual([answered.status, refused.status], [200, 401]);
		assert.deepEqual(
			refusals.map((data) => ({
				actorId: data['actorId'],
				actorType: data['actorType'],
				method: data['method'],
				reason: data['reason'],
				refusedSubject: data[REFUSED_SUBJECT_MEMBER],
				result: data['result'],
				route: data['route'],
			})),
			[managementTokenRefusal(operation, EXCHANGE_REFUSAL_REASONS.excessiveLifetime, person.subject)],
		);
	});
});
