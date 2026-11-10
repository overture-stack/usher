import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import {
  currencyOf,
  namesAudience,
  type NamesRefusal,
  readNames,
  sessionOf,
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

// Either sign of a client-credentials token marks a service account, so a person's token carrying one
// is refused as a service account's rather than admitted as a person's.
const isServiceAccount = (claims: TokenClaims): boolean => {
  const username = claims['preferred_username'];
  return (
    typeof claims['client_id'] === 'string' ||
    (typeof username === 'string' &&
      username.startsWith(SERVICE_ACCOUNT_USERNAME))
  );
};

const principalOf = (
  claims: TokenClaims,
  subject: string,
  administratorRole: string,
): Principal => ({
  administrator: realmRolesOf(claims).includes(administratorRole),
  subject,
  type: isServiceAccount(claims) ? 'serviceAccount' : 'human',
});

/**
 * Reads a verified management token's claims at an instant: its subject, which is required and must be
 * storable text, as must any `sid` it carries, both judged as `readNames` judges them on every route
 * reading a sign-in token, so a `sid` that is not text is refused; then its expiry, which is required,
 * and its `nbf`, each judged within {@link CLOCK_TOLERANCE_MILLISECONDS}; then its `aud`, a string or
 * a list, which must name the management API, and its `azp`, which must name a configured management
 * client. A token from a service account is read as one, and a principal holding the administrator
 * realm role as a platform administrator.
 *
 * @param claims the token's verified claims.
 * @param settings the management API's audience and clients, and the administrator role.
 * @param now the instant, in milliseconds since the Unix epoch.
 */
export const readManagementClaims = (
  claims: TokenClaims,
  {
    administratorRole,
    managementAudience,
    managementClients,
  }: ManagementTokenSettings,
  now: number,
): ClaimsReading => {
  const names = readNames(claims);
  if (names.kind === 'refused') {
    return NAMES_READINGS[names.reason];
  }
  const { subject } = names;
  const refused = (
    reason: 'expiredToken' | 'missingExpiry' | 'notYetValid' | 'otherAudience',
  ): ClaimsReading => ({ kind: 'refused', reason, subject });
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
      principal: principalOf(claims, subject, administratorRole),
      session: sessionOf(claims),
    };
  }
  return refused('otherAudience');
};
