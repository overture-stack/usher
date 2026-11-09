import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { refusalTallyEvent } from './refusalTallyEvent.js';

suite("a management credential refusal tally's event", () => {
  test('records a count of credentials that could not be read or verified as managementToken.refusalTally by its reason and count alone, at warning', () => {
    const events = [
      refusalTallyEvent('invalidSignature', 3),
      refusalTallyEvent('malformedCredential', 1),
    ];

    assert.deepEqual(events, [
      {
        data: { count: 3, reason: 'invalidSignature' },
        severity: 'warning',
        type: 'managementToken.refusalTally',
      },
      {
        data: { count: 1, reason: 'malformedCredential' },
        severity: 'warning',
        type: 'managementToken.refusalTally',
      },
    ]);
  });
});
