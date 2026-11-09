import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as failures from './index.js';

suite("the controller's failures module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(failures).toSorted(), [
      'ControllerError',
      'StartRefusal',
      'failureCodeOf',
      'failureNameOf',
      'reportFailure',
      'reportUncaughtFailure',
    ]);
  });
});
