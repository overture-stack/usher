import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import {
  currencyOf,
  isKeycloakAccessToken,
  namesAudience,
  type NamesRefusal,
  readNames,
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

// Keycloak names a service account's user after its client, and gives its tokens the client's id.
const SERVICE_ACCOUNT_USERNAME = 'service-account-';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const realmRolesOf = (claims: TokenClaims): readonly unknown[] => {
  const access = claims['realm_access'];
  const roles = isRecord(access) ? access['roles'] : undefined;
  return Array.isArray(roles) ? roles : [];
};

// Any one mark makes a token a service account's: either sign of a client-credentials token, or the
// service-account realm role. So a person's token carrying one is refused as a service account's
// rather than admitted as a person's.
const isServiceAccount = (
  claims: TokenClaims,
  serviceAccountRole: string,
): boolean => {
  const username = claims['preferred_username'];
  return (
    typeof claims['client_id'] === 'string' ||
    (typeof username === 'string' &&
      username.startsWith(SERVICE_ACCOUNT_USERNAME)) ||
    realmRolesOf(claims).includes(serviceAccountRole)
  );
};

const principalOf = (
  claims: TokenClaims,
  subject: string,
  {
    administratorRole,
    serviceAccountRole,
  }: Pick<ManagementTokenSettings, 'administratorRole' | 'serviceAccountRole'>,
): Principal => ({
  administrator: realmRolesOf(claims).includes(administratorRole),
  subject,
  type: isServiceAccount(claims, serviceAccountRole)
    ? 'serviceAccount'
    : 'human',
});

/**
 * Reads a verified management token's claims at an instant: its subject, which is required and must be
 * storable text, as must any `sid` it carries, both judged as `readNames` judges them on every route
 * reading a sign-in token, so a `sid` that is not text is refused; then whether it is an access token,
 * as its identity provider's connector recognizes one, Keycloak's by `isKeycloakAccessToken`, any
 * other token refused as `otherType`; then its expiry, which is required, and its `nbf`, each judged
 * within {@link CLOCK_TOLERANCE_MILLISECONDS}; then its `aud`, a string or a list, which must name the
 * management API, and its `azp`, which must name a configured management client. Each refusal from the
 * access-token check on names the token's subject. A token carrying any one of three marks is read as
 * a service account's, whether or not it also holds the administrator realm role: a `client_id` claim
 * that is text, a `preferred_username` starting `service-account-`, or the service-account realm role,
 * compared by its exact name as the administrator role is. A principal holding the administrator realm
 * role is read as a platform administrator.
 *
 * @param token the token's verified claims and protected header.
 * @param settings the management API's audience and clients, and the administrator and service-account roles.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const readManagementClaims = (
  token: TokenContents,
  {
    administratorRole,
    managementAudience,
    managementClients,
    serviceAccountRole,
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
  const currency = currencyOf(claims, now);
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
        administratorRole,
        serviceAccountRole,
      }),
      session: sessionOf(claims),
    };
  }
  return refused('otherAudience');
};
