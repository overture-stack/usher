import type { RouteOptions } from 'fastify';
import pg from 'pg';

import type { AdministratorStore } from '../administrators/index.js';
import type { ControllerConfiguration } from '../configuration/index.js';
import type { Actor, AuditTrail, JsonValue } from '../eventLog/index.js';
import {
	type InputReading,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	type OperationOutcome,
	type StoreReader,
	unreadableBody,
} from '../managementApi/index.js';
import type { SettingsSource } from './createSettingsSource.js';
import type { ChangeableSettingName, GrantRules, SettingName } from './types.js';
import { readGrantRules } from './readGrantRules.js';
import { SETTING_DEFINITIONS } from './settingDefinitions.js';
import { readHeldSettings, type StoredSetting } from './readStoredSettings.js';
import { SETTINGS_PROBLEMS } from './settingsProblems.js';

/** What the settings operations are built on: the configuration they judge against, the store and the trail. */
export interface SettingsOperationsSettings {
	/** The administrator store over a transaction's connection, which finds the administrator a change is made by. */
	administratorStoreOf(connection: pg.ClientBase): AdministratorStore;

	/** The configuration the operations read, the audiences, the clock, the schema and the trusted issuer. */
	settings: Pick<
		ControllerConfiguration,
		'backChannelLogoutAudiences' | 'clock' | 'databaseSchema' | 'identityProviderIssuer'
	>;

	/** The source the instance rereads its settings through once a change of its own has committed. */
	source: Pick<SettingsSource, 'reread'>;

	/** The store, read outside any transaction, one statement at a time. */
	store: StoreReader;

	/** The trail each change is made in, with its event. */
	trail: Pick<AuditTrail<pg.PoolClient>, 'inTransaction'>;
}

const noInput = (): InputReading<undefined> => ({ input: undefined, kind: 'read' });

const answered = (status: number, body: JsonValue): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

// The change's actor is the administrator making it, as the trail declares it before the change.
const actorOf = ({ subject, type }: { subject: string; type: 'human' | 'serviceAccount' }): Actor => ({
	id: subject,
	type,
});

// The body of a change of the grant rules: the list alone, read by the validator the seed file and the store use.
const readGrantRulesRequest = (
	body: Readonly<Record<string, unknown>> | undefined,
): InputReading<{ grantRules: GrantRules }> => {
	const members = Object.keys(body ?? {});
	if (!members.every((name) => name === 'grantRules')) {
		return {
			kind: 'refused',
			problem: unreadableBody('holds a member this operation does not take: it takes grantRules alone'),
		};
	}
	if (!Object.hasOwn(body ?? {}, 'grantRules')) {
		return { kind: 'refused', problem: unreadableBody('lacks the member grantRules') };
	}
	const reading = readGrantRules(body?.['grantRules']);
	return reading.kind === 'read'
		? { input: { grantRules: reading.value }, kind: 'read' }
		: { kind: 'refused', problem: unreadableBody(`holds grantRules, which ${reading.rule}`) };
};

// A setting's name and value as a change names them, one member of a settings update.
interface SettingChange {
	name: ChangeableSettingName;
	value: JsonValue;
}

// One member of a settings update, read by its name: a changeable setting's value, read by its own reader, or
// the rule the member breaks, which never quotes the value.
const readMember = (
	name: string,
	value: unknown,
): { kind: 'read'; change: SettingChange } | { kind: 'refused'; rule: string } => {
	if (!Object.hasOwn(SETTING_DEFINITIONS, name)) {
		return { kind: 'refused', rule: 'is not a setting this operation changes' };
	}
	const setting = name as SettingName;
	if (setting === 'grantRules') {
		return { kind: 'refused', rule: 'is changed through PUT /admin/settings/grant-rules' };
	}
	if (!SETTING_DEFINITIONS[setting].changeable) {
		return { kind: 'refused', rule: 'is fixed after the first run' };
	}
	const reading = SETTING_DEFINITIONS[setting].read(value);
	return reading.kind === 'read'
		? { kind: 'read', change: { name: setting as ChangeableSettingName, value: reading.value as JsonValue } }
		: { kind: 'refused', rule: reading.rule };
};

