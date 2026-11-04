import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { RecordAction } from '@overture-stack/usher-types';

/** A source of the current time, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/**
 * An application's id and one of its keys, as given to its bridge by the key's issue. The
 * controller's configuration names no application; the database is the only list of them.
 */
export interface ControllerApplication {
  /** The application's audience identifier: its `applications.id`, a generated uuid, and every Usher token's `aud` for it, verbatim. */
  id: string;

  /** An application key: 32 bytes as 43 base64url characters in canonical form. */
  key: string;
}

/**
 * The controller's configuration, typed: what the config module reads from an environment and what
 * the controller is created from. A default named below is the controller's when the environment
 * leaves that variable unset.
 */
export interface ControllerConfiguration {
  /** The identity provider realm role that makes its holder a platform administrator; `usher-platform-admin` by default. */
  administratorRole: string;

  /**
   * The characters an instance adds to the default set an externalId may hold (ASCII letters, digits,
   * dot, underscore and hyphen, #211 Q1); none by default. Letters beyond ASCII are compared by Unicode
   * case folding after NFC.
   */
  allowedCharactersExtra: string;

  /** Whether a grant is accepted at creation without its recipient answering it (auto-accept); off by default. */
  autoAccept: boolean;

  /** The `aud` values a back-channel logout token may carry: the platform's client identifiers. */
  backChannelLogoutAudiences: readonly string[];

  /** The record actions the baseline confers on everyone, anonymous visitors included; count, view and export by default. */
  baseline: readonly RecordAction[];

  /**
   * The cache's (Valkey) password, in a variable of its own: a missing one refuses the start, naming
   * the variable and never its value.
   */
  cachePassword: string;

  /** The cache's (Valkey) URL, carrying no password: one carrying a password refuses the start. */
  cacheUrl: string;

  /**
   * The controller's wall clock. Set only through the configuration, never from the environment, so a
   * test can fix now. Every duration the controller measures runs on it, the signing-key cache's
   * maximum age (10 min) and refetch cooldown (30 s) included (#208 Q5), so a test moves past either by
   * advancing this clock.
   */
  clock: Clock;

  /** The key cursors are encrypted under, shared by every instance: 43 base64url characters, as an application key is. */
  cursorKey: string;

  /**
   * The runtime role's PostgreSQL password, in a variable of its own: a missing one refuses the start,
   * naming the variable and never its value.
   */
  databasePassword: string;

  /** The schema the controller's tables live in. */
  databaseSchema: string;

  /**
   * A connection URL under the controller's runtime role, carrying no password: one carrying a
   * password refuses the start.
   */
  databaseUrl: string;

  /** The client id of the service account the controller resolves addresses through (#212, #213 Q1). */
  directoryClientId: string;

  /** That service account's secret, which no refusal, log line or answer ever shows. */
  directoryClientSecret: string;

  /** The identity provider realm the directory looks people up in. */
  directoryRealm: string;

  /**
   * The identity provider's base URL, whose admin API the directory reads (`<url>/admin/realms/<realm>`);
   * empty for none, which answers every operation needing an address as the directory unavailable.
   */
  directoryUrl: string;

  /**
   * The EGO policies granting every study, by name, matched as literal text (ruled, "#216: all-study
   * policies and data without a policy" 1): `ENVIRONMENTAL` in iMS. None by default. A run reads no
   * study from such a policy and writes its holders no grant; it lists each holding in the report's
   * `allStudyAccess`, for the administrator to decide each person deliberately.
   */
  egoMigrationAllStudyPolicies: readonly string[];

  /**
   * The base tier of each resource the EGO migration registers (#216 Q12); `null`, none, by default,
   * and a migration run while none is configured is refused before it reads its export.
   */
  egoMigrationBaseTier: 'grant' | 'open' | 'registered' | null;

