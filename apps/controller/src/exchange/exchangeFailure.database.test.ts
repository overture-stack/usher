import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { AUDIT_EVENT_TYPES, auditRows, emittedType } from '../../testing/harness/auditEvents.js';
import { exchange, type Person } from '../../testing/harness/exchange.js';
import { withHarness } from '../../testing/harness/harness.js';
import { failNthInsert, POLICY_TABLES, rowCounts, usersWithSubject } from '../../testing/harness/policy.js';
import { cleanupFor } from '../../testing/harness/waiting.js';

const APPLICATION = 'Exchange failure';

const PERSON_TABLES = Object.freeze({
	exchangedSids: POLICY_TABLES.exchangedSids,
	userIdentities: POLICY_TABLES.userIdentities,
	users: POLICY_TABLES.users,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

suite("the exchange's store work failing against the store", () => {
	test("records a first exchange whose identity cannot be written as failed, storeUnavailable, keeping no person, identity or session, and serves the person's next exchange", async (context) => {
		await withHarness(
			{ applications: [APPLICATION] },
			async (harness) => {
				const { migration } = harness.clients;
				const person: Person = {
					email: 'first-exchange@example.org',
					subject: randomUUID(),
				};
				const exchangeAs = async (): Promise<number> =>
					(
						await exchange(harness.url, {
							application: harness.application(APPLICATION),
							credential: await harness.tokens.signIn(person, {
								application: APPLICATION,
							}),
						})
					).status;
				const before = await rowCounts(migration, PERSON_TABLES);
				const recordedBefore = new Set((await auditRows(migration)).map(({ id }) => id));
				const fault = await failNthInsert(cleanupFor(context), migration, POLICY_TABLES.userIdentities, 1);

				const refused = await exchangeAs();
				await fault.remove();
				const recorded = (await auditRows(migration)).flatMap(({ data, id, type }) =>
					!recordedBefore.has(id) && type === emittedType(AUDIT_EVENT_TYPES.tokenExchange) && isRecord(data)
						? [
								{
									actorType: data['actorType'],
									reason: data['reason'],
									result: data['result'],
								},
							]
						: [],
				);
				const afterRefusal = await rowCounts(migration, PERSON_TABLES);
				const served = await exchangeAs();

				assert.equal(refused, 503);
				assert.deepEqual(recorded, [
					{
						actorType: 'anonymous',
						reason: 'storeUnavailable',
						result: 'failed',
					},
				]);
				assert.deepEqual(afterRefusal, before);
				assert.equal(served, 200);
				assert.equal(await usersWithSubject(migration, person.subject), 1);
			},
			context,
		);
	});
});
