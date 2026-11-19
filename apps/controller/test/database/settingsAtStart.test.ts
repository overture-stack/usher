import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { postBackChannelLogout, readReadiness } from '../../test-support/admin.js';
import { AUDIT_EVENT_TYPES, auditRows, emittedType } from '../../test-support/auditEvents.js';
import {
	captureLog,
	ENVIRONMENT_VARIABLES,
	refusalText,
	startController,
	startOutcome,
} from '../../test-support/controller.js';
import { writeStoredSettings } from '../../test-support/database.js';
import { exchange, type Person } from '../../test-support/exchange.js';
import { logoutTokenFor } from '../../test-support/fixtures/channel.js';
import { type Harness, startInstance, withHarness } from '../../test-support/harness.js';
import { cleanupFor } from '../../test-support/waiting.js';

const APPLICATION = 'Settings at start';

// Past the harness's own maximum of 3600 seconds and the maximum the store is set to below, so a token of
// this lifetime is issued by a Controller reading the configuration's maximum and refused by one reading
// the store's.
const LIFETIME_SECONDS = 900;

const STORED_MAXIMUM_SECONDS = 600;

// Longer than a whole second, so a token minted after it is issued in a later second than a change before it.
const WHOLE_SECOND_MILLISECONDS = 1100;

// The harness's notice reread interval, which a change committed on one instance must reach another within,
// plus the time a read of the store takes.
const REREAD_MILLISECONDS = 2000;
const REREAD_SLACK_MILLISECONDS = 1000;
const POLL_MILLISECONDS = 100;

const freshPerson = (): Person => ({
	email: 'settings@example.org',
	subject: randomUUID(),
});

// Deletes one stored setting's row as the schema's owner, declaring the system as the actor, so a start finds
// no value for it.
const deleteStoredSetting = async (client: pg.ClientBase, schema: string, name: string): Promise<void> => {
	await client.query('BEGIN');
	await client.query("SELECT set_config('usher.actor_type', 'system', true)");
	await client.query(`DELETE FROM ${pg.escapeIdentifier(schema)}.settings WHERE name = $1`, [name]);
	await client.query('COMMIT');
};

// The token the Controller issues the signed-in principal, asked for by an exchange under a sign-in token of the
// lifetime given.
const signInFor = (harness: Harness, lifetimeSeconds: number): Promise<string> =>
	harness.tokens.signIn(freshPerson(), {
		application: APPLICATION,
		mint: { lifetimeSeconds },
	});

const problemCodeOf = (body: string): unknown => (JSON.parse(body) as { code?: unknown }).code;

// The level a warning is written at, as the structured log writes it.
const WARNING_LEVEL = 40;

// The structured log's lines a capture holds, each parsed, so a test reads its level, message and fields.
const parsedLinesOf = (text: readonly string[]): readonly unknown[] => text.map((line): unknown => JSON.parse(line));

