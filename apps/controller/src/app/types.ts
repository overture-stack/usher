/** A controller as the app creates it, not yet listening. */
export interface Controller {
  /**
   * Checks the store, then listens, resolving to the URL the controller answers at. A controller
   * starts once.
   *
   * @throws {StartRefusal} naming the variable at fault, before anything listens.
   */
  start(): Promise<{ url: URL }>;

  /** Stops the controller, settling only once its work has ended, and also when it never started. */
  stop(): Promise<void>;
}

/** One step run after each committed transaction, before its result is given back. */
export interface AfterCommitStep {
  /** Names the step on the line written when it fails. */
  name: string;

  run(): Promise<void> | void;
}

/** Where a step that failed after a commit is written. */
export interface AfterCommitLog {
  /** Writes a line at error. */
  error(message: string, fields?: Readonly<Record<string, string>>): void;
}
