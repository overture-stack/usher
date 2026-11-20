import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { decodeJwt } from 'jose';
import pg from 'pg';

import type { Settings } from '../../src/settings/index.js';

import {
	type AdminCaller,
	assertSucceeded,
	issueApplicationKey,
	issuedApplicationKeyOf,
	mintManagementToken,
	registerApplication,
	registeredApplicationOf,
} from './admin.js';
import { runningContainers } from './containerEnvironment.js';
import type { DedicatedContainer, KeycloakRealm, KeycloakRealmOptions } from './containers.js';
import {
	type ControllerApplication,
	type ControllerConfiguration,
	type MigrationOptions,
	type RunningController,
	type SeededPolicySettings,
	startController,
	storedSettingsOf,
	writeSeededPolicy,
} from './controller.js';
import {
	createTestDatabase,
	type DatabaseRole,
	type DatabaseTemplate,
	TEMPLATE_SETTINGS,
	type TestDatabase,
	templateSeededWith,
	USHER_SCHEMA,
	USHER_TEMPLATE,
	writeStoredSettings,
} from './database.js';
import { mintSignInToken, PEOPLE, type Person, SYSTEM_CLOCK } from './exchange.js';
import { type IdentityProvider, type MintOptions, startIdentityProvider } from '../peripherals/identityProvider.js';
import {
	type FixtureApplication,
	inTurn,
	type PolicyFixture,
	restoreStoreSnapshot,
	seedAdministrator,
	type SeededPolicy,
	seedPolicy,
	setEpoch,
	type StoreSnapshot,
	takeStoreSnapshot,
} from './policy.js';
import { type Cleanup, cleanupFor, suiteCleanup } from './waiting.js';

/**
 * What gives the harness a platform administrator's management token for registering its
 * applications and issuing their first keys, given the configuration its Controller runs with. The
 * harness seeds the person the token names as an administrator before using it.
 */
export type AdministratorTokenSource = (configuration: ControllerConfiguration) => Promise<string>;

/** What a harness is started with; every member has a default. */
export interface HarnessOptions {
	/**
	 * Where the harness gets the platform administrator's token for registering its applications and
	 * issuing their first keys: {@link standInAdministrator}'s by default. A fixture whose
	 * Controller trusts a Keycloak realm passes {@link realmAdministrator}'s, so registration runs as
	 * production runs it, by an administrator of the trusted issuer, and each application's registrant
	 * is a principal the Controller trusts. It is asked once, when the harness's own Controller first
	 * listens, and not at all when there is nothing to register.
	 */
	administratorToken?: AdministratorTokenSource;

	/**
	 * The harness's applications, by display name, in order: `arranger-test` and `lyric-test` by
	 * default and none for an empty list, then each further one named by the fixture
	 * ({@link harnessApplicationNames}). Once its own Controller first listens, the harness registers
	 * each through `POST /admin/applications` as the platform administrator
	 * ({@link HarnessOptions.administratorToken}), or, for one seeded by SQL already, issues its first
	 * key through `POST /admin/applications/{id}/keys`. Each answer's id and key are kept for
	 * {@link Harness.application}.
	 */
	applications?: readonly string[];

	/** Fields set over the harness's configuration, last, so a test can set any of them. */
	configuration?: Partial<ControllerConfiguration>;

	/**
	 * Policy seeded by SQL, the stand-in's issuer its users' by default, once the Controller has started
	 * and the harness has registered its applications, since the Controller writes the seeded roles at
	 * its start (#207 Q11): each of the fixture's applications is seeded under its registered id
	 * ({@link withRegisteredIds}), so seeding writes only what each serves. Registered through the API,
	 * an application takes its description from the fixture, and its registrant is the platform
	 * administrator whose token the harness holds, never a user named by the fixture. Nothing is seeded
	 * before the start.
	 */
	fixture?: PolicyFixture;

	/**
	 * A stand-in the test started itself, so a test can have the identity provider fail from before the
	 * Controller's start: a fresh one by default. The harness leaves a given one running.
	 */
	identityProvider?: IdentityProvider;

	/**
	 * A PostgreSQL the test file started for its outage tests, from `startDedicatedPostgresql`, to put
	 * the test file's database on: the run's shared one by default. The harness leaves it running.
	 */
	postgresql?: DedicatedContainer;

	/**
	 * Whether the harness seeds its administrator, `PEOPLE.administrator` under the configured
	 * issuer, once its own Controller first listens and before it registers anything: true by
	 * default, so a test acting as an administrator, or as any other principal, finds Usher with an
	 * administrator. False leaves the store holding none, as before the first user's nomination is
	 * accepted, so every operation but nominating, accepting and a nominee's listing is refused: a
	 * harness registering applications then seeds the administrator whose token registers them, and
	 * no other. A harness starting no Controller seeds none until it first starts one.
	 */
	seedsAdministrator?: boolean;

	/**
	 * Whether the harness starts a Controller: true by default. A test starting its own instances
	 * passes false and starts them from the harness's configuration, or calls
	 * {@link Harness.restart}; the fixture is then seeded whole before anything starts, its
	 * applications under the fixture's ids, and each is issued its first key once the harness's own
	 * Controller first listens.
	 */
	startsController?: boolean;

	/**
	 * The template the test file's database is cloned from: the Controller's own by default, and for a
	 * harness starting no Controller {@link STARTED_STORE_TEMPLATE}, so a fixture seeded before any start
	 * finds the roles a start writes. Another is for the harness's own tests.
	 */
	template?: DatabaseTemplate;
}