// The body of a change of settings: at least one member, each a changeable setting read by its own reader.
const readSettingsUpdate = (
	body: Readonly<Record<string, unknown>> | undefined,
): InputReading<readonly SettingChange[]> => {
	const members = Object.entries(body ?? {});
	if (members.length === 0) {
		return { kind: 'refused', problem: unreadableBody('holds no setting to change') };
	}
	// A name no setting takes is refused without being echoed: it is text from the caller.
	if (members.some(([name]) => !Object.hasOwn(SETTING_DEFINITIONS, name))) {
		return { kind: 'refused', problem: unreadableBody('holds a member that no setting takes') };
	}
	const readings = members.map(([name, value]) => ({ name, reading: readMember(name, value) }));
	const refusal = readings.find(({ reading }) => reading.kind === 'refused');
	if (refusal?.reading.kind === 'refused') {
		return { kind: 'refused', problem: unreadableBody(`holds ${refusal.name}, which ${refusal.reading.rule}`) };
	}
	return {
		input: readings.flatMap(({ reading }) => (reading.kind === 'read' ? [reading.change] : [])),
		kind: 'read',
	};
};

// Whether two lists of grant rules, each read by the validator, are the same rules in the same order.
const sameRules = (previous: GrantRules, next: GrantRules): boolean =>
	JSON.stringify(previous) === JSON.stringify(next);

const refused = (problem: (typeof SETTINGS_PROBLEMS)[keyof typeof SETTINGS_PROBLEMS]): OperationOutcome => ({
	kind: 'refused',
	problem,
});

