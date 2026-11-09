import { CLOCK_TOLERANCE_MILLISECONDS } from '../configuration/index.js';
import type { TokenClaims } from '../identityProvider/index.js';
import { isStorableText } from '../store/index.js';
import type {
  ClaimsReading,
  ManagementTokenSettings,
  Principal,
} from './types.js';

// Keycloak names a service account's user after its client, and gives its tokens the client's id.
const SERVICE_ACCOUNT_USERNAME = 'service-account-';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const audiencesOf = (aud: unknown): readonly unknown[] =>
  Array.isArray(aud) ? aud : [aud];

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

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Reads a verified management token's claims at an instant: its subject, which is required and must be
 * storable text, as must its `sid`; then its expiry, which is required, and its `nbf`, each judged
 * within {@link CLOCK_TOLERANCE_MILLISECONDS}; then its `aud`, a string or a list, which must name the
 * management API, and its `azp`, which must name a configured management client. A token from a
 * service account is read as one, and a principal holding the administrator realm role as a platform
 * administrator.
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
  const subject = claims['sub'];
  const sid = claims['sid'];
  if (typeof subject !== 'string' || subject === '') {
    return { kind: 'unreadable' };
  }
  if (
    !isStorableText(subject) ||
    (typeof sid === 'string' && !isStorableText(sid))
  ) {
    return { kind: 'unrepresentable' };
  }
  const refused = (
    reason: 'expiredToken' | 'missingExpiry' | 'notYetValid' | 'otherAudience',
  ): ClaimsReading => ({ kind: 'refused', reason, subject });
  const { exp, nbf } = claims;
  if (!isTime(exp)) {
    return refused('missingExpiry');
  }
  if (now >= exp * 1000 + CLOCK_TOLERANCE_MILLISECONDS) {
    return refused('expiredToken');
  }
  if (
    nbf !== undefined &&
    !(isTime(nbf) && nbf * 1000 <= now + CLOCK_TOLERANCE_MILLISECONDS)
  ) {
    return refused('notYetValid');
  }
  const azp = claims['azp'];
  if (
    audiencesOf(claims['aud']).includes(managementAudience) &&
    typeof azp === 'string' &&
    managementClients.includes(azp)
  ) {
    return {
      kind: 'accepted',
      principal: principalOf(claims, subject, administratorRole),
      session: {
        ...(isTime(claims['iat']) ? { issuedAt: claims['iat'] } : {}),
        ...(typeof sid === 'string' ? { sid } : {}),
      },
    };
  }
  return refused('otherAudience');
};
