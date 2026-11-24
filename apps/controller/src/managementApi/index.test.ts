import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as managementApi from './index.js';

suite("the management API's module", () => {
	test('exports at run time exactly the values its surface names', () => {
		assert.deepEqual(Object.keys(managementApi).toSorted(), [
			'AdministratorStatusWithdrawn',
			'PROBLEMS',
			'admittedAdministrator',
			'managementRoute',
			'pageOf',
			'readPageQuery',
			'readTextMembers',
			'refusalTallyEvent',
			'unreadableBody',
			'unreadableQuery',
			'withAdministratorAuthority',
		]);
	});
});
