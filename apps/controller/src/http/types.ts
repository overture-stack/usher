/** What the server asks to answer whether the controller can serve. */
export interface Readiness {
  /** Whether the controller can serve now; it never rejects. */
  isReady(): Promise<boolean>;
}

/** What the server is created from. */
export interface ServerSettings extends Readiness {
  /**
   * The addresses whose `X-Forwarded-For` the server believes, so a request's address is the nearest
   * one they did not add; none for a server no proxy fronts.
   */
  trustedProxies: readonly string[];
}