  /**
   * The prefixes the EGO migration reads a study id after in a policy's name, matched as literal text
   * in their configured letter case (#216 Q4, Q7): `PX-` and `PX-FILES-` in iMS. None by default, and a
   * migration run while none is configured answers 503 `migrationNotConfigured` before it reads its
   * export; an empty prefix, or one listed twice, refuses the controller's start, naming this field's
   * variable (ruled, "#216's reasons, export size and prefixes" 3).
   */
  egoMigrationPrefixes: readonly string[];

  /** The CloudEvents `source` every event carries: one per deployment, the same on every instance (#214). */
  eventSource: string;

  /**
   * When `grant.rateExceeded` fires: more grant operations by one actor than `operationCount` within
   * `windowSeconds` (#214 Q19), as `audit-events.md` names the setting.
   */
  grantRateThreshold: { operationCount: number; windowSeconds: number };

  /**
   * How long an open notice stream may stay silent before the controller writes a heartbeat comment,
   * in milliseconds: 10,000 by default (#210 Q15), short enough for the bridge's 25 s idle timer.
   * Configurable so a test can run the bridge's compressed profile (#215 Q10, #217 Q2).
   */
  heartbeatMilliseconds: number;

  /** The host the controller listens on; a loopback address in tests. */
  host: string;

  /** The identity provider's issuer, exactly as its discovery document and tokens carry it: https, or http to a loopback host only. */
  identityProviderIssuer: string;

  /** This instance's name, the `instance` every event it emits carries (#214 Q17); unique among the deployment's instances. */
  instanceName: string;

  /** The controller's own issuer: every Usher token's `iss`. */
  issuer: string;

  /**
   * The key-encryption key encrypting every stored application key, shared by every instance:
   * 32 bytes as 43 base64url characters in canonical form, an application key's format. Whitespace
   * around it is ignored. A missing or malformed one refuses the start, and so does one failing the
   * check value recorded in the database at the first start; each refusal names the variable and
   * never its value.
   */
  keyEncryptionKey: string;

  /**
   * Where the controller writes its structured log lines: the process's standard output by default.
   * Set only through the configuration, never from the environment, so a test can read what is
   * logged.
   */
  logStream: Writable;

  /** The `aud` a management token must name: the Policy Management API's identifier at the identity provider. */
  managementAudience: string;

  /** The clients a management token's `azp` may name: the management screens' client identifiers. */
  managementClients: readonly string[];

  /** The most notices one poll answer carries before it names a next page: 500 by default (#210 Q13). */
  noticePageLimit: number;

  /**
   * How often each instance reads the notice stream again when no wake-up has arrived through the
   * cache, in milliseconds: 2,000 by default (#210 Q14), so a lost wake-up costs at most that.
   */
  noticeRereadMilliseconds: number;

  /** The access level a resource registered naming none takes: `registered` by default (#211). */
  platformDefaultAccessLevel: 'grant' | 'open' | 'registered';

  /** The port the controller listens on; 0 asks for any free port. */
  port: number;

  /** The grace period, in seconds, that the notice retention floor counts beyond the token lifetime. */
  retentionGraceSeconds: number;

  /** The margin, in seconds, that the notice retention floor adds beyond the token lifetime and the grace period. */
  retentionMarginSeconds: number;

  /** The longest an administrator's self-grant may last, in seconds: 86,400 by default (#212). */
  selfGrantMaximumSeconds: number;

  /**
   * The longest lifetime, in seconds, of a sign-in token the deployment accepts: how long a relayed
   * sign-out naming a subject alone is kept (R7).
   */
  signInTokenMaximumLifetimeSeconds: number;

  /** The record actions the signed-in rule confers on every signed-in principal; count, view and export by default. */
  signedInRule: readonly RecordAction[];

  /**
   * How long the controller waits on the store for one request before it answers it unavailable, in
   * milliseconds: half the bridge's poll deadline D, 5,000 by default against the bridge's 10 s
   * (#210 Q13), so a poll waiting on a stalled store is answered 503 within the bridge's deadline.
   */
  storeTimeoutMilliseconds: number;

  /** The push streams one audience may hold open on one instance; 64 by default, a stream past it answered 503 and logged. */
  streamLimitPerAudience: number;

