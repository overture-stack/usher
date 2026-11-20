import { randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import pg from 'pg';

import { migrate, migrateThroughCommand, type MigrationOptions, writeSeedFile } from '../harness/controller.js';
import {
	createTestDatabase,
	type DatabaseRole,
	DATABASE_ROLES,
	type DatabaseTemplate,
	TEMPLATE_SETTINGS,
	type TestDatabase,
	type TestDatabaseOptions,
	USHER_SCHEMA,
	USHER_TEMPLATE,
} from '../harness/database.js';
import {
	type Actor,
	declareActor,
	DEFAULT_FIXTURE_ISSUER,
	fixtureApplicationId,
	highestPosition,
	inTransactionAs,
	inTurn,
	noticesAfter,
	noticeSubject,
	type PolicyFixture,
	POLICY_TABLES,
	qualified,
	seededId,
	type SeededPolicy,
	seedPolicy,
	STEWARD,
	type StoredNotice,
	SYSTEM_ACTOR,
} from '../harness/policy.js';

// The database tests' own support (#207). Every table, column and stored form it relies on comes from
// policy.ts.

const {
	administrators,
	applicationKeys,
	applicationResources,
	applications,
	auditLog,
	capabilities,
	categories,
	changeRecords,
	grantDecisions,
	grants,
	groupUsers,
	groups,
	invitations,
	nominations,
	noticeStream,
	notices,
	policyGeneration,
	principalRevocations,
	resourceCategories,
	resourceFieldValues,
	resourceFields,
	resources,
	rolePermissions,
	roles,
	schemaMigrations,
	userIdentities,
	users,
} = POLICY_TABLES;

/** A table as `policy.ts` names it. */
export interface NamedTable {
	name: string;
}

/** A row to write or a row read back, keyed by column name. */
export type Row = Readonly<Record<string, unknown>>;

/** A second identity provider's issuer, beside the fixture's default, {@link DEFAULT_FIXTURE_ISSUER}. */
export const SECOND_ISSUER = 'https://login.example.org';

/** The invented subjects of the base fixture's people, as each provider writes them. */
export const SUBJECTS = Object.freeze({
	ana: '5f0c9a7e-3b2d-4e1f-8a6c-2d9e4b7f1a03',
	bo: 'auth0|65f1c2d3e4b5a69788d1e2f3',
	cy: 'c3d0b8a1-7e6f-4a5b-9c8d-1e2f3a4b5c6d',
});

/** A person acting, as a transaction declares them: Ana, by her subject. */
export const ANA_ACTING: Actor = Object.freeze({
	id: SUBJECTS.ana,
	type: 'human',
});

/**
 * The policy most database tests start from: three people under two providers, three resources
 * (`STUDY-A1` at the grant tier offering `controlled` and `unmarked`, `STUDY-B2` and `study.c_3`
 * offering `unmarked`), two applications labelled `ims-arranger`, serving `STUDY-A1` and `STUDY-B2`,
 * and `ims-lyric`, serving `STUDY-A1`, each under the id derived from its label by
 * `policy.ts`'s `fixtureApplicationId`, the roles `owner`, `submitter` and `viewer` (written by the
 * Controller at start, so a freshly migrated store holds none), Ana's accepted `viewer` grant on
 * `STUDY-A1` under `controlled`, and Bo's `owner` grant there on the whole resource.
 */
export const BASE_FIXTURE: PolicyFixture = Object.freeze<PolicyFixture>({
	applications: {
		'ims-arranger': { serves: ['STUDY-A1', 'STUDY-B2'] },
		'ims-lyric': { serves: ['STUDY-A1'] },
	},
	categories: {
		controlled: { description: 'Records under a data access committee' },
	},
	decisions: [{ decision: 'accepted', grant: 'anaViews' }],
	grants: {
		anaViews: {
			category: 'controlled',
			holder: { user: 'ana' },
			resource: 'STUDY-A1',
			role: 'viewer',
		},
		boOwns: {
			category: null,
			holder: { user: 'bo' },
			resource: 'STUDY-A1',
			role: 'owner',
		},
	},
	resources: {
		'STUDY-A1': {
			baseTier: 'grant',
			name: 'Cardiac Outcomes',
			offers: ['controlled', 'unmarked'],
		},
		'STUDY-B2': {
			baseTier: 'registered',
			name: 'Members Archive',
			offers: ['unmarked'],
		},
		'study.c_3': {
			baseTier: 'open',
			name: 'Open Atlas',
			offers: ['unmarked'],
		},
	},
	roles: {
		owner: {
			capabilities: ['grant.create', 'grant.revoke', 'resource.view'],
			plane: 'control',
		},
		submitter: {
			capabilities: ['record.create', 'record.update'],
			plane: 'data',
		},
		viewer: {
			capabilities: ['record.count', 'record.export', 'record.view'],
			plane: 'data',
		},
	},
	users: {
		ana: { subject: SUBJECTS.ana },
		bo: { issuer: SECOND_ISSUER, subject: SUBJECTS.bo },
		cy: { subject: SUBJECTS.cy },
	},
});

/**
 * Opens a database of the test's own, cloned from the template the Controller's migrations build,
 * and drops it once the test has ended.
 *
 * @param context the test the database belongs to.
 * @param options the retention floor, and the PostgreSQL to create it on.
 */
export const openDatabase = async (context: TestContext, options: TestDatabaseOptions = {}): Promise<TestDatabase> => {
	const database = await createTestDatabase(USHER_TEMPLATE, options);
	context.after(() => database.close());
	return database;
};

/** A database, its owner's connection, and the ids its fixture was seeded with. */
export interface SeededDatabase {
	database: TestDatabase;

	/** A connection under the migration role, which owns the schema. */
	owner: pg.Client;

	seeded: SeededPolicy;
}

/**
 * Opens a database of the test's own and seeds a fixture in it by SQL, under the system actor.
 *
 * @param context the test the database belongs to.
 * @param fixture the policy to seed: {@link BASE_FIXTURE} by default.
 * @param options the retention floor, and the PostgreSQL to create it on.
 */
export const openSeededDatabase = async (
	context: TestContext,
	fixture: PolicyFixture = BASE_FIXTURE,
	options: TestDatabaseOptions = {},
): Promise<SeededDatabase> => {
	const database = await openDatabase(context, options);
	const owner = await database.connect('migration');
	const seeded = await seedPolicy(owner, fixture);
	return { database, owner, seeded };
};

const EMPTY_TEMPLATE: DatabaseTemplate = Object.freeze({
	migrate: async (): Promise<void> => undefined,
	name: `usher_empty_${randomBytes(6).toString('hex')}`,
	schema: USHER_SCHEMA,
});

/**
 * Opens an empty database of the test's own, owned by the migration role and holding nothing the
 * migrations write, for the migration tests to migrate themselves.
 *
 * @param context the test the database belongs to.
 */
export const openEmptyDatabase = async (context: TestContext): Promise<TestDatabase> => {
	const database = await createTestDatabase(EMPTY_TEMPLATE);
	context.after(() => database.close());
	return database;
};

/** What a migration run is told beyond the database: each has the template's default. */
export interface MigrationRun {
	/** The seed file a first run seeds from; a database not yet seeded gets the template's settings when absent. */
	seedFile?: string;

	/** The runtime role the migrations grant to: the Controller's, which the deployment creates, by default. */
	runtimeRole?: string;

	/** The last migration to apply; every migration when absent. Only a run in-process takes one. */
	target?: string;
}

const migrationOptionsFor = (
	database: TestDatabase,
	{ runtimeRole = DATABASE_ROLES.runtime, target }: MigrationRun,
): MigrationOptions => ({
	databaseUrl: database.urlFor('migration'),
	runtimeRole,
	schema: database.schema,
	settings: TEMPLATE_SETTINGS,
	...(target === undefined ? {} : { target }),
});

/**
 * Runs every one of the Controller's migrations on a database through the run's build of the schema
 * migration command, as a deployment runs it: under the schema migration role, granting to the
 * runtime role, in the schema named for Usher.
 *
 * @param database the database to migrate.
 * @param run the runtime role.
 * @returns each line the command wrote to standard output, parsed.
 * @throws {Error} carrying what the command wrote, when the run fails or is refused.
 */
export const migrateDatabase = async (
	database: TestDatabase,
	{ seedFile, runtimeRole = DATABASE_ROLES.runtime }: Omit<MigrationRun, 'target'> = {},
): Promise<readonly unknown[]> =>
	migrateThroughCommand({
		...((file) => (file === undefined ? {} : { seedFile: file }))(
			seedFile ?? ((await isSeeded(database)) ? undefined : await writeSeedFile(TEMPLATE_SETTINGS)),
		),
		databaseUrl: database.urlFor('migration'),
		runtimeRole,
		schema: database.schema,
	});

// Whether the database holds settings yet: a run against it is a later run, which reads no seed file.
const isSeeded = async (database: TestDatabase): Promise<boolean> => {
	const owner = await database.connect('migration');
	const { rows } = await owner.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [
		`${pg.escapeIdentifier(database.schema)}.settings`,
	]);
	if (rows[0]?.present !== true) {
		return false;
	}
	const stored = await owner.query<{ stored: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(database.schema)}.settings) AS stored`,
	);
	return stored.rows[0]?.stored === true;
};

/**
 * Runs the Controller's migrations on a database in-process, through the seam's `migrate`, as
 * {@link migrateDatabase} does through the command but for one thing: a target, for a step-by-step
 * run the command never makes.
 *
 * @param database the database to migrate.
 * @param run the runtime role and the target.
 * @throws {Error} the run's own failure or refusal.
 */
export const migrateDatabaseInProcess = (database: TestDatabase, run: MigrationRun = {}): Promise<void> =>
	migrate(migrationOptionsFor(database, run));

/**
 * Opens a connection under a role whose session reads and writes times in the given zone.
 *
 * @param database the database to connect to.
 * @param role the role to connect under.
 * @param timeZone an IANA zone name, such as `America/Toronto`.
 */
export const connectInTimeZone = async (
	database: TestDatabase,
	role: DatabaseRole,
	timeZone: string,
): Promise<pg.Client> => {
	const client = await database.connect(role);
	await client.query("SELECT set_config('TimeZone', $1, false)", [timeZone]);
	return client;
};

/**
 * Inserts one row, as written, returning the row the database stored.
 *
 * @param client the connection, inside a transaction declaring its actor where the table needs one.
 * @param table the table to write.
 * @param row the values by column name; a column left out takes its default.
 */
export const insertRow = async (client: pg.ClientBase, table: NamedTable, row: Row): Promise<Row> => {
	const entries = Object.entries(row);
	const placeholders = [...entries.keys()].map((index) => `$${index + 1}`);
	const { rows } = await client.query<Row>(
		`INSERT INTO ${qualified(table)} (${entries.map(([column]) => pg.escapeIdentifier(column)).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
		entries.map(([, value]) => value),
	);
	const [stored] = rows;
	if (stored !== undefined) {
		return stored;
	}
	throw new Error(`the insert into ${table.name} returned no row`);
};

