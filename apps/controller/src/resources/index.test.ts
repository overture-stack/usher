import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as resources from './index.js';

suite('the resources module', () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(resources).toSorted(), [
      'createResourceRoutes',
    ]);
  });
});