/** What the harness mints tokens with: every one from the identity provider stand-in. */
export interface HarnessTokens {
	/**
	 * An administrator's management token: the person is seeded as an administrator in the harness's
	 * store first, under the configured issuer, since a token makes no administrator, and the token
	 * carries no role beyond Keycloak's defaults.
	 */
	administrator(person: Person, options?: MintOptions): Promise<string>;

	/** The first user's management token, carrying the configured first-user role. */
	firstUser(person: Person, options?: MintOptions): Promise<string>;

	/** A management token carrying no role beyond Keycloak's defaults. */
	management(person: Person, options?: MintOptions): Promise<string>;

	/**
	 * A sign-in token for an application named by its display name, its `aud` the application's id:
	 * the first application registered by default.
	 */
	signIn(person: Person, options?: { application?: string; mint?: MintOptions }): Promise<string>;
}

/** An application registered by the harness, with the first key issued to it. */
export interface HarnessApplication extends ControllerApplication {
	/** The display name it was registered under, by which {@link Harness.application} finds it. */
	displayName: string;

	/** The id of {@link ControllerApplication.key}. */
	keyId: string;
}

/** Everything a test needs from one running Controller, stopped by one call. */
export interface Harness {
	/**
	 * An application registered by the harness, by its display name: its id, generated by its
	 * registration or, for one seeded by SQL before, the fixture's, and the first key issued to it.
	 *
	 * @throws when the harness registered no application of that display name.
	 */
	application(displayName: string): HarnessApplication;

	/**
	 * Every application registered by the harness, in the order given by
	 * {@link harnessApplicationNames}; none before its Controller first listens.
	 */
	applications: readonly HarnessApplication[];

	/** A caller of the Policy Management API holding a token, or none for `null`. */
	caller(token: string | null): AdminCaller;

	/** Connections under each database role, ended at stop. */
	clients: Readonly<Record<DatabaseRole, pg.Client>>;

	/** The configuration the Controller runs with, or last ran with; a restart's overrides change it. */
	configuration: ControllerConfiguration;

	database: TestDatabase;
	identityProvider: IdentityProvider;

	/**
	 * Stops the Controller, if one runs, then starts one on the same database, stand-in and keys, with
	 * the overrides given over the current configuration, settling once it listens: a stop, then
	 * {@link Harness.startController}, so on the port it last listened on. A start refused leaves no
	 * Controller running, and is thrown.
	 */
	restart(overrides?: Partial<ControllerConfiguration>): Promise<void>;

	/** The ids the fixture wrote; empty records when no fixture was given. */
	seeded: SeededPolicy;

	/**
	 * Starts a Controller on the same database, stand-in and keys, with the overrides given over the
	 * current configuration, settling once it listens. While the configuration asks for any free port,
	 * it listens on the port the harness's Controller last listened on, so a Bridge pointed at its URL
	 * reaches the new start as it would a restarted deployment. A start refused leaves no Controller
	 * running, and is thrown.
	 *
	 * @throws when the harness already runs a Controller.
	 */
	startController(overrides?: Partial<ControllerConfiguration>): Promise<void>;

	/**
	 * Stops the Controller, the stand-in the harness started and the database, settling once each has
	 * stopped.
	 */
	stop(): Promise<void>;

	/** Stops the Controller alone, settling once its work has ended; nothing happens when none runs. */
	stopController(): Promise<void>;

	tokens: HarnessTokens;

	/** The Controller's URL, ending in `/`; reading it while no Controller runs throws. */
	url: URL;
}

/**
 * A harness one suite's tests share: the first call starts it and every later one gets the same; a
 * start that failed is tried again by the next call, so each test reports its own failure.
 */
export type SharedHarness = () => Promise<Harness>;

/**
 * The client a logout token is addressed to by default, a Keycloak client id that is no
 * application's id, so a logout token's `aud` is checked against the configured clients alone.
 */
export const HARNESS_LOGOUT_CLIENT = 'portal-ui-test';

/** The one management client the harness's Controller lists by default, `managementClients`. */
export const HARNESS_MANAGEMENT_CLIENT = 'usher-ui-test';

/** The CloudEvents `source` the harness's Controller emits under, one for the whole deployment (#214). */
export const HARNESS_EVENT_SOURCE = 'https://usher.example.org/controller';

/**
 * The Controller's half of #217's compressed timing profile (#217 Q2): a 0.5 s heartbeat, 10 s Usher
 * tokens, a 20 s notice retention floor, the token lifetime with the Bridge's compressed 4 s grace
 * period and a 6 s margin, and a 250 ms store timeout, half the Bridge's compressed 0.5 s poll
 * deadline (#210 Q13). Give it as a harness's configuration, since the floor is set when the test's
 * database is created. The Bridge's half, and the pair, are in `vendoredBridge.ts`.
 */
export const COMPRESSED_CONTROLLER_TIMING: Readonly<
	Pick<
		ControllerConfiguration,
		| 'heartbeatMilliseconds'
		| 'retentionGraceSeconds'
		| 'retentionMarginSeconds'
		| 'storeTimeoutMilliseconds'
		| 'tokenLifetimeSeconds'
	>
> = Object.freeze({
	heartbeatMilliseconds: 500,
	retentionGraceSeconds: 4,
	retentionMarginSeconds: 6,
	storeTimeoutMilliseconds: 250,
	tokenLifetimeSeconds: 10,
});

