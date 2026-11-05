// The controller's process entry, and the one place it reads its environment. A refused start writes
// one structured line naming the variables at fault to standard error, and ends the process with a
// non-zero code before anything listens; a stop signal stops the controller once its work has ended.
import { createController } from './app/index.js';
import { readConfiguration } from './configuration/index.js';
import { StartRefusal } from './startRefusal.js';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

// The level a process that cannot go on writes at, the log stream's numbering of fatal, so one reader
// takes this line and the stream's alike.
const FATAL_LEVEL = 60;

// A refusal's message names variables and rules alone; any other failure is the store's or the
// network's, whose messages carry no secret, since no URL the controller holds carries a password.
// The members come in the log stream's order: the level, the fields, then the message and the time.
const failureRecord = (
  act: 'start' | 'stop',
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
        message: `the controller failed to ${act}: ${failure instanceof Error ? failure.message : 'an unknown failure'}`,
        time: new Date().toISOString(),
      };

const reportFailure =
  (act: 'start' | 'stop') =>
  (failure: unknown): void => {
    process.stderr.write(`${JSON.stringify(failureRecord(act, failure))}\n`);
    process.exitCode = 1;
  };

const run = async (): Promise<void> => {
  const controller = createController(readConfiguration(process.env));
  STOP_SIGNALS.forEach((signal) =>
    process.once(signal, () => {
      controller.stop().catch(reportFailure('stop'));
    }),
  );
  try {
    await controller.start();
  } catch (failure) {
    // The failure to start is what is reported; a stop failing after it changes nothing reported.
    await controller.stop().catch(() => undefined);
    throw failure;
  }
};

run().catch(reportFailure('start'));
