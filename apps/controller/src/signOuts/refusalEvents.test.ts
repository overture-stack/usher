import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  logoutTokenRefusalEvent,
  logoutTokenRefusalTallyEvent,
} from './refusalEvents.js';

suite("a refused logout token's events", () => {
  test('records a verified token refused anyway at warning, naming its reason, the request and the subject it names as refusedSubject', () => {
    const event = logoutTokenRefusalEvent({
      reason: 'otherAudience',
      sourceIp: '192.0.2.10',
      subject: 'subject-ana',
    });

    assert.deepEqual(event, {
      data: {
        reason: 'otherAudience',
        result: 'denied',
        refusedSubject: 'subject-ana',
        sourceIp: '192.0.2.10',
      },
      severity: 'warning',
      type: 'logoutToken.refusal',
    });
  });

  test('leaves the subject out, never empty or null, for a token naming none it may name', () => {
    const event = logoutTokenRefusalEvent({
      reason: 'namesNoOne',
      sourceIp: '192.0.2.10',
      subject: undefined,
    });

    assert.deepEqual(event.data, {
      reason: 'namesNoOne',
      result: 'denied',
      sourceIp: '192.0.2.10',
    });
  });

  test("records one interval's count of tokens that could not be verified at warning, by reason alone", () => {
    const event = logoutTokenRefusalTallyEvent('invalidSignature', 3);

    assert.deepEqual(event, {
      data: { count: 3, reason: 'invalidSignature' },
      severity: 'warning',
      type: 'logoutToken.refusalTally',
    });
  });
});