/**
 * How often every Controller instance reloads the live application keys into memory beside the
 * wake-ups through the cache, in milliseconds: 30 s, a constant of the Controller's and no setting,
 * so a lost wake-up delays a registration, an issue or a revocation by at most this.
 */
export const APPLICATION_KEY_RELOAD_INTERVAL_MILLISECONDS = 30_000;

/** The settings the harness configures that the tests' own configuration does not otherwise give. */
export interface HarnessSettings {
	/** The cache's URL, which may carry its password, as given by `containers.ts`. */
	cacheUrl: string;

	databaseSchema: string;

	/** A URL under the runtime role, which may carry its password, as given by `database.ts`. */
	databaseUrl: string;

	identityProviderIssuer: string;
	overrides: Partial<ControllerConfiguration>;
}

const DEFAULT_APPLICATIONS = Object.freeze(['arranger-test', 'lyric-test']);

/**
 * The Controller's production defaults for an Usher token's lifetime and the notice retention
 * floor's grace period and margin, in seconds, which the harness configures unless a test sets its
 * own: 300 s tokens, a 60 s grace period and a 30 s margin.
 */
export const RETENTION_DEFAULTS = Object.freeze({
	retentionGraceSeconds: 60,
	retentionMarginSeconds: 30,
	tokenLifetimeSeconds: 300,
});

const NOTHING_SEEDED: SeededPolicy = Object.freeze({
	applications: {},
	categories: {},
	fields: {},
	grants: {},
	groups: {},
	invitations: [],
	resourceCategories: {},
	resourceTimes: {},
	resources: {},
	revocations: [],
	roles: {},
	users: {},
});

/**
 * A 32-byte key, fresh from the system's randomness, as 43 base64url characters in canonical form:
 * an application key's form, the cursor key's and the key-encryption key's.
 */
export const freshKey = (): string => randomBytes(32).toString('base64url');

const freshPassword = (): string => randomBytes(24).toString('base64url');

const passwordApart = (url: string, password: string): { password: string; url: string } => {
	const parsed = new URL(url);
	if (parsed.password.length > 0) {
		const carried = decodeURIComponent(parsed.password);
		parsed.password = '';
		return { password: carried, url: parsed.href };
	}
	return { password, url };
};

/**
 * A configuration with each store's password out of its URL and in a variable of its own, as in a
 * deployment: a URL carrying a password, as given by `containers.ts` and `database.ts`, moves it to
 * `databasePassword` or `cachePassword`, its user name kept; a URL carrying none leaves the password
 * field as it is. The harness starts every Controller through it, so a test may hand it a URL with
 * its credentials.
 *
 * @param configuration the configuration.
 */
export const passwordsApart = (configuration: ControllerConfiguration): ControllerConfiguration => {
	const cache = passwordApart(configuration.cacheUrl, configuration.cachePassword);
	const database = passwordApart(configuration.databaseUrl, configuration.databasePassword);
	return {
		...configuration,
		cachePassword: cache.password,
		cacheUrl: cache.url,
		databasePassword: database.password,
		databaseUrl: database.url,
	};
};

/**
 * The configuration of a harness's Controller: the Controller's issuer `https://usher.example.org`, a
 * fresh cursor key and key-encryption key, each store's password apart from its URL
 * ({@link passwordsApart}), a fresh one standing in where the URL carries none, the management API
 * `usher-management-test` with the client `usher-ui-test`, {@link HARNESS_LOGOUT_CLIENT} as the
 * back-channel logout audience, {@link HARNESS_EVENT_SOURCE} and the instance `usher-test-1`, no
 * directory, no EGO import settings, a grant rate threshold of 100 operations in 60 s, high enough
 * for no test to reach it by accident, the defaults given by the rulings (the timing settings at their
 * production defaults: a 10 s heartbeat, 300 s Usher tokens, a 500-notice page, a 2 s re-read, a 5 s
 * store timeout and a 15 min stream), the store connections at their defaults (10 for the exchange
 * and 5 for everything else), loopback on any free port, the system's clock and the process's
 * standard output as the log stream; then the test's overrides over all of it. The configuration
 * names no application: the harness registers its applications through the API once its Controller
 * listens.
 *
 * @param settings the cache, the database and the identity provider, and the test's overrides.
 */