  /**
   * The longest a notice stream stays open, in seconds, before the controller ends it. A value below
   * {@link STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS} is refused.
   */
  streamMaximumLifetimeSeconds: number;

  /** The notices queued for one stream before the controller closes a stream whose reader has stopped reading; 1,000 by default. */
  streamQueueLimit: number;

  /** The category a submitter grant names, as the payload names it: `global.unmarked` by default (#212 Q6). */
  submitterCategory: string;

  /** How long an Usher token lives, in seconds; 300 by default. */
  tokenLifetimeSeconds: number;

  /** The addresses whose `X-Forwarded-For` the controller believes when it records `sourceIp` (#214 Q15); none by default. */
  trustedProxies: readonly string[];
}

/** A plain record of environment variables, as `process.env` holds them. */
export type ControllerEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * The config module's export: reads a configuration from an environment, or throws a refusal whose
 * message names the rule broken and never the value.
 */
export type ReadConfiguration = (
  environment: ControllerEnvironment,
) => ControllerConfiguration;

/** A controller as the app creates it, not yet listening. */
export interface Controller {
  /** Starts listening, resolving to the URL the controller answers at. */
  start(): Promise<{ url: URL }>;

  /** Stops the controller, settling only once its work has ended, and also when it never started. */
  stop(): Promise<void>;
}

/** The app's export: creates a controller from its configuration. */
export type CreateController = (
  configuration: ControllerConfiguration,
) => Controller;

/** What the migrations are told: the in-process form of the deployment command's arguments. */
export interface MigrationOptions {
  /** A connection URL under the migration role, which owns the database and the schema. */
  databaseUrl: string;

  /**
   * The notice retention floor in seconds, the token lifetime plus the grace period and the margin,
   * which the migrations store for the trimming function to read. The deployment sets it, so the
   * controller's own role can never lower it (R3).
   */
  retentionFloorSeconds: number;

  /** The controller's runtime role, created by the deployment, to which the migrations grant. */
  runtimeRole: string;

  /** The schema the tables live in. */
  schema: string;

  /** The last migration to apply; every migration when absent. */
  target?: string;
}

/**
 * The migrations module's export: applies migrations up to a target, all of them by default,
 * settling once its connections have closed.
 */
export type Migrate = (options: MigrationOptions) => Promise<void>;

/** A running controller, as a test holds it. */
export interface RunningController {
  /** Stops the controller, settling only once its work has ended. */
  stop(): Promise<void>;

  /** The URL the controller answers at. */
  url: URL;
}

/** How the controller's process ended, as {@link spawnController} saw it. */
export interface ControllerExit {
  /** Whether the process ever accepted a connection on the probed port while it ran. */
  acceptedConnection: boolean;

  /** The exit code, or `null` when a signal ended the process. */
  exitCode: number | null;

  /** The signal that ended the process, or `null` when it exited by itself. */
  signal: NodeJS.Signals | null;

  stderr: string;
  stdout: string;

  /** Whether the process outran its timeout and was killed. */
  timedOut: boolean;
}

/** What {@link spawnController} is told beyond the environment. */
export interface SpawnOptions {
  /** The host probed for a listener: the environment's host, or `127.0.0.1` when it names none. */
  host?: string;

  /** The port probed for a listener: the environment's port by default, which must then not be 0. */
  port?: number;

  /** How long the process may run before it is killed: 10 s by default. */
  timeoutMs?: number;
}

interface ControllerModule {
  /** The module's path from the app's root, which is also how a missing module is named. */
  path: string;
}

interface ControllerExport extends ControllerModule {
  exportName: string;
}

const CONTROLLER_MODULES = {
  app: { exportName: 'createController', path: 'src/app.ts' },
  configuration: {
    exportName: 'readConfiguration',
    path: 'src/configuration.ts',
  },
  main: { path: 'src/main.ts' },
  migrations: { exportName: 'migrate', path: 'src/migrations/index.ts' },
} as const satisfies Record<string, ControllerExport | ControllerModule>;

