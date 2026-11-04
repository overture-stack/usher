import { SQON_OP_ALIASES } from '@overture-stack/sqon';

import { isNonEmptyString } from './plainData.js';

/**
 * The markers read by Arranger inside a value as an instruction rather than as the value itself: a
 * pattern, a saved-set reference and a missing-field marker. Frozen, so no caller can narrow what is
 * refused.
 */
export const SPECIAL_VALUE_MARKERS: readonly string[] = Object.freeze([
  '*',
  '__missing__',
  'set_id:',
]);

// A Map, so a name inherited from Object.prototype is never taken for an alias.
const CANONICAL_OPERATORS: ReadonlyMap<string, string> = new Map(
  Object.entries(SQON_OP_ALIASES),
);

/**
 * Whether a SQON value is read as itself: anything but a string holding one of
 * {@link SPECIAL_VALUE_MARKERS}.
 *
 * @param value one value of a clause.
 */
export const isLiteralValue = (value: unknown): boolean =>
  typeof value === 'string'
    ? SPECIAL_VALUE_MARKERS.every((marker) => !value.includes(marker))
    : true;

/**
 * Date math's relative form: `now` in any case after any leading whitespace, alone save for
 * trailing whitespace, or followed by an offset or a rounding.
 */
const RELATIVE_DATE = /^\s*now(?:\s*$|[+\-/])/iu;

/**
 * Whether a value is fixed: anything but a string written as Elasticsearch date math, either
 * relative (`now`, `now-1y`, `now/d`) or anchored (`2024-01-01||+1M`). Date math makes a value
 * change with time, so a condition holding it would move records between categories with no grant
 * changing. `now` is recognized in any case, after leading whitespace and, standing alone, before
 * trailing whitespace, so that no spelling read as date math by a search engine or an adapter
 * passes as fixed. A keyword merely containing it, such as `unknown` or `nowhere`, is fixed, and
 * `||` is refused anywhere.
 *
 * @param value one value of a clause.
 */
export const isFixedValue = (value: unknown): boolean =>
  typeof value === 'string'
    ? !RELATIVE_DATE.test(value) && !value.includes('||')
    : true;

/**
 * The canonical spelling of a SQON operator, read through `SQON_OP_ALIASES`, where a name inherited
 * from `Object.prototype` is never taken for an alias. An operator that is no alias is returned
 * unchanged, known or not, and one that is not a string gives `undefined`.
 *
 * @param operator a node's `op`, untrusted.
 */
export const canonicalOperatorOf = (operator: unknown): string | undefined =>
  typeof operator === 'string'
    ? (CANONICAL_OPERATORS.get(operator) ?? operator)
    : undefined;

/**
 * A value the search engine can use as a range bound: a finite number or a non-empty string, which
 * is how a date reaches a filter that has passed `SqonSchema`.
 *
 * @param value one value of a clause.
 */
export const isBound = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  isNonEmptyString(value);

/**
 * Whether `value` can name a resource: a non-empty string other than `__proto__`, holding no marker
 * read specially by Arranger.
 */
export const isUsableResource = (value: unknown): value is string =>
  isNonEmptyString(value) && value !== '__proto__' && isLiteralValue(value);
