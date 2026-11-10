import { StartRefusal } from '../failures/index.js';
import { ENVIRONMENT_VARIABLES } from './environmentVariables.js';
import { readRecordRule } from './readRecordRule.js';
import { readRetentionDurations } from './retention.js';
import type {
  Clock,
  ConfigurationEnvironment,
  ControllerConfiguration,
  FieldWithVariable,
} from './types.js';
import {
  CONTROLLER_ROLE_DESCRIPTION,
  readAddresses,
  readDatabaseUrl,
  readInteger,
  readKey,
  readList,
  readSecureUrl,
  readText,
  type Reading,
  type Variable,
} from './variableReaders.js';

// The greatest delay a Node timer keeps; a longer one fires at once.
const LONGEST_TIMER_MILLISECONDS = 2_147_483_647;

// The least a stream's maximum lifetime may be, so a mistyped value cannot end every stream at once.
const STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS = 60;

const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

const valueOf = <Value>(reading: Reading<Value>): Value => {
  if (reading.kind === 'read') {
    return reading.value;
  }
  throw new StartRefusal([reading.problem]);
};

/**
 * Reads the controller's configuration from an environment, every variable checked before any is
 * used: a refusal lists every rule broken, each naming the variable at fault and never its value.
 * The keys are 32 bytes as 43 base64url characters in canonical form, any whitespace around them left
 * out; the database's password is read from its own variable, as given, and a database URL carrying
 * one is refused, as is one naming no database role. The clock is the system's and the log stream
 * the process's standard output; neither is read from the environment.
 *
 * @param environment the environment variables, such as `process.env`.
 * @throws {StartRefusal} naming each variable at fault.
 */
export const readConfiguration = (
  environment: ConfigurationEnvironment,
): ControllerConfiguration => {
  const variable = (field: FieldWithVariable): Variable => ({
    name: ENVIRONMENT_VARIABLES[field],
    value: environment[ENVIRONMENT_VARIABLES[field]],
  });
  const retention = readRetentionDurations(variable);
  const readings = {
    administratorRole: readText(variable('administratorRole'), {
      fallback: 'usher-platform-admin',
    }),
    backChannelLogoutAudiences: readList(
      variable('backChannelLogoutAudiences'),
    ),
    baseline: readRecordRule(variable('baseline')),
    cursorKey: readKey(variable('cursorKey')),
    databasePassword: readText(variable('databasePassword')),
    databaseSchema: readText(variable('databaseSchema')),
    databaseUrl: readDatabaseUrl(variable('databaseUrl'), {
      passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
      roleDescription: CONTROLLER_ROLE_DESCRIPTION,
    }),
    eventSource: readText(variable('eventSource')),
    heartbeatMilliseconds: readInteger(variable('heartbeatMilliseconds'), {
      fallback: 10_000,
      maximum: LONGEST_TIMER_MILLISECONDS,
      minimum: 1,
    }),
    host: readText(variable('host')),
    identityProviderIssuer: readSecureUrl(variable('identityProviderIssuer')),
    instanceName: readText(variable('instanceName')),
    keyEncryptionKey: readKey(variable('keyEncryptionKey')),
    managementAudience: readText(variable('managementAudience')),
    managementClients: readList(variable('managementClients')),
    noticePageLimit: readInteger(variable('noticePageLimit'), {
      fallback: 500,
      minimum: 1,
    }),
    noticeRereadMilliseconds: readInteger(
      variable('noticeRereadMilliseconds'),
      { fallback: 2000, maximum: LONGEST_TIMER_MILLISECONDS, minimum: 1 },
    ),
    port: readInteger(variable('port'), { maximum: 65_535, minimum: 0 }),
    retentionGraceSeconds: retention.retentionGraceSeconds,
    retentionMarginSeconds: retention.retentionMarginSeconds,
    signInTokenMaximumLifetimeSeconds: readInteger(
      variable('signInTokenMaximumLifetimeSeconds'),
      { minimum: 1 },
    ),
    signedInRule: readRecordRule(variable('signedInRule')),
    storeTimeoutMilliseconds: readInteger(
      variable('storeTimeoutMilliseconds'),
      { fallback: 5000, maximum: LONGEST_TIMER_MILLISECONDS, minimum: 1 },
    ),
    streamLimitPerAudience: readInteger(variable('streamLimitPerAudience'), {
      fallback: 64,
      minimum: 1,
    }),
    streamMaximumLifetimeSeconds: readInteger(
      variable('streamMaximumLifetimeSeconds'),
      { fallback: 900, minimum: STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS },
    ),
    streamQueueLimit: readInteger(variable('streamQueueLimit'), {
      fallback: 1000,
      minimum: 1,
    }),
    tokenLifetimeSeconds: retention.tokenLifetimeSeconds,
    trustedProxies: readAddresses(variable('trustedProxies')),
  } satisfies Record<FieldWithVariable, Reading<unknown>>;
  const problems = Object.values(readings).flatMap((reading) =>
    reading.kind === 'refused' ? [reading.problem] : [],
  );
  if (problems.length === 0) {
    return {
      administratorRole: valueOf(readings.administratorRole),
      backChannelLogoutAudiences: valueOf(readings.backChannelLogoutAudiences),
      baseline: valueOf(readings.baseline),
      clock: SYSTEM_CLOCK,
      cursorKey: valueOf(readings.cursorKey),
      databasePassword: valueOf(readings.databasePassword),
      databaseSchema: valueOf(readings.databaseSchema),
      databaseUrl: valueOf(readings.databaseUrl),
      eventSource: valueOf(readings.eventSource),
      heartbeatMilliseconds: valueOf(readings.heartbeatMilliseconds),
      host: valueOf(readings.host),
      identityProviderIssuer: valueOf(readings.identityProviderIssuer),
      instanceName: valueOf(readings.instanceName),
      keyEncryptionKey: valueOf(readings.keyEncryptionKey),
      logStream: process.stdout,
      managementAudience: valueOf(readings.managementAudience),
      managementClients: valueOf(readings.managementClients),
      noticePageLimit: valueOf(readings.noticePageLimit),
      noticeRereadMilliseconds: valueOf(readings.noticeRereadMilliseconds),
      port: valueOf(readings.port),
      retentionGraceSeconds: valueOf(readings.retentionGraceSeconds),
      retentionMarginSeconds: valueOf(readings.retentionMarginSeconds),
      signInTokenMaximumLifetimeSeconds: valueOf(
        readings.signInTokenMaximumLifetimeSeconds,
      ),
      signedInRule: valueOf(readings.signedInRule),
      storeTimeoutMilliseconds: valueOf(readings.storeTimeoutMilliseconds),
      streamLimitPerAudience: valueOf(readings.streamLimitPerAudience),
      streamMaximumLifetimeSeconds: valueOf(
        readings.streamMaximumLifetimeSeconds,
      ),
      streamQueueLimit: valueOf(readings.streamQueueLimit),
      tokenLifetimeSeconds: valueOf(readings.tokenLifetimeSeconds),
      trustedProxies: valueOf(readings.trustedProxies),
    };
  }
  throw new StartRefusal(problems);
};
