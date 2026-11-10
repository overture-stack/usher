import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as signOuts from './index.js';

suite("the sign-outs' module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(signOuts).toSorted(), [
      'BACK_CHANNEL_LOGOUT_EVENT',
      'LOGOUT_TOKEN_TALLY_INTERVAL_MILLISECONDS',
      'SIGN_OUT_PATH',
      'SIGN_OUT_STORE_FAILED',
      'SIGN_OUT_UNEXPECTED_FAILURE',
      'createSignOutRoute',
      'logoutTokenRefusalTallyEvent',
    ]);
  });
});
