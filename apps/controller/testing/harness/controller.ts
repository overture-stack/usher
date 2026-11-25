import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { MigrationOptions as CommandMigrationOptions, SeedFile } from '../../src/migrations/index.js';
import type { RecordAction } from '@overture-stack/usher-types';
import type { GrantRuleAction, GrantRateThreshold, GrantRules, Settings } from '../../src/settings/index.js';

import type { AuditEventType, Severity } from './auditEvents.js';
import { type BuiltEntry, builtEntry } from './build.js';
import { type Actor, inTurn } from './policy.js';

/** A source of the current time, in milliseconds since the Unix epoch. */
export interface Clock {
	now(): number;
}

/**
 * An application's id and one of its keys, as given to its Bridge by the key's issue. The
 * Controller's configuration names no application; the database is the only list of them.
 */
export interface ControllerApplication {
	/** The application's audience identifier: its `applications.id`, a generated uuid, and every Usher token's `aud` for it, verbatim. */
	id: string;

	/** An application key: 32 bytes as 43 base64url characters in canonical form. */
	key: string;
}

/**
 * The settings the Controller reads, as the harness gives them: each field but the clock, the log
 * stream and the {@link StoredField}s travels in an environment variable of its own, written by
 * {@link environmentFor}, and the config module reads it from there. A stored field is written to the
 * store instead, by {@link storedSettingsOf}, and the Controller reads it from there at its start. A
 * default named below is the Controller's when the environment leaves that variable unset.
 */
export interface ControllerSettings {
	/**
	 * The client used by the API documentation page at `/api-docs` to sign people in, which must be one
	 * of the management clients exactly: any other refuses the start. Empty, the default, for no page,
	 * every path under `/api-docs` then answered as an unknown path is.
	 */
	apiDocsClient: string;

	/**
	 * Whether a grant is accepted at creation without its holder answering it (auto-accept): its
	 * holder's acceptance, showing what the grant's role carries then, is recorded with it. Off by
	 * default.
	 */
	autoAccept: boolean;

	/** The `aud` values a back-channel logout token may carry: the platform's client identifiers. */
	backChannelLogoutAudiences: readonly string[];

	/**
	 * The actions the grant rules confer on open resources for everyone, anonymous visitors included, and
	 * for signed-in principals too; count, view and export by default. Stored as the grant rules.
	 */
	baseline: readonly RecordAction[];

	/**
	 * The Controller's wall clock. Set only through the configuration, never from the environment,
	 * so a test can fix now. Every duration the Controller measures runs on it, the signing-key
	 * cache's maximum age (10 min) and refetch cooldown (30 s) included (`.dev/design/decisions.md`
	 * § The Controller's clock is configuration, and every duration it measures runs on it), so a
	 * test moves past either by advancing this clock.
	 */
	clock: Clock;

	/** The key cursors are encrypted under, shared by every instance: 43 base64url characters, as an application key is. */
	cursorKey: string;

	/**
	 * Whether a database connection that does not verify the server it reaches is allowed: off by
	 * default, and never on in the harness but in this setting's own tests. Off, a connection leaving
	 * the host must set `sslmode=verify-full`, or `sslmode=verify-ca` with `sslrootcert`; on, every
	 * start of the Controller or the schema migration command writes one line at warning naming its
	 * variable.
	 */
	databaseAllowUnverifiedConnection: boolean;

	/**
	 * The store connections each instance holds for everything but the token exchange and readiness: 5
	 * by default, a whole number of at least 1.
	 */
	databaseControlConnections: number;

	/**
	 * The store connections each instance holds for the token exchange, which each application's
	 * admission share divides: 10 by default, a whole number of at least 1.
	 */
	databaseExchangeConnections: number;

	/**
	 * The runtime role's PostgreSQL password, in a variable of its own: a missing one refuses the start,
	 * naming the variable and never its value.
	 */
	databasePassword: string;

	/** The schema the Controller's tables live in. */
	databaseSchema: string;

	/**
	 * A connection URL under the Controller's runtime role, carrying no password: one carrying a
	 * password refuses the start.
	 */
	databaseUrl: string;

	/**
	 * The client whose service account the controller's directory signs in as, through the client
	 * credentials grant (`docs/deployment.md` § The directory); read while `directoryUrl` names a
	 * directory, empty by default.
	 */
	directoryClientId: string;

	/**
	 * That client's secret, in a variable of its own, which no refusal, log line, event or answer
	 * ever shows; read while `directoryUrl` names a directory, empty by default.
	 */
	directoryClientSecret: string;

	/**
	 * The identity provider realm the directory looks people up in, whose token endpoint issues the
	 * directory's token; read while `directoryUrl` names a directory, empty by default.
	 */
	directoryRealm: string;

	/**
	 * The identity provider's base URL, whose admin API the directory reads
	 * (`<url>/admin/realms/<realm>`): https, or http to a loopback host. Empty, the default, for
	 * none, which answers every operation naming a person by address 503 `directoryNotConfigured`. The
	 * controller starts whatever the directory answers, a refused credential included.
	 */
	directoryUrl: string;

	/**
	 * The CloudEvents `source` every event carries: one per deployment, the same on every instance
	 * (`.dev/design/audit-events.md` § The envelope).
	 */
	eventSource: string;

	/**
	 * The identity provider realm role naming its holder the first user, who nominates Usher's first
	 * administrator while none has accepted: `usher-first-user` by default. A start with
	 * `USHER_ADMINISTRATOR_ROLE` set is refused, naming this setting's variable as its replacement.
	 */
	firstUserRole: string;

	/**
	 * When `grant.rateExceeded` fires: more grant operations by one actor than `operationCount`
	 * within `windowSeconds` (`docs/deployment.md` § Settings). A setting the store holds, written
	 * to it by {@link storedSettingsOf}.
	 */
	grantRateThreshold: GrantRateThreshold;

	/**
	 * How long an open notice stream may stay silent before the Controller writes a heartbeat
	 * comment, in milliseconds: 10,000 by default (`docs/deployment.md` § Settings), short enough
	 * for the Bridge's 25 s idle timer. Configurable so a test can run the Bridge's compressed
	 * profile (`docs/deployment.md` § Settings).
	 */
	heartbeatMilliseconds: number;

	/** The host the Controller listens on; a loopback address in tests. */
	host: string;

	/** The identity provider's issuer, exactly as its discovery document and tokens carry it: https, or http to a loopback host only. */
	identityProviderIssuer: string;

