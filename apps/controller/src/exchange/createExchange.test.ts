import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { suite, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS } from '@overture-stack/usher-types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import pg from 'pg';

import { createAdmission } from '../admission/index.js';
import { applicationSubkeys } from '../applicationKeyRing/index.js';
import {
	type ChannelAssertionCheck,
	createAssertionRefusals,
	createRefusedAssertions,
} from '../channelAssertion/index.js';
import {
	type Actor,
	type AuditEvent,
	type AuditTransaction,
	createAuditTrail,
	createEventLog,
	type LineFields,
	type TransactionOptions,
} from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { SignInJudgement, StoredRefusal } from '../signInTokens/index.js';
import { COMMIT_WINDOW_MILLISECONDS, CommitUnconfirmed, type Deadline } from '../storeTimeout/index.js';
import type { ReachingGrant, ServedResource } from '../tokenCalculation/index.js';
import { createWindowedRefusals } from '../windowedRefusals/index.js';
import {
	createExchange,
	EXCHANGE_PATH,
	EXCHANGE_REQUEST_TIMEOUT,
	EXCHANGE_STORE_FAILED,
	EXCHANGE_TOKEN_OVER_RESPONSE_CAP,
	EXCHANGE_UNEXPECTED_FAILURE,
	LATE_REQUEST_THRESHOLD_MILLISECONDS,
	MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS,
	RECORDING_RESERVE_MILLISECONDS,
} from './createExchange.js';
import { exchangeRefusalTallyEvent } from './exchangeEvents.js';
import { TOKEN_LIMIT_BYTES } from './exchangeProblems.js';
import type { CredentialJudge, ExchangeKey } from './types.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0, 750);

// Long enough for an answer given from memory, and far shorter than any wait on the store.
const ANSWER_WITHIN_MS = 1000;

// How far past the moment it is due an answer may come, for the timers and the event loop to run.
const SCHEDULING_SLACK_MS = 200;

const SECONDS = Math.floor(NOW / 1000);

const APPLICATION = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const KEY_SUBKEYS = applicationSubkeys(randomBytes(32));

const KEY: ExchangeKey = {
	applicationId: APPLICATION,
	keyId: '6a1e9c3b-2f4d-4b8a-9c7e-1d5f3a8b2e90',
	token: KEY_SUBKEYS.token,
};

const IDENTITY_PROVIDER = 'https://keycloak.example.org/realms/overture';

const SERVICE_ACCOUNT_ROLE = 'usher-service-account';

const SETTINGS = Object.freeze({
	clock: { now: () => NOW },
	databaseSchema: 'usher',
	identityProviderIssuer: IDENTITY_PROVIDER,
	issuer: 'https://usher.example.org',
	serviceAccountRole: SERVICE_ACCOUNT_ROLE,
	tokenLifetimeSeconds: 300,
});

// The grant rules the store holds in the policy's one read: everyone's count, view and export on open
// resources' unmarked records, and signed-in principals' view on registered ones.
const GRANT_RULES = [
	{
		resources: [
			{
				accessLevel: 'open',
				categories: [{ actions: ['count', 'view', 'export'], name: 'global.unmarked' }],
			},
		],
		to: 'everyone',
	},
	{
		resources: [
			{
				accessLevel: 'registered',
				categories: [{ actions: ['view'], name: 'global.unmarked' }],
			},
		],
		to: 'signedIn',
	},
];

// Opaque text standing for assertions and credentials: the stand gives each its check or its
// judgement, so nothing here is read as a token.
const ASSERTIONS: Readonly<Record<string, ChannelAssertionCheck<ExchangeKey>>> = {
	'Bearer assertion-expired': {
		applicationId: APPLICATION,
		kind: 'refused',
		reason: 'expiredAssertion',
		signingInputDigest: 'digest-of-the-expired-assertion',
	},
	'Bearer assertion-for-another-audience': {
		applicationId: APPLICATION,
		kind: 'refused',
		reason: 'otherAudience',
		signingInputDigest: 'digest-of-the-assertion-for-another-audience',
	},
	'Bearer assertion-of-a-keyless-application': {
		applicationId: APPLICATION,
		kind: 'unverified',
		reason: 'noLiveKey',
	},
	'Bearer assertion-verified': {
		assertion: {
			acceptedUntil: NOW + 60_000,
			id: 'jti-1',
			key: KEY,
			signingInputDigest: 'digest-of-the-verified-assertion',
		},
		kind: 'verified',
	},
};

const VERIFIED = 'Bearer assertion-verified';

const ACCEPTED = {
	claims: {
		aud: [APPLICATION],
		exp: SECONDS + 300,
		preferred_username: 'ana@example.org',
		realm_access: { roles: ['offline_access'] },
		sub: 'subject-ana',
	},
	expiresAt: SECONDS + 300,
	kind: 'accepted',
	session: { issuedAt: SECONDS - 10, sid: 'session-1' },
	subject: 'subject-ana',
} satisfies SignInJudgement;

// An accepted judgement whose verified claims carry the departures given.
const acceptedWith = (departures: Readonly<Record<string, unknown>>): SignInJudgement => ({
	...ACCEPTED,
	claims: { ...ACCEPTED.claims, ...departures },
});

// An accepted judgement whose sign-in token expires at the second given.
const expiringAt = (expiresAt: number): SignInJudgement => ({
	...ACCEPTED,
	claims: { ...ACCEPTED.claims, exp: expiresAt },
	expiresAt,
});

// Each of a service account's marks, on a token the judgement accepts.
const SERVICE_ACCOUNT_MARKS: Readonly<Record<string, SignInJudgement>> = {
	'credential-of-a-client': acceptedWith({ client_id: 'lyric-svc' }),
	'credential-of-a-service-account-user': acceptedWith({
		preferred_username: 'service-account-lyric-svc',
	}),
	'credential-of-the-service-account-role': acceptedWith({
		realm_access: { roles: ['offline_access', SERVICE_ACCOUNT_ROLE] },
	}),
};

const JUDGEMENTS: Readonly<Record<string, SignInJudgement>> = {
	'': { kind: 'recorded', reason: 'missingCredential' },
	'credential-accepted': ACCEPTED,
	'credential-expiring-a-second-after-issue': expiringAt(SECONDS + 1),
	'credential-expiring-as-issued': expiringAt(SECONDS),
	'credential-of-no-session': { ...ACCEPTED, session: {} },
	'credential-expired': {
		kind: 'recorded',
		reason: 'expiredToken',
		refusedSubject: 'subject "ana" \\',
	},
	'credential-forged': { kind: 'recorded', reason: 'invalidSignature' },
	'credential-forged-otherwise': {
		kind: 'recorded',
		reason: 'invalidSignature',
	},
	'credential-while-keys-unavailable': { kind: 'keysUnavailable' },
	'credential-under-a-new-key': {
		kind: 'signingKeyUnconfirmed',
		retryAfterSeconds: 17,
	},
	uak_example: { kind: 'recorded', reason: 'apiKeyVerifierNotConfigured' },
	...SERVICE_ACCOUNT_MARKS,
};

// The audience's policy as one read gives it: an open resource holding a category of its own, an open
// one, one open but suppressed, one registered and one retired.
const SERVED: readonly ServedResource[] = [
	{
		baseTier: 'open',
		externalId: 'STUDY-A1',
		ownCategories: ['local-panel'],
		retired: false,
		suppressed: false,
	},
	{
		baseTier: 'open',
		externalId: 'étude « Nord » "B2"',
		ownCategories: [],
		retired: false,
		suppressed: false,
	},
	{
		baseTier: 'open',
		externalId: 'STUDY-F6',
		ownCategories: [],
		retired: false,
		suppressed: true,
	},
	{
		baseTier: 'registered',
		externalId: 'STUDY-C3',
		ownCategories: [],
		retired: false,
		suppressed: false,
	},
	{
		baseTier: 'open',
		externalId: 'STUDY-E5',
		ownCategories: [],
		retired: true,
		suppressed: false,
	},
];

const POLICY_ROW = {
	globalCategories: ['community-governed', 'controlled', 'unmarked'],
	grantRules: GRANT_RULES,
	grants: [],
	served: SERVED,
};

// The person the stand's store records on meeting a subject for the first time.
const PERSON_ID = '4e8b1c2d-7a3f-4b9e-8d6c-5f2a1e9b3c70';

// A principal's standing as the store answers it: refused for the reason given, or for none.
const standingRow = (refusal: StoredRefusal | undefined) => ({
	revoked: refusal === 'revokedPrincipal',
	revokedPlatform: refusal === 'revokedPlatform',
	signedOut: refusal === 'signedOutSession',
});

// What the stand's store reads for a statement: a principal's standing, a person recorded on meeting
// them first, the audience's policy with the grants given as those reaching the principal, or no row,
// as it finds no person and inserts a session.
const rowsAnswering = (
	text: string,
	refusal: StoredRefusal | undefined,
	grants: readonly ReachingGrant[] = [],
	grantRules: unknown = POLICY_ROW.grantRules,
): readonly unknown[] => {
	if (text.includes('principal_revocations')) {
		return [standingRow(refusal)];
	}
	if (text.includes('RETURNING id')) {
		return [{ id: PERSON_ID }];
	}
	return text.includes('application_resources') ? [{ ...POLICY_ROW, grantRules, grants }] : [];
};

// What each statement the exchange sent reads or writes, by its text: a principal's standing, a
// person, the audience's policy, or a session exchanged.
const statementKindOf = (text: string): string => {
	if (text.includes('principal_revocations')) {
		return 'standing';
	}
	if (text.includes('exchanged_sids')) {
		return 'session';
	}
	return text.includes('application_resources') ? 'policy' : 'person';
};

// The kinds of a transaction's statements in order, each run of one kind named once.
const statementKindsIn = ({ statements }: Pick<Transaction, 'statements'>): readonly string[] =>
	statements.map(({ text }) => statementKindOf(text)).filter((kind, at, kinds) => kinds[at - 1] !== kind);

const ANONYMOUS_PAYLOAD = {
	aud: APPLICATION,
	exp: SECONDS + 300,
	generatedAt: SECONDS,
	globalCategories: ['global.community-governed', 'global.controlled'],
	iat: SECONDS,
	iss: 'https://usher.example.org',
	payloadVersion: 1,
	permissions: {
		'STUDY-A1': { 'global.unmarked': { record: ['count', 'view', 'export'] } },
		'étude « Nord » "B2"': {
			'global.unmarked': { record: ['count', 'view', 'export'] },
		},
	},
	resourceCategories: {
		'STUDY-A1': ['resource.local-panel'],
		'étude « Nord » "B2"': [],
	},
	servedResources: ['STUDY-A1', 'étude « Nord » "B2"', 'STUDY-F6', 'STUDY-C3'],
	sub: null,
};

// The anonymous visitor's payload, with the registered resource's unmarked records under the
// signed-in rule, for the identity provider's subject.
const SIGNED_IN_PAYLOAD = {
	...ANONYMOUS_PAYLOAD,
	permissions: {
		...ANONYMOUS_PAYLOAD.permissions,
		'STUDY-C3': { 'global.unmarked': { record: ['view'] } },
	},
	resourceCategories: {
		...ANONYMOUS_PAYLOAD.resourceCategories,
		'STUDY-C3': [],
	},
	sub: 'subject-ana',
};

interface Deferred {
	promise: Promise<void>;
	release(): void;
}

const deferred = (): Deferred => {
	const held: { release: () => void } = { release: () => undefined };
	const promise = new Promise<void>((resolve) => {
		held.release = resolve;
	});
	return { promise, release: () => held.release() };
};

interface Line {
	fields: LineFields | undefined;
	message: string;
}

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

/** One transaction the stand ran: its actor, its options, its statements, and the events recorded in it. */
interface Transaction {
	actor: Actor;
	options: TransactionOptions | undefined;
	recorded: AuditEvent[];
	statements: Statement[];
}

interface Stand {
	/** The events closing the windows refused credentials were counted in, each with its actor. */
	closings: { actor: Actor; event: AuditEvent }[];

	/** Closes every window refused credentials are counted in, settling once each closing is recorded. */
	closeWindows(): Promise<void>;

	/** Each key the exchange asked to confirm, with the address of the request asking, as its confirmation settled. */
	confirmed: { applicationId: string; keyId: string; sourceIp: string }[];

	/** The deadline given with each key's confirmation, as it was asked for. */
	confirmationDeadlines: (Deadline | undefined)[];

	counted: { applicationId: string | undefined; reason: string }[];

	/** The application each exchange refused over its share was counted for, in order. */
	countedOverShare: string[];

	/** How many exchanges the stand's admission holds in flight now. */
	inFlight(): number;

