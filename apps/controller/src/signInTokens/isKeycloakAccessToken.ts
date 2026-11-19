import type { TokenContents } from './types.js';

// The payload `typ` given by Keycloak to every access token, and to no other token it issues.
const KEYCLOAK_ACCESS_TOKEN_TYPE = 'Bearer';

/**
 * The Keycloak connector's recognition of an access token: true exactly when the token's payload `typ`
 * is the text `Bearer`, compared exactly, letter case included. Keycloak 12.0.4 and 26.8.0 give every
 * access token that `typ`, whatever its grant, a lightweight one and one in RFC 9068 mode included.
 * Each other token they issue carries a `typ` of its own: `ID`, `Refresh`, `Offline`, `Logout`,
 * `Serialized-ID`, or `DPoP` for an access token bound to a key held by the client, whose proof of
 * possession cannot be checked by a reader holding the token alone. The header's `typ` is not read:
 * Keycloak gives an access token `JWT` there by default, and `at+jwt` only with its RFC 9068 option
 * on, so the payload's `typ` alone recognizes one in either mode.
 *
 * A generic connector, for a provider following RFC 9068, would recognize an access token by its
 * header's `typ` instead, `at+jwt` or `application/at+jwt`. That connector is not built here.
 *
 * @param token the token's claims and protected header, verified or not.
 */
export const isKeycloakAccessToken = ({ claims }: TokenContents): boolean =>
	claims['typ'] === KEYCLOAK_ACCESS_TOKEN_TYPE;
