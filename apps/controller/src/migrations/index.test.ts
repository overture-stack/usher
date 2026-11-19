import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as migrations from './index.js';

suite('the migrations module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(migrations).toSorted(), [
			'MIGRATIONS_REFUSE_TO_RUN',
			'MIGRATION_UNKNOWN',
			'MigrationRefusal',
			'migrate',
			'migrationUnknownFields',
			'readMigrations',
			'unknownMigrations',
		]);
	});
});
