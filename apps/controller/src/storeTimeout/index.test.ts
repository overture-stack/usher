import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as storeTimeout from './index.js';

suite("the store timeout's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(storeTimeout).toSorted(), [
      'COMMIT_WINDOW_MILLISECONDS',
      'CommitUnconfirmed',
      'StoreTimeout',
      'createStoreReader',
      'withinStoreTimeout',
    ]);
  });
});
