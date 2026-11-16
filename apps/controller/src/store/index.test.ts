import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as store from './index.js';

suite("the store's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(store).toSorted(), [
      'checkStatementLimits',
      'connectionProblemOf',
      'holdsUnstorableText',
      'isStorableText',
      'openStore',
      'prepareStore',
      'readStoreProbe',
      'writeSeededPolicy',
    ]);
  });
});