/** The least a stream's maximum lifetime may be configured to, in seconds; a lower one is refused. */
export const STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS = 60;

/** A configuration field the environment can set: every one but the clock and the log stream. */
export type FieldWithVariable = Exclude<
  keyof ControllerConfiguration,
  'clock' | 'logStream'
>;

const VARIABLE_NAMES: Readonly<Record<FieldWithVariable, string>> = {
  administratorRole: 'USHER_ADMINISTRATOR_ROLE',
  allowedCharactersExtra: 'USHER_ALLOWED_CHARACTERS_EXTRA',
  autoAccept: 'USHER_AUTO_ACCEPT',
  backChannelLogoutAudiences: 'USHER_BACK_CHANNEL_LOGOUT_AUDIENCES',
  baseline: 'USHER_BASELINE',
  cachePassword: 'USHER_CACHE_PASSWORD',
  cacheUrl: 'USHER_CACHE_URL',
  cursorKey: 'USHER_CURSOR_KEY',
  databasePassword: 'USHER_DATABASE_PASSWORD',
  databaseSchema: 'USHER_DATABASE_SCHEMA',
  databaseUrl: 'USHER_DATABASE_URL',
  directoryClientId: 'USHER_DIRECTORY_CLIENT_ID',
  directoryClientSecret: 'USHER_DIRECTORY_CLIENT_SECRET',
  directoryRealm: 'USHER_DIRECTORY_REALM',
  directoryUrl: 'USHER_DIRECTORY_URL',
  egoMigrationAllStudyPolicies: 'USHER_EGO_MIGRATION_ALL_STUDY_POLICIES',
  egoMigrationBaseTier: 'USHER_EGO_MIGRATION_BASE_TIER',
  egoMigrationPrefixes: 'USHER_EGO_MIGRATION_PREFIXES',
  eventSource: 'USHER_EVENT_SOURCE',
  grantRateThreshold: 'USHER_GRANT_RATE_THRESHOLD',
  heartbeatMilliseconds: 'USHER_HEARTBEAT_MILLISECONDS',
  host: 'USHER_HOST',
  identityProviderIssuer: 'USHER_IDENTITY_PROVIDER_ISSUER',
  instanceName: 'USHER_INSTANCE_NAME',
  issuer: 'USHER_ISSUER',
  keyEncryptionKey: 'USHER_KEY_ENCRYPTION_KEY',
  managementAudience: 'USHER_MANAGEMENT_AUDIENCE',
  managementClients: 'USHER_MANAGEMENT_CLIENTS',
  noticePageLimit: 'USHER_NOTICE_PAGE_LIMIT',
  noticeRereadMilliseconds: 'USHER_NOTICE_REREAD_MILLISECONDS',
  platformDefaultAccessLevel: 'USHER_PLATFORM_DEFAULT_ACCESS_LEVEL',
  port: 'USHER_PORT',
  retentionGraceSeconds: 'USHER_RETENTION_GRACE_SECONDS',
  retentionMarginSeconds: 'USHER_RETENTION_MARGIN_SECONDS',
  selfGrantMaximumSeconds: 'USHER_SELF_GRANT_MAXIMUM_SECONDS',
  signInTokenMaximumLifetimeSeconds:
    'USHER_SIGN_IN_TOKEN_MAXIMUM_LIFETIME_SECONDS',
  signedInRule: 'USHER_SIGNED_IN_RULE',
  storeTimeoutMilliseconds: 'USHER_STORE_TIMEOUT_MILLISECONDS',
  streamLimitPerAudience: 'USHER_STREAM_LIMIT_PER_AUDIENCE',
  streamMaximumLifetimeSeconds: 'USHER_STREAM_MAXIMUM_LIFETIME_SECONDS',
  streamQueueLimit: 'USHER_STREAM_QUEUE_LIMIT',
  submitterCategory: 'USHER_SUBMITTER_CATEGORY',
  tokenLifetimeSeconds: 'USHER_TOKEN_LIFETIME_SECONDS',
  trustedProxies: 'USHER_TRUSTED_PROXIES',
};

