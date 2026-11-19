/**
 * How far the Controller's clock and a credential issuer's may disagree when the credential's times
 * are judged, in milliseconds. It stays below the Bridge's local refusal tolerance, so the Bridge never
 * refuses a token the Controller would accept.
 */
export const CLOCK_TOLERANCE_MILLISECONDS = 30_000;
