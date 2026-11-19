import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { eventInstant } from './eventInstant.js';

suite("an event's instant", () => {
  test('is written in UTC with the Z designator, its seconds and milliseconds always present', () => {
    assert.equal(
      eventInstant(Date.UTC(2026, 9, 23, 12, 0, 0)),
      '2026-10-23T12:00:00.000Z',
    );
    assert.equal(
      eventInstant(Date.UTC(2026, 9, 23, 23, 59, 59, 7)),
      '2026-10-23T23:59:59.007Z',
    );
  });
});
