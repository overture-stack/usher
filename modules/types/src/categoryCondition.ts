import {
  checkSqonDepth,
  isFieldFilter,
  isGroupNode,
  SQON_MAX_DEPTH,
  type SqonCanonicalOp,
  type SqonNode,
  SqonSchema,
} from '@overture-stack/sqon';

import type { NonEmpty } from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownMember,
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  type ValidationProblem,
} from './problems.js';
import {
  canonicalOperatorOf,
  isBound,
  isFixedValue,
  isLiteralValue,
} from './sqonPrimitives.js';

/**
 * A category's condition as authored in a catalogue's category mapping: a SQON node held to the
 * grammar checked by {@link validateCategoryCondition}. A record carries the category exactly when
 * it matches the condition, and a field equal to a value is the simplest form. Its values are
 * fixed: date math is refused, since a condition holding it would move records between categories
 * as time passes. A date value matches by the span it names:
 * - an `in` value of `2024-03-15` matches any instant that day;
 * - a date-only bound is its whole day, included by `gte` and `lte` and excluded by `gt` and `lt`,
 *   so a `between` covers whole days at both ends;
 * - a bound given to the minute is filled to the end of that minute when rounding up.
 *
 * A `between` orders string bounds by code unit, so two dates written in different forms or offsets
 * can be refused as out of order.
 */
export type CategoryCondition = SqonNode;

/**
 * The result of {@link validateCategoryCondition}: a copy of the condition's own data, typed, when
 * it holds to the grammar, and otherwise every problem found, each value-free.
 */
