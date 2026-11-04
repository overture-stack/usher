import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { UsherContractError } from './problems.js';

/**
 * A string placed in identifiers, names and values of a test input, so a test can show that no part
 * of the input reached a problem or an error. Every marker in the tests contains it.
 */
export const LEAK_MARKER = 'ZZLEAKZZ';

/**
 * A number placed where a test input carries one, such as a timestamp or a bound. Its digits mark
 * it, and so does any number derived from it that keeps the digits `171717`.
 */
export const LEAK_NUMBER = 1_717_171_717;

const LEAK_DIGITS = '171717';

/** The one number carried unmarked by a leak input: version 1, fixed by the contract. */
const CONTRACT_NUMBERS: ReadonlySet<number> = new Set([1]);

/** The result of any validator in this package, seen only as far as these assertions need. */
export type CheckedResult =
  | { success: true }
  | { problems: readonly { position: string; rule: string }[]; success: false };

/**
 * One input refused by a validator, with the problem it must report, for a test showing that the
 * problem names no content of the input.
 */
export interface LeakCase {
  /** The input's defect, named in the test. */
  description: string;

  /** The input, every identifier and value of it marked. */
  input: unknown;

  /** The position required in the problem. */
  position: string;

  /** The rule required in the problem. */
  rule: string;
}

const problemPositions = (result: CheckedResult): readonly string[] =>
  result.success ? [] : result.problems.map((problem) => problem.position);

/**
 * Asserts the value was accepted.
 *
 * @throws {AssertionError} when it was refused, carrying the problems found as its `actual`.
 */
export const assertAccepted = (result: CheckedResult): void => {
  assert.deepEqual(
    result.success ? [] : result.problems,
    [],
    'expected the value to be accepted',
  );
  assert.equal(result.success, true);
};

/**
 * Asserts the value was refused with at least one problem, whatever its position.
 *
 * @throws {AssertionError} when it was accepted, or refused with no problem.
 */
export const assertRefused = (result: CheckedResult): void => {
  assert.equal(result.success, false, 'expected the value to be refused');
  assert.ok(
    problemPositions(result).length > 0,
    'a refusal names at least one problem',
  );
};

/**
 * Asserts the value was refused with a problem naming `rule` at `position`, so the test isolates
 * the one rule it is about even where an input breaks another at the same position.
 *
 * @param position the value-free position required in the problem.
 * @param rule the rule required in the problem.
 * @throws {AssertionError} when the value was accepted, or when it was refused with no problem
 *   naming `rule` at `position`, in which case the message lists the problems found.
 */
export const assertRefusedFor = (
  result: CheckedResult,
  position: string,
  rule: string,
): void => {
  assertRefused(result);
  assert.ok(
    !result.success &&
      result.problems.some(
        (problem) => problem.position === position && problem.rule === rule,
      ),
    `expected "${rule}" at ${position}; found ${inspect(result.success ? [] : result.problems)}`,
  );
};

/**
 * Asserts nothing reachable from `carrier`, hidden members, causes and stacks included, contains
 * {@link LEAK_MARKER} or the digits of {@link LEAK_NUMBER}.
 *
 * @param carrier a validator's result, or a thrown error.
 * @throws {AssertionError} when the marker or the digits are found, quoting what was rendered.
 */
export const assertCarriesNoInput = (carrier: unknown): void => {
  const rendered = inspect(carrier, { depth: Infinity, showHidden: true });

  assert.equal(
    rendered.includes(LEAK_MARKER) || rendered.includes(LEAK_DIGITS),
    false,
    `a problem or an error carried content of the input: ${rendered}`,
  );
};

const unmarkedParts = (
  value: unknown,
  contractWords: ReadonlySet<string>,
  allowedUnmarkedKeys: ReadonlySet<string>,
): readonly unknown[] => {
  if (typeof value === 'string') {
    return value.includes(LEAK_MARKER) || contractWords.has(value)
      ? []
      : [value];
  }

  if (typeof value === 'number') {
    return String(value).includes(LEAK_DIGITS) || CONTRACT_NUMBERS.has(value)
      ? []
      : [value];
  }

  if (Array.isArray(value)) {
    return Array.from(value).flatMap((entry) =>
      unmarkedParts(entry, contractWords, allowedUnmarkedKeys),
    );
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, member]) => [
      ...(allowedUnmarkedKeys.has(key)
        ? []
        : unmarkedParts(key, contractWords, allowedUnmarkedKeys)),
      ...unmarkedParts(member, contractWords, allowedUnmarkedKeys),
    ]);
  }

  return [];
};

/**
 * Asserts every string and number carried by `input`, keys included, is marked as input or is a
 * word fixed by the contract, so a leak test cannot pass on content it never marked.
 *
 * @param input a leak test's input.
 * @param contractWords the words fixed by the contract, such as member names, actions and
 *   operators.
 * @param allowedUnmarkedKeys the keys named by a validator by design, such as configured category
 *   names, allowed unmarked as keys of the input and nowhere else. When omitted, every key is held
 *   to the same test as a value.
 * @throws {AssertionError} when any string or number is unmarked, carrying each one as its
 *   `actual`.
 */
export const assertInputMarked = (
  input: unknown,
  contractWords: ReadonlySet<string>,
  allowedUnmarkedKeys: ReadonlySet<string> = new Set(),
): void => {
  assert.deepEqual(
    unmarkedParts(input, contractWords, allowedUnmarkedKeys),
    [],
    'every identifier and value of a leak input carries the marker',
  );
};

/**
 * Asserts that the leak cases between them break every rule in `rules`, so a rule with no case of
 * its own fails the check.
 *
 * @param cases the leak cases of one validator.
 * @param rules every rule held by that validator.
 * @throws {AssertionError} when any rule is broken by no case, carrying each such rule as its
 *   `actual`.
 */
export const assertEveryRuleBroken = (
  cases: readonly { rule: string }[],
  rules: Readonly<Record<string, string>>,
): void => {
  const broken: ReadonlySet<string> = new Set(cases.map(({ rule }) => rule));

  assert.deepEqual(
    Object.values(rules).filter((rule) => !broken.has(rule)),
    [],
  );
};

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }

  return assert.fail('expected the call to throw');
};

/**
 * Runs `action`, asserts it threw this package's error naming `rule`, and returns that error.
 *
 * @param action the call expected to throw.
 * @param rule the rule required in the error.
 * @throws {AssertionError} when `action` throws nothing, throws anything other than an
 *   {@link UsherContractError}, or throws one whose message is not `rule`.
 */
export const contractErrorFrom = (
  action: () => unknown,
  rule: string,
): UsherContractError => {
  const error = thrownBy(action);

  assert.ok(error instanceof UsherContractError, inspect(error));
  assert.equal(error.message, rule);

  return error;
};

/**
 * Passes a value ruled out by the types, as a caller without those types could.
 *
 * @param value the ill-typed value.
 */
export const bypassTypes = <Target>(value: unknown): Target => value as Target;

/**
 * Builds a value through JSON text, as a parsed payload arrives: a `__proto__` key written as a
 * computed key stays an own member of the result.
 *
 * @param value a value holding JSON data only.
 */
export const throughJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));

/** Whether `value` and everything reachable from it is frozen. */
export const isDeeplyFrozen = (value: unknown): boolean =>
  typeof value === 'object' && value !== null
    ? Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen)
    : true;
