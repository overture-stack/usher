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
