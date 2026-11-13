import type { TokenClaims } from '../identityProvider/index.js';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the realm roles a token's claims list, as Keycloak lists them in `realm_access.roles`, each
 * as it stands, whatever its type: none where `realm_access` is no object or `roles` is no list.
 *
 * @param claims the token's claims.
 */
export const realmRolesOf = (claims: TokenClaims): readonly unknown[] => {
  const access = claims['realm_access'];
  const roles = isRecord(access) ? access['roles'] : undefined;
  return Array.isArray(roles) ? roles : [];
};
