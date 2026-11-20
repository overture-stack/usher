import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { AUDIT_EVENT_TYPES, auditRows, emittedType } from '../../testing/harness/auditEvents.js';
import {
	captureLog,
	type ControllerConfiguration,
	ENVIRONMENT_VARIABLES,
	startController,
	type LogCapture,
} from '../../testing/harness/controller.js';
import { holdTable, untilBlocked } from '../../testing/harness/database.js';
import { committedQuery, readChangeRecords, selectRows } from '../../testing/fixtures/database.js';
import {
	HARNESS_MANAGEMENT_CLIENT,
	type Harness,
	startHarness,
	startInstance,
	startReadOnlyInstance,
	takeSnapshot,
} from '../../testing/harness/harness.js';
import {
	type Actor,
	POLICY_TABLES,
	qualified,
	SEEDED_ROLES,
	STEWARD_SUBJECT,
	storedKeyFingerprints,
} from '../../testing/harness/policy.js';
import { type Cleanup, cleanupFor } from '../../testing/harness/waiting.js';

const { capabilities, identityProviderConfiguration, notices, rolePermissions, roles } = POLICY_TABLES;

// The capability vocabulary of permissions-model.md, each entity in its plane: the data plane's four
// entities a token's category entry may carry, and the control plane's rows of Usher's own store.
const VOCABULARY: Readonly<Record<string, { actions: readonly string[]; plane: string }>> = Object.freeze({
	artifact: {
		actions: ['count', 'create', 'delete', 'export', 'update', 'view'],
		plane: 'data',
	},
	category: { actions: ['create'], plane: 'control' },
	custodianship: { actions: ['assign', 'remove'], plane: 'control' },
	field: { actions: ['count', 'export', 'update', 'view'], plane: 'data' },
	grant: {
		actions: ['create', 'extend', 'reduce', 'revoke', 'view'],
		plane: 'control',
	},
	group: {
		actions: ['addMember', 'create', 'removeMember', 'update', 'view'],
		plane: 'control',
	},
	invitation: { actions: ['create'], plane: 'control' },
	ownership: { actions: ['transfer'], plane: 'control' },
	record: {
		actions: ['count', 'create', 'delete', 'export', 'update', 'view'],
		plane: 'data',
	},
	resource: {
		actions: ['register', 'restore', 'suppress', 'update', 'view'],
		plane: 'control',
	},
	revision: { actions: ['export', 'view'], plane: 'data' },
	role: { actions: ['define'], plane: 'control' },
});

const ADMINISTRATOR: Actor = Object.freeze({
	id: STEWARD_SUBJECT,
	type: 'human',
});

const REFUSED_ON_ITS_ROLE = Object.freeze({
	message: new RegExp(`\\b${ENVIRONMENT_VARIABLES.databaseUrl}\\b`, 'u'),
});

/** A store a Controller has started on once, and the log stream that Controller writes to. */
interface StartedStore {
	harness: Harness;
	log: LogCapture;
}

// A store a Controller started on once under the runtime role, with no application registered, so
// nothing but what a start writes is in it beyond what the migrations write.
const startedStore = async (scope: Cleanup): Promise<StartedStore> => {
	const log = captureLog();
	const harness = await startHarness({
		applications: [],
		configuration: { logStream: log.stream },
	});
	scope.defer(() => harness.stop());
	return { harness, log };
};

const storedVocabulary = (client: pg.ClientBase): Promise<readonly { name: string; plane: string }[]> =>
	selectRows<{ name: string; plane: string }>(
		client,
		`SELECT ${capabilities.columns.entity} || '.' || ${capabilities.columns.action} AS name, ${capabilities.columns.plane} AS plane FROM ${qualified(capabilities)} ORDER BY name`,
	);