/**
 * Inserts one row in a transaction of its own that declares its actor, and commits it.
 *
 * @param client a connection holding no transaction.
 * @param table the table to write.
 * @param row the values by column name.
 * @param actor who acts: the system actor by default.
 */
export const committedInsert = (
	client: pg.ClientBase,
	table: NamedTable,
	row: Row,
	actor: Actor = SYSTEM_ACTOR,
): Promise<Row> => inTransactionAs(client, actor, () => insertRow(client, table, row));

/**
 * Runs one statement in a transaction of its own that declares its actor, and commits it.
 *
 * @param client a connection holding no transaction.
 * @param text the statement.
 * @param parameters its parameters.
 * @param actor who acts: the system actor by default.
 */
export const committedQuery = (
	client: pg.ClientBase,
	text: string,
	parameters: readonly unknown[] = [],
	actor: Actor = SYSTEM_ACTOR,
): Promise<pg.QueryResult<Row>> => inTransactionAs(client, actor, () => client.query<Row>(text, [...parameters]));

/**
 * The rows of one query, typed as the caller reads them.
 *
 * @param client the connection.
 * @param text the query.
 * @param parameters its parameters.
 */
export const selectRows = async <Selected extends object>(
	client: pg.ClientBase,
	text: string,
	parameters: readonly unknown[] = [],
): Promise<readonly Selected[]> => (await client.query<Selected>(text, [...parameters])).rows;

/**
 * Whether a promise is refused by the store, settling to `false` when it succeeds.
 *
 * @param attempt the write attempted.
 */
export const refusedByStore = (attempt: Promise<unknown>): Promise<boolean> =>
	attempt.then(
		() => false,
		(error: unknown) => isStoreRefusal(error),
	);

/** The SQLSTATE codes of the integrity constraints the schema states, as PostgreSQL raises them. */
export const INTEGRITY = Object.freeze({
	check: '23514',
	foreignKey: '23503',
	notNull: '23502',
	restrict: '23001',
	unique: '23505',
});

/**
 * The codes a delete is refused with while an `ON DELETE RESTRICT` key references the row:
 * PostgreSQL 15 answers 23503 and PostgreSQL 18 answers 23001. A test pins that the key refuses the
 * delete, not which of the two the server gives.
 */
export const RESTRICTED_DELETE_CODES: ReadonlySet<string> = new Set([INTEGRITY.foreignKey, INTEGRITY.restrict]);

/**
 * Whether an error is a delete refused by a referencing `ON DELETE RESTRICT` key, under either of
 * {@link RESTRICTED_DELETE_CODES}, for `assert.rejects`.
 *
 * @param error what the delete rejected with.
 */
export const isRestrictedDelete = (error: unknown): boolean =>
	error instanceof pg.DatabaseError && error.code !== undefined && RESTRICTED_DELETE_CODES.has(error.code);

/** PostgreSQL's code for a privilege the role does not hold, ownership included. */
export const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * What a refusal by a named constraint looks like, for `assert.rejects`.
 *
 * @param code the SQLSTATE expected.
 * @param constraint the constraint's or index's name, when the test names one.
 */
export const violation = (code: string, constraint?: string): Readonly<{ code: string; constraint?: string }> => ({
	code,
	...(constraint === undefined ? {} : { constraint }),
});

// A trigger may raise with PL/pgSQL's default code or any of the integrity class, and a privilege
// or an identity column refuses with its own. A syntax error or a missing object is a defect of the
// test, so those classes are left out.
const REFUSAL_CODES: ReadonlySet<string> = new Set([INSUFFICIENT_PRIVILEGE, '428C9']);

const REFUSAL_CLASSES: ReadonlySet<string> = new Set(['23', 'P0']);

/**
 * Whether an error is the store refusing a write, by any mechanism the design leaves open: an
 * integrity constraint, a trigger raising, a privilege, or an identity column generated always.
 * For `assert.rejects` where the design names no mechanism.
 *
 * @param error what a statement rejected with.
 */
export const isStoreRefusal = (error: unknown): boolean =>
	error instanceof pg.DatabaseError &&
	error.code !== undefined &&
	(REFUSAL_CODES.has(error.code) || REFUSAL_CLASSES.has(error.code.slice(0, 2)));

/** What a write came to: `accepted`, or the SQLSTATE the store refused it with. */
export type WriteOutcome = string;

/**
 * What a write came to: `accepted` when it succeeds, or the SQLSTATE the store refused it with. An
 * error carrying no SQLSTATE is rethrown, since it is no refusal of the store's.
 *
 * @param attempt the write attempted.
 */
export const writeOutcome = (attempt: Promise<unknown>): Promise<WriteOutcome> =>
	attempt.then(
		() => 'accepted',
		(error: unknown) => {
			if (error instanceof pg.DatabaseError && error.code !== undefined) {
				return error.code;
			}
			throw error;
		},
	);

/**
 * A connection's server process id, as `pg_stat_activity` and `pg_blocking_pids` name it.
 *
 * @param client the connection.
 */
export const backendPid = async (client: pg.ClientBase): Promise<number> => {
	const [row] = await selectRows<{ pid: number }>(client, 'SELECT pg_backend_pid() AS pid');
	if (row !== undefined) {
		return row.pid;
	}
	throw new Error('the connection reported no process id');
};

/**
 * Checks a condition every 20 ms until it holds or the time runs out, for a test that must act
 * once another session has reached a given point and never on a guess of how long that takes.
 *
 * @param condition the check.
 * @param timeoutMs how long to keep checking: 10 s by default.
 * @returns whether the condition held before the time ran out.
 */
export const pollUntil = async (condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	const check = async (): Promise<boolean> => {
		if (await condition()) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(20);
		return check();
	};
	return check();
};

/**
 * Waits, within 10 s, until a session is inside `pg_sleep`, as a slow statement is while it
 * evaluates.
 *
 * @param observer a connection under the same role, which may read the session's wait event.
 * @param pid the sleeping session's process id.
 */
export const untilSleeping = (observer: pg.ClientBase, pid: number): Promise<boolean> =>
	pollUntil(async () => {
		const [row] = await selectRows<{ sleeping: boolean }>(
			observer,
			"SELECT coalesce(wait_event = 'PgSleep', false) AS sleeping FROM pg_stat_activity WHERE pid = $1",
			[pid],
		);
		return row?.sleeping === true;
	});

/** A fresh person's row: the person alone, each of their identities a row of its own. */
export const userRow = (): Row => ({
	[users.columns.createdAt]: new Date(),
});

/**
 * An identity's row: who a person is at one identity provider.
 *
 * @param userId the person's `users.id`.
 * @param subject the provider's subject identifier.
 * @param issuer the provider's issuer: the fixture's default, a Keycloak realm, by default.
 * @param addedBy who added it, as a `users.id`; nobody, as on a first meeting, by default.
 */
export const identityRow = (
	userId: string,
	subject: string,
	issuer: string = DEFAULT_FIXTURE_ISSUER,
	addedBy: string | null = null,
): Row => ({
	[userIdentities.columns.addedAt]: new Date(),
	[userIdentities.columns.addedBy]: addedBy,
	[userIdentities.columns.idpIssuer]: issuer,
	[userIdentities.columns.idpSubjectId]: subject,
	[userIdentities.columns.userId]: userId,
});

/**
 * Writes a person and their one identity in the caller's transaction, as a first meeting does.
 *
 * @param client a connection with a transaction open.
 * @param subject the provider's subject identifier.
 * @param issuer the provider's issuer: the fixture's default by default.
 * @returns the person's `users.id`.
 */
export const insertPerson = async (
	client: pg.ClientBase,
	subject: string,
	issuer: string = DEFAULT_FIXTURE_ISSUER,
): Promise<string> => {
	const person = await insertRow(client, users, userRow());
	const userId = String(person[users.columns.id]);
	await insertRow(client, userIdentities, identityRow(userId, subject, issuer));
	return userId;
};

