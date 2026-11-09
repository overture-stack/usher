// The schema migration command's process entry, and the one place it reads its environment. It runs
// apart from the controller's processes, which never hold the schema migration role's password. A
// refusal writes one structured line naming the variables at fault to standard error, as the
// controller's start does, and ends the process with a non-zero code; a run that applies its
// migrations writes one line at info naming them to standard output, where the controller writes
// its own, and ends with zero. A failure nothing caught writes its line and ends the process at once.
import { constants } from 'node:os';

import {
  ENVIRONMENT_VARIABLES,
  SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES,
  readSchemaMigrationConfiguration,
} from './configuration/index.js';
import {
  reportFailure,
  reportUncaughtFailure,
  StartRefusal,
} from './failures/index.js';
import {
  migrate,
  MIGRATIONS_REFUSE_TO_RUN,
  MigrationRefusal,
  type MigrationOutcome,
  type RefusedOption,
} from './migrations/index.js';
import { connectionProblemOf } from './store/index.js';

// The log stream's numbering of info.
const INFO_LEVEL = 30;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const SCHEMA_MIGRATIONS_APPLIED = 'schemaMigrations.applied';

// The variable each option a run's refusal can be laid on is read from.
const OPTION_VARIABLES: Readonly<Record<RefusedOption, string>> = {
  databaseUrl: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl,
  runtimeRole: ENVIRONMENT_VARIABLES.databaseUrl,
  schema: ENVIRONMENT_VARIABLES.databaseSchema,
};

// A failure laid on an option, or met reaching or signing in to the store, is a variable's fault and
// refused as one; any other is the run's own, reported as it is.
const refusalFor = (failure: unknown): unknown => {
  if (failure instanceof MigrationRefusal) {
    return new StartRefusal(
      [{ rule: failure.rule, variable: OPTION_VARIABLES[failure.option] }],
      MIGRATIONS_REFUSE_TO_RUN,
    );
  }
  const problem = connectionProblemOf(failure, {
    passwordVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databasePassword,
    urlVariable: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.databaseUrl,
  });
  return problem === undefined
    ? failure
    : new StartRefusal([problem], MIGRATIONS_REFUSE_TO_RUN);
};

// The line names migrations and the floor alone, never a URL, a role or a password. Its members
// come in the log stream's order, as the failure's do: the level, the fields, then the message and
// the time.
const reportApplied = ({
  applied,
  retentionFloorSeconds,
}: MigrationOutcome): void => {
  const line = {
    level: INFO_LEVEL,
    applied,
    ...(retentionFloorSeconds === undefined ? {} : { retentionFloorSeconds }),
    message: SCHEMA_MIGRATIONS_APPLIED,
    time: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

process.on(
  'uncaughtException',
  reportUncaughtFailure('the schema migration command failed'),
);

// The first stop signal stops the run: its connection ends, which rolls back the migration in flight,
// and the run fails saying it was stopped. The process then exits as one the signal ended does, with
// 128 and the signal's number. The handlers let go at the first, so a second signal ends the process
// at once, as it does by default.
const stopping = new AbortController();
const stoppedBy: { signal?: (typeof STOP_SIGNALS)[number] } = {};
const stop = (signal: (typeof STOP_SIGNALS)[number]): void => {
  STOP_SIGNALS.forEach((name) => {
    process.off(name, stop);
  });
  stoppedBy.signal = signal;
  stopping.abort();
};
STOP_SIGNALS.forEach((signal) => {
  process.on(signal, stop);
});

const run = async (): Promise<void> => {
  const configuration = readSchemaMigrationConfiguration(process.env);
  const outcome = await migrate({
    ...configuration,
    signal: stopping.signal,
  }).catch((failure: unknown) => {
    throw refusalFor(failure);
  });
  reportApplied(outcome);
};

run().catch((failure: unknown) => {
  reportFailure('the schema migration command failed')(failure);
  if (stoppedBy.signal !== undefined) {
    process.exitCode = 128 + constants.signals[stoppedBy.signal];
  }
});