	judged: { audience: string; credential: string; now: number }[];

	/** The lines written at error. */
	lines: Line[];

	/** The events recorded outside any transaction, each with its actor. */
	outside: { actor: Actor; event: AuditEvent }[];

	server: FastifyInstance;
	stop(): Promise<void>;

	/** Every transaction begun, whether or not it committed. */
	transactions: Transaction[];

	/** The lines written at warning. */
	warnings: Line[];
}

interface StandOptions {
	/** What the transaction throws once its work has run, as a store failing at its commit does. */
	commitFailure?: unknown;

	/** Settles when a key's confirmation does: at once by default. */
	confirmationSettled?: Promise<void>;

	/** The exchange's deadline: the Controller's own by default. */
	deadlineMilliseconds?: number;

	/**
	 * The late-request threshold: the Controller's own by default. A test shortening the deadline to
	 * reach the store's bound within it names a shorter one, so its request is not answered as late.
	 */
	lateRequestThresholdMilliseconds?: number;

	/** The grant rules the store holds for the audience: the baseline the policy row carries by default. */
	grantRules?: unknown;

	/** The grants the store reads as reaching a signed-in principal: none by default. */
	grants?: readonly ReachingGrant[];

	/** Judges each credential in place of the stand's own judgements. */
	judge?: CredentialJudge;

	/** Settles when a refused assertion's recording, outside any exchange's transaction, is written: at once by default. */
	outsideRecorded?: Promise<void>;

	/**
	 * How many connections the exchange pool holds, which the admission divides among the registered
	 * applications: 10 by default.
	 */
	poolSize?: number;

	/** What the store's read throws, as a store failing within the transaction does. */
	readFailure?: unknown;

	/** How many applications are registered: 1 by default, so the application's share is the pool. */
	registered?: number;

	/** Why the store refuses every principal whose standing is read: for no reason by default. */
	standing?: StoredRefusal;

	/** Settles when the store takes each transaction begun, its work waiting until then: at once by default. */
	storeTakes?: Promise<void>;

	/** The most bytes a token answered may hold: the Controller's own limit by default. */
	tokenLimitBytes?: number;
}

const standUp = (
	context: TestContext,
	{
		commitFailure,
		confirmationSettled = Promise.resolve(),
		deadlineMilliseconds = CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS,
		grantRules,
		grants,
		judge,
		lateRequestThresholdMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS,
		outsideRecorded = Promise.resolve(),
		poolSize = 10,
		readFailure,
		registered = 1,
		standing,
		storeTakes = Promise.resolve(),
		tokenLimitBytes = TOKEN_LIMIT_BYTES,
	}: StandOptions = {},
): Stand => {
	const admission = createAdmission({
		poolSize,
		registeredCount: () => registered,
	});
	const stand: Omit<Stand, 'closeWindows' | 'server' | 'stop'> = {
		closings: [],
		confirmationDeadlines: [],
		confirmed: [],
		counted: [],
		countedOverShare: [],
		inFlight: () => admission.inFlight(),
		judged: [],
		lines: [],
		outside: [],
		transactions: [],
		warnings: [],
	};
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	const counter = {
		count: (reason: string, applicationId?: string): void => {
			stand.counted.push({ applicationId, reason });
		},
	};
	// The instance's recorder of refused assertions, writing to a trail of its own, apart from the
	// exchange's transactions.
	const refusals = createAssertionRefusals({
		clock: SETTINGS.clock,
		log: {
			warning: (message, fields) => {
				stand.warnings.push({ fields, message });
			},
		},
		refusedAssertions: createRefusedAssertions(SETTINGS.clock),
		rejections: counter,
	});
	// The instance's windows, closing each through a trail of their own, apart from the exchange's
	// transactions.
	const windows = createWindowedRefusals({
		clock: SETTINGS.clock,
		closingEvents: {
			exchange: exchangeRefusalTallyEvent,
			logout: exchangeRefusalTallyEvent,
			management: exchangeRefusalTallyEvent,
		},
		log: {
			error: (message, fields) => {
				stand.lines.push({ fields, message });
			},
		},
		trail: {
			recordEvent: async (actor, event) => {
				stand.closings.push({ actor, event });
				return 'closing-id';
			},
		},
	});
	const exchange = createExchange({
		admission,
		assertionRecordingLimit: 5,
		// The exchange's own recorder, its limit and its admission as the exchange gives them, writing to
		// a trail of its own, apart from the exchange's transactions.
		assertionRefusals: {
			forRoute: (route) =>
				refusals.forRoute({
					...route,
					trail: {
						inTransaction: async (actor, work) =>
							work({
								connection: undefined,
								record: async (event) => {
									await outsideRecorded;
									stand.outside.push({ actor, event });
									return 'event-id';
								},
							}),
					},
				}),
		},
		assertionRejections: counter,
		assertions: {
			verify: async (rawHeaders) => {
				const index = rawHeaders.findIndex(
					(name, at) => at % 2 === 0 && name.toLowerCase() === 'authorization',
				);
				const presented = index === -1 ? undefined : rawHeaders[index + 1];
				return (
					ASSERTIONS[presented ?? ''] ?? {
						kind: 'unverified',
						reason: 'missingAssertion',
					}
				);
			},
		},
		deadlineMilliseconds,
		eventLog: {
			error: (message, fields) => {
				stand.lines.push({ fields, message });
			},
			warning: (message, fields) => {
				stand.warnings.push({ fields, message });
			},
		},
		judgeCredential: async (credential, { audience, now }) => {
			stand.judged.push({ audience, credential, now });
			if (judge !== undefined) {
				return judge(credential, { audience, now });
			}
			const judgement = JUDGEMENTS[credential];
			if (judgement === undefined) {
				throw new TypeError('the stand holds no judgement for the credential');
			}
			return judgement;
		},
		keyConfirmations: {
			confirm: async ({ applicationId, keyId }, sourceIp, deadline) => {
				stand.confirmationDeadlines.push(deadline);
				await confirmationSettled;
				stand.confirmed.push({ applicationId, keyId, sourceIp });
			},
		},
		lateRequestThresholdMilliseconds,
		monotonicNow: () => performance.now(),
		refusals: windows,
		settings: SETTINGS,
		sharesExceeded: {
			count: (applicationId) => {
				stand.countedOverShare.push(applicationId);
			},
		},
		tokenLimitBytes,
		trail: {
			inTransaction: async (actor, work, options) => {
				const transaction: Transaction = {
					actor,
					options,
					recorded: [],
					statements: [],
				};
				stand.transactions.push(transaction);
				await storeTakes;
				const query = async (text: string, values?: readonly unknown[]) => {
					transaction.statements.push({ text, values });
					if (readFailure !== undefined) {
						throw readFailure;
					}
					return { rows: rowsAnswering(text, standing, grants, grantRules) };
				};
				const opened: AuditTransaction<pg.ClientBase> = {
					// A client that never connects, its query answered here.
					connection: Object.assign(new pg.Client(), { query }),
					record: async (event) => {
						transaction.recorded.push(event);
						return 'event-id';
					},
				};
				const result = await work(opened);
				if (commitFailure !== undefined) {
					throw commitFailure;
				}
				return result;
			},
		},
	});
	server.route(exchange.route);
	context.after(async () => {
		await refusals.stop();
		await server.close();
		await windows.stop();
	});
	return {
		...stand,
		closeWindows: () => windows.stop(),
		server,
		stop: () => refusals.stop(),
	};
};

interface Sent {
	assertion?: string | null;
	body?: string;
	contentType?: string;
}

const post = (
	{ server }: Pick<Stand, 'server'>,
	{
		assertion = VERIFIED,
		body = JSON.stringify({ payloadVersions: [1] }),
		contentType = 'application/json',
	}: Sent = {},
): Promise<LightMyRequestResponse> =>
	server.inject({
		headers: {
			'content-type': contentType,
			...(assertion === null ? {} : { authorization: assertion }),
		},
		method: 'POST',
		payload: body,
		url: EXCHANGE_PATH,
	});

const withCredential = (credential: string): Sent => ({
	body: JSON.stringify({ credential, payloadVersions: [1] }),
});

// An answer as two that must be identical are compared: its status, its body, and every header but
// the date, by name and value.
const onTheWire = (answer: LightMyRequestResponse) => ({
	body: answer.body,
	headers: Object.entries(answer.headers)
		.filter(([name]) => name !== 'date')
		.toSorted(([first], [second]) => first.localeCompare(second)),
	status: answer.statusCode,
});

const problemOf = (answer: LightMyRequestResponse): { code: unknown; status: number } => ({
	code: (JSON.parse(answer.body) as Readonly<Record<string, unknown>>)['code'],
	status: answer.statusCode,
});

const recordedIn = (stand: Stand): readonly AuditEvent[] => stand.transactions.flatMap(({ recorded }) => recorded);

// The payload an issued token holds, opened under the token subkey it was sealed under.
const payloadIn = async (answer: LightMyRequestResponse): Promise<unknown> => {
	const { plaintext } = await compactDecrypt(answer.body, KEY_SUBKEYS.token, {
		contentEncryptionAlgorithms: ['A256GCM'],
		keyManagementAlgorithms: ['dir'],
	});
	return JSON.parse(new TextDecoder().decode(plaintext));
};

const storeFailure = (code: string): Error => Object.assign(new Error('the store refused the statement'), { code });

// An answer's problem code, or its status for a token issued.
const problemOrStatusOf = (answer: LightMyRequestResponse): unknown =>
	answer.statusCode === 200 ? 200 : problemOf(answer).code;

// Settles once the stand has begun as many transactions as given, or after ANSWER_WITHIN_MS, giving
// whether it had, so a test never waits on time to learn that an exchange holds its place.
const untilTransactionsBegun = async (
	stand: Pick<Stand, 'transactions'>,
	count: number,
	deadline: number = Date.now() + ANSWER_WITHIN_MS,
): Promise<boolean> => {
	if (stand.transactions.length >= count) {
		return true;
	}
	if (Date.now() > deadline) {
		return false;
	}
	await delay(1);
	return untilTransactionsBegun(stand, count, deadline);
};

// Whether an answer came before any wait on the store could have ended.
const answeredAtOnce = (answering: Promise<unknown>): Promise<boolean> =>
	Promise.race([answering.then(() => true), delay(ANSWER_WITHIN_MS).then(() => false)]);

/** A row the store committed: the table written, and the values bound. */
interface CommittedRow {
	table: string;
	values: readonly unknown[];
}

/** A stand whose exchange records through the audit trail itself, over a store a test holds back. */
interface StoreStand {
	/** Every row the store committed, in order. */
	committed: readonly CommittedRow[];

	/** Every line the exchange and its trail wrote, parsed. */
	lines(): readonly Readonly<Record<string, unknown>>[];

	/** Whether each release of the store's connection asked for it to be discarded. */
	releases: (boolean | undefined)[];

	server: FastifyInstance;

	/** Every statement sent to the store, by its text. */
	statements: string[];
}

/** A statement the store fails: the first one sent that matches, and whether its failure ends the connection. */
interface StatementFault {
	endsConnection: boolean;
	matches(text: string): boolean;
}

interface StoreStandOptions {
	deadlineMilliseconds: number;

	/** The statement the store fails: none by default. */
	fault?: StatementFault;

	/**
	 * The late-request threshold: none by default, since these tests shorten the deadline to make the
	 * store the step it cuts short, and no request of theirs is late.
	 */
	lateRequestThresholdMilliseconds?: number;

	/**
	 * How long the store holds back its answer to a statement, in milliseconds, for each statement a
	 * test names: `Infinity` for one it never answers, until its connection is discarded.
	 */
	holds: (text: string) => number | undefined;

	storeTimeoutMilliseconds: number;

	/** The most bytes a token answered may hold: the Controller's own limit by default. */
	tokenLimitBytes?: number;
}

const INSERTED_TABLE = /^INSERT INTO "[^"]+"\.(?<table>\w+)/u;

const SAVEPOINT_NAMED = /SAVEPOINT (?<name>\w+)$/u;