export const harnessConfiguration = ({
	cacheUrl,
	databaseSchema,
	databaseUrl,
	identityProviderIssuer,
	overrides,
}: HarnessSettings): ControllerConfiguration =>
	passwordsApart({
		allowedCharactersExtra: '',
		apiDocsClient: '',
		autoAccept: false,
		backChannelLogoutAudiences: [HARNESS_LOGOUT_CLIENT],
		baseline: ['count', 'view', 'export'],
		cachePassword: freshPassword(),
		cacheUrl,
		clock: SYSTEM_CLOCK,
		cursorKey: freshKey(),
		databaseAllowUnverifiedConnection: false,
		databaseControlConnections: 5,
		databaseExchangeConnections: 10,
		databasePassword: freshPassword(),
		databaseSchema,
		databaseUrl,
		directoryClientId: '',
		directoryClientSecret: '',
		directoryRealm: '',
		directoryUrl: '',
		egoImportAllStudyPolicies: [],
		egoImportBaseTier: null,
		egoImportPrefixes: [],
		eventSource: HARNESS_EVENT_SOURCE,
		firstUserRole: 'usher-first-user',
		grantRateThreshold: { operationCount: 100, windowSeconds: 60 },
		heartbeatMilliseconds: 10_000,
		host: '127.0.0.1',
		identityProviderIssuer,
		instanceName: 'usher-test-1',
		issuer: 'https://usher.example.org',
		keyEncryptionKey: freshKey(),
		logStream: process.stdout,
		managementAudience: 'usher-management-test',
		managementClients: [HARNESS_MANAGEMENT_CLIENT],
		noticePageLimit: 500,
		noticeRereadMilliseconds: 2000,
		port: 0,
		retentionGraceSeconds: RETENTION_DEFAULTS.retentionGraceSeconds,
		retentionMarginSeconds: RETENTION_DEFAULTS.retentionMarginSeconds,
		selfGrantMaximumLifetimeSeconds: 86_400,
		serviceAccountRole: 'usher-service-account',
		signInTokenMaximumLifetimeSeconds: 3600,
		signedInRule: ['count', 'view', 'export'],
		storeTimeoutMilliseconds: 5000,
		streamLimitPerAudience: 64,
		streamMaximumLifetimeSeconds: 900,
		streamQueueLimit: 1000,
		submitterCategory: 'global.unmarked',
		tokenLifetimeSeconds: RETENTION_DEFAULTS.tokenLifetimeSeconds,
		trustedProxies: [],
		...overrides,
	});

/**
 * A configuration for the tests that only read one from an environment, or only start a Controller
 * to see it refuse: the harness's defaults, with loopback addresses for the stores and the identity
 * provider, none of which reading connects to, then the test's overrides.
 *
 * @param overrides fields set over the defaults.
 */
export const configurationToRead = (overrides: Partial<ControllerConfiguration> = {}): ControllerConfiguration =>
	harnessConfiguration({
		cacheUrl: 'redis://127.0.0.1:6379',
		databaseSchema: USHER_SCHEMA,
		databaseUrl: 'postgres://usher_controller@127.0.0.1:5432/usher_read',
		identityProviderIssuer: 'http://127.0.0.1:8080/realms/usher-test',
		overrides,
	});

/**
 * The clock the started store's template seeds the policy under: the system's, read at each recording.
 */
const STARTED_STORE_SETTINGS: Readonly<Pick<SeededPolicySettings, 'clock'>> = Object.freeze({
	clock: Object.freeze({ now: () => Date.now() }),
});

/**
 * The Controller's template with the policy a start seeds written by the Controller's own code
 * (#207 Q11), under {@link STARTED_STORE_SETTINGS}: the capability vocabulary, `SEEDED_ROLES` with their
 * capabilities, and the settings a start under {@link configurationToRead}'s defaults writes
 * ({@link writeStartSettings}), so a start on it writes no setting. It is a store as a started Controller
 * leaves it, but for the key-encryption key's fingerprint and the identity provider's record, which the first
 * start under a configuration records: the record's six rows are left null, as the migration creates them, so
 * a first start on the template fills them. For a test seeding a fixture that names the seeded roles while
 * starting no Controller. Run again on a clone, it writes nothing the migrations and the Controller would not
 * write again.
 */
export const STARTED_STORE_TEMPLATE: DatabaseTemplate = Object.freeze({
	migrate: async (options: MigrationOptions) => {
		await USHER_TEMPLATE.migrate(options);
		const client = new pg.Client({ connectionString: options.databaseUrl });
		await client.connect();
		try {
			await writeSeededPolicy(client, {
				...STARTED_STORE_SETTINGS,
				databaseSchema: options.schema,
			});
			await writeStoredSettings(client, options.schema, storedSettingsOf(configurationToRead()));
		} finally {
			await client.end();
		}
	},
	name: 'usher_template_started',
	schema: USHER_SCHEMA,
});

/**
 * The notice retention floor a configuration gives, which the deployment command sets (R3): the
 * token lifetime, the grace period and the margin, in seconds.
 *
 * @param configuration the three durations.
 */
export const retentionFloorSeconds = ({
	retentionGraceSeconds,
	retentionMarginSeconds,
	tokenLifetimeSeconds,
}: Pick<
	ControllerConfiguration,
	'retentionGraceSeconds' | 'retentionMarginSeconds' | 'tokenLifetimeSeconds'
>): number => tokenLifetimeSeconds + retentionGraceSeconds + retentionMarginSeconds;

/**
 * A Controller's URL ending in `/`, as the Bridge's client and the support modules resolve paths
 * against it.
 *
 * @param url the URL a Controller answers at.
 */
export const withTrailingSlash = (url: URL): URL => (url.pathname.endsWith('/') ? url : new URL(`${url.href}/`));

type Stop = () => Promise<void>;

const failuresOf = async (stops: readonly Stop[]): Promise<unknown[]> =>
	(await Promise.allSettled(stops.map((stop) => stop()))).flatMap((outcome) =>
		outcome.status === 'rejected' ? [outcome.reason] : [],
	);

// Each stage starts once the one before it has settled, whether or not every stop in it succeeded.
const stopInStages = async (stages: readonly (readonly Stop[])[]): Promise<void> => {
	const failures = await stages.reduce<Promise<unknown[]>>(
		async (earlier, stage) => [...(await earlier), ...(await failuresOf(stage))],
		Promise.resolve([]),
	);
	if (failures.length > 0) {
		throw new AggregateError(failures, 'the harness did not stop cleanly');
	}
};

