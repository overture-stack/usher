import pg from 'pg';

import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { AuditTransaction, JsonValue, Severity } from '../eventLog/index.js';
import { ControllerError, type StartProblem } from '../failures/index.js';
import type { StoreSettings } from './types.js';
import { writeOrRefuse } from './writeOrRefuse.js';

/**
 * The identity provider's identifiers the store records at each start, in the order it lists them: the
 * record names no actor, only what changed and when.
 */
export const IDENTIFIER_NAMES = [
	'apiDocsClient',
	'backChannelLogoutAudiences',
	'identityProviderIssuer',
	'managementAudience',
	'managementClients',
	'serviceAccountRole',
] as const;

/** One of the identifiers the store records. */
export type IdentifierName = (typeof IDENTIFIER_NAMES)[number];

// A change to one of these is critical; a change to any other identifier is a warning.
const CRITICAL_NAMES: readonly IdentifierName[] = [
	'identityProviderIssuer',
	'managementAudience',
	'managementClients',
	'serviceAccountRole',
];

const UNWRITABLE: StartProblem = {
	rule: "names a database role that may only read, which cannot record the identity provider's identifiers this start reads",
	variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

// A list is held as a set, so it is stored sorted and its order records nothing; any other value is held as given.
const normalized = (value: JsonValue): JsonValue => (Array.isArray(value) ? [...new Set(value)].toSorted() : value);

const sameValue = (stored: JsonValue, held: JsonValue): boolean =>
	JSON.stringify(normalized(stored)) === JSON.stringify(normalized(held));

// The record's values by name, a row never filled holding null. A plain read, not `FOR UPDATE`: that
// locking read needs UPDATE privilege, which a role that may only read lacks, and it would refuse such a
// start even when the record already matches. Every start takes the START_LOCK advisory lock before this
// read, so starts take turns, and starts are the rows' only writers.
const recordedValues = async (connection: pg.ClientBase, schema: string): Promise<ReadonlyMap<string, JsonValue>> => {
	const { rows } = await connection.query<{ name: string; value: JsonValue }>(
		`SELECT name, value FROM ${pg.escapeIdentifier(schema)}.identity_provider_configuration ORDER BY name`,
	);
	return new Map(rows.map(({ name, value }) => [name, value]));
};

const recordedValueOf = (recorded: ReadonlyMap<string, JsonValue>, name: IdentifierName): JsonValue => {
	if (!recorded.has(name)) {
		throw new ControllerError(`the store holds no record of the identity provider's ${name}`);
	}
	return recorded.get(name) ?? null;
};

/**
 * Records the identity provider's identifiers the configuration reads, in the transaction a start runs
 * in, after its start lock. A row never filled is filled with no event. Where a recorded
 * value differs from the configured one, one `identityProvider.configurationChange` is recorded as the
 * system, naming each identifier changed with its previous and new value, at `critical` when the issuer,
 * the management audience, the management clients or the service-account role changed and at `warning`
 * otherwise; then each row changed or unfilled takes the new value and the configured clock's time.
 * Lists compare as sets and are stored sorted. A start whose record already matches writes nothing.
 *
 * @param transaction the start's transaction, held as the system.
 * @param settings the schema, the clock and the identifiers the configuration reads.
 * @throws {StartRefusal} naming the database URL when the database role may not write the record and
 *   the record needs a write.
 * @throws {ControllerError} when the store holds no row for an identifier.
 */
export const recordIdentityProvider = async (
	transaction: AuditTransaction<pg.ClientBase>,
	settings: Pick<StoreSettings, 'clock' | 'databaseSchema' | IdentifierName>,
): Promise<void> => {
	const { connection } = transaction;
	const recorded = await recordedValues(connection, settings.databaseSchema);
	const comparisons = IDENTIFIER_NAMES.map((name) => ({
		held: normalized(settings[name]),
		name,
		previous: recordedValueOf(recorded, name),
	}));
	const changes = comparisons.filter(({ held, previous }) => previous !== null && !sameValue(previous, held));
	const updated = comparisons.filter(({ held, previous }) => previous === null || !sameValue(previous, held));
	if (updated.length === 0) {
		return;
	}
	const severity: Severity = changes.some(({ name }) => CRITICAL_NAMES.includes(name)) ? 'critical' : 'warning';
	const recordedAt = new Date(settings.clock.now());
	await writeOrRefuse(UNWRITABLE, async () => {
		if (changes.length > 0) {
			await transaction.record({
				data: {
					changes: changes.map(({ held, name, previous }) => ({
						name,
						previousValue: previous,
						value: held,
					})),
				},
				severity,
				type: 'identityProvider.configurationChange',
			});
		}
		await Promise.all(
			updated.map(({ held, name }) =>
				connection.query(
					`UPDATE ${pg.escapeIdentifier(settings.databaseSchema)}.identity_provider_configuration SET value = $1, recorded_at = $2 WHERE name = $3`,
					[JSON.stringify(held), recordedAt, name],
				),
			),
		);
	});
};