// A store whose one connection answers each statement, the policy read included, once the time the
// test holds it for has passed. A discarded connection fails every statement held, and every later
// one without sending it, as the driver's does. It keeps each row inserted until its transaction
// commits, forgetting those a rollback to a savepoint or a rollback undoes. The statement a fault
// names fails, and ends the connection if the fault says so; otherwise every later statement but a
// rollback fails, as the store's does in a transaction a statement failed in, and a COMMIT is
// answered as a rollback.
const heldStore = (
	holds: StoreStandOptions['holds'],
	fault: StatementFault | undefined,
): {
	committed: CommittedRow[];
	connect(): Promise<pg.PoolClient>;
	releases: (boolean | undefined)[];
	statements: string[];
} => {
	const state: {
		aborted: boolean;
		discarded: boolean;
		failHeld: (() => void)[];
		faulted: boolean;
		pending: CommittedRow[];
		savepoints: Map<string, number>;
	} = {
		aborted: false,
		discarded: false,
		failHeld: [],
		faulted: false,
		pending: [],
		savepoints: new Map(),
	};
	const committed: CommittedRow[] = [];
	const releases: (boolean | undefined)[] = [];
	const statements: string[] = [];
	const discard = (): void => {
		state.discarded = true;
		state.failHeld.forEach((fail) => fail());
	};
	// What the store does with a statement it answers, and the command it answers with.
	const answered = (
		text: string,
		values: readonly unknown[] | undefined,
	): { command: string; rows: readonly unknown[] } => {
		const savepoint = SAVEPOINT_NAMED.exec(text)?.groups?.['name'] ?? '';
		if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
			state.pending.splice(state.savepoints.get(savepoint) ?? 0);
			state.aborted = false;
			return { command: 'ROLLBACK', rows: [] };
		}
		if (text.startsWith('SAVEPOINT') || text.startsWith('BEGIN; SAVEPOINT')) {
			state.savepoints.set(savepoint, state.pending.length);
		}
		if (text === 'COMMIT' || text === 'ROLLBACK') {
			const commits = text === 'COMMIT' && !state.aborted;
			committed.push(...(commits ? state.pending : []));
			state.pending = [];
			state.aborted = false;
			return { command: commits ? 'COMMIT' : 'ROLLBACK', rows: [] };
		}
		const table = INSERTED_TABLE.exec(text)?.groups?.['table'];
		if (table !== undefined) {
			state.pending.push({ table, values: values ?? [] });
		}
		return {
			command: text.split(' ')[0] ?? text,
			rows: rowsAnswering(text, undefined),
		};
	};
	const query = (text: string, values?: readonly unknown[]): Promise<unknown> => {
		if (state.discarded) {
			return Promise.reject(new Error('Client was closed and is not queryable'));
		}
		statements.push(text);
		if (!state.faulted && fault?.matches(text) === true) {
			state.faulted = true;
			if (fault.endsConnection) {
				discard();
				return Promise.reject(new Error('Connection terminated unexpectedly'));
			}
			state.aborted = true;
			return Promise.reject(Object.assign(new Error('a test injected a fault'), { code: 'P0001' }));
		}
		if (state.aborted && !text.startsWith('ROLLBACK') && text !== 'COMMIT') {
			return Promise.reject(
				Object.assign(new Error('the transaction is aborted'), {
					code: '25P02',
				}),
			);
		}
		const heldFor = holds(text);
		return heldFor === undefined
			? Promise.resolve(answered(text, values))
			: new Promise((resolve, reject) => {
					const timer = Number.isFinite(heldFor)
						? setTimeout(() => resolve(answered(text, values)), heldFor)
						: undefined;
					state.failHeld.push(() => {
						clearTimeout(timer);
						reject(new Error('Connection terminated'));
					});
				});
	};
	// A client that never connects, its query answered here.
	const connection: pg.PoolClient = Object.assign(new pg.Client(), {
		query,
		release: (destroy?: boolean | Error) => {
			releases.push(destroy === true ? true : undefined);
			if (destroy === true) {
				discard();
			}
		},
	});
	return { committed, connect: async () => connection, releases, statements };
};

const storeStandUp = (
	context: TestContext,
	{
		deadlineMilliseconds,
		fault,
		holds,
		lateRequestThresholdMilliseconds = 0,
		storeTimeoutMilliseconds,
		tokenLimitBytes = TOKEN_LIMIT_BYTES,
	}: StoreStandOptions,
): StoreStand => {
	const chunks: string[] = [];
	const logStream = new Writable({
		write: (chunk: unknown, _encoding, callback) => {
			chunks.push(String(chunk));
			callback();
		},
	});
	const eventLog = createEventLog({ clock: SETTINGS.clock, logStream });
	const store = heldStore(holds, fault);
	const trail = createAuditTrail<pg.PoolClient>({
		eventLog,
		settings: {
			clock: SETTINGS.clock,
			databaseSchema: SETTINGS.databaseSchema,
			eventSource: 'https://usher.example.org/controller',
			instanceName: 'usher-test-1',
			storeTimeoutMilliseconds,
		},
		store,
	});
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	const exchange = createExchange({
		admission: createAdmission({ poolSize: 10, registeredCount: () => 1 }),
		assertionRecordingLimit: 5,
		assertionRefusals: { forRoute: () => ({ refused: () => undefined }) },
		assertionRejections: { count: () => undefined },
		assertions: {
			verify: async () => ASSERTIONS[VERIFIED] ?? assert.fail(),
		},
		deadlineMilliseconds,
		eventLog,
		judgeCredential: async (credential) => JUDGEMENTS[credential] ?? assert.fail(),
		keyConfirmations: { confirm: async () => undefined },
		lateRequestThresholdMilliseconds,
		monotonicNow: () => performance.now(),
		refusals: {
			refuse: async (_key, open) => ({ kind: 'opened', opening: await open() }),
		},
		settings: SETTINGS,
		sharesExceeded: { count: () => undefined },
		tokenLimitBytes,
		trail,
	});
	server.route(exchange.route);
	context.after(async () => {
		await server.close();
	});
	return {
		committed: store.committed,
		lines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>),
		releases: store.releases,
		server,
		statements: store.statements,
	};
};

// What the store committed: each row by its table, an event's row by its type and what its data
// names of the actor, the result and the reason.
const committedIn = (stand: Pick<StoreStand, 'committed'>): readonly Readonly<Record<string, unknown>>[] =>
	stand.committed.map(({ table, values }) => {
		if (table !== 'audit_log') {
			return { table };
		}
		const data = JSON.parse(String(values[6])) as Readonly<Record<string, unknown>>;
		return {
			actorType: data['actorType'],
			reason: data['reason'],
			result: data['result'],
			table,
			type: values[3],
			userId: data['userId'],
		};
	});

// The token.exchange recorded for an exchange whose store work failed.
const STORE_FAILURE_ROW = Object.freeze({
	actorType: 'anonymous',
	reason: 'storeUnavailable',
	result: 'failed',
	table: 'audit_log',
	type: 'bio.overture.token.exchange',
	userId: null,
});

// What each event line names: its type, and its data's actor, result and reason.
const eventsLoggedIn = (stand: Pick<StoreStand, 'lines'>): readonly Readonly<Record<string, unknown>>[] =>
	eventLinesIn(stand.lines()).map(({ data, type }) => {
		const members = data as Readonly<Record<string, unknown>>;
		return {
			actorType: members['actorType'],
			reason: members['reason'],
			result: members['result'],
			type,
		};
	});

// The audit row's insert of a store whose statements are named by their text.
const isAuditInsert = (text: string): boolean => isInsert(text) && text.includes('.audit_log ');

interface Timed {
	answer: LightMyRequestResponse;
	elapsedMs: number;
}

const timedPost = async (stand: Pick<Stand, 'server'>, sent: Sent = {}): Promise<Timed> => {
	const from = performance.now();
	const answer = await post(stand, sent);
	return { answer, elapsedMs: performance.now() - from };
};

// A verified request whose body arrives whole only the given milliseconds after the request does, as
// a client sending it slowly does.
const postArrivingAfter = (
	{ server }: Pick<Stand, 'server'>,
	body: string,
	milliseconds: number,
): Promise<LightMyRequestResponse> => {
	const stream = new Readable({ read: () => undefined });
	stream.push(body);
	setTimeout(() => {
		stream.push(null);
	}, milliseconds);
	return server.inject({
		headers: { authorization: VERIFIED, 'content-type': 'application/json' },
		method: 'POST',
		payload: stream,
		url: EXCHANGE_PATH,
	});
};

const CREDENTIAL_BODY = JSON.stringify({
	credential: 'credential-forged',
	payloadVersions: [1],
});

const ANONYMOUS_BODY = JSON.stringify({ payloadVersions: [1] });

// The audit trail's lines that are events, by their type and data.
const eventLinesIn = (
	lines: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] => lines.filter(({ specversion }) => specversion === '1.0');

const isInsert = (text: string): boolean => text.startsWith('INSERT');

