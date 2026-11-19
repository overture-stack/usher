import type { TokenClaims } from '../identityProvider/index.js';
import { realmRolesOf } from './realmRolesOf.js';

// Keycloak names a service account's user after its client, and gives its tokens the client's id.
const SERVICE_ACCOUNT_USERNAME = 'service-account-';

/**
 * Whether a token's claims mark it as a service account's, by any one of three marks: a `client_id`
 * claim that is text, or a `preferred_username` starting `service-account-`, either sign of
 * Keycloak's client credentials; or the service-account realm role, compared by its exact name. A
 * token carrying any one is a service account's whatever else it carries, a person's name or any
 * other realm role among them.
 *
 * @param claims the token's verified claims.
 * @param serviceAccountRole the realm role marking its holder's token as a service account's.
 */
export const isServiceAccount = (
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
