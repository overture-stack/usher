import { createHash } from 'node:crypto';

/**
 * The SHA-256 digest of a whole token, as base64url, under which a refusal of a token that verified
 * is counted. A window keeps the digest alone, never the token.
 *
 * @param token the token as the request carried it.
 */
export const tokenDigestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');