suite('the settings a start reads from the store', () => {
	test('reads each setting from the store, not from the configuration it is given: a sign-in token past the maximum the store holds is refused', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			await harness.stopController();
			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				signInTokenMaximumLifetimeSeconds: STORED_MAXIMUM_SECONDS,
			});
			const started = await startController(harness.configuration);
			try {
				const token = await signInFor(harness, LIFETIME_SECONDS);

				const answer = await exchange(started.url, {
					application: harness.application(APPLICATION),
					credential: token,
				});

				assert.equal(answer.status, 403);
			} finally {
				await started.stop();
			}
		});
	});

	test('refuses a start whose stored row it cannot read, naming the setting and never its value', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			await harness.stopController();
			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				noticePageLimit: 'SECRET-VALUE-NOT-A-NUMBER',
			});

			const outcome = await startOutcome(harness.configuration);

			assert.equal(outcome.kind, 'refused');
			const text = refusalText(outcome.kind === 'refused' ? outcome.refusal : undefined);
			assert.ok(text.includes('noticePageLimit'), 'the refusal names the setting');
			assert.equal(text.includes('SECRET-VALUE-NOT-A-NUMBER'), false);
		});
	});

	test('refuses a start whose store holds no row for a setting, naming the setting', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			await harness.stopController();
			await deleteStoredSetting(harness.clients.migration, harness.database.schema, 'noticePageLimit');

			const outcome = await startOutcome(harness.configuration);

			assert.equal(outcome.kind, 'refused');
			assert.ok(
				refusalText(outcome.kind === 'refused' ? outcome.refusal : undefined).includes('noticePageLimit'),
				'the refusal names the setting',
			);
		});
	});

	test("refuses a start whose service account role is the first user's realm role, naming the variable", async () => {
		await withHarness({ startsController: false }, async (harness) => {
			const firstUserRole = await harness.clients.migration
				.query<{ value: { realmRole: string } }>(
					`SELECT value FROM ${pg.escapeIdentifier(harness.database.schema)}.settings WHERE name = 'firstUser'`,
				)
				.then(({ rows }) => rows[0]?.value.realmRole);
			const outcome = await startOutcome({
				...harness.configuration,
				serviceAccountRole: String(firstUserRole),
			});

			assert.equal(outcome.kind, 'refused');
			assert.ok(
				refusalText(outcome.kind === 'refused' ? outcome.refusal : undefined).includes(
					ENVIRONMENT_VARIABLES.serviceAccountRole,
				),
				'the refusal names the variable',
			);
		});
	});

	test('makes readiness unready, and answers an exchange 503 storedSettingsInvalid issuing nothing, when a hand-edited grant rules row breaks its rule on a running Controller, recording the exchange failed', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			const application = harness.application(APPLICATION);
			const before = await exchange(harness.url, { application });
			assert.equal(before.status, 200);

			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				grantRules: [{ resources: [], to: 'anyone' }],
			});

			const readiness = await readReadiness(harness.url);
			const answer = await exchange(harness.url, { application });
			const failures = (await auditRows(harness.clients.migration)).filter(
				({ data, type }) =>
					type === emittedType(AUDIT_EVENT_TYPES.tokenExchange) &&
					(data as Record<string, unknown>)['reason'] === 'storedSettingsInvalid',
			);

			assert.equal(readiness.status, 503);
			assert.equal(answer.status, 503);
			assert.equal(answer.headers.get('content-type')?.includes('application/jwt'), false);
			assert.equal(problemCodeOf(answer.body), 'storedSettingsInvalid');
			assert.deepEqual(
				failures.map(({ data }) => (data as Record<string, unknown>)['result']),
				['failed'],
			);
		});
	});

	test('reaches a change committed while one instance runs at another instance within one notice reread interval, with no notice stream open', async (context: TestContext) => {
		await withHarness(
			{ applications: [APPLICATION] },
			async (harness) => {
				const other = await startInstance(cleanupFor(context), harness);
				const application = harness.application(APPLICATION);
				// Issued instants are whole seconds: a token minted in the second the store's own writes landed
				// in would count them as after its issue, so it waits for the next second.
				await delay(WHOLE_SECOND_MILLISECONDS);
				const token = await signInFor(harness, LIFETIME_SECONDS);
				const issuedBefore = await exchange(other.url, { application, credential: token });
				assert.equal(issuedBefore.status, 200);

				await writeStoredSettings(harness.clients.migration, harness.database.schema, {
					signInTokenMaximumLifetimeSeconds: STORED_MAXIMUM_SECONDS,
				});
				const deadline = Date.now() + REREAD_MILLISECONDS + REREAD_SLACK_MILLISECONDS;
				const statuses: number[] = [];
				while (Date.now() < deadline) {
					await delay(POLL_MILLISECONDS);
					const answer = await exchange(other.url, { application, credential: token });
					statuses.push(answer.status);
					if (answer.status === 403) {
						break;
					}
				}

				assert.equal(statuses.at(-1), 403, `the other instance still answered ${statuses.join(', ')}`);
			},
			context,
		);
	});

	test('refuses a start with backChannelLogout on and no back-channel logout audience, naming the variable and the setting', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			await harness.stopController();

			const outcome = await startOutcome({ ...harness.configuration, backChannelLogoutAudiences: [] });

			assert.equal(outcome.kind, 'refused');
			const text = refusalText(outcome.kind === 'refused' ? outcome.refusal : undefined);
			assert.ok(
				text.includes(ENVIRONMENT_VARIABLES.backChannelLogoutAudiences),
				'the refusal names the variable',
			);
			assert.ok(text.includes('backChannelLogout'), 'the refusal names the setting');
			assert.ok(text.includes('set backChannelLogout to false'), 'the refusal says how to relay nothing');
		});
	});

	test('writes one line at warning, signOuts.relayingOff, naming the setting, on every start with backChannelLogout off', async () => {
		await withHarness({ applications: [APPLICATION] }, async (harness) => {
			await harness.stopController();
			await writeStoredSettings(harness.clients.migration, harness.database.schema, {
				backChannelLogout: false,
			});
			const log = captureLog();
			const configuration = { ...harness.configuration, backChannelLogoutAudiences: [], logStream: log.stream };

			for (const _start of [1, 2]) {
				const started = await startController(configuration);
				await started.stop();
			}

			const relayingOff = parsedLinesOf(log.lines()).filter(
				(line) =>
					typeof line === 'object' &&
					line !== null &&
					Reflect.get(line, 'message') === 'signOuts.relayingOff',
			);
			assert.deepEqual(
				relayingOff.map((line) => ({
					level: Reflect.get(line as object, 'level'),
					setting: Reflect.get(line as object, 'setting'),
				})),
				[
					{ level: WARNING_LEVEL, setting: 'backChannelLogout' },
					{ level: WARNING_LEVEL, setting: 'backChannelLogout' },
				],
			);
		});
	});

	test('refuses a logout token at the next request once a re-read finds backChannelLogout off, answering it before any verification', async (context: TestContext) => {
		await withHarness(
			{ applications: [APPLICATION] },
			async (harness) => {
				const other = await startInstance(cleanupFor(context), harness);
				const logoutToken = await logoutTokenFor(harness, freshPerson());
				const relayed = await postBackChannelLogout(other.url, logoutToken);
				assert.equal(relayed.status, 200);

				await writeStoredSettings(harness.clients.migration, harness.database.schema, {
					backChannelLogout: false,
				});
				const deadline = Date.now() + REREAD_MILLISECONDS + REREAD_SLACK_MILLISECONDS;
				let answer = relayed;
				while (answer.status !== 400 && Date.now() < deadline) {
					await delay(POLL_MILLISECONDS);
					answer = await postBackChannelLogout(other.url, logoutToken);
				}

				assert.equal(answer.status, 400, 'the other instance refused the logout token once turned off');
				assert.equal(answer.problem?.code, 'logoutTokenRefused');
			},
			context,
		);
	});
});