/**
 * The environment variable each configuration field travels in, by field: names only, so a test
 * names a variable through this map rather than spelling it. A refusal of the configuration names
 * the variable at fault and never its value.
 */
export const ENVIRONMENT_VARIABLES: Readonly<
  Record<FieldWithVariable, string>
> = Object.freeze({ ...VARIABLE_NAMES });

const APP_ROOT = new URL('../', import.meta.url);

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;

const PROBE_INTERVAL_MS = 25;

const LOOPBACK = '127.0.0.1';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const isPresent = (url: URL): Promise<boolean> =>
  access(url).then(
    () => true,
    () => false,
  );

const NOT_IMPLEMENTED = 'the Usher Controller is not implemented yet:';

const presentModule = async ({ path }: ControllerModule): Promise<URL> => {
  const url = new URL(path, APP_ROOT);
  if (await isPresent(url)) {
    return url;
  }
  throw new Error(`${NOT_IMPLEMENTED} ${path} is missing`);
};

// A missing module is the seam's to report, never a refusal by the controller.
const isSeamMessage = (thrown: unknown): boolean =>
  thrown instanceof Error && thrown.message.startsWith(NOT_IMPLEMENTED);

// The specifier is built at run time, so the type checker resolves nothing and this project
// typechecks before the controller exists.
const loadExport = async <Exported>(
  module: ControllerExport,
): Promise<Exported> => {
  const url = await presentModule(module);
  const loaded: unknown = await import(url.href);
  const exported = isRecord(loaded) ? loaded[module.exportName] : undefined;
  if (typeof exported === 'function') {
    return exported as Exported;
  }
  throw new Error(
    `the Usher Controller's ${module.path} exports no function ${module.exportName}: align test-support/controller.ts with the implementation`,
  );
};

/**
 * The environment the config module reads for a configuration: the one place the controller's
 * environment variable names live. Every field but `clock` and `logStream` has a variable; a list is
 * comma-separated, empty for an empty list; the EGO migration's prefixes and its all-study policies
 * are JSON lists, since a prefix list must tell an empty prefix from none and a policy's name may hold
 * a comma, and the grant rate threshold a JSON object; the EGO migration's base tier is empty for
 * none. The key-encryption key and each store's password travel as given, each in its own variable.
 *
 * @param configuration the configuration to express.
 */
