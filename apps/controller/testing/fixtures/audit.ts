import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import {
	type AdminCaller,
	type AuditPage,
	auditPageOf,
	type AuditQuery,
	readAudit,
	stringsIn,
} from '../harness/admin.js';
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	type CloudEvent,
	cloudEventsIn,
	emittedType,
	jsonObjectOf,
	LOG_LEVEL_MEMBER,
	REFUSED_SUBJECT_MEMBER,
	SEVERITY_ATTRIBUTE,
	type Severity,
} from '../harness/auditEvents.js';
import { createChannelAssertion, importApplicationKey } from '../peripherals/bridgeWire.js';
import type { KeycloakRealmOptions } from '../harness/containers.js';
import {
	captureLog,
	type ControllerApplication,
	type ControllerConfiguration,
	type LogCapture,
} from '../harness/controller.js';
import { exchange, PEOPLE, type Person, type WireResponse } from '../harness/exchange.js';
import {
	type AdministratorTokenSource,
	type ControllerInstance,
	type Harness,
	type HarnessOptions,
	startInstance,
	suiteHarness,
	withHarness,
} from '../harness/harness.js';
import { type IdentityProvider, type MintOptions, SERVICE_ACCOUNT } from '../peripherals/identityProvider.js';
import {
	type FixtureDecision,
	type FixtureGrant,
	mergedPolicy,
	POLICY_TABLES,
	type PolicyFixture,
	qualified,
} from '../harness/policy.js';
import { type Cleanup, eventually, nowSeconds } from '../harness/waiting.js';

// The fixture and helpers of #214's tests alone: audit logging. Every path, table, column, person,
// problem code, reason and event registration they use comes from the shared support modules. The people are the shared cast: `owner` owns STUDY-A1 to STUDY-C3 and makes the consumer
// grants (#212 Q4), Ana, Bo, Cy, Dana and Eli hold or receive them, and the administrator is one by the
// management token's realm role alone.

/**
 * The application the audit tests exchange through unless they name another, by its display name,
 * which is its label in the fixture; `harness.application(SEARCH_PORTAL).id` is its id, which events
 * name it by.
 */
export const SEARCH_PORTAL = 'search-portal';

/** The second application, serving STUDY-B2 and STUDY-C3, by its display name. */
export const SUBMISSION_PORTAL = 'submission-portal';

/** The resources the fixture registers, by externalId. */
export const RESOURCES = Object.freeze({
	a1: 'STUDY-A1',
	b2: 'STUDY-B2',
	c3: 'STUDY-C3',
	d4: 'STUDY-D4',
});

/** The global category the consumer grants name, as the payload names it. */
export const CONTROLLED = 'global.controlled';

/** What a person accepting a `viewer` grant is shown, as `entity.action` names (the batch 1 addendum). */
export const VIEWER_CAPABILITIES: readonly string[] = Object.freeze(['record.count', 'record.export', 'record.view']);

/**
 * The grant rate threshold the rate tests run under: more than 3 operations by one actor within 30 s
 * (#214 Q19), a window no run's operations outlast.
 */
export const RATE_THRESHOLD: ControllerConfiguration['grantRateThreshold'] = Object.freeze({
	operationCount: 3,
	windowSeconds: 30,
});

/** The threshold the clock-boundary test runs under: more than 3 operations within 5 s. */
export const BOUNDARY_RATE_THRESHOLD: ControllerConfiguration['grantRateThreshold'] = Object.freeze({
	operationCount: 3,
	windowSeconds: 5,
});

/** A fixed code's form, as the Bridge's reasons and the API's problem codes take it: camelCase ASCII. */
export const FIXED_CODE = /^[a-z][A-Za-z0-9]*$/u;

/** The CloudEvents attributes an event carries, `severity` beside the standard's own (#214 Q2). */
export const ENVELOPE_ATTRIBUTES: readonly string[] = Object.freeze([
	'data',
	'id',
	SEVERITY_ATTRIBUTE,
	'source',
	'specversion',
	'time',
	'type',
]);

/** The properties `audit-events.md` names as recurring across entities, with `instance` (#214 Q17). */
export const RECURRING_PROPERTIES = Object.freeze({
	actorId: 'actorId',
	actorType: 'actorType',
	instance: 'instance',
	result: 'result',
	sourceIp: 'sourceIp',
});

/**
 * The observations among the Controller's events: noticed by the system, so carrying no `result` and,
 * being system-generated, no `sourceIp` (`audit-events.md` § Two families of event; #214 Q19).
 */
