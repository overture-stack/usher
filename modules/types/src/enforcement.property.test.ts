import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import fastCheck, { type Arbitrary } from 'fast-check';

import { ENFORCEMENT_RULES, validateEnforcement } from './enforcement.js';
import { READ_RULE } from './problems.js';
import {
  assertOwnDataCopy,
  assertRefusedWithOneOf,
  type DataRecord,
  describedBy,
  enforcementMutationsOf,
  enforcementOf,
  EXCLUSION_SPELLINGS,
  filterArbitraries,
  filterMutationsOf,
  filterSites,
  IN_SPELLINGS,
  isDataRecord,
  type Mutation,
  oneOf,
  PATTERN_SPELLINGS,
  PLAIN_TEXT,
  replacedAt,
  siteAmong,
  type TextArbitraries,
} from './propertySupport.js';
import { assertCarriesNoInput } from './testSupport.js';

const filters = filterArbitraries(PLAIN_TEXT);

const narrowing = (sqon: unknown): DataRecord => ({ kind: 'narrow', sqon });

const filterMutationOf = (text: TextArbitraries): Arbitrary<Mutation> =>
  filterArbitraries(text).filter.chain((filter) =>
    oneOf(filterMutationsOf(filter, text)).map((mutation) =>
      describedBy({ ...mutation, changed: narrowing(mutation.changed) }),
    ),
  );

const enforcementMutationOf = (text: TextArbitraries): Arbitrary<Mutation> =>
  enforcementOf(filterArbitraries(text)).chain((enforcement) =>
    oneOf(enforcementMutationsOf(enforcement, text)).map(describedBy),
  );

suite('validateEnforcement, over generated values', () => {
  suite('the properties', () => {
    test('accepts every generated narrowing, returning a copy of its own data', () => {
      fastCheck.assert(
        fastCheck.property(enforcementOf(filters), (enforcement) => {
          const result = validateEnforcement(enforcement);

          assert.equal(result.success, true, 'a valid result is accepted');
          assertOwnDataCopy(result.success && result.enforcement, enforcement);
        }),
        { numRuns: 300 },
      );
    });

    test('refuses every single forbidden change to a narrowing filter, for the rule it breaks', () => {
      fastCheck.assert(
        fastCheck.property(
          filterMutationOf(PLAIN_TEXT),
          ({ changed, expected }) => {
            assertRefusedWithOneOf(validateEnforcement(changed), expected);
          },
        ),
        { numRuns: 600 },
      );
    });

    test('refuses every single forbidden change to an enforcement result of any kind', () => {
      fastCheck.assert(
        fastCheck.property(
          enforcementMutationOf(PLAIN_TEXT),
          ({ changed, expected }) => {
            assertRefusedWithOneOf(validateEnforcement(changed), expected);
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