export const environmentFor = ({
  administratorRole,
  allowedCharactersExtra,
  autoAccept,
  backChannelLogoutAudiences,
  baseline,
  cachePassword,
  cacheUrl,
  cursorKey,
  databasePassword,
  databaseSchema,
  databaseUrl,
  directoryClientId,
  directoryClientSecret,
  directoryRealm,
  directoryUrl,
  egoMigrationAllStudyPolicies,
  egoMigrationBaseTier,
  egoMigrationPrefixes,
  eventSource,
  grantRateThreshold,
  heartbeatMilliseconds,
  host,
  identityProviderIssuer,
  instanceName,
  issuer,
  keyEncryptionKey,
  managementAudience,
  managementClients,
  noticePageLimit,
  noticeRereadMilliseconds,
  platformDefaultAccessLevel,
  port,
  retentionGraceSeconds,
  retentionMarginSeconds,
  selfGrantMaximumSeconds,
  signInTokenMaximumLifetimeSeconds,
  signedInRule,
  storeTimeoutMilliseconds,
  streamLimitPerAudience,
  streamMaximumLifetimeSeconds,
  streamQueueLimit,
  submitterCategory,
  tokenLifetimeSeconds,
  trustedProxies,
}: ControllerConfiguration): Readonly<Record<string, string>> => ({
  [VARIABLE_NAMES.administratorRole]: administratorRole,
  [VARIABLE_NAMES.allowedCharactersExtra]: allowedCharactersExtra,
  [VARIABLE_NAMES.autoAccept]: String(autoAccept),
  [VARIABLE_NAMES.backChannelLogoutAudiences]:
    backChannelLogoutAudiences.join(','),
  [VARIABLE_NAMES.baseline]: baseline.join(','),
  [VARIABLE_NAMES.cachePassword]: cachePassword,
  [VARIABLE_NAMES.cacheUrl]: cacheUrl,
  [VARIABLE_NAMES.cursorKey]: cursorKey,
  [VARIABLE_NAMES.databasePassword]: databasePassword,
  [VARIABLE_NAMES.databaseSchema]: databaseSchema,
  [VARIABLE_NAMES.databaseUrl]: databaseUrl,
  [VARIABLE_NAMES.directoryClientId]: directoryClientId,
  [VARIABLE_NAMES.directoryClientSecret]: directoryClientSecret,
  [VARIABLE_NAMES.directoryRealm]: directoryRealm,
  [VARIABLE_NAMES.directoryUrl]: directoryUrl,
  [VARIABLE_NAMES.egoMigrationAllStudyPolicies]: JSON.stringify(
    egoMigrationAllStudyPolicies,
  ),
  [VARIABLE_NAMES.egoMigrationBaseTier]: egoMigrationBaseTier ?? '',
  [VARIABLE_NAMES.egoMigrationPrefixes]: JSON.stringify(egoMigrationPrefixes),
  [VARIABLE_NAMES.eventSource]: eventSource,
  [VARIABLE_NAMES.grantRateThreshold]: JSON.stringify({
    operationCount: grantRateThreshold.operationCount,
    windowSeconds: grantRateThreshold.windowSeconds,
  }),
  [VARIABLE_NAMES.heartbeatMilliseconds]: String(heartbeatMilliseconds),
  [VARIABLE_NAMES.host]: host,
  [VARIABLE_NAMES.identityProviderIssuer]: identityProviderIssuer,
  [VARIABLE_NAMES.instanceName]: instanceName,
  [VARIABLE_NAMES.issuer]: issuer,
  [VARIABLE_NAMES.keyEncryptionKey]: keyEncryptionKey,
  [VARIABLE_NAMES.managementAudience]: managementAudience,
  [VARIABLE_NAMES.managementClients]: managementClients.join(','),
  [VARIABLE_NAMES.noticePageLimit]: String(noticePageLimit),
  [VARIABLE_NAMES.noticeRereadMilliseconds]: String(noticeRereadMilliseconds),
  [VARIABLE_NAMES.platformDefaultAccessLevel]: platformDefaultAccessLevel,
  [VARIABLE_NAMES.port]: String(port),
  [VARIABLE_NAMES.retentionGraceSeconds]: String(retentionGraceSeconds),
  [VARIABLE_NAMES.retentionMarginSeconds]: String(retentionMarginSeconds),
  [VARIABLE_NAMES.selfGrantMaximumSeconds]: String(selfGrantMaximumSeconds),
  [VARIABLE_NAMES.signInTokenMaximumLifetimeSeconds]: String(
    signInTokenMaximumLifetimeSeconds,
  ),
  [VARIABLE_NAMES.signedInRule]: signedInRule.join(','),
  [VARIABLE_NAMES.storeTimeoutMilliseconds]: String(storeTimeoutMilliseconds),
  [VARIABLE_NAMES.streamLimitPerAudience]: String(streamLimitPerAudience),
  [VARIABLE_NAMES.streamMaximumLifetimeSeconds]: String(
    streamMaximumLifetimeSeconds,
  ),
  [VARIABLE_NAMES.streamQueueLimit]: String(streamQueueLimit),
  [VARIABLE_NAMES.submitterCategory]: submitterCategory,
  [VARIABLE_NAMES.tokenLifetimeSeconds]: String(tokenLifetimeSeconds),
  [VARIABLE_NAMES.trustedProxies]: trustedProxies.join(','),
});

