// The Controller's process entry, and the one place it reads its environment. A refused start writes
// one structured line naming the variables at fault to standard error, and ends the process with a
// non-zero code before anything listens; a stop signal stops the Controller once its work has ended.
// A failure nothing caught writes its line and ends the process at once.
import { createController } from './app/index.js';
import { readConfiguration } from './configuration/index.js';
import { reportFailure, reportUncaughtFailure } from './failures/index.js';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

process.on('uncaughtException', reportUncaughtFailure('the controller failed'));

const run = async (): Promise<void> => {
  const controller = createController(readConfiguration(process.env));
  STOP_SIGNALS.forEach((signal) =>
    process.once(signal, () => {
      controller.stop().catch(reportFailure('the controller failed to stop'));
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

run().catch(reportFailure('the controller failed to start'));