/**
 * Writes a person and their one identity in a transaction of its own, under the system actor.
 *
 * @param client a connection holding no transaction.
 * @param subject the provider's subject identifier.
 * @param issuer the provider's issuer: the fixture's default by default.
 * @returns the person's `users.id`.
 */
export const committedPerson = (
	client: pg.ClientBase,
	subject: string,
	issuer: string = DEFAULT_FIXTURE_ISSUER,
): Promise<string> => inTransactionAs(client, SYSTEM_ACTOR, () => insertPerson(client, subject, issuer));

/**
 * A resource's row at the open tier, leaving `suppressed` to its default.
 *
 * @param externalId the identifier the data carries.
 * @param registeredBy the registering principal's id.
 */
export const resourceRow = (externalId: string, registeredBy: string): Row => ({
	[resources.columns.baseTier]: 'open',
	[resources.columns.externalId]: externalId,
	[resources.columns.name]: `Study ${externalId}`,
	[resources.columns.registeredAt]: new Date(),
	[resources.columns.registeredBy]: registeredBy,
	[resources.columns.updatedAt]: new Date(),
});

/**
 * A global category's row.
 *
 * @param name the name, without its `global.` scope.
 */
export const globalCategoryRow = (name: string): Row => ({
	[categories.columns.name]: name,
	[categories.columns.scope]: 'global',
});

/**
 * A resource category's row.
 *
 * @param name the name, without its `resource.` scope.
 * @param resourceId the resource it belongs to.
 */
export const resourceCategoryRow = (name: string, resourceId: string): Row => ({
	[categories.columns.name]: name,
	[categories.columns.resourceId]: resourceId,
	[categories.columns.scope]: 'resource',
});

/** What a grant's row is built from; each optional column is null unless given. */
export interface GrantParts {
	expiresAt?: Date;
	fieldCategoryId?: string;
	grantedBy: string;
	holderGroupId?: string;
	holderUserId?: string;
	recordCategoryId?: string;
	resourceId: string;
	revoked?: { at: Date; by: string };
	roleId: string;
}

/**
 * A grant's row.
 *
 * @param parts the grant's resource, holder, categories, role, granter, expiry and revocation.
 */
export const grantRow = ({
	expiresAt,
	fieldCategoryId,
	grantedBy,
	holderGroupId,
	holderUserId,
	recordCategoryId,
	resourceId,
	revoked,
	roleId,
}: GrantParts): Row => ({
	[grants.columns.expiresAt]: expiresAt ?? null,
	[grants.columns.fieldCategoryId]: fieldCategoryId ?? null,
	[grants.columns.grantedAt]: new Date(),
	[grants.columns.grantedBy]: grantedBy,
	[grants.columns.holderGroupId]: holderGroupId ?? null,
	[grants.columns.holderUserId]: holderUserId ?? null,
	[grants.columns.recordCategoryId]: recordCategoryId ?? null,
	[grants.columns.resourceId]: resourceId,
	[grants.columns.revokedAt]: revoked?.at ?? null,
	[grants.columns.revokedBy]: revoked?.by ?? null,
	[grants.columns.roleId]: roleId,
});

/**
 * A nomination of a person to be an administrator.
 *
 * @param parts the nominee and the nominator, by `users.id`, the nomination's id, generated by the
 *   store by default, and when: now by default.
 */
export const nominationRow = ({
	id,
	nominatedAt = new Date(),
	nominatedBy,
	nomineeId,
}: {
	id?: string;
	nominatedAt?: Date;
	nominatedBy: string;
	nomineeId: string;
}): Row => ({
	...(id === undefined ? {} : { [nominations.columns.id]: id }),
	[nominations.columns.nominatedAt]: nominatedAt,
	[nominations.columns.nominatedBy]: nominatedBy,
	[nominations.columns.nomineeId]: nomineeId,
});

/**
 * An administrator: the nominee of the nomination they accepted.
 *
 * @param parts the administrator's `users.id`, the nomination accepted, and when: now by default.
 */
export const administratorRow = ({
	acceptedAt = new Date(),
	nominationId,
	userId,
}: {
	acceptedAt?: Date;
	nominationId: string;
	userId: string;
}): Row => ({
	[administrators.columns.acceptedAt]: acceptedAt,
	[administrators.columns.nominationId]: nominationId,
	[administrators.columns.userId]: userId,
});

/**
 * An answer about a grant.
 *
 * @param parts who answered which grant, how, what they were shown, and when: now by default.
 */
export const decisionRow = ({
	capabilities: shown = ['record.count', 'record.export', 'record.view'],
	decidedAt = new Date(),
	decision,
	grantId,
	userId,
}: {
	capabilities?: readonly string[];
	decidedAt?: Date;
	decision: string;
	grantId: string;
	userId: string;
}): Row => ({
	[grantDecisions.columns.capabilities]: shown,
	[grantDecisions.columns.decidedAt]: decidedAt,
	[grantDecisions.columns.decision]: decision,
	[grantDecisions.columns.grantId]: grantId,
	[grantDecisions.columns.userId]: userId,
});

/**
 * A principal revocation, standing unless a lift is given.
 *
 * @param parts the principal revoked, who revoked and when (by default the lift's time, or now
 *   when there is no lift), and the lift if any.
 */
export const revocationRow = ({
	lifted,
	revokedAt = lifted?.at ?? new Date(),
	revokedBy,
	userId,
}: {
	lifted?: { at: Date; by: string };
	revokedAt?: Date;
	revokedBy: string;
	userId: string;
}): Row => ({
	[principalRevocations.columns.liftedAt]: lifted?.at ?? null,
	[principalRevocations.columns.liftedBy]: lifted?.by ?? null,
	[principalRevocations.columns.reason]: 'account reported compromised',
	[principalRevocations.columns.revokedAt]: revokedAt,
	[principalRevocations.columns.revokedBy]: revokedBy,
	[principalRevocations.columns.userId]: userId,
});

/** What an invitation's row is built from; each optional column is null unless given. */
export interface InvitationParts {
	email: string;
	fieldCategoryId?: string;
	invitedBy: string;
	recordCategoryId?: string;
	resourceId: string;
	roleId: string;
}

/**
 * An invitation's row, with a fresh link hash and no expiry for the grant it promises.
 *
 * @param parts the address, resource, categories, role and inviter.
 */
export const invitationRow = ({
	email,
	fieldCategoryId,
	invitedBy,
	recordCategoryId,
	resourceId,
	roleId,
}: InvitationParts): Row => ({
	[invitations.columns.email]: email,
	[invitations.columns.expiresAt]: null,
	[invitations.columns.fieldCategoryId]: fieldCategoryId ?? null,
	[invitations.columns.invitedAt]: new Date(),
	[invitations.columns.invitedBy]: invitedBy,
	[invitations.columns.linkTokenHash]: randomBytes(32),
	[invitations.columns.recordCategoryId]: recordCategoryId ?? null,
	[invitations.columns.resourceId]: resourceId,
	[invitations.columns.roleId]: roleId,
});

/** A notice's row: its kind and whichever of subject, resource and audience it names. */
export interface NoticeParts {
	audience?: string;
	createdAt?: Date;
	kind: string;
	resourceExternalId?: string;
	subject?: string;
}

/**
 * A notice's row, naming only what is given, created now unless told otherwise.
 *
 * @param parts the kind, and what it names.
 */
export const noticeRow = ({
	audience,
	createdAt = new Date(),
	kind,
	resourceExternalId,
	subject,
}: NoticeParts): Row => ({
	[notices.columns.audience]: audience ?? null,
	[notices.columns.createdAt]: createdAt,
	[notices.columns.kind]: kind,
	[notices.columns.idpSubjectId]: subject ?? null,
	[notices.columns.resourceExternalId]: resourceExternalId ?? null,
});

/**
 * An audit event's row, a CloudEvents envelope carrying the given payload, at severity `info`.
 *
 * @param data the event's payload.
 */
export const auditEntryRow = (data: Readonly<Record<string, unknown>>): Row => ({
	[auditLog.columns.data]: JSON.stringify(data),
	[auditLog.columns.dataSchema]: null,
	[auditLog.columns.occurredAt]: new Date(),
	[auditLog.columns.severity]: 'info',
	[auditLog.columns.source]: 'urn:usher:controller:test',
	[auditLog.columns.specVersion]: '1.0',
	[auditLog.columns.type]: 'org.overture.usher.grant.create',
});

/**
 * A capability's id, by its `entity.action` name.
 *
 * @param client the connection.
 * @param name the capability, such as `record.view`.
 */
export const capabilityId = async (client: pg.ClientBase, name: string): Promise<string> => {
	const [entity, action] = name.split('.');
	const [row] = await selectRows<{ id: string }>(
		client,
		`SELECT ${capabilities.columns.id} AS id FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} = $1 AND ${capabilities.columns.action} = $2`,
		[entity, action],
	);
	if (row !== undefined) {
		return row.id;
	}
	throw new Error(`the store holds no capability ${name}`);
};

/**
 * The steward's id in a seeded fixture, who acts wherever an entry names no one.
 *
 * @param seeded the ids seeding returned.
 */
export const stewardOf = (seeded: SeededPolicy): string => {
	const id = seeded.users[STEWARD];
	if (id !== undefined) {
		return id;
	}
	throw new Error('the fixture wrote no steward');
};

/** What a notice says, without where it sits or who wrote it. */
export interface NoticeContent {
	audience: string | null;
	kind: string;
	resourceExternalId: string | null;
	subject: string | null;
}

