import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as configuration from './index.js';

suite("the configuration's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(configuration).toSorted(), [
			'CLOCK_TOLERANCE_MILLISECONDS',
			'ENVIRONMENT_VARIABLES',
			'SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES',
			'readConfiguration',
			'readSchemaMigrationConfiguration',
		]);
	});
});