export const OBSERVATION_TYPES: readonly AuditEventType[] = Object.freeze([
	'admission.shareExceededTally',
	'applicationKey.confirmation',
	'applicationKey.unreadable',
	'channelAssertion.rejectionTally',
	'grant.rateExceeded',
	'logoutToken.refusalTally',
	'managementToken.refusalTally',
	'resource.orphaned',
	'token.exchangeRefusalTally',
]);

/** The severity each `result` gives an event whose row's severity follows it (#214 Q3). */
export const RESULT_SEVERITIES: Readonly<Record<string, Severity>> = Object.freeze({
	denied: 'warning',
	failed: 'error',
	succeeded: 'info',
});

/**
 * The management clients a configuration lists so a service account's token is read, and refused with
 * 403 rather than 401 as a credential.
 */
export const MANAGEMENT_CLIENTS_WITH_SERVICE_ACCOUNT: readonly string[] = Object.freeze([
	'usher-ui-test',
	SERVICE_ACCOUNT.clientId,
]);

const OWNED = Object.freeze([RESOURCES.a1, RESOURCES.b2, RESOURCES.c3]);

const ownerGrantName = (externalId: string): string => `owner:${externalId}`;

const FIXTURE_PEOPLE = Object.freeze(['ana', 'bo', 'cy', 'dana', 'eli', 'owner'] as const);

/**
 * The applications alone, serving nothing, for a test seeding nothing else before it starts its own
 * Controller: seeded by SQL under the fixture's ids, each is issued its first key once the harness's
 * own Controller first listens, and holds none until then.
 */
export const APPLICATIONS_ONLY: PolicyFixture = Object.freeze({
	applications: {
		[SEARCH_PORTAL]: { serves: [] },
		[SUBMISSION_PORTAL]: { serves: [] },
	},
});

/**
 * The audit fixture with a test's own policy over it: `controlled` a global category; STUDY-A1 open,
 * STUDY-B2 registered, STUDY-C3 grant and STUDY-D4 registered; `search-portal` serving STUDY-A1,
 * STUDY-B2 and STUDY-D4, `submission-portal` STUDY-B2 and STUDY-C3; Ana, Bo, Cy, Dana, Eli and the
 * owner of the shared cast; and the owner's accepted owner grants on STUDY-A1 to STUDY-C3, since a
 * consumer grant through the API is made by the resource's owner (#212 Q4). STUDY-D4 has no owner.
 *
 * @param policy the test's own entries, merged over the fixture's by name.
 */
export const auditPolicy = (policy: PolicyFixture = {}): PolicyFixture =>
	mergedPolicy(
		{
			applications: {
				[SEARCH_PORTAL]: {
					serves: [RESOURCES.a1, RESOURCES.b2, RESOURCES.d4],
				},
				[SUBMISSION_PORTAL]: { serves: [RESOURCES.b2, RESOURCES.c3] },
			},
			categories: { controlled: { description: 'Controlled access' } },
			decisions: OWNED.map((externalId): FixtureDecision => ({
				decision: 'accepted',
				grant: ownerGrantName(externalId),
			})),
			grants: Object.fromEntries(
				OWNED.map((externalId): [string, FixtureGrant] => [
					ownerGrantName(externalId),
					{
						category: null,
						holder: { user: 'owner' },
						resource: externalId,
						role: 'owner',
					},
				]),
			),
			resources: {
				[RESOURCES.a1]: { baseTier: 'open', name: 'Wastewater Survey A1' },
				[RESOURCES.b2]: { baseTier: 'registered', name: 'Cohort B2' },
				[RESOURCES.c3]: { baseTier: 'grant', name: 'Sealed Study C3' },
				[RESOURCES.d4]: { baseTier: 'registered', name: 'Unowned Study D4' },
			},
			users: Object.fromEntries(FIXTURE_PEOPLE.map((name) => [name, { subject: PEOPLE[name].subject }])),
		},
		policy,
	);

/**
 * A consumer grant on the controlled category for a fixture user, at `viewer` unless a role is named.
 *
 * @param user the holder's fixture name.
 * @param resource the resource's externalId.
 * @param options the role, and the grant's end.
 */
export const consumerGrant = (
	user: string,
	resource: string,
	{ expiresAt, role = 'viewer' }: { expiresAt?: Date; role?: string } = {},
): FixtureGrant => ({
	category: 'controlled',
	holder: { user },
	resource,
	role,
	...(expiresAt === undefined ? {} : { expiresAt }),
});

