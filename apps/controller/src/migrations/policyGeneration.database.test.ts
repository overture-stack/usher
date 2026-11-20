import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { untilBlocked } from '../../testing/harness/database.js';
import {
	committedQuery,
	isStoreRefusal,
	type LaterOperation,
	mayKeepHistory,
	observeChange,
	openSeededDatabase,
	POLICY_GENERATION_TABLES,
	recordedChangeKits,
	readPolicyGeneration,
	run,
	type Statement,
	writtenInItsTransaction,
} from '../../testing/fixtures/database.js';
import {
	declareActor,
	inTurn,
	POLICY_TABLES,
	qualified,
	seededId,
	SYSTEM_ACTOR,
} from '../../testing/harness/policy.js';

const { resources } = POLICY_TABLES;

const describing = (client: pg.ClientBase, resourceId: string, description: string): Promise<unknown> =>
	client.query(
		`UPDATE ${qualified(resources)} SET ${resources.columns.description} = $1 WHERE ${resources.columns.id} = $2`,
		[description, resourceId],
	);

suite('the policy generation', () => {
	test('raises the policy generation in the transaction of every policy change the store accepts, and rolls it back with it', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const kits = recordedChangeKits(seeded).filter(({ table }) => POLICY_GENERATION_TABLES.includes(table));

		const problems = await inTurn(kits, async (kit) => {
			await inTurn(kit.prepare, (step) => committedQuery(owner, step.text, step.parameters));
			const operations: readonly {
				operation: 'insert' | LaterOperation;
				step: Statement;
			}[] = [
				{ operation: 'insert', step: kit.insert },
				{ operation: 'update', step: kit.update },
				{ operation: 'delete', step: kit.delete },
			];
			return inTurn(operations, async ({ operation, step }) => {
				const before = await readPolicyGeneration(owner);
				const observed = await observeChange(database, (client) => run(client, step)).catch(
					(error: unknown) => {
						if (operation !== 'insert' && isStoreRefusal(error) && mayKeepHistory(kit.table, operation)) {
							return undefined;
						}
						throw error;
					},
				);
				const after = await readPolicyGeneration(owner);
				const where = `${kit.table.name} ${operation}`;
				if (observed === undefined) {
					return after === before ? [] : [`${where}: refused, yet raised`];
				}
				const raised =
					before !== undefined &&
					observed.insideTransaction.generation !== undefined &&
					observed.insideTransaction.generation > before;
				return [
					...(raised ? [] : [`${where}: not raised`]),
					...(writtenInItsTransaction(observed) ? [] : [`${where}: not raised in its own transaction alone`]),
				];
			});
		});

		assert.deepEqual(problems.flat(2), []);
	});

	test('gives two policy changes committed at once different generations', async (context) => {
		const { database, owner, seeded } = await openSeededDatabase(context);
		const first = await database.connect('migration');
		const second = await database.connect('migration');
		const start = await readPolicyGeneration(owner);

		await first.query('BEGIN');
		await declareActor(first, SYSTEM_ACTOR);
		await describing(first, seededId(seeded.resources, 'STUDY-A1'), 'Cardiac outcomes, followed for five years');
		const firstGeneration = await readPolicyGeneration(first);
		await second.query('BEGIN');
		await declareActor(second, SYSTEM_ACTOR);
		const secondChange = (async (): Promise<bigint | undefined> => {
			await describing(second, seededId(seeded.resources, 'STUDY-B2'), 'Pulmonary function, as measured at rest');
			return readPolicyGeneration(second);
		})();
		await untilBlocked(owner, secondChange);
		await first.query('COMMIT');
		const secondGeneration = await secondChange;
		await second.query('COMMIT');
		const final = await readPolicyGeneration(owner);

		assert.notEqual(start, undefined);
		assert.notEqual(firstGeneration, undefined);
		assert.notEqual(secondGeneration, undefined);
		assert.notEqual(firstGeneration, secondGeneration);
		assert.equal(
			[firstGeneration, secondGeneration].every(
				(generation) => generation !== undefined && start !== undefined && generation > start,
			),
			true,
		);
		assert.equal(
			final,
			[firstGeneration ?? 0n, secondGeneration ?? 0n].reduce((highest, generation) =>
				generation > highest ? generation : highest,
			),
		);
	});
});