/**
 * Inserts a notice and returns its position.
 *
 * @param client the connection, inside a transaction or not.
 * @param parts the notice.
 */
export const insertNotice = async (client: pg.ClientBase, parts: NoticeParts): Promise<bigint> => {
	const stored = await insertRow(client, notices, noticeRow(parts));
	return BigInt(String(stored[notices.columns.position]));
};

const contentKey = ({ audience, kind, resourceExternalId, subject }: NoticeContent): string =>
	JSON.stringify([kind, subject, resourceExternalId, audience]);

/**
 * What a set of notices says, each distinct content once, in a fixed order, for comparing what a
 * change wrote with what it must write.
 *
 * @param written notices, or expected contents.
 */
export const distinctContents = (written: readonly NoticeContent[]): readonly NoticeContent[] =>
	[
		...new Map(
			written.map(({ audience, kind, resourceExternalId, subject }) => {
				const content = { audience, kind, resourceExternalId, subject };
				return [contentKey(content), content] as const;
			}),
		),
	]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, content]) => content);

const nothingNamed = {
	audience: null,
	resourceExternalId: null,
	subject: null,
} as const;

/**
 * A principal notice's content, naming the person as `noticeSubject` gives it.
 *
 * @param subject the person's subject at the identity provider.
 */
export const principalNotice = (subject: string): NoticeContent => ({
	...nothingNamed,
	kind: 'principal',
	subject: noticeSubject({ subject }),
});

/**
 * A category notice's content.
 *
 * @param resourceExternalId the resource it names, by externalId.
 */
export const categoryNotice = (resourceExternalId: string): NoticeContent => ({
	...nothingNamed,
	kind: 'category',
	resourceExternalId,
});

/** A baseline notice's content. */
export const BASELINE_NOTICE: NoticeContent = Object.freeze({
	...nothingNamed,
	kind: 'baseline',
});

/** A global notice's content. */
export const GLOBAL_NOTICE: NoticeContent = Object.freeze({
	...nothingNamed,
	kind: 'global',
});

/**
 * A servedResources notice's content.
 *
 * @param audience the id of the application it is for.
 */
export const servedResourcesNotice = (audience: string): NoticeContent => ({
	...nothingNamed,
	audience,
	kind: 'servedResources',
});

/** A change record as its table holds it, in the form `policy.ts` gives for `change_records`. */
export interface ChangeRecord {
	actorId: string | null;
	actorType: string | null;
	id: string;
	newRow: Readonly<Record<string, unknown>> | null;
	oldRow: Readonly<Record<string, unknown>> | null;
	operation: string;
	rowKey: unknown;
	tableName: string;
}

/**
 * Every change record, in no particular order.
 *
 * @param client the connection.
 */
export const readChangeRecords = (client: pg.ClientBase): Promise<readonly ChangeRecord[]> => {
	const { columns } = changeRecords;
	return selectRows<ChangeRecord>(
		client,
		`SELECT ${columns.idpSubjectId} AS "actorId", ${columns.actorType} AS "actorType", ${columns.id}::text AS id, ${columns.newRow} AS "newRow", ${columns.oldRow} AS "oldRow", ${columns.operation} AS operation, ${columns.rowKey} AS "rowKey", ${columns.tableName} AS "tableName" FROM ${qualified(changeRecords)}`,
	);
};

/**
 * The policy generation, or nothing when its row is absent.
 *
 * @param client the connection.
 */
export const readPolicyGeneration = async (client: pg.ClientBase): Promise<bigint | undefined> => {
	const [row] = await selectRows<{ generation: string }>(
		client,
		`SELECT ${policyGeneration.columns.generation}::text AS generation FROM ${qualified(policyGeneration)}`,
	);
	return row === undefined ? undefined : BigInt(row.generation);
};

/** Where the store's change records and notices stood at one moment, for reading what was written since. */
export interface StoreMarker {
	position: bigint;
	recordIds: ReadonlySet<string>;
}

/**
 * Where the store's change records and notices stand now, as a connection sees them.
 *
 * @param client the connection.
 */
export const markStore = async (client: pg.ClientBase): Promise<StoreMarker> => ({
	position: await highestPosition(client),
	recordIds: new Set((await readChangeRecords(client)).map(({ id }) => id)),
});

/** The change records and notices a connection sees that came after a marker. */
export interface WrittenSince {
	changeRecords: readonly ChangeRecord[];
	notices: readonly StoredNotice[];
}

/**
 * The change records and notices a connection sees that a marker did not hold.
 *
 * @param client the connection.
 * @param marker where the store stood before.
 */
export const writtenSince = async (
	client: pg.ClientBase,
	{ position, recordIds }: StoreMarker,
): Promise<WrittenSince> => ({
	changeRecords: (await readChangeRecords(client)).filter(({ id }) => !recordIds.has(id)),
	notices: await noticesAfter(client, position),
});

/**
 * Runs work in a transaction declaring its actor, commits it, and returns the change records and
 * notices written meanwhile. The connection's own reads before and after bound them, so the work
 * must be the only writer to the database while it runs.
 *
 * @param client a connection holding no transaction, which may read the change records and notices.
 * @param work the statements to run, on the same connection.
 * @param actor who acts: the system actor by default.
 */
export const committedChange = async (
	client: pg.ClientBase,
	work: () => Promise<unknown>,
	actor: Actor = SYSTEM_ACTOR,
): Promise<WrittenSince> => {
	const marker = await markStore(client);
	await inTransactionAs(client, actor, work);
	return writtenSince(client, marker);
};

/** What a session reads of a change's effects at one moment. */
export interface StoreSnapshot {
	/** The change records written since the observation began. */
	changeRecords: readonly ChangeRecord[];

	generation: bigint | undefined;

	/** The notices written since the observation began. */
	notices: readonly StoredNotice[];
}

/**
 * One change, made and rolled back, then made and committed, read from the writing session and
 * from another. Visibility alone says which transaction wrote what: the writing session sees its own
 * uncommitted rows and no other session does, so rows the writer reads before its commit, that no
 * other session reads until the commit, and that a rollback removes, were written by the change's
 * own transaction, whatever subtransactions the store wrote them in.
 */
export interface ObservedChange {
	/** What another session read once the change had been made and rolled back. */
	afterRollback: StoreSnapshot;

	/** What another session read before the change. */
	before: StoreSnapshot;

	/** What another session read while the committing transaction had made the change and was still open. */
	beforeCommit: StoreSnapshot;

	/** What another session read once the change had committed. */
	committed: StoreSnapshot;

	/** What the writing session read of its own change just before committing it. */
	insideTransaction: StoreSnapshot;
}

/** Who makes an observed change, and under which role. */
export interface ObservedChangeOptions {
	/** The system actor by default. */
	actor?: Actor;

	/** The migration role, the owner, by default. */
	role?: DatabaseRole;
}

const rollingBack = async <Result>(client: pg.ClientBase, work: () => Promise<Result>): Promise<Result> => {
	try {
		return await work();
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	}
};

/**
 * Makes one change twice on a connection of its own, first rolling it back and then committing it,
 * and reads the notices, change records and policy generation before, during and after each: from a
 * second session throughout, and from the writing session just before its commit. The change must be
 * one that can be made again once rolled back. Both connections are ended before it settles.
 *
 * @param database the database to change.
 * @param change the statements making the change, on the connection given.
 * @param options the actor the transaction declares, and the role it runs under.
 */
export const observeChange = async (
	database: TestDatabase,
	change: (client: pg.Client) => Promise<unknown>,
	{ actor = SYSTEM_ACTOR, role = 'migration' }: ObservedChangeOptions = {},
): Promise<ObservedChange> => {
	const writer = await database.connect(role);
	const observer = await database.connect('migration');
	try {
		const marker = await markStore(observer);
		const snapshot = async (client: pg.ClientBase): Promise<StoreSnapshot> => ({
			...(await writtenSince(client, marker)),
			generation: await readPolicyGeneration(client),
		});
		const before = await snapshot(observer);

		await writer.query('BEGIN');
		await rollingBack(writer, async () => {
			await declareActor(writer, actor);
			await change(writer);
		});
		await writer.query('ROLLBACK');
		const afterRollback = await snapshot(observer);

		await writer.query('BEGIN');
		const { beforeCommit, insideTransaction } = await rollingBack(writer, async () => {
			await declareActor(writer, actor);
			await change(writer);
			return {
				beforeCommit: await snapshot(observer),
				insideTransaction: await snapshot(writer),
			};
		});
		await writer.query('COMMIT');
		const committed = await snapshot(observer);

		return {
			afterRollback,
			before,
			beforeCommit,
			committed,
			insideTransaction,
		};
	} finally {
		await Promise.all([writer.end(), observer.end()]);
	}
};

/**
 * Whether an observed change wrote exactly what another session reads after its commit, in its own
 * transaction: the writer read those rows before committing, no other session read them until the
 * commit, and the rollback left none.
 *
 * @param observed the change, observed.
 */
export const writtenInItsTransaction = ({
	afterRollback,
	before,
	beforeCommit,
	committed,
	insideTransaction,
}: ObservedChange): boolean =>
	isDeepStrictEqual(afterRollback, before) &&
	isDeepStrictEqual(beforeCommit, before) &&
	isDeepStrictEqual(committed, insideTransaction);

/** A statement and its parameters. */
export interface Statement {
	parameters: readonly unknown[];
	text: string;
}