suite('the token exchange', () => {
	suite('a channel assertion it refuses', () => {
		test('answers one identical 401 to every refused assertion, whatever the request carries, and does nothing else for the caller', async (context) => {
			const stand = standUp(context);

			const answers = await Promise.all([
				post(stand, { assertion: null }),
				post(stand, {
					assertion: 'Bearer assertion-expired',
					...withCredential('credential-accepted'),
				}),
				post(stand, {
					assertion: 'Bearer assertion-of-a-keyless-application',
					body: '{"payloadVersions":',
				}),
				post(stand, {
					assertion: 'Bearer assertion-for-another-audience',
					body: 'x'.repeat(70_000),
				}),
			]);

			const [first] = answers;
			answers.forEach((answer) => {
				assert.equal(answer.statusCode, 401);
				assert.deepEqual(onTheWire(answer), first && onTheWire(first));
			});
			assert.deepEqual(problemOf(answers[0] ?? assert.fail()), {
				code: 'channelAssertionRefused',
				status: 401,
			});
			assert.equal(first?.headers['www-authenticate'], 'Bearer');
			assert.equal(first?.headers['cache-control'], 'no-store');
			assert.deepEqual(stand.judged, []);
			assert.deepEqual(stand.transactions, []);
		});

		test('counts an assertion it could not verify by reason and the registered application it names, recording no event for it', async (context) => {
			const stand = standUp(context);

			await post(stand, { assertion: null });
			await post(stand, {
				assertion: 'Bearer assertion-of-a-keyless-application',
			});

			assert.deepEqual(stand.counted, [
				{ applicationId: undefined, reason: 'missingAssertion' },
				{ applicationId: APPLICATION, reason: 'noLiveKey' },
			]);
			assert.deepEqual(stand.outside, []);
		});

		test("records an assertion verified and refused anyway as channelAssertion.rejection, denied, naming its application and the request's address, its actor the system, counting nothing", async (context) => {
			const stand = standUp(context);

			await post(stand, { assertion: 'Bearer assertion-expired' });
			await stand.stop();

			assert.deepEqual(stand.outside, [
				{
					actor: { type: 'system' },
					event: {
						data: {
							applicationId: APPLICATION,
							reason: 'expiredAssertion',
							result: 'denied',
							sourceIp: '127.0.0.1',
						},
						severity: 'warning',
						type: 'channelAssertion.rejection',
					},
				},
			]);
			assert.deepEqual(stand.counted, []);
		});

		test('records the first refusal of each assertion that verified and counts its repeats by reason and application, answering every one alike', async (context) => {
			const stand = standUp(context);

			const answers = [
				await post(stand, { assertion: 'Bearer assertion-expired' }),
				await post(stand, { assertion: 'Bearer assertion-expired' }),
				await post(stand, {
					assertion: 'Bearer assertion-for-another-audience',
				}),
			];
			await stand.stop();

			const [first] = answers;
			answers.forEach((answer) => {
				assert.deepEqual(onTheWire(answer), first && onTheWire(first));
			});
			assert.deepEqual(
				stand.outside.map(({ event }) => event.data['reason']),
				['expiredAssertion', 'otherAudience'],
			);
			assert.deepEqual(stand.counted, [{ applicationId: APPLICATION, reason: 'expiredAssertion' }]);
		});

		test('answers before the rejection is recorded, so the store never delays the answer, and its stop settles only once the recording has', async (context) => {
			const written = deferred();
			const stand = standUp(context, { outsideRecorded: written.promise });

			const answering = post(stand, { assertion: 'Bearer assertion-expired' });
			const answeredFirst = await Promise.race([
				answering.then(() => true),
				delay(ANSWER_WITHIN_MS).then(() => false),
			]);
			const stopping = stand.stop().then(() => stand.outside.length);
			await delay(0);
			const beforeWritten = stand.outside.length;
			written.release();

			assert.equal(answeredFirst, true);
			assert.equal((await answering).statusCode, 401);
			assert.equal(beforeWritten, 0);
			assert.equal(await stopping, 1);
		});
	});

	suite('the request', () => {
		test('answers 400 to a body unreadable by its shape and 406 to one listing no version served, judging nothing and opening no transaction', async (context) => {
			const stand = standUp(context);

			const answers = await Promise.all([
				post(stand, { body: '{"credential":' }),
				post(stand, { body: '[1]' }),
				post(stand, { body: '{"payloadVersions":[1.5]}' }),
				post(stand, { body: '{"credential":42,"payloadVersions":[1]}' }),
				post(stand, {
					body: '{"payloadVersions":[1]}',
					contentType: 'text/plain',
				}),
				post(stand, { body: '{"payloadVersions":[2]}' }),
			]);

			assert.deepEqual(answers.map(problemOf), [
				{ code: 'unreadableBody', status: 400 },
				{ code: 'unreadableBody', status: 400 },
				{ code: 'unreadableBody', status: 400 },
				{ code: 'unreadableBody', status: 400 },
				{ code: 'unreadableBody', status: 400 },
				{ code: 'payloadVersionUnserved', status: 406 },
			]);
			answers.forEach((answer) => assert.equal(answer.headers['cache-control'], 'no-store'));
			assert.deepEqual(stand.judged, []);
			assert.deepEqual(stand.transactions, []);
		});

		test('answers 413 to a body larger than 64 KiB from a caller its assertion authenticates', async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, {
				body: JSON.stringify({
					padding: 'x'.repeat(65_536),
					payloadVersions: [1],
				}),
			});

			assert.deepEqual(problemOf(answer), {
				code: 'bodyTooLarge',
				status: 413,
			});
			assert.deepEqual(stand.transactions, []);
		});

		test('issues for the application the assertion names, whatever the body names', async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, {
				body: JSON.stringify({
					aud: 'another-application',
					audience: 'another-application',
					payloadVersions: [2, 1],
				}),
			});
			const { plaintext } = await compactDecrypt(answer.body, KEY_SUBKEYS.token);

			assert.equal(answer.statusCode, 200);
			assert.equal((JSON.parse(new TextDecoder().decode(plaintext)) as { aud: unknown }).aud, APPLICATION);
			assert.deepEqual(stand.transactions[0]?.statements[0]?.values, [APPLICATION]);
		});
	});

	suite('the anonymous exchange', () => {
		test("answers one compact token as an application/jwt body, no-store, sealed under the token subkey of the key the assertion verified under, holding the anonymous visitor's version 1 payload exactly", async (context) => {
			const stand = standUp(context);

			const answer = await post(stand);
			const { plaintext } = await compactDecrypt(answer.body, KEY_SUBKEYS.token, {
				contentEncryptionAlgorithms: ['A256GCM'],
				keyManagementAlgorithms: ['dir'],
			});

			assert.equal(answer.statusCode, 200);
			assert.equal(answer.headers['content-type'], 'application/jwt');
			assert.equal(answer.headers['cache-control'], 'no-store');
			assert.match(answer.body, /^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/u);
			assert.deepEqual(decodeProtectedHeader(answer.body), {
				alg: 'dir',
				enc: 'A256GCM',
				typ: 'usher+jwt',
			});
			assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), ANONYMOUS_PAYLOAD);
		});

		test("reads the audience's policy in one statement and records its token.exchange in the same transaction, succeeded, its actor anonymous", async (context) => {
			const stand = standUp(context);

			await post(stand);

			assert.equal(stand.transactions.length, 1);
			assert.deepEqual(stand.transactions[0]?.actor, { type: 'anonymous' });
			assert.equal(stand.transactions[0]?.statements.length, 1);
			assert.deepEqual(stand.transactions[0]?.recorded, [
				{
					data: {
						audience: APPLICATION,
						generatedAt: new Date(SECONDS * 1000).toISOString(),
						grantCount: 0,
						result: 'succeeded',
						rules: ['everyone'],
						sourceIp: '127.0.0.1',
						tokenTtl: 300,
						userId: null,
					},
					severity: 'info',
					type: 'token.exchange',
				},
			]);
			assert.deepEqual(stand.outside, []);
		});

		test('answers 503 storeUnavailable, issuing no token, when the store cannot answer its read, writing the failure by its code alone', async (context) => {
			const stand = standUp(context, { readFailure: storeFailure('57P01') });

			const answer = await post(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.deepEqual(stand.lines, [
				{
					fields: { code: '57P01', route: EXCHANGE_PATH },
					message: EXCHANGE_STORE_FAILED,
				},
			]);
		});

		test('answers 503 storeUnavailable, issuing no token, when its token.exchange cannot be committed', async (context) => {
			const stand = standUp(context, { commitFailure: storeFailure('40001') });

			const answer = await post(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.equal(recordedIn(stand).length, 1);
		});

		test('answers 503 outcomeUnknown, issuing no token, when its commit goes unconfirmed, writing no line of its own', async (context) => {
			const stand = standUp(context, {
				commitFailure: new CommitUnconfirmed(),
			});

			const answer = await post(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
			assert.deepEqual(stand.lines, []);
		});
	});

	suite("its key's confirmation", () => {
		test('confirms the key the assertion verified under for every exchange it answers: issued, anonymous or signed in, refused for its credential, for its body or for its size, or kept from its store', async (context) => {
			const stand = standUp(context);
			const failing = standUp(context, { readFailure: storeFailure('57P01') });

			const answers = await Promise.all([
				post(stand),
				post(stand, withCredential('credential-accepted')),
				post(stand, withCredential('credential-expired')),
				post(stand, { body: '[1]' }),
				post(stand, { body: '{"payloadVersions":[2]}' }),
				post(stand, {
					body: JSON.stringify({ padding: 'x'.repeat(65_536) }),
				}),
				post(failing),
			]);

			assert.deepEqual(
				answers.map(({ statusCode }) => statusCode),
				[200, 200, 403, 400, 406, 413, 503],
			);
			assert.deepEqual(
				[...stand.confirmed, ...failing.confirmed],
				answers.map(() => ({
					applicationId: APPLICATION,
					keyId: KEY.keyId,
					sourceIp: '127.0.0.1',
				})),
			);
		});

		test('confirms nothing for an exchange refused for its channel assertion', async (context) => {
			const stand = standUp(context);

			await Promise.all([
				post(stand, { assertion: null }),
				post(stand, { assertion: 'Bearer assertion-expired' }),
				post(stand, {
					assertion: 'Bearer assertion-of-a-keyless-application',
				}),
			]);

			assert.deepEqual(stand.confirmed, []);
		});

		test("waits for the key's confirmation within the deadline, so the key reads as confirmed when the first exchange is answered once the store takes the confirmation in time", async (context) => {
			const confirmation = deferred();
			const stand = standUp(context, {
				confirmationSettled: confirmation.promise,
			});

			const answering = post(stand);
			const answeredFirst = await Promise.race([
				answering.then(() => true),
				delay(ANSWER_WITHIN_MS).then(() => false),
			]);
			confirmation.release();
			const answer = await answering;

			assert.equal(answeredFirst, false);
			assert.equal(answer.statusCode, 200);
			assert.equal(stand.confirmed.length, 1);
		});
	});

	suite('a credential', () => {
		test("is judged only once its assertion verifies, for the application the assertion names, at the clock's instant", async (context) => {
			const stand = standUp(context);

			await post(stand, {
				assertion: 'Bearer assertion-expired',
				...withCredential('credential-expired'),
			});
			await post(stand, withCredential('credential-expired'));

			assert.deepEqual(stand.judged, [{ audience: APPLICATION, credential: 'credential-expired', now: NOW }]);
		});

		test('is answered one identical 403 for every refusal of the judgement, each recorded as denied under its own reason in a transaction of its own, naming refusedSubject only as the judgement does and the application where it does not', async (context) => {
			const stand = standUp(context);
			const credentials = ['credential-expired', 'credential-forged', '', 'uak_example'];

			const answers = await Promise.all(credentials.map((credential) => post(stand, withCredential(credential))));

			const [first] = answers;
			answers.forEach((answer) => {
				assert.equal(answer.statusCode, 403);
				assert.deepEqual(onTheWire(answer), first && onTheWire(first));
			});
			assert.deepEqual(problemOf(answers[0] ?? assert.fail()), {
				code: 'credentialRefused',
				status: 403,
			});
			assert.deepEqual(
				stand.transactions.map(({ actor, recorded, statements }) => ({
					actor,
					recorded: recorded.map(({ data, severity }) => ({ data, severity })),
					statements: statements.length,
				})),
				[
					{
						data: {
							reason: 'expiredToken',
							refusedSubject: 'subject "ana" \\',
							result: 'denied',
							sourceIp: '127.0.0.1',
							userId: null,
						},
					},
					{
						data: {
							applicationId: APPLICATION,
							reason: 'invalidSignature',
							result: 'denied',
							sourceIp: '127.0.0.1',
							userId: null,
						},
					},
					{
						data: {
							applicationId: APPLICATION,
							reason: 'missingCredential',
							result: 'denied',
							sourceIp: '127.0.0.1',
							userId: null,
						},
					},
					{
						data: {
							applicationId: APPLICATION,
							reason: 'apiKeyVerifierNotConfigured',
							result: 'denied',
							sourceIp: '127.0.0.1',
							userId: null,
						},
					},
				].map(({ data }) => ({
					actor: { type: 'anonymous' },
					recorded: [{ data, severity: 'warning' }],
					statements: 0,
				})),
			);
		});

		test("is answered 503 identityProviderUnavailable while the identity provider's keys cannot be had, the exchange recorded as failed", async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, withCredential('credential-while-keys-unavailable'));

			assert.deepEqual(problemOf(answer), {
				code: 'identityProviderUnavailable',
				status: 503,
			});
			assert.equal(Object.hasOwn(answer.headers, 'retry-after'), false);
			assert.deepEqual(recordedIn(stand), [
				{
					data: {
						reason: 'identityProviderUnavailable',
						result: 'failed',
						sourceIp: '127.0.0.1',
						userId: null,
					},
					severity: 'error',
					type: 'token.exchange',
				},
			]);
		});

		test('is answered 503 storedSettingsInvalid, issuing no token, when the grant rules the store holds break their rule, anonymous or signed in, the exchange recorded failed as storedSettingsInvalid', async (context) => {
			const anonymous = standUp(context, {
				grantRules: [{ resources: [], to: 'anyone' }],
			});
			const signedIn = standUp(context, {
				grantRules: [{ resources: [], to: 'anyone' }],
			});

			const answers = [await post(anonymous), await post(signedIn, withCredential('credential-accepted'))];

			assert.deepEqual(
				answers.map(problemOf),
				answers.map(() => ({ code: 'storedSettingsInvalid', status: 503 })),
			);
			const failure = {
				actor: { type: 'anonymous' },
				data: {
					reason: 'storedSettingsInvalid',
					result: 'failed',
					sourceIp: '127.0.0.1',
					userId: null,
				},
				severity: 'error',
				type: 'token.exchange',
			};
			assert.deepEqual(recordedIn(anonymous), [failure]);
			assert.deepEqual(recordedIn(signedIn), [failure]);
		});

		test('is answered 503 signingKeyUnconfirmed with its seconds in Retry-After while its signing key is not confirmed yet, the exchange recorded as denied at warning naming the application', async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, withCredential('credential-under-a-new-key'));

			assert.deepEqual(problemOf(answer), {
				code: 'signingKeyUnconfirmed',
				status: 503,
			});
			assert.equal(answer.headers['retry-after'], '17');
			assert.deepEqual(recordedIn(stand), [
				{
					data: {
						applicationId: APPLICATION,
						reason: 'signingKeyUnconfirmed',
						result: 'denied',
						sourceIp: '127.0.0.1',
						userId: null,
					},
					severity: 'warning',
					type: 'token.exchange',
				},
			]);
		});

		test('is answered 503 storeUnavailable rather than 403 when its refusal cannot be recorded, so no refusal goes unrecorded while looking answered', async (context) => {
			const stand = standUp(context, { commitFailure: storeFailure('57P01') });

			const answers = await Promise.all(
				['credential-forged', 'credential-of-a-client', 'credential-while-keys-unavailable'].map((credential) =>
					post(stand, withCredential(credential)),
				),
			);

			assert.deepEqual(
				answers.map(problemOf),
				answers.map(() => ({ code: 'storeUnavailable', status: 503 })),
			);
			assert.equal(stand.lines.length, 3);
		});

		test("is answered 503 outcomeUnknown when its refusal's commit goes unconfirmed", async (context) => {
			const stand = standUp(context, {
				commitFailure: new CommitUnconfirmed(),
			});

			const answer = await post(stand, withCredential('credential-forged'));

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
		});

		test('is answered 500 internalError when judging it fails unexpectedly, the failure written by its name alone and nothing recorded', async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, withCredential('a credential the stand cannot judge'));

			assert.deepEqual(problemOf(answer), {
				code: 'internalError',
				status: 500,
			});
			assert.deepEqual(stand.lines, [
				{
					fields: { error: 'TypeError', route: EXCHANGE_PATH },
					message: EXCHANGE_UNEXPECTED_FAILURE,
				},
			]);
			assert.deepEqual(stand.transactions, []);
		});
	});

	suite('a signed-in principal', () => {
		test("is issued one compact token as an application/jwt body, no-store, sealed under the token subkey of the key the assertion verified under, holding their version 1 payload exactly: the identity provider's subject, the baseline on open resources and the signed-in rule on registered ones", async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.equal(answer.statusCode, 200);
			assert.equal(answer.headers['content-type'], 'application/jwt');
			assert.equal(answer.headers['cache-control'], 'no-store');
			assert.deepEqual(decodeProtectedHeader(answer.body), {
				alg: 'dir',
				enc: 'A256GCM',
				typ: 'usher+jwt',
			});
			assert.deepEqual(await payloadIn(answer), SIGNED_IN_PAYLOAD);
		});

		test("records its token.exchange succeeded at info in the exchange's one transaction, its actor the person by the identity provider's subject, naming them as userId, both conferring rules, no recorded grant, its lifetime, its audience and its computation time", async (context) => {
			const stand = standUp(context);

			await post(stand, withCredential('credential-accepted'));

			assert.equal(stand.transactions.length, 1);
			assert.equal(stand.transactions[0]?.options?.deadline, stand.confirmationDeadlines[0]);
			assert.deepEqual(stand.transactions[0]?.actor, {
				id: 'subject-ana',
				type: 'human',
			});
			assert.deepEqual(stand.transactions[0]?.recorded, [
				{
					data: {
						audience: APPLICATION,
						generatedAt: new Date(SECONDS * 1000).toISOString(),
						grantCount: 0,
						result: 'succeeded',
						rules: ['everyone', 'signedIn'],
						sourceIp: '127.0.0.1',
						tokenTtl: 300,
						userId: 'subject-ana',
					},
					severity: 'info',
					type: 'token.exchange',
				},
			]);
		});

		test("draws on the grants the store reads as reaching them: each kept grant's entry in the payload, its expiry bounding the token's, rounded down, and their count in the token.exchange", async (context) => {
			const stand = standUp(context, {
				grants: [
					{
						expiresAt: (SECONDS + 120) * 1000 + 500,
						externalId: 'STUDY-A1',
						fieldCategory: null,
						latestDecision: {
							capabilities: ['record.view'],
							decision: 'accepted',
						},
						plane: 'data',
						recordCategory: { name: 'controlled', scope: 'global' },
						roleCapabilities: ['record.count', 'record.export', 'record.view'],
					},
					{
						expiresAt: null,
						externalId: 'STUDY-C3',
						fieldCategory: null,
						latestDecision: null,
						plane: 'data',
						recordCategory: { name: 'controlled', scope: 'global' },
						roleCapabilities: ['record.view'],
					},
				],
			});

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.equal(answer.statusCode, 200);
			assert.deepEqual(await payloadIn(answer), {
				...SIGNED_IN_PAYLOAD,
				exp: SECONDS + 120,
				permissions: {
					...SIGNED_IN_PAYLOAD.permissions,
					'STUDY-A1': {
						'global.controlled': { record: ['view'] },
						'global.unmarked': { record: ['count', 'view', 'export'] },
					},
				},
			});
			assert.deepEqual(
				stand.transactions[0]?.recorded.map(({ data }) => ({
					grantCount: data['grantCount'],
					tokenTtl: data['tokenTtl'],
				})),
				[{ grantCount: 1, tokenTtl: 120 }],
			);
		});

		test("reads the principal's standing, meets them as a person, reads the audience's policy and the grants reaching them, binding the person met, and records the session the sign-in token carries, in that order, in the one transaction", async (context) => {
			const stand = standUp(context);

			await post(stand, withCredential('credential-accepted'));
			const statements = stand.transactions[0]?.statements ?? [];
			const valuesOf = (kind: string): readonly unknown[] | undefined =>
				statements.find(({ text }) => statementKindOf(text) === kind)?.values;

			assert.deepEqual(statementKindsIn({ statements }), ['standing', 'person', 'policy', 'session']);
			assert.deepEqual(valuesOf('standing'), [
				IDENTITY_PROVIDER,
				'subject-ana',
				'session-1',
				new Date((SECONDS - 10) * 1000),
			]);
			assert.deepEqual(valuesOf('person'), [IDENTITY_PROVIDER, 'subject-ana']);
			assert.deepEqual(valuesOf('policy'), [APPLICATION, PERSON_ID]);
			assert.deepEqual(valuesOf('session'), [
				IDENTITY_PROVIDER,
				'session-1',
				'subject-ana',
				new Date((SECONDS + 300) * 1000),
			]);
		});

		test('records no session for a sign-in token carrying no sid', async (context) => {
			const stand = standUp(context);

			const answer = await post(stand, withCredential('credential-of-no-session'));

			assert.equal(answer.statusCode, 200);
			assert.deepEqual(statementKindsIn(stand.transactions[0] ?? { statements: [] }), [
				'standing',
				'person',
				'policy',
			]);
		});

		test('is answered one identical 403 when the store refuses the principal, recorded denied under its own reason naming the refused subject, its actor anonymous, and nothing written beside it', async (context) => {
			const refusals: readonly StoredRefusal[] = ['revokedPlatform', 'revokedPrincipal', 'signedOutSession'];
			const forged = await post(standUp(context), withCredential('credential-forged'));

			const outcomes = await Promise.all(
				refusals.map(async (standing) => {
					const stand = standUp(context, { standing });
					const answer = await post(stand, withCredential('credential-accepted'));
					return { answer, transactions: stand.transactions };
				}),
			);

			outcomes.forEach(({ answer }) => {
				assert.deepEqual(onTheWire(answer), onTheWire(forged));
				assert.equal(answer.body.includes('subject-ana'), false);
			});
			assert.deepEqual(problemOf(forged), {
				code: 'credentialRefused',
				status: 403,
			});
			assert.deepEqual(
				outcomes.map(({ transactions }) =>
					transactions.map((transaction) => ({
						actor: transaction.actor,
						recorded: transaction.recorded,
						statements: statementKindsIn(transaction),
					})),
				),
				refusals.map((reason) => [
					{
						actor: { id: 'subject-ana', type: 'human' },
						recorded: [],
						statements: ['standing'],
					},
					{
						actor: { type: 'anonymous' },
						recorded: [
							{
								data: {
									reason,
									refusedSubject: 'subject-ana',
									result: 'denied',
									sourceIp: '127.0.0.1',
									userId: null,
								},
								severity: 'warning',
								type: 'token.exchange',
							},
						],
						statements: [],
					},
				]),
			);
		});

		test("refuses a service account's token by each of its marks with the one 403, recorded denied as serviceAccountNotPermitted naming its subject, its actor anonymous, reading nothing from the store", async (context) => {
			const stand = standUp(context);
			const credentials = Object.keys(SERVICE_ACCOUNT_MARKS);

			const answers = await Promise.all(credentials.map((credential) => post(stand, withCredential(credential))));
			const forged = await post(stand, withCredential('credential-forged'));

			answers.forEach((answer) => {
				assert.deepEqual(onTheWire(answer), onTheWire(forged));
			});
			assert.deepEqual(
				stand.transactions.slice(0, credentials.length).map(({ actor, recorded, statements }) => ({
					actor,
					recorded,
					statements: statements.length,
				})),
				credentials.map(() => ({
					actor: { type: 'anonymous' },
					recorded: [
						{
							data: {
								reason: 'serviceAccountNotPermitted',
								refusedSubject: 'subject-ana',
								result: 'denied',
								sourceIp: '127.0.0.1',
								userId: null,
							},
							severity: 'warning',
							type: 'token.exchange',
						},
					],
					statements: 0,
				})),
			);
		});

		test("refuses a sign-in token expiring at or before the issuing second as expiredToken, naming its subject and reading nothing from the store, and issues one expiring a second after it a token of that one second's lifetime", async (context) => {
			const stand = standUp(context);

			const refused = await post(stand, withCredential('credential-expiring-as-issued'));
			const issued = await post(stand, withCredential('credential-expiring-a-second-after-issue'));
			const [refusal, issuance] = stand.transactions;

			assert.deepEqual(problemOf(refused), {
				code: 'credentialRefused',
				status: 403,
			});
			assert.deepEqual(
				{
					actor: refusal?.actor,
					recorded: refusal?.recorded,
					statements: refusal?.statements.length,
				},
				{
					actor: { type: 'anonymous' },
					recorded: [
						{
							data: {
								reason: 'expiredToken',
								refusedSubject: 'subject-ana',
								result: 'denied',
								sourceIp: '127.0.0.1',
								userId: null,
							},
							severity: 'warning',
							type: 'token.exchange',
						},
					],
					statements: 0,
				},
			);
			assert.equal(issued.statusCode, 200);
			assert.deepEqual(await payloadIn(issued), {
				...SIGNED_IN_PAYLOAD,
				exp: SECONDS + 1,
			});
			assert.equal(issuance?.recorded[0]?.data['tokenTtl'], 1);
		});

		test('is answered 503 storeUnavailable, issuing no token, when the store cannot answer its reads or commit its token.exchange, writing the failure by its code alone', async (context) => {
			const unreadable = standUp(context, {
				readFailure: storeFailure('57P01'),
			});
			const uncommitted = standUp(context, {
				commitFailure: storeFailure('40001'),
			});

			const answers = [
				await post(unreadable, withCredential('credential-accepted')),
				await post(uncommitted, withCredential('credential-accepted')),
			];

			assert.deepEqual(
				answers.map(problemOf),
				answers.map(() => ({ code: 'storeUnavailable', status: 503 })),
			);
			assert.deepEqual(
				[...unreadable.lines, ...uncommitted.lines],
				[
					{
						fields: { code: '57P01', route: EXCHANGE_PATH },
						message: EXCHANGE_STORE_FAILED,
					},
					{
						fields: { code: '40001', route: EXCHANGE_PATH },
						message: EXCHANGE_STORE_FAILED,
					},
				],
			);
		});

		test('is answered 503 outcomeUnknown, issuing no token, when its commit goes unconfirmed', async (context) => {
			const stand = standUp(context, {
				commitFailure: new CommitUnconfirmed(),
			});

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
			assert.deepEqual(stand.lines, []);
		});

		test("is answered 503 admissionShareExceeded at once over its application's share while the pool is contended, beginning no transaction, as every credential is and unlike the anonymous exchange", async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});

			const holding = post(stand, withCredential('credential-forged'));
			await untilTransactionsBegun(stand, 1);
			const answering = post(stand, withCredential('credential-accepted'));
			const atOnce = await answeredAtOnce(answering);
			const transactionsWhileFull = stand.transactions.length;
			store.release();
			const [overShare] = await Promise.all([answering, holding]);

			assert.equal(atOnce, true);
			assert.deepEqual(problemOf(overShare), {
				code: 'admissionShareExceeded',
				status: 503,
			});
			assert.equal(overShare.headers['retry-after'], '1');
			assert.equal(transactionsWhileFull, 1);
			assert.deepEqual(stand.countedOverShare, [APPLICATION]);
		});

		test('is answered 408 requestTimeout when its body arrives with less than the late-request threshold left, judging nothing and beginning no transaction', async (context) => {
			const stand = standUp(context, {
				deadlineMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS + 300,
			});

			const answer = await postArrivingAfter(
				stand,
				JSON.stringify({
					credential: 'credential-accepted',
					payloadVersions: [1],
				}),
				400,
			);

			assert.deepEqual(problemOf(answer), {
				code: 'requestTimeout',
				status: 408,
			});
			assert.deepEqual(stand.judged, []);
			assert.deepEqual(stand.transactions, []);
		});
	});

	suite('a token past the token limit', () => {
		// The bytes a token answered takes on the wire: its body as UTF-8.
		const bodyBytesOf = (answer: LightMyRequestResponse): number => Buffer.byteLength(answer.body, 'utf8');

		test('serves the anonymous visitor a token of exactly the limit, and answers one a byte past it 503 tokenOverResponseCap with no token and no Retry-After, recording its token.exchange failed at error, its actor anonymous, with the resources its payload holds and its bytes', async (context) => {
			const limit = bodyBytesOf(await post(standUp(context)));
			const atLimit = standUp(context, { tokenLimitBytes: limit });
			const pastLimit = standUp(context, { tokenLimitBytes: limit - 1 });

			const served = await post(atLimit);
			const refused = await post(pastLimit);

			assert.equal(served.statusCode, 200);
			assert.equal(bodyBytesOf(served), limit);
			assert.deepEqual(await payloadIn(served), ANONYMOUS_PAYLOAD);
			assert.deepEqual(problemOf(refused), {
				code: 'tokenOverResponseCap',
				status: 503,
			});
			assert.match(String(refused.headers['content-type']), /^application\/problem\+json\b/u);
			assert.equal(refused.headers['retry-after'], undefined);
			assert.equal(refused.headers['cache-control'], 'no-store');
			assert.deepEqual(pastLimit.transactions[0]?.actor, { type: 'anonymous' });
			assert.deepEqual(recordedIn(pastLimit), [
				{
					data: {
						heldResourceCount: 2,
						reason: 'tokenOverResponseCap',
						result: 'failed',
						sourceIp: '127.0.0.1',
						tokenBytes: limit,
						userId: null,
					},
					severity: 'error',
					type: 'token.exchange',
				},
			]);
			assert.deepEqual(pastLimit.lines, [
				{
					fields: { route: EXCHANGE_PATH },
					message: EXCHANGE_TOKEN_OVER_RESPONSE_CAP,
				},
			]);
		});

		test("answers a signed-in principal's token past the limit 503 tokenOverResponseCap, recording only its failed token.exchange, naming them as userId, and recording no session", async (context) => {
			const tokenBytes = bodyBytesOf(await post(standUp(context), withCredential('credential-accepted')));
			const stand = standUp(context, { tokenLimitBytes: tokenBytes - 1 });

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.deepEqual(problemOf(answer), {
				code: 'tokenOverResponseCap',
				status: 503,
			});
			assert.equal(answer.headers['retry-after'], undefined);
			assert.deepEqual(statementKindsIn(stand.transactions[0] ?? { statements: [] }), [
				'standing',
				'person',
				'policy',
			]);
			assert.deepEqual(stand.transactions[0]?.actor, {
				id: 'subject-ana',
				type: 'human',
			});
			assert.deepEqual(recordedIn(stand), [
				{
					data: {
						heldResourceCount: 3,
						reason: 'tokenOverResponseCap',
						result: 'failed',
						sourceIp: '127.0.0.1',
						tokenBytes,
						userId: 'subject-ana',
					},
					severity: 'error',
					type: 'token.exchange',
				},
			]);
		});

		test("commits a signed-in principal's first meeting and their failed token.exchange alone when their token passes the limit, and no session", async (context) => {
			const stand = storeStandUp(context, {
				deadlineMilliseconds: CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS,
				holds: () => undefined,
				storeTimeoutMilliseconds: 5000,
				tokenLimitBytes: 100,
			});

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.deepEqual(problemOf(answer), {
				code: 'tokenOverResponseCap',
				status: 503,
			});
			assert.deepEqual(committedIn(stand), [
				{ table: 'users' },
				{ table: 'user_identities' },
				{
					actorType: 'human',
					reason: 'tokenOverResponseCap',
					result: 'failed',
					table: 'audit_log',
					type: 'bio.overture.token.exchange',
					userId: 'subject-ana',
				},
			]);
		});
	});

	suite('its deadline', () => {
		test("passes the deadline started as the request arrived to its own transaction and to the key's confirmation, one deadline for the whole request", async (context) => {
			const stand = standUp(context);

			await post(stand);
			const [given] = stand.confirmationDeadlines;
			const transactionDeadline = stand.transactions[0]?.options?.deadline;
			const remaining = given?.remainingMilliseconds() ?? -1;

			assert.equal(transactionDeadline, given);
			assert.ok(
				remaining < CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS &&
					remaining > CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS - ANSWER_WITHIN_MS,
				`${Math.round(remaining)} ms left`,
			);
		});

		test('answers 408 requestTimeout at once, with Connection: close, to a body arriving whole only once the deadline has passed, recording nothing, judging nothing and writing one line at warning naming the route', async (context) => {
			const deadlineMilliseconds = 100;
			const bodyEndsAfterMs = deadlineMilliseconds + 150;
			const stand = standUp(context, { deadlineMilliseconds });
			const body = new Readable({ read: () => undefined });
			body.push(
				JSON.stringify({
					credential: 'credential-forged',
					payloadVersions: [1],
				}),
			);
			setTimeout(() => {
				body.push(null);
			}, bodyEndsAfterMs);

			const from = performance.now();
			const answer = await stand.server.inject({
				headers: {
					authorization: VERIFIED,
					'content-type': 'application/json',
				},
				method: 'POST',
				payload: body,
				url: EXCHANGE_PATH,
			});
			const elapsedMs = performance.now() - from;

			assert.deepEqual(problemOf(answer), {
				code: 'requestTimeout',
				status: 408,
			});
			assert.equal(answer.headers['connection'], 'close');
			assert.equal(answer.headers['cache-control'], 'no-store');
			assert.ok(elapsedMs < bodyEndsAfterMs + SCHEDULING_SLACK_MS, `answered in ${Math.round(elapsedMs)} ms`);
			assert.deepEqual(stand.transactions, []);
			assert.deepEqual(stand.judged, []);
			assert.deepEqual(stand.lines, []);
			assert.deepEqual(stand.warnings, [
				{
					fields: { route: EXCHANGE_PATH },
					message: EXCHANGE_REQUEST_TIMEOUT,
				},
			]);
		});

		suite('a body arriving close to the late-request threshold', () => {
			// A deadline leaving the threshold and 300 ms more, so a body arriving 400 ms late finds less than
			// the threshold left, and one arriving 200 ms late finds more.
			const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 300;

			test('answers a credential whose body arrives with less than the threshold left 408 requestTimeout, judging nothing, recording nothing and writing no line naming the identity provider or the store', async (context) => {
				const stand = standUp(context, { deadlineMilliseconds });

				const answer = await postArrivingAfter(stand, CREDENTIAL_BODY, 400);

				assert.deepEqual(problemOf(answer), {
					code: 'requestTimeout',
					status: 408,
				});
				assert.deepEqual(stand.judged, []);
				assert.deepEqual(stand.transactions, []);
				assert.deepEqual(stand.lines, []);
				assert.deepEqual(
					stand.warnings.map(({ message }) => message),
					[EXCHANGE_REQUEST_TIMEOUT],
				);
			});

			test('answers the anonymous exchange whose body arrives with less than the threshold left 408 requestTimeout, beginning no transaction and writing no line naming the store', async (context) => {
				const stand = standUp(context, { deadlineMilliseconds });

				const answer = await postArrivingAfter(stand, ANONYMOUS_BODY, 400);

				assert.deepEqual(problemOf(answer), {
					code: 'requestTimeout',
					status: 408,
				});
				assert.deepEqual(stand.transactions, []);
				assert.deepEqual(stand.lines, []);
			});

			test('judges and records a credential whose body arrives with more than the threshold left, as any other', async (context) => {
				const stand = standUp(context, { deadlineMilliseconds });

				const answer = await postArrivingAfter(stand, CREDENTIAL_BODY, 200);

				assert.deepEqual(problemOf(answer), {
					code: 'credentialRefused',
					status: 403,
				});
				assert.deepEqual(
					stand.judged.map(({ credential }) => credential),
					['credential-forged'],
				);
				assert.deepEqual(
					recordedIn(stand).map(({ data }) => [data['result'], data['reason']]),
					[['denied', 'invalidSignature']],
				);
				assert.deepEqual(stand.warnings, []);
			});
		});

		test('answers as late a credential left less than the least judgement budget, whatever threshold the exchange was given, judging and recording nothing', async (context) => {
			const stand = standUp(context, {
				deadlineMilliseconds: RECORDING_RESERVE_MILLISECONDS + MINIMUM_JUDGEMENT_BUDGET_MILLISECONDS / 2,
				lateRequestThresholdMilliseconds: 0,
			});

			const answer = await post(stand, withCredential('credential-forged'));

			assert.deepEqual(problemOf(answer), {
				code: 'requestTimeout',
				status: 408,
			});
			assert.deepEqual(stand.judged, []);
			assert.deepEqual(stand.transactions, []);
			assert.deepEqual(stand.lines, []);
		});

		test("answers a credential whose judgement is not given by the deadline less the recording reserve 503 identityProviderUnavailable, recorded failed at error, as keys that cannot be had are, within the deadline, and drops the judgement's late failure", async (context) => {
			// The least deadline a credential is judged under, so the judge overruns the least budget.
			const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 50;
			const budgetMs = deadlineMilliseconds - RECORDING_RESERVE_MILLISECONDS;
			const judging: { fail: (failure: Error) => void } = {
				fail: () => undefined,
			};
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on('unhandledRejection', onUnhandled);
			context.after(() => {
				process.off('unhandledRejection', onUnhandled);
			});
			const stand = standUp(context, {
				deadlineMilliseconds,
				judge: () =>
					new Promise<SignInJudgement>((_resolve, reject) => {
						judging.fail = reject;
					}),
			});

			const { answer, elapsedMs } = await timedPost(stand, withCredential('credential-forged'));
			judging.fail(new Error('the shared fetch failed once the exchange was answered'));
			await delay(10);

			assert.deepEqual(problemOf(answer), {
				code: 'identityProviderUnavailable',
				status: 503,
			});
			assert.ok(
				elapsedMs >= budgetMs - 1 && elapsedMs < budgetMs + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.deepEqual(recordedIn(stand), [
				{
					data: {
						reason: 'identityProviderUnavailable',
						result: 'failed',
						sourceIp: '127.0.0.1',
						userId: null,
					},
					severity: 'error',
					type: 'token.exchange',
				},
			]);
			assert.deepEqual(unhandled, []);
			assert.deepEqual(stand.lines, []);
		});

		test("leaves a fetch of the identity provider's keys shared by every request running past one request's deadline, so it still serves a later request", async (context) => {
			const keysArrive = deferred();
			const shared: {
				fetches: number;
				inFlight: Promise<SignInJudgement> | undefined;
			} = { fetches: 0, inFlight: undefined };
			// The least deadline a credential is judged under, so the judgement is given the least budget.
			const stand = standUp(context, {
				deadlineMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS + 50,
				judge: () => {
					shared.inFlight ??= (() => {
						shared.fetches += 1;
						return keysArrive.promise.then((): SignInJudgement => ({
							kind: 'recorded',
							reason: 'invalidSignature',
						}));
					})();
					return shared.inFlight;
				},
			});

			const first = await post(stand, withCredential('credential-forged'));
			keysArrive.release();
			await shared.inFlight;
			const later = await post(stand, withCredential('credential-forged'));

			assert.deepEqual(problemOf(first), {
				code: 'identityProviderUnavailable',
				status: 503,
			});
			assert.deepEqual(problemOf(later), {
				code: 'credentialRefused',
				status: 403,
			});
			assert.equal(shared.fetches, 1);
			assert.deepEqual(
				recordedIn(stand).map(({ data }) => data['reason']),
				['identityProviderUnavailable', 'invalidSignature'],
			);
		});

		test("answers at the deadline while the key's confirmation is still pending, issuing the token, and leaves the confirmation to settle on its own", async (context) => {
			const deadlineMilliseconds = 300;
			const confirmation = deferred();
			const stand = standUp(context, {
				confirmationSettled: confirmation.promise,
				deadlineMilliseconds,
				lateRequestThresholdMilliseconds: 0,
			});

			const { answer, elapsedMs } = await timedPost(stand);
			const confirmedAtAnswer = stand.confirmed.length;
			confirmation.release();
			await delay(0);

			assert.equal(answer.statusCode, 200);
			assert.ok(
				elapsedMs >= deadlineMilliseconds - 1 && elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.equal(confirmedAtAnswer, 0);
			assert.equal(stand.confirmed.length, 1);
		});

		test("answers 503 storeUnavailable within the deadline, recording nothing and discarding the connection, when the store does not answer the anonymous exchange's transaction by then, though the store timeout is longer", async (context) => {
			const deadlineMilliseconds = 300;
			const stand = storeStandUp(context, {
				deadlineMilliseconds,
				holds: (text) => (text.startsWith('BEGIN') ? Infinity : undefined),
				storeTimeoutMilliseconds: 5000,
			});

			const { answer, elapsedMs } = await timedPost(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.ok(
				elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.deepEqual(stand.releases, [true]);
			assert.deepEqual(eventLinesIn(stand.lines()), []);
			assert.deepEqual(
				stand.lines().map(({ code, message }) => ({ code, message })),
				[{ code: 'storeTimeout', message: EXCHANGE_STORE_FAILED }],
			);
		});

		test('answers 503 storeUnavailable when less than the commit window is left to the deadline as the transaction ends, sending no COMMIT, destroying the connection and recording nothing', async (context) => {
			const deadlineMilliseconds = 400;
			const stand = storeStandUp(context, {
				deadlineMilliseconds,
				holds: (text) =>
					isInsert(text) ? deadlineMilliseconds - COMMIT_WINDOW_MILLISECONDS / 2 - 10 : undefined,
				storeTimeoutMilliseconds: 5000,
			});

			const { answer, elapsedMs } = await timedPost(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.ok(
				elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.equal(stand.statements.includes('COMMIT'), false);
			assert.deepEqual(stand.releases, [true]);
			assert.deepEqual(eventLinesIn(stand.lines()), []);
		});

		test("answers 503 outcomeUnknown within the deadline when the store does not answer the COMMIT by then, the trail's line naming the token.exchange it recorded", async (context) => {
			const deadlineMilliseconds = 300;
			const stand = storeStandUp(context, {
				deadlineMilliseconds,
				holds: (text) => (text === 'COMMIT' ? Infinity : undefined),
				storeTimeoutMilliseconds: 5000,
			});

			const { answer, elapsedMs } = await timedPost(stand);
			const [line, ...more] = stand.lines();

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
			assert.ok(
				elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.deepEqual(more, []);
			assert.equal(line?.['message'], 'audit.commitUnconfirmed');
			assert.match(
				JSON.stringify(line?.['events']),
				/^\[\{"id":"[0-9a-f-]{36}","type":"bio\.overture\.token\.exchange"\}\]$/u,
			);
			assert.deepEqual(stand.releases, [true]);
		});

		test('gives the COMMIT one more store timeout where the deadline is further, answering 503 outcomeUnknown within the store timeout rather than at the deadline', async (context) => {
			const storeTimeoutMilliseconds = 250;
			const stand = storeStandUp(context, {
				deadlineMilliseconds: CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS,
				holds: (text) => (text === 'COMMIT' ? Infinity : undefined),
				storeTimeoutMilliseconds,
			});

			const { answer, elapsedMs } = await timedPost(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
			assert.ok(
				elapsedMs >= storeTimeoutMilliseconds - 1 && elapsedMs < storeTimeoutMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
		});

		test("answers a refused credential 503 storeUnavailable within the deadline, recording nothing, when the store does not take its refusal's recording by then", async (context) => {
			// The least deadline a credential is judged under: judged at once, its recording is left the
			// reserve and a little more, which the store never answers.
			const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 50;
			const stand = storeStandUp(context, {
				deadlineMilliseconds,
				holds: (text) => (isInsert(text) ? Infinity : undefined),
				lateRequestThresholdMilliseconds: LATE_REQUEST_THRESHOLD_MILLISECONDS,
				storeTimeoutMilliseconds: 5000,
			});

			const { answer, elapsedMs } = await timedPost(stand, withCredential('credential-forged'));

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.ok(
				elapsedMs < deadlineMilliseconds + SCHEDULING_SLACK_MS,
				`answered in ${Math.round(elapsedMs)} ms`,
			);
			assert.equal(stand.statements.includes('COMMIT'), false);
			assert.deepEqual(eventLinesIn(stand.lines()), []);
		});

		test('issues as before through the trail when the store answers in time, recording one succeeded token.exchange', async (context) => {
			const stand = storeStandUp(context, {
				deadlineMilliseconds: 300,
				holds: () => undefined,
				storeTimeoutMilliseconds: 5000,
			});

			const answer = await post(stand);

			assert.equal(answer.statusCode, 200);
			assert.deepEqual(
				eventLinesIn(stand.lines()).map(({ data, type }) => ({
					result: (data as Readonly<Record<string, unknown>>)['result'],
					type,
				})),
				[{ result: 'succeeded', type: 'bio.overture.token.exchange' }],
			);
			assert.deepEqual(stand.releases, [undefined]);
		});
	});

	suite('a failure of its store work', () => {
		// A deadline leaving a credential its least judgement budget, and the store time to answer.
		const deadlineMilliseconds = LATE_REQUEST_THRESHOLD_MILLISECONDS + 2000;

		const failingAt = (
			context: TestContext,
			matches: (text: string) => boolean,
			endsConnection = false,
		): StoreStand =>
			storeStandUp(context, {
				deadlineMilliseconds,
				fault: { endsConnection, matches },
				holds: () => undefined,
				storeTimeoutMilliseconds: 5000,
			});

		test("gives each of its transactions the event recording a failure of its work: failed, storeUnavailable, at error, its actor anonymous, naming no userId, the request's address", async (context) => {
			const stand = standUp(context);
			const refusedByTheStore = standUp(context, {
				standing: 'revokedPrincipal',
			});

			await post(stand);
			await post(stand, withCredential('credential-forged'));
			await post(stand, withCredential('credential-accepted'));
			await post(refusedByTheStore, withCredential('credential-accepted'));

			// The anonymous exchange's, the forged credential's refusal, the issuance, and the refused
			// principal's standing read and refusal.
			assert.deepEqual(
				[...stand.transactions, ...refusedByTheStore.transactions].map(({ options }) => options?.failureEvent),
				[1, 2, 3, 4, 5].map(() => ({
					actor: { type: 'anonymous' },
					data: {
						reason: 'storeUnavailable',
						result: 'failed',
						sourceIp: '127.0.0.1',
						userId: null,
					},
					severity: 'error',
					type: 'token.exchange',
				})),
			);
		});

		test("answers the anonymous exchange whose token.exchange cannot be written 503 storeUnavailable, recording it failed in that event's place and writing the failure by its code", async (context) => {
			const stand = failingAt(context, isAuditInsert);

			const answer = await post(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.deepEqual(committedIn(stand), [STORE_FAILURE_ROW]);
			assert.deepEqual(eventsLoggedIn(stand), [
				{
					actorType: 'anonymous',
					reason: 'storeUnavailable',
					result: 'failed',
					type: 'bio.overture.token.exchange',
				},
			]);
			assert.deepEqual(
				stand
					.lines()
					.filter(({ message }) => message === EXCHANGE_STORE_FAILED)
					.map(({ code }) => code),
				['P0001'],
			);
			assert.deepEqual(stand.releases, [undefined]);
		});

		test("answers a refused credential whose refusal cannot be written 503 storeUnavailable rather than 403, recording it failed in the refusal's place", async (context) => {
			const stand = failingAt(context, isAuditInsert);

			const answer = await post(stand, withCredential('credential-forged'));

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.deepEqual(committedIn(stand), [STORE_FAILURE_ROW]);
			assert.deepEqual(
				eventsLoggedIn(stand).map(({ reason, result }) => [result, reason]),
				[['failed', 'storeUnavailable']],
			);
		});

		test('answers a first exchange whose identity cannot be written 503 storeUnavailable, issuing no token, recording it failed and keeping no person, no identity and no session', async (context) => {
			const stand = failingAt(context, (text) => isInsert(text) && text.includes('.user_identities '));

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.match(String(answer.headers['content-type']), /^application\/problem\+json\b/u);
			assert.ok(
				stand.statements.some((text) => isInsert(text) && text.includes('.users ')),
				'the person was written before the identity failed',
			);
			assert.deepEqual(committedIn(stand), [STORE_FAILURE_ROW]);
			assert.deepEqual(
				eventsLoggedIn(stand).map(({ reason, result }) => [result, reason]),
				[['failed', 'storeUnavailable']],
			);
		});

		test('records nothing when the failing statement ends the connection, answering 503 storeUnavailable and writing the failure, discarding the connection', async (context) => {
			const stand = failingAt(context, (text) => isInsert(text) && text.includes('.user_identities '), true);

			const answer = await post(stand, withCredential('credential-accepted'));

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.deepEqual(stand.committed, []);
			assert.deepEqual(eventLinesIn(stand.lines()), []);
			assert.deepEqual(
				stand.lines().map(({ message }) => message),
				[EXCHANGE_STORE_FAILED],
			);
			assert.deepEqual(stand.releases, [true]);
		});

		test('records nothing more when the COMMIT of an exchange whose work succeeded goes unanswered, answering 503 outcomeUnknown', async (context) => {
			const stand = storeStandUp(context, {
				deadlineMilliseconds: 300,
				holds: (text) => (text === 'COMMIT' ? Infinity : undefined),
				storeTimeoutMilliseconds: 5000,
			});

			const answer = await post(stand);

			assert.deepEqual(problemOf(answer), {
				code: 'outcomeUnknown',
				status: 503,
			});
			assert.equal(stand.statements.filter(isAuditInsert).length, 1);
			assert.equal(
				stand.statements.some((text) => text.startsWith('ROLLBACK TO')),
				false,
			);
			assert.deepEqual(stand.committed, []);
		});

		test("records nothing when the store stops answering the exchange's work by the deadline, answering 503 storeUnavailable with the store timeout's code", async (context) => {
			const stand = storeStandUp(context, {
				deadlineMilliseconds: 300,
				holds: (text) => (text.includes('application_resources') ? Infinity : undefined),
				storeTimeoutMilliseconds: 5000,
			});

			const answer = await post(stand);
			await delay(0);

			assert.deepEqual(problemOf(answer), {
				code: 'storeUnavailable',
				status: 503,
			});
			assert.deepEqual(stand.committed, []);
			assert.equal(stand.statements.filter(isAuditInsert).length, 0);
			assert.deepEqual(eventLinesIn(stand.lines()), []);
			assert.deepEqual(
				stand.lines().map(({ code, message }) => ({ code, message })),
				[{ code: 'storeTimeout', message: EXCHANGE_STORE_FAILED }],
			);
		});
	});

	suite("admission into its application's share", () => {
		test("answers an exchange over its application's share, the pool contended, 503 admissionShareExceeded with Retry-After 1 at once, after judging its credential, beginning no transaction and counting it for the application", async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});

			const holding = post(stand, withCredential('credential-forged'));
			const placeTaken = await untilTransactionsBegun(stand, 1);
			const answering = post(stand, withCredential('credential-expired'));
			const overShareAtOnce = await answeredAtOnce(answering);
			const transactionsWhileFull = stand.transactions.length;
			store.release();
			const [held, overShare] = await Promise.all([holding, answering]);

			assert.equal(placeTaken, true);
			assert.equal(overShareAtOnce, true);
			assert.deepEqual(problemOf(overShare), {
				code: 'admissionShareExceeded',
				status: 503,
			});
			assert.equal(overShare.headers['retry-after'], '1');
			assert.equal(overShare.headers['cache-control'], 'no-store');
			assert.match(String(overShare.headers['content-type']), /^application\/problem\+json\b/u);
			assert.equal(transactionsWhileFull, 1);
			assert.deepEqual(
				stand.judged.map(({ credential }) => credential),
				['credential-forged', 'credential-expired'],
			);
			assert.deepEqual(stand.countedOverShare, [APPLICATION]);
			assert.equal(held.statusCode, 403);
			assert.deepEqual(
				recordedIn(stand).map(({ data }) => data['reason']),
				['invalidSignature'],
			);
		});

		test('refuses a credential over its share, the pool contended, whatever its judgement, so none is answered 403 or 503 unrecorded', async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});
			const credentials = [
				'credential-accepted',
				'credential-expired',
				'credential-forged',
				'credential-under-a-new-key',
				'credential-while-keys-unavailable',
				'',
				'uak_example',
			];

			const holding = post(stand, withCredential('credential-of-no-session'));
			await untilTransactionsBegun(stand, 1);
			const answering = Promise.all(credentials.map((credential) => post(stand, withCredential(credential))));
			const allAtOnce = await answeredAtOnce(answering);
			const transactionsWhileFull = stand.transactions.length;
			store.release();
			const [answers] = await Promise.all([answering, holding]);

			assert.equal(allAtOnce, true);
			assert.deepEqual(
				answers.map(problemOf),
				credentials.map(() => ({
					code: 'admissionShareExceeded',
					status: 503,
				})),
			);
			answers.forEach((answer) => {
				assert.equal(answer.headers['retry-after'], '1');
			});
			assert.equal(transactionsWhileFull, 1);
			assert.deepEqual(
				stand.countedOverShare,
				credentials.map(() => APPLICATION),
			);
		});

		test('answers a credential whose signing key is not confirmed yet 503 admissionShareExceeded with the share full and the pool contended, counting it and recording nothing, and records it denied within the share', async (context) => {
			const store = deferred();
			const contended = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});
			const withinShare = standUp(context, { poolSize: 1 });

			const holding = post(contended, withCredential('credential-forged'));
			await untilTransactionsBegun(contended, 1);
			const overShare = await post(contended, withCredential('credential-under-a-new-key'));
			store.release();
			await holding;
			const recorded = await post(withinShare, withCredential('credential-under-a-new-key'));

			assert.deepEqual(
				{
					problem: problemOf(overShare),
					retryAfter: overShare.headers['retry-after'],
				},
				{
					problem: { code: 'admissionShareExceeded', status: 503 },
					retryAfter: '1',
				},
			);
			assert.deepEqual(contended.countedOverShare, [APPLICATION]);
			assert.deepEqual(
				recordedIn(contended).map(({ data }) => data['reason']),
				['invalidSignature'],
			);
			assert.deepEqual(
				{
					problem: problemOf(recorded),
					retryAfter: recorded.headers['retry-after'],
				},
				{
					problem: { code: 'signingKeyUnconfirmed', status: 503 },
					retryAfter: '17',
				},
			);
			assert.deepEqual(withinShare.countedOverShare, []);
			assert.deepEqual(
				recordedIn(withinShare).map(({ data }) => ({
					reason: data['reason'],
					result: data['result'],
				})),
				[{ reason: 'signingKeyUnconfirmed', result: 'denied' }],
			);
		});

		test("lends a connection idle past the application's share, and refuses its next exchange once the exchanges in flight reach the pool's connections", async (context) => {
			const store = deferred();
			// Two applications registered over two connections: a share of one each.
			const stand = standUp(context, {
				poolSize: 2,
				registered: 2,
				storeTakes: store.promise,
			});

			const holding = [
				post(stand, withCredential('credential-forged')),
				post(stand, withCredential('credential-expired')),
			];
			const bothBegun = await untilTransactionsBegun(stand, 2);
			const inFlightOnceBorrowed = stand.inFlight();
			const overShare = await post(stand, withCredential('uak_example'));
			store.release();
			const held = await Promise.all(holding);

			assert.equal(bothBegun, true);
			assert.equal(inFlightOnceBorrowed, 2);
			assert.deepEqual(held.map(problemOrStatusOf), ['credentialRefused', 'credentialRefused']);
			assert.equal(problemOf(overShare).code, 'admissionShareExceeded');
			assert.deepEqual(stand.countedOverShare, [APPLICATION]);
			assert.equal(stand.inFlight(), 0);
		});

		test('takes no place for an exchange refused before its store work, for its assertion, its body, or a judgement that fails unexpectedly, each answered as it would be with the share free', async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});

			const holding = post(stand, withCredential('credential-forged'));
			await untilTransactionsBegun(stand, 1);
			const answering = Promise.all([
				post(stand, { assertion: null }),
				post(stand, {
					assertion: 'Bearer assertion-of-a-keyless-application',
				}),
				post(stand, { body: '[1]' }),
				post(stand, { body: '{"payloadVersions":[2]}' }),
				post(stand, {
					body: JSON.stringify({ padding: 'x'.repeat(65_536) }),
				}),
				post(stand, withCredential('a credential the stand cannot judge')),
			]);
			const allAtOnce = await answeredAtOnce(answering);
			const transactionsWhileFull = stand.transactions.length;
			store.release();
			const [answers] = await Promise.all([answering, holding]);

			assert.equal(allAtOnce, true);
			assert.deepEqual(
				answers.map(({ statusCode }) => statusCode),
				[401, 401, 400, 406, 413, 500],
			);
			assert.deepEqual(stand.countedOverShare, []);
			assert.equal(transactionsWhileFull, 1);
		});

		test("releases the place once the exchange's store work has ended, whether its transaction committed or failed, so each exchange after it is admitted", async (context) => {
			const stand = standUp(context, { poolSize: 1 });
			const failing = standUp(context, {
				poolSize: 1,
				readFailure: storeFailure('57P01'),
			});
			const unconfirmed = standUp(context, {
				commitFailure: new CommitUnconfirmed(),
				poolSize: 1,
			});

			const answers = [
				await post(stand),
				await post(stand, withCredential('credential-forged')),
				await post(stand),
				await post(failing),
				await post(failing),
				await post(unconfirmed, withCredential('credential-forged')),
				await post(unconfirmed),
			];

			assert.deepEqual(answers.map(problemOrStatusOf), [
				200,
				'credentialRefused',
				200,
				'storeUnavailable',
				'storeUnavailable',
				'outcomeUnknown',
				'outcomeUnknown',
			]);
			assert.deepEqual(
				[...stand.countedOverShare, ...failing.countedOverShare, ...unconfirmed.countedOverShare],
				[],
			);
			assert.deepEqual(
				[stand, failing, unconfirmed].map(({ inFlight }) => inFlight()),
				[0, 0, 0],
			);
		});

		test('issues one anonymous exchange past a full share while the pool is contended, and refuses a second one concurrent with it 503', async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});

			const recording = post(stand, withCredential('credential-forged'));
			await untilTransactionsBegun(stand, 1);
			const admittedPastShare = post(stand);
			const laneTaken = await untilTransactionsBegun(stand, 2);
			const second = post(stand);
			const secondAtOnce = await answeredAtOnce(second);
			store.release();
			const [recorded, issued, refused] = await Promise.all([recording, admittedPastShare, second]);

			assert.equal(laneTaken, true);
			assert.equal(secondAtOnce, true);
			assert.equal(recorded.statusCode, 403);
			assert.equal(issued.statusCode, 200);
			assert.equal(issued.headers['content-type'], 'application/jwt');
			assert.deepEqual(problemOf(refused), {
				code: 'admissionShareExceeded',
				status: 503,
			});
			assert.equal(refused.headers['retry-after'], '1');
			assert.equal(stand.transactions.length, 2);
			assert.deepEqual(stand.countedOverShare, [APPLICATION]);
		});

		test("counts an assertion it verified and refused rather than recording it, with its application's share full and the pool contended, answering it 401 alike and counting no exchange over the share", async (context) => {
			const store = deferred();
			const stand = standUp(context, {
				poolSize: 1,
				storeTakes: store.promise,
			});

			const holding = post(stand, withCredential('credential-forged'));
			await untilTransactionsBegun(stand, 1);
			const whileFull = await post(stand, {
				assertion: 'Bearer assertion-expired',
			});
			await stand.stop();
			const outsideWhileFull = stand.outside.length;
			store.release();
			await holding;
			const onceFree = await post(stand, {
				assertion: 'Bearer assertion-for-another-audience',
			});
			await stand.stop();

			assert.deepEqual(
				[whileFull, onceFree].map(({ statusCode }) => statusCode),
				[401, 401],
			);
			assert.equal(outsideWhileFull, 0);
			assert.deepEqual(stand.counted, [{ applicationId: APPLICATION, reason: 'expiredAssertion' }]);
			assert.deepEqual(
				stand.outside.map(({ event }) => event.data['reason']),
				['otherAudience'],
			);
			assert.deepEqual(stand.countedOverShare, []);
		});

		test("holds a place in the application's share while a refused assertion's rejection is being recorded", async (context) => {
			const written = deferred();
			const stand = standUp(context, {
				outsideRecorded: written.promise,
				poolSize: 1,
			});

			const refused = await post(stand, {
				assertion: 'Bearer assertion-expired',
			});
			const inFlightWhileRecording = stand.inFlight();
			const whileRecording = await post(stand, withCredential('credential-forged'));
			written.release();
			await stand.stop();
			const afterwards = await post(stand, withCredential('credential-forged'));

			assert.equal(refused.statusCode, 401);
			assert.equal(inFlightWhileRecording, 1);
			assert.equal(problemOf(whileRecording).code, 'admissionShareExceeded');
			assert.equal(problemOf(afterwards).code, 'credentialRefused');
			assert.equal(stand.outside.length, 1);
		});
	});
});

