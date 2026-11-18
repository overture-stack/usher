/** A Controller as the app creates it, not yet listening. */
export interface Controller {
  /**
   * Checks the store, then listens, resolving to the URL the Controller answers at. A Controller
   * starts once.
   *
   * @throws {StartRefusal} naming the variable at fault, before anything listens.
   */
  start(): Promise<{ url: URL }>;

  /** Stops the Controller, settling only once its work has ended, and also when it never started. */
  stop(): Promise<void>;
}

/**
 * One step run after each committed transaction, before its result is given back, and after one whose
 * `COMMIT` went unconfirmed, before its failure is thrown: it runs whether or not the change was made,
 * so it must be safe either way, as reading what the store holds is.
 */
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