/**
 * An insert, an update and a delete of one row of one table recorded by the change records, each
 * runnable once the base fixture is seeded and whatever `prepare` writes has committed.
 */
export interface RecordedChangeKit {
	delete: Statement;
	insert: Statement;
	prepare: readonly Statement[];
	table: NamedTable;
	update: Statement;

	/**
	 * Whether the update changes the row's key, as it must on a table of links holding nothing but
	 * its key, so the row the delete removes is no longer the one the insert wrote.
	 */
	updateMovesKey: boolean;
}

/** An operation of a {@link RecordedChangeKit} beyond its insert. */
export type LaterOperation = 'delete' | 'update';

/**
 * The operations on a table the store may refuse even to its owner, because the design keeps that
 * history: grants are revoked, never deleted; decisions and nominations are append-only; a
 * revocation is lifted, never deleted; an application key may be kept once revoked, as its issue
 * and revocation are; and an administrator is never deleted. Every other operation a kit makes must
 * be accepted.
 */
export const HISTORY_KEPT: Readonly<Record<string, readonly LaterOperation[]>> = Object.freeze({
	[administrators.name]: ['delete'],
	[applicationKeys.name]: ['delete'],
	[grantDecisions.name]: ['delete', 'update'],
	[grants.name]: ['delete'],
	[nominations.name]: ['delete', 'update'],
	[principalRevocations.name]: ['delete'],
});

/**
 * Whether the store may refuse an operation on a table to its owner.
 *
 * @param table the table.
 * @param operation the operation.
 */
export const mayKeepHistory = (table: NamedTable, operation: LaterOperation): boolean =>
	Object.entries(HISTORY_KEPT).some(([name, operations]) => name === table.name && operations.includes(operation));

/**
 * The tables raising the policy generation (R6) on every change: the policy tables named by #207 Q3,
 * with `applications` left out, and without `application_keys` (ruled), since neither changes what a
 * token holds.
 */
export const POLICY_GENERATION_TABLES: readonly NamedTable[] = Object.freeze([
	applicationResources,
	capabilities,
	categories,
	grantDecisions,
	grants,
	groupUsers,
	groups,
	principalRevocations,
	resourceCategories,
	resourceFieldValues,
	resourceFields,
	resources,
	rolePermissions,
	roles,
]);

/**
 * The tables with every change recorded in `change_records` by the triggers, each declaring an
 * actor: {@link POLICY_GENERATION_TABLES}, and `applications`, `application_keys`, `nominations`
 * and `administrators` beside them (ruled). A key's record never copies its `encrypted_key`, in its
 * old values or its new ones: change records are append-only by privilege and never re-encrypted,
 * so a copy there would outlive a rotation of the key-encryption key protecting it.
 */
export const CHANGE_RECORDED_TABLES: readonly NamedTable[] = Object.freeze([
	administrators,
	applicationKeys,
	applicationResources,
	applications,
	capabilities,
	categories,
	grantDecisions,
	grants,
	groupUsers,
	groups,
	nominations,
	principalRevocations,
	resourceCategories,
	resourceFieldValues,
	resourceFields,
	resources,
	rolePermissions,
	roles,
]);

const capabilityNamed = (name: string): string => {
	const [entity, action] = name.split('.');
	return `(SELECT ${capabilities.columns.id} FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} = ${pg.escapeLiteral(entity ?? '')} AND ${capabilities.columns.action} = ${pg.escapeLiteral(action ?? '')})`;
};

const groupNamed = (name: string): string =>
	`(SELECT ${groups.columns.id} FROM ${qualified(groups)} WHERE ${groups.columns.name} = ${pg.escapeLiteral(name)})`;

const fieldNamed = (name: string): string =>
	`(SELECT ${resourceFields.columns.id} FROM ${qualified(resourceFields)} WHERE ${resourceFields.columns.name} = ${pg.escapeLiteral(name)})`;

const statement = (text: string, parameters: readonly unknown[] = []): Statement => ({ parameters, text });

/**
 * One kit for each of {@link CHANGE_RECORDED_TABLES}, against the base fixture's ids. A test of the
 * policy generation keeps those of {@link POLICY_GENERATION_TABLES}.
 *
 * @param seeded the ids seeding {@link BASE_FIXTURE} returned.
 */