export type CategoryConditionValidationResult =
  | { condition: CategoryCondition; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/**
 * The wording of every rule held by {@link validateCategoryCondition}, keyed by a stable name, to
 * match against each problem's `rule`.
 */
export const CONDITION_RULES = {
  all: 'a condition holds no all: requiring several values of one field is written as an and of in clauses',
  betweenBounds:
    'a between holds a list of exactly two bounds, each a finite number or a non-empty string',
  betweenOrder:
    'a between holds two bounds of one kind, two numbers or two strings, lowest first, strings compared by code unit',
  clauseMembers: 'a clause carries only fieldName and value',
  contentIsList: 'an and, an or or a not holds its conditions in a list',
  depth:
    'a condition nests no deeper than SQON allows once placed in the narrowing rendered from it',
  exclusion:
    'a condition holds no exclusion operator: excluding a value is written as a not around an in',
  fixedValues:
    "a condition's values are fixed, never date math such as now or an expression anchored with ||",
  groupNotEmpty:
    'an and or an or holds at least one condition, since an empty group matches every record',
  inValueKinds:
    'each value listed by an in clause is a finite number or a non-empty string',
  inValueList: 'an in clause lists its values in a non-empty list',
  inValuesDistinct: 'an in clause names each value once',
  literalValues:
    'a condition names literal values, never one read specially by Arranger: a * pattern, a set_id: reference or __missing__',
  namesField: 'a clause names its field as a non-empty fieldName',
  nodeIsMap: 'every node of a condition is a map',
  nodeMembers: 'a condition node carries only op and content',
  notHoldsOne: 'a not holds exactly one condition',
  openRangeBound:
    'a gt, gte, lt or lte holds one bound, a finite number or a non-empty string, never a list',
  operator: 'a condition uses only operators defined by SQON',
  pattern: 'a condition matches values as listed, never by a wildcard pattern',
  pivot: 'a condition carries no pivot',
  validSqon: 'a condition is a valid SQON',
} as const;

/**
 * The deepest wrapping, in nodes, placed around an authored condition by a rendered record
 * narrowing: on the path from the root `and`, the unmarked clause's `not` and `and`, the `not`
 * around its `or`, that `or`, the `and` testing that each lacking resource carries one of its own
 * categories, and one resource's `or`, which holds the condition.
 */
export const RENDERED_WRAPPING_NODES = 7;

/**
 * How deep an authored condition may nest, in JSON levels as `checkSqonDepth` counts them, so the
 * narrowing rendered around it stays within `SQON_MAX_DEPTH`: each wrapping node adds two levels,
 * the node and its content list.
 */
const AUTHORED_DEPTH_LIMIT = SQON_MAX_DEPTH - 2 * RENDERED_WRAPPING_NODES;

type Rule = readonly [holds: boolean, rule: string];

/**
 * The problems with one node, given its content, under the rules of the operator it is registered
 * for.
 */
type OperatorCheck = (
  position: string,
  content: unknown,
  depth: number,
) => readonly ValidationProblem[];

/** `pivot` is held by a rule of its own, so a condition carrying one is told why. */
const NODE_MEMBERS: ReadonlySet<string> = new Set(['content', 'op', 'pivot']);

const CLAUSE_MEMBERS: ReadonlySet<string> = new Set(['fieldName', 'value']);

const CONDITION_POSITION = 'condition';

const isListableValue = isBound;

const hasNoRepeats = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

const inValueRules = (value: unknown): readonly Rule[] => {
  const values = listEntries(value);
  const listed = values ?? [value];

  return [
    [values !== undefined && values.length > 0, CONDITION_RULES.inValueList],
    [hasNoRepeats(listed), CONDITION_RULES.inValuesDistinct],
    [listed.every(isListableValue), CONDITION_RULES.inValueKinds],
    [listed.every(isLiteralValue), CONDITION_RULES.literalValues],
    [listed.every(isFixedValue), CONDITION_RULES.fixedValues],
  ];
};

const openRangeRules = (value: unknown): readonly Rule[] => [
  [isBound(value), CONDITION_RULES.openRangeBound],
  [isLiteralValue(value), CONDITION_RULES.literalValues],
  [isFixedValue(value), CONDITION_RULES.fixedValues],
];

/**
 * Whether two usable bounds can bound anything: a pair mixing a number with a string, or two bounds
 * highest first, matches no record, so the category it defines would be carried by none. Strings are
 * compared by code unit, which is how Arranger orders a between's bounds before sending it, so the
 * bounds written by the author are the ones sent.
 */
const isOrderedPair = ([low, high]: readonly unknown[]): boolean =>
  (typeof low === 'number' && typeof high === 'number') ||
  (typeof low === 'string' && typeof high === 'string')
    ? low <= high
    : false;

const betweenRules = (value: unknown): readonly Rule[] => {
  const bounds = listEntries(value);
  const pair =
    bounds !== undefined && bounds.length === 2 && bounds.every(isBound)
      ? bounds
      : undefined;
  const listed = bounds ?? [value];

  return [
    [pair !== undefined, CONDITION_RULES.betweenBounds],
    [pair ? isOrderedPair(pair) : true, CONDITION_RULES.betweenOrder],
    [listed.every(isLiteralValue), CONDITION_RULES.literalValues],
    [listed.every(isFixedValue), CONDITION_RULES.fixedValues],
  ];
};

const clauseCheck =
  (valueRules: (value: unknown) => readonly Rule[]): OperatorCheck =>
  (position, content) => {
    if (isPlainRecord(content)) {
      return brokenRules(position, [
        [
          isNonEmptyString(ownMember(content, 'fieldName')),
          CONDITION_RULES.namesField,
        ],
        [
          hasOnlyMembers(content, CLAUSE_MEMBERS),
          CONDITION_RULES.clauseMembers,
        ],
        ...valueRules(ownMember(content, 'value')),
      ]);
    }

    return [{ position, rule: CONDITION_RULES.namesField }];
  };

const combinationCheck =
  (holdsCount: (count: number) => boolean, countRule: string): OperatorCheck =>
  (position, content, depth) => {
    const entries = listEntries(content);

    if (entries !== undefined) {
      return [
        ...brokenRules(position, [[holdsCount(entries.length), countRule]]),
        ...entries.flatMap((entry, index) =>
          problemsAt(entry, `${position}.content[${index}]`, depth + 1),
        ),
      ];
    }

    return [{ position, rule: CONDITION_RULES.contentIsList }];
  };

const refusedAs =
  (rule: string): OperatorCheck =>
  (position) => [{ position, rule }];

const holdsAtLeastOne = (count: number): boolean => count > 0;

/**
 * Each canonical operator's check, looked up through a `Map` so an inherited name is never an
 * operator. Typed over every canonical operator, so an operator added to SQON fails the typecheck
 * until it has a check here.
 */
const OPERATOR_CHECKS: ReadonlyMap<string, OperatorCheck> = new Map(
  Object.entries({
    all: refusedAs(CONDITION_RULES.all),
    and: combinationCheck(holdsAtLeastOne, CONDITION_RULES.groupNotEmpty),
    between: clauseCheck(betweenRules),
    gt: clauseCheck(openRangeRules),
    gte: clauseCheck(openRangeRules),
    in: clauseCheck(inValueRules),
    lt: clauseCheck(openRangeRules),
    lte: clauseCheck(openRangeRules),
    not: combinationCheck((count) => count === 1, CONDITION_RULES.notHoldsOne),
    'not-in': refusedAs(CONDITION_RULES.exclusion),
    or: combinationCheck(holdsAtLeastOne, CONDITION_RULES.groupNotEmpty),
    'some-not-in': refusedAs(CONDITION_RULES.exclusion),
    wildcard: refusedAs(CONDITION_RULES.pattern),
  } satisfies Readonly<Record<SqonCanonicalOp, OperatorCheck>>),
);

const nodeProblems = (
  node: Readonly<Record<string, unknown>>,
  position: string,
  depth: number,
): readonly ValidationProblem[] => {
  const operator = canonicalOperatorOf(ownMember(node, 'op'));
  const check =
    operator === undefined ? undefined : OPERATOR_CHECKS.get(operator);

  return [
    ...brokenRules(position, [
      [hasOnlyMembers(node, NODE_MEMBERS), CONDITION_RULES.nodeMembers],
      [!Object.hasOwn(node, 'pivot'), CONDITION_RULES.pivot],
    ]),
    ...(check
      ? check(position, ownMember(node, 'content'), depth)
      : [{ position, rule: CONDITION_RULES.operator }]),
  ];
};

/**
 * The depth limit is `SqonSchema`'s own, counted here in nodes rather than in JSON levels, as the
 * narrowing's walk counts it. It guards the recursion: a condition within the authored limit never
 * reaches it, and recursion stays far inside the stack.
 */
const problemsAt = (
  node: unknown,
  position: string,
  depth: number,
): readonly ValidationProblem[] => {
  const withinDepth = depth <= SQON_MAX_DEPTH;

  if (withinDepth && isPlainRecord(node)) {
    return nodeProblems(node, position, depth);
  }

  return [
    {
      position,
      rule: withinDepth ? CONDITION_RULES.nodeIsMap : CONDITION_RULES.depth,
    },
  ];
};

// Exported so tests can reach refusals otherwise made first by `SqonSchema`, such as an unknown
// operator. The package root does not export it.
/**
 * The problems found in `condition` by the structural walk alone, without `SqonSchema` or the
 * authored depth limit, positioned from `position`. It takes no snapshot: `condition` is read
 * directly, so a getter in it runs and an error it throws is not caught.
 *
 * @param position the value-free position of the condition itself.
 * @internal
 */
export const conditionWalkProblems = (
  condition: unknown,
  position: string,
): readonly ValidationProblem[] => problemsAt(condition, position, 0);

/**
 * The problems with a category's condition under the rules of {@link validateCategoryCondition},
 * positioned from `position`. Unlike that validator, it takes no snapshot: `condition` is read
 * directly, so a getter in it runs and an error it throws is not caught. No problem quotes the
 * condition, even when `SqonSchema` refuses it.
 *
 * @param position the value-free position of the condition itself.
 */
export const categoryConditionProblems = (
  condition: unknown,
  position: string,
): readonly ValidationProblem[] => {
  // SqonSchema's issues are never passed on, since they can quote the condition.
  if (SqonSchema.safeParse(condition).success) {
    return checkSqonDepth(condition, AUTHORED_DEPTH_LIMIT)
      ? conditionWalkProblems(condition, position)
      : [{ position, rule: CONDITION_RULES.depth }];
  }

  return [{ position, rule: CONDITION_RULES.validSqon }];
};

/**
 * Validates a category's condition as authored, never throwing, whatever `value` is. The condition
 * is accepted only when:
 * - it passes `SqonSchema` and nests no deeper than `SQON_MAX_DEPTH` less two JSON levels for each
 *   of {@link RENDERED_WRAPPING_NODES}, leaving room for the record narrowing rendered around it;
 * - every node, at any depth, is a map carrying only `op` and `content`, never a `pivot`;
 * - every `and` or `or` holds a list of at least one condition, and every `not` a list of exactly
 *   one;
 * - every clause names its field by a non-empty `fieldName` and carries only `fieldName` and
 *   `value`;
 * - every `in` lists distinct values, at least one, each a finite number or a non-empty string;
 * - every `gt`, `gte`, `lt` or `lte` holds one bound, a finite number or a non-empty string, never a
 *   list, and every `between` a list of two such bounds, both numbers or both strings, lowest
 *   first, strings compared by code unit;
 * - no value is date math, such as `now`, `now-1y` or an expression anchored with `||`;
 * - no value holds a marker read specially by Arranger;
 * - no clause is a wildcard pattern, an exclusion of any kind or an `all`, each refused by a rule of
 *   its own.
 *
 * Operators are read through `SQON_OP_ALIASES` first, so `=` is an `in` and `!=` an exclusion.
 * Problems are positioned from `condition`.
 *
 * @param value a condition, untrusted.
 * @returns a copy of the condition's own data, typed, which is exactly what was checked, or every
 *   problem found, none naming a field or a value of the condition.
 */
export const validateCategoryCondition = (
  value: unknown,
): CategoryConditionValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, (condition) =>
    categoryConditionProblems(condition, CONDITION_POSITION),
  );

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { condition: snapshot as CategoryCondition, success: true };
};

