import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
  type PermissionsPayload,
  validatePayload,
} from '@overture-stack/usher-types';

import { grantSet, holdsOnlyOpenTier } from './grants.js';

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../.dev/design/conformance/principals.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { principals: readonly { case: string; payload: unknown }[] };

const payloadFor = (caseNumber: string): PermissionsPayload => {
  const entry = corpus.principals.find(
    (principal) => principal.case === caseNumber,
  );
  const result = validatePayload(entry?.payload);
  assert.ok(result.success, `case ${caseNumber} is a valid payload`);
  return result.payload;
};

const ANONYMOUS_GRANTS = grantSet(payloadFor('02').permissions);

suite('holdsOnlyOpenTier', () => {
  for (const [caseNumber, expected, holding] of [
    ['03', true, 'nothing beyond the anonymous payload'],
    ['04', true, 'nothing beyond the anonymous payload'],
    ['05', false, "HEART_STUDY's controlled records"],
    ['24', false, 'a field partition, which is a restriction and not an extra'],
    ['24b', false, 'a field partition naming the clinician columns'],
    ['26', false, 'revision.view'],
    ['27', false, 'artifact.create'],
    ['30', false, 'the registered tier'],
  ] as const) {
    test(`gives case ${caseNumber}, holding ${holding}, ${expected}`, () => {
      assert.equal(
        holdsOnlyOpenTier(payloadFor(caseNumber), ANONYMOUS_GRANTS),
        expected,
      );
    });
  }

  test('gives the anonymous payload itself true', () => {
    assert.equal(holdsOnlyOpenTier(payloadFor('02'), ANONYMOUS_GRANTS), true);
  });

  test('gives false when no anonymous grant set is held to compare with', () => {
    assert.equal(holdsOnlyOpenTier(payloadFor('03'), undefined), false);
  });

  suite('a record grant under a field partition', () => {
    const holding = (
      permissions: PermissionsPayload['permissions'],
    ): PermissionsPayload => ({ ...payloadFor('02'), permissions });
    const partitioned = grantSet({
      HEART_STUDY: {
        'global.unmarked': {
          field: { 'global.basic': ['view'] },
          record: ['view'],
        },
      },
    });

    test('gives false for whole records where the anonymous payload reaches them only through a field partition', () => {
      const principal = holding({
        HEART_STUDY: { 'global.unmarked': { record: ['view'] } },
      });

      assert.equal(holdsOnlyOpenTier(principal, partitioned), false);
    });

    test('gives true for the same field partition the anonymous payload holds', () => {
      const principal = holding({
        HEART_STUDY: {
          'global.unmarked': {
            field: { 'global.basic': ['view'] },
            record: ['view'],
          },
        },
      });

      assert.equal(holdsOnlyOpenTier(principal, partitioned), true);
    });
  });

  test('tells a resource name holding a separator apart from two shorter names', () => {
    const joined = grantSet({
      'A,B': { 'global.unmarked': { record: ['view'] } },
    });
    const parted = grantSet({
      A: { 'B,global.unmarked': { record: ['view'] } },
    } as unknown as PermissionsPayload['permissions']);

    assert.equal(
      [...joined].some((grant) => parted.has(grant)),
      false,
    );
  });
});
