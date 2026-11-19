import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import pg from 'pg';

import {
	type AdminCaller,
	administratorCaller,
	managementRouteOfOperation,
	readApplication,
} from '../../test-support/admin.js';
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	auditRows,
	emittedType,
	EXCHANGE_REFUSAL_REASONS,
	managementTokenRefusal,
	REFUSED_SUBJECT_MEMBER,
} from '../../test-support/auditEvents.js';
import { exchange, type Person, type WireResponse } from '../../test-support/exchange.js';
import { type Harness, suiteHarness } from '../../test-support/harness.js';
import { POLICY_TABLES, qualified } from '../../test-support/policy.js';
import { nowSeconds } from '../../test-support/waiting.js';

const APPLICATION = 'Subject sign-outs';

const { subjectSignOuts } = POLICY_TABLES;

// Long enough before the test's own clock that every token minted at or around the sign-out is
// still current, and well within the lifetime the harness accepts.
const SIGNED_OUT_SECONDS_AGO = 30;

const quoted = (column: string): string => pg.escapeIdentifier(column);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// Someone the store has never met, so each test reads only the events naming its own person.
const freshPerson = (): Person => ({
	email: 'subject-sign-out@example.org',
	subject: randomUUID(),
});

const exchangeOf = (harness: Harness, credential: string): Promise<WireResponse> =>
	exchange(harness.url, {
		application: harness.application(APPLICATION),
		credential,
	});

// Records, as the back-channel logout does for a logout token naming the subject alone, a sign-out
// of the person under the trusted issuer at the instant given, in seconds since the Unix epoch.
const recordSubjectSignOut = async (harness: Harness, person: Person, signedOutAt: number): Promise<void> => {
	const { columns } = subjectSignOuts;
	await harness.clients.migration.query(
		`INSERT INTO ${qualified(subjectSignOuts)}
       (${quoted(columns.idpIssuer)}, ${quoted(columns.idpSubjectId)},
        ${quoted(columns.signedOutAt)}, ${quoted(columns.expiresAt)})
     VALUES ($1, $2, $3, $4)`,
		[
			harness.configuration.identityProviderIssuer,
			person.subject,
			new Date(signedOutAt * 1000),
			new Date((signedOutAt + 3600) * 1000),
		],
	);
};

// The data of every event of one type the trail holds naming a refused subject.
const refusalsNaming = async (
	harness: Harness,
	type: AuditEventType,
	subject: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
	(await auditRows(harness.clients.migration)).flatMap(({ data, type: rowType }) =>
		rowType === emittedType(type) && isRecord(data) && data[REFUSED_SUBJECT_MEMBER] === subject ? [data] : [],
	);

suite("a subject's sign-out, against the tokens issued around it", () => {
	const shared = suiteHarness({ applications: [APPLICATION] });

	test("refuses at the exchange a sign-in token issued a second before or at the instant of its subject's sign-out, recording each denied as signedOutSession, and issues one issued a second after it", async () => {
		const harness = await shared();
		const person = freshPerson();
		const signedOutAt = nowSeconds() - SIGNED_OUT_SECONDS_AGO;
		await recordSubjectSignOut(harness, person, signedOutAt);
		const issuedAt = (iat: number): Promise<string> =>
			harness.tokens.signIn(person, {
				application: APPLICATION,
				mint: { claims: { iat } },
			});
		const [before, atTheInstant, after] = await Promise.all([
			issuedAt(signedOutAt - 1),
			issuedAt(signedOutAt),
			issuedAt(signedOutAt + 1),
		]);

		const answers = [
			await exchangeOf(harness, before),
			await exchangeOf(harness, atTheInstant),
			await exchangeOf(harness, after),
		];
		const denials = await refusalsNaming(harness, AUDIT_EVENT_TYPES.tokenExchange, person.subject);

		assert.deepEqual(
			answers.map(({ status }) => status),
			[403, 403, 200],
		);
		assert.deepEqual(
			denials.map((data) => ({
				reason: data['reason'],
				result: data['result'],
			})),
			[
				{
					reason: EXCHANGE_REFUSAL_REASONS.signedOutSession,
					result: 'denied',
				},
				{
					reason: EXCHANGE_REFUSAL_REASONS.signedOutSession,
					result: 'denied',
				},
			],
		);
	});

	test("refuses at the Management API a management token issued a second before or at the instant of its subject's sign-out 401, recording a managementToken.refusal as signedOutSession for each, and answers one issued a second after it", async () => {
		const harness = await shared();
		const person = freshPerson();
		const { id } = harness.application(APPLICATION);
		const operation = await managementRouteOfOperation((recorded) => readApplication(recorded, id));
		const signedOutAt = nowSeconds() - SIGNED_OUT_SECONDS_AGO;
		await recordSubjectSignOut(harness, person, signedOutAt);
		const issuedAt = (iat: number): Promise<AdminCaller> =>
			administratorCaller(harness, { mint: { claims: { iat } }, person });
		const [before, atTheInstant, after] = await Promise.all([
			issuedAt(signedOutAt - 1),
			issuedAt(signedOutAt),
			issuedAt(signedOutAt + 1),
		]);

		const answers = [
			await readApplication(before, id),
			await readApplication(atTheInstant, id),
			await readApplication(after, id),
		];
		const refusals = await refusalsNaming(harness, AUDIT_EVENT_TYPES.managementTokenRefusal, person.subject);

		assert.deepEqual(
			answers.map(({ status }) => status),
			[401, 401, 200],
		);
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
			[
				managementTokenRefusal(operation, EXCHANGE_REFUSAL_REASONS.signedOutSession, person.subject),
				managementTokenRefusal(operation, EXCHANGE_REFUSAL_REASONS.signedOutSession, person.subject),
			],
		);
	});
});
