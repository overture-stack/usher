import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import type { StoreReader } from '../storeTimeout/index.js';
import { createUsedAssertions } from './createUsedAssertions.js';

const SCHEMA = 'usher';

const ACCEPTED_UNTIL = 2_000;

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

/**
 * A store double holding rows by their first two values, the application and the `jti`, as the
 * table's primary key does: an insert of a key it holds writes nothing, and reports so as the store does.
 */
const storeHolding = (): { reader: StoreReader; statements: Statement[] } => {
	const keys = new Set<string>();
	const statements: Statement[] = [];
	const reader: StoreReader = {
		query: <Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) => {
			statements.push({ text, values });
			const key = JSON.stringify(values?.slice(0, 2));
			const rowCount = keys.has(key) ? 0 : 1;
			keys.add(key);
			return Promise.resolve({
				command: 'INSERT',
				fields: [],
				oid: 0,
				rowCount,
				rows: [] as Row[],
			} satisfies pg.QueryResult<Row>);
		},
	};
	return { reader, statements };
};

suite('the record of assertions presented to the stream', () => {
	test('records an assertion once, and refuses it again', async () => {
		const { reader } = storeHolding();
		const used = createUsedAssertions(reader, SCHEMA);

		assert.equal(await used.record('search', 'jti-1', ACCEPTED_UNTIL), true);
		assert.equal(await used.record('search', 'jti-1', ACCEPTED_UNTIL), false);
	});

	test('knows an assertion by its application and its jti together', async () => {
		const { reader } = storeHolding();
		const used = createUsedAssertions(reader, SCHEMA);

		await used.record('search', 'jti-1', ACCEPTED_UNTIL);

		assert.equal(await used.record('portal', 'jti-1', ACCEPTED_UNTIL), true);
		assert.equal(await used.record('search', 'jti-2', ACCEPTED_UNTIL), true);
	});

	test('writes each record through the store as an insert ignoring a conflict, under the schema, with the instant as a date', async () => {
		const { reader, statements } = storeHolding();
		const used = createUsedAssertions(reader, SCHEMA);

		await used.record('search', 'jti-1', ACCEPTED_UNTIL);

		const [statement] = statements;
		assert.ok(statement !== undefined);
		assert.match(statement.text, /INSERT INTO "usher"\.used_channel_assertions/u);
		assert.match(statement.text, /ON CONFLICT DO NOTHING/u);
		assert.deepEqual(statement.values, ['search', 'jti-1', new Date(ACCEPTED_UNTIL)]);
	});

	test('rejects when the store does, recording nothing', async () => {
		const reader: StoreReader = {
			query: () => Promise.reject(new Error('the store does not answer')),
		};
		const used = createUsedAssertions(reader, SCHEMA);

		await assert.rejects(used.record('search', 'jti-1', ACCEPTED_UNTIL), /the store does not answer/u);
	});
});
