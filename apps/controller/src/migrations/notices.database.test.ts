import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type pg from 'pg';

import { createDedicatedTestDatabase, untilBlocked } from '../../testing/harness/database.js';
import {
	backendPid,
	BASE_FIXTURE,
	committedInsert,
	insertNotice,
	INTEGRITY,
	isStoreRefusal,
	type NoticeParts,
	noticeRow,
	noticeStreamRows,
	openSeededDatabase,
	selectRows,
	SUBJECTS,
	untilSleeping,
	violation,
	writeOutcome,
} from '../../testing/fixtures/database.js';
import {
	fixtureApplicationId,
	highestPosition,
	inTurn,
	noticesAfter,
	noticeSubject,
	POLICY_TABLES,
	qualified,
	seedPolicy,
	type StoredNotice,
} from '../../testing/harness/policy.js';

const { noticeStream, notices } = POLICY_TABLES;

const ONE_OF_EACH_KIND: readonly NoticeParts[] = [
	{ kind: 'principal', subject: noticeSubject({ subject: SUBJECTS.ana }) },
	{ kind: 'category', resourceExternalId: 'STUDY-A1' },
	{ kind: 'baseline' },
	{ kind: 'signOutEveryone' },
	{ audience: fixtureApplicationId('ims-arranger'), kind: 'servedResources' },
];

// A baseline notice's value for each column a notice insert writes, and the same value computed
// only after a two-second sleep, for the column a slow insert evaluates after its position.
const PLAIN_VALUES: Readonly<Record<string, string>> = {
	[notices.columns.audience]: 'NULL::uuid',
	[notices.columns.createdAt]: 'clock_timestamp()',
	[notices.columns.kind]: "'baseline'",
	[notices.columns.resourceExternalId]: 'NULL::text',
	[notices.columns.idpSubjectId]: 'NULL::text',
};

const SLOW_VALUES: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(PLAIN_VALUES).map(([column, value]) => [column, `(SELECT ${value} FROM pg_sleep(2))`]),
);

// PostgreSQL evaluates an insert's values in the table's column order, so a value in a column
// after position is computed after the position is drawn.
const columnOrder = async (client: pg.ClientBase): Promise<readonly string[]> =>
	(
		await selectRows<{ name: string }>(
			client,
			'SELECT attname AS name FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum',
			[qualified(notices)],
		)
	).map(({ name }) => name);

// Every way to break a rule that one kind alone names a field: that kind without it, and each other
// kind, otherwise whole, with it.
const exclusiveTo = (
	owningKind: string,
	field: Pick<NoticeParts, 'audience' | 'resourceExternalId' | 'subject'>,
): readonly NoticeParts[] => [
	{ kind: owningKind },
	...ONE_OF_EACH_KIND.filter(({ kind }) => kind !== owningKind).map((parts) => ({ ...parts, ...field })),
];

const WRITERS = 50;

interface Commit {
	position: bigint;

	/** When the commit's answer reached the test, from `performance.now()`. */
	returnedAt: number;
}

const laterAndEarlier = (first: Commit, second: Commit): { earlier: Commit; later: Commit } =>
	first.returnedAt > second.returnedAt ? { earlier: second, later: first } : { earlier: first, later: second };

const insertAndCommit = async (client: pg.ClientBase, parts: NoticeParts): Promise<Commit> => {
	const position = await insertNotice(client, parts);
	await client.query('COMMIT');
	return { position, returnedAt: performance.now() };
};

const commitNow = async (client: pg.ClientBase, position: bigint): Promise<Commit> => {
	await client.query('COMMIT');
	return { position, returnedAt: performance.now() };
};

const follow = async (
	reader: pg.ClientBase,
	after: bigint,
	seen: readonly StoredNotice[],
	writersDone: () => boolean,
): Promise<readonly StoredNotice[]> => {
	const doneBeforeReading = writersDone();
	const batch = await noticesAfter(reader, after);
	const read = [...seen, ...batch];
	if (doneBeforeReading && batch.length === 0) {
		return read;
	}
	await delay(5);
	return follow(reader, batch.at(-1)?.position ?? after, read, writersDone);
};

