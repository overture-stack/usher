import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  isSqonOpAlias,
  normalizeSqonOp,
  SQON_COMBINATION_OPS,
  SQON_FIELD_OPS,
  SQON_OP_ALIASES,
  type SqonAcceptedOp,
  type SqonCanonicalOp,
  type SqonFieldOp,
} from '@overture-stack/sqon';
import fastCheck, { type Arbitrary } from 'fast-check';

import { ENFORCEMENT_RULES, type Enforcement } from './enforcement.js';
import { READ_RULE, ROOT_POSITION } from './problems.js';
import { isFixedValue, SPECIAL_VALUE_MARKERS } from './sqonPrimitives.js';
import { LEAK_MARKER } from './testSupport.js';

/** A read-only map from string keys to values of any kind. */
export type DataRecord = Readonly<Record<string, unknown>>;

/** A read-only list holding at least one element. */
export type NonEmptyList<Element> = readonly [Element, ...Element[]];

/** A problem expected in a validator's result. */
export interface ExpectedProblem {
  position: string;
  rule: string;
}

/**
 * Whether `value` is an object other than `null` or a list. Its prototype is not checked, so a class
 * instance or a proxy counts.
 */
export const isDataRecord = (value: unknown): value is DataRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A copy of `record`'s own enumerable members with `key` set to `value`. An existing key keeps its
 * position and a new one comes last; `__proto__` becomes an own member like any other key.
 */
export const withMember = (
  record: DataRecord,
  key: string,
  value: unknown,
): DataRecord => ({ ...record, [key]: value });

/** A copy of `record`'s own enumerable members without `key`, or of all of them when it has none. */
export const withoutMember = (record: DataRecord, key: string): DataRecord =>
  Object.fromEntries(
    Object.entries(record).filter(([existing]) => existing !== key),
  );

/**
 * A copy of `record`'s own enumerable members with the member at `from` renamed `to`, in the same
 * position. A record without `from` is copied unchanged. When `to` already names another member, the
 * two collapse into one key, at the earlier position and holding the later value.
 */
export const withRenamedMember = (
  record: DataRecord,
  from: string,
  to: string,
): DataRecord =>
  Object.fromEntries(
    Object.entries(record).map(([existing, member]) => [
      existing === from ? to : existing,
      member,
    ]),
  );

/**
 * A copy of `list` with `item` inserted before the entry at `index`. The index is taken modulo one
 * more than the list's length, so any natural number names a position, the end of the list included.
 */
export const insertedAt = <Element>(
  list: readonly Element[],
  index: number,
  item: Element,
): readonly Element[] => {
  const at = index % (list.length + 1);

  return [...list.slice(0, at), item, ...list.slice(at)];
};

/** `key`, with `~` appended as many times as it takes to name nothing in `taken`. */
export const freshKey = (taken: ReadonlySet<string>, key: string): string =>
  taken.has(key) ? freshKey(taken, `${key}~`) : key;

/**
 * An arbitrary choosing one of `sites`, shrinking towards the first, or `undefined` when `sites` is
 * empty.
 */
export const siteAmong = <Site>(
  sites: readonly Site[],
): Arbitrary<Site> | undefined => {
  const [first, ...others] = sites;

  return first === undefined
    ? undefined
    : fastCheck.constantFrom(first, ...others);
};

/** The arbitraries given, without the `undefined` entries. */
export const applicable = <Value>(
  arbitraries: readonly (Arbitrary<Value> | undefined)[],
): readonly Arbitrary<Value>[] =>
  arbitraries.filter(
    (arbitrary): arbitrary is Arbitrary<Value> => arbitrary !== undefined,
  );

const nonEmptyOr = <Element>(
  list: readonly Element[],
  failure: string,
): NonEmptyList<Element> => {
  const [first, ...others] = list;

  if (first !== undefined) {
    return [first, ...others];
  }

  throw new Error(failure);
};

/**
 * An arbitrary drawing from one of `arbitraries`, as `fastCheck.oneof` does. Throws an `Error` when
 * `arbitraries` is empty.
 */
export const oneOf = <Value>(
  arbitraries: readonly Arbitrary<Value>[],
): Arbitrary<Value> =>
  fastCheck.oneof(
    ...nonEmptyOr(arbitraries, 'oneOf needs at least one arbitrary'),
  );

/** One way a member can be missing or misshapen, as applied by {@link withAbsentMember}. */
export type Absence =
  | 'deleted'
  | 'undefined'
  | 'null'
  | 'empty string'
  | 'empty list'
  | 'wrong type';

/** Every {@link Absence}. */
export const ABSENCES: readonly Absence[] = [
  'deleted',
  'undefined',
  'null',
  'empty string',
  'empty list',
  'wrong type',
];

/**
 * A copy of `record` with the member at `key` made absent in the way named by `absence`:
 * - `deleted`: the member is removed;
 * - `undefined`, `null`, `empty string`, `empty list`: the member holds `undefined`, `null`, `''` or
 *   `[]`;
 * - `wrong type`: the member holds `wrongType`, which is read by no other absence.
 */
export const withAbsentMember = (
  record: DataRecord,
  key: string,
  absence: Absence,
  wrongType: unknown,
): DataRecord => {
  const values: Readonly<Record<Exclude<Absence, 'deleted'>, unknown>> = {
    'empty list': [],
    'empty string': '',
    null: null,
    undefined,
    'wrong type': wrongType,
  };

  return absence === 'deleted'
    ? withoutMember(record, key)
    : withMember(record, key, values[absence]);
};

/**
 * Names of members inherited from `Object.prototype`, found on any record by a lookup through `in`
 * or a plain object.
 */
export const PROTOTYPE_MEMBER_NAMES: NonEmptyList<string> = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'toString',
  'valueOf',
  '__defineGetter__',
];

/** A source of strings: `any` may draw the empty string, and `nonEmpty` never does. */
export interface TextArbitraries {
  any: Arbitrary<string>;
  nonEmpty: Arbitrary<string>;
}

