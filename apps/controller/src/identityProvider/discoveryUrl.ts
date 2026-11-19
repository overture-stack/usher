/**
 * Where an issuer's OpenID Connect Discovery document is: the issuer, any trailing slash left out,
 * then the well-known path.
 *
 * @param issuer the issuer, as its tokens carry it.
 */
export const discoveryUrl = (issuer: string): URL =>
  new URL(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`);