export const recordedChangeKits = (seeded: SeededPolicy): readonly RecordedChangeKit[] => {
	const steward = stewardOf(seeded);
	const user = (name: string): string => seededId(seeded.users, name);
	const resource = (externalId: string): string => seededId(seeded.resources, externalId);
	const category = (name: string): string => seededId(seeded.categories, name);
	const role = (name: string): string => seededId(seeded.roles, name);
	const lyric = seededId(seeded.applications, 'ims-lyric');
	const song = fixtureApplicationId('ims-song');
	const lyricKeyId = randomUUID();
	const anaNominated = randomUUID();
	const cyNominated = randomUUID();
	return [
		{
			delete: statement(`DELETE FROM ${qualified(administrators)} WHERE ${administrators.columns.userId} = $1`, [
				user('ana'),
			]),
			insert: statement(
				`INSERT INTO ${qualified(administrators)} (${administrators.columns.acceptedAt}, ${administrators.columns.nominationId}, ${administrators.columns.userId}) VALUES (now(), $1, $2)`,
				[anaNominated, user('ana')],
			),
			prepare: [
				statement(
					`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId}) VALUES ($1, now(), $2, $3)`,
					[anaNominated, steward, user('ana')],
				),
			],
			table: administrators,
			update: statement(
				`UPDATE ${qualified(administrators)} SET ${administrators.columns.acceptedAt} = ${administrators.columns.acceptedAt} + interval '1 second' WHERE ${administrators.columns.userId} = $1`,
				[user('ana')],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(`DELETE FROM ${qualified(applicationKeys)} WHERE ${applicationKeys.columns.id} = $1`, [
				lyricKeyId,
			]),
			insert: statement(
				`INSERT INTO ${qualified(applicationKeys)} (${applicationKeys.columns.applicationId}, ${applicationKeys.columns.encryptedKey}, ${applicationKeys.columns.id}, ${applicationKeys.columns.issuedAt}, ${applicationKeys.columns.issuedBy}) VALUES ($1, $2, $3, now(), $4)`,
				[lyric, randomBytes(60), lyricKeyId, steward],
			),
			prepare: [],
			table: applicationKeys,
			update: statement(
				`UPDATE ${qualified(applicationKeys)} SET ${applicationKeys.columns.revokedAt} = now(), ${applicationKeys.columns.revokedBy} = $1 WHERE ${applicationKeys.columns.id} = $2`,
				[steward, lyricKeyId],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(applicationResources)} WHERE ${applicationResources.columns.applicationId} = $1 AND ${applicationResources.columns.resourceId} = $2`,
				[lyric, resource('study.c_3')],
			),
			insert: statement(
				`INSERT INTO ${qualified(applicationResources)} (${applicationResources.columns.applicationId}, ${applicationResources.columns.resourceId}) VALUES ($1, $2)`,
				[lyric, resource('STUDY-B2')],
			),
			prepare: [],
			table: applicationResources,
			update: statement(
				`UPDATE ${qualified(applicationResources)} SET ${applicationResources.columns.resourceId} = $1 WHERE ${applicationResources.columns.applicationId} = $2 AND ${applicationResources.columns.resourceId} = $3`,
				[resource('study.c_3'), lyric, resource('STUDY-B2')],
			),
			updateMovesKey: true,
		},
		{
			delete: statement(`DELETE FROM ${qualified(applications)} WHERE ${applications.columns.id} = $1`, [song]),
			insert: statement(
				`INSERT INTO ${qualified(applications)} (${applications.columns.description}, ${applications.columns.displayName}, ${applications.columns.id}, ${applications.columns.registeredAt}, ${applications.columns.registeredBy}) VALUES ('Song', 'ims-song', $1, now(), $2)`,
				[song, steward],
			),
			prepare: [],
			table: applications,
			update: statement(
				`UPDATE ${qualified(applications)} SET ${applications.columns.description} = 'Song, the file index' WHERE ${applications.columns.id} = $1`,
				[song],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} = 'record' AND ${capabilities.columns.action} = 'delete'`,
			),
			insert: statement(
				`INSERT INTO ${qualified(capabilities)} (${capabilities.columns.action}, ${capabilities.columns.displayName}, ${capabilities.columns.entity}, ${capabilities.columns.plane}) VALUES ('delete', 'Delete records', 'record', 'data')`,
			),
			prepare: [],
			table: capabilities,
			update: statement(
				`UPDATE ${qualified(capabilities)} SET ${capabilities.columns.displayName} = 'Remove records' WHERE ${capabilities.columns.entity} = 'record' AND ${capabilities.columns.action} = 'delete'`,
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(categories)} WHERE ${categories.columns.scope} = 'global' AND ${categories.columns.name} = 'restricted'`,
			),
			insert: statement(
				`INSERT INTO ${qualified(categories)} (${categories.columns.description}, ${categories.columns.name}, ${categories.columns.scope}) VALUES ('Restricted records', 'restricted', 'global')`,
			),
			prepare: [],
			table: categories,
			update: statement(
				`UPDATE ${qualified(categories)} SET ${categories.columns.description} = 'Records under an embargo' WHERE ${categories.columns.scope} = 'global' AND ${categories.columns.name} = 'restricted'`,
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(grantDecisions)} WHERE ${grantDecisions.columns.userId} = $1 AND ${grantDecisions.columns.decision} = 'rejected'`,
				[user('ana')],
			),
			insert: statement(
				`INSERT INTO ${qualified(grantDecisions)} (${grantDecisions.columns.capabilities}, ${grantDecisions.columns.decidedAt}, ${grantDecisions.columns.decision}, ${grantDecisions.columns.grantId}, ${grantDecisions.columns.userId}) VALUES ('{record.count,record.export,record.view}', now(), 'rejected', $1, $2)`,
				[seededId(seeded.grants, 'anaViews'), user('ana')],
			),
			prepare: [],
			table: grantDecisions,
			update: statement(
				`UPDATE ${qualified(grantDecisions)} SET ${grantDecisions.columns.capabilities} = '{record.view}' WHERE ${grantDecisions.columns.userId} = $1 AND ${grantDecisions.columns.decision} = 'rejected'`,
				[user('ana')],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(grants)} WHERE ${grants.columns.holderUserId} = $1 AND ${grants.columns.resourceId} = $2`,
				[user('cy'), resource('STUDY-A1')],
			),
			insert: statement(
				`INSERT INTO ${qualified(grants)} (${grants.columns.grantedAt}, ${grants.columns.grantedBy}, ${grants.columns.holderUserId}, ${grants.columns.recordCategoryId}, ${grants.columns.resourceId}, ${grants.columns.roleId}) VALUES (now(), $1, $2, $3, $4, $5)`,
				[steward, user('cy'), category('controlled'), resource('STUDY-A1'), role('viewer')],
			),
			prepare: [],
			table: grants,
			update: statement(
				`UPDATE ${qualified(grants)} SET ${grants.columns.roleId} = $1 WHERE ${grants.columns.holderUserId} = $2 AND ${grants.columns.resourceId} = $3`,
				[role('submitter'), user('cy'), resource('STUDY-A1')],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(groupUsers)} WHERE ${groupUsers.columns.groupId} = ${groupNamed('curators')} AND ${groupUsers.columns.userId} = $1`,
				[user('cy')],
			),
			insert: statement(
				`INSERT INTO ${qualified(groupUsers)} (${groupUsers.columns.groupId}, ${groupUsers.columns.userId}) VALUES (${groupNamed('curators')}, $1)`,
				[user('ana')],
			),
			prepare: [
				statement(
					`INSERT INTO ${qualified(groups)} (${groups.columns.createdAt}, ${groups.columns.createdBy}, ${groups.columns.name}, ${groups.columns.resourceId}) VALUES (now(), $1, 'curators', $2)`,
					[steward, resource('STUDY-A1')],
				),
			],
			table: groupUsers,
			update: statement(
				`UPDATE ${qualified(groupUsers)} SET ${groupUsers.columns.userId} = $1 WHERE ${groupUsers.columns.groupId} = ${groupNamed('curators')} AND ${groupUsers.columns.userId} = $2`,
				[user('cy'), user('ana')],
			),
			updateMovesKey: true,
		},
		{
			delete: statement(`DELETE FROM ${qualified(groups)} WHERE ${groups.columns.name} = 'readers'`),
			insert: statement(
				`INSERT INTO ${qualified(groups)} (${groups.columns.createdAt}, ${groups.columns.createdBy}, ${groups.columns.description}, ${groups.columns.name}, ${groups.columns.resourceId}) VALUES (now(), $1, 'Readers of the cohort', 'readers', $2)`,
				[steward, resource('STUDY-A1')],
			),
			prepare: [],
			table: groups,
			update: statement(
				`UPDATE ${qualified(groups)} SET ${groups.columns.description} = 'Readers of the whole cohort' WHERE ${groups.columns.name} = 'readers'`,
			),
			updateMovesKey: false,
		},
		{
			delete: statement(`DELETE FROM ${qualified(nominations)} WHERE ${nominations.columns.id} = $1`, [
				cyNominated,
			]),
			insert: statement(
				`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId}) VALUES ($1, now(), $2, $3)`,
				[cyNominated, steward, user('cy')],
			),
			prepare: [],
			table: nominations,
			update: statement(
				`UPDATE ${qualified(nominations)} SET ${nominations.columns.nominatedAt} = ${nominations.columns.nominatedAt} + interval '1 second' WHERE ${nominations.columns.id} = $1`,
				[cyNominated],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(principalRevocations)} WHERE ${principalRevocations.columns.userId} = $1`,
				[user('cy')],
			),
			insert: statement(
				`INSERT INTO ${qualified(principalRevocations)} (${principalRevocations.columns.reason}, ${principalRevocations.columns.revokedAt}, ${principalRevocations.columns.revokedBy}, ${principalRevocations.columns.userId}) VALUES ('account reported compromised', now(), $1, $2)`,
				[steward, user('cy')],
			),
			prepare: [],
			table: principalRevocations,
			update: statement(
				`UPDATE ${qualified(principalRevocations)} SET ${principalRevocations.columns.liftedAt} = now(), ${principalRevocations.columns.liftedBy} = $1 WHERE ${principalRevocations.columns.userId} = $2`,
				[steward, user('cy')],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1 AND ${resourceCategories.columns.categoryId} = $2`,
				[resource('study.c_3'), category('controlled')],
			),
			insert: statement(
				`INSERT INTO ${qualified(resourceCategories)} (${resourceCategories.columns.categoryId}, ${resourceCategories.columns.resourceId}) VALUES ($1, $2)`,
				[category('controlled'), resource('STUDY-B2')],
			),
			prepare: [],
			table: resourceCategories,
			update: statement(
				`UPDATE ${qualified(resourceCategories)} SET ${resourceCategories.columns.resourceId} = $1 WHERE ${resourceCategories.columns.resourceId} = $2 AND ${resourceCategories.columns.categoryId} = $3`,
				[resource('study.c_3'), resource('STUDY-B2'), category('controlled')],
			),
			updateMovesKey: true,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(resourceFieldValues)} WHERE ${resourceFieldValues.columns.resourceId} = $1 AND ${resourceFieldValues.columns.fieldId} = ${fieldNamed('organization')}`,
				[resource('STUDY-A1')],
			),
			insert: statement(
				`INSERT INTO ${qualified(resourceFieldValues)} (${resourceFieldValues.columns.fieldId}, ${resourceFieldValues.columns.resourceId}, ${resourceFieldValues.columns.value}) VALUES (${fieldNamed('organization')}, $1, 'Institut Exemple du Sud')`,
				[resource('STUDY-A1')],
			),
			prepare: [
				statement(
					`INSERT INTO ${qualified(resourceFields)} (${resourceFields.columns.description}, ${resourceFields.columns.name}) VALUES ('Who holds the data', 'organization')`,
				),
			],
			table: resourceFieldValues,
			update: statement(
				`UPDATE ${qualified(resourceFieldValues)} SET ${resourceFieldValues.columns.value} = 'Société Exemple du Nord' WHERE ${resourceFieldValues.columns.resourceId} = $1 AND ${resourceFieldValues.columns.fieldId} = ${fieldNamed('organization')}`,
				[resource('STUDY-A1')],
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(resourceFields)} WHERE ${resourceFields.columns.name} = 'funder'`,
			),
			insert: statement(
				`INSERT INTO ${qualified(resourceFields)} (${resourceFields.columns.description}, ${resourceFields.columns.name}) VALUES ('Who funds the study', 'funder')`,
			),
			prepare: [],
			table: resourceFields,
			update: statement(
				`UPDATE ${qualified(resourceFields)} SET ${resourceFields.columns.description} = 'The agency funding the study' WHERE ${resourceFields.columns.name} = 'funder'`,
			),
			updateMovesKey: false,
		},
		{
			delete: statement(`DELETE FROM ${qualified(resources)} WHERE ${resources.columns.externalId} = 'STUDY-K1'`),
			insert: statement(
				`INSERT INTO ${qualified(resources)} (${resources.columns.baseTier}, ${resources.columns.description}, ${resources.columns.externalId}, ${resources.columns.name}, ${resources.columns.registeredAt}, ${resources.columns.registeredBy}, ${resources.columns.updatedAt}) VALUES ('open', 'Registered description', 'STUDY-K1', 'Kidney Atlas', now(), $1, now())`,
				[steward],
			),
			prepare: [],
			table: resources,
			update: statement(
				`UPDATE ${qualified(resources)} SET ${resources.columns.description} = 'Revised description' WHERE ${resources.columns.externalId} = 'STUDY-K1'`,
			),
			updateMovesKey: false,
		},
		{
			delete: statement(
				`DELETE FROM ${qualified(rolePermissions)} WHERE ${rolePermissions.columns.roleId} = $1 AND ${rolePermissions.columns.capabilityId} = ${capabilityNamed('record.count')}`,
				[role('submitter')],
			),
			insert: statement(
				`INSERT INTO ${qualified(rolePermissions)} (${rolePermissions.columns.capabilityId}, ${rolePermissions.columns.roleId}) VALUES (${capabilityNamed('record.view')}, $1)`,
				[role('submitter')],
			),
			prepare: [],
			table: rolePermissions,
			update: statement(
				`UPDATE ${qualified(rolePermissions)} SET ${rolePermissions.columns.capabilityId} = ${capabilityNamed('record.count')} WHERE ${rolePermissions.columns.roleId} = $1 AND ${rolePermissions.columns.capabilityId} = ${capabilityNamed('record.view')}`,
				[role('submitter')],
			),
			updateMovesKey: true,
		},
		{
			delete: statement(`DELETE FROM ${qualified(roles)} WHERE ${roles.columns.name} = 'curator'`),
			insert: statement(
				`INSERT INTO ${qualified(roles)} (${roles.columns.description}, ${roles.columns.name}, ${roles.columns.plane}) VALUES ('Curates records', 'curator', 'data')`,
			),
			prepare: [],
			table: roles,
			update: statement(
				`UPDATE ${qualified(roles)} SET ${roles.columns.description} = 'Curates and removes records' WHERE ${roles.columns.name} = 'curator'`,
			),
			updateMovesKey: false,
		},
	];
};

