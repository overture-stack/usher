/** RFC 9457 problem details as the controller answers a refusal, carrying a code. */
export interface Problem {
  /** Names the refusal, for a caller to act on. */
  code: string;

  /** What was wrong, and what to do about it; never a value the request carried. */
  detail: string;

  status: number;

  /** The rule broken, in a few words. */
  title: string;
}

/** What the server asks to answer whether the controller can serve. */
export interface Readiness {
  /** Whether the controller can serve now; it never rejects. */
  isReady(): Promise<boolean>;
}

/** What the server is created from. */
export interface ServerSettings extends Readiness {
  /**
   * The addresses and CIDR ranges whose `X-Forwarded-For` the server believes, so a request's address
   * is the nearest one they did not add; none for a server no proxy fronts.
   */
  trustedProxies: readonly string[];
}
