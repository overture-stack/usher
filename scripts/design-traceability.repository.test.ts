import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { repositoryWorkspace } from './check-design-traceability.ts';
import { traceabilityFindings } from './design-traceability.ts';

suite("the repository's design traceability list", () => {
	test('stands: every design section has a row, and every row stands', () => {
		assert.deepEqual(traceabilityFindings(repositoryWorkspace()), []);
	});
});
