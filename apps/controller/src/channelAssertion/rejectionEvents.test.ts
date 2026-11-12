import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { rejectionEvent, rejectionTallyEvent } from './rejectionEvents.js';

suite("a refused channel assertion's events", () => {
  test("records a verified assertion refused anyway as channelAssertion.rejection, denied, by its reason, its application and the request's address, at warning", () => {
    const applicationId = randomUUID();

    const events = [
      rejectionEvent({
        applicationId,
        reason: 'notYetValid',
        sourceIp: '192.0.2.10',
      }),
      rejectionEvent({
        applicationId,
        reason: 'reusedAssertion',
        sourceIp: '2001:db8::10',
      }),
    ];

    assert.deepEqual(events, [
      {
        data: {
          applicationId,
          reason: 'notYetValid',
          result: 'denied',
          sourceIp: '192.0.2.10',
        },
        severity: 'warning',
        type: 'channelAssertion.rejection',
      },
      {
        data: {
          applicationId,
          reason: 'reusedAssertion',
          result: 'denied',
          sourceIp: '2001:db8::10',
        },
        severity: 'warning',
        type: 'channelAssertion.rejection',
      },
    ]);
  });

  test('records a count of refusals not recorded one by one as channelAssertion.rejectionTally by its reason and count, naming an application only when one is registered, at warning', () => {
    const applicationId = randomUUID();

    const events = [
      rejectionTallyEvent('noLiveKey', applicationId, 3),
      rejectionTallyEvent('missingAssertion', undefined, 1),
      rejectionTallyEvent('expiredAssertion', applicationId, 2),
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
      {
        data: { applicationId, count: 2, reason: 'expiredAssertion' },
        severity: 'warning',
        type: 'channelAssertion.rejectionTally',
      },
    ]);
  });
});
