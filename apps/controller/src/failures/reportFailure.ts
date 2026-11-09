import { writeSync } from 'node:fs';

import { ControllerError } from './controllerError.js';
import { StartRefusal } from './startRefusal.js';

// The level a process that cannot go on writes at, the log stream's numbering of fatal, so one reader
// takes this line and the stream's alike.
const FATAL_LEVEL = 60;

// A code or a name is an identifier, such as a SQLSTATE, a system error's code or a class's name;
// any other text in its place is not one.
const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/u;

const identifierOf = (value: unknown): string | undefined =>
  typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;

/**
 * A failure's code, a SQLSTATE or a system error's code, as a failure line may write it: only when it
 * is an identifier, `undefined` otherwise or for a failure carrying none.
 *
 * @param failure what failed.
 */
export const failureCodeOf = (failure: unknown): string | undefined =>
  identifierOf(
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? failure.code
      : undefined,
  );

/**
 * A failure's name as a failure line may write it: an error's name when it is an identifier, else
 * `Error`, and for anything thrown that is no error, its type.
 *
 * @param failure what failed.
 */
export const failureNameOf = (failure: unknown): string =>
  failure instanceof Error
    ? (identifierOf(failure.name) ?? 'Error')
    : typeof failure;

// A failure line carries codes and the controller's own messages only. A refusal is written with the
// variables it names and its message, and any other error of the controller's own with its name and
// its message, beside the code of the failure it wraps when that carries one; any other failure by
// its code when it carries one, else by its name alone, under the fixed message naming what failed.
// A code or a name is written only when it is an identifier. The members come in the log stream's
// order: the level, the fields, then the message and the time.
const failureFields = (
  failed: string,
  failure: unknown,
): Readonly<Record<string, unknown>> => {
  if (failure instanceof StartRefusal) {
    return { variables: failure.variables, message: failure.message };
  }
  if (failure instanceof ControllerError) {
    const causeCode = failureCodeOf(failure.cause);
    return {
      error: failure.name,
      ...(causeCode === undefined ? {} : { code: causeCode }),
      message: `${failed}: ${failure.message}`,
    };
  }
  const code = failureCodeOf(failure);
  return code === undefined
    ? { error: failureNameOf(failure), message: failed }
    : { code, message: failed };
};

/**
 * The structured line a process entry's failure is reported as: a {@link StartRefusal} with the
 * variables it names and its message; any other {@link ControllerError} with its name and its
 * message, after what failed, and the code of the failure it wraps as its `cause` when that carries
 * one; any other failure by its code when it carries one, a SQLSTATE or a system error's code, else
 * by its name alone, its message never written, under what failed. A code or a name that is not an
 * identifier is not written: a failure's name is then written as `Error`.
 *
 * @param failed what failed, which opens the message, such as `the controller failed to start`.
 * @param failure what the entry met.
 */
export const failureRecord = (
  failed: string,
  failure: unknown,
): Readonly<Record<string, unknown>> => ({
  level: FATAL_LEVEL,
  ...failureFields(failed, failure),
  time: new Date().toISOString(),
});

/**
 * Reports a process entry's failure as one structured line on standard error, as
 * {@link failureRecord} gives it, and gives the process a non-zero exit code.
 *
 * @param failed what failed, which opens the message, such as `the controller failed to start`.
 */
export const reportFailure =
  (failed: string) =>
  (failure: unknown): void => {
    process.stderr.write(`${JSON.stringify(failureRecord(failed, failure))}\n`);
    process.exitCode = 1;
  };

/**
 * Reports a failure nothing caught, a thrown error or, under Node's default handling, a rejected
 * promise nobody handled, as the one line {@link failureRecord} gives, written to standard error
 * before anything else runs, and ends the process at once with exit code 1. Nothing is stopped
 * gracefully, since what state the process is in is unknown. A process entry installs it as its
 * `uncaughtException` handler.
 *
 * @param failed what failed, which opens the message, such as `the controller failed`.
 */
export const reportUncaughtFailure =
  (failed: string) =>
  (failure: unknown): never => {
    try {
      writeSync(
        process.stderr.fd,
        `${JSON.stringify(failureRecord(failed, failure))}\n`,
      );
    } finally {
      process.exit(1);
    }
  };