const storedRoles = async (
	client: pg.ClientBase,
): Promise<Readonly<Record<string, { capabilities: readonly string[]; plane: string }>>> => {
	const rows = await selectRows<{
		capabilities: string[];
		name: string;
		plane: string;
	}>(
		client,
		`SELECT role.${roles.columns.name} AS name, role.${roles.columns.plane} AS plane,
            coalesce(array_agg(capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action} ORDER BY capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action}) FILTER (WHERE capability.${capabilities.columns.id} IS NOT NULL), '{}') AS capabilities
       FROM ${qualified(roles)} role
       LEFT JOIN ${qualified(rolePermissions)} permission ON permission.${rolePermissions.columns.roleId} = role.${roles.columns.id}
       LEFT JOIN ${qualified(capabilities)} capability ON capability.${capabilities.columns.id} = permission.${rolePermissions.columns.capabilityId}
      GROUP BY role.${roles.columns.name}, role.${roles.columns.plane}`,
	);
	return Object.fromEntries(rows.map(({ capabilities: held, name, plane }) => [name, { capabilities: held, plane }]));
};

const noticeCount = async (client: pg.ClientBase, kind?: string): Promise<number> => {
	const [row] = await selectRows<{ count: number }>(
		client,
		`SELECT count(*)::int AS count FROM ${qualified(notices)} WHERE $1::text IS NULL OR ${notices.columns.kind} = $1`,
		[kind ?? null],
	);
	return row?.count ?? 0;
};

const withoutPermission = (client: pg.ClientBase, role: string, capability: string): Promise<unknown> =>
	committedQuery(
		client,
		`DELETE FROM ${qualified(rolePermissions)}
      WHERE ${rolePermissions.columns.roleId} = (SELECT ${roles.columns.id} FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1)
        AND ${rolePermissions.columns.capabilityId} = (SELECT ${capabilities.columns.id} FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} || '.' || ${capabilities.columns.action} = $2)`,
		[role, capability],
		ADMINISTRATOR,
	);

// Removes a seeded role and what it carries, as the migration role, so the store lacks it.
const withoutRole = async (client: pg.ClientBase, role: string): Promise<void> => {
	await committedQuery(
		client,
		`DELETE FROM ${qualified(rolePermissions)} WHERE ${rolePermissions.columns.roleId} = (SELECT ${roles.columns.id} FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1)`,
		[role],
	);
	await committedQuery(client, `DELETE FROM ${qualified(roles)} WHERE ${roles.columns.name} = $1`, [role]);
};

suite('what the controller writes at its start', () => {
	test('writes the capability vocabulary, each capability in the plane of its entity, at its first start', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));

		const stored = await storedVocabulary(harness.clients.migration);

		assert.deepEqual(
			stored,
			Object.entries(VOCABULARY)
				.flatMap(([entity, { actions, plane }]) =>
					actions.map((action) => ({ name: `${entity}.${action}`, plane })),
				)
				.toSorted((first, second) => first.name.localeCompare(second.name)),
		);
	});

	test('writes each seeded role with the capabilities the seeded matrix gives it at its first start', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));

		const stored = await storedRoles(harness.clients.migration);

		assert.deepEqual(
			stored,
			Object.fromEntries(
				Object.entries(SEEDED_ROLES).map(([name, { capabilities: held, plane }]) => [
					name,
					{ capabilities: [...held], plane },
				]),
			),
		);
	});

	test('records one fingerprint at its first start, of 32 bytes, under the name keyEncryptionKey', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));

		const stored = await storedKeyFingerprints(harness.clients.migration);

		assert.deepEqual(
			stored.map(({ fingerprint, keyName }) => ({
				keyName,
				thirtyTwoBytes: /^[\da-f]{64}$/u.test(fingerprint),
			})),
			[{ keyName: 'keyEncryptionKey', thirtyTwoBytes: true }],
		);
	});

	test('writes its capabilities, roles and their permissions as the system, which names nobody', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const written = new Set<string>([capabilities.name, rolePermissions.name, roles.name]);

		const records = (await readChangeRecords(harness.clients.migration)).filter(({ tableName }) =>
			written.has(tableName),
		);

		assert.deepEqual([...new Set(records.map(({ tableName }) => tableName))].toSorted(), [...written].toSorted());
		assert.deepEqual(
			[...new Set(records.map(({ actorId, actorType }) => `${actorType} ${String(actorId)}`))],
			['system null'],
		);
	});

	test('writes nothing when it restarts on a store it has already started', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const before = await takeSnapshot(harness);

		await harness.restart();

		assert.deepEqual(await takeSnapshot(harness), before);
	});

	test('starts on a role that may only read on a store it has already started, writing nothing', async (context) => {
		const scope = cleanupFor(context);
		const { harness } = await startedStore(scope);
		const before = await takeSnapshot(harness);

		const reading = await startReadOnlyInstance(scope, harness);
		await reading.stop();

		assert.deepEqual(await takeSnapshot(harness), before);
	});

	test('refuses a start on a role that may only read while the store lacks a seeded role, naming the database URL and writing nothing', async (context) => {
		const scope = cleanupFor(context);
		const { harness } = await startedStore(scope);
		await withoutRole(harness.clients.migration, 'curator');
		const before = await takeSnapshot(harness);

		await assert.rejects(startReadOnlyInstance(scope, harness), REFUSED_ON_ITS_ROLE);

		assert.deepEqual(await takeSnapshot(harness), before);
	});

	test('writes a seeded role the store lacks, with every capability the seeded matrix gives it', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		await withoutRole(harness.clients.migration, 'curator');

		await harness.restart();

		assert.deepEqual((await storedRoles(harness.clients.migration))['curator'], {
			capabilities: [...SEEDED_ROLES.curator.capabilities],
			plane: SEEDED_ROLES.curator.plane,
		});
	});

	test("keeps an administrator's change to a seeded role at a later start", async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		await withoutPermission(harness.clients.migration, 'viewer', 'record.export');
		const before = await takeSnapshot(harness);

		await harness.restart();

		assert.deepEqual(
			(await storedRoles(harness.clients.migration))['viewer']?.capabilities,
			SEEDED_ROLES.viewer.capabilities.filter((capability) => capability !== 'record.export'),
		);
		assert.deepEqual(await takeSnapshot(harness), before);
	});
});