/**
 * Runs a statement on a connection.
 *
 * @param client the connection.
 * @param toRun the statement and its parameters.
 */
export const run = (client: pg.ClientBase, toRun: Statement): Promise<pg.QueryResult<Row>> =>
	client.query<Row>(toRun.text, [...toRun.parameters]);

/** A column's type and nullability as the catalogue reports them. */
export interface ColumnShape {
	notNull: boolean;

	/** As `format_type` spells it, such as `timestamp with time zone`. */
	type: string;
}

const required = (type: string): ColumnShape => ({ notNull: true, type });

const optional = (type: string): ColumnShape => ({ notNull: false, type });

const BIGINT = 'bigint';
const BOOLEAN = 'boolean';
const BYTES = 'bytea';
const INSTANT = 'timestamp with time zone';
const JSONB = 'jsonb';
const TEXT = 'text';
const TEXTS = 'text[]';
const UUID = 'uuid';

type PolicyTables = typeof POLICY_TABLES;

type ColumnShapes<Table extends keyof PolicyTables> = Readonly<
	Record<keyof PolicyTables[Table]['columns'], ColumnShape>
>;

/**
 * The type and nullability of every column `schema.md` names, as the rulings adjust it:
 * `resources.external_id` (O16, #207 Q5), its retirement (#320 B), the capabilities' plane (#207
 * Q14), the notices' resource and audience columns (#207 Q5), an invitation's nullable expiry, the
 * resulting grant's (#207 Q9), each audit event's severity (#214 Q2; no ruling fixes its type, so
 * text, required), a person held apart from their identities in `user_identities` (several
 * identities per person), and the subject identifier named `idp_subject_id` wherever it is stored.
 * The tables the rulings add are checked by their columns alone, unless a ruling fixes their types,
 * as it does for `user_identities`, and as `schema.md` § Applications does for an application's id,
 * its display name and its keys' two tables.
 */
export const DESIGNED_COLUMNS: {
	readonly [Table in keyof PolicyTables]?: ColumnShapes<Table>;
} = Object.freeze({
	administrators: {
		acceptedAt: required(INSTANT),
		nominationId: required(UUID),
		userId: required(UUID),
	},
	applicationKeys: {
		applicationId: required(UUID),
		confirmedAt: optional(INSTANT),
		encryptedKey: required(BYTES),
		id: required(UUID),
		issuedAt: required(INSTANT),
		issuedBy: required(UUID),
		revokedAt: optional(INSTANT),
		revokedBy: optional(UUID),
	},
	applicationResources: {
		applicationId: required(UUID),
		resourceId: required(UUID),
	},
	applications: {
		description: optional(TEXT),
		displayName: required(TEXT),
		id: required(UUID),
		registeredAt: required(INSTANT),
		registeredBy: required(UUID),
	},
	auditLog: {
		data: required(JSONB),
		dataSchema: optional(TEXT),
		id: required(UUID),
		occurredAt: required(INSTANT),
		severity: required(TEXT),
		source: required(TEXT),
		specVersion: required(TEXT),
		type: required(TEXT),
	},
	capabilities: {
		action: required(TEXT),
		description: optional(TEXT),
		displayName: required(TEXT),
		entity: required(TEXT),
		id: required(UUID),
		plane: required(TEXT),
	},
	categories: {
		description: optional(TEXT),
		id: required(UUID),
		name: required(TEXT),
		resourceId: optional(UUID),
		scope: required(TEXT),
	},
	grantDecisions: {
		capabilities: required(TEXTS),
		decidedAt: required(INSTANT),
		decision: required(TEXT),
		grantId: required(UUID),
		id: required(UUID),
		userId: required(UUID),
	},
	grants: {
		endedAt: optional(INSTANT),
		expiresAt: optional(INSTANT),
		fieldCategoryId: optional(UUID),
		grantedAt: required(INSTANT),
		grantedBy: required(UUID),
		holderGroupId: optional(UUID),
		holderUserId: optional(UUID),
		id: required(UUID),
		recordCategoryId: optional(UUID),
		resourceId: required(UUID),
		revokedAt: optional(INSTANT),
		revokedBy: optional(UUID),
		roleId: required(UUID),
	},
	groupUsers: { groupId: required(UUID), userId: required(UUID) },
	groups: {
		createdAt: required(INSTANT),
		createdBy: required(UUID),
		description: optional(TEXT),
		id: required(UUID),
		name: required(TEXT),
		resourceId: required(UUID),
	},
	identityProviderConfiguration: {
		name: required(TEXT),
		recordedAt: optional(INSTANT),
		value: optional(JSONB),
	},
	invitations: {
		email: required(TEXT),
		expiresAt: optional(INSTANT),
		fieldCategoryId: optional(UUID),
		id: required(UUID),
		invitedAt: required(INSTANT),
		invitedBy: required(UUID),
		linkTokenHash: required(BYTES),
		recordCategoryId: optional(UUID),
		resourceId: required(UUID),
		roleId: required(UUID),
	},
	keyFingerprints: {
		fingerprint: required(BYTES),
		keyName: required(TEXT),
		recordedAt: required(INSTANT),
	},
	nominations: {
		id: required(UUID),
		nominatedAt: required(INSTANT),
		nominatedBy: required(UUID),
		nomineeId: required(UUID),
	},
	noticeStream: {
		epoch: required(UUID),
		singleton: required(BOOLEAN),
		trimmedThrough: required(BIGINT),
	},
	notices: {
		audience: optional(UUID),
		createdAt: required(INSTANT),
		idpSubjectId: optional(TEXT),
		kind: required(TEXT),
		position: required(BIGINT),
		resourceExternalId: optional(TEXT),
	},
	principalRevocations: {
		id: required(UUID),
		liftedAt: optional(INSTANT),
		liftedBy: optional(UUID),
		reason: required(TEXT),
		revokedAt: required(INSTANT),
		revokedBy: required(UUID),
		userId: required(UUID),
	},
	resourceCategories: {
		categoryId: required(UUID),
		resourceId: required(UUID),
	},
	resources: {
		baseTier: required(TEXT),
		description: optional(TEXT),
		externalId: required(TEXT),
		id: required(UUID),
		name: required(TEXT),
		registeredAt: required(INSTANT),
		registeredBy: required(UUID),
		retiredAt: optional(INSTANT),
		retiredBy: optional(UUID),
		suppressed: required(BOOLEAN),
		updatedAt: required(INSTANT),
	},
	rolePermissions: {
		capabilityId: required(UUID),
		roleId: required(UUID),
	},
	roles: {
		description: optional(TEXT),
		id: required(UUID),
		name: required(TEXT),
		plane: required(TEXT),
	},
	settings: {
		changedAt: required(INSTANT),
		changedBy: optional(UUID),
		name: required(TEXT),
		value: required(JSONB),
	},
	settingsGeneration: {
		generation: required(BIGINT),
		singleton: required(BOOLEAN),
	},
	userIdentities: {
		addedAt: required(INSTANT),
		addedBy: optional(UUID),
		id: required(UUID),
		idpIssuer: required(TEXT),
		idpSubjectId: required(TEXT),
		userId: required(UUID),
	},
	users: {
		createdAt: required(INSTANT),
		id: required(UUID),
	},
});

/** One column of a table in the schema named for Usher, as the catalogue reports it. */
export interface CatalogueColumn extends ColumnShape {
	column: string;
	table: string;
}

/**
 * Every column of every table in the schema named for Usher.
 *
 * @param client the connection.
 */
export const readColumns = (client: pg.ClientBase): Promise<readonly CatalogueColumn[]> =>
	selectRows<CatalogueColumn>(
		client,
		`SELECT relation.relname AS "table", attribute.attname AS "column", format_type(attribute.atttypid, attribute.atttypmod) AS type, attribute.attnotnull AS "notNull"
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attnum`,
		[USHER_SCHEMA],
	);

const columnsByTable = (columns: readonly CatalogueColumn[]): ReadonlyMap<string, ReadonlyMap<string, ColumnShape>> =>
	new Map(
		[...new Set(columns.map(({ table }) => table))].map((table) => [
			table,
			new Map(
				columns
					.filter((column) => column.table === table)
					.map(({ column, notNull, type }) => [column, { notNull, type }]),
			),
		]),
	);

const tableProblems = (
	table: { columns: Readonly<Record<string, string>>; name: string },
	designed: Readonly<Record<string, ColumnShape>> | undefined,
	actual: ReadonlyMap<string, ColumnShape> | undefined,
): readonly string[] => {
	if (actual === undefined) {
		return [`${table.name} is missing`];
	}
	const expectedNames = new Set(Object.values(table.columns));
	const missing = [...expectedNames]
		.filter((column) => !actual.has(column))
		.map((column) => `${table.name}.${column} is missing`);
	const unexpected = [...actual.keys()]
		.filter((column) => !expectedNames.has(column))
		.map((column) => `${table.name}.${column} is not in the design`);
	const mismatched = Object.entries(designed ?? {}).flatMap(([columnKey, shape]) => {
		const column = table.columns[columnKey] ?? columnKey;
		const found = actual.get(column);
		return found === undefined || (found.type === shape.type && found.notNull === shape.notNull)
			? []
			: [
					`${table.name}.${column} is ${found.type}${found.notNull ? ' not null' : ''}, designed as ${shape.type}${shape.notNull ? ' not null' : ''}`,
				];
	});
	return [...missing, ...unexpected, ...mismatched];
};

