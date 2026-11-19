import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { suite, test, type TestContext } from 'node:test';

import type pg from 'pg';

import {
	type AdminCaller,
	assertSucceeded,
	changeGrantRules,
	readGrantRules,
	updateSettings,
} from '../../test-support/admin.js';
import { auditRows, dataOf, emittedType } from '../../test-support/auditEvents.js';
import { exchange, PEOPLE, type Person } from '../../test-support/exchange.js';
import { type Harness, startInstance, withHarness } from '../../test-support/harness.js';
import { cleanupFor } from '../../test-support/waiting.js';

// A list of grant rules other than the defaults: the signed-in recipient reads open resources' counts alone.
const CHANGED_RULES = [
	{
		resources: [
			{
				accessLevel: 'open',
				categories: [{ actions: ['count'], name: 'global.unmarked' }],
			},
		],
		to: 'signedIn',
	},
];

// The stored list, and the generation and baseline notices the settings hold, as the store reads them.
const storedRulesOf = async (client: pg.ClientBase, schema: string): Promise<unknown> => {
	const { rows } = await client.query<{ value: unknown }>(
		`SELECT value FROM ${schema}.settings WHERE name = 'grantRules'`,
	);
	return rows[0]?.value;
};

const generationOf = async (client: pg.ClientBase, schema: string): Promise<number> => {
	const { rows } = await client.query<{ generation: string }>(`SELECT generation FROM ${schema}.settings_generation`);
	return Number(rows[0]?.generation);
};

const baselineNoticesOf = async (client: pg.ClientBase, schema: string): Promise<number> => {
	const { rows } = await client.query<{ held: number }>(
		`SELECT count(*)::int AS held FROM ${schema}.notices WHERE kind = 'baseline'`,
	);
	return rows[0]?.held ?? 0;
};

const eventsOf = async (harness: Harness, type: string) =>
	(await auditRows(harness.clients.migration))
		.filter((row) => row.type === emittedType(type))
		.map((row) => ({ data: dataOf(row), severity: row.severity }));

const eventCountOf = async (harness: Harness, type: string): Promise<number> => (await eventsOf(harness, type)).length;

const administratorOf = async (harness: Harness) =>
	harness.caller(await harness.tokens.administrator(PEOPLE.administrator));

suite('the grant rules, read and replaced through the Management API', () => {
	test('replaces the whole list, recording grantRules.change at critical with the previous list and one baseline notice, the administrator changing it', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;
				const previous = await readGrantRules(caller);
				assertSucceeded(previous, 'reading the grant rules');
				const baselinesBefore = await baselineNoticesOf(harness.clients.migration, schema);

				const answer = await changeGrantRules(caller, CHANGED_RULES);

				assertSucceeded(answer, 'changing the grant rules');
				assert.deepEqual(answer.body, { grantRules: CHANGED_RULES });
				assert.deepEqual(await storedRulesOf(harness.clients.migration, schema), CHANGED_RULES);
				const [recorded] = await eventsOf(harness, 'grantRules.change');
				assert.equal(await eventCountOf(harness, 'grantRules.change'), 1);
				assert.equal(recorded?.severity, 'critical');
				assert.deepEqual(recorded?.data, {
					actorId: PEOPLE.administrator.subject,
					actorType: 'human',
					grantRules: CHANGED_RULES,
					instance: recorded?.data.instance,
					previousGrantRules: (previous.body as { grantRules: unknown }).grantRules,
					result: 'succeeded',
					sourceIp: '127.0.0.1',
				});
				assert.equal(await baselineNoticesOf(harness.clients.migration, schema), baselinesBefore + 1);
			},
			context,
		);
	});

	test('writes nothing and records nothing for a list identical to the stored one, answering the current rules', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;
				assertSucceeded(await changeGrantRules(caller, CHANGED_RULES), 'changing the grant rules');
				const generation = await generationOf(harness.clients.migration, schema);
				const baselines = await baselineNoticesOf(harness.clients.migration, schema);
				const events = await eventsOf(harness, 'grantRules.change');

				const answer = await changeGrantRules(caller, CHANGED_RULES);

				assertSucceeded(answer, 'changing the grant rules to the same list');
				assert.deepEqual(answer.body, { grantRules: CHANGED_RULES });
				assert.equal(await generationOf(harness.clients.migration, schema), generation);
				assert.equal(await baselineNoticesOf(harness.clients.migration, schema), baselines);
				assert.deepEqual(await eventsOf(harness, 'grantRules.change'), events);
			},
			context,
		);
	});

	test('answers 503 storedSettingsInvalid, issuing nothing, when a hand-edited grant rules row breaks its rule', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;
				await harness.clients.migration.query('BEGIN');
				await harness.clients.migration.query("SELECT set_config('usher.actor_type', 'system', true)");
				await harness.clients.migration.query(
					`UPDATE ${schema}.settings SET value = '"not a list"'::jsonb WHERE name = 'grantRules'`,
				);
				await harness.clients.migration.query('COMMIT');

				const answer = await readGrantRules(caller);

				assert.equal(answer.status, 503);
				assert.equal(answer.problem?.code, 'storedSettingsInvalid');
				assert.doesNotMatch(answer.text, /not a list/u);
			},
			context,
		);
	});
});

