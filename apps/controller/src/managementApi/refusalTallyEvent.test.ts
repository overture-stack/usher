import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { refusalTallyEvent } from './refusalTallyEvent.js';

const OPENED_AT = Date.UTC(2026, 10, 18, 9, 0, 0);

const WINDOW_ID = '0f4c1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b';

suite("a closed window's managementToken.refusalTally", () => {
  test('records the window at warning: its reason, its count, the instants of its first and latest refusals, and the opening event it closes as windowId', () => {
    const event = refusalTallyEvent({
      count: 3,
      firstSeenAt: OPENED_AT,
      lastSeenAt: OPENED_AT + 90_000,
      reason: 'expiredToken',
      windowId: WINDOW_ID,
    });

    assert.deepEqual(event, {
      data: {
        count: 3,
        firstSeenAt: '2026-11-18T09:00:00.000Z',
        lastSeenAt: '2026-11-18T09:01:30.000Z',
        reason: 'expiredToken',
        windowId: WINDOW_ID,
      },
      severity: 'warning',
      type: 'managementToken.refusalTally',
    });
  });

  test('leaves windowId out, never empty or null, for a window whose opening event did not commit', () => {
    const event = refusalTallyEvent({
      count: 1,
      firstSeenAt: OPENED_AT,
      lastSeenAt: OPENED_AT,
      reason: 'invalidSignature',
    });

    assert.deepEqual(event.data, {
      count: 1,
      firstSeenAt: '2026-11-18T09:00:00.000Z',
      lastSeenAt: '2026-11-18T09:00:00.000Z',
      reason: 'invalidSignature',
    });
  });
});