const unicodeText = (minLength: number): Arbitrary<string> =>
  fastCheck.oneof(
    fastCheck.string({ minLength, unit: 'grapheme' }),
    fastCheck.string({ minLength, unit: 'binary' }),
  );

/**
 * Unicode text drawn by grapheme or by code unit, lone surrogates included, and the names in
 * {@link PROTOTYPE_MEMBER_NAMES}.
 */
export const PLAIN_TEXT: TextArbitraries = {
  any: fastCheck.oneof(
    unicodeText(0),
    fastCheck.constantFrom(...PROTOTYPE_MEMBER_NAMES),
  ),
  nonEmpty: fastCheck.oneof(
    unicodeText(1),
    fastCheck.constantFrom(...PROTOTYPE_MEMBER_NAMES),
  ),
};

/** `key`, with `~` appended when it is `__proto__`, so it can name an own member of a literal. */
export const usableKey = (key: string): string =>
  key === '__proto__' ? `${key}~` : key;

/**
 * `text` with every marker in `SPECIAL_VALUE_MARKERS` removed, any marker formed by joining the text
 * around a removed one included, so the result holds none.
 */
export const withoutSpecialMarkers = (text: string): string =>
  SPECIAL_VALUE_MARKERS.some((marker) => text.includes(marker))
    ? withoutSpecialMarkers(
        SPECIAL_VALUE_MARKERS.reduce(
          (current, marker) => current.replaceAll(marker, ''),
          text,
        ),
      )
    : text;

/**
 * Text read as itself in a SQON value: `text` with every special marker removed, and near misses of
 * those markers that are not markers. `nonEmpty` draws `~` where removal leaves nothing.
 */
export const literalTextOf = (text: TextArbitraries): TextArbitraries => {
  const nearMisses = fastCheck.constantFrom(
    'set_id',
    'set-id:',
    '__missing',
    'missing__',
    '_missing_',
  );

  return {
    any: fastCheck.oneof(text.any.map(withoutSpecialMarkers), nearMisses),
    nonEmpty: fastCheck.oneof(
      text.nonEmpty.map(withoutSpecialMarkers).map((literal) => literal || '~'),
      nearMisses,
    ),
  };
};

/** Any finite number, integer or not; never `NaN` or an infinity. */
export const FINITE_NUMBER: Arbitrary<number> = fastCheck.oneof(
  fastCheck.integer(),
  fastCheck.double({ noDefaultInfinity: true, noNaN: true }),
);

const FIELD_OPERATOR_ROLES = {
  all: 'listing',
  between: 'range',
  gt: 'range',
  gte: 'range',
  in: 'listing',
  lt: 'range',
  lte: 'range',
  'not-in': 'exclusion',
  'some-not-in': 'exclusion',
  wildcard: 'pattern',
} as const satisfies Readonly<
  Record<SqonFieldOp, 'exclusion' | 'listing' | 'pattern' | 'range'>
>;

/** Every operator spelling accepted by SQON: combinations, field operators and aliases. */
export const ACCEPTED_OPERATORS: readonly SqonAcceptedOp[] = [
  ...SQON_COMBINATION_OPS,
  ...SQON_FIELD_OPS,
  ...Object.keys(SQON_OP_ALIASES).filter(isSqonOpAlias),
];

/**
 * The canonical operator spelled by `operator`, an alias read as the operator it stands for, or
 * `undefined` for anything not in {@link ACCEPTED_OPERATORS}, a value that is not a string included.
 */
export const canonicalOperatorOf = (
  operator: unknown,
): SqonCanonicalOp | undefined => {
  const accepted = ACCEPTED_OPERATORS.find((spelling) => spelling === operator);

  return accepted === undefined ? undefined : normalizeSqonOp(accepted);
};

const operatorOf = (node: unknown): SqonCanonicalOp | undefined =>
  isDataRecord(node) ? canonicalOperatorOf(node['op']) : undefined;

/**
 * Every accepted spelling of the `canonical` operators, aliases included, in the order of
 * {@link ACCEPTED_OPERATORS}. Throws an `Error` when no operator is given.
 */
export const spellingsOf = (
  ...canonical: readonly SqonCanonicalOp[]
): NonEmptyList<string> =>
  nonEmptyOr(
    ACCEPTED_OPERATORS.filter((spelling) =>
      canonical.includes(normalizeSqonOp(spelling)),
    ),
    'no spelling of the operators given',
  );

const fieldOperatorsPlaying = (
  role: (typeof FIELD_OPERATOR_ROLES)[SqonFieldOp],
): readonly SqonFieldOp[] =>
  SQON_FIELD_OPS.filter((operator) => FIELD_OPERATOR_ROLES[operator] === role);

/** Every spelling of an exclusion: `not-in`, `some-not-in` and their aliases. */
export const EXCLUSION_SPELLINGS: NonEmptyList<string> = spellingsOf(
  ...fieldOperatorsPlaying('exclusion'),
);

/** Every spelling of a wildcard pattern. */
export const PATTERN_SPELLINGS: NonEmptyList<string> = spellingsOf(
  ...fieldOperatorsPlaying('pattern'),
);

/** Every spelling of `in`, aliases included. */
export const IN_SPELLINGS: NonEmptyList<string> = spellingsOf('in');

const ALL_SPELLINGS = spellingsOf('all');
const OPEN_RANGE_SPELLINGS = spellingsOf('gt', 'gte', 'lt', 'lte');
const BETWEEN_SPELLINGS = spellingsOf('between');
const AND_SPELLINGS = spellingsOf('and');
const GROUP_SPELLINGS = spellingsOf('and', 'or');

/** Every spelling of `and`, `or` and `not`. */
export const COMBINATION_SPELLINGS: NonEmptyList<string> = spellingsOf(
  'and',
  'or',
  'not',
);

/** A condition drawn from the grammar, with the field name of every clause in it, repeats kept. */
export interface GeneratedCondition {
  condition: DataRecord;
  fieldNames: readonly string[];
}