/**
 * Creates the routes of the Management API's settings operations, each for platform administrators alone, and
 * each refusing a service account and anyone else before any read. The grant rules are read from the store by one
 * statement and validated with the reader the seed file and the Management API use, and replaced whole in one
 * transaction with their baseline notice. The other settings are read as one typed object, and changed all or
 * nothing: a change equal to the stored values writes nothing and records nothing, and a change lays its guards
 * over the caller's own token and over the back-channel logout audiences. A stored row breaking its rule is answered
 * 503 `storedSettingsInvalid`, with no value, and the instance answering a change holds it at once.
 *
 * @param operations the settings the operations read, the store they read it from and the trail a change is made in.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createSettingsRoutes = (
	{
		administratorStoreOf,
		settings: { backChannelLogoutAudiences, clock, databaseSchema },
		store,
		trail,
	}: SettingsOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const readGrantRulesOperation: ManagementOperation<undefined> = {
		administratorOnly: true,
		body: 'none',
		method: 'GET',
		readInput: noInput,
		route: '/admin/settings/grant-rules',
		run: async () => {
			const { rows } = await store.query<{ value: unknown }>(
				`SELECT value FROM ${pg.escapeIdentifier(databaseSchema)}.settings WHERE name = 'grantRules'`,
			);
			const reading = readGrantRules(rows[0]?.value);
			return reading.kind === 'read'
				? answered(200, { grantRules: reading.value })
				: refused(SETTINGS_PROBLEMS.storedSettingsInvalid);
		},
	};

	const readSettingsOperation: ManagementOperation<undefined> = {
		administratorOnly: true,
		body: 'none',
		method: 'GET',
		readInput: noInput,
		route: '/admin/settings',
		run: async () => {
			const { rows } = await store.query<StoredSetting>(
				`SELECT name, value FROM ${pg.escapeIdentifier(databaseSchema)}.settings`,
			);
			const reading = readHeldSettings(rows);
			return reading.kind === 'read'
				? answered(200, reading.settings)
				: refused(SETTINGS_PROBLEMS.storedSettingsInvalid);
		},
	};

	const changeGrantRulesOperation: ManagementOperation<{ grantRules: GrantRules }> = {
		administratorOnly: true,
		body: 'required',
		event: { named: async () => ({}), type: 'grantRules.change' },
		method: 'PUT',
		readInput: readGrantRulesRequest,
		route: '/admin/settings/grant-rules',
		run: async ({ input: { grantRules }, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return trail.inTransaction(
				actorOf(principal),
				async ({ connection, record }): Promise<OperationOutcome> => {
					const { rows } = await connection.query<{ value: unknown }>(
						`SELECT value FROM ${pg.escapeIdentifier(databaseSchema)}.settings WHERE name = 'grantRules' FOR UPDATE`,
					);
					const stored = readGrantRules(rows[0]?.value);
					if (stored.kind === 'refused') {
						return refused(SETTINGS_PROBLEMS.storedSettingsInvalid);
					}
					if (sameRules(stored.value, grantRules)) {
						return answered(200, { grantRules: stored.value });
					}
					const administrator = await administratorStoreOf(connection).findPerson(principal.subject);
					if (administrator === undefined) {
						throw new Error('an administrator is always a recorded person');
					}
					await connection.query(
						`UPDATE ${pg.escapeIdentifier(databaseSchema)}.settings
						SET value = $1::jsonb, changed_at = $2, changed_by = $3
						WHERE name = 'grantRules'`,
						[JSON.stringify(grantRules), now, administrator],
					);
					await record({
						data: {
							grantRules,
							previousGrantRules: stored.value,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'critical',
						type: 'grantRules.change',
					});
					return answered(200, { grantRules });
				},
			);
		},
	};

	const changeSettingsOperation: ManagementOperation<readonly SettingChange[]> = {
		administratorOnly: true,
		afterCommit: ['settingsReread'],
		body: 'required',
		event: { named: async () => ({}), type: 'settings.change' },
		method: 'PATCH',
		readInput: (body) => readSettingsUpdate(body),
		route: '/admin/settings',
		run: async ({ input, principal, sourceIp }) => {
			const now = new Date(clock.now());
			return trail.inTransaction(
				actorOf(principal),
				async ({ connection, record }): Promise<OperationOutcome> => {
					const { rows } = await connection.query<StoredSetting>(
						`SELECT name, value FROM ${pg.escapeIdentifier(databaseSchema)}.settings FOR UPDATE`,
					);
					const stored = rows.map((row) => ({ name: row.name, value: row.value as JsonValue }));
					const previousOf = (name: string): JsonValue | undefined =>
						stored.find((row) => row.name === name)?.value;
					const changes = input.filter(
						({ name, value }) => JSON.stringify(value) !== JSON.stringify(previousOf(name)),
					);
					// The whole of the stored settings with the update applied, read and validated together: a rule
					// laid across settings is judged on the values they would hold.
					const after = readHeldSettings(
						stored.map((row) => input.find(({ name }) => name === row.name) ?? row),
					);
					if (after.kind === 'refused') {
						const named = after.problems.find(({ setting }) => input.some(({ name }) => name === setting));
						return named === undefined
							? refused(SETTINGS_PROBLEMS.storedSettingsInvalid)
							: refused(unreadableBody(`holds ${named.setting}, which ${named.rule}`));
					}
					if (changes.length === 0) {
						return answered(200, after.settings);
					}
					const maximum = changes.find(({ name }) => name === 'signInTokenMaximumLifetimeSeconds');
					if (typeof maximum?.value === 'number' && principal.tokenLifetimeSeconds > maximum.value) {
						return refused(SETTINGS_PROBLEMS.changeLocksOutCaller);
					}
					if (
						changes.some(({ name, value }) => name === 'backChannelLogout' && value === true) &&
						backChannelLogoutAudiences.length === 0
					) {
						return refused(SETTINGS_PROBLEMS.backChannelLogoutNeedsAudiences);
					}
					const administrator = await administratorStoreOf(connection).findPerson(principal.subject);
					if (administrator === undefined) {
						throw new Error('an administrator is always a recorded person');
					}
					await connection.query(
						`UPDATE ${pg.escapeIdentifier(databaseSchema)}.settings AS setting
						SET value = changed.value::jsonb, changed_at = $2, changed_by = $3
						FROM unnest($1::text[], $4::text[]) AS changed(name, value)
						WHERE setting.name = changed.name`,
						[
							changes.map(({ name }) => name),
							now,
							administrator,
							changes.map(({ value }) => JSON.stringify(value)),
						],
					);
					await record({
						data: {
							changes: changes.map(({ name, value }) => ({
								name,
								previousValue: previousOf(name) ?? null,
								value,
							})),
							result: 'succeeded',
							sourceIp,
						},
						severity: changes.some(({ name }) => SETTING_DEFINITIONS[name].severity === 'critical')
							? 'critical'
							: 'warning',
						type: 'settings.change',
					});
					return answered(200, after.settings);
				},
			);
		},
	};

	return [
		managementRoute(readGrantRulesOperation, dependencies),
		managementRoute(changeSettingsOperation, dependencies),
		managementRoute(changeGrantRulesOperation, dependencies),
		managementRoute(readSettingsOperation, dependencies),
	];
};