	/**
	 * This instance's name, the `instance` every event it emits carries (`docs/deployment.md`
	 * § This instance and its events); unique among the deployment's instances.
	 */
	instanceName: string;

	/** The Controller's own issuer: every Usher token's `iss`. */
	issuer: string;

	/**
	 * The key-encryption key encrypting every stored application key, shared by every instance:
	 * 32 bytes as 43 base64url characters in canonical form, an application key's format. Whitespace
	 * around it is ignored. A missing or malformed one refuses the start, and so does one not matching
	 * the fingerprint, the key's one-way identifier, recorded in the database at the first start; each
	 * refusal names the variable and never its value.
	 */
	keyEncryptionKey: string;

	/**
	 * Where the Controller writes its structured log lines: the process's standard output by default.
	 * Set only through the configuration, never from the environment, so a test can read what is
	 * logged.
	 */
	logStream: Writable;

	/** The `aud` a management token must name: the Policy Management API's identifier at the identity provider. */
	managementAudience: string;

	/** The clients a management token's `azp` may name: the management screens' client identifiers. */
	managementClients: readonly string[];

	/**
	 * The most notices one poll answer carries before it names a next page: 500 by default
	 * (`docs/deployment.md` § Settings).
	 */
	noticePageLimit: number;

	/**
	 * How often each instance reads the notice stream again when no wake-up has arrived through the
	 * cache, in milliseconds: 2,000 by default (`docs/deployment.md` § Settings), so a lost wake-up
	 * costs at most that.
	 */
	noticeRereadMilliseconds: number;

	/** The port the Controller listens on; 0 asks for any free port. */
	port: number;

	/** The grace period, in seconds, that the notice retention floor counts beyond the token lifetime. */
	retentionGraceSeconds: number;

	/** The margin, in seconds, that the notice retention floor adds beyond the token lifetime and the grace period. */
	retentionMarginSeconds: number;

	/**
	 * The longest a self-grant may last, in seconds, from the instant it is asked for: 86,400 by
	 * default (`docs/deployment.md` § Settings). An owner's self-grant and a platform
	 * administrator's request are held to it, and so is a change to a self-grant's end. A setting
	 * the store holds, written to it by {@link storedSettingsOf}.
	 */
	selfGrantMaximumLifetimeSeconds: number;

	/** The identity provider realm role marking its holder's token as a service account's; a role other than the administrator role, `usher-service-account` by default. */
	serviceAccountRole: string;

	/**
	 * The longest lifetime, in seconds, of a sign-in token the deployment accepts: how long a relayed
	 * sign-out naming a subject alone is kept (`docs/deployment.md` § Sign-outs).
	 */
	signInTokenMaximumLifetimeSeconds: number;

	/**
	 * The actions the grant rules confer on registered resources for every signed-in principal; count, view
	 * and export by default. Stored as the grant rules.
	 */
	signedInRule: readonly RecordAction[];

	/**
	 * How long the Controller waits on the store for one request before it answers it unavailable,
	 * in milliseconds: half the Bridge's poll deadline D, 5,000 by default against the Bridge's
	 * 10 s (`docs/deployment.md` § The database), so a poll waiting on a stalled store is answered
	 * 503 within the Bridge's deadline.
	 */
	storeTimeoutMilliseconds: number;

	/** The push streams one audience may hold open on one instance; 64 by default, a stream past it answered 503 and logged. */
	streamLimitPerAudience: number;

	/**
	 * The longest a notice stream stays open, in seconds, before the Controller ends it. A value below
	 * {@link STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS} is refused.
	 */
	streamMaximumLifetimeSeconds: number;

	/** The notices queued for one stream before the Controller closes a stream whose reader has stopped reading; 1,000 by default. */
	streamQueueLimit: number;

	/**
	 * The category a submitter grant naming none takes, as the payload names it: `global.unmarked`
	 * by default (the contract's `createGrant`).
	 */
	submitterCategory: string;

	/** How long an Usher token lives, in seconds; 300 by default. */
	tokenLifetimeSeconds: number;

	/**
	 * The addresses and CIDR ranges whose `X-Forwarded-For` the Controller believes when it records
	 * `sourceIp` (`docs/deployment.md` § Listening); none by default.
	 */
	trustedProxies: readonly string[];
}

/**
 * The settings the design names that the Controller does not read yet. The harness holds them so the
 * fixtures and tests written against the design keep their values, and puts none of them in the
 * Controller's environment: {@link environmentFor} writes no variable for them, since the Controller
 * reads a setting only once code uses it. Each moves to {@link ControllerSettings}, with its variable,
 * in the unit whose code reads it.
 */
export interface PendingSettings {
	/**
	 * The characters an instance adds to the default set an externalId may hold (ASCII letters,
	 * digits, dot, underscore and hyphen, `docs/deployment.md` § Registering resources); none by
	 * default. Letters beyond ASCII are compared by Unicode case folding after NFC.
	 */
	allowedCharactersExtra: string;

	/**
	 * The cache's (Valkey) password, in a variable of its own: a missing one refuses the start, naming
	 * the variable and never its value.
	 */
	cachePassword: string;

	/** The cache's (Valkey) URL, carrying no password: one carrying a password refuses the start. */
	cacheUrl: string;

	/**
	 * The EGO policies granting every study, by name, matched as literal text (ruled, the
	 * contract's planned `importFromEgo`): `ENVIRONMENTAL` in iMS. None by default. A run reads no
	 * study from such a policy and writes its holders no grant; it lists each holding in the
	 * report's `allStudyAccess`, for the administrator to decide each person deliberately.
	 */
	egoImportAllStudyPolicies: readonly string[];

	/**
	 * The base tier of each resource the EGO import registers (the contract's planned
	 * `importFromEgo`); `null`, none, by default, and an import run while none is configured is
	 * refused before it reads its export.
	 */
	egoImportBaseTier: 'grant' | 'open' | 'registered' | null;

	/**
	 * The prefixes the EGO import reads a study id after in a policy's name, matched as literal
	 * text in their configured letter case (the contract's planned `importFromEgo`): `PX-` and
	 * `PX-FILES-` in iMS. None by default, and a import run while none is configured answers 503
	 * `importNotConfigured` before it reads its export; an empty prefix, or one listed twice,
	 * refuses the Controller's start, naming this field's variable (ruled, the contract's planned
	 * `importFromEgo`).
	 */
	egoImportPrefixes: readonly string[];
}

