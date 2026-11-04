import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import fastCheck, { type Arbitrary } from 'fast-check';

import {
  CONDITION_RULES,
  fieldNamesReadBy,
  validateCategoryCondition,
} from './categoryCondition.js';
import {
  applicable,
  assertOwnDataCopy,
  assertRefusedWithOneOf,
  authoredConditionOf,
  canonicalOperatorOf,
  combinationEntries,
  type DataRecord,
  describedBy,
  EXCLUSION_SPELLINGS,
  type FilterSite,
  filterSites,
  FINITE_NUMBER,
  type GeneratedCondition,
  insertedAt,
  isDataRecord,
  literalTextOf,
  type Mutation,
  type NonEmptyList,
  oneOf,
  PATTERN_SPELLINGS,
  PLAIN_TEXT,
  replacedAt,
  siteAmong,
  spellingsOf,
  type TextArbitraries,
  withMember,
} from './propertySupport.js';
import { SPECIAL_VALUE_MARKERS } from './sqonPrimitives.js';
import { assertAccepted } from './testSupport.js';

const ALL_SPELLINGS = spellingsOf('all');

/** Conditions read fields drawn often from a few, so a condition reads one field more than once. */
const conditionOf = (text: TextArbitraries): Arbitrary<GeneratedCondition> =>
  authoredConditionOf(
    text,
    fastCheck.oneof(
      fastCheck.constantFrom('collection_date', 'data_category', 'donor_age'),
      text.nonEmpty,
    ),
  );

const conditionPosition = (path: readonly number[]): string =>
  `condition${path.map((index) => `.content[${index}]`).join('')}`;

const operatorAt = (site: FilterSite): string | undefined =>
  isDataRecord(site.node) ? canonicalOperatorOf(site.node['op']) : undefined;

const withClauseValue = (
  node: DataRecord,
  change: (value: unknown) => unknown,
): DataRecord => {
  const content = isDataRecord(node['content']) ? node['content'] : {};

  return withMember(
    node,
    'content',
    withMember(content, 'value', change(content['value'])),
  );
};

const specialValueOf = (text: TextArbitraries): Arbitrary<string> =>
  fastCheck
    .tuple(text.any, fastCheck.constantFrom(...SPECIAL_VALUE_MARKERS), text.any)
    .map(([before, marker, after]) => `${before}${marker}${after}`);

/**
 * Every way of placing an excluded operator, a marker value or a pivot in `condition`, one change
 * at a time.
 */