suite('the notice stream', () => {
	test('accepts each kind of notice the bridge reads', async (context) => {
		const { owner } = await openSeededDatabase(context);

		const outcomes = await inTurn(ONE_OF_EACH_KIND, (parts) =>
			writeOutcome(committedInsert(owner, notices, noticeRow(parts))),
		);

		assert.deepEqual(
			outcomes,
			ONE_OF_EACH_KIND.map(() => 'accepted'),
		);
	});

	test('holds only the kinds the bridge reads', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const lookalikes = ['Principal', 'served_resources', 'servedresources', 'revocation', ' principal', ''];

		const outcomes = await inTurn(lookalikes, (kind) =>
			writeOutcome(committedInsert(owner, notices, noticeRow({ kind }))),
		);

		assert.deepEqual(
			outcomes,
			lookalikes.map(() => INTEGRITY.check),
		);
	});

	test('names a subject on a principal notice and on no other', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const cases = exclusiveTo('principal', {
			subject: noticeSubject({ subject: SUBJECTS.ana }),
		});

		const outcomes = await inTurn(cases, (parts) =>
			writeOutcome(committedInsert(owner, notices, noticeRow(parts))),
		);

		assert.deepEqual(
			outcomes,
			cases.map(() => INTEGRITY.check),
		);
	});

	test('names a resource on a category notice and on no other', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const cases = exclusiveTo('category', { resourceExternalId: 'STUDY-A1' });

		const outcomes = await inTurn(cases, (parts) =>
			writeOutcome(committedInsert(owner, notices, noticeRow(parts))),
		);

		assert.deepEqual(
			outcomes,
			cases.map(() => INTEGRITY.check),
		);
	});

	test('names an audience on a servedResources notice and on no other', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const cases = exclusiveTo('servedResources', {
			audience: fixtureApplicationId('ims-arranger'),
		});

		const outcomes = await inTurn(cases, (parts) =>
			writeOutcome(committedInsert(owner, notices, noticeRow(parts))),
		);

		assert.deepEqual(
			outcomes,
			cases.map(() => INTEGRITY.check),
		);
	});

	test('names a non-empty subject and resource on every notice that names one', async (context) => {
		const { owner } = await openSeededDatabase(context);

		const outcomes = await inTurn(
			[
				{ kind: 'principal', subject: '' },
				{ kind: 'category', resourceExternalId: '' },
			],
			(parts) => writeOutcome(committedInsert(owner, notices, noticeRow(parts))),
		);

		assert.deepEqual(outcomes, [INTEGRITY.check, INTEGRITY.check]);
	});

	test('assigns every position in the database, in one sequence across kinds', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const named = (await highestPosition(owner)) + 1000n;

		await assert.rejects(
			owner.query(
				`INSERT INTO ${qualified(notices)} (${notices.columns.createdAt}, ${notices.columns.kind}, ${notices.columns.position}) VALUES (now(), 'baseline', $1)`,
				[named.toString()],
			),
			isStoreRefusal,
		);
		const positions = await inTurn([...ONE_OF_EACH_KIND, ...ONE_OF_EACH_KIND], (parts) =>
			insertNotice(owner, parts),
		);

		assert.deepEqual(
			positions.slice(1).map((position, index) => position > (positions[index] ?? position)),
			positions.slice(1).map(() => true),
		);
		assert.deepEqual(
			await selectRows(owner, `SELECT 1 FROM ${qualified(notices)} WHERE ${notices.columns.position} = $1`, [
				named.toString(),
			]),
			[],
		);
	});

	test('gives the later commit the higher position', async (context) => {
		const { database, owner } = await openSeededDatabase(context);
		const first = await database.connect('migration');
		const second = await database.connect('migration');

		await first.query('BEGIN');
		const firstPosition = await insertNotice(first, { kind: 'baseline' });
		await second.query('BEGIN');
		const secondCommitted = insertAndCommit(second, { kind: 'signOutEveryone' });
		await untilBlocked(owner, secondCommitted);
		const firstCommitted = await commitNow(first, firstPosition);
		const { earlier, later } = laterAndEarlier(firstCommitted, await secondCommitted);

		assert.equal(later.position > earlier.position, true);
	});

	test('orders a notice by its commit however long its insert takes to evaluate', async (context) => {
		const { database, owner } = await openSeededDatabase(context);
		const first = await database.connect('migration');
		const second = await database.connect('migration');
		const firstPid = await backendPid(first);
		const order = await columnOrder(owner);
		const slowColumn = order
			.slice(order.indexOf(notices.columns.position) + 1)
			.find((column) => Object.hasOwn(SLOW_VALUES, column));
		assert.notEqual(
			slowColumn,
			undefined,
			'the test needs a column of notices that the table holds after position, so the insert is slow after drawing its position',
		);
		const inserted = Object.keys(PLAIN_VALUES);
		const values = inserted.map((column) => (column === slowColumn ? SLOW_VALUES[column] : PLAIN_VALUES[column]));

		await first.query('BEGIN');
		const slowInsert = first.query<{ position: string }>(
			`INSERT INTO ${qualified(notices)} (${inserted.join(', ')}) VALUES (${values.join(', ')}) RETURNING ${notices.columns.position}::text AS position`,
		);
		await untilSleeping(owner, firstPid);
		await second.query('BEGIN');
		const secondCommitted = insertAndCommit(second, { kind: 'signOutEveryone' });
		const [slowRow] = (await slowInsert).rows;
		await untilBlocked(owner, secondCommitted);
		const firstCommitted = await commitNow(first, BigInt(slowRow?.position ?? '0'));
		const { earlier, later } = laterAndEarlier(firstCommitted, await secondCommitted);

		assert.equal(later.position > earlier.position, true);
	});

	test('lets a reader following positions see every committed notice', async (context) => {
		const database = await createDedicatedTestDatabase();
		context.after(() => database.close());
		const owner = await database.connect('migration');
		await seedPolicy(owner, BASE_FIXTURE);
		const reader = await database.connect('migration');
		const writers = await Promise.all(Array.from({ length: WRITERS }, () => database.connect('migration')));
		const start = await highestPosition(reader);
		const firstMarker = Date.parse('2026-10-23T00:00:00Z');
		const writing = { done: false };

		const written = Promise.all(
			writers.map(async (writer, index) => {
				const marker = new Date(firstMarker + index * 1000);
				const rollsBack = Math.floor(index / 5) % 5 === index % 5;
				await writer.query('BEGIN');
				await insertNotice(writer, {
					...(ONE_OF_EACH_KIND[index % ONE_OF_EACH_KIND.length] ?? {
						kind: 'baseline',
					}),
					createdAt: marker,
				});
				await delay((index * 37) % 201);
				await writer.query(rollsBack ? 'ROLLBACK' : 'COMMIT');
				return { committed: !rollsBack, marker: marker.getTime() / 1000 };
			}),
		).finally(() => {
			writing.done = true;
		});
		const read = await follow(reader, start, [], () => writing.done);
		const outcomes = await written;

		assert.deepEqual(
			read.slice(1).map((notice, index) => notice.position > (read[index]?.position ?? notice.position)),
			read.slice(1).map(() => true),
		);
		assert.deepEqual(
			read.map(({ createdAt }) => Number(createdAt)).sort((left, right) => left - right),
			outcomes
				.filter(({ committed }) => committed)
				.map(({ marker }) => marker)
				.sort((left, right) => left - right),
		);
		assert.equal(outcomes.filter(({ committed }) => !committed).length, WRITERS / 5);
	});

	test('keeps one row describing the stream', async (context) => {
		const { owner } = await openSeededDatabase(context);
		const stream = await noticeStreamRows(owner);

		await assert.rejects(
			committedInsert(owner, noticeStream, {
				[noticeStream.columns.epoch]: randomUUID(),
				[noticeStream.columns.trimmedThrough]: 0,
			}),
			violation(INTEGRITY.unique),
		);
		await assert.rejects(
			committedInsert(owner, noticeStream, {
				[noticeStream.columns.epoch]: randomUUID(),
				[noticeStream.columns.singleton]: false,
				[noticeStream.columns.trimmedThrough]: 0,
			}),
			violation(INTEGRITY.check),
		);

		assert.equal(stream.length, 1);
		assert.deepEqual(await noticeStreamRows(owner), stream);
	});
});
