import { StartRefusal } from '../failures/index.js';
import { MIGRATIONS_REFUSE_TO_RUN } from '../migrations/index.js';
import {
	ENVIRONMENT_VARIABLES,
	REPLACED_VARIABLES,
	SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
} from './environmentVariables.js';
import type {
	ConfigurationEnvironment,
	FieldWithVariable,
	SchemaMigrationConfiguration,
	SchemaMigrationFieldWithVariable,
} from './types.js';
import {
	CONTROLLER_ROLE_DESCRIPTION,
	read,
	readDatabaseRole,
	readDatabaseUrl,
	readSwitch,
	readText,
	readVerifiedConnection,
	type Reading,
	then,
	type Variable,
} from './variableReaders.js';

const valueOf = <Value>(reading: Reading<Value>): Value => {
	if (reading.kind === 'read') {
		return reading.value;
	}
	throw new StartRefusal([reading.problem], MIGRATIONS_REFUSE_TO_RUN);
};

// The seed file's default path, resolved against the command's working directory when it is read.
const DEFAULT_SEED_FILE = './seed.json';

// The seed file is optional: unset, the run reads the default path, and set, the path is read as any other text.
const readSeedFile = (variable: Variable): Reading<string> =>
	variable.value === undefined ? read(DEFAULT_SEED_FILE) : readText(variable);

/**
 * Reads the schema migration command's configuration from an environment, every variable checked
 * before any is used: a refusal lists every rule broken, each naming the variable at fault and
 * never its value. The schema migration role's URL and its password are read from variables of the
 * command's own, {@link SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES}, the URL refused when it carries a
 * password, names no database role, names a file the driver cannot read, or leaves the host without
 * verifying the server while `USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION`, read as the Controller
 * reads it, does not allow that, as the Controller's is. The runtime role is the database role the
 * Controller's own URL names, read and refused as the Controller reads it, and nothing else of that
 * URL is kept; the Controller's password is never read. The schema is read from the Controller's own
 * variables, with the Controller's default. Every variable in {@link REPLACED_VARIABLES} that is set,
 * empty or not, is refused, naming the variable that replaces it.
 *
 * @param environment the environment variables, such as `process.env`.
 * @throws {StartRefusal} naming each variable at fault, its message opening with the schema
 *   migrations' refusal to run.
 */
export const readSchemaMigrationConfiguration = (
	environment: ConfigurationEnvironment,
): SchemaMigrationConfiguration => {
	const own = (field: SchemaMigrationFieldWithVariable): Variable => ({
		name: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES[field],
		value: environment[SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES[field]],
	});
	const shared = (field: FieldWithVariable): Variable => ({
		name: ENVIRONMENT_VARIABLES[field],
		value: environment[ENVIRONMENT_VARIABLES[field]],
	});
	const databaseAllowUnverifiedConnection = readSwitch(shared('databaseAllowUnverifiedConnection'), false);
	const readings = {
		seedFile: readSeedFile(own('seedFile')),
		databaseAllowUnverifiedConnection,
		databasePassword: readText(own('databasePassword')),
		// An opt-out that cannot be read allows nothing, beside its own refusal.
		databaseUrl: then(
			readDatabaseUrl(own('databaseUrl'), {
				passwordVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword,
				roleDescription: 'the schema migration role',
			}),
			(url) =>
				readVerifiedConnection(
					own('databaseUrl'),
					url,
					databaseAllowUnverifiedConnection.kind === 'read' && databaseAllowUnverifiedConnection.value,
				),
		),
		runtimeRole: readDatabaseRole(shared('databaseUrl'), {
			passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
			roleDescription: CONTROLLER_ROLE_DESCRIPTION,
		}),
		schema: readText(shared('databaseSchema')),
	};
	const replaced = Object.entries(REPLACED_VARIABLES).flatMap(([variable, replacement]) =>
		environment[variable] === undefined ? [] : [{ rule: `is replaced by ${replacement}: unset it`, variable }],
	);
	const problems = [
		...replaced,
		...Object.values(readings).flatMap((reading) => (reading.kind === 'refused' ? [reading.problem] : [])),
	];
	if (problems.length === 0) {
		return {
			seedFile: valueOf(readings.seedFile),
			databaseAllowUnverifiedConnection: valueOf(readings.databaseAllowUnverifiedConnection),
			databasePassword: valueOf(readings.databasePassword),
			databaseUrl: valueOf(readings.databaseUrl),
			runtimeRole: valueOf(readings.runtimeRole),
			schema: valueOf(readings.schema),
		};
	}
	throw new StartRefusal(problems, MIGRATIONS_REFUSE_TO_RUN);
};
