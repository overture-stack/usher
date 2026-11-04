/**
 * Marks a response as limited rather than complete: set to {@link SUSPENDED_VALUE} on a request
 * served to a suspended principal, who is served the open tier alone, and exposed to browsers.
 */
export const SUSPENDED_HEADER = 'Usher-Suspended';

/** The value of {@link SUSPENDED_HEADER} on a request served to a suspended principal. */
export const SUSPENDED_VALUE = 'true';

/**
 * The `error` values of the bridge's `WWW-Authenticate: Bearer` challenge:
 * - `invalidToken` comes with a 401 refusing the credential, whatever the reason. A 401 that
 *   persists after one successful renewal of the sign-in token is final for that token.
 * - `invalidRequest` comes with a 400 refusing a request that carried more than one credential, or
 *   one anywhere but the Authorization header.
 */
export const CHALLENGE_ERRORS: Readonly<{
  invalidRequest: 'invalid_request';
  invalidToken: 'invalid_token';
}> = Object.freeze({
  invalidRequest: 'invalid_request',
  invalidToken: 'invalid_token',
});