/** The Controller's configuration as the harness holds it: the settings the Controller reads, and those it does not read yet. */
export interface ControllerConfiguration extends ControllerSettings, PendingSettings {}

/** A plain record of environment variables, as `process.env` holds them. */
export type ControllerEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The config module's export: reads a configuration from an environment, or throws a refusal whose
 * message names the rule broken and never the value.
 */
export type ReadConfiguration = (environment: ControllerEnvironment) => ControllerConfiguration;

/** A Controller as the app creates it, not yet listening. */
export interface Controller {
	/** Starts listening, resolving to the URL the Controller answers at. */
	start(): Promise<{ url: URL }>;

	/** Stops the Controller, settling only once its work has ended, and also when it never started. */
	stop(): Promise<void>;
}

/** The app's export: creates a Controller from its configuration. */
export type CreateController = (configuration: ControllerConfiguration) => Controller;

/**
 * What the migrations are told: the in-process form of the deployment command's arguments, and a
 * target, which the command never takes.
 */
export interface MigrationOptions {
	/** A connection URL under the migration role, which owns the database and the schema. */
	databaseUrl: string;

	/**
	 * Every setting a first run seeds, as the seed file gives them: the test's own values, and the
	 * defaults the template gives the rest.
	 */
	settings: Settings;

	/** The Controller's runtime role, created by the deployment, to which the migrations grant. */
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
export type Migrate = (options: CommandMigrationOptions) => Promise<void>;

/**
 * The settings the policy a Controller's start seeds is written under: the schema, and the clock its
 * recording time is read from. The grant rules are not among them: the store holds them as a setting.
 */
export interface SeededPolicySettings {
	clock: Clock;
	databaseSchema: string;
}

/** A connection the seeded policy is written on, such as a `pg.Client` under the migration role. */
export interface SeedingConnection {
	query(text: string, values?: unknown[]): Promise<{ command: string }>;
}

// One of the Controller's audit trail's transactions, as far as writing the seeded policy uses it.
interface SeedingTransaction {
	connection: unknown;
	record(event: unknown): Promise<string>;
}

/**
 * The store module's export writing the policy a start seeds, in a transaction the audit trail holds:
 * the capability vocabulary and the seeded roles a store lacks.
 */
export type WriteSeededPolicy = (transaction: SeedingTransaction, settings: SeededPolicySettings) => Promise<void>;

/**
 * One connection the audit trail runs a transaction on, released once the transaction ends. It must
 * run a text of several statements given without values as one query, its statements in order.
 */
export interface TrailConnection {
	/**
	 * Runs a statement, or a text of several given without values, resolving, for a single statement,
	 * to the command the store answered it with, such as `COMMIT`.
	 */
	query(text: string, values?: readonly unknown[]): Promise<{ command: string }>;

	/** Returns the connection to its pool, or discards it when `destroy` is true. */
	release(destroy?: boolean): void;
}

/** One audit event as a transaction records it, its type without the `bio.overture.` prefix. */
export interface AuditEvent {
	/** The event's own members. */
	data: Readonly<Record<string, string>>;

	severity: Severity;
	type: AuditEventType;
}

/** An event's envelope as its line carries it, as far as a test reads it: the event's unique id. */
export interface EventEnvelope {
	id: string;
}

/** A transaction in progress, its actor declared. */
export interface AuditTransaction<Connection> {
	/** The transaction's connection, for the change's own statements. */
	connection: Connection;

	/** Writes an event's row in the transaction, resolving to the event's id once it is written. */
	record(event: AuditEvent): Promise<string>;
}

/**
 * How one transaction is run, where it differs from the default: its own timeout, in milliseconds,
 * which both limits the store applies to a session are set to inside the transaction alone, and the
 * event recorded in the work's place when the work fails.
 */
export interface TransactionOptions {
	failureEvent?: AuditEvent;
	timeoutMilliseconds?: number;
}

/** The Controller's audit trail, as far as a test runs a transaction through it. */
export interface AuditTrail<Connection> {
	/**
	 * Runs work in one transaction declaring its actor, committing the rows of the events the work
	 * records with its change and writing their lines once it has committed.
	 */
	inTransaction<Result>(
		actor: Actor,
		work: (transaction: AuditTransaction<Connection>) => Promise<Result>,
		options?: TransactionOptions,
	): Promise<Result>;
}

/** What the Controller's audit trail is created from, as far as a test gives it. */
export interface AuditTrailOptions<Connection extends TrailConnection> {
	/** Where each committed event's line is written, and the line naming an event whose row was not. */
	eventLog: { error(): void; writeEvent(envelope: EventEnvelope): void };

	/**
	 * The clock events' times are read from, the store's schema, the event source, the instance's name,
	 * and the store timeout each transaction runs within.
	 */
	settings: Pick<SeededPolicySettings, 'clock' | 'databaseSchema'> & {
		eventSource: string;
		instanceName: string;
		storeTimeoutMilliseconds: number;
	};

	/** Where each transaction's connection is taken from. */
	store: { connect(): Promise<Connection> };
}

/** A running Controller, as a test holds it. */
export interface RunningController {
	/** Stops the Controller, settling only once its work has ended. */
	stop(): Promise<void>;

