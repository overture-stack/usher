import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import pg from 'pg';

import { AUDIT_EVENT_TYPES, auditRows, emittedType } from '../../test-support/auditEvents.js';
import {
	type AuditEvent,
	type AuditTrail,
	createAuditTrail,
	DEFAULT_STORE_TIMEOUT_MILLISECONDS,
	type EventEnvelope,
	type TrailConnection,
} from '../../test-support/controller.js';
import type { TestDatabase } from '../../test-support/database.js';
import {
	identityRow,
	markStore,
	openDatabase,
	type Row,
	selectRows,
	userRow,
	writtenSince,
} from '../../test-support/fixtures/database.js';
import { HARNESS_EVENT_SOURCE } from '../../test-support/harness.js';
import {
	ACTOR_SETTINGS,
	BEGIN_UNDER_SAVEPOINT,
	POLICY_TABLES,
	qualified,
	SESSION_LIMIT_SETTINGS,
	WORK_SAVEPOINT,
} from '../../test-support/policy.js';

const { userIdentities, users } = POLICY_TABLES;

// A transaction's own timeout that no session default would have: an odd number of milliseconds,
// which the store shows in milliseconds since no larger unit divides it.
const OWN_TIMEOUT_MILLISECONDS = 12_345;

const PERSON_ACTING: { id: string; type: 'human' } = Object.freeze({
	id: randomUUID(),
	type: 'human',
});

const WORK_EVENT: AuditEvent = Object.freeze({
	data: { result: 'succeeded' },
	severity: 'info',
	type: AUDIT_EVENT_TYPES.grantCreation,
});

const FAILURE_EVENT: AuditEvent = Object.freeze({
	data: { reason: 'storeUnavailable', result: 'failed' },
	severity: 'error',
	type: AUDIT_EVENT_TYPES.tokenExchange,
});

/** A pool connection as the audit trail takes it, the rows of each query readable by the work. */
interface PoolTrailConnection extends TrailConnection {
	query(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<Row>>;
}

/** A query the trail or its work gave the connection, as given. */
interface Sent {
	text: string;
	values: readonly unknown[] | undefined;
}

/** The settings in force on a connection, as the store shows them. */
interface InForce {
	actorId: string;
	actorType: string;
	idleInTransactionSessionTimeout: string;
	statementTimeout: string;
}

/** What a test keeps of the queries a connection is given, and when it reads the settings in force. */
interface Watch {
	/** The settings read just before each query the test watches for. */
	readings: InForce[];

	/** Every query given, in order. */
	sent: Sent[];

