import { StartRefusal } from '../failures/index.js';
import { ENVIRONMENT_VARIABLES } from './environmentVariables.js';
import { readRecordRule } from './readRecordRule.js';
import { readRetentionDurations } from './retention.js';
import type {
  AccessLevel,
  Clock,
  ConfigurationEnvironment,
  ControllerConfiguration,
  FieldWithVariable,
  GrantRateThreshold,
} from './types.js';
import {
  CONTROLLER_ROLE_DESCRIPTION,
  read,
  readAddresses,
  readBoolean,
  readChoice,
  readDatabaseUrl,
  readInteger,
  readJson,
  readKey,
  readList,
  readSecureUrl,
  readStoreUrl,
  readText,
  type Reading,
  type Variable,
} from './variableReaders.js';

const ACCESS_LEVELS: readonly AccessLevel[] = ['grant', 'open', 'registered'];

// The greatest delay a Node timer keeps; a longer one fires at once.
const LONGEST_TIMER_MILLISECONDS = 2_147_483_647;

// The least a stream's maximum lifetime may be, so a mistyped value cannot end every stream at once.
const STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS = 60;

const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWholeFromOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const isThreshold = (value: unknown): value is GrantRateThreshold =>
  isRecord(value) &&
  Object.keys(value).toSorted().join(',') === 'operationCount,windowSeconds' &&
  isWholeFromOne(value['operationCount']) &&
  isWholeFromOne(value['windowSeconds']);

const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string' && entry !== '');

// A prefix list must tell an empty prefix from none, so it is JSON rather than comma-separated.
const isPrefixList = (value: unknown): value is readonly string[] =>
  isTextList(value) && new Set(value).size === value.length;

const readBaseTier = (variable: Variable): Reading<AccessLevel | null> =>
  variable.value === undefined || variable.value === ''
    ? read(null)
    : readChoice(variable, ACCESS_LEVELS);