const stoppedAfter = async (error: unknown, stops: readonly Stop[]): Promise<never> => {
	await stopInStages([stops]).catch((stopError: unknown) => {
		throw new AggregateError(
			[error, stopError],
			'the harness did not start, and what it had started did not stop cleanly',
		);
	});
	throw error;
};

const tokensFor = (
	identityProvider: IdentityProvider,
	configuration: () => ControllerConfiguration,
	applications: () => readonly HarnessApplication[],
	seedAdministratorOf: (subject: string) => Promise<unknown>,
): HarnessTokens => ({
	administrator: async (person, mint = {}) => {
		await seedAdministratorOf(person.subject);
		return mintManagementToken(identityProvider, configuration(), person, {
			mint,
		});
	},
	firstUser: (person, mint = {}) =>
		mintManagementToken(identityProvider, configuration(), person, {
			firstUser: true,
			mint,
		}),
	management: (person, mint = {}) => mintManagementToken(identityProvider, configuration(), person, { mint }),
	signIn: async (person, { application, mint = {} } = {}) => {
		const registered = applications();
		const chosen =
			application === undefined
				? registered[0]
				: registered.find(({ displayName }) => displayName === application);
		if (chosen !== undefined) {
			return mintSignInToken(identityProvider, person, chosen.id, mint);
		}
		throw new Error(`the harness registered no application ${application ?? 'to sign in to'}`);
	},
});

/**
 * The display names of a harness's applications, in order: those named by its options, then each
 * further one named by its fixture, by label, in the fixture's order. A name given twice is kept
 * once, where it first appears.
 *
 * @param displayNames the applications named by the options.
 * @param fixture the fixture, when one is given.
 */
export const harnessApplicationNames = (
	displayNames: readonly string[],
	fixture: PolicyFixture | undefined,
): readonly string[] => [...new Set([...displayNames, ...Object.keys(fixture?.applications ?? {})])];

/**
 * A fixture whose applications are held by their registered ids, each found by its label as a
 * display name, so seeding writes no row for them, only what each serves. An application not
 * registered by the harness keeps the fixture's id, and everything else is unchanged.
 *
 * @param fixture the fixture.
 * @param registered the harness's applications, by display name and id.
 */
export const withRegisteredIds = (
	fixture: PolicyFixture,
	registered: readonly Pick<HarnessApplication, 'displayName' | 'id'>[],
): PolicyFixture => {
	const ids = new Map(registered.map(({ displayName, id }) => [displayName, id]));
	return fixture.applications === undefined
		? fixture
		: {
				...fixture,
				applications: Object.fromEntries(
					Object.entries(fixture.applications).map(([label, application]): [string, FixtureApplication] => {
						const id = ids.get(label);
						return [label, id === undefined ? application : { ...application, id }];
					}),
				),
			};
};

/**
 * The harness's default {@link AdministratorTokenSource}: a management token minted by the stand-in
 * for `PEOPLE.administrator`, for a Controller trusting the stand-in's issuer.
 *
 * @param identityProvider the stand-in.
 */
export const standInAdministrator =
	(identityProvider: IdentityProvider): AdministratorTokenSource =>
	(configuration) =>
		mintManagementToken(identityProvider, configuration, PEOPLE.administrator);

/**
 * An {@link AdministratorTokenSource} for a Controller trusting a Keycloak realm: the realm's own
 * administrator, the first of its people holding the configured first-user role, signed in through
 * the first of its clients that is a configured management client and carries the management API's
 * audience. The token is Keycloak's own, from a real sign-in.
 *
 * @param realm the running realm and what it was set up with.
 */
export const realmAdministrator =
	({ keycloak, options }: { keycloak: KeycloakRealm; options: KeycloakRealmOptions }): AdministratorTokenSource =>
	async ({ firstUserRole, managementAudience, managementClients }) => {
		const client = options.clients.find(
			({ audiences, clientId }) => audiences.includes(managementAudience) && managementClients.includes(clientId),
		);
		const administrator = options.people.find(({ realmRoles = [] }) => realmRoles.includes(firstUserRole));
		if (client === undefined || administrator === undefined) {
			throw new Error('the realm holds no management client or no administrator to sign in');
		}
		return (await keycloak.signIn(client.clientId, administrator)).accessToken;
	};

/** A running realm and what it was set up with, as {@link realmAdministrator} reads one. */
export interface StartedRealm {
	keycloak: KeycloakRealm;
	options: KeycloakRealmOptions;
}

/** The token source of a harness started before its realm, and how the test gives it the realm. */
export interface RealmRegistrar {
	/**
	 * Signs the realm's own administrator in ({@link realmAdministrator}) once the realm is given, and
	 * is refused before.
	 */
	administratorToken: AdministratorTokenSource;

	/** Gives the source the realm, once the test has started it. */
	started(realm: StartedRealm): void;
}

/**
 * The administrator's token source of a harness started before its Keycloak realm, as a test starts
 * one so that it fails with the seam's message before any Keycloak starts: the harness asks it once
 * its Controller first listens, after the restart trusting the realm, and registers its applications
 * and issues their first keys as the realm's own administrator.
 */
export const realmRegistrar = (): RealmRegistrar => {
	const state: { realm: StartedRealm | undefined } = { realm: undefined };
	return {
		administratorToken: (configuration) =>
			state.realm === undefined
				? Promise.reject(
						new Error('the realm was not given to the registrar before the harness first listened'),
					)
				: realmAdministrator(state.realm)(configuration),
		started: (realm) => {
			state.realm = realm;
		},
	};
};

