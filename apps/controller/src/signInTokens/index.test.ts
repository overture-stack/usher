import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as signInTokens from './index.js';

suite("the sign-in tokens' module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(signInTokens).toSorted(), [
      'currencyOf',
      'judgeSignInCredential',
      'namesAudience',
      'readNames',
      'readStoredRefusal',
      'sessionOf',
    ]);
  });
});
