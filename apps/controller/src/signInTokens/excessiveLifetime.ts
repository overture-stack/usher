/**
 * The reason a sign-in or management token is refused under, at the exchange and at the Management
 * API alike, when its `exp` falls more than the longest lifetime a token may have after its `iat`.
 */
export const EXCESSIVE_LIFETIME = 'excessiveLifetime';
