import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as capabilities from './index.js';

suite('the capabilities module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(capabilities).toSorted(), [
      'CAPABILITY_VOCABULARY',
      'SEEDED_ROLES',
    ]);
  });
});
