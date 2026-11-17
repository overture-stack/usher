import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import {
  currencyOf,
  isKeycloakAccessToken,
  isServiceAccount,
  namesAudience,
  type NamesRefusal,
  readNames,
  realmRolesOf,
  sessionOf,
  type TokenContents,
} from '../signInTokens/index.js';
import type {
  ClaimsReading,
  ManagementTokenSettings,
  Principal,
} from './types.js';

// The reading each refusal of a token's names is given, so the route answers and records each as its
// own: a token naming no subject to act for, or one whose subject or session cannot be stored.
const NAMES_READINGS = {
  missingSubject: { kind: 'unreadable' },
  unrepresentableSubject: { kind: 'unrepresentable' },
} as const satisfies Readonly<Record<NamesRefusal, ClaimsReading>>;

const principalOf = (
  claims: TokenClaims,
  subject: string,
  {
    firstUserRole,
    serviceAccountRole,
  }: Pick<ManagementTokenSettings, 'firstUserRole' | 'serviceAccountRole'>,
): Omit<Principal, 'administrator'> => ({
  firstUser: realmRolesOf(claims).includes(firstUserRole),
  subject,
  type: isServiceAccount(claims, serviceAccountRole)
    ? 'serviceAccount'
    : 'human',
});

/**
 * Reads a verified management token's claims at an instant, in this order. Its subject is required
 * and must be storable text, as must any `sid` it carries, so a `sid` that is not text is refused.
 * It must be an access token as its identity provider's connector recognizes one, Keycloak's by
 * `isKeycloakAccessToken`, and any other token is refused as `otherType`. Its expiry is required and
 * must not have passed, within {@link CLOCK_TOLERANCE_MILLISECONDS}. Its `iat` is required, else it is
 * refused as `missingIssuedAt`, and its expiry must fall at most the longest lifetime a sign-in token
 * may have after it, compared exactly, with no tolerance, else it is refused as `excessiveLifetime`.
 * Any `nbf` must be reached, within the clock tolerance. Its `aud`, a string or a list, must name the
 * management API, and its `azp` must name a configured management client. Each refusal from the
 * access-token check on names the token's subject. A token that {@link isServiceAccount} marks as a
 * service account's is read as one, whether or not it also holds the first-user realm role. Whether
 * the token holds the first-user realm role, compared by its exact name, is read; a token says
 * nothing of admin status, which the store holds.
 *
 * @param token the token's verified claims and protected header.
 * @param settings the management API's audience and clients, the first-user and service-account
 *   roles, and the longest lifetime a sign-in token may have.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const readManagementClaims = (
  token: TokenContents,
  {
    firstUserRole,
    managementAudience,
    managementClients,
    serviceAccountRole,
    signInTokenMaximumLifetimeSeconds,
  }: ManagementTokenSettings,
  now: number,
): ClaimsReading => {
  const { claims } = token;
  const names = readNames(claims);
  if (names.kind === 'refused') {
    return NAMES_READINGS[names.reason];
  }
  const { subject } = names;
  const refused = (
    reason: Extract<ClaimsReading, { kind: 'refused' }>['reason'],
  ): ClaimsReading => ({ kind: 'refused', reason, subject });
  if (!isKeycloakAccessToken(token)) {
    return refused('otherType');
  }
  const currency = currencyOf(
    claims,
    { signInTokenMaximumLifetimeSeconds },
    now,
  );
  if (currency.kind === 'refused') {
    return refused(currency.reason);
  }
  const azp = claims['azp'];
  if (
    namesAudience(claims, managementAudience) &&
    typeof azp === 'string' &&
    managementClients.includes(azp)
  ) {
    return {
      kind: 'accepted',
      principal: principalOf(claims, subject, {
        firstUserRole,
        serviceAccountRole,
      }),
      session: sessionOf(claims),
    };
  }
  return refused('otherAudience');
};