// Each part of the directory is needed once its URL names one, and may be empty while it names none.
const readDirectoryPart = (
  variable: Variable,
  directoryNamed: boolean,
): Reading<string> =>
  directoryNamed
    ? readText(variable)
    : readText(variable, { emptyAllowed: true, fallback: '' });

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
 * out; each store's password is read from its own variable, as given, and a store URL carrying one is
 * refused, as is a database URL naming no database role. The clock is the system's and the log stream
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
  const directoryUrl = readSecureUrl(variable('directoryUrl'), '');
  const retention = readRetentionDurations(variable);
  const directoryNamed =
    directoryUrl.kind === 'read' && directoryUrl.value !== '';
  const readings = {
    administratorRole: readText(variable('administratorRole'), {
      fallback: 'usher-platform-admin',
    }),
    allowedCharactersExtra: readText(variable('allowedCharactersExtra'), {
      emptyAllowed: true,
      fallback: '',
    }),
    autoAccept: readBoolean(variable('autoAccept'), false),
    backChannelLogoutAudiences: readList(
      variable('backChannelLogoutAudiences'),
    ),
    baseline: readRecordRule(variable('baseline')),
    cachePassword: readText(variable('cachePassword')),
    cacheUrl: readStoreUrl(variable('cacheUrl'), {
      passwordVariable: ENVIRONMENT_VARIABLES.cachePassword,
    }),
    cursorKey: readKey(variable('cursorKey')),
    databasePassword: readText(variable('databasePassword')),
    databaseSchema: readText(variable('databaseSchema')),
    databaseUrl: readDatabaseUrl(variable('databaseUrl'), {
      passwordVariable: ENVIRONMENT_VARIABLES.databasePassword,
      roleDescription: CONTROLLER_ROLE_DESCRIPTION,
    }),
    directoryClientId: readDirectoryPart(
      variable('directoryClientId'),
      directoryNamed,
    ),
    directoryClientSecret: readDirectoryPart(
      variable('directoryClientSecret'),
      directoryNamed,
    ),
    directoryRealm: readDirectoryPart(
      variable('directoryRealm'),
      directoryNamed,
    ),
    directoryUrl,
    egoMigrationAllStudyPolicies: readJson(
      variable('egoMigrationAllStudyPolicies'),
      {
        fallback: [],
        isValue: isTextList,
        rule: 'is not a JSON list of policy names, none of them empty',
      },
    ),
    egoMigrationBaseTier: readBaseTier(variable('egoMigrationBaseTier')),
    egoMigrationPrefixes: readJson(variable('egoMigrationPrefixes'), {
      fallback: [],
      isValue: isPrefixList,
      rule: 'is not a JSON list of prefixes, each one non-empty and listed once',
    }),
    eventSource: readText(variable('eventSource')),
    grantRateThreshold: readJson(variable('grantRateThreshold'), {
      isValue: isThreshold,
      rule: 'is not a JSON object holding a whole operationCount and windowSeconds alone, each at least 1',
    }),
    heartbeatMilliseconds: readInteger(variable('heartbeatMilliseconds'), {
      fallback: 10_000,
      maximum: LONGEST_TIMER_MILLISECONDS,
      minimum: 1,
    }),
    host: readText(variable('host')),
    identityProviderIssuer: readSecureUrl(variable('identityProviderIssuer')),
    instanceName: readText(variable('instanceName')),
    issuer: readText(variable('issuer')),
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
    platformDefaultAccessLevel: readChoice(
      variable('platformDefaultAccessLevel'),
      ACCESS_LEVELS,
      'registered',
    ),
    port: readInteger(variable('port'), { maximum: 65_535, minimum: 0 }),
    retentionGraceSeconds: retention.retentionGraceSeconds,
    retentionMarginSeconds: retention.retentionMarginSeconds,
    selfGrantMaximumSeconds: readInteger(variable('selfGrantMaximumSeconds'), {
      fallback: 86_400,
      minimum: 1,
    }),
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
    submitterCategory: readText(variable('submitterCategory'), {
      fallback: 'global.unmarked',
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
      allowedCharactersExtra: valueOf(readings.allowedCharactersExtra),
      autoAccept: valueOf(readings.autoAccept),
      backChannelLogoutAudiences: valueOf(readings.backChannelLogoutAudiences),
      baseline: valueOf(readings.baseline),
      cachePassword: valueOf(readings.cachePassword),
      cacheUrl: valueOf(readings.cacheUrl),
      clock: SYSTEM_CLOCK,
      cursorKey: valueOf(readings.cursorKey),
      databasePassword: valueOf(readings.databasePassword),
      databaseSchema: valueOf(readings.databaseSchema),
      databaseUrl: valueOf(readings.databaseUrl),
      directoryClientId: valueOf(readings.directoryClientId),
      directoryClientSecret: valueOf(readings.directoryClientSecret),
      directoryRealm: valueOf(readings.directoryRealm),
      directoryUrl: valueOf(readings.directoryUrl),
      egoMigrationAllStudyPolicies: valueOf(
        readings.egoMigrationAllStudyPolicies,
      ),
      egoMigrationBaseTier: valueOf(readings.egoMigrationBaseTier),
      egoMigrationPrefixes: valueOf(readings.egoMigrationPrefixes),
      eventSource: valueOf(readings.eventSource),
      grantRateThreshold: valueOf(readings.grantRateThreshold),
      heartbeatMilliseconds: valueOf(readings.heartbeatMilliseconds),
      host: valueOf(readings.host),
      identityProviderIssuer: valueOf(readings.identityProviderIssuer),
      instanceName: valueOf(readings.instanceName),
      issuer: valueOf(readings.issuer),
      keyEncryptionKey: valueOf(readings.keyEncryptionKey),
      logStream: process.stdout,
      managementAudience: valueOf(readings.managementAudience),
      managementClients: valueOf(readings.managementClients),
      noticePageLimit: valueOf(readings.noticePageLimit),
      noticeRereadMilliseconds: valueOf(readings.noticeRereadMilliseconds),
      platformDefaultAccessLevel: valueOf(readings.platformDefaultAccessLevel),
      port: valueOf(readings.port),
      retentionGraceSeconds: valueOf(readings.retentionGraceSeconds),
      retentionMarginSeconds: valueOf(readings.retentionMarginSeconds),
      selfGrantMaximumSeconds: valueOf(readings.selfGrantMaximumSeconds),
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
      submitterCategory: valueOf(readings.submitterCategory),
      tokenLifetimeSeconds: valueOf(readings.tokenLifetimeSeconds),
      trustedProxies: valueOf(readings.trustedProxies),
    };
  }
  throw new StartRefusal(problems);
};
