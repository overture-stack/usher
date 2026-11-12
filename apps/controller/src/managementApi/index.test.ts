import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as managementApi from './index.js';

suite("the management API's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(managementApi).toSorted(), [
      'PROBLEMS',
      'REFUSAL_TALLY_INTERVAL_MILLISECONDS',
      'managementRoute',
      'readTextMembers',
      'refusalTallyEvent',
      'unreadableBody',
      'unreadableQuery',
    ]);
  });
});
