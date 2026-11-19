import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import * as noticeChannel from './index.js';

suite("the notice channel's module", () => {
  test('exports at run time exactly the values its surface names', () => {
    assert.deepEqual(Object.keys(noticeChannel).toSorted(), [
      'CHANNEL_PATHS',
      'CHANNEL_STORE_FAILED',
      'CHANNEL_UNEXPECTED_FAILURE',
      'SLOW_STREAM_CLOSED',
      'STREAM_FAILED',
      'TAIL_READ_FAILED',
      'createNoticeChannel',
      'createUsedAssertions',
    ]);
  });
});
