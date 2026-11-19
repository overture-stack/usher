import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type pg from 'pg';

import { openDatabase } from '../../test-support/fixtures/database.js';
import { ANA_ACTING } from '../../test-support/fixtures/database.js';
import { type Actor, inTransactionAs, SYSTEM_ACTOR } from '../../test-support/policy.js';

const FIXED = ['eventSource', 'firstUser', 'issuer'];

// The settings table and its companions, as the schema names them.
const SETTINGS = 'usher.settings';
const GENERATION = 'usher.settings_generation';
const IDENTIFIERS = 'usher.identity_provider_configuration';
const FLOOR = 'usher.notice_retention';

// Attempts run one after another on the connections they share, each started only when the one before it has settled.
const inOrder = async <Result>(attempts: readonly (() => Promise<Result>)[]): Promise<Result[]> => {
	const results: Result[] = [];
	for (const attempt of attempts) {
		results.push(await attempt());
	}
	return results;
};

// A rejection's constraint or, failing one, its SQLSTATE code: what a refusal of the store names.
const refusalOf = (attempt: () => Promise<unknown>) => (): Promise<string | undefined> =>
	attempt().then(
		() => undefined,
		(error: { code?: string; constraint?: string }) => error.constraint ?? error.code,
	);

const valueOf = async (client: pg.ClientBase, name: string): Promise<unknown> => {
	const { rows } = await client.query<{ value: unknown }>(`SELECT value FROM ${SETTINGS} WHERE name = $1`, [name]);
	return rows[0]?.value;
};

const generationOf = async (client: pg.ClientBase): Promise<number> => {
	const { rows } = await client.query<{ generation: string }>(`SELECT generation FROM ${GENERATION}`);
	return Number(rows[0]?.generation);
};

const floorOf = async (client: pg.ClientBase): Promise<number> => {
	const { rows } = await client.query<{ floor: number }>(`SELECT floor_seconds AS floor FROM ${FLOOR}`);
	return rows[0]?.floor ?? Number.NaN;
};

const baselineNoticesOf = async (client: pg.ClientBase): Promise<number> => {
	const { rows } = await client.query<{ held: number }>(
		"SELECT count(*)::int AS held FROM usher.notices WHERE kind = 'baseline'",
	);
	return rows[0]?.held ?? 0;
};

const changeRecordsOf = async (
	client: pg.ClientBase,
	name: string,
	operation: string,
): Promise<readonly { actorType: string; subject: string | null }[]> => {
	const { rows } = await client.query<{ actorType: string; subject: string | null }>(
		`SELECT actor_type AS "actorType", idp_subject_id AS subject FROM usher.change_records
          WHERE table_name = 'settings' AND operation = $2 AND row_key = jsonb_build_object('name', $1::text)`,
		[name, operation],
	);
	return rows;
};

// Runs statements in one transaction that declares the actor, which the store records each change under.
const as = (client: pg.ClientBase, actor: Actor, statements: readonly string[]): Promise<unknown> =>
	inTransactionAs(client, actor, async () => {
		for (const statement of statements) {
			await client.query(statement);
		}
	});

// The durations a test sets the floor with, as text the settings hold.
const durations = (token: number, grace: number, margin: number): readonly string[] => [
	`UPDATE ${SETTINGS} SET value = '${token}' WHERE name = 'tokenLifetimeSeconds'`,
	`UPDATE ${SETTINGS} SET value = '${grace}' WHERE name = 'retentionGraceSeconds'`,
	`UPDATE ${SETTINGS} SET value = '${margin}' WHERE name = 'retentionMarginSeconds'`,
];

const openSettings = async (context: TestContext) => {
	const database = await openDatabase(context);
	const owner = await database.connect('migration');
	const runtime = await database.connect('runtime');
	return { owner, runtime };
};

