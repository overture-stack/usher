import type { ExternalIdRule } from './types.js';

/** The longest an externalId may be, in characters, a character outside the Basic Multilingual Plane counting once. */
export const EXTERNAL_ID_MAXIMUM_LENGTH = 128;

/**
 * The text a search application reads as an instruction in a filter value rather than as itself: a
 * wildcard, a missing-field marker and a saved-set reference, as usher-types lists them, so a
 * payload naming a resource by its externalId never filters by anything else.
 */
export const FILTER_MARKERS: readonly string[] = Object.freeze([
  '*',
  '__missing__',
  'set_id:',
]);

// The default set: ASCII letters, digits, dots, underscores and hyphens, starting with a letter or a
// digit, so `__proto__`, the one name a payload's key may never take, is never one.
const DEFAULT_FORM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * The first rule of its form an externalId breaks, judged in this order: it is in Unicode
 * normalization form C; it holds from 1 to {@link EXTERNAL_ID_MAXIMUM_LENGTH} characters; it starts
 * with a letter or a digit and holds letters, digits, dots, underscores and hyphens alone, each from
 * ASCII, so it is never `__proto__`; and it holds no {@link FILTER_MARKERS filter marker}.
 *
 * @param externalId the externalId sent.
 * @returns the rule broken, or `undefined` for an externalId keeping every rule.
 */
export const externalIdRuleBroken = (
  externalId: string,
): ExternalIdRule | undefined => {
  if (externalId.normalize('NFC') !== externalId) {
    return 'normalization';
  }
  const length = [...externalId].length;
  if (length === 0 || length > EXTERNAL_ID_MAXIMUM_LENGTH) {
    return 'length';
  }
  if (!DEFAULT_FORM.test(externalId)) {
    return 'characters';
  }
  return FILTER_MARKERS.some((marker) => externalId.includes(marker))
    ? 'filterMarker'
    : undefined;
};
