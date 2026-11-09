/**
 * How far the controller's clock and a credential issuer's may disagree when the credential's times
 * are judged, in milliseconds. It stays below the bridge's local refusal tolerance, so the bridge never
 * refuses a token the controller would accept.
 */
export const CLOCK_TOLERANCE_MILLISECONDS = 30_000;