// The instance answering a registration or an issue holds the new key in memory before it answers
// (ruled), so a test exchanges with the key at once. An application seeded by SQL already keeps the
// fixture's id and is issued its first key; any other is registered, with the fixture's description
// when it names one.
const boundApplications = async (
	administratorToken: AdministratorTokenSource,
	configuration: ControllerConfiguration,
	url: URL,
	displayNames: readonly string[],
	fixture: PolicyFixture | undefined,
	seededIds: ReadonlyMap<string, string>,
): Promise<readonly HarnessApplication[]> => {
	if (displayNames.length === 0) {
		return [];
	}
	const administrator: AdminCaller = {
		token: await administratorToken(configuration),
		url,
	};
	return inTurn(displayNames, async (displayName) => {
		const seededId = seededIds.get(displayName);
		if (seededId !== undefined) {
			const label = `issuing the first key of the harness's application ${displayName}`;
			const response = await issueApplicationKey(administrator, seededId);
			assertSucceeded(response, label);
			const key = issuedApplicationKeyOf(response, label);
			return { displayName, id: seededId, key: key.value, keyId: key.id };
		}
		const label = `registering the harness's application ${displayName}`;
		const description = fixture?.applications?.[displayName]?.description;
		const response = await registerApplication(administrator, {
			displayName,
			...(description === undefined ? {} : { description }),
		});
		assertSucceeded(response, label);
		const { id, key } = registeredApplicationOf(response, label);
		return { displayName, id, key: key.value, keyId: key.id };
	});
};

interface Started {
	/** The applications the harness registered, once its Controller first listened. */
	applications: readonly HarnessApplication[] | undefined;

	configuration: ControllerConfiguration;

	/**
	 * The fixture's applications seeded by SQL, by display name, each issued its first key rather than
	 * registered once the harness's Controller first listens: none until the fixture is seeded.
	 */
	seededIds: ReadonlyMap<string, string>;

	/** The port the harness's Controller last listened on, kept for the next start. */
	port: number | undefined;

	running: RunningController | undefined;

	/**
	 * The last seeding of an administrator, settled or not: each seeding waits for the one before it,
	 * since each runs a transaction of its own on the harness's migration connection.
	 */
	seeding: Promise<unknown>;
}

const UNDEFINED_TABLE = '42P01';

// Writes what a start's configuration gives the store, before the Controller starts. A store with no settings
// table is left to the start, which refuses it naming its schema, as a store the migrations never built is refused.
const writeStartSettings = async (
	client: pg.ClientBase,
	schema: string,
	settings: Partial<Settings>,
): Promise<void> => {
	await writeStoredSettings(client, schema, settings).catch((failure: unknown) => {
		if (!(failure instanceof pg.DatabaseError && failure.code === UNDEFINED_TABLE)) {
			throw failure;
		}
	});
};

