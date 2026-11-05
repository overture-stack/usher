/** What the server asks to answer whether the controller can serve. */
export interface Readiness {
  /** Whether the controller can serve now: started, and not stopping. */
  isReady(): boolean;
}