suite('the settings table', () => {
	test('refuses UPDATE and DELETE of each fixed setting, for the owner and for the runtime role alike', async (context) => {
		const { owner, runtime } = await openSettings(context);

		const refusals = await inOrder(
			FIXED.flatMap((name) => [
				refusalOf(() =>
					as(owner, SYSTEM_ACTOR, [`UPDATE ${SETTINGS} SET value = value WHERE name = '${name}'`]),
				),
				refusalOf(() => as(owner, SYSTEM_ACTOR, [`DELETE FROM ${SETTINGS} WHERE name = '${name}'`])),
				refusalOf(() =>
					as(runtime, ANA_ACTING, [`UPDATE ${SETTINGS} SET value = value WHERE name = '${name}'`]),
				),
				refusalOf(() => as(runtime, ANA_ACTING, [`DELETE FROM ${SETTINGS} WHERE name = '${name}'`])),
			]),
		);

		assert.deepEqual(
			refusals,
			FIXED.flatMap(() => ['settings_fixed_kept', 'settings_fixed_kept', 'settings_fixed_kept', '42501']),
		);
	});

	test('refuses a TRUNCATE for the schema owner, which the row triggers do not see', async (context) => {
		const { owner } = await openSettings(context);

		assert.equal(await refusalOf(() => owner.query(`TRUNCATE ${SETTINGS}`))(), 'settings_kept');
		assert.equal((await valueOf(owner, 'issuer')) !== undefined, true);
	});

	test('sets the notice retention floor to the sum of the three durations within the change that sets one of them', async (context) => {
		const { owner, runtime } = await openSettings(context);

		await as(runtime, ANA_ACTING, durations(120, 10, 5));
		assert.equal(await floorOf(owner), 135);

		await as(runtime, ANA_ACTING, [`UPDATE ${SETTINGS} SET value = '200' WHERE name = 'tokenLifetimeSeconds'`]);
		assert.equal(await floorOf(owner), 215);
	});

	test('reads the floor as the sum of the rows as they stand at the end of the transaction', async (context) => {
		const { owner, runtime } = await openSettings(context);

		const within = await inTransactionAs(runtime, ANA_ACTING, async () => {
			await runtime.query(`UPDATE ${SETTINGS} SET value = '50' WHERE name = 'tokenLifetimeSeconds'`);
			return floorOf(runtime);
		});

		assert.equal(within, 50 + 60 + 30);
		assert.equal(await floorOf(owner), 140);
	});

	test('writes exactly one baseline notice when the grant rules change, and none when they are written unchanged or seeded', async (context) => {
		const { owner, runtime } = await openSettings(context);
		const seeded = await baselineNoticesOf(owner);
		const rules = JSON.stringify(await valueOf(owner, 'grantRules'));

		await as(runtime, ANA_ACTING, [`UPDATE ${SETTINGS} SET value = '${rules}'::jsonb WHERE name = 'grantRules'`]);
		const unchanged = await baselineNoticesOf(owner);
		await as(runtime, ANA_ACTING, [`UPDATE ${SETTINGS} SET value = '[]'::jsonb WHERE name = 'grantRules'`]);
		const changed = await baselineNoticesOf(owner);

		assert.deepEqual([seeded, unchanged, changed], [0, 0, 1]);
	});

	test('records every change to a setting under the actor declared for it, the seeding as the system', async (context) => {
		const { owner, runtime } = await openSettings(context);

		const seeded = await changeRecordsOf(owner, 'issuer', 'INSERT');
		await as(runtime, ANA_ACTING, [`UPDATE ${SETTINGS} SET value = '300' WHERE name = 'tokenLifetimeSeconds'`]);
		const updated = await changeRecordsOf(owner, 'tokenLifetimeSeconds', 'UPDATE');

		assert.deepEqual(seeded, [{ actorType: 'system', subject: null }]);
		assert.deepEqual(updated, [
			{ actorType: 'human', subject: ANA_ACTING.type === 'human' ? ANA_ACTING.id : null },
		]);
	});

	test('raises the settings generation once for each statement that changes settings, however many rows it changes', async (context) => {
		const { owner, runtime } = await openSettings(context);
		const start = await generationOf(owner);

		await as(runtime, ANA_ACTING, [
			`UPDATE ${SETTINGS} SET value = value WHERE name IN ('noticePageLimit', 'streamQueueLimit')`,
		]);
		const afterOneStatement = await generationOf(owner);
		await as(runtime, ANA_ACTING, [
			`UPDATE ${SETTINGS} SET value = value WHERE name = 'noticePageLimit'`,
			`UPDATE ${SETTINGS} SET value = value WHERE name = 'streamQueueLimit'`,
		]);

		assert.deepEqual([afterOneStatement - start, (await generationOf(owner)) - afterOneStatement], [1, 2]);
	});

	test('lets the runtime role neither insert into nor delete from settings or the identifiers of the identity provider', async (context) => {
		const { runtime } = await openSettings(context);

		const refusals = await inOrder([
			refusalOf(() => as(runtime, ANA_ACTING, [`DELETE FROM ${SETTINGS} WHERE name = 'noticePageLimit'`])),
			refusalOf(() =>
				as(runtime, ANA_ACTING, [
					`INSERT INTO ${SETTINGS} (name, value, changed_at) VALUES ('noticePageLimit', '5', now())`,
				]),
			),
			refusalOf(() => as(runtime, ANA_ACTING, [`DELETE FROM ${IDENTIFIERS} WHERE name = 'managementAudience'`])),
			refusalOf(() =>
				as(runtime, ANA_ACTING, [`INSERT INTO ${IDENTIFIERS} (name) VALUES ('managementAudience')`]),
			),
		]);

		assert.deepEqual(refusals, ['42501', '42501', '42501', '42501']);
	});

	test('lets the runtime role update only the columns granted, and every other column refused', async (context) => {
		const { runtime } = await openSettings(context);

		const refusals = await inOrder([
			refusalOf(() =>
				as(runtime, ANA_ACTING, [
					`UPDATE ${SETTINGS} SET name = 'noticePageLimit' WHERE name = 'streamQueueLimit'`,
				]),
			),
			refusalOf(() =>
				as(runtime, ANA_ACTING, [
					`UPDATE ${IDENTIFIERS} SET name = 'managementAudience' WHERE name = 'managementAudience'`,
				]),
			),
		]);

		assert.deepEqual(refusals, ['42501', '42501']);
		await as(runtime, ANA_ACTING, [
			`UPDATE ${IDENTIFIERS} SET value = '"a"'::jsonb, recorded_at = now() WHERE name = 'managementAudience'`,
		]);
	});

	test('holds six identifiers of the identity provider, each with its value and recording time null, and refuses a value without its time', async (context) => {
		const { owner } = await openSettings(context);

		const { rows } = await owner.query<{ name: string; value: unknown; recorded_at: unknown }>(
			`SELECT name, value, recorded_at FROM ${IDENTIFIERS} ORDER BY name`,
		);

		assert.deepEqual(
			rows.map(({ name }) => name),
			[
				'apiDocsClient',
				'backChannelLogoutAudiences',
				'identityProviderIssuer',
				'managementAudience',
				'managementClients',
				'serviceAccountRole',
			],
		);
		assert.equal(
			rows.every(({ recorded_at, value }) => value === null && recorded_at === null),
			true,
		);
		assert.equal(
			await refusalOf(() =>
				owner.query(`UPDATE ${IDENTIFIERS} SET value = '"a"'::jsonb WHERE name = 'managementAudience'`),
			)(),
			'identity_provider_configuration_recorded_together',
		);
	});
});
