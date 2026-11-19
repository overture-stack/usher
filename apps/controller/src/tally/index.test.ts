import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as tally from './index.js';

suite('the tally module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(tally).toSorted(), ['createTally']);
  });
});