// The identity provider's six identifiers, in the order the store lists them.
const IDENTIFIER_NAMES = [
	'apiDocsClient',
	'backChannelLogoutAudiences',
	'identityProviderIssuer',
	'managementAudience',
	'managementClients',
	'serviceAccountRole',
] as const;

const sortedOf = (values: readonly string[]): string[] => [...values].toSorted();

// The six identifiers as a store holding the configuration records them: the lists sorted.
const recordOf = (configuration: ControllerConfiguration): Readonly<Record<string, unknown>> => ({
	apiDocsClient: configuration.apiDocsClient,
	backChannelLogoutAudiences: sortedOf(configuration.backChannelLogoutAudiences),
	identityProviderIssuer: configuration.identityProviderIssuer,
	managementAudience: configuration.managementAudience,
	managementClients: sortedOf(configuration.managementClients),
	serviceAccountRole: configuration.serviceAccountRole,
});

const UNRECORDED: Readonly<Record<string, null>> = Object.freeze(
	Object.fromEntries(IDENTIFIER_NAMES.map((name) => [name, null])),
);

const EXTRA_CLIENT = 'zz-added-client';

// The six identifiers the store holds, each by name.
const identityRecord = async (client: pg.ClientBase): Promise<Readonly<Record<string, unknown>>> => {
	const { columns, name } = identityProviderConfiguration;
	const rows = await selectRows<{ name: string; value: unknown }>(
		client,
		`SELECT ${columns.name} AS name, ${columns.value} AS value FROM ${qualified({ name })} ORDER BY ${columns.name}`,
	);
	return Object.fromEntries(rows.map((row) => [row.name, row.value]));
};

// The audit rows of a configuration change, the system's, in order.
const configurationChanges = async (client: pg.ClientBase): Promise<readonly { data: unknown; severity: string }[]> =>
	(await auditRows(client))
		.filter(({ type }) => type === emittedType(AUDIT_EVENT_TYPES.identityProviderConfigurationChange))
		.map(({ data, severity }) => ({ data, severity: String(severity) }));

// The `changes` member of a configuration change's data.
const changesOf = (data: unknown): unknown => (data as Record<string, unknown>)['changes'];

// A Controller started and stopped at once on the configuration given, which records what its start records.
const startAndStop = async (configuration: ControllerConfiguration): Promise<void> => {
	const running = await startController(configuration);
	await running.stop();
};

