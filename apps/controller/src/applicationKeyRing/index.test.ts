import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as keyRing from './index.js';

suite("the application key ring's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(keyRing).toSorted(), [
      'KEY_CHANGE_FAILED',
      'KEY_READ_FAILED',
      'KEY_RELOAD_INTERVAL_MILLISECONDS',
      'KEY_UNREADABLE',
      'SUBKEY_LABELS',
      'applicationSubkeys',
      'createApplicationKeyRing',
    ]);
  });
});
