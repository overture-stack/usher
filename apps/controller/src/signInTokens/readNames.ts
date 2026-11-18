import type { TokenClaims } from '../identityProvider/index.js';
import { isStorableText } from '../store/index.js';
import type { NamesReading } from './types.js';

/**
 * Reads the names a sign-in token gives, alike on every route reading one. Its subject, in `sub`, must
 * be non-empty text, else it is refused as `missingSubject`. That subject, and any `sid` the token
 * carries, must be text the store can hold, else it is refused as `unrepresentableSubject`; a `sid`
 * that is not text counts as such, since a session the Controller cannot name cannot be matched
 * against a sign-out of that session.
 *
 * @param claims the token's claims.
 */
export const readNames = (claims: TokenClaims): NamesReading => {
  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject === '') {
    return { kind: 'refused', reason: 'missingSubject' };
  }
  const sid = claims['sid'];
  const storableSession =
    !Object.hasOwn(claims, 'sid') ||
    (typeof sid === 'string' && isStorableText(sid));
  return isStorableText(subject) && storableSession
    ? { kind: 'named', subject }
    : { kind: 'refused', reason: 'unrepresentableSubject' };
};
