import { StartRefusal } from './startRefusal.js';

// The level a process that cannot go on writes at, the log stream's numbering of fatal, so one reader
// takes this line and the stream's alike.
const FATAL_LEVEL = 60;

// A refusal's message names variables and rules alone; any other failure is the store's or the
// network's, whose messages carry no secret, since no URL a process entry reads carries a password.
// The members come in the log stream's order: the level, the fields, then the message and the time.
const failureRecord = (
  failed: string,
  failure: unknown,
): Readonly<Record<string, unknown>> =>
  failure instanceof StartRefusal
    ? {
        level: FATAL_LEVEL,
        variables: failure.variables,
        message: failure.message,
        time: new Date().toISOString(),
      }
    : {
        level: FATAL_LEVEL,
        error: failure instanceof Error ? failure.name : typeof failure,
        message: `${failed}: ${failure instanceof Error ? failure.message : 'an unknown failure'}`,
        time: new Date().toISOString(),
      };

/**
 * Reports a process entry's failure as one structured line on standard error, and gives the process a
 * non-zero exit code. A {@link StartRefusal} is written with the variables it names and its message;
 * any other failure with its name and its message, after what failed.
 *
 * @param failed what failed, opening the message of a failure other than a refusal, such as
 *   `the controller failed to start`.
 */
export const reportFailure =
  (failed: string) =>
  (failure: unknown): void => {
    process.stderr.write(`${JSON.stringify(failureRecord(failed, failure))}\n`);
    process.exitCode = 1;
  };
