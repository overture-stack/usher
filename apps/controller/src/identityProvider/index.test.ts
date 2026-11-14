import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as identityProvider from './index.js';

suite("the identity provider's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(identityProvider).toSorted(), [
      'createTokenVerifier',
      'discoveryUrl',
    ]);
  });
});
