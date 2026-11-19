import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as refusalWindows from './index.js';

suite('the refusal windows module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(refusalWindows).toSorted(), [
      'PER_TOKEN_WINDOW_LIMIT',
      'REFUSAL_WINDOW_CEILING_MILLISECONDS',
      'REFUSAL_WINDOW_COOLDOWN_MILLISECONDS',
      'createRefusalWindows',
      'tokenDigestOf',
    ]);
  });
});
