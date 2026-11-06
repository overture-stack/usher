import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { rejectionEvent, rejectionTallyEvent } from './rejectionEvents.js';

suite("a refused channel assertion's events", () => {
  test('records a verified assertion refused anyway as channelAssertion.rejection by its reason and its application, at warning', () => {
    const applicationId = randomUUID();

    const events = [
      rejectionEvent('notYetValid', applicationId),
      rejectionEvent('reusedAssertion', applicationId),
    ];

    assert.deepEqual(events, [
      {
        data: { applicationId, reason: 'notYetValid' },
        severity: 'warning',
        type: 'channelAssertion.rejection',
      },
      {
        data: { applicationId, reason: 'reusedAssertion' },
        severity: 'warning',
        type: 'channelAssertion.rejection',
      },
    ]);
  });

  test('records a count of unverified refusals as channelAssertion.rejectionTally by its reason and count, naming an application only when one is registered, at warning', () => {
    const applicationId = randomUUID();

    const events = [
      rejectionTallyEvent('noLiveKey', applicationId, 3),
      rejectionTallyEvent('missingAssertion', undefined, 1),
    ];

    assert.deepEqual(events, [
      {
        data: { applicationId, count: 3, reason: 'noLiveKey' },
        severity: 'warning',
        type: 'channelAssertion.rejectionTally',
      },
      {
        data: { count: 1, reason: 'missingAssertion' },
        severity: 'warning',
        type: 'channelAssertion.rejectionTally',
      },
    ]);
  });
});