suite('the credentials the exchange refuses, counted in windows', () => {
	const INSTANT = new Date(NOW).toISOString();

	test("records a refused credential's first refusal and answers each later one alike at once, recording nothing and taking no place: a verified token's by its digest and reason, any other credential's by its application and reason", async (context) => {
		const stand = standUp(context);

		const first = [
			await post(stand, withCredential('credential-expired')),
			await post(stand, withCredential('credential-forged')),
		];
		const transactionsAfterFirst = stand.transactions.length;
		const later = [
			await post(stand, withCredential('credential-expired')),
			await post(stand, withCredential('credential-forged')),
			await post(stand, withCredential('credential-forged-otherwise')),
		];

		const answers = [...first, ...later];
		const shown = answers.map(onTheWire);
		shown.forEach((answer) => assert.deepEqual(answer, shown[0]));
		assert.deepEqual(
			answers.map(problemOf),
			answers.map(() => ({ code: 'credentialRefused', status: 403 })),
		);
		assert.equal(transactionsAfterFirst, 2);
		assert.equal(stand.transactions.length, 2);
		assert.equal(stand.inFlight(), 0);
	});

	test('closes each window at the stop with token.exchangeRefusalTally as the system, naming its count, its reason, the application for a credential that did not verify, and its opening event', async (context) => {
		const stand = standUp(context);
		await post(stand, withCredential('credential-expired'));
		await post(stand, withCredential('credential-expired'));
		await post(stand, withCredential('credential-forged'));
		await post(stand, withCredential('credential-forged-otherwise'));
		await post(stand, withCredential('credential-forged'));

		await stand.closeWindows();

		assert.deepEqual(stand.closings, [
			{
				actor: { type: 'system' },
				event: {
					data: {
						count: 2,
						firstSeenAt: INSTANT,
						lastSeenAt: INSTANT,
						reason: 'expiredToken',
						windowId: 'event-id',
					},
					severity: 'warning',
					type: 'token.exchangeRefusalTally',
				},
			},
			{
				actor: { type: 'system' },
				event: {
					data: {
						applicationId: APPLICATION,
						count: 3,
						firstSeenAt: INSTANT,
						lastSeenAt: INSTANT,
						reason: 'invalidSignature',
						windowId: 'event-id',
					},
					severity: 'warning',
					type: 'token.exchangeRefusalTally',
				},
			},
		]);
	});

	test('reads the standing of a principal the store refuses on each exchange, recording only the refusal opening its window', async (context) => {
		const stand = standUp(context, { standing: 'revokedPrincipal' });

		const answers = [
			await post(stand, withCredential('credential-accepted')),
			await post(stand, withCredential('credential-accepted')),
		];
		await stand.closeWindows();

		answers.forEach((answer) => {
			assert.deepEqual(problemOf(answer), {
				code: 'credentialRefused',
				status: 403,
			});
		});
		assert.deepEqual(
			stand.transactions.map((transaction) => ({
				recorded: transaction.recorded.map(({ data }) => data['reason']),
				statements: statementKindsIn(transaction),
			})),
			[
				{ recorded: [], statements: ['standing'] },
				{ recorded: ['revokedPrincipal'], statements: [] },
				{ recorded: [], statements: ['standing'] },
			],
		);
		assert.deepEqual(
			stand.closings.map(({ event }) => [event.data['reason'], event.data['count']]),
			[['revokedPrincipal', 2]],
		);
	});

	test('answers a signing key not confirmed yet 503 with Retry-After each time, recording only the refusal opening its window', async (context) => {
		const stand = standUp(context);

		const answers = [
			await post(stand, withCredential('credential-under-a-new-key')),
			await post(stand, withCredential('credential-under-a-new-key')),
		];

		answers.forEach((answer) => {
			assert.deepEqual(problemOf(answer), {
				code: 'signingKeyUnconfirmed',
				status: 503,
			});
			assert.equal(answer.headers['retry-after'], '17');
		});
		assert.equal(stand.transactions.length, 1);
	});

	test('records every exchange refused failed, a window counting none of them', async (context) => {
		const stand = standUp(context);

		await post(stand, withCredential('credential-while-keys-unavailable'));
		await post(stand, withCredential('credential-while-keys-unavailable'));
		await stand.closeWindows();

		assert.deepEqual(
			stand.transactions.map(({ recorded }) => recorded.map(({ data }) => [data['result'], data['reason']])),
			[[['failed', 'identityProviderUnavailable']], [['failed', 'identityProviderUnavailable']]],
		);
		assert.deepEqual(stand.closings, []);
	});

	test('answers a refusal counted in an open window 403 at once while its share is full and the pool contended', async (context) => {
		const store = deferred();
		const stand = standUp(context, { poolSize: 1, storeTakes: store.promise });

		const opening = post(stand, withCredential('credential-forged'));
		await untilTransactionsBegun(stand, 1);
		const counted = await answeredAtOnce(post(stand, withCredential('credential-forged-otherwise')));
		const answer = await post(stand, withCredential('credential-forged-otherwise'));
		store.release();
		await opening;

		assert.equal(counted, true);
		assert.deepEqual(problemOf(answer), {
			code: 'credentialRefused',
			status: 403,
		});
		assert.deepEqual(stand.countedOverShare, []);
		assert.equal(stand.transactions.length, 1);
	});
});
