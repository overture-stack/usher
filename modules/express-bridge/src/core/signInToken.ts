/**
 * The two claims read from a three-part signed sign-in token. Neither is verified, since the
 * token's signature is never checked.
 */
export interface SignedTokenClaims {
  /**
   * The token's `exp`, in seconds since the Unix epoch; `undefined` when absent or not a finite
   * number.
   */
  exp: number | undefined;

  /** The token's `sub`; `undefined` when absent or not a string. */
  subject: string | undefined;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsedSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    // A parse error's message can quote the token, so the error is dropped unread.
    return undefined;
  }
};

/**
 * Reads `exp` and `sub` from a credential shaped as a three-part signed token, without checking its
 * signature. Returns `undefined` when the credential is not three non-empty base64url segments, or
 * when its middle segment does not decode to a JSON object. Never throws, and never logs or returns
 * a parse error.
 */
export const readSignedToken = (
  credential: string,
): SignedTokenClaims | undefined => {
  const segments = credential.split('.');
  const [, payload] = segments;
  const claims =
    segments.length === 3 &&
    segments.every((part) => SEGMENT.test(part)) &&
    payload !== undefined
      ? parsedSegment(payload)
      : undefined;

  if (isPlainObject(claims)) {
    const exp = Object.hasOwn(claims, 'exp') ? claims['exp'] : undefined;
    const subject = Object.hasOwn(claims, 'sub') ? claims['sub'] : undefined;
    return {
      exp: typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined,
      subject: typeof subject === 'string' ? subject : undefined,
    };
  }
  return undefined;
};

/**
 * Whether `wallNow`, a wall-clock reading in milliseconds, is at or past the token's `exp` plus
 * `toleranceMs`. A token without `exp` is never expired.
 */
export const isLocallyExpired = (
  claims: SignedTokenClaims,
  wallNow: number,
  toleranceMs: number,
): boolean =>
  claims.exp !== undefined && wallNow >= claims.exp * 1000 + toleranceMs;