const CALENDAR_DATE: Arbitrary<string> = fastCheck
  .date({
    max: new Date('2100-12-31'),
    min: new Date('1900-01-01'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

/**
 * Conditions in the form written by an author: `in` over distinct literal values, the ranges over
 * numbers, dates and other literal strings, and `and`, `or` and `not` around them, under every
 * spelling. Every value is fixed, never date math. Each clause reads a field drawn from `fieldName`,
 * and its text values are drawn from `text`.
 */
export const authoredConditionOf = (
  text: TextArbitraries,
  fieldName: Arbitrary<string>,
): Arbitrary<GeneratedCondition> => {
  const fixedText = literalTextOf(text).nonEmpty.filter(isFixedValue);
  const bound = fastCheck.oneof(FINITE_NUMBER, fixedText, CALENDAR_DATE);
  const lowestFirst = <Bound extends number | string>([first, second]: [
    Bound,
    Bound,
  ]): [Bound, Bound] => (first <= second ? [first, second] : [second, first]);
  const orderedPair = fastCheck.oneof(
    fastCheck.tuple(FINITE_NUMBER, FINITE_NUMBER).map(lowestFirst),
    fastCheck.tuple(fixedText, fixedText).map(lowestFirst),
    fastCheck.tuple(CALENDAR_DATE, CALENDAR_DATE).map(lowestFirst),
  );
  const listedValues = fastCheck.uniqueArray(
    fastCheck.oneof(FINITE_NUMBER, fixedText, CALENDAR_DATE),
    { comparator: 'SameValueZero', maxLength: 4, minLength: 1 },
  );
  const clause = (
    spellings: NonEmptyList<string>,
    value: Arbitrary<unknown>,
  ): Arbitrary<GeneratedCondition> =>
    fastCheck
      .tuple(fastCheck.constantFrom(...spellings), fieldName, value)
      .map(([op, clauseFieldName, clauseValue]) => ({
        condition: {
          content: { fieldName: clauseFieldName, value: clauseValue },
          op,
        },
        fieldNames: [clauseFieldName],
      }));
  const leaf = fastCheck.oneof(
    clause(IN_SPELLINGS, listedValues),
    clause(OPEN_RANGE_SPELLINGS, bound),
    clause(BETWEEN_SPELLINGS, orderedPair),
  );
  const { condition } = fastCheck.letrec<{
    condition: GeneratedCondition;
    group: GeneratedCondition;
    negation: GeneratedCondition;
  }>((tie) => ({
    condition: fastCheck.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      tie('group'),
      tie('negation'),
    ),
    group: fastCheck
      .tuple(
        fastCheck.array(tie('condition'), { maxLength: 3, minLength: 1 }),
        fastCheck.constantFrom(...GROUP_SPELLINGS),
      )
      .map(([entries, op]) => ({
        condition: { content: entries.map((entry) => entry.condition), op },
        fieldNames: entries.flatMap((entry) => entry.fieldNames),
      })),
    negation: fastCheck
      .tuple(tie('condition'), fastCheck.constantFrom(...spellingsOf('not')))
      .map(([entry, op]) => ({
        condition: { content: [entry.condition], op },
        fieldNames: entry.fieldNames,
      })),
  }));

  return condition;
};

/** A single value held by a SQON clause. */
export type Scalar = string | number | boolean;

/** Arbitraries for the filters held by a narrowing, as made by {@link filterArbitraries}. */
export interface FilterArbitraries {
  /** Any filter held by a narrowing, leaf or combination, at any depth. */
  filter: Arbitrary<DataRecord>;

  /** An `in` clause over literal values, under any spelling. */
  inClause: Arbitrary<DataRecord>;

  /** Any value allowed in a listing clause's list. */
  literalScalar: Arbitrary<Scalar>;
}

/**
 * Arbitraries for valid narrowing filters: `in`, `all` and range clauses under every spelling, with
 * `and`, `or` and `not` around them, a `not` always held by an `and` beside an `in`. Field names and
 * text values are drawn from `text`, text values with every special marker removed.
 */
export const filterArbitraries = (text: TextArbitraries): FilterArbitraries => {
  const literal = literalTextOf(text);
  const literalScalar: Arbitrary<Scalar> = fastCheck.oneof(
    literal.any,
    FINITE_NUMBER,
    fastCheck.boolean(),
  );
  const valueList = fastCheck.array(literalScalar, {
    maxLength: 4,
    minLength: 1,
  });
  const bound: Arbitrary<Scalar> = fastCheck.oneof(
    FINITE_NUMBER,
    literal.nonEmpty,
  );
  const clause = (
    spellings: NonEmptyList<string>,
    value: Arbitrary<unknown>,
  ): Arbitrary<DataRecord> =>
    fastCheck
      .tuple(fastCheck.constantFrom(...spellings), text.nonEmpty, value)
      .map(([op, fieldName, clauseValue]) => ({
        content: { fieldName, value: clauseValue },
        op,
      }));
  const inClause = clause(
    IN_SPELLINGS,
    fastCheck.oneof(valueList, literalScalar),
  );
  const leaf = fastCheck.oneof(
    inClause,
    clause(ALL_SPELLINGS, valueList),
    clause(
      OPEN_RANGE_SPELLINGS,
      fastCheck.oneof(
        bound,
        fastCheck.array(bound, { maxLength: 3, minLength: 1 }),
      ),
    ),
    clause(BETWEEN_SPELLINGS, fastCheck.tuple(bound, bound)),
  );
  const { filter } = fastCheck.letrec<{
    andBesideNot: DataRecord;
    combination: DataRecord;
    filter: DataRecord;
    group: DataRecord;
    leaf: DataRecord;
    negation: DataRecord;
  }>((tie) => ({
    andBesideNot: fastCheck
      .tuple(
        inClause,
        tie('negation'),
        fastCheck.array(tie('filter'), { maxLength: 2 }),
        fastCheck.nat(),
        fastCheck.nat(),
        fastCheck.constantFrom(...AND_SPELLINGS),
      )
      .map(([held, negation, others, heldAt, negationAt, op]) => ({
        content: insertedAt(
          insertedAt(others, heldAt, held),
          negationAt,
          negation,
        ),
        op,
      })),
    combination: fastCheck.oneof(tie('group'), tie('andBesideNot')),
    filter: fastCheck.oneof(
      { depthSize: 'small', withCrossShrink: true },
      tie('leaf'),
      tie('combination'),
    ),
    group: fastCheck
      .tuple(
        fastCheck.array(tie('filter'), { maxLength: 3, minLength: 1 }),
        fastCheck.constantFrom(...GROUP_SPELLINGS),
      )
      .map(([content, op]) => ({ content, op })),
    leaf,
    negation: fastCheck
      .tuple(
        fastCheck.array(tie('filter'), { maxLength: 2, minLength: 1 }),
        fastCheck.constantFrom(...spellingsOf('not')),
      )
      .map(([content, op]) => ({ content, op })),
  }));

  return { filter, inClause, literalScalar };
};

/**
 * The entries of `node` when it is an `and`, `or` or `not` under any spelling whose `content` is a
 * list, and `undefined` for anything else.
 */
export const combinationEntries = (
  node: unknown,
): readonly unknown[] | undefined => {
  const operator = operatorOf(node);
  const content = isDataRecord(node) ? node['content'] : undefined;

  return SQON_COMBINATION_OPS.some((combination) => combination === operator) &&
    Array.isArray(content)
    ? content
    : undefined;
};

/** Whether `node` is a map whose `op` is any spelling of `in`. */
export const isInLeaf = (node: unknown): boolean => operatorOf(node) === 'in';

/**
 * What holds a node in a filter: nothing, at the root; an `and` holding an `in` other than the node;
 * an `and` holding no `in` but the node; an `or`; or a `not`.
 */
export type FilterHolder =
  'root' | 'and beside an in' | 'and holding no other in' | 'or' | 'not';

/** A node of a filter, with what holds it and where it is. */
export interface FilterSite {
  holder: FilterHolder;
  node: unknown;

  /** The entry indices leading from the filter's root to the node. */
  path: readonly number[];
}

const holderOf = (
  operator: SqonCanonicalOp | undefined,
  entries: readonly unknown[],
  index: number,
): FilterHolder => {
  if (operator === 'and') {
    return entries.some((entry, at) => at !== index && isInLeaf(entry))
      ? 'and beside an in'
      : 'and holding no other in';
  }

  return operator === 'or' ? 'or' : 'not';
};

/**
 * Every node of `filter`, `filter` itself first, then each combination's entries depth first.
 * `path` and `holder` are those of `filter` itself: omitted, it is the root, at an empty path.
 */
export const filterSites = (
  filter: unknown,
  path: readonly number[] = [],
  holder: FilterHolder = 'root',
): readonly FilterSite[] => {
  const entries = combinationEntries(filter);
  const operator = operatorOf(filter);

  return [
    { holder, node: filter, path },
    ...(entries ?? []).flatMap((entry, index) =>
      filterSites(
        entry,
        [...path, index],
        holderOf(operator, entries ?? [], index),
      ),
    ),
  ];
};

/** The position of the node at `path` in a narrowing's filter, as `sqon.content[1].content[0]`. */
export const filterPosition = (path: readonly number[]): string =>
  `sqon${path.map((index) => `.content[${index}]`).join('')}`;

/**
 * A copy of `filter` with the node at `path` replaced by the result of calling `replace` on it; an
 * empty `path` replaces `filter` itself. Only the combinations along the path are copied. A path
 * stepping into a node that is not a combination, or past a combination's last entry, leaves
 * `filter` as it is from that point.
 */
export const replacedAt = (
  filter: unknown,
  path: readonly number[],
  replace: (node: unknown) => unknown,
): unknown => {
  const [index, ...rest] = path;
  const entries = combinationEntries(filter);

  if (index === undefined) {
    return replace(filter);
  }

  return isDataRecord(filter) && entries
    ? withMember(
        filter,
        'content',
        entries.map((entry, at) =>
          at === index ? replacedAt(entry, rest, replace) : entry,
        ),
      )
    : filter;
};

/** One forbidden change to a valid value, and the problems expected from validating the result. */
export interface Mutation {
  /** The value after the change. */
  changed: unknown;

  /** The problems of which the validator's result holds at least one. */
  expected: NonEmptyList<ExpectedProblem>;

  /** The kind of change, for measuring how often each is made. */
  kind: string;
}

/**
 * A copy of `record`, a list staying a list, whose member at `key` is an enumerable getter throwing
 * an `Error` that carries `LEAK_MARKER`. The copy inherits from `Array.prototype` or
 * `Object.prototype`, whatever `record` inherits from.
 */
export const withThrowingGetter = (record: object, key: string): object =>
  Object.defineProperty(
    Array.isArray(record) ? [...record] : { ...record },
    key,
    {
      configurable: true,
      enumerable: true,
      get: (): never => {
        throw new Error(`${LEAK_MARKER} thrown by a getter`);
      },
    },
  );

const thrower = (): never => {
  throw new Error(`${LEAK_MARKER} thrown by a proxy`);
};

const UNREADABLE_HANDLERS: NonEmptyList<ProxyHandler<object>> = [
  { get: thrower },
  { getPrototypeOf: thrower },
  { ownKeys: thrower },
];

/**
 * An arbitrary of functions that make a record throw when read, each throw carrying `LEAK_MARKER`.
 * The function either adds a throwing getter at a key drawn from `text`, or wraps the record in a
 * proxy that throws on reading a member, its prototype or its keys. A record with no own key always
 * gets the getter.
 */
export const unreadableOf = (
  text: TextArbitraries,
): Arbitrary<(target: DataRecord) => object> =>
  fastCheck.oneof(
    text.any.map(
      (key) =>
        (target: DataRecord): object =>
          withThrowingGetter(target, key),
    ),
    fastCheck
      .tuple(fastCheck.constantFrom(...UNREADABLE_HANDLERS), text.any)
      .map(
        ([handler, key]) =>
          (target: DataRecord): object =>
            // A proxy over a record with no member to read might never reach its trap.
            Reflect.ownKeys(target).length > 0
              ? new Proxy(target, handler)
              : withThrowingGetter(target, key),
      ),
  );

/**
 * A copy of `value`'s own enumerable members, printed by fast-check in a counterexample as `value`
 * is rendered by `inspect`: to a depth of 8, showing proxies and never running a getter. The copy is
 * a plain object, so it keeps neither a list's nature nor a class's prototype.
 */
export const describedBy = <Value extends object>(value: Value): Value =>
  Object.defineProperty({ ...value }, fastCheck.toStringMethod, {
    value: (): string =>
      inspect(value, { depth: 8, getters: false, showProxy: true }),
  });

/**
 * The own keys of `record`, in its order, as a non-empty list. Given a record checked with
 * `satisfies` against a record type keyed by a union, it lists every member of that union. Throws an
 * `Error` when `record` has no key.
 */
export const keysOf = <Key extends string>(
  record: Readonly<Record<Key, unknown>>,
): NonEmptyList<Key> => {
  const isKey = (key: string): key is Key => Object.hasOwn(record, key);

  return nonEmptyOr(
    Object.keys(record).filter(isKey),
    'keysOf needs a map naming at least one key',
  );
};

/** Every reason allowed in a `deny` enforcement result. */
export const DENY_REASONS: NonEmptyList<string> = keysOf({
  'filter-limit': true,
  'no-grants': true,
  'rendering-mismatch': true,
  'unknown-resource': true,
  'unmapped-category': true,
} satisfies Readonly<
  Record<Extract<Enforcement, { kind: 'deny' }>['reason'], true>
>);

const ARM_MEMBERS: Readonly<Record<Enforcement['kind'], readonly string[]>> = {
  allow: ['kind'],
  deny: ['kind', 'reason'],
  narrow: ['kind', 'sqon'],
};

const SCHEMA_PROBLEM: ExpectedProblem = {
  position: 'sqon',
  rule: ENFORCEMENT_RULES.validSqon,
};

/**
 * Valid enforcement results: `allow`, `deny` with any of {@link DENY_REASONS}, and `narrow` with a
 * filter drawn from `filters`.
 */
export const enforcementOf = (
  filters: FilterArbitraries,
): Arbitrary<DataRecord> =>
  fastCheck.oneof(
    fastCheck.constant({ kind: 'allow' }),
    fastCheck
      .constantFrom(...DENY_REASONS)
      .map((reason) => ({ kind: 'deny', reason })),
    filters.filter.map((sqon) => ({ kind: 'narrow', sqon })),
  );

const unknownOperatorOf = (text: TextArbitraries): Arbitrary<string> =>
  fastCheck.oneof(
    fastCheck.constantFrom(
      'IN',
      'And',
      'NOT',
      'not_in',
      'notIn',
      'nin',
      'eq',
      '__proto__',
      ...PROTOTYPE_MEMBER_NAMES,
    ),
    text.any.map((operator) =>
      ACCEPTED_OPERATORS.some((spelling) => spelling === operator)
        ? `${operator}~`
        : operator,
    ),
  );

const specialValueOf = (text: TextArbitraries): Arbitrary<string> =>
  fastCheck
    .tuple(text.any, fastCheck.constantFrom(...SPECIAL_VALUE_MARKERS), text.any)
    .map(([before, marker, after]) => `${before}${marker}${after}`);

const foreignKeyOf = (
  text: TextArbitraries,
  defined: readonly string[],
): Arbitrary<string> =>
  fastCheck.oneof(
    fastCheck.constant('__proto__'),
    text.any.map((key) => freshKey(new Set(defined), key)),
  );

const memberValueOf = (text: TextArbitraries): Arbitrary<unknown> =>
  fastCheck.oneof(
    fastCheck.constant(undefined),
    fastCheck.constant(null),
    text.any,
    fastCheck.jsonValue({ maxDepth: 2 }),
  );

const absentValueRefusals = (
  operator: SqonCanonicalOp | undefined,
  position: string,
): NonEmptyList<readonly [Absence, unknown, ExpectedProblem]> => {
  const common: NonEmptyList<readonly [Absence, unknown, ExpectedProblem]> = [
    ['deleted', undefined, SCHEMA_PROBLEM],
    ['undefined', undefined, SCHEMA_PROBLEM],
    ['null', undefined, SCHEMA_PROBLEM],
    ['wrong type', { value: 'nested' }, SCHEMA_PROBLEM],
  ];

  if (operator === 'in') {
    return [
      ...common,
      [
        'empty list',
        undefined,
        { position, rule: ENFORCEMENT_RULES.inNotEmpty },
      ],
      ['wrong type', [['nested']], SCHEMA_PROBLEM],
    ];
  }

  if (
    operator === 'gt' ||
    operator === 'gte' ||
    operator === 'lt' ||
    operator === 'lte'
  ) {
    return [
      ...common,
      [
        'empty string',
        undefined,
        { position, rule: ENFORCEMENT_RULES.rangeBound },
      ],
      [
        'empty list',
        undefined,
        { position, rule: ENFORCEMENT_RULES.rangeBound },
      ],
      ['wrong type', true, { position, rule: ENFORCEMENT_RULES.rangeBound }],
    ];
  }

  return [
    ...common,
    ['empty string', undefined, SCHEMA_PROBLEM],
    ['empty list', undefined, SCHEMA_PROBLEM],
    ['wrong type', 42, SCHEMA_PROBLEM],
  ];
};

/**
 * Arbitraries each making one forbidden change to `filter`, a valid narrowing filter, and naming the
 * problems expected from validating the result. Only the changes that fit the filter's shape are
 * included: one needing a leaf, a listing clause, a combination or a node below the root is left out
 * of a filter holding none. New field names and values are drawn from `text`. Throws an `Error` when
 * no change applies, which never happens, since any node can be replaced.
 */
export const filterMutationsOf = (
  filter: unknown,
  text: TextArbitraries,
): NonEmptyList<Arbitrary<Mutation>> => {
  const sites = filterSites(filter);
  const anySite: Arbitrary<FilterSite> =
    siteAmong(sites) ??
    fastCheck.constant<FilterSite>({ holder: 'root', node: filter, path: [] });
  const leafSites = sites.filter((site) => !combinationEntries(site.node));
  const listingSites = leafSites.filter((site) => {
    const operator = operatorOf(site.node);

    return operator === 'in' || operator === 'all';
  });
  const combinationSites = sites.filter((site) =>
    combinationEntries(site.node),
  );
  const nonRootSites = sites.filter((site) => site.path.length > 0);
  const forbiddenNotSites = sites.filter(
    (site) => site.holder !== 'and beside an in',
  );
  const literal = literalTextOf(text);
  const literalList = fastCheck.array(
    fastCheck.oneof(literal.any, FINITE_NUMBER, fastCheck.boolean()),
    { maxLength: 3 },
  );
  const at = (
    site: FilterSite,
    rule: string,
  ): NonEmptyList<ExpectedProblem> => [
    { position: filterPosition(site.path), rule },
  ];
  const replacing = (
    kind: string,
    replacement: Arbitrary<unknown>,
    rule: string,
  ): Arbitrary<Mutation> =>
    fastCheck.tuple(anySite, replacement).map(([site, node]) => ({
      changed: replacedAt(filter, site.path, () => node),
      expected: at(site, rule),
      kind,
    }));
  const changingNode = (
    kind: string,
    siteArbitrary: Arbitrary<FilterSite> | undefined,
    change: Arbitrary<
      (node: DataRecord, site: FilterSite) => Mutation['changed']
    >,
    expectedAt: (site: FilterSite) => NonEmptyList<ExpectedProblem>,
  ): Arbitrary<Mutation> | undefined =>
    siteArbitrary &&
    fastCheck.tuple(siteArbitrary, change).map(([site, apply]) => ({
      changed: replacedAt(filter, site.path, (node) =>
        isDataRecord(node) ? apply(node, site) : node,
      ),
      expected: expectedAt(site),
      kind,
    }));

  const mutations = applicable<Mutation>([
    replacing(
      'an exclusion in place of a node',
      fastCheck
        .tuple(
          fastCheck.constantFrom(...EXCLUSION_SPELLINGS),
          text.nonEmpty,
          fastCheck.oneof(literalList, literal.any),
        )
        .map(([op, fieldName, value]) => ({
          content: { fieldName, value },
          op,
        })),
      ENFORCEMENT_RULES.exclusion,
    ),
    changingNode(
      'a leaf respelled as an exclusion',
      siteAmong(leafSites),
      fastCheck
        .constantFrom(...EXCLUSION_SPELLINGS)
        .map((op) => (node: DataRecord) => withMember(node, 'op', op)),
      (site) => at(site, ENFORCEMENT_RULES.exclusion),
    ),
    replacing(
      'an empty group in place of a node',
      fastCheck
        .constantFrom(...COMBINATION_SPELLINGS)
        .map((op) => ({ content: [], op })),
      ENFORCEMENT_RULES.combinationNotEmpty,
    ),
    changingNode(
      'an empty group added to a combination',
      siteAmong(combinationSites),
      fastCheck
        .constantFrom(...COMBINATION_SPELLINGS)
        .map(
          (op) => (node: DataRecord) =>
            withMember(node, 'content', [
              ...(combinationEntries(node) ?? []),
              { content: [], op },
            ]),
        ),
      (site) => [
        {
          position: filterPosition([
            ...site.path,
            combinationEntries(site.node)?.length ?? 0,
          ]),
          rule: ENFORCEMENT_RULES.combinationNotEmpty,
        },
      ],
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
      (site) => at(site, ENFORCEMENT_RULES.pivot),
    ),
    changingNode(
      'a member not defined by SQON, on a node',
      anySite,
      fastCheck
        .tuple(
          foreignKeyOf(text, ['content', 'op', 'pivot']),
          memberValueOf(text),
        )
        .map(
          ([key, value]) =>
            (node: DataRecord) =>
              withMember(node, key, value),
        ),
      (site) => at(site, ENFORCEMENT_RULES.nodeMembers),
    ),
    changingNode(
      'a member not defined by SQON, in a clause',
      siteAmong(leafSites),
      fastCheck
        .tuple(foreignKeyOf(text, ['fieldName', 'value']), memberValueOf(text))
        .map(([key, value]) => (node: DataRecord) => {
          const content = node['content'];

          return withMember(
            node,
            'content',
            isDataRecord(content) ? withMember(content, key, value) : content,
          );
        }),
      (site) => at(site, ENFORCEMENT_RULES.clauseMembers),
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
      ENFORCEMENT_RULES.pattern,
    ),
    replacing(
      'a listing clause holding a special value in place of a node',
      fastCheck
        .tuple(
          fastCheck.constantFrom(...IN_SPELLINGS, ...ALL_SPELLINGS),
          text.nonEmpty,
          literalList,
          specialValueOf(text),
          fastCheck.nat(),
        )
        .map(([op, fieldName, values, special, index]) => ({
          content: { fieldName, value: insertedAt(values, index, special) },
          op,
        })),
      ENFORCEMENT_RULES.literalValues,
    ),
    changingNode(
      'a special value added to a listing clause',
      siteAmong(listingSites),
      fastCheck
        .tuple(specialValueOf(text), fastCheck.nat())
        .map(([special, index]) => (node: DataRecord) => {
          const content = isDataRecord(node['content']) ? node['content'] : {};
          const value = content['value'];

          return withMember(
            node,
            'content',
            withMember(
              content,
              'value',
              insertedAt(
                Array.isArray(value) ? value : [value],
                index,
                special,
              ),
            ),
          );
        }),
      (site) => at(site, ENFORCEMENT_RULES.literalValues),
    ),
    changingNode(
      'a not placed anywhere but beside an in',
      siteAmong(forbiddenNotSites),
      fastCheck
        .constantFrom(...spellingsOf('not'))
        .map((op) => (node: DataRecord) => ({ content: [node], op })),
      (site) => at(site, ENFORCEMENT_RULES.notPlacement),
    ),
    replacing(
      'an empty in in place of a node',
      fastCheck
        .tuple(fastCheck.constantFrom(...IN_SPELLINGS), text.nonEmpty)
        .map(([op, fieldName]) => ({ content: { fieldName, value: [] }, op })),
      ENFORCEMENT_RULES.inNotEmpty,
    ),
    fastCheck
      .tuple(fastCheck.constantFrom(...ALL_SPELLINGS), text.nonEmpty, anySite)
      .map(([op, fieldName, site]) => ({
        changed: replacedAt(filter, site.path, () => ({
          content: { fieldName, value: [] },
          op,
        })),
        expected: [SCHEMA_PROBLEM],
        kind: 'an empty all in place of a node',
      })),
    changingNode(
      'an operator gone missing',
      anySite,
      fastCheck
        .tuple(
          fastCheck.constantFrom(...ABSENCES),
          fastCheck.constantFrom(42, ['in'], {}),
        )
        .map(
          ([absence, wrongType]) =>
            (node: DataRecord) =>
              withAbsentMember(node, 'op', absence, wrongType),
        ),
      () => [SCHEMA_PROBLEM],
    ),
    changingNode(
      'a clause content gone missing',
      siteAmong(leafSites),
      fastCheck
        .tuple(fastCheck.constantFrom(...ABSENCES), fastCheck.boolean())
        .map(
          ([absence, listed]) =>
            (node: DataRecord) =>
              withAbsentMember(
                node,
                'content',
                absence,
                listed ? [node['content']] : 42,
              ),
        ),
      () => [SCHEMA_PROBLEM],
    ),
    siteAmong(combinationSites)?.chain((site) =>
      fastCheck.constantFrom(...ABSENCES).map((absence): Mutation => ({
        changed: replacedAt(filter, site.path, (node) =>
          isDataRecord(node)
            ? withAbsentMember(
                node,
                'content',
                absence,
                (combinationEntries(node) ?? [])[0],
              )
            : node,
        ),
        expected:
          absence === 'empty list'
            ? at(site, ENFORCEMENT_RULES.combinationNotEmpty)
            : [SCHEMA_PROBLEM],
        kind: 'a combination content gone missing',
      })),
    ),
    changingNode(
      'a field name gone missing',
      siteAmong(leafSites),
      fastCheck
        .constantFrom(...ABSENCES)
        .map((absence) => (node: DataRecord) => {
          const content = isDataRecord(node['content']) ? node['content'] : {};

          return withMember(
            node,
            'content',
            withAbsentMember(content, 'fieldName', absence, [
              content['fieldName'],
            ]),
          );
        }),
      () => [SCHEMA_PROBLEM],
    ),
    siteAmong(leafSites)?.chain((site) => {
      const position = filterPosition(site.path);
      const [first, ...others] = absentValueRefusals(
        operatorOf(site.node),
        position,
      );

      return fastCheck
        .constantFrom(first, ...others)
        .map(([absence, wrongType, expected]): Mutation => ({
          changed: replacedAt(filter, site.path, (node) => {
            const content =
              isDataRecord(node) && isDataRecord(node['content'])
                ? node['content']
                : {};

            return isDataRecord(node)
              ? withMember(
                  node,
                  'content',
                  withAbsentMember(content, 'value', absence, wrongType),
                )
              : node;
          }),
          expected: [expected],
          kind: 'a clause value gone missing or misshapen',
        }));
    }),
    changingNode(
      'an operator not defined by SQON',
      anySite,
      unknownOperatorOf(text).map(
        (op) => (node: DataRecord) => withMember(node, 'op', op),
      ),
      () => [SCHEMA_PROBLEM],
    ),
    changingNode(
      'an entry that is no node',
      siteAmong(nonRootSites),
      fastCheck.oneof(
        fastCheck
          .oneof(fastCheck.constantFrom<unknown>(null, 42, true), text.any)
          .map((entry) => (): unknown => entry),
        fastCheck.constant((node: DataRecord): unknown => [node]),
      ),
      () => [SCHEMA_PROBLEM],
    ),
    changingNode(
      'nesting past the depth limit',
      anySite,
      fastCheck
        .integer({ max: 80, min: 65 })
        .map(
          (levels) => (node: DataRecord) =>
            Array.from({ length: levels }).reduce<unknown>(
              (inner) => ({ content: [inner], op: 'and' }),
              node,
            ),
        ),
      () => [SCHEMA_PROBLEM],
    ),
    changingNode(
      'a member that throws when read',
      anySite,
      unreadableOf(text).map(
        (unreadable) => (node: DataRecord) => unreadable(node),
      ),
      () => [{ position: ROOT_POSITION, rule: READ_RULE }],
    ),
  ]);

  return nonEmptyOr(mutations, 'no mutation applies to the filter');
};

/**
 * Arbitraries each making one forbidden change to `enforcement`, a valid enforcement result, and
 * naming the problems expected from validating the result. Every kind gets a missing or unknown
 * `kind`, a member not carried by its kind, and a result that is not a map. A `deny` also gets a
 * missing or unknown `reason`; a `narrow` also gets a missing `sqon` and every change made to its
 * filter by {@link filterMutationsOf}, throwing whatever that throws. New keys and values are drawn
 * from `text`.
 */
export const enforcementMutationsOf = (
  enforcement: DataRecord,
  text: TextArbitraries,
): NonEmptyList<Arbitrary<Mutation>> => {
  const kind = enforcement['kind'];
  const armMembers =
    kind === 'allow' || kind === 'deny' || kind === 'narrow'
      ? ARM_MEMBERS[kind]
      : [];
  const kindMissing: Arbitrary<Mutation> = fastCheck
    .tuple(
      fastCheck.constantFrom(...ABSENCES),
      fastCheck.oneof(
        fastCheck.constantFrom<unknown>(
          42,
          ['allow'],
          '__proto__',
          ...PROTOTYPE_MEMBER_NAMES,
        ),
        text.any.map((unknown) =>
          freshKey(new Set(['allow', 'deny', 'narrow']), unknown),
        ),
      ),
    )
    .map(([absence, wrongType]) => ({
      changed: withAbsentMember(enforcement, 'kind', absence, wrongType),
      expected: [{ position: 'kind', rule: ENFORCEMENT_RULES.kind }],
      kind: 'a kind gone missing or unknown',
    }));
  const foreignMember: Arbitrary<Mutation> = fastCheck
    .tuple(
      fastCheck.oneof(
        fastCheck.constantFrom('kind', 'reason', 'sqon'),
        foreignKeyOf(text, ['kind', 'reason', 'sqon']),
      ),
      memberValueOf(text),
    )
    .map(([key, value]) => {
      const added = freshKey(new Set(armMembers), key);

      return {
        changed: withMember(
          enforcement,
          added,
          added === 'reason' ? 'no-grants' : value,
        ),
        expected: [
          { position: ROOT_POSITION, rule: ENFORCEMENT_RULES.armMembers },
        ],
        kind: 'a member not defined by the kind',
      };
    });
  const reasonInvalid: Arbitrary<Mutation> | undefined =
    kind === 'deny'
      ? fastCheck
          .tuple(
            fastCheck.constantFrom(...ABSENCES),
            fastCheck.oneof(
              fastCheck.constantFrom<unknown>(
                42,
                ['no-grants'],
                'No-Grants',
                'expired',
                ...PROTOTYPE_MEMBER_NAMES,
              ),
              text.any.map((reason) => freshKey(new Set(DENY_REASONS), reason)),
            ),
          )
          .map(([absence, wrongType]) => ({
            changed: withAbsentMember(
              enforcement,
              'reason',
              absence,
              wrongType,
            ),
            expected: [
              { position: 'reason', rule: ENFORCEMENT_RULES.denyReason },
            ],
            kind: 'a deny reason gone missing or unknown',
          }))
      : undefined;
  const sqon = enforcement['sqon'];
  const narrowing: readonly Arbitrary<Mutation>[] =
    kind === 'narrow'
      ? [
          fastCheck
            .tuple(
              fastCheck.constantFrom(...ABSENCES),
              fastCheck.constantFrom<unknown>(42, 'in', true),
            )
            .map(([absence, wrongType]) => ({
              changed: withAbsentMember(
                enforcement,
                'sqon',
                absence,
                wrongType,
              ),
              expected: [SCHEMA_PROBLEM],
              kind: 'a filter gone missing',
            })),
          oneOf(filterMutationsOf(sqon, text)).map((mutation) => ({
            ...mutation,
            changed: withMember(enforcement, 'sqon', mutation.changed),
          })),
        ]
      : [];

  const notAMap: Arbitrary<Mutation> = fastCheck
    .constantFrom<unknown>(
      undefined,
      null,
      '',
      42,
      true,
      [enforcement],
      'allow',
    )
    .map((changed) => ({
      changed,
      expected: [{ position: ROOT_POSITION, rule: ENFORCEMENT_RULES.isMap }],
      kind: 'a result that is not a map',
    }));

  return [
    kindMissing,
    foreignMember,
    notAMap,
    ...applicable([reasonInvalid]),
    ...narrowing,
  ];
};

/** The result of any validator in this package, as read by {@link assertRefusedWithOneOf}. */
export type ValidatorResult =
  { success: true } | { problems: readonly ExpectedProblem[]; success: false };

/**
 * Asserts that `result` is a refusal reporting at least one of `expected`, matched by position and
 * rule. Throws an `AssertionError` when `result` is a success or reports none of them.
 */
export const assertRefusedWithOneOf = (
  result: ValidatorResult,
  expected: readonly ExpectedProblem[],
): void => {
  const problems = result.success ? [] : result.problems;

  assert.equal(result.success, false, 'expected the value to be refused');
  assert.ok(
    problems.some((problem) =>
      expected.some(
        ({ position, rule }) =>
          problem.position === position && problem.rule === rule,
      ),
    ),
    `expected one of ${inspect(expected)}; found ${inspect(problems)}`,
  );
};

/**
 * `value` and every object reachable from it through own enumerable members, `value` first, then
 * depth first; empty when `value` is not an object. Getters are run. A cyclic value overflows the
 * stack with a `RangeError`.
 */
export const objectsReachableFrom = (value: unknown): readonly object[] =>
  typeof value === 'object' && value !== null
    ? [value, ...Object.values(value).flatMap(objectsReachableFrom)]
    : [];

/**
 * Asserts that `returned` is a copy of `given`'s data: deeply equal to a structured clone of
 * `given`, sharing no object with it, and holding only objects that inherit from `Object.prototype`
 * or `Array.prototype`. Throws an `AssertionError` when any of that fails, and whatever
 * `structuredClone` throws for a value it cannot clone, such as a function.
 */
export const assertOwnDataCopy = (returned: unknown, given: unknown): void => {
  const givenObjects: ReadonlySet<object> = new Set(
    objectsReachableFrom(given),
  );

  assert.deepEqual(returned, structuredClone(given));
  assert.deepEqual(
    objectsReachableFrom(returned).filter(
      (object) =>
        givenObjects.has(object) ||
        ![Object.prototype, Array.prototype].includes(
          Object.getPrototypeOf(object),
        ),
    ),
    [],
    'the value returned shares no object with the input and inherits only from Object or Array',
  );
};