suite('what the controller records of the identity provider at its start', () => {
	test('fills all six identifiers at a first start, recording no change', async (context) => {
		const log = captureLog();
		const harness = await startHarness({
			applications: [],
			configuration: { logStream: log.stream },
			startsController: false,
		});
		const scope = cleanupFor(context);
		scope.defer(() => harness.stop());
		const unrecorded = await identityRecord(harness.clients.migration);

		await harness.startController();

		assert.deepEqual(unrecorded, UNRECORDED);
		assert.deepEqual(await identityRecord(harness.clients.migration), recordOf(harness.configuration));
		assert.deepEqual(await configurationChanges(harness.clients.migration), []);
	});

	test('records nothing and writes nothing at a start under the identifiers the store holds', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const before = await takeSnapshot(harness);

		await harness.restart();

		assert.deepEqual(await takeSnapshot(harness), before);
		assert.deepEqual(await configurationChanges(harness.clients.migration), []);
	});

	test('records one critical change naming the management clients with their previous list, and stores the new list sorted', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const { configuration } = harness;
		const changed = {
			...configuration,
			managementClients: [...configuration.managementClients, EXTRA_CLIENT].toReversed(),
		};
		await harness.stopController();

		await startAndStop(changed);

		assert.deepEqual(
			(await configurationChanges(harness.clients.migration)).map(({ data, severity }) => ({
				changes: changesOf(data),
				severity,
			})),
			[
				{
					changes: [
						{
							name: 'managementClients',
							previousValue: sortedOf(configuration.managementClients),
							value: sortedOf(changed.managementClients),
						},
					],
					severity: 'critical',
				},
			],
		);
		assert.deepEqual(await identityRecord(harness.clients.migration), recordOf(changed));
	});

	test('records nothing when a changed list holds the same clients in another order', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const { configuration } = harness;
		const clients = [...configuration.managementClients, EXTRA_CLIENT];
		await harness.stopController();
		await startAndStop({ ...configuration, managementClients: clients });
		const before = await takeSnapshot(harness);

		await startAndStop({
			...configuration,
			managementClients: clients.toReversed(),
		});

		assert.deepEqual(await takeSnapshot(harness), before);
		assert.equal((await configurationChanges(harness.clients.migration)).length, 1);
	});

	test('records one warning change when apiDocsClient alone changes', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const { configuration } = harness;
		await harness.stopController();

		await startAndStop({
			...configuration,
			apiDocsClient: HARNESS_MANAGEMENT_CLIENT,
		});

		assert.deepEqual(
			(await configurationChanges(harness.clients.migration)).map(({ data, severity }) => ({
				changes: changesOf(data),
				severity,
			})),
			[
				{
					changes: [
						{
							name: 'apiDocsClient',
							previousValue: '',
							value: HARNESS_MANAGEMENT_CLIENT,
						},
					],
					severity: 'warning',
				},
			],
		);
	});

	test('records exactly one change when two Controllers start together under new identifiers', async (context) => {
		const { harness } = await startedStore(cleanupFor(context));
		const { configuration } = harness;
		const changed = {
			...configuration,
			managementClients: [...configuration.managementClients, EXTRA_CLIENT],
		};
		await harness.stopController();

		const running = await Promise.all([startController(changed), startController(changed)]);
		await Promise.all(running.map((instance) => instance.stop()));

		assert.equal((await configurationChanges(harness.clients.migration)).length, 1);
		assert.deepEqual(await identityRecord(harness.clients.migration), recordOf(changed));
	});

	test('starts on a role that may only read against a record that matches, recording nothing and writing nothing', async (context) => {
		const scope = cleanupFor(context);
		const { harness } = await startedStore(scope);
		const before = await takeSnapshot(harness);

		const reading = await startReadOnlyInstance(scope, harness);
		await reading.stop();

		assert.deepEqual(await identityRecord(harness.clients.migration), recordOf(harness.configuration));
		assert.deepEqual(await takeSnapshot(harness), before);
	});

	test('refuses a start on a role that may only read when an identifier changed, naming the database URL and writing nothing', async (context) => {
		const scope = cleanupFor(context);
		const { harness } = await startedStore(scope);
		const { configuration } = harness;
		const before = await takeSnapshot(harness);

		await assert.rejects(
			startReadOnlyInstance(scope, harness, {
				managementClients: [...configuration.managementClients, EXTRA_CLIENT],
			}),
			REFUSED_ON_ITS_ROLE,
		);

		assert.deepEqual(await takeSnapshot(harness), before);
	});
});