/**
 * A decision on a fixture grant by its holder.
 *
 * @param grant the fixture grant's name.
 * @param decision the answer: accepted by default.
 */
export const decided = (grant: string, decision: FixtureDecision['decision'] = 'accepted'): FixtureDecision => ({
	decision,
	grant,
});

/** What a test's Controller runs with, over the audit harness's own. */
export interface AuditHarnessOptions {
	/**
	 * Where the harness gets the platform administrator's token for registering its applications and
	 * issuing their first keys: the stand-in's by default, and a realm's own administrator's for a
	 * Controller trusting a Keycloak realm (`realmRegistrar`, in `harness.ts`).
	 */
	administratorToken?: AdministratorTokenSource;

	/** Fields over the harness's configuration. */
	configuration?: Partial<ControllerConfiguration>;

	/** The whole fixture: {@link auditPolicy}'s by default. */
	fixture?: PolicyFixture;

	/** A stand-in the test started itself, so the identity provider can fail before the start. */
	identityProvider?: IdentityProvider;

	/** Whether the harness starts a Controller: true by default. */
	startsController?: boolean;
}

/** A harness whose Controller writes its log stream where the test reads it. */
export interface AuditHarness {
	harness: Harness;
	log: LogCapture;
}

const harnessOptions = (
	log: LogCapture,
	{
		administratorToken,
		configuration = {},
		fixture = auditPolicy(),
		identityProvider,
		startsController = true,
	}: AuditHarnessOptions,
): HarnessOptions => ({
	...(administratorToken === undefined ? {} : { administratorToken }),
	applications: [SEARCH_PORTAL, SUBMISSION_PORTAL],
	configuration: { logStream: log.stream, ...configuration },
	fixture,
	startsController,
	...(identityProvider === undefined ? {} : { identityProvider }),
});

/**
 * Starts a harness on the audit fixture, its log stream captured, and runs a test's work against it.
 * Given the test's context, the harness stops once the test has ended, after anything the test
 * deferred later, such as an instance started on it; without one, as soon as the work settles.
 *
 * @param options the configuration over the harness's, the fixture, a stand-in and whether to start.
 * @param work the test's steps.
 * @param context the test's context, to stop the harness after the test's own cleanups.
 */
export const withAuditHarness = <Result>(
	options: AuditHarnessOptions,
	work: (audit: AuditHarness) => Promise<Result>,
	context?: TestContext,
): Promise<Result> => {
	const log = captureLog();
	return withHarness(harnessOptions(log, options), (harness) => work({ harness, log }), context);
};

/**
 * A harness on the audit fixture one suite's tests share, its log stream captured: started by the
 * first test asking, stopped once the suite's tests have ended. Call it in the suite's body.
 *
 * @param options the configuration over the harness's and the fixture.
 */
export const sharedAuditHarness = (options: AuditHarnessOptions = {}): (() => Promise<AuditHarness>) => {
	const log = captureLog();
	const shared = suiteHarness(harnessOptions(log, options));
	return async () => ({ harness: await shared(), log });
};

/** A second Controller instance a test started, with its own log stream. */
export interface LoggedInstance {
	instance: ControllerInstance;
	log: LogCapture;
}

/**
 * Starts another Controller instance beside the harness's, on its store and keys, its log stream
 * captured, its stop deferred to the cleanup given.
 *
 * @param scope the cleanup stopping it.
 * @param harness the harness it shares the store with.
 * @param overrides fields over the harness's configuration.
 */
export const startLoggedInstance = async (
	scope: Cleanup,
	harness: Harness,
	overrides: Partial<ControllerConfiguration> = {},
): Promise<LoggedInstance> => {
	const log = captureLog();
	const instance = await startInstance(scope, harness, {
		logStream: log.stream,
		...overrides,
	});
	return { instance, log };
};

/** One exchange as a test describes it. */
export interface ExchangeBy {
	/** The application exchanging, by display name: `search-portal` by default. */
	application?: string;

	/** A channel assertion sent in place of a fresh one. */
	assertion?: string;

	/** A credential sent in place of a fresh sign-in token for the person. */
	credential?: string;

	/** Claims and options over a fresh sign-in token's. */
	mint?: MintOptions;

	/** The instance exchanged with: the harness's Controller by default. */
	url?: URL;
}