const mutationsOf = (
  condition: DataRecord,
  text: TextArbitraries,
): NonEmptyList<Arbitrary<Mutation>> => {
  const sites = filterSites(condition);
  const anySite =
    siteAmong(sites) ??
    fastCheck.constant<FilterSite>({
      holder: 'root',
      node: condition,
      path: [],
    });
  const leafSites = sites.filter(
    (site) => combinationEntries(site.node) === undefined,
  );
  const inSites = leafSites.filter((site) => operatorAt(site) === 'in');
  const rangeSites = leafSites.filter((site) => operatorAt(site) !== 'in');
  const literal = literalTextOf(text);
  const literalList = fastCheck.array(
    fastCheck.oneof(literal.nonEmpty, FINITE_NUMBER),
    { maxLength: 3, minLength: 1 },
  );
  const replacing = (
    kind: string,
    replacement: Arbitrary<DataRecord>,
    rule: string,
  ): Arbitrary<Mutation> =>
    fastCheck.tuple(anySite, replacement).map(([site, node]) => ({
      changed: replacedAt(condition, site.path, () => node),
      expected: [{ position: conditionPosition(site.path), rule }],
      kind,
    }));
  const changingNode = (
    kind: string,
    siteArbitrary: Arbitrary<FilterSite> | undefined,
    change: Arbitrary<(node: DataRecord) => DataRecord>,
    rule: string,
  ): Arbitrary<Mutation> | undefined =>
    siteArbitrary &&
    fastCheck.tuple(siteArbitrary, change).map(([site, apply]) => ({
      changed: replacedAt(condition, site.path, (node) =>
        isDataRecord(node) ? apply(node) : node,
      ),
      expected: [{ position: conditionPosition(site.path), rule }],
      kind,
    }));

  const mutations = applicable<Mutation>([
    replacing(
      'an exclusion in place of a node',
      fastCheck
        .tuple(
          fastCheck.constantFrom(...EXCLUSION_SPELLINGS),
          text.nonEmpty,
          fastCheck.oneof(literalList, literal.nonEmpty),
        )
        .map(([op, fieldName, value]) => ({
          content: { fieldName, value },
          op,
        })),
      CONDITION_RULES.exclusion,
    ),
    replacing(
      'a wildcard in place of a node',
      fastCheck
        .tuple(
          fastCheck.constantFrom(...PATTERN_SPELLINGS),
          fastCheck.array(text.nonEmpty, { maxLength: 3, minLength: 1 }),
          text.any,
        )
        .map(([op, fieldNames, value]) => ({
          content: { fieldNames, value },
          op,
        })),
      CONDITION_RULES.pattern,
    ),
    replacing(
      'an all in place of a node',
      fastCheck
        .tuple(
          fastCheck.constantFrom(...ALL_SPELLINGS),
          text.nonEmpty,
          literalList,
        )
        .map(([op, fieldName, value]) => ({
          content: { fieldName, value },
          op,
        })),
      CONDITION_RULES.all,
    ),
    changingNode(
      'a clause respelled as an exclusion',
      siteAmong(leafSites),
      fastCheck
        .constantFrom(...EXCLUSION_SPELLINGS)
        .map((op) => (node: DataRecord) => withMember(node, 'op', op)),
      CONDITION_RULES.exclusion,
    ),
    changingNode(
      'an in respelled as an all',
      siteAmong(inSites),
      fastCheck
        .constantFrom(...ALL_SPELLINGS)
        .map((op) => (node: DataRecord) => withMember(node, 'op', op)),
      CONDITION_RULES.all,
    ),
    changingNode(
      'a marker value added to an in',
      siteAmong(inSites),
      fastCheck.tuple(specialValueOf(text), fastCheck.nat()).map(
        ([special, index]) =>
          (node: DataRecord) =>
            withClauseValue(node, (value) =>
              insertedAt(
                Array.isArray(value) ? value : [value],
                index,
                special,
              ),
            ),
      ),
      CONDITION_RULES.literalValues,
    ),
    changingNode(
      'a marker value in place of a bound',
      siteAmong(rangeSites),
      fastCheck.tuple(specialValueOf(text), fastCheck.nat()).map(
        ([special, index]) =>
          (node: DataRecord) =>
            withClauseValue(node, (value) =>
              Array.isArray(value)
                ? value.map((bound, at) =>
                    at === index % value.length ? special : bound,
                  )
                : special,
            ),
      ),
      CONDITION_RULES.literalValues,
    ),
    changingNode(
      'a pivot on a node',
      anySite,
      fastCheck
        .oneof(
          fastCheck.constant(null),
          fastCheck.constant(undefined),
          text.any,
        )
        .map((pivot) => (node: DataRecord) => withMember(node, 'pivot', pivot)),
      CONDITION_RULES.pivot,
    ),
  ]);
  const [first, ...others] = mutations;

  if (first) {
    return [first, ...others];
  }

  throw new Error('no mutation applies to the condition');
};

const mutationOf = (text: TextArbitraries): Arbitrary<Mutation> =>
  conditionOf(text).chain(({ condition }) =>
    oneOf(mutationsOf(condition, text)).map(describedBy),
  );

suite('validateCategoryCondition, over generated values', () => {
  suite('the properties', () => {
    test('accepts every condition drawn from the grammar, returning a copy of its own data', () => {
      fastCheck.assert(
        fastCheck.property(conditionOf(PLAIN_TEXT), ({ condition }) => {
          const result = validateCategoryCondition(condition);

          assertAccepted(result);
          assertOwnDataCopy(result.success && result.condition, condition);
        }),
        { numRuns: 300 },
      );
    });

    test('reads exactly the fields each condition drawn from the grammar names, each once and sorted', () => {
      fastCheck.assert(
        fastCheck.property(
          conditionOf(PLAIN_TEXT),
          ({ condition, fieldNames }) => {
            const result = validateCategoryCondition(condition);

            const read = result.success
              ? fieldNamesReadBy(result.condition)
              : [];

            assert.deepEqual(read, [...new Set(fieldNames)].toSorted());
          },
        ),
        { numRuns: 300 },
      );
    });

    test('refuses an excluded operator or a marker value placed anywhere in a condition, for the rule it breaks', () => {
      fastCheck.assert(
        fastCheck.property(mutationOf(PLAIN_TEXT), ({ changed, expected }) => {
          assertRefusedWithOneOf(validateCategoryCondition(changed), expected);
        }),
        { numRuns: 600 },
      );
    });
  });
});
