import { plainSnapshot } from './plainData.js';

/**
 * One reason a value was refused: the rule it broke, and where. Neither member ever carries a value
 * taken from the refused input, so a problem is safe to log.
 */
export interface ValidationProblem {
  /**
   * A value-free path from the validated value's root, such as
   * `permissions.<resource>.<category>.record`. A key taken from the input is replaced by a
   * placeholder (`<resource>`, `<category>`, `<entity>` or `<key>`), with one exception: a
   * registration's problems name each category name and resource identifier they are found under,
   * since those keys come from configuration rather than data. Each such key is written as
   * {@link keySegment} writes it, bare or quoted in brackets, as in
   * `categories.resource.HEART_STUDY["resource.consented"]`. A list entry is written with its index,
   * such as `content[1]`, since an index is structure rather than content, and `(root)` is the
   * validated value itself.
   */
  position: string;

  /** Fixed wording naming the rule broken. */
  rule: string;
}

/** The position naming the validated value itself. */
export const ROOT_POSITION = '(root)';

/** The rule broken by a value that throws when read, through a getter or a proxy. */
export const READ_RULE =
  'the value is plain data that can be read without error';

/**
 * The one error this package throws. Its message is the rule broken and `problems` lists where, so
 * neither carries a value taken from the input that caused it, and it never holds a cause.
 */
export class UsherContractError extends Error {
  /** The problems behind the error, empty when the rule alone says what went wrong. */
  readonly problems: readonly ValidationProblem[];

  /**
   * @param rule fixed wording naming the rule broken, never content of the value.
   * @param problems the value-free problems found, when a validator found any.
   */
  constructor(rule: string, problems: readonly ValidationProblem[] = []) {
    super(rule);
    this.name = 'UsherContractError';
    this.problems = Object.freeze(
      problems.map(({ position, rule: problemRule }) =>
        Object.freeze({ position, rule: problemRule }),
      ),
    );
  }
}

/**
 * The problems at `position` whose rule does not hold, one per broken rule.
 *
 * @param position the value-free position every rule here applies to.
 * @param rules each rule's wording, paired with whether the value meets it.
 */
export const brokenRules = (
  position: string,
  rules: readonly (readonly [holds: boolean, rule: string])[],
): readonly ValidationProblem[] =>
  rules.filter(([holds]) => !holds).map(([, rule]) => ({ position, rule }));

/** Every problem found by a validator in its snapshot of a value, and the snapshot it checked. */
export interface CheckedSnapshot {
  problems: readonly ValidationProblem[];
  snapshot: unknown;
}

/**
 * Takes a snapshot of `value` and checks it with `problemsOf`, returning exactly the snapshot
 * checked. Anything thrown while reading the value or checking it becomes a refusal of the whole
 * value and is never passed on, since it can quote the input.
 *
 * @param problemsOf the validator's own walk over the snapshot.
 * @returns the snapshot and every problem found in it, or, when reading or checking `value`
 *   throws, an `undefined` snapshot and a single problem at `(root)` naming {@link READ_RULE}.
 */
export const checkSnapshot = (
  value: unknown,
  problemsOf: (snapshot: unknown) => readonly ValidationProblem[],
): CheckedSnapshot => {
  try {
    const snapshot = plainSnapshot(value);

    return { problems: problemsOf(snapshot), snapshot };
  } catch {
    return {
      problems: [{ position: ROOT_POSITION, rule: READ_RULE }],
      snapshot: undefined,
    };
  }
};

/**
 * The position of a problem found inside a nested value, given the position of that value.
 *
 * @param outer the position of the nested value.
 * @param inner the problem's position relative to the nested value.
 */
export const nestedPosition = (outer: string, inner: string): string =>
  inner === ROOT_POSITION ? outer : `${outer}.${inner}`;

const BARE_KEY_FORM = /^[A-Za-z0-9_-]+$/u;

const ESCAPED_BEYOND_JSON = /[\u007f-\u009f\u2028\u2029]/gu;

const isBareKey = (key: string): boolean => BARE_KEY_FORM.test(key);

const unicodeEscape = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * The segment naming `key` in a position, for a key named by a position because it comes from
 * configuration: a catalogue key, a resource identifier or a category name.
 * - A key of ASCII letters, digits, `_` and `-` is written bare, such as `HEART_STUDY`, and follows
 *   the segment before it after a dot.
 * - Any other key is written as a JSON string in brackets, such as `["global.controlled"]`, and
 *   follows the segment before it directly. Each quote, backslash and character from U+0000 to
 *   U+001F is escaped as JSON escapes it. Each character from U+007F to U+009F, NEL among them, and
 *   the separators U+2028 and U+2029 are written as `\u` escapes as well, since a log can read them
 *   as a line break or a control.
 *
 * A bare segment never holds a dot, a bracket or a quote, so a reader always knows which form is
 * being read. No key can close its brackets early or break a line in a log, and a bracketed key is
 * still a valid JSON string literal.
 *
 * @param key the key, a name from configuration rather than a value from data.
 * @returns the key bare, or quoted in brackets.
 */
export const keySegment = (key: string): string =>
  isBareKey(key)
    ? key
    : `[${JSON.stringify(key).replace(ESCAPED_BEYOND_JSON, unicodeEscape)}]`;

/**
 * The position of the member at `key` in the map at `outer`, the key written by {@link keySegment}:
 * `categories.resource.HEART_STUDY` or `categories.global["global.controlled"]`.
 *
 * @param outer the position of the map.
 * @param key the member's key, a name from configuration rather than a value from data.
 */
export const memberPosition = (outer: string, key: string): string =>
  isBareKey(key) ? `${outer}.${keySegment(key)}` : `${outer}${keySegment(key)}`;