/**
 * Every way the migrated schema departs from the design: a table or column missing, a column the
 * design does not name, or a type or nullability other than designed. Empty when it matches.
 *
 * @param client the connection.
 */
export const shapeProblems = async (client: pg.ClientBase): Promise<readonly string[]> => {
	const byTable = columnsByTable(await readColumns(client));
	const designedByKey: ReadonlyMap<string, Readonly<Record<string, ColumnShape>> | undefined> = new Map(
		Object.entries(DESIGNED_COLUMNS),
	);
	return Object.entries(POLICY_TABLES).flatMap(([key, table]) =>
		tableProblems(table, designedByKey.get(key), byTable.get(table.name)),
	);
};

/**
 * The definitions of every `CHECK` constraint reading a column.
 *
 * @param client the connection.
 * @param table the table.
 * @param column the column's name.
 */
export const checksOn = async (client: pg.ClientBase, table: NamedTable, column: string): Promise<readonly string[]> =>
	(
		await selectRows<{ definition: string }>(
			client,
			`SELECT pg_get_constraintdef(constraint_.oid) AS definition
         FROM pg_constraint constraint_
         JOIN pg_class relation ON relation.oid = constraint_.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = ANY (constraint_.conkey)
        WHERE constraint_.contype = 'c' AND namespace.nspname = $1 AND relation.relname = $2 AND attribute.attname = $3`,
			[USHER_SCHEMA, table.name, column],
		)
	).map(({ definition }) => definition);

/** A foreign key in the schema named for Usher. */
export interface ForeignKey {
	/** The referencing columns, comma-separated, in key order. */
	columns: string;

	/** `pg_constraint.confdeltype`: `r` for `RESTRICT`, `a` for `NO ACTION`, `c` for `CASCADE`. */
	onDelete: string;

	referenced: string;
	table: string;
}

/**
 * Every foreign key in the schema named for Usher.
 *
 * @param client the connection.
 */
export const readForeignKeys = (client: pg.ClientBase): Promise<readonly ForeignKey[]> =>
	selectRows<ForeignKey>(
		client,
		`SELECT source.relname AS "table", target.relname AS referenced, constraint_.confdeltype AS "onDelete",
            (SELECT string_agg(attribute.attname::text, ',' ORDER BY key.ordinal)
               FROM unnest(constraint_.conkey) WITH ORDINALITY AS key(attnum, ordinal)
               JOIN pg_attribute attribute ON attribute.attrelid = constraint_.conrelid AND attribute.attnum = key.attnum) AS columns
       FROM pg_constraint constraint_
       JOIN pg_class source ON source.oid = constraint_.conrelid
       JOIN pg_class target ON target.oid = constraint_.confrelid
       JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
      WHERE constraint_.contype = 'f' AND namespace.nspname = $1
      ORDER BY source.relname, columns`,
		[USHER_SCHEMA],
	);

/**
 * The tables of the schema named for Usher, by name.
 *
 * @param client the connection.
 */
export const tableNames = async (client: pg.ClientBase): Promise<readonly string[]> =>
	(
		await selectRows<{ name: string }>(
			client,
			`SELECT relation.relname AS name FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p') ORDER BY relation.relname`,
			[USHER_SCHEMA],
		)
	).map(({ name }) => name);

/** Everything the catalogue says about the schema named for Usher, in a form two databases compare by. */
export interface CatalogueSnapshot {
	columns: readonly string[];
	constraints: readonly string[];
	functions: readonly string[];
	indexes: readonly string[];
	relations: readonly string[];
	schema: readonly string[];
	triggers: readonly string[];
}

const describedRows = async (client: pg.ClientBase, text: string): Promise<readonly string[]> =>
	(await selectRows<{ described: string }>(client, text, [USHER_SCHEMA])).map(({ described }) => described).sort();

/**
 * The schema named for Usher as the catalogue describes it: its owner and privileges, every
 * relation with its owner and privileges, every column with its type, nullability, default and
 * identity, every constraint, index and trigger by definition, and every function by definition,
 * owner, privileges and settings. Two databases built alike give equal snapshots.
 *
 * @param client the connection.
 */
export const catalogueSnapshot = async (client: pg.ClientBase): Promise<CatalogueSnapshot> => ({
	columns: await describedRows(
		client,
		`SELECT concat_ws(' ', relation.relname, attribute.attname, format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull, attribute.attidentity, attribute.attgenerated, pg_get_expr(default_.adbin, default_.adrelid)) AS described
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_attrdef default_ ON default_.adrelid = attribute.attrelid AND default_.adnum = attribute.attnum
      WHERE namespace.nspname = $1 AND attribute.attnum > 0 AND NOT attribute.attisdropped AND relation.relkind IN ('r', 'p', 'v', 'm')`,
	),
	constraints: await describedRows(
		client,
		`SELECT concat_ws(' ', relation.relname, constraint_.conname, pg_get_constraintdef(constraint_.oid)) AS described
       FROM pg_constraint constraint_
       JOIN pg_class relation ON relation.oid = constraint_.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1`,
	),
	functions: await describedRows(
		client,
		`SELECT concat_ws(' ', pg_get_functiondef(function_.oid), pg_get_userbyid(function_.proowner), function_.proacl::text, function_.prosecdef, function_.proconfig::text) AS described
       FROM pg_proc function_
       JOIN pg_namespace namespace ON namespace.oid = function_.pronamespace
      WHERE namespace.nspname = $1 AND function_.prokind IN ('f', 'p')`,
	),
	indexes: await describedRows(client, 'SELECT indexdef AS described FROM pg_indexes WHERE schemaname = $1'),
	relations: await describedRows(
		client,
		`SELECT concat_ws(' ', relation.relname, relation.relkind, pg_get_userbyid(relation.relowner), relation.relacl::text) AS described
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1`,
	),
	schema: await describedRows(
		client,
		`SELECT concat_ws(' ', nspname, pg_get_userbyid(nspowner), nspacl::text) AS described FROM pg_namespace WHERE nspname = $1`,
	),
	triggers: await describedRows(
		client,
		`SELECT concat_ws(' ', pg_get_triggerdef(trigger_.oid), trigger_.tgenabled) AS described
       FROM pg_trigger trigger_
       JOIN pg_class relation ON relation.oid = trigger_.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND NOT trigger_.tgisinternal`,
	),
});

/**
 * Every row of every table in the schema named for Usher, as JSON text, sorted within each table.
 *
 * @param client the connection.
 */
export const tableContents = async (client: pg.ClientBase): Promise<Readonly<Record<string, readonly string[]>>> =>
	Object.fromEntries(
		await inTurn(await tableNames(client), async (name) => {
			const rows = await selectRows<{ row: string }>(
				client,
				`SELECT to_jsonb(stored)::text AS row FROM ${qualified({ name })} stored`,
			);
			return [name, rows.map(({ row }) => row).sort()] as const;
		}),
	);

/** One applied migration, as its record holds it. */
export interface AppliedMigration {
	appliedAt: string;
	checksum: string;
	name: string;
}

/**
 * The migrations recorded as applied, by name, or none when the record does not exist yet.
 *
 * @param client the connection.
 */
export const appliedMigrations = async (client: pg.ClientBase): Promise<readonly AppliedMigration[]> => {
	const [present] = await selectRows<{ present: boolean }>(client, 'SELECT to_regclass($1) IS NOT NULL AS present', [
		qualified(schemaMigrations),
	]);
	if (present?.present === true) {
		const { columns } = schemaMigrations;
		return selectRows<AppliedMigration>(
			client,
			`SELECT ${columns.appliedAt}::text AS "appliedAt", ${columns.checksum}::text AS checksum, ${columns.name}::text AS name FROM ${qualified(schemaMigrations)} ORDER BY ${columns.name}`,
		);
	}
	return [];
};

/**
 * Whether a table exists in the schema named for Usher.
 *
 * @param client the connection.
 * @param table the table.
 */
export const tableExists = async (client: pg.ClientBase, table: NamedTable): Promise<boolean> => {
	const [row] = await selectRows<{ present: boolean }>(client, 'SELECT to_regclass($1) IS NOT NULL AS present', [
		qualified(table),
	]);
	return row?.present === true;
};

/**
 * Every row the stream's table holds, each with its epoch and how far trimming has reached, for the
 * tests that hold it to one row.
 *
 * @param client the connection.
 */
export const noticeStreamRows = async (
	client: pg.ClientBase,
): Promise<readonly { epoch: string; trimmedThrough: bigint }[]> =>
	(
		await selectRows<{ epoch: string; trimmedThrough: string }>(
			client,
			`SELECT ${noticeStream.columns.epoch}::text AS epoch, ${noticeStream.columns.trimmedThrough}::text AS "trimmedThrough" FROM ${qualified(noticeStream)}`,
		)
	).map(({ epoch, trimmedThrough }) => ({
		epoch,
		trimmedThrough: BigInt(trimmedThrough),
	}));

/**
 * An identifier no row holds, for the foreign key tests.
 */
export const unheldId = (): string => randomUUID();