/**
 * Reads a configuration through the app's config module. The clock of the configuration it returns
 * is the controller's own; a test needing a known now replaces it.
 *
 * @param environment the environment variables, such as {@link environmentFor} gives.
 * @throws the config module's refusal, naming the rule broken; or, until the module exists, the
 *   seam's message that it is missing.
 */
export const readConfiguration = async (
  environment: ControllerEnvironment,
): Promise<ControllerConfiguration> => {
  const read = await loadExport<ReadConfiguration>(
    CONTROLLER_MODULES.configuration,
  );
  return read(environment);
};

/**
 * Creates and starts a controller. A start that rejects is followed by `stop`, so a refused start
 * leaves nothing running.
 *
 * @param configuration the controller's configuration.
 * @returns the URL the controller answers at, and a `stop` settling once its work has ended.
 */
export const startController = async (
  configuration: ControllerConfiguration,
): Promise<RunningController> => {
  const create = await loadExport<CreateController>(CONTROLLER_MODULES.app);
  const controller = create(configuration);
  try {
    const { url } = await controller.start();
    return { stop: () => controller.stop(), url };
  } catch (startError) {
    await controller.stop().catch((stopError: unknown) => {
      throw new AggregateError(
        [startError, stopError],
        'the controller refused to start, and its stop failed too',
      );
    });
    throw startError;
  }
};

/**
 * Applies the controller's migrations up to a target, all of them by default: the in-process form
 * of the deployment command.
 *
 * @param options the migration role's connection URL, the runtime role, the schema and the target.
 */
export const migrate = async (options: MigrationOptions): Promise<void> => {
  const apply = await loadExport<Migrate>(CONTROLLER_MODULES.migrations);
  await apply(options);
};

const isPort = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value < 65_536;

const definedVariables = (
  environment: ControllerEnvironment,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );

const acceptsConnection = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });

const acceptedWhile = async (
  running: () => boolean,
  host: string,
  port: number,
): Promise<boolean> => {
  if (running()) {
    const accepted = await acceptsConnection(host, port);
    return (
      accepted ||
      delay(PROBE_INTERVAL_MS).then(() => acceptedWhile(running, host, port))
    );
  }
  return false;
};

const runEntry = async (
  entry: URL,
  environment: ControllerEnvironment,
  { host, port, timeoutMs }: Required<SpawnOptions>,
): Promise<ControllerExit> => {
  const output: { stderr: Buffer[]; stdout: Buffer[] } = {
    stderr: [],
    stdout: [],
  };
  const state = { running: true, timedOut: false };
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), fileURLToPath(entry)],
    {
      cwd: fileURLToPath(APP_ROOT),
      env: definedVariables(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (chunk: Buffer) => output.stderr.push(chunk));
  child.stdout.on('data', (chunk: Buffer) => output.stdout.push(chunk));
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const ended = new Promise<Pick<ControllerExit, 'exitCode' | 'signal'>>(
    (resolve, reject) => {
      child.once('error', (error) => {
        state.running = false;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        state.running = false;
        clearTimeout(timer);
        resolve({ exitCode, signal });
      });
    },
  );
  const [{ exitCode, signal }, acceptedConnection] = await Promise.all([
    ended,
    acceptedWhile(() => state.running, host, port),
  ]);
  return {
    acceptedConnection,
    exitCode,
    signal,
    stderr: Buffer.concat(output.stderr).toString('utf8'),
    stdout: Buffer.concat(output.stdout).toString('utf8'),
    timedOut: state.timedOut,
  };
};

/**
 * Runs the app's process entry, `src/main.ts`, through tsx as a child process given exactly the
 * environment passed, nothing inherited: tsx and Node need no variable of their own to run it. While
 * it runs, the port it was given is probed for a listener every 25 ms, so a listener that comes and
 * goes between two probes can be missed. A process still running at the timeout is killed.
 *
 * @param environment the environment variables, such as {@link environmentFor} gives; its port is
 *   the one probed unless the options name another.
 * @param options the host and port probed, and the timeout.
 * @returns the exit code or signal, the output, whether the port ever accepted a connection, and
 *   whether the timeout ended the process.
 * @throws the seam's message while `src/main.ts` is missing; a `RangeError` when no port other
 *   than 0 is given to probe.
 */