/**
 * Sends one exchange as the Bridge sends it: the person's fresh sign-in token for the application, a
 * given one, or none for `null`, the anonymous exchange.
 *
 * @param harness the harness.
 * @param person who signs in, or `null`.
 * @param request the application, the credential, the assertion and the instance.
 */
export const exchangeBy = async (
	harness: Harness,
	person: Person | null,
	{ application = SEARCH_PORTAL, assertion, credential, mint = {}, url }: ExchangeBy = {},
): Promise<WireResponse> =>
	exchange(url ?? harness.url, {
		application: harness.application(application),
		...(assertion === undefined ? {} : { assertion }),
		credential: credential ?? (person === null ? null : await harness.tokens.signIn(person, { application, mint })),
	});

export const expiredClaims = (): MintOptions => {
	const now = nowSeconds();
	return { claims: { exp: now - 3600, iat: now - 3900 } };
};

/**
 * A channel assertion the application signed normally, as the Bridge signs one, ten minutes ago, so it
 * has long expired: a channel credential the Controller refuses with no forged signature.
 *
 * @param application the application signing.
 */
export const expiredAssertion = async (application: ControllerApplication): Promise<string> => {
	const { channelAssertionKey } = await importApplicationKey(application.key);
	return createChannelAssertion({
		application: application.id,
		assertionKey: channelAssertionKey,
		wallClock: { now: () => Date.now() - 10 * 60_000 },
	})();
};

/**
 * An instant a duration from now, as the API takes one.
 *
 * @param milliseconds the duration; negative for the past.
 */
export const instantIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

/**
 * An instant written at a numeric offset from UTC, as RFC 3339 permits and `audit-events.md` narrows
 * away: the same instant, its wall time shifted by the offset.
 *
 * @param instant the instant, in milliseconds since the Unix epoch.
 * @param offsetMinutes the offset east of UTC, in minutes.
 */
export const atOffset = (instant: number, offsetMinutes: number): string => {
	const sign = offsetMinutes < 0 ? '-' : '+';
	const magnitude = Math.abs(offsetMinutes);
	const hours = String(Math.floor(magnitude / 60)).padStart(2, '0');
	const minutes = String(magnitude % 60).padStart(2, '0');
	return new Date(instant + offsetMinutes * 60_000).toISOString().replace('Z', `${sign}${hours}:${minutes}`);
};

/**
 * A key ordering RFC 3339 UTC times to the nanosecond, whatever fraction each carries.
 *
 * @param time a `time` as an event carries it.
 * @throws when the time is not in UTC with the `Z` designator.
 */