	/** The URL the Controller answers at. */
	url: URL;
}

/** How the Controller's process ended, as {@link spawnController} saw it. */
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

/** How a run of the schema migration command ended, as {@link spawnSchemaMigrationCommand} saw it. */
export type CommandExit = Omit<ControllerExit, 'acceptedConnection'>;

/** What {@link spawnController} is told beyond the environment. */
export interface SpawnOptions {
	/** A built entry, such as `dist/main.js`, run under Node alone in place of the app's process entry `src/main.ts`. */
	builtEntry?: URL;

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

// Selects each workspace package's source through its `@overture-stack/source` export condition, as
// the test runner's own `--conditions` does.
const SOURCE_CONDITION = '--conditions=@overture-stack/source';

const CONTROLLER_MODULES = {
	app: { exportName: 'createController', path: 'src/app/index.ts' },
	applicationKeyCipher: { exportName: 'createApplicationKeyCipher', path: 'src/applications/index.ts' },
	auditTrail: { exportName: 'createAuditTrail', path: 'src/eventLog/index.ts' },
	configuration: {
		exportName: 'readConfiguration',
		path: 'src/configuration/index.ts',
	},
	insertApplication: { exportName: 'insertApplication', path: 'src/applications/index.ts' },
	insertKey: { exportName: 'insertKey', path: 'src/applications/index.ts' },
	main: { path: 'src/main.ts' },
	migrations: { exportName: 'migrate', path: 'src/migrations/index.ts' },
	seededPolicy: { exportName: 'writeSeededPolicy', path: 'src/store/index.ts' },
} as const satisfies Record<string, ControllerExport | ControllerModule>;

/** The least a stream's maximum lifetime may be configured to, in seconds; a lower one is refused. */
export const STREAM_MAXIMUM_LIFETIME_FLOOR_SECONDS = 60;

/**
 * A setting the Controller reads from the store rather than its environment: the harness writes it there
 * as the schema's owner, from {@link storedSettingsOf}, before the Controller starts. `baseline` and
 * `signedInRule` are the actions of the grant rules, which the store holds as one setting.
 */
export type StoredField =
	| 'autoAccept'
	| 'baseline'
	| 'eventSource'
	| 'firstUserRole'
	| 'grantRateThreshold'
	| 'heartbeatMilliseconds'
	| 'issuer'
	| 'noticePageLimit'
	| 'noticeRereadMilliseconds'
	| 'retentionGraceSeconds'
	| 'retentionMarginSeconds'
	| 'selfGrantMaximumLifetimeSeconds'
	| 'signInTokenMaximumLifetimeSeconds'
	| 'signedInRule'
	| 'streamLimitPerAudience'
	| 'streamMaximumLifetimeSeconds'
	| 'streamQueueLimit'
	| 'submitterCategory'
	| 'tokenLifetimeSeconds';

/**
 * A setting the Controller reads from an environment variable of its own: every one but the clock, the log
 * stream and the {@link StoredField}s.
 */
export type FieldWithVariable = Exclude<keyof ControllerSettings, 'clock' | 'logStream' | StoredField>;

// The grant rules confer only count, view and export, so a harness action of another kind is refused here rather than
// stored as a rule that cannot hold it.
const grantActionOf = (action: RecordAction): GrantRuleAction => {
	if (action === 'count' || action === 'export' || action === 'view') {
		return action;
	}
	throw new Error(`the grant rules confer count, view and export, not `);
};

/**
 * The grant rules a harness's `baseline` and `signedInRule` give: everyone reads open resources in the
 * baseline's actions, signed-in principals read the same on open resources and the signed-in rule's on
 * registered ones, each on `global.unmarked`. The product's default is this shape with count, view and
 * export in both, so a harness that leaves both at their defaults holds the default rules.
 *
 * @param rules the baseline and the signed-in rule's actions.
 */
export const grantRulesOf = ({
	baseline,
	signedInRule,
}: Pick<ControllerSettings, 'baseline' | 'signedInRule'>): GrantRules => {
	const categoriesOf = (actions: readonly RecordAction[]) =>
		actions.length === 0
			? []
			: [
					{
						actions: actions.map(grantActionOf),
						name: 'global.unmarked' as const,
					},
				];
	return [
		{
			resources: [{ accessLevel: 'open', categories: categoriesOf(baseline) }],
			to: 'everyone',
		},
		{
			resources: [
				{ accessLevel: 'open', categories: categoriesOf(baseline) },
				{ accessLevel: 'registered', categories: categoriesOf(signedInRule) },
			],
			to: 'signedIn',
		},
	];
};

/**
 * The values of the settings a configuration gives the store, by the store's name for each: every
 * {@link StoredField}, the grant rules from the baseline and the signed-in rule, and the first user as its
 * realm role.
 *
 * @param configuration the harness's configuration, or the stored fields of one.
 */
export const storedSettingsOf = ({
	autoAccept,
	baseline,
	eventSource,
	firstUserRole,
	grantRateThreshold,
	heartbeatMilliseconds,
	issuer,
	noticePageLimit,
	noticeRereadMilliseconds,
	retentionGraceSeconds,
	retentionMarginSeconds,
	selfGrantMaximumLifetimeSeconds,
	signInTokenMaximumLifetimeSeconds,
	signedInRule,
	streamLimitPerAudience,
	streamMaximumLifetimeSeconds,
	streamQueueLimit,
	submitterCategory,
	tokenLifetimeSeconds,
}: Pick<ControllerSettings, StoredField>): Partial<Settings> => ({
	eventSource,
	firstUser: { realmRole: firstUserRole },
	grantAutoAccept: autoAccept,
	grantRateThreshold,
	grantRules: grantRulesOf({ baseline, signedInRule }),
	heartbeatMilliseconds,
	issuer,
	noticePageLimit,
	noticeRereadMilliseconds,
	retentionGraceSeconds,
	retentionMarginSeconds,
	selfGrantMaximumLifetimeSeconds,
	signInTokenMaximumLifetimeSeconds,
	streamLimitPerAudience,
	streamMaximumLifetimeSeconds,
	streamQueueLimit,
	submitterCategory,
	tokenLifetimeSeconds,
});

const VARIABLE_NAMES: Readonly<Record<FieldWithVariable, string>> = {
	apiDocsClient: 'USHER_API_DOCS_CLIENT',
	backChannelLogoutAudiences: 'USHER_BACK_CHANNEL_LOGOUT_AUDIENCES',
	cursorKey: 'USHER_CURSOR_KEY',
	databaseAllowUnverifiedConnection: 'USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION',
	databaseControlConnections: 'USHER_DATABASE_CONTROL_CONNECTIONS',
	databaseExchangeConnections: 'USHER_DATABASE_EXCHANGE_CONNECTIONS',
	databasePassword: 'USHER_DATABASE_PASSWORD',
	databaseSchema: 'USHER_DATABASE_SCHEMA',
	databaseUrl: 'USHER_DATABASE_URL',
	directoryClientId: 'USHER_DIRECTORY_CLIENT_ID',
	directoryClientSecret: 'USHER_DIRECTORY_CLIENT_SECRET',
	directoryRealm: 'USHER_DIRECTORY_REALM',
	directoryUrl: 'USHER_DIRECTORY_URL',
	host: 'USHER_HOST',
	identityProviderIssuer: 'USHER_IDENTITY_PROVIDER_ISSUER',
	instanceName: 'USHER_INSTANCE_NAME',
	keyEncryptionKey: 'USHER_KEY_ENCRYPTION_KEY',
	managementAudience: 'USHER_MANAGEMENT_AUDIENCE',
	managementClients: 'USHER_MANAGEMENT_CLIENTS',
	port: 'USHER_PORT',
	serviceAccountRole: 'USHER_SERVICE_ACCOUNT_ROLE',
	storeTimeoutMilliseconds: 'USHER_STORE_TIMEOUT_MILLISECONDS',
	trustedProxies: 'USHER_TRUSTED_PROXIES',
};

/**
 * The environment variable each configuration field travels in, by field: names only, so a test
 * names a variable through this map rather than spelling it. A refusal of the configuration names
 * the variable at fault and never its value.
 */
export const ENVIRONMENT_VARIABLES: Readonly<Record<FieldWithVariable, string>> = Object.freeze({ ...VARIABLE_NAMES });

const APP_ROOT = new URL('../../', import.meta.url);

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

// A missing module is the seam's to report, never a refusal by the Controller.
const isSeamMessage = (thrown: unknown): boolean =>
	thrown instanceof Error && thrown.message.startsWith(NOT_IMPLEMENTED);

// The specifier is built at run time, so the type checker resolves nothing and this project
// typechecks before the Controller exists.
const loadExport = async <Exported>(module: ControllerExport): Promise<Exported> => {
	const url = await presentModule(module);
	const loaded: unknown = await import(url.href);
	const exported = isRecord(loaded) ? loaded[module.exportName] : undefined;
	if (typeof exported === 'function') {
		return exported as Exported;
	}
	throw new Error(
		`the Usher Controller's ${module.path} exports no function ${module.exportName}: align testing/harness/controller.ts with the implementation`,
	);
};

/**
 * The environment the config module reads for a configuration: the one place the Controller's
 * environment variable names live. Every setting the Controller reads but `clock` and `logStream` has
 * a variable; a list is comma-separated, empty for an empty list. The key-encryption key, the
 * database password and the directory's client secret travel as given, each in its own variable.
 * The {@link PendingSettings}, which the Controller does not read yet, travel in none.
 *
 * @param configuration the configuration to express.
 */
export const environmentFor = ({
	apiDocsClient,
	backChannelLogoutAudiences,
	cursorKey,
	databaseAllowUnverifiedConnection,
	databaseControlConnections,
	databaseExchangeConnections,
	databasePassword,
	databaseSchema,
	databaseUrl,
	directoryClientId,
	directoryClientSecret,
	directoryRealm,
	directoryUrl,
	host,
	identityProviderIssuer,
	instanceName,
	keyEncryptionKey,
	managementAudience,
	managementClients,
	port,
	serviceAccountRole,
	storeTimeoutMilliseconds,
	trustedProxies,
}: ControllerSettings): Readonly<Record<string, string>> => ({
	[VARIABLE_NAMES.apiDocsClient]: apiDocsClient,
	[VARIABLE_NAMES.backChannelLogoutAudiences]: backChannelLogoutAudiences.join(','),
	[VARIABLE_NAMES.cursorKey]: cursorKey,
	[VARIABLE_NAMES.databaseAllowUnverifiedConnection]: String(databaseAllowUnverifiedConnection),
	[VARIABLE_NAMES.databaseControlConnections]: String(databaseControlConnections),
	[VARIABLE_NAMES.databaseExchangeConnections]: String(databaseExchangeConnections),
	[VARIABLE_NAMES.databasePassword]: databasePassword,
	[VARIABLE_NAMES.databaseSchema]: databaseSchema,
	[VARIABLE_NAMES.databaseUrl]: databaseUrl,
	[VARIABLE_NAMES.directoryClientId]: directoryClientId,
	[VARIABLE_NAMES.directoryClientSecret]: directoryClientSecret,
	[VARIABLE_NAMES.directoryRealm]: directoryRealm,
	[VARIABLE_NAMES.directoryUrl]: directoryUrl,
	[VARIABLE_NAMES.host]: host,
	[VARIABLE_NAMES.identityProviderIssuer]: identityProviderIssuer,
	[VARIABLE_NAMES.instanceName]: instanceName,
	[VARIABLE_NAMES.keyEncryptionKey]: keyEncryptionKey,
	[VARIABLE_NAMES.managementAudience]: managementAudience,
	[VARIABLE_NAMES.managementClients]: managementClients.join(','),
	[VARIABLE_NAMES.port]: String(port),
	[VARIABLE_NAMES.serviceAccountRole]: serviceAccountRole,
	[VARIABLE_NAMES.storeTimeoutMilliseconds]: String(storeTimeoutMilliseconds),
	[VARIABLE_NAMES.trustedProxies]: trustedProxies.join(','),
});

/**
 * Reads a configuration through the app's config module. The clock of the configuration it returns
 * is the Controller's own; a test needing a known now replaces it.
 *
 * @param environment the environment variables, such as {@link environmentFor} gives.
 * @throws the config module's refusal, naming the rule broken; or, until the module exists, the
 *   seam's message that it is missing.
 */
export const readConfiguration = async (environment: ControllerEnvironment): Promise<ControllerConfiguration> => {
	const read = await loadExport<ReadConfiguration>(CONTROLLER_MODULES.configuration);
	return read(environment);
};

/**
 * Creates and starts a Controller. A start that rejects is followed by `stop`, so a refused start
 * leaves nothing running.
 *
 * @param configuration the Controller's configuration.
 * @returns the URL the Controller answers at, and a `stop` settling once its work has ended.
 */
export const startController = async (configuration: ControllerConfiguration): Promise<RunningController> => {
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
 * Applies the Controller's migrations up to a target, all of them by default: the in-process form
 * of the deployment command, for a step-by-step run the command never makes.
 *
 * @param options the migration role's connection URL, the runtime role, the schema and the target.
 */
export const migrate = async (options: MigrationOptions): Promise<void> => {
	const apply = await loadExport<Migrate>(CONTROLLER_MODULES.migrations);
	const { settings, ...rest } = options;
	await apply({
		...rest,
		seed: (): Promise<SeedFile> => Promise.resolve({ kind: 'present', text: JSON.stringify(settings) }),
		clock: { now: () => Date.now() },
		eventLog: { error: () => undefined, writeEvent: () => undefined },
	});
};

/**
 * Creates the Controller's audit trail, through its own code, from the log stream's writes, the
 * settings and the store given.
 *
 * @param options where lines are written, the settings, and where connections are taken from.
 * @throws until the module exists, the seam's message that it is missing.
 */
export const createAuditTrail = async <Connection extends TrailConnection>(
	options: AuditTrailOptions<Connection>,
): Promise<AuditTrail<Connection>> => {
	const create = await loadExport<(options: AuditTrailOptions<Connection>) => AuditTrail<Connection>>(
		CONTROLLER_MODULES.auditTrail,
	);
	return create(options);
};

/** The Controller's store timeout where its configuration names none, in milliseconds. */
export const DEFAULT_STORE_TIMEOUT_MILLISECONDS = 5000;

/**
 * The store timeout every harness start gets where a test's configuration names none, in milliseconds.
 * A start runs wholly within its store timeout, and under load a start has taken 5,166 ms, past the
 * product's 5,000 ms default, so the harness gives its starts a timeout about three times that slowest
 * start seen. Suites that test the timeout itself name their own.
 */
export const HARNESS_STORE_TIMEOUT_MILLISECONDS = 15_000;

// The names the seam's trail gives events it never writes: the seeded policy records none.
const SEAM_EVENT_SOURCE = 'usher-seeded-policy-seam';

const SEAM_INSTANCE_NAME = 'usher-seeded-policy-seam';

/**
 * Writes the policy a Controller's start seeds, through the Controller's own code, on the connection
 * given: in one transaction its audit trail holds as the system, within the harness's store timeout, the
 * capability vocabulary and the seeded roles the store lacks. A store already holding all of
 * it is written nothing, so it can run again on the same store. No privilege or key-encryption key is
 * checked: that is the start's alone.
 *
 * @param connection the connection, holding no transaction; it is left open.
 * @param settings the schema and the clock.
 * @throws until the modules exist, the seam's message that one is missing.
 */
export const writeSeededPolicy = async (
	connection: SeedingConnection,
	settings: SeededPolicySettings,
): Promise<void> => {
	const [trail, write] = await Promise.all([
		seamTrail(connection, settings),
		loadExport<WriteSeededPolicy>(CONTROLLER_MODULES.seededPolicy),
	]);
	await trail.inTransaction({ type: 'system' }, (transaction) => write(transaction, settings));
};

/**
 * The application a start writes: its display name and description, and the id the fixture seeded it
 * under, which it keeps, when the fixture seeded it before the start.
 */
export interface ApplicationToWrite {
	description: string | null;
	displayName: string;

	/** The id the fixture seeded the application under; `undefined` for one the start writes new. */
	seededId: string | undefined;
}

/** An application a start wrote, with the first key it was issued: its id, and the key's id and value. */
export interface WrittenApplication {
	displayName: string;
	id: string;
	key: string;
	keyId: string;
}

/** The settings an application is written under: the seeded policy's, and the key-encryption key sealing its key. */
export interface ApplicationWriteSettings extends SeededPolicySettings {
	keyEncryptionKey: string;
}

// The store module's exports the application writes use, as the seam calls them.
type InsertApplication = (
	connection: SeedingConnection,
	schema: string,
	application: { description: string | null; displayName: string; registeredAt: Date; registeredBy: string },
) => Promise<string>;

type InsertKey = (
	connection: SeedingConnection,
	schema: string,
	cipher: unknown,
	key: { applicationId: string; issuedAt: Date; issuedBy: string },
) => Promise<{ id: string; value: string }>;

type CreateApplicationKeyCipher = (keyEncryptionKey: string) => unknown;

/**
 * Writes the harness's applications and the first key of each, through the Controller's own code, on
 * the connection given: in one transaction its audit trail holds as the system, each application
 * inserted by the store, or kept under the id the fixture seeded it with, and its key sealed under the
 * key-encryption key. The seam records no event, as the seeded policy records none. Nothing is checked
 * of the registrant beyond its id, which the caller gives.
 *
 * @param connection the connection, holding no transaction; it is left open.
 * @param settings the schema, the clock and the key-encryption key.
 * @param applications the applications, in the order they are written.
 * @param registrant the `users.id` of the person registering and issuing them.
 * @throws until the modules exist, the seam's message that one is missing.
 */
export const writeApplicationsThroughStore = async (
	connection: SeedingConnection,
	settings: ApplicationWriteSettings,
	applications: readonly ApplicationToWrite[],
	registrant: string,
): Promise<readonly WrittenApplication[]> => {
	const [trail, insertApplication, insertKey, createCipher] = await Promise.all([
		seamTrail(connection, settings),
		loadExport<InsertApplication>(CONTROLLER_MODULES.insertApplication),
		loadExport<InsertKey>(CONTROLLER_MODULES.insertKey),
		loadExport<CreateApplicationKeyCipher>(CONTROLLER_MODULES.applicationKeyCipher),
	]);
	const cipher = createCipher(settings.keyEncryptionKey);
	const now = new Date(settings.clock.now());
	return trail.inTransaction({ type: 'system' }, ({ connection: transaction }) =>
		inTurn(applications, async ({ description, displayName, seededId }) => {
			const id =
				seededId ??
				(await insertApplication(transaction, settings.databaseSchema, {
					description,
					displayName,
					registeredAt: now,
					registeredBy: registrant,
				}));
			const key = await insertKey(transaction, settings.databaseSchema, cipher, {
				applicationId: id,
				issuedAt: now,
				issuedBy: registrant,
			});
			return { displayName, id, key: key.value, keyId: key.id };
		}),
	);
};

// The audit trail a seam write runs its transaction on, over the connection given. It records no event:
// the names the trail gives events are never written, and the seam's event sink drops any line.
const seamTrail = (connection: SeedingConnection, settings: SeededPolicySettings) =>
	createAuditTrail({
		eventLog: { error: () => undefined, writeEvent: () => undefined },
		settings: {
			...settings,
			eventSource: SEAM_EVENT_SOURCE,
			instanceName: SEAM_INSTANCE_NAME,
			storeTimeoutMilliseconds: HARNESS_STORE_TIMEOUT_MILLISECONDS,
		},
		store: {
			connect: async () => ({
				query: (text: string, values?: readonly unknown[]) =>
					connection.query(text, values === undefined ? undefined : [...values]),
				release: () => undefined,
			}),
		},
	});

const isPort = (value: number): boolean => Number.isInteger(value) && value > 0 && value < 65_536;

const definedVariables = (environment: ControllerEnvironment): Record<string, string> =>
	Object.fromEntries(
		Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
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

const acceptedWhile = async (running: () => boolean, host: string, port: number): Promise<boolean> => {
	if (running()) {
		const accepted = await acceptsConnection(host, port);
		return accepted || delay(PROBE_INTERVAL_MS).then(() => acceptedWhile(running, host, port));
	}
	return false;
};

// A built entry runs under Node alone, as it is run outside the tests, so nothing tsx resolves or
// transforms passes for the build's own; the source entry runs through tsx, reading the workspace
// packages it imports from their source, as the test runner does.
const nodeArgumentsFor = async (builtEntry: URL | undefined): Promise<readonly string[]> =>
	builtEntry
		? [fileURLToPath(builtEntry)]
		: [
				SOURCE_CONDITION,
				'--import',
				import.meta.resolve('tsx'),
				fileURLToPath(await presentModule(CONTROLLER_MODULES.main)),
			];

interface RunOptions {
	/** Where a listener is probed for while the process runs; nowhere when absent. */
	probe?: { host: string; port: number };

	/** The signal sent to the process once this settles with one, if it is still running then. */
	stopWith?: Promise<NodeJS.Signals>;

	timeoutMs: number;
}

const runEntry = async (
	nodeArguments: readonly string[],
	environment: ControllerEnvironment,
	{ probe, stopWith, timeoutMs }: RunOptions,
): Promise<ControllerExit> => {
	const output: { stderr: Buffer[]; stdout: Buffer[] } = {
		stderr: [],
		stdout: [],
	};
	const state = { running: true, timedOut: false };
	const child = spawn(process.execPath, nodeArguments, {
		cwd: fileURLToPath(APP_ROOT),
		env: definedVariables(environment),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stderr.on('data', (chunk: Buffer) => output.stderr.push(chunk));
	child.stdout.on('data', (chunk: Buffer) => output.stdout.push(chunk));
	const timer = setTimeout(() => {
		state.timedOut = true;
		child.kill('SIGKILL');
	}, timeoutMs);
	stopWith?.then(
		(signal) => {
			if (state.running) {
				child.kill(signal);
			}
		},
		() => undefined,
	);
	const ended = new Promise<Pick<ControllerExit, 'exitCode' | 'signal'>>((resolve, reject) => {
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
	});
	const [{ exitCode, signal }, acceptedConnection] = await Promise.all([
		ended,
		probe === undefined ? false : acceptedWhile(() => state.running, probe.host, probe.port),
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
 * Runs the app's process entry, `src/main.ts`, through tsx, or a built entry under Node alone, as a
 * child process given exactly the environment passed, nothing inherited: tsx and Node need no
 * variable of their own to run it. While it runs, the port it was given is probed for a listener
 * every 25 ms, so a listener that comes and goes between two probes can be missed. A process still
 * running at the timeout is killed.
 *
 * @param environment the environment variables, such as {@link environmentFor} gives; its port is
 *   the one probed unless the options name another.
 * @param options the built entry run, if any; the host and port probed; and the timeout.
 * @returns the exit code or signal, the output, whether the port ever accepted a connection, and
 *   whether the timeout ended the process.
 * @throws the seam's message while `src/main.ts` is missing and no built entry is given; a
 *   `RangeError` when no port other than 0 is given to probe.
 */
export const spawnController = async (
	environment: ControllerEnvironment,
	{ builtEntry, host, port, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS }: SpawnOptions = {},
): Promise<ControllerExit> => {
	const nodeArguments = await nodeArgumentsFor(builtEntry);
	const probedPort = port ?? Number(environment[VARIABLE_NAMES.port]);
	if (isPort(probedPort)) {
		return runEntry(nodeArguments, environment, {
			probe: {
				host: host ?? environment[VARIABLE_NAMES.host] ?? LOOPBACK,
				port: probedPort,
			},
			timeoutMs,
		});
	}
	throw new RangeError('spawnController probes a port other than 0: give one in the environment or in its options');
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

/** How a failure nothing catches is raised in a built entry's process: thrown, or a promise rejected with nobody handling it. */
export type UncaughtFailure = 'exception' | 'rejection';

/** What {@link spawnWithUncaughtFailure} is told beyond the entry and the environment. */
export interface UncaughtFailureSpawn {
	/** How the failure is raised. */
	failure: UncaughtFailure;

	/** The failure's message, which a test searches the output for. */
	message: string;

	/** How long the process may run before it is killed: 10 s by default. */
	timeoutMs?: number;
}

// Loads a built entry, then raises an error nothing catches once the entry's own code has run, so
// whatever the entry installed for such a failure is in place: plain JavaScript, run under Node
// alone, given the entry's URL, how to raise the error and its message.
const UNCAUGHT_FAILURE_SCRIPT = `const [entry, failure, message] = process.argv.slice(1);
await import(entry);
const error = new Error(message);
setImmediate(() => {
  if (failure === 'rejection') {
    Promise.reject(error);
  } else {
    throw error;
  }
});`;

/**
 * Runs a built entry under Node alone as a child process given exactly the environment passed, and
 * raises an error nothing catches in it once the entry's own code has run: thrown, or as a promise
 * rejected with nobody handling it. A process still running at the timeout is killed.
 *
 * @param entry the entry, by the name of the file it builds.
 * @param environment the environment variables, such as {@link schemaMigrationEnvironmentFor} gives.
 * @param options how the error is raised, its message, and the timeout.
 * @returns the exit code or signal, the output, and whether the timeout ended the process.
 * @throws while the run has no build, as when a test file runs without the global setup.
 */
export const spawnWithUncaughtFailure = async (
	entry: BuiltEntry,
	environment: ControllerEnvironment,
	{ failure, message, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS }: UncaughtFailureSpawn,
): Promise<CommandExit> => {
	const { acceptedConnection: _acceptedConnection, ...exit } = await runEntry(
		['--input-type=module', '--eval', UNCAUGHT_FAILURE_SCRIPT, builtEntry(entry).href, failure, message],
		environment,
		{ timeoutMs },
	);
	return exit;
};

const SCHEMA_MIGRATION_VARIABLE_NAMES = {
	seedFile: 'USHER_SEED_FILE',
	databasePassword: 'USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD',
	databaseUrl: 'USHER_SCHEMA_MIGRATION_DATABASE_URL',
} as const;

/**
 * The environment variables of the schema migration command's own, by field: names only, so a test
 * names one through this map rather than spelling it. The command also reads the runtime role, the
 * database role `USHER_DATABASE_URL` names, and the schema and the durations the retention floor is
 * made of from the Controller's own variables, in {@link ENVIRONMENT_VARIABLES}.
 */
export const SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES: Readonly<
	Record<keyof typeof SCHEMA_MIGRATION_VARIABLE_NAMES, string>
> = Object.freeze({ ...SCHEMA_MIGRATION_VARIABLE_NAMES });

// A run on a database under the suite's load takes far less; a hung one is ended.
const SCHEMA_MIGRATION_TIMEOUT_MS = 30_000;

/**
 * What a run of the schema migration command is told: every option of the in-process `migrate` but
 * a target, since the command applies every migration.
 */
export type SchemaMigrationCommandOptions = Omit<MigrationOptions, 'settings' | 'target'> & {
	/**
	 * The seed file a first run seeds from, as {@link writeSeedFile} writes it; none for a run on a
	 * database already seeded, which reads no file.
	 */
	seedFile?: string;
};

/**
 * The environment the schema migration command reads for a run's options. The URL's password, which
 * the command refuses inside a URL, travels in its own variable; the runtime role as the user of
 * the Controller's own URL, `USHER_DATABASE_URL`, which is the schema migration role's URL under
 * that role, carrying no password; and the retention floor as a token lifetime with no grace period
 * or margin, which the command sums back to the floor.
 *
 * @param options the run's options, such as the in-process `migrate` takes, but a target.
 */
export const schemaMigrationEnvironmentFor = ({
	seedFile,
	databaseUrl,
	runtimeRole,
	schema,
}: SchemaMigrationCommandOptions): Readonly<Record<string, string>> => {
	const url = new URL(databaseUrl);
	const password = decodeURIComponent(url.password);
	url.password = '';
	const runtimeUrl = new URL(url);
	runtimeUrl.username = runtimeRole;
	return {
		...(seedFile === undefined ? {} : { [SCHEMA_MIGRATION_VARIABLE_NAMES.seedFile]: seedFile }),
		[VARIABLE_NAMES.databaseSchema]: schema,
		[VARIABLE_NAMES.databaseUrl]: runtimeUrl.href,
		[SCHEMA_MIGRATION_VARIABLE_NAMES.databasePassword]: password,
		[SCHEMA_MIGRATION_VARIABLE_NAMES.databaseUrl]: url.href,
	};
};

/** What {@link spawnSchemaMigrationCommand} is told beyond the environment. */
export interface SchemaMigrationCommandSpawn {
	/** The signal sent to the command once this settles with one, if it is still running then; none when absent. */
	stopWith?: Promise<NodeJS.Signals>;

	/** How long the command may run before it is killed: 30 s by default. */
	timeoutMs?: number;
}

/**
 * Runs the run's build of the schema migration command, `migrate.js`, under Node alone as a child
 * process given exactly the environment passed, nothing inherited. A signal is sent to it when the
 * test asks for one, and a process still running at the timeout is killed.
 *
 * @param environment the environment variables, such as {@link schemaMigrationEnvironmentFor} gives.
 * @param options the signal to send and when, and the timeout.
 * @returns the exit code or signal, the output, and whether the timeout ended the process.
 * @throws while the run has no build, as when a test file runs without the global setup.
 */
export const spawnSchemaMigrationCommand = async (
	environment: ControllerEnvironment,
	{ stopWith, timeoutMs = SCHEMA_MIGRATION_TIMEOUT_MS }: SchemaMigrationCommandSpawn = {},
): Promise<CommandExit> => {
	const { acceptedConnection: _acceptedConnection, ...exit } = await runEntry(
		[fileURLToPath(builtEntry('migrate'))],
		environment,
		{ ...(stopWith === undefined ? {} : { stopWith }), timeoutMs },
	);
	return exit;
};

/**
 * Writes a seed file holding the settings given, in a folder of its own, and returns its path: the
 * file a first run of the schema migration command seeds from.
 *
 * @param settings every setting, as the file holds them.
 */
export const writeSeedFile = async (settings: Settings): Promise<string> => {
	const folder = await mkdtemp(join(tmpdir(), 'usher-seed-'));
	const path = join(folder, 'seed.json');
	await writeFile(path, JSON.stringify(settings));
	return path;
};

/**
 * Applies every one of the Controller's migrations through the run's build of the schema migration
 * command, run as a deployment runs it.
 *
 * @param options the schema migration role's connection URL, the seed file, the runtime role and
 *   the schema.
 * @returns each line the command wrote to standard output, parsed.
 * @throws {Error} carrying what the command wrote, when it ends other than with exit code 0.
 */
export const migrateThroughCommand = async (options: SchemaMigrationCommandOptions): Promise<readonly unknown[]> => {
	const { exitCode, signal, stderr, stdout } = await spawnSchemaMigrationCommand(
		schemaMigrationEnvironmentFor(options),
	);
	if (exitCode === 0) {
		return stdout
			.split('\n')
			.filter((line) => line !== '')
			.map((line): unknown => JSON.parse(line));
	}
	throw new Error(`the schema migration command ended with ${exitCode ?? signal}: ${stderr.trim()}`);
};

/**
 * The names of the environment variables whose values differ between two environments, sorted: how
 * a test finds the variable a configuration field travels in without spelling it.
 *
 * @param from one environment.
 * @param to the other.
 */
export const changedVariables = (from: ControllerEnvironment, to: ControllerEnvironment): readonly string[] =>
	[...new Set([...Object.keys(from), ...Object.keys(to)])].filter((name) => from[name] !== to[name]).toSorted();

/**
 * What reading a configuration from an environment threw: the refusal a test examines. The seam's
 * own message, while the config module is missing, is thrown on rather than taken for a refusal.
 *
 * @param environment the environment refused.
 * @throws when the configuration is read without a refusal, and the seam's message while the config
 *   module is missing.
 */
export const readRefusal = async (environment: ControllerEnvironment): Promise<unknown> => {
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

/** What the Controller wrote to a log stream a test gave it. */
export interface LogCapture {
	/** Each line written so far, in order, empty lines left out. */
	lines(): readonly string[];

	/** The stream to configure as `logStream`. */
	stream: Writable;
}

/** A writable stream recording every line written to it, to configure as the Controller's `logStream`. */
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
export type StartOutcome = { kind: 'refused'; refusal: unknown } | { kind: 'started' };

/**
 * Starts a Controller and stops it at once, or gives the start's refusal. The seam's own message,
 * while the app module is missing, is thrown on rather than taken for a refusal.
 *
 * @param configuration the configuration to start with.
 */
export const startOutcome = async (configuration: ControllerConfiguration): Promise<StartOutcome> => {
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
