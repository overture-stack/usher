import type pg from 'pg';

import type { Clock } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';

/** The instance's retention sweep: runs deleting what the store keeps past its retention, until stopped. */
export interface RetentionSweep {
  /** Starts the runs, the first one interval from now; a second call, or one once stopped, does nothing. */
  start(): void;

  /** Stops the runs, beginning none from now on, and settles once a run in flight has ended. */
  stop(): Promise<void>;
}

/** Where the sweep writes its one line, named by its message. */
export interface SweepLog {
  /** Writes a line at error. */
  error(message: string, fields?: Readonly<Record<string, string>>): void;
}

/** What the retention sweep is created from. */
export interface RetentionSweepSettings {
  /** The configured clock, which each run reads once to judge every row's expiry. */
  clock: Clock;

  /** Where a run that fails, once runs start failing, is written. */
  log: SweepLog;

  /** The controller's schema. */
  schema: string;

  /** Where each run's transaction runs, as the system, recording no event, within the store timeout. */
  trail: Pick<AuditTrail<pg.ClientBase>, 'inTransaction'>;
}
