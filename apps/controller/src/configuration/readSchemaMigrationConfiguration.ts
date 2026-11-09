import { type StartProblem, StartRefusal } from '../failures/index.js';
import {
  LARGEST_RETENTION_FLOOR_SECONDS,
  MIGRATIONS_REFUSE_TO_RUN,
} from '../migrations/index.js';
import {
  ENVIRONMENT_VARIABLES,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
} from './environmentVariables.js';
import { readRetentionDurations, retentionFloorSeconds } from './retention.js';
import type {
  ConfigurationEnvironment,
  FieldWithVariable,
  SchemaMigrationConfiguration,
  SchemaMigrationFieldWithVariable,
  RetentionDurations,
} from './types.js';
import {
  CONTROLLER_ROLE_DESCRIPTION,
  readDatabaseRole,
  readDatabaseUrl,
  readText,
  type Reading,
  type Variable,
} from './variableReaders.js';

const RETENTION_FIELDS: readonly (keyof RetentionDurations)[] = [
  'retentionGraceSeconds',
  'retentionMarginSeconds',
  'tokenLifetimeSeconds',
];

// Every duration adds to the floor, so a floor past what its column holds lays the fault on each.
const floorProblems = (
  durations: RetentionDurations,
): readonly StartProblem[] =>
  retentionFloorSeconds(durations) <= LARGEST_RETENTION_FLOOR_SECONDS
    ? []
    : RETENTION_FIELDS.map((field) => ({
        rule: `adds to a retention floor of more than ${LARGEST_RETENTION_FLOOR_SECONDS} seconds, the most one may be`,
        variable: ENVIRONMENT_VARIABLES[field],
      }));

const valueOf = <Value>(reading: Reading<Value>): Value => {
  if (reading.kind === 'read') {
    return reading.value;
  }
  throw new StartRefusal([reading.problem], MIGRATIONS_REFUSE_TO_RUN);
};

/**
 * Reads the schema migration command's configuration from an environment, every variable checked
 * before any is used: a refusal lists every rule broken, each naming the variable at fault and
 * never its value. The schema migration role's URL and its password are read from variables of the
 * command's own, {@link SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES}, the URL refused when it carries a
 * password or names no database role, as the controller's is. The runtime role is the database
 * role the controller's own URL names, read and refused as the controller reads it, and nothing else
 * of that URL is kept; the controller's password is never read. The schema and the retention
 * floor's durations are read from the controller's own variables, with the controller's defaults,
 * and the floor is their sum.
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
  const retention = readRetentionDurations(shared);
  const readings = {
    databasePassword: readText(own('databasePassword')),
    databaseUrl: readDatabaseUrl(own('databaseUrl'), {
      passwordVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword,
      roleDescription: 'the schema migration role',
    }),
    retentionGraceSeconds: retention.retentionGraceSeconds,
    retentionMarginSeconds: retention.retentionMarginSeconds,
    runtimeRole: readDatabaseRole(shared('databaseUrl'), {
      passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
      roleDescription: CONTROLLER_ROLE_DESCRIPTION,
    }),
    schema: readText(shared('databaseSchema')),
    tokenLifetimeSeconds: retention.tokenLifetimeSeconds,
  };
  const durations = (): RetentionDurations => ({
    retentionGraceSeconds: valueOf(readings.retentionGraceSeconds),
    retentionMarginSeconds: valueOf(readings.retentionMarginSeconds),
    tokenLifetimeSeconds: valueOf(readings.tokenLifetimeSeconds),
  });
  const readProblems = Object.values(readings).flatMap((reading) =>
    reading.kind === 'refused' ? [reading.problem] : [],
  );
  // The floor is checked only once every duration it is made of has been read.
  const problems =
    readProblems.length === 0 ? floorProblems(durations()) : readProblems;
  if (problems.length === 0) {
    return {
      databasePassword: valueOf(readings.databasePassword),
      databaseUrl: valueOf(readings.databaseUrl),
      retentionFloorSeconds: retentionFloorSeconds(durations()),
      runtimeRole: valueOf(readings.runtimeRole),
      schema: valueOf(readings.schema),
    };
  }
  throw new StartRefusal(problems, MIGRATIONS_REFUSE_TO_RUN);
};