const APPLICATION = 'Settings operations';

// The store's setting rows, read as the migration role reads them.
const storedValueOf = async (client: pg.ClientBase, schema: string, name: string): Promise<unknown> => {
	const { rows } = await client.query<{ value: unknown }>(`SELECT value FROM ${schema}.settings WHERE name = $1`, [
		name,
	]);
	return rows[0]?.value;
};

// A change of settings, sent as the merge patch the operation takes.
const patchOf = (_harness: Harness, caller: AdminCaller, update: Readonly<Record<string, unknown>>) =>
	updateSettings(caller, update);

// Issued instants are whole seconds: a token minted in the second a change was made in would count the change as after
// its issue, so the test waits a second first.
const WHOLE_SECOND_MILLISECONDS = 1100;

// The longest a change takes to reach another instance: the harness's notice reread interval, plus slack.
const REREAD_WAIT_MILLISECONDS = 4000;
const POLL_MILLISECONDS = 100;

suite('the settings, changed through the Management API', () => {
	test('applies a valid change of settings all at once, recording one settings.change with each change and its previous value, at critical when a critical setting changed', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;
				const generation = await generationOf(harness.clients.migration, schema);

				const answer = await patchOf(harness, caller, { grantAutoAccept: true, noticePageLimit: 250 });

				assertSucceeded(answer, 'changing two settings');
				assert.equal(await storedValueOf(harness.clients.migration, schema, 'grantAutoAccept'), true);
				assert.equal(await storedValueOf(harness.clients.migration, schema, 'noticePageLimit'), 250);
				assert.ok((await generationOf(harness.clients.migration, schema)) > generation);
				assert.equal(await eventCountOf(harness, 'settings.change'), 1);
				const [recorded] = await eventsOf(harness, 'settings.change');
				assert.equal(recorded?.severity, 'critical');
				assert.deepEqual((recorded?.data as { changes: unknown }).changes, [
					{ name: 'grantAutoAccept', previousValue: false, value: true },
					{ name: 'noticePageLimit', previousValue: 500, value: 250 },
				]);
				assert.equal((recorded?.data as { actorId: unknown }).actorId, PEOPLE.administrator.subject);
			},
			context,
		);
	});

	test('records a change of warning settings alone at warning, and writes nothing and records nothing for values equal to the stored ones', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;

				assertSucceeded(await patchOf(harness, caller, { noticePageLimit: 250 }), 'changing a warning setting');
				const [recorded] = await eventsOf(harness, 'settings.change');
				assert.equal(recorded?.severity, 'warning');

				const generation = await generationOf(harness.clients.migration, schema);
				const answer = await patchOf(harness, caller, { noticePageLimit: 250 });

				assertSucceeded(answer, 'changing a setting to its stored value');
				assert.equal((answer.body as { noticePageLimit: unknown }).noticePageLimit, 250);
				assert.equal(await generationOf(harness.clients.migration, schema), generation);
				assert.equal(await eventCountOf(harness, 'settings.change'), 1);
			},
			context,
		);
	});

	test('refuses a change whose values break a rule laid across settings, changing none of them and recording the refusal denied', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;

				const answer = await patchOf(harness, caller, {
					noticePageLimit: 250,
					retentionGraceSeconds: 2147483647,
				});

				assert.equal(answer.status, 400);
				assert.equal(answer.problem?.code, 'unreadableBody');
				assert.equal(await storedValueOf(harness.clients.migration, schema, 'noticePageLimit'), 500);
				assert.equal(await eventCountOf(harness, 'settings.change'), 1);
				const [recorded] = await eventsOf(harness, 'settings.change');
				assert.equal((recorded?.data as { result: unknown }).result, 'denied');
			},
			context,
		);
	});

	test('refuses a change that would lock out the caller 409 changeLocksOutCaller, changing nothing, while a maximum the caller can meet is applied', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = harness.caller(
					await harness.tokens.administrator(PEOPLE.administrator, { lifetimeSeconds: 900 }),
				);
				const { schema } = harness.database;

				const refused = await patchOf(harness, caller, { signInTokenMaximumLifetimeSeconds: 600 });

				assert.equal(refused.status, 409);
				assert.equal(refused.problem?.code, 'changeLocksOutCaller');
				assert.equal(
					await storedValueOf(harness.clients.migration, schema, 'signInTokenMaximumLifetimeSeconds'),
					3600,
				);

				assertSucceeded(
					await patchOf(harness, caller, { signInTokenMaximumLifetimeSeconds: 1200 }),
					'raising the maximum',
				);
			},
			context,
		);
	});

	test('refuses backChannelLogout on while the audiences are empty 409 backChannelLogoutNeedsAudiences, and allows it off', async (context: TestContext) => {
		await withHarness(
			{ applications: [] },
			async (harness) => {
				const caller = await administratorOf(harness);
				const { schema } = harness.database;
				assertSucceeded(await patchOf(harness, caller, { backChannelLogout: false }), 'switching relaying off');
				await harness.restart({ backChannelLogoutAudiences: [] });
				const freshCaller = await administratorOf(harness);

				const refused = await patchOf(harness, freshCaller, { backChannelLogout: true });

				assert.equal(refused.status, 409);
				assert.equal(refused.problem?.code, 'backChannelLogoutNeedsAudiences');
				assert.equal(await storedValueOf(harness.clients.migration, schema, 'backChannelLogout'), false);
			},
			context,
		);
	});

	test('applies a change to the signed-in token maximum at once on the instance making it, and reaches another instance within one notice reread interval', async (context: TestContext) => {
		await withHarness(
			{ applications: [APPLICATION] },
			async (harness) => {
				const other = await startInstance(cleanupFor(context), harness);
				const application = harness.application(APPLICATION);
				const caller = harness.caller(
					await harness.tokens.administrator(PEOPLE.administrator, { lifetimeSeconds: 300 }),
				);
				await delay(WHOLE_SECOND_MILLISECONDS);
				const person: Person = { email: 'reread@example.org', subject: randomUUID() };
				const token = await harness.tokens.signIn(person, {
					application: APPLICATION,
					mint: { lifetimeSeconds: 900 },
				});
				assert.equal((await exchange(other.url, { application, credential: token })).status, 200);

				assertSucceeded(
					await patchOf(harness, caller, { signInTokenMaximumLifetimeSeconds: 600 }),
					'lowering the maximum',
				);
				const atOnce = await exchange(harness.url, { application, credential: token });
				assert.equal(atOnce.status, 403, 'the instance making the change answered before its reread');

				const deadline = Date.now() + REREAD_WAIT_MILLISECONDS;
				let status = 0;
				while (Date.now() < deadline && status !== 403) {
					await delay(POLL_MILLISECONDS);
					status = (await exchange(other.url, { application, credential: token })).status;
				}
				assert.equal(status, 403, 'the other instance did not take the change within one reread interval');
			},
			context,
		);
	});
});