const startedWith = async (
	database: TestDatabase,
	identityProvider: IdentityProvider,
	stopOwned: Stop,
	{
		administratorToken = standInAdministrator(identityProvider),
		applications: givenNames = DEFAULT_APPLICATIONS,
		configuration: overrides = {},
		fixture,
		seedsAdministrator = true,
		startsController = true,
	}: HarnessOptions,
): Promise<Harness> => {
	const displayNames = harnessApplicationNames(givenNames, fixture);
	const state: Started = {
		applications: undefined,
		configuration: harnessConfiguration({
			cacheUrl: runningContainers().valkey.url,
			databaseSchema: database.schema,
			databaseUrl: database.urlFor('runtime'),
			identityProviderIssuer: identityProvider.issuer,
			overrides,
		}),
		port: undefined,
		running: undefined,
		seededIds: new Map(),
		seeding: Promise.resolve(),
	};
	const stopController = async (): Promise<void> => {
		const { running } = state;
		state.running = undefined;
		await running?.stop();
	};
	const registerOnce = async (running: RunningController): Promise<void> => {
		if (state.applications !== undefined) {
			return;
		}
		try {
			if (seedsAdministrator) {
				await seedAdministratorOf(PEOPLE.administrator.subject);
			}
			state.applications = await boundApplications(
				seededAdministratorToken,
				state.configuration,
				withTrailingSlash(running.url),
				displayNames,
				fixture,
				state.seededIds,
			);
		} catch (error) {
			await stopController();
			throw error;
		}
	};
	const startNow = async (startOverrides: Partial<ControllerConfiguration> = {}): Promise<void> => {
		if (state.running !== undefined) {
			throw new Error('the harness already runs a controller: stop it before starting another on its port');
		}
		state.configuration = passwordsApart({
			...state.configuration,
			...startOverrides,
		});
		await writeSettingsOnce();
		const { port } = state.configuration;
		const running = await startController({
			...state.configuration,
			port: port === 0 ? (state.port ?? 0) : port,
		});
		state.running = running;
		state.port = Number(running.url.port);
		await registerOnce(running);
	};
	const [migration, runtime] = await Promise.all([database.connect('migration'), database.connect('runtime')]);
	// The settings this harness last wrote, so a start writes only what changed since. A store the test has paused
	// is then read by no harness step ahead of the Controller's own start, which refuses it.
	let writtenSettings: Partial<Settings> | undefined;
	const writeSettingsOnce = async (): Promise<void> => {
		const settings = storedSettingsOf(state.configuration);
		if (isDeepStrictEqual(settings, writtenSettings)) {
			return;
		}
		await writeStartSettings(migration, database.schema, settings);
		writtenSettings = settings;
	};
	// A token makes no administrator, so whoever acts as one is seeded as one first, under the issuer
	// the Controller trusts as the token is asked for.
	const seedAdministratorOf = (subject: string): Promise<string> => {
		const seeded = state.seeding
			.catch(() => undefined)
			.then(() =>
				seedAdministrator(migration, {
					issuer: state.configuration.identityProviderIssuer,
					subject,
				}),
			);
		state.seeding = seeded;
		return seeded;
	};
	const seededAdministratorToken: AdministratorTokenSource = async (configuration) => {
		const token = await administratorToken(configuration);
		const { sub } = decodeJwt(token);
		if (sub === undefined) {
			throw new Error("the administrator's token names no subject to seed");
		}
		await seedAdministratorOf(sub);
		return token;
	};
	const seeding: PolicyFixture | undefined =
		fixture === undefined ? undefined : { issuer: identityProvider.issuer, ...fixture };
	const registered = (): readonly HarnessApplication[] => state.applications ?? [];
	try {
		await writeSettingsOnce();
		if (startsController) {
			await startNow();
		}
		// Its Controller started, the harness has registered the fixture's applications, so seeding writes
		// only what they serve; with none started, they are seeded under the fixture's ids, and issued
		// their keys once the harness's Controller first listens.
		const seeded =
			seeding === undefined
				? NOTHING_SEEDED
				: await seedPolicy(migration, withRegisteredIds(seeding, registered()));
		state.seededIds = new Map(Object.entries(seeded.applications));
		const url = (): URL => {
			if (state.running !== undefined) {
				return withTrailingSlash(state.running.url);
			}
			throw new Error('the harness runs no controller now');
		};

		return {
			application: (displayName) => {
				const found = registered().find((application) => application.displayName === displayName);
				if (found !== undefined) {
					return found;
				}
				throw new Error(`the harness registered no application ${displayName}`);
			},
			get applications(): readonly HarnessApplication[] {
				return registered();
			},
			caller: (token) => ({ token, url: url() }),
			clients: { migration, runtime },
			get configuration(): ControllerConfiguration {
				return state.configuration;
			},
			database,
			identityProvider,
			restart: async (restartOverrides = {}) => {
				await stopController();
				await startNow(restartOverrides);
			},
			seeded,
			startController: startNow,
			stop: () => stopInStages([[stopController], [stopOwned, () => database.close()]]),
			stopController,
			tokens: tokensFor(identityProvider, () => state.configuration, registered, seedAdministratorOf),
			get url(): URL {
				return url();
			},
		};
	} catch (error) {
		return stoppedAfter(error, [stopController]);
	}
};

// The settings a database is seeded with for a harness: the template's, with the fixed settings the harness's
// configuration gives, so a test naming its own issuer, event source or first user is seeded with it.
const seedOf = ({ eventSource, firstUserRole, issuer }: Partial<ControllerConfiguration> = {}): Settings => ({
	...TEMPLATE_SETTINGS,
	...(eventSource === undefined ? {} : { eventSource }),
	...(firstUserRole === undefined ? {} : { firstUser: { realmRole: firstUserRole } }),
	...(issuer === undefined ? {} : { issuer }),
});

/**
 * Stands up everything a test file needs, in order: its own database, cloned through `database.ts`
 * with the retention floor its configuration gives, on the run's PostgreSQL or the test file's own;
 * an identity provider stand-in, or the test's own; a configuration from {@link harnessConfiguration}
 * and the test's overrides; the Controller, started through `controller.ts`, unless the test starts
 * its own, with the harness's applications, the fixture's among them, registered through the API
 * once it listens; and then the fixture, seeded by SQL under the registered ids, since the Controller
 * writes the seeded roles at its start (#207 Q11). Whatever started before a failure is stopped
 * before the failure is thrown, so while the Controller is missing the harness fails with the seam's
 * message and leaves nothing running.
 *
 * @param options the applications, configuration overrides, a fixture, a stand-in and a PostgreSQL
 *   of the test file's own, whether to start a Controller, and the template.
 */
export const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
	const database = await createTestDatabase(
		options.template ??
			(options.startsController === false
				? STARTED_STORE_TEMPLATE
				: templateSeededWith(seedOf(options.configuration))),
		{
			retentionFloorSeconds: retentionFloorSeconds({
				...RETENTION_DEFAULTS,
				...options.configuration,
			}),
			...(options.postgresql === undefined ? {} : { superuserUrl: options.postgresql.container.url }),
		},
	);
	const given = options.identityProvider;
	const identityProvider =
		given ??
		(await startIdentityProvider().catch((error: unknown) => stoppedAfter(error, [() => database.close()])));
	const stopOwned: Stop = given === undefined ? () => identityProvider.stop() : async () => undefined;
	return startedWith(database, identityProvider, stopOwned, options).catch((error: unknown) =>
		stoppedAfter(error, [stopOwned, () => database.close()]),
	);
};

/**
 * Starts a harness, runs a test's work against it, and stops it whether or not the work succeeded,
 * so no test ends with a Controller, a stand-in or a database still running.
 *
 * Given the test's context, the harness stops only once the test has ended, as a step of its
 * {@link cleanupFor} registry deferred when the harness started: a step the test defers after that,
 * such as stopping an instance from `startInstance`, runs first, so nothing started on the harness
 * outlives its database; and one deferred before it, such as removing a PostgreSQL of the test's
 * own, runs after. Without one, the harness stops as soon as the work settles.
 *
 * @param options the harness's options.
 * @param work the test's steps.
 * @param context the test's context, to stop the harness after the test's own cleanups.
 */