const fieldNamesIn = (node: SqonNode): readonly string[] => {
  if (isGroupNode(node)) {
    return node.content.flatMap(fieldNamesIn);
  }

  if (isFieldFilter(node)) {
    return [node.content.fieldName];
  }

  return [];
};

/**
 * The distinct field names read by `condition`, sorted by code unit, so the order never depends on
 * a locale. It assumes a condition accepted by {@link validateCategoryCondition} and checks
 * nothing, so a condition refused by that validator can give any answer.
 */
export const fieldNamesReadBy = (
  condition: CategoryCondition,
): readonly string[] => [...new Set(fieldNamesIn(condition))].toSorted();

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const withSortedKeys = (_key: string, value: unknown): unknown =>
  isPlainRecord(value)
    ? Object.fromEntries(
        Object.entries(value).toSorted(([left], [right]) =>
          compareCodeUnits(left, right),
        ),
      )
    : value;

/**
 * `condition` through a JSON round trip with the keys of every node sorted by code unit, so neither
 * the order its keys were written in nor `-0` reaches the result, and two equal conditions serialize
 * to the same text. The result is a copy sharing no object with `condition`.
 *
 * @param condition a condition accepted by {@link validateCategoryCondition}, which is JSON data.
 */
export const normalizedCondition = (
  condition: CategoryCondition,
): CategoryCondition => {
  const normalized: unknown = JSON.parse(
    JSON.stringify(condition, withSortedKeys),
  );

  // A JSON round trip of a SQON node, with only its keys reordered, is a SQON node of the same
  // shape.
  return normalized as CategoryCondition;
};
