import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as http from './index.js';

suite('the HTTP module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(http).toSorted(), ['createServer', 'problem']);
  });
});