export const timeKey = (time: string): string => {
	const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u.exec(time);
	if (matched?.[1] !== undefined) {
		return `${matched[1]}.${(matched[2] ?? '').padEnd(9, '0').slice(0, 9)}`;
	}
	throw new Error(`${time} is not an RFC 3339 time in UTC`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An event's `data`, as a log line or an answer of the audit log carries it, failing the test unless
 * it is a JSON object.
 *
 * @param event the event.
 */
export const dataOf = (event: { readonly data?: unknown }): Readonly<Record<string, unknown>> =>
	isRecord(event.data) ? event.data : assert.fail("an event's data is not an object");

/**
 * The events among the lines a log stream holds, from a mark on.
 *
 * @param log the captured log stream.
 * @param since how many lines to pass over: none by default.
 */
export const eventsIn = (log: LogCapture, since: number = 0): readonly CloudEvent[] =>
	cloudEventsIn(log.lines().slice(since));

/**
 * The events of one type, as the table names it.
 *
 * @param events the events.
 * @param type the event type, without the prefix.
 */
export const ofType = (events: readonly CloudEvent[], type: AuditEventType): readonly CloudEvent[] =>
	events.filter((event) => event.type === emittedType(type));

/** Where a wait reads from, and for how long. */
export interface AwaitOptions {
	/** Lines to pass over: none by default. */
	since?: number;

	/** The longest wait: 10 s by default. */
	timeoutMs?: number;
}

/**
 * Waits until the log stream's events satisfy a condition, failing the test if they never do, and
 * gives them.
 *
 * @param log the captured log stream.
 * @param condition what the events must satisfy.
 * @param options the mark and the timeout.
 */
export const awaitEvents = async (
	log: LogCapture,
	condition: (events: readonly CloudEvent[]) => boolean,
	{ since = 0, timeoutMs = 10_000 }: AwaitOptions = {},
): Promise<readonly CloudEvent[]> => {
	const held = await eventually(async () => condition(eventsIn(log, since)), timeoutMs);
	assert.ok(held, 'the events awaited never reached the log stream');
	return eventsIn(log, since);
};

/**
 * Waits until the log stream holds at least a number of events of one type, and gives those.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param options how many, the mark and the timeout.
 */
export const awaitEventsOfType = async (
	log: LogCapture,
	type: AuditEventType,
	{ count = 1, ...options }: AwaitOptions & { count?: number } = {},
): Promise<readonly CloudEvent[]> =>
	ofType(await awaitEvents(log, (events) => ofType(events, type).length >= count, options), type);

/**
 * The one event of a type the log stream holds from a mark on, waited for, failing the test unless
 * exactly one arrives.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param options the mark and the timeout.
 */
export const awaitOneEvent = async (
	log: LogCapture,
	type: AuditEventType,
	options: AwaitOptions = {},
): Promise<CloudEvent> => {
	const [event, ...more] = await awaitEventsOfType(log, type, options);
	assert.equal(more.length, 0, `more than one ${type} was recorded`);
	return event ?? assert.fail(`no ${type} was recorded`);
};

/**
 * The one event of a type whose `data` satisfies a condition, waited for, failing the test unless
 * exactly one such event arrives.
 *
 * @param log the captured log stream.
 * @param type the event type, without the prefix.
 * @param matches what its `data` must satisfy, such as naming a grant.
 * @param options the mark and the timeout.
 */
export const awaitEventWhere = async (
	log: LogCapture,
	type: AuditEventType,
	matches: (data: Readonly<Record<string, unknown>>) => boolean,
	options: AwaitOptions = {},
): Promise<CloudEvent> => {
	const matching = (events: readonly CloudEvent[]): readonly CloudEvent[] =>
		ofType(events, type).filter((event) => matches(dataOf(event)));
	const [event, ...more] = matching(await awaitEvents(log, (events) => matching(events).length > 0, options));
	assert.equal(more.length, 0, `more than one matching ${type} was recorded`);
	return event ?? assert.fail(`no matching ${type} was recorded`);
};

/**
 * A condition on an event's `data`: that it names a grant by id.
 *
 * @param grantId the grant's id.
 */
export const namingGrant =
	(grantId: string | undefined): ((data: Readonly<Record<string, unknown>>) => boolean) =>
	(data) =>
		grantId !== undefined && data['grantId'] === grantId;

/**
 * The log stream's operational lines: every line carrying no CloudEvents envelope.
 *
 * @param log the captured log stream.
 */
export const operationalLines = (log: LogCapture): readonly string[] =>
	log.lines().filter((line) => cloudEventsIn([line]).length === 0);

/**
 * How many lines a log stream holds now, as a mark a later read passes over.
 *
 * @param log the captured log stream.
 */
export const markOf = (log: LogCapture): number => log.lines().length;

/**
 * A mark after the first keys the harness issued once its own Controller first listened, for a
 * harness whose applications were all seeded by SQL before it, as {@link APPLICATIONS_ONLY}'s are: it
 * waits until the log stream holds one `applicationKey.issuance` for each of the harness's
 * applications, so a test marking after the harness's first listen reads only the events of its own
 * act.
 *
 * @param log the captured log stream.
 * @param harness the harness, its Controller listening.
 */
export const markAfterFirstKeys = async (log: LogCapture, harness: Harness): Promise<number> => {
	await awaitEventsOfType(log, AUDIT_EVENT_TYPES.applicationKeyIssuance, {
		count: harness.applications.length,
	});
	return markOf(log);
};

/** One `audit_log` row as a test reads it. */
export interface AuditRow {
	data: unknown;
	dataschema: string | null;
	id: string;

	/** `occurred_at`, to the store's microsecond, as {@link timeKey} writes an event's `time`. */
	occurredAtKey: string;

	severity: unknown;
	source: string;
	specversion: string;
	type: string;
}

const quoted = (name: string): string => pg.escapeIdentifier(name);

/**
 * Every `audit_log` row, ordered by when it occurred and then by id.
 *
 * @param client a connection under the migration role.
 */
export const auditRows = async (client: pg.ClientBase): Promise<readonly AuditRow[]> => {
	const { columns } = POLICY_TABLES.auditLog;
	const { rows } = await client.query<AuditRow>(
		`SELECT ${quoted(columns.data)} AS data, ${quoted(columns.dataSchema)} AS dataschema, ${quoted(columns.id)}::text AS id, to_char(${quoted(columns.occurredAt)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '000' AS "occurredAtKey", ${quoted(columns.severity)} AS severity, ${quoted(columns.source)} AS source, ${quoted(columns.specVersion)} AS specversion, ${quoted(columns.type)} AS type FROM ${qualified(POLICY_TABLES.auditLog)} ORDER BY ${quoted(columns.occurredAt)}, ${quoted(columns.id)}`,
	);
	return rows;
};

/**
 * A row's `data`, failing the test unless it is a JSON object.
 *
 * @param row the row.
 */
export const rowDataOf = (row: AuditRow): Readonly<Record<string, unknown>> =>
	isRecord(row.data) ? row.data : assert.fail("a row's data is not an object");

/**
 * The `audit_log` rows of one type.
 *
 * @param client a connection under the migration role.
 * @param type the event type, without the prefix.
 */
export const auditRowsOfType = async (client: pg.ClientBase, type: AuditEventType): Promise<readonly AuditRow[]> =>
	(await auditRows(client)).filter((row) => row.type === emittedType(type));

/**
 * The `audit_log` row holding an event, by the event's id, failing the test unless exactly one does.
 *
 * @param rows the rows.
 * @param event the event.
 */
export const rowOf = (rows: readonly AuditRow[], event: CloudEvent): AuditRow => {
	const held = rows.filter((row) => row.id === event.id);
	assert.equal(held.length, 1, `audit_log holds ${held.length} rows by one event's id`);
	return held[0] ?? assert.fail('no row holds the event');
};

const parsedOrNothing = (line: string): unknown => {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutRefusedSubject = (data: unknown): unknown =>
	isPlainObject(data)
		? Object.fromEntries(Object.entries(data).filter(([member]) => member !== REFUSED_SUBJECT_MEMBER))
		: data;

const lineWithoutRefusedSubject = (line: string): string => {
	const parsed = parsedOrNothing(line);
	return isPlainObject(parsed) &&
		isPlainObject(parsed['data']) &&
		Object.hasOwn(parsed['data'], REFUSED_SUBJECT_MEMBER)
		? JSON.stringify({ ...parsed, data: withoutRefusedSubject(parsed['data']) })
		: line;
};

/**
 * The trail as {@link recordedTexts} gives it, each event's `refusedSubject` left out of its log line
 * and its row alike: for a scan forbidding a token's values everywhere but the one member that names a
 * verified token's subject by rule, so it still forbids them, addresses included, in every other
 * member, line and row.
 *
 * @param lines the log stream's lines.
 * @param rows the `audit_log` rows.
 */
export const recordedTextsBesideRefusedSubjects = (
	lines: readonly string[],
	rows: readonly AuditRow[],
): readonly string[] =>
	recordedTexts(
		lines.map(lineWithoutRefusedSubject),
		rows.map((row) => ({ ...row, data: withoutRefusedSubject(row.data) })),
	);

/**
 * Everything a reader of the trail sees: each log line as written, every member and value each line
 * holds, and every column and `data` value of every row.
 *
 * @param lines the log stream's lines.
 * @param rows the `audit_log` rows.
 */
export const recordedTexts = (lines: readonly string[], rows: readonly AuditRow[]): readonly string[] => [
	...lines,
	...lines.flatMap((line) => stringsIn(parsedOrNothing(line))),
	...rows.flatMap((row) => [
		row.id,
		row.source,
		row.specversion,
		row.type,
		String(row.severity),
		row.dataschema ?? '',
		...stringsIn(row.data),
	]),
];

/**
 * The values among those given that appear in any recorded text, empty ones left out.
 *
 * @param values what must never appear.
 * @param texts what was recorded, from {@link recordedTexts}.
 * @param options whether letter case is ignored: false by default.
 */
export const valuesFound = (
	values: readonly string[],
	texts: readonly string[],
	{ ignoreCase = false }: { ignoreCase?: boolean } = {},
): readonly string[] => {
	const folded = (text: string): string => (ignoreCase ? text.toLowerCase() : text);
	const searched = texts.map(folded);
	return values
		.filter((value) => value.length > 0)
		.filter((value) => searched.some((text) => text.includes(folded(value))));
};

/**
 * How many unrevoked grants a person holds on a resource, by the store.
 *
 * @param client a connection under the migration role.
 * @param subject the holder's subject.
 * @param externalId the resource.
 */
export const liveGrantCount = async (client: pg.ClientBase, subject: string, externalId: string): Promise<number> => {
	const { grants, resources, userIdentities } = POLICY_TABLES;
	const { rows } = await client.query<{ count: number }>(
		`SELECT count(*)::int AS count
       FROM ${qualified(grants)} held
       JOIN ${qualified(userIdentities)} holder ON holder.${quoted(userIdentities.columns.userId)} = held.${quoted(grants.columns.holderUserId)}
       JOIN ${qualified(resources)} resource ON resource.${quoted(resources.columns.id)} = held.${quoted(grants.columns.resourceId)}
      WHERE holder.${quoted(userIdentities.columns.idpSubjectId)} = $1
        AND resource.${quoted(resources.columns.externalId)} = $2
        AND held.${quoted(grants.columns.revokedAt)} IS NULL`,
		[subject, externalId],
	);
	return rows[0]?.count ?? 0;
};

/**
 * A grant's end and its revocation, by the store.
 *
 * @param client a connection under the migration role.
 * @param grantId the grant's id.
 * @throws when no grant has that id.
 */
export const storedGrant = async (
	client: pg.ClientBase,
	grantId: string,
): Promise<{ expiresAt: Date | null; revokedAt: Date | null }> => {
	const { grants } = POLICY_TABLES;
	const { rows } = await client.query<{
		expiresAt: Date | null;
		revokedAt: Date | null;
	}>(
		`SELECT ${quoted(grants.columns.expiresAt)} AS "expiresAt", ${quoted(grants.columns.revokedAt)} AS "revokedAt" FROM ${qualified(grants)} WHERE ${quoted(grants.columns.id)}::text = $1`,
		[grantId],
	);
	const [row] = rows;
	if (row !== undefined) {
		return row;
	}
	throw new Error('no grant has that id');
};

/**
 * The externalIds of the resources the store holds by an externalId in any letter case.
 *
 * @param client a connection under the migration role.
 * @param externalId the externalId.
 */
export const resourcesNamed = async (client: pg.ClientBase, externalId: string): Promise<readonly string[]> => {
	const { resources } = POLICY_TABLES;
	const { rows } = await client.query<{ externalId: string }>(
		`SELECT ${quoted(resources.columns.externalId)} AS "externalId" FROM ${qualified(resources)} WHERE lower(${quoted(resources.columns.externalId)}) = lower($1)`,
		[externalId],
	);
	return rows.map((row) => row.externalId);
};

/**
 * When a resource was retired, by the store, or `null` while it is not.
 *
 * @param client a connection under the migration role.
 * @param externalId the resource.
 * @throws when no resource has that externalId.
 */
export const retiredAt = async (client: pg.ClientBase, externalId: string): Promise<Date | null> => {
	const { resources } = POLICY_TABLES;
	const { rows } = await client.query<{ retiredAt: Date | null }>(
		`SELECT ${quoted(resources.columns.retiredAt)} AS "retiredAt" FROM ${qualified(resources)} WHERE ${quoted(resources.columns.externalId)} = $1`,
		[externalId],
	);
	const [row] = rows;
	if (row !== undefined) {
		return row.retiredAt;
	}
	throw new Error('no resource has that externalId');
};

/**
 * How many principal revocations name a person, lifted or not, by the store.
 *
 * @param client a connection under the migration role.
 * @param subject the person's subject.
 */
export const principalRevocationCount = async (client: pg.ClientBase, subject: string): Promise<number> => {
	const { principalRevocations, userIdentities } = POLICY_TABLES;
	const { rows } = await client.query<{ count: number }>(
		`SELECT count(*)::int AS count
       FROM ${qualified(principalRevocations)} revocation
       JOIN ${qualified(userIdentities)} revoked ON revoked.${quoted(userIdentities.columns.userId)} = revocation.${quoted(principalRevocations.columns.userId)}
      WHERE revoked.${quoted(userIdentities.columns.idpSubjectId)} = $1`,
		[subject],
	);
	return rows[0]?.count ?? 0;
};

/**
 * Grants or revokes one privilege on `audit_log` for the Controller's runtime role, as the schema's
 * owner, for the integrity tests.
 *
 * @param client a connection under the migration role.
 * @param change `GRANT` or `REVOKE`.
 * @param privilege the privilege.
 * @param runtimeRole the runtime role's name.
 */
export const changeAuditPrivilege = async (
	client: pg.ClientBase,
	change: 'GRANT' | 'REVOKE',
	privilege: 'DELETE' | 'INSERT' | 'UPDATE',
	runtimeRole: string,
): Promise<void> => {
	const direction = change === 'GRANT' ? 'TO' : 'FROM';
	await client.query(
		`${change} ${privilege} ON ${qualified(POLICY_TABLES.auditLog)} ${direction} ${quoted(runtimeRole)}`,
	);
};

/** How {@link readEveryAuditPage} pages. */
export interface PagingOptions {
	/** Work done after each page but the last, such as writing events while the pages are read. */
	between?: () => Promise<void>;

	/** The most pages read: 200 by default. */
	maximumPages?: number;
}

/**
 * Reads every page of the audit log for a query, following each page's cursor, failing the test past
 * a number of pages. Unless the query bounds it, every read is bounded by a `to` taken before the
 * first, so the reads' own `audit.read` events and anything written meanwhile cannot extend it.
 *
 * @param caller the administrator's caller.
 * @param query the filters and the page size.
 * @param options work between pages, and the most pages read.
 */
export const readEveryAuditPage = async (
	caller: AdminCaller,
	query: AuditQuery,
	{ between, maximumPages = 200 }: PagingOptions = {},
): Promise<readonly AuditPage[]> => {
	const bounded: AuditQuery = { to: new Date().toISOString(), ...query };
	const from = async (cursor: string | undefined, remaining: number): Promise<readonly AuditPage[]> => {
		assert.ok(remaining > 0, 'the audit log kept answering further pages');
		const page = auditPageOf(
			await readAudit(caller, {
				...bounded,
				...(cursor === undefined ? {} : { cursor }),
			}),
		);
		if (page.next === undefined || page.events.length === 0) {
			return [page];
		}
		await between?.();
		return [page, ...(await from(page.next, remaining - 1))];
	};
	return from(undefined, maximumPages);
};

const WARNING_LEVELS: ReadonlySet<string> = new Set(['critical', 'error', 'fatal', 'warn', 'warning']);

// The numeric levels common loggers write, pino's among them: 40 is warn.
const LOWEST_NUMERIC_WARNING = 40;

/**
 * Whether a log line is at the warning level or above: an event by its severity, any other line by
 * its logger's level, named or numbered as common loggers write it. How the Controller's logger writes
 * its level is not fixed: an assumption for the README's table, beside `auditEvents.ts`'s `LOG_LEVEL_MEMBER`.
 *
 * @param line a log line.
 */
export const atWarningOrAbove = (line: string): boolean => {
	const value = jsonObjectOf(line);
	const level = value[SEVERITY_ATTRIBUTE] ?? value[LOG_LEVEL_MEMBER];
	return typeof level === 'number'
		? level >= LOWEST_NUMERIC_WARNING
		: WARNING_LEVELS.has(String(level).toLowerCase());
};

/**
 * Waits until a wall-clock instant, for the tests whose operations fall at set times.
 *
 * @param instant milliseconds since the Unix epoch.
 */
export const untilInstant = async (instant: number): Promise<void> => {
	const remaining = instant - Date.now();
	if (remaining > 0) {
		await delay(remaining);
	}
};

const freshSecret = (): string => randomBytes(24).toString('base64url');

/** The person a real Keycloak's realm holds as the administrator, signing in through the management client. */
export const KEYCLOAK_ADMINISTRATOR = Object.freeze({
	email: 'admin.one@example.org',
	username: 'admin.one@example.org',
});

/**
 * A realm for telling a person's token from a service account's on a real Keycloak (#214 Q16): the
 * management client `usher-ui-test`, public, its tokens naming the management API through an audience
 * mapper; `lyric-svc`, confidential with a service account, its tokens naming the management API the
 * same way; and the administrator holding the first-user role, which marks the person the harness
 * seeds as an administrator once signed in.
 *
 * @param options the first-user role and the management API's audience: the harness's by default.
 */
export const serviceAccountRealm = ({
	firstUserRole = 'usher-first-user',
	managementAudience = 'usher-management-test',
}: {
	firstUserRole?: string;
	managementAudience?: string;
} = {}): KeycloakRealmOptions => ({
	clients: [
		{ audiences: [managementAudience], clientId: 'usher-ui-test' },
		{
			audiences: [managementAudience],
			clientId: SERVICE_ACCOUNT.clientId,
			secret: freshSecret(),
		},
	],
	people: [
		{
			...KEYCLOAK_ADMINISTRATOR,
			password: freshSecret(),
			realmRoles: [firstUserRole],
		},
	],
	realm: 'usher-test',
	realmRoles: [firstUserRole],
});
