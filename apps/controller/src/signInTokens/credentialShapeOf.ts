import type { CredentialShape } from './types.js';

const BASE64URL = /^[A-Za-z0-9_-]*$/u;

// RFC 7515's and RFC 7516's compact serializations, by their count of segments. A JWE's encrypted key
// is empty under direct encryption, as an Usher token's is, so only the protected header has to be
// non-empty.
const COMPACT_SHAPES: ReadonlyMap<number, CredentialShape> = new Map([
  [3, 'signedToken'],
  [5, 'encryptedToken'],
]);

/**
 * Reads a credential's shape from its text alone, nothing of it decoded or verified: empty text is
 * empty; base64url segments joined by dots, the first non-empty, are a compact JWS when there are three
 * and a compact JWE when there are five; and anything else is opaque.
 *
 * @param credential the credential, as the request carried it.
 */
export const credentialShapeOf = (credential: string): CredentialShape => {
  if (credential === '') {
    return 'empty';
  }
  const segments = credential.split('.');
  const compact =
    segments[0] !== '' && segments.every((segment) => BASE64URL.test(segment));
  return (
    (compact ? COMPACT_SHAPES.get(segments.length) : undefined) ?? 'opaque'
  );
};
