import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as exchange from './index.js';

suite("the exchange's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(exchange).toSorted(), [
      'EXCHANGE_PATH',
      'EXCHANGE_REQUEST_TIMEOUT',
      'EXCHANGE_STORE_FAILED',
      'EXCHANGE_UNEXPECTED_FAILURE',
      'KEY_CONFIRMATION_FAILED',
      'LATE_REQUEST_THRESHOLD_MILLISECONDS',
      'createExchange',
      'createKeyConfirmations',
    ]);
  });
});