export const spawnController = async (
  environment: ControllerEnvironment,
  { host, port, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS }: SpawnOptions = {},
): Promise<ControllerExit> => {
  const entry = await presentModule(CONTROLLER_MODULES.main);
  const probedPort = port ?? Number(environment[VARIABLE_NAMES.port]);
  if (isPort(probedPort)) {
    return runEntry(entry, environment, {
      host: host ?? environment[VARIABLE_NAMES.host] ?? LOOPBACK,
      port: probedPort,
      timeoutMs,
    });
  }
  throw new RangeError(
    'spawnController probes a port other than 0: give one in the environment or in its options',
  );
};

/**
 * A port nothing listens on at the moment of asking, for a configuration handed to
 * {@link spawnController}. Another process could take it first, which a loopback run makes unlikely.
 *
 * @param host the address to ask on: `127.0.0.1` by default.
 */
export const unusedPort = (host: string = LOOPBACK): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/**
 * The names of the environment variables whose values differ between two environments, sorted: how
 * a test finds the variable a configuration field travels in without spelling it.
 *
 * @param from one environment.
 * @param to the other.
 */
export const changedVariables = (
  from: ControllerEnvironment,
  to: ControllerEnvironment,
): readonly string[] =>
  [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .filter((name) => from[name] !== to[name])
    .toSorted();

/**
 * What reading a configuration from an environment threw: the refusal a test examines. The seam's
 * own message, while the config module is missing, is thrown on rather than taken for a refusal.
 *
 * @param environment the environment refused.
 * @throws when the configuration is read without a refusal, and the seam's message while the config
 *   module is missing.
 */
export const readRefusal = async (
  environment: ControllerEnvironment,
): Promise<unknown> => {
  const outcome = await readConfiguration(environment).then(
    () => ({ kind: 'read' }) as const,
    (refusal: unknown) => ({ kind: 'refused', refusal }) as const,
  );
  if (outcome.kind === 'refused' && !isSeamMessage(outcome.refusal)) {
    return outcome.refusal;
  }
  if (outcome.kind === 'refused') {
    throw outcome.refusal;
  }
  throw new Error('the configuration was read, where a refusal was expected');
};

/**
 * Everything a refusal shows a reader: its message, its stack, its own members serialized and its
 * cause, for a test searching it for what it must never name, such as a key.
 *
 * @param refusal what a start or a configuration threw.
 */
export const refusalText = (refusal: unknown): string =>
  refusal instanceof Error
    ? [
        refusal.message,
        String(refusal.stack),
        JSON.stringify(refusal, Object.getOwnPropertyNames(refusal)),
        String(refusal.cause),
      ].join('\n')
    : String(refusal);

/** What the controller wrote to a log stream a test gave it. */
export interface LogCapture {
  /** Each line written so far, in order, empty lines left out. */
  lines(): readonly string[];

  /** The stream to configure as `logStream`. */
  stream: Writable;
}

/** A writable stream recording every line written to it, to configure as the controller's `logStream`. */
export const captureLog = (): LogCapture => {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: unknown, _encoding, callback) => {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0),
    stream,
  };
};

/** How a start ended, as a refusal test reads it. */
export type StartOutcome =
  { kind: 'refused'; refusal: unknown } | { kind: 'started' };

/**
 * Starts a controller and stops it at once, or gives the start's refusal. The seam's own message,
 * while the app module is missing, is thrown on rather than taken for a refusal.
 *
 * @param configuration the configuration to start with.
 */
export const startOutcome = async (
  configuration: ControllerConfiguration,
): Promise<StartOutcome> => {
  try {
    const running = await startController(configuration);
    await running.stop();
    return { kind: 'started' };
  } catch (refusal) {
    if (isSeamMessage(refusal)) {
      throw refusal;
    }
    return { kind: 'refused', refusal };
  }
};