	watching(values: readonly unknown[] | undefined): boolean;
}

const inForceOn = async (client: pg.ClientBase): Promise<InForce> => {
	const [row] = await selectRows<InForce>(
		client,
		'SELECT current_setting($1) AS "actorType", current_setting($2) AS "actorId", current_setting($3) AS "statementTimeout", current_setting($4) AS "idleInTransactionSessionTimeout"',
		[
			ACTOR_SETTINGS.type,
			ACTOR_SETTINGS.id,
			SESSION_LIMIT_SETTINGS.statementTimeout,
			SESSION_LIMIT_SETTINGS.idleInTransactionSessionTimeout,
		],
	);
	return row ?? assert.fail('the store showed no settings');
};

// A pool connection that keeps each query given, and reads the settings in force on itself just
// before sending one the test watches for.
const watchedConnection = (client: pg.PoolClient, { readings, sent, watching }: Watch): PoolTrailConnection => ({
	query: async (text, values) => {
		sent.push({ text, values });
		if (watching(values)) {
			readings.push(await inForceOn(client));
		}
		return client.query<Row>(text, values === undefined ? undefined : [...values]);
	},
	release: (destroy) => {
		client.release(destroy);
	},
});

// Runs a test's use of a pool of one connection under the Controller's role, ending the pool once
// the use has settled. The listener keeps a connection lost while idle from ending the test process.
const withControllerPool = async <Result>(
	database: TestDatabase,
	use: (pool: pg.Pool) => Promise<Result>,
): Promise<Result> => {
	const pool = new pg.Pool({
		connectionString: database.urlFor('runtime'),
		max: 1,
	});
	pool.on('error', () => undefined);
	try {
		return await use(pool);
	} finally {
		await pool.end();
	}
};

// The Controller's audit trail over the pool, each connection it takes watched, and each line it
// writes kept in `written`.
const trailOver = (
	database: TestDatabase,
	pool: pg.Pool,
	watch: Watch,
	written: EventEnvelope[],
): Promise<AuditTrail<PoolTrailConnection>> =>
	createAuditTrail({
		eventLog: {
			error: () => undefined,
			writeEvent: (envelope) => {
				written.push(envelope);
			},
		},
		settings: {
			clock: { now: () => Date.now() },
			databaseSchema: database.schema,
			eventSource: HARNESS_EVENT_SOURCE,
			instanceName: 'usher-failure-event-recording',
			storeTimeoutMilliseconds: DEFAULT_STORE_TIMEOUT_MILLISECONDS,
		},
		store: {
			connect: async () => watchedConnection(await pool.connect(), watch),
		},
	});

const insertInto = (connection: PoolTrailConnection, table: { name: string }, row: Row): Promise<unknown> => {
	const entries = Object.entries(row);
	return connection.query(
		`INSERT INTO ${qualified(table)} (${entries.map(([column]) => pg.escapeIdentifier(column)).join(', ')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(', ')})`,
		entries.map(([, value]) => value),
	);
};

/** A person's id, and the id of the one identity every person holds once their transaction commits. */
interface PersonIds {
	identityId: string;
	userId: string;
}

const freshPersonIds = (): PersonIds => ({
	identityId: randomUUID(),
	userId: randomUUID(),
});

const insertPerson = async (connection: PoolTrailConnection, { identityId, userId }: PersonIds): Promise<void> => {
	await insertInto(connection, users, {
		...userRow(),
		[users.columns.id]: userId,
	});
	await insertInto(connection, userIdentities, {
		...identityRow(userId, randomUUID()),
		[userIdentities.columns.id]: identityId,
	});
};

const rowsWithId = async (
	client: pg.ClientBase,
	table: { columns: { id: string }; name: string },
	id: string,
): Promise<number> =>
	(
		await selectRows<{ count: number }>(
			client,
			`SELECT count(*)::int AS count FROM ${qualified(table)} WHERE ${pg.escapeIdentifier(table.columns.id)} = $1`,
			[id],
		)
	)[0]?.count ?? 0;

// Each query by its first word, one naming the work's savepoint in full.
const shapeOf = ({ text }: Sent): string => (text.includes(WORK_SAVEPOINT) ? text : (text.split(' ')[0] ?? text));

const isFailureEventRow = (values: readonly unknown[] | undefined): boolean =>
	values?.includes(emittedType(FAILURE_EVENT.type)) === true;

suite('a transaction naming a failure event, against the store', () => {
	test("sends BEGIN and the savepoint its work runs under as one query on a pool connection, and commits the work's rows and its events when the work succeeds", async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');
		const marker = await markStore(owner);
		const person = freshPersonIds();
		const sent: Sent[] = [];
		const written: EventEnvelope[] = [];

		const eventId = await withControllerPool(database, async (pool) =>
			(await trailOver(database, pool, { readings: [], sent, watching: () => false }, written)).inTransaction(
				PERSON_ACTING,
				async ({ connection, record }) => {
					await insertPerson(connection, person);
					return record(WORK_EVENT);
				},
				{ failureEvent: FAILURE_EVENT },
			),
		);
		const { changeRecords } = await writtenSince(owner, marker);
		const recorded = (await auditRows(owner)).filter(({ id }) => id === eventId);

		assert.deepEqual(sent[0], {
			text: BEGIN_UNDER_SAVEPOINT,
			values: undefined,
		});
		assert.deepEqual(sent.map(shapeOf), [BEGIN_UNDER_SAVEPOINT, 'SELECT', 'INSERT', 'INSERT', 'INSERT', 'COMMIT']);
		assert.equal(await rowsWithId(owner, users, person.userId), 1);
		assert.equal(await rowsWithId(owner, userIdentities, person.identityId), 1);
		assert.deepEqual(
			changeRecords.map(({ actorId, actorType, rowKey, tableName }) => ({
				actorId,
				actorType,
				rowKey,
				tableName,
			})),
			[
				{
					actorId: PERSON_ACTING.id,
					actorType: PERSON_ACTING.type,
					rowKey: { [userIdentities.columns.id]: person.identityId },
					tableName: userIdentities.name,
				},
			],
		);
		assert.deepEqual(
			recorded.map(({ type }) => type),
			[emittedType(WORK_EVENT.type)],
		);
		assert.deepEqual(
			written.map(({ id }) => id),
			[eventId],
		);
	});

	test("declares the actor and the transaction's own limits again before writing the failure event's row once the work fails, committing that row alone and nothing the work wrote", async (context) => {
		const database = await openDatabase(context);
		const owner = await database.connect('migration');
		const marker = await markStore(owner);
		const recordedBefore = new Set((await auditRows(owner)).map(({ id }) => id));
		const person = freshPersonIds();
		const failure = new Error('the work failed');
		const readings: InForce[] = [];
		const sent: Sent[] = [];
		const written: EventEnvelope[] = [];

		await withControllerPool(database, async (pool) =>
			assert.rejects(
				(
					await trailOver(database, pool, { readings, sent, watching: isFailureEventRow }, written)
				).inTransaction(
					PERSON_ACTING,
					async ({ connection, record }) => {
						await insertPerson(connection, person);
						await record(WORK_EVENT);
						throw failure;
					},
					{
						failureEvent: FAILURE_EVENT,
						timeoutMilliseconds: OWN_TIMEOUT_MILLISECONDS,
					},
				),
				(thrown) => thrown === failure,
			),
		);
		const { changeRecords } = await writtenSince(owner, marker);
		const recorded = (await auditRows(owner)).filter(({ id }) => !recordedBefore.has(id));
		const [declared, declaredAgain, ...declaredMore] = sent.filter(({ text }) =>
			text.includes(ACTOR_SETTINGS.type),
		);

		assert.deepEqual(readings, [
			{
				actorId: PERSON_ACTING.id,
				actorType: PERSON_ACTING.type,
				idleInTransactionSessionTimeout: `${OWN_TIMEOUT_MILLISECONDS}ms`,
				statementTimeout: `${OWN_TIMEOUT_MILLISECONDS}ms`,
			},
		]);
		assert.deepEqual(sent.map(shapeOf), [
			BEGIN_UNDER_SAVEPOINT,
			'SELECT',
			'INSERT',
			'INSERT',
			'INSERT',
			`ROLLBACK TO SAVEPOINT ${WORK_SAVEPOINT}`,
			'SELECT',
			'INSERT',
			'COMMIT',
		]);
		assert.deepEqual(declared?.values, [PERSON_ACTING.type, PERSON_ACTING.id, String(OWN_TIMEOUT_MILLISECONDS)]);
		assert.deepEqual(declaredAgain, declared);
		assert.deepEqual(declaredMore, []);
		assert.deepEqual(
			recorded.map(({ id, type }) => ({ id, type })),
			written.map(({ id }) => ({ id, type: emittedType(FAILURE_EVENT.type) })),
		);
		assert.equal(written.length, 1);
		assert.equal(await rowsWithId(owner, users, person.userId), 0);
		assert.equal(await rowsWithId(owner, userIdentities, person.identityId), 0);
		assert.deepEqual(changeRecords, []);
	});
});
