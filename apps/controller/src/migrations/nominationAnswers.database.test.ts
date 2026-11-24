import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
	ANA_ACTING,
	committedQuery,
	INSUFFICIENT_PRIVILEGE,
	INTEGRITY,
	openSeededDatabase,
	selectRows,
	stewardOf,
	violation,
} from '../../testing/fixtures/database.js';
import { USHER_SCHEMA } from '../../testing/harness/database.js';
import { inTurn, POLICY_TABLES, qualified, seededId } from '../../testing/harness/policy.js';

const { administrators, nominationDeclines, nominationRevocations, nominations } = POLICY_TABLES;

// The code PL/pgSQL raises a history rule's refusal with, naming the rule as its constraint.
const HISTORY_KEPT_CODE = '23000';

interface ColumnShape {
	column: string;
	nullable: string;
	type: string;
}

// A table's columns, in order, as the catalogue of the Controller's schema gives them.
const columnsOf = (client: pg.ClientBase, table: string): Promise<readonly ColumnShape[]> =>
	selectRows<ColumnShape>(
		client,
		`SELECT column_name AS column, data_type AS type, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
		[USHER_SCHEMA, table],
	);

// Each table's insert of one answer to a nomination, by the table's name, with the nominee named by its
// `users.id` and the nomination by its id.
const ANSWER_INSERTS: Readonly<
	Record<string, (nominationId: string, nomineeId: string) => readonly [string, unknown[]]>
> = Object.freeze({
	administrators: (nominationId, nomineeId) => [
		`INSERT INTO ${qualified(administrators)} (${administrators.columns.userId}, ${administrators.columns.nominationId}, ${administrators.columns.acceptedAt}) VALUES ($1, $2, now())`,
		[nomineeId, nominationId],
	],
	nomination_declines: (nominationId) => [
		`INSERT INTO ${qualified(nominationDeclines)} (${nominationDeclines.columns.nominationId}, ${nominationDeclines.columns.declinedAt}) VALUES ($1, now())`,
		[nominationId],
	],
	nomination_revocations: (nominationId) => [
		`INSERT INTO ${qualified(nominationRevocations)} (${nominationRevocations.columns.nominationId}, ${nominationRevocations.columns.revokedAt}) VALUES ($1, now())`,
		[nominationId],
	],
});

suite("the nomination answers' tables, from migration 0014", () => {
	test('shapes a decline and a revocation each as a row keyed by its nomination, holding the instant it was made', async (context) => {
		const { owner } = await openSeededDatabase(context);

		assert.deepEqual(await columnsOf(owner, nominationDeclines.name), [
			{ column: 'nomination_id', nullable: 'NO', type: 'uuid' },
			{ column: 'declined_at', nullable: 'NO', type: 'timestamp with time zone' },
		]);
		assert.deepEqual(await columnsOf(owner, nominationRevocations.name), [
			{ column: 'nomination_id', nullable: 'NO', type: 'uuid' },
			{ column: 'revoked_at', nullable: 'NO', type: 'timestamp with time zone' },
		]);
	});

	test('refuses an answer naming no nomination, and a second answer to one nomination, each by its constraint', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const steward = stewardOf(seeded);
		const nominated = randomUUID();
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
       VALUES ($1, now() + interval '1 day', $2, $3)`,
			[nominated, steward, seededId(seeded.users, 'cy')],
		);

		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(nominationDeclines)} (${nominationDeclines.columns.nominationId}, ${nominationDeclines.columns.declinedAt}) VALUES ($1, now())`,
				[randomUUID()],
			),
			violation(INTEGRITY.foreignKey, 'nomination_declines_nomination_id_fkey'),
		);
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominationDeclines)} (${nominationDeclines.columns.nominationId}, ${nominationDeclines.columns.declinedAt}) VALUES ($1, now())`,
			[nominated],
		);
		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(nominationDeclines)} (${nominationDeclines.columns.nominationId}, ${nominationDeclines.columns.declinedAt}) VALUES ($1, now())`,
				[nominated],
			),
			violation(INTEGRITY.unique, 'nomination_declines_pkey'),
		);
		await assert.rejects(
			committedQuery(
				owner,
				`INSERT INTO ${qualified(nominationRevocations)} (${nominationRevocations.columns.nominationId}, ${nominationRevocations.columns.revokedAt}) VALUES ($1, now())`,
				[randomUUID()],
			),
			violation(INTEGRITY.foreignKey, 'nomination_revocations_nomination_id_fkey'),
		);
	});

	test("keeps every decline and revocation as written, for the schema's owner too", async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const nominated = randomUUID();
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
       VALUES ($1, now() + interval '1 day', $2, $3)`,
			[nominated, stewardOf(seeded), seededId(seeded.users, 'cy')],
		);
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominationRevocations)} (${nominationRevocations.columns.nominationId}, ${nominationRevocations.columns.revokedAt}) VALUES ($1, now())`,
			[nominated],
		);

		await assert.rejects(
			committedQuery(
				owner,
				`UPDATE ${qualified(nominationRevocations)} SET ${nominationRevocations.columns.revokedAt} = now()`,
			),
			violation(HISTORY_KEPT_CODE, 'nomination_revocations_kept'),
		);
		await assert.rejects(
			committedQuery(owner, `DELETE FROM ${qualified(nominationRevocations)}`),
			violation(HISTORY_KEPT_CODE, 'nomination_revocations_kept'),
		);
	});

	test("lets the controller's role insert and read each answer, and neither change nor delete it", async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const controller = await database.connect('runtime');
		const nominated = randomUUID();
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
       VALUES ($1, now() + interval '1 day', $2, $3)`,
			[nominated, stewardOf(seeded), seededId(seeded.users, 'cy')],
		);

		await committedQuery(
			controller,
			`INSERT INTO ${qualified(nominationDeclines)} (${nominationDeclines.columns.nominationId}, ${nominationDeclines.columns.declinedAt}) VALUES ($1, now())`,
			[nominated],
			ANA_ACTING,
		);
		const read = await selectRows(controller, `SELECT * FROM ${qualified(nominationDeclines)}`);

		await assert.rejects(
			committedQuery(
				controller,
				`UPDATE ${qualified(nominationDeclines)} SET ${nominationDeclines.columns.declinedAt} = now()`,
				[],
				ANA_ACTING,
			),
			{ code: INSUFFICIENT_PRIVILEGE },
		);
		await assert.rejects(
			committedQuery(controller, `DELETE FROM ${qualified(nominationDeclines)}`, [], ANA_ACTING),
			{ code: INSUFFICIENT_PRIVILEGE },
		);
		assert.equal(read.length, 1);
	});

	test('refuses a second answer to a nomination in any other answer table, whichever of the three came first, by the constraint nomination_answered_once', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const tables = Object.keys(ANSWER_INSERTS);
		// The pairs take the fixture's people in turn. A person holds one administrator row, so the two
		// pairs answering first by acceptance each need a nominee not yet an administrator; in every other
		// pair the second answer is refused by the trigger before any key is checked.
		const nominees = ['ana', 'bo', 'cy'].map((name) => seededId(seeded.users, name));
		const pairs = tables
			.flatMap((first) => tables.filter((second) => second !== first).map((second) => [first, second] as const))
			.map(([first, second], index) => ({
				first,
				nominee: nominees[index % nominees.length] ?? assert.fail(`no nominee for pair ${index}`),
				second,
			}));

		const outcomes = await inTurn(pairs, async ({ first, nominee, second }) => {
			const nominated = randomUUID();
			await committedQuery(
				owner,
				`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
           VALUES ($1, now() + interval '1 day', $2, $3)`,
				[nominated, stewardOf(seeded), nominee],
			);
			const [firstText, firstParams] = ANSWER_INSERTS[first]?.(nominated, nominee) ?? assert.fail(first);
			await committedQuery(owner, firstText, firstParams);
			const [secondText, secondParams] = ANSWER_INSERTS[second]?.(nominated, nominee) ?? assert.fail(second);
			return committedQuery(owner, secondText, secondParams).then(
				() => 'accepted',
				(error: unknown) => (error instanceof Error && 'constraint' in error ? error.constraint : error),
			);
		});

		assert.deepEqual(
			outcomes,
			pairs.map(() => 'nomination_answered_once'),
		);
	});

	test('refuses a second administrator for one nomination by the constraint administrator_held_once, since a person holds one administrator at a time', async (context) => {
		const { owner, seeded } = await openSeededDatabase(context);
		const cy = seededId(seeded.users, 'cy');
		const nominated = randomUUID();
		await committedQuery(
			owner,
			`INSERT INTO ${qualified(nominations)} (${nominations.columns.id}, ${nominations.columns.nominatedAt}, ${nominations.columns.nominatedBy}, ${nominations.columns.nomineeId})
       VALUES ($1, now() + interval '1 day', $2, $3)`,
			[nominated, stewardOf(seeded), cy],
		);
		const [text, params] = ANSWER_INSERTS['administrators']?.(nominated, cy) ?? assert.fail('administrators');
		await committedQuery(owner, text, params);

		await assert.rejects(committedQuery(owner, text, params), violation('23000', 'administrator_held_once'));
	});
});
