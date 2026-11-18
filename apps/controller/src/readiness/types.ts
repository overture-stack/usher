import type { LineFields } from '../eventLog/index.js';
import type { UnknownMigration } from '../migrations/index.js';

/**
 * What the store answered readiness's probe: whether it reads as read-only, and the migrations it
 * records as applied that this release does not know.
 */
export interface StoreProbe {
  readOnly: boolean;
  unknownMigrations: readonly UnknownMigration[];
}

/** Where readiness writes its lines, each named by its message. */
export interface ReadinessLog {
  /** Writes a line at error. */
  error(message: string, fields: LineFields): void;

  /** Writes a line at info. */
  info(message: string, fields?: Readonly<Record<string, string>>): void;

  /** Writes a line at warning. */
  warning(message: string, fields?: Readonly<Record<string, string>>): void;
}

/** What the Controller's readiness is judged from. */
export interface ReadinessSettings {
  /** Whether every line so far has reached the log stream. */
  isLogWritable(): boolean;

  /** Whether the Controller has started and is not stopping. */
  isServing(): boolean;

  /** Where each change of readiness is written. */
  log: ReadinessLog;

  /** A monotonic clock, in milliseconds, such as `performance.now`. */
  monotonicNow(): number;

  /**
   * Asks the store one statement within the store timeout, resolving to its answer and rejecting
   * when it is not answered.
   */
  probeStore(): Promise<StoreProbe>;

  /** Whether the instance's database role writes, so a store reading as read-only cannot serve it. */
  writesStore(): boolean;
}
