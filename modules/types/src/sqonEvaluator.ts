import { isPlainRecord, listEntries, ownMember } from './plainData.js';
import { canonicalOperatorOf, isLiteralValue } from './sqonPrimitives.js';

// A SQON evaluator for tests only, kept off the package root: it reads a filter against one record
// as the search engine would. It throws for anything it does not evaluate rather than guess.

/** A record to evaluate: each field name mapped to a value, a list of values, or null. */
export type EvaluatedRecord = Readonly<Record<string, unknown>>;

const MISSING_MARKER = '__missing__';

/** A record's values at a field: none when the field is absent, null or an empty list. */
const valuesAt = (
  record: EvaluatedRecord,
  fieldName: string,
): readonly unknown[] => {
  const value = ownMember(record, fieldName);

  if (value === undefined || value === null) {
    return [];
  }

  return listEntries(value) ?? [value];
};

/**
 * Whether `record` lacks `fieldName`: the field is absent, null or an empty list, which is what
 * `__missing__` matches.
 */
export const isMissingField = (
  record: EvaluatedRecord,
  fieldName: string,
): boolean => valuesAt(record, fieldName).length === 0;

/** A record value and a bound compare only as two numbers, or as two strings by code unit. */
const comparison = (value: unknown, bound: unknown): number | undefined => {
  if (typeof value === 'number' && typeof bound === 'number') {
    return value - bound;
  }

  if (typeof value === 'string' && typeof bound === 'string') {
    return value < bound ? -1 : value > bound ? 1 : 0;
  }

  return undefined;
};

const RANGE_TESTS: ReadonlyMap<string, (difference: number) => boolean> =
  new Map([
    ['gt', (difference) => difference > 0],
    ['gte', (difference) => difference >= 0],
    ['lt', (difference) => difference < 0],
    ['lte', (difference) => difference <= 0],
  ]);

interface Clause {
  fieldName: string;
  value: unknown;
}

const clauseOf = (content: unknown): Clause => {
  if (isPlainRecord(content)) {
    const fieldName = ownMember(content, 'fieldName');

    if (typeof fieldName === 'string') {
      return { fieldName, value: ownMember(content, 'value') };
    }
  }

  throw new Error('the evaluator reads a clause naming one field');
};

const listedIn = (value: unknown): readonly unknown[] =>
  listEntries(value) ?? [value];

/** Every listed value, each read as written; a pattern or a set reference is not. */
const literalsIn = (value: unknown): readonly unknown[] => {
  const listed = listedIn(value);

  if (listed.every(isLiteralValue)) {
    return listed;
  }

  throw new Error('the evaluator reads listed values only as written');
};

const singleBoundOf = (value: unknown): unknown => {
  if (listEntries(value) === undefined) {
    return value;
  }

  throw new Error('the evaluator reads a range holding one bound');
};

const boundsOf = (value: unknown): readonly [unknown, unknown] => {
  const [low, high, ...others] = listEntries(value) ?? [];

  if (low !== undefined && high !== undefined && others.length === 0) {
    return [low, high];
  }

  throw new Error('the evaluator reads a between holding two bounds');
};

const matchesIn = (record: EvaluatedRecord, content: unknown): boolean => {
  const { fieldName, value } = clauseOf(content);
  const held = valuesAt(record, fieldName);
  const listed = listedIn(value);
  const literals = literalsIn(
    listed.filter((entry) => entry !== MISSING_MARKER),
  );

  return (
    (listed.includes(MISSING_MARKER) && held.length === 0) ||
    literals.some((literal) => held.includes(literal))
  );
};

const matchesAll = (record: EvaluatedRecord, content: unknown): boolean => {
  const { fieldName, value } = clauseOf(content);
  const held = valuesAt(record, fieldName);

  return literalsIn(value).every((listed) => held.includes(listed));
};

const matchesRange = (
  record: EvaluatedRecord,
  content: unknown,
  holds: (difference: number) => boolean,
): boolean => {
  const { fieldName, value } = clauseOf(content);
  const bound = singleBoundOf(value);

  return valuesAt(record, fieldName).some((held) => {
    const difference = comparison(held, bound);

    return difference !== undefined && holds(difference);
  });
};

const matchesBetween = (record: EvaluatedRecord, content: unknown): boolean => {
  const { fieldName, value } = clauseOf(content);
  const [low, high] = boundsOf(value);

  return valuesAt(record, fieldName).some((held) => {
    const fromLow = comparison(held, low);
    const toHigh = comparison(held, high);

    return (
      fromLow !== undefined &&
      toHigh !== undefined &&
      fromLow >= 0 &&
      toHigh <= 0
    );
  });
};

const entriesOf = (content: unknown): readonly unknown[] => {
  const entries = listEntries(content);

  if (entries) {
    return entries;
  }

  throw new Error('the evaluator reads a combination holding a list');
};

// An empty group means every record, so reading one as matching nothing would let a test pass on a
// filter that serves everything; it is refused instead.
const groupEntriesOf = (content: unknown): readonly unknown[] => {
  const entries = entriesOf(content);

  if (entries.length > 0) {
    return entries;
  }

  throw new Error(
    'the evaluator reads an and or an or holding at least one entry',
  );
};

const onlyEntryOf = (content: unknown): unknown => {
  const [entry, ...others] = entriesOf(content);

  if (entry !== undefined && others.length === 0) {
    return entry;
  }

  throw new Error('the evaluator reads a not holding exactly one entry');
};

/**
 * Whether `record` matches `node`, read as the search engine reads it. Operators are read through
 * SQON's aliases first.
 * - An `in` matches when any of the record's values at the field equals any listed value, and a
 *   listed `__missing__` matches a field that is absent, null or an empty list.
 * - A `not-in` matches exactly when the same clause as an `in` does not.
 * - An `all` matches when the record holds every listed value at the field.
 * - A range compares numbers numerically and strings by code unit, matching when any of the
 *   record's values at the field does, and a `between` includes both bounds.
 * - An `and` or an `or` of at least one entry, and a `not` of exactly one, read as usual.
 *
 * A field that is absent, null or an empty list matches no range and no listed value other than
 * `__missing__`.
 *
 * @throws {Error} for any of:
 * - a wildcard, a `some-not-in` or an unknown operator;
 * - an empty `and` or `or`;
 * - a range whose bound is a list, or a `between` holding other than two bounds;
 * - an `in` or an `all` listing a pattern or a set reference, or an `all` listing `__missing__`;
 * - a malformed node.
 */
export const matchesSqon = (
  node: unknown,
  record: EvaluatedRecord,
): boolean => {
  const { content, operator } = isPlainRecord(node)
    ? {
        content: ownMember(node, 'content'),
        operator: canonicalOperatorOf(ownMember(node, 'op')),
      }
    : { content: undefined, operator: undefined };
  const range = operator ? RANGE_TESTS.get(operator) : undefined;

  if (range) {
    return matchesRange(record, content, range);
  }

  switch (operator) {
    case 'all':
      return matchesAll(record, content);
    case 'and':
      return groupEntriesOf(content).every((entry) =>
        matchesSqon(entry, record),
      );
    case 'between':
      return matchesBetween(record, content);
    case 'in':
      return matchesIn(record, content);
    case 'not':
      return !matchesSqon(onlyEntryOf(content), record);
    case 'not-in':
      return !matchesIn(record, content);
    case 'or':
      return groupEntriesOf(content).some((entry) =>
        matchesSqon(entry, record),
      );
    default:
      throw new Error('the evaluator does not read this operator');
  }
};
