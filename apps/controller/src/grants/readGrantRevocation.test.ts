import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readGrantRevocation } from './readGrantRevocation.js';

const outcomeOf = (
  body: Readonly<Record<string, unknown>> | undefined,
): unknown => {
  const reading = readGrantRevocation(body);
  return reading.kind === 'refused'
    ? [reading.problem.status, reading.problem.code]
    : reading.input;
};

const GIVEN = [
  'accessNoLongerNeeded',
  'accessReview',
  'custodianRequest',
  'grantedInError',
  'holderLeftProject',
  'requestedByHolder',
  'termsViolation',
];

suite("reading a grant's revocation", () => {
  test('reads each reason a caller may give, and no body as the reason unspecified', () => {
    assert.deepEqual(
      [...GIVEN.map((reason) => outcomeOf({ reason })), outcomeOf(undefined)],
      [...GIVEN, 'unspecified'].map((reason) => ({ reason })),
    );
  });

  test('refuses 422 a reason the controller alone records, and any outside the vocabulary', () => {
    const refused = [
      'unspecified',
      'resourceRetired',
      'left the study',
      'AccessReview',
    ];

    assert.deepEqual(
      refused.map((reason) => outcomeOf({ reason })),
      refused.map(() => [422, 'unknownRevocationReason']),
    );
  });

  test('refuses 400 a body lacking its reason, holding another member, or a reason that is no string', () => {
    const unreadable = [
      {},
      { reason: 'accessReview', note: 'gone' },
      { reason: null },
      { reason: ['accessReview'] },
    ];

    assert.deepEqual(
      unreadable.map(outcomeOf),
      unreadable.map(() => [400, 'unreadableBody']),
    );
  });
});
