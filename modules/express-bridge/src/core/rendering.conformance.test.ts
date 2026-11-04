import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import {
  type Enforcement,
  type PermissionsPayload,
  validatePayload,
  validateRegistration,
} from '@overture-stack/usher-types';

// Read from usher-types' source by path: the evaluator is test-only, so no package exports it.
import {
  type EvaluatedRecord,
  matchesSqon,
} from '../../../types/src/sqonEvaluator.js';

import { CONFIGURATION_DEFAULTS } from './configuration.js';
import { compileKey, renderKey } from './rendering.js';

/** One record of an expectations case. */
interface ExpectedRecord {
  fields: EvaluatedRecord;
  outcome: string;
  reason: string;
}

/**
 * One case of `expectations.json`. `principalId` names the principals.json entry supplying its
 * payload.
 */
interface ExpectationCase {
  keyRegistration: unknown;
  principalId: string;
  records: readonly ExpectedRecord[];
}

const conformanceFile = (fileName: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../.dev/design/conformance/${fileName}`,
        import.meta.url,
      ),
      'utf8',
    ),
  );

const { principals } = conformanceFile('principals.json') as {
  principals: readonly {
    id: string;
    implementable?: unknown;
    payload?: unknown;
  }[];
};

const expectations = conformanceFile('expectations.json') as {
  cases: readonly ExpectationCase[];
  formatVersion: unknown;
};

type Outcome = 'denied' | 'served' | 'withheld';

const OUTCOMES: ReadonlySet<string> = new Set<Outcome>([
  'denied',
  'served',
  'withheld',
]);

/**
 * The payload of the principals.json entry named, validated. An entry marked not implementable fails
 * rather than skips: a case holding expectations is asserted, and a skip would let the flag switch
 * an assertion off with nothing announcing it.
 */
const payloadFor = (principalId: string): PermissionsPayload => {
  const principal = principals.find(({ id }) => id === principalId);

  assert.ok(principal, `principals.json holds ${principalId}`);
  assert.equal(
    principal.implementable ?? true,
    true,
    `${principalId} holds expectations, so principals.json does not mark it not implementable`,
  );

  const validated = validatePayload(principal.payload);

  if (validated.success) {
    return validated.payload;
  }

  return assert.fail(
    `${principalId}'s payload is refused: ${JSON.stringify(validated.problems)}`,
  );
};

const enforcementFor = ({
  keyRegistration,
  principalId,
}: ExpectationCase): Enforcement => {
  const payload = payloadFor(principalId);
  const validated = validateRegistration(keyRegistration);

  if (validated.success) {
    return renderKey(
      payload,
      compileKey(validated.registration),
      CONFIGURATION_DEFAULTS.filterClauseLimit,
    ).enforcement;
  }

  return assert.fail(
    `${principalId}'s key registration is refused: ${JSON.stringify(validated.problems)}`,
  );
};

/**
 * A deny refuses the whole catalogue, so it is `denied` and never `withheld`: a refusal and a
 * narrowing that leaves the record out are different answers.
 */
const outcomeOf = (
  enforcement: Enforcement,
  record: EvaluatedRecord,
): Outcome => {
  switch (enforcement.kind) {
    case 'allow':
      return 'served';
    case 'deny':
      return 'denied';
    case 'narrow':
      return matchesSqon(enforcement.sqon, record) ? 'served' : 'withheld';
  }
};

suite('the conformance expectations', () => {
  test('are written in the format this suite reads, holding at least one case and a record in each', () => {
    assert.equal(expectations.formatVersion, 1);
    assert.ok(expectations.cases.length > 0);
    assert.ok(expectations.cases.every(({ records }) => records.length > 0));
  });

  for (const expectationCase of expectations.cases) {
    suite(expectationCase.principalId, () => {
      for (const [index, record] of expectationCase.records.entries()) {
        test(`record ${index + 1} is ${record.outcome}: ${record.reason}`, () => {
          assert.ok(
            OUTCOMES.has(record.outcome),
            'the outcome is served, withheld or denied',
          );
          assert.equal(
            outcomeOf(enforcementFor(expectationCase), record.fields),
            record.outcome,
          );
        });
      }
    });
  }
});
