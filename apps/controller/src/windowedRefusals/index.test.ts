import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as windowedRefusals from './index.js';

suite('the windowed refusals module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(windowedRefusals).toSorted(), [
      'CLOSING_UNRECORDED',
      'WINDOW_CLOCK_READING_MILLISECONDS',
      'createWindowedRefusals',
    ]);
  });
});
