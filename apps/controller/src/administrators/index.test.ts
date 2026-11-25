import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as administrators from './index.js';

suite('the administrators module', () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(administrators).toSorted(), [
			'ADMINISTRATOR_PROBLEMS',
			'confirmAdministratorAuthority',
			'countLiveAdministrators',
			'createAdministratorRoutes',
			'readAdministratorStatus',
			'sqlAdministratorStore',
		]);
	});
});
