import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { migrateDatabaseInProcess, openEmptyDatabase, readColumns } from '../../testing/fixtures/database.js';

suite('the migration adding creation ids', () => {
	test('gives grants and grant requests a nullable uuid naming the call that wrote them', async (context) => {
		const database = await openEmptyDatabase(context);
		await migrateDatabaseInProcess(database);
		const owner = await database.connect('migration');

		const columns = (await readColumns(owner)).filter(({ column }) => column === 'creation_id');

		assert.deepEqual(
			columns.map(({ notNull, table, type }) => ({ notNull, table, type })),
			[
				{ notNull: false, table: 'grant_requests', type: 'uuid' },
				{ notNull: false, table: 'grants', type: 'uuid' },
			],
		);
		await owner.end();
	});
});