export const withHarness = async <Result>(
	options: HarnessOptions,
	work: (harness: Harness) => Promise<Result>,
	context?: TestContext,
): Promise<Result> => {
	const harness = await startHarness(options);
	if (context !== undefined) {
		cleanupFor(context).defer(() => harness.stop());
		return work(harness);
	}
	try {
		return await work(harness);
	} finally {
		await harness.stop();
	}
};

/**
 * A harness one suite's tests share, for tests that change nothing another test reads: started by the
 * first test asking for it, stopped once the suite's tests have ended. A start that failed is tried
 * again by the next test asking. Call it in the suite's body.
 *
 * @param options the harness's options, or a function giving them at the start.
 */
export const suiteHarness = (options: HarnessOptions | (() => HarnessOptions)): SharedHarness => {
	const scope = suiteCleanup();
	const state: { starting: Promise<Harness> | undefined } = {
		starting: undefined,
	};
	scope.defer(async () => {
		const starting = state.starting;
		state.starting = undefined;
		const started = await starting?.catch(() => undefined);
		await started?.stop();
	});
	return () => {
		const starting =
			state.starting ??
			startHarness(typeof options === 'function' ? options() : options).catch((error: unknown) => {
				state.starting = undefined;
				throw error;
			});
		state.starting = starting;
		return starting;
	};
};

/** A Controller instance a test started beside the harness's, on the same database, cache and keys. */
export interface ControllerInstance {
	/** Its configuration: the harness's, with the test's overrides. */
	configuration: ControllerConfiguration;

	/** Stops it, settling once its work has ended; stopping again does nothing. */
	stop(): Promise<void>;

	/** Its URL, ending in `/`. */
	url: URL;
}

/**
 * Starts another Controller instance through the seam, on the harness's configuration with the
 * overrides over it and each store's password apart from its URL ({@link passwordsApart}), its
 * `instanceName` the harness's with `-beside-` and a fresh suffix unless the overrides name one, and
 * defers its stop to the cleanup given. It registers no application: it serves those registered on
 * the shared database.
 *
 * @param scope the cleanup stopping it.
 * @param harness the harness whose database, cache, stand-in and keys it shares.
 * @param overrides fields over the harness's configuration.
 */
export const startInstance = async (
	scope: Cleanup,
	harness: Harness,
	overrides: Partial<ControllerConfiguration> = {},
): Promise<ControllerInstance> => {
	const configuration = passwordsApart({
		...harness.configuration,
		instanceName: `${harness.configuration.instanceName}-beside-${randomBytes(3).toString('hex')}`,
		...overrides,
	});
	await writeStartSettings(harness.clients.migration, harness.database.schema, storedSettingsOf(configuration));
	const running = await startController(configuration);
	const state = { stopped: false };
	const stop = async (): Promise<void> => {
		if (state.stopped) {
			return;
		}
		state.stopped = true;
		await running.stop();
	};
	scope.defer(stop);
	return { configuration, stop, url: withTrailingSlash(running.url) };
};

/**
 * Starts another Controller instance beside the harness's, as {@link startInstance} does, on the
 * database's read-only role ({@link TestDatabase.readOnlyUrl}): for the dry run of the EGO import,
 * which completes under a role that may only read (#216 Q16). Its start writes nothing, so it starts
 * once the harness's own Controller has started on the database and written what a start writes.
 *
 * @param scope the cleanup stopping it.
 * @param harness the harness whose database, cache, stand-in and keys it shares.
 * @param overrides fields over the harness's configuration.
 */
export const startReadOnlyInstance = async (
	scope: Cleanup,
	harness: Harness,
	overrides: Partial<ControllerConfiguration> = {},
): Promise<ControllerInstance> =>
	startInstance(scope, harness, {
		databaseUrl: await harness.database.readOnlyUrl(),
		...overrides,
	});

/**
 * Takes a snapshot of a running harness's store, as a backup is taken while the Controller serves:
 * every table's rows and every sequence's state, in one consistent read under the migration role.
 *
 * @param harness the harness.
 */
export const takeSnapshot = (harness: Harness): Promise<StoreSnapshot> =>
	takeStoreSnapshot(harness.clients.migration, harness.database.schema);

/**
 * Restores a snapshot as a restore's runbook does (#215 Q12, #217 Q3): the harness's Controller
 * stopped, the snapshot restored over the store, a new `notice_stream.epoch` written unless the test
 * keeps the snapshot's, and a Controller started again on the same configuration and port. Every
 * instance a test started beside the harness must be stopped first. A start refused is thrown, the
 * store restored all the same.
 *
 * @param harness the harness.
 * @param snapshot what {@link takeSnapshot} took.
 * @param options `epoch: 'kept'` to restore behind issued cursors with the epoch unchanged;
 *   `replaced`, the runbook's step, by default.
 */
export const restoreSnapshot = async (
	harness: Harness,
	snapshot: StoreSnapshot,
	{ epoch = 'replaced' }: { epoch?: 'kept' | 'replaced' } = {},
): Promise<void> => {
	await harness.stopController();
	await restoreStoreSnapshot(harness.clients.migration, snapshot);
	if (epoch === 'replaced') {
		await setEpoch(harness.clients.migration);
	}
	await harness.startController();
};
