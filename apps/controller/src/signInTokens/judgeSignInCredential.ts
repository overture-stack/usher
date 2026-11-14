import { decodeJwt, decodeProtectedHeader } from 'jose';

import type {
  HeldKeyVerification,
  TokenVerification,
  UnverifiedReason,
} from '../identityProvider/index.js';
import { credentialShapeOf } from './credentialShapeOf.js';
import {
  readSignInClaims,
  SUBJECT_NAMING_REFUSALS,
} from './readSignInClaims.js';
import type {
  ContentsRefusal,
  CredentialShape,
  RecordedRefusal,
  SignInJudgement,
  SignInJudgementContext,
  SignInRefusal,
  TokenContents,
} from './types.js';

// The reason a credential refused for its shape alone is recorded under. An opaque credential is an
// API key's to judge, so with no API key verifier its reason names that state rather than the
// credential.
const SHAPE_REASONS = {
  empty: 'missingCredential',
  encryptedToken: 'unreadableToken',
  opaque: 'apiKeyVerifierNotConfigured',
} as const satisfies Readonly<
  Record<Exclude<CredentialShape, 'signedToken'>, SignInRefusal>
>;

// The reason each of the verifier's reasons is recorded under. It covers every reason the verifier
// gives, so a reason added there fails to compile here rather than reaching the audit trail unlisted.
const VERIFIER_REASONS = {
  invalidSignature: 'invalidSignature',
  otherIssuer: 'otherIssuer',
  unreadableToken: 'unreadableToken',
} as const satisfies Readonly<Record<UnverifiedReason, SignInRefusal>>;

// What a token's claims are judged against: everything a credential is, but the verifier.
type ClaimsContext = Omit<SignInJudgementContext, 'verifier'>;

const recorded = (reason: SignInRefusal): RecordedRefusal => ({
  kind: 'recorded',
  reason,
});

const unverifiedContentsOf = (token: string): TokenContents | undefined => {
  try {
    return { claims: decodeJwt(token), header: decodeProtectedHeader(token) };
  } catch {
    return undefined;
  }
};

const contentsRefusalOf = (
  token: string,
  claimsContext: ClaimsContext,
): ContentsRefusal | undefined => {
  const contents = unverifiedContentsOf(token);
  if (contents === undefined) {
    return 'unreadableToken';
  }
  const reading = readSignInClaims(contents, claimsContext);
  return reading.kind === 'refused' ? reading.reason : undefined;
};

// A token its contents did not refuse, judged by what verifying it found, the keys fetched if need
// be: by its verified claims alone once it verifies.
const judgementOf = (
  verification: TokenVerification,
  claimsContext: ClaimsContext,
): SignInJudgement => {
  if (verification.kind === 'verified') {
    const reading = readSignInClaims(verification, claimsContext);
    return reading.kind === 'accepted'
      ? { claims: verification.claims, ...reading }
      : { ...reading, kind: 'recorded' };
  }
  return verification.kind === 'unverified'
    ? recorded(VERIFIER_REASONS[verification.reason])
    : verification;
};

// A token its contents refused stays refused, whatever the keys held let its signature show: verified,
// it is recorded as its verified claims refuse it, its subject named as they allow; otherwise, under the
// refusal its contents earned, naming no subject.
const refusalOf = (
  contentsRefusal: ContentsRefusal,
  verification: HeldKeyVerification,
  claimsContext: ClaimsContext,
): RecordedRefusal => {
  if (verification.kind === 'verified') {
    const reading = readSignInClaims(verification, claimsContext);
    if (reading.kind === 'refused') {
      return { ...reading, kind: 'recorded' };
    }
  }
  return recorded(contentsRefusal);
};

/**
 * Judges a signed token from the refusal its contents earned before its signature was checked, if any.
 * A token its contents did not refuse is verified, the trusted issuer's keys fetched if need be: it is
 * accepted or refused by its verified claims alone, refused under the verifier's reason when it does not
 * verify, and not judged while the keys cannot be had or its key is not confirmed yet. A token its
 * contents refused stays refused, and its signature is checked only where that can change the record:
 * for a refusal in {@link SUBJECT_NAMING_REFUSALS}, under the keys already held alone, so nothing is
 * fetched to judge a token already refused. Once that verifies it, it is recorded under the refusal
 * its verified claims earn, naming the subject that refusal names; otherwise, its key not held or
 * the verifier refusing it, it is recorded under the refusal its contents earned, naming no
 * subject, as is every other refusal of its contents, without any check of its signature.
 *
 * @param token the credential, a compact JWS.
 * @param contentsRefusal why its contents, read without verifying them, refused it, if they did.
 * @param context the calling application's id, the instant, the longest lifetime a sign-in token may
 *   have, and the verifier.
 */
export const judgeSignedToken = async (
  token: string,
  contentsRefusal: ContentsRefusal | undefined,
  { verifier, ...claimsContext }: SignInJudgementContext,
): Promise<SignInJudgement> => {
  if (contentsRefusal === undefined) {
    return judgementOf(await verifier.verify(token), claimsContext);
  }
  return SUBJECT_NAMING_REFUSALS.has(contentsRefusal)
    ? refusalOf(
        contentsRefusal,
        await verifier.verifyHeld(token),
        claimsContext,
      )
    : recorded(contentsRefusal);
};

/**
 * Judges a credential presented at the exchange at an instant, its checks ordered by cost so a
 * credential is refused at its cheapest failing one, and every refusal recorded. Its shape first: an
 * empty, encrypted or opaque credential is refused, and never verified. A signed token's contents next,
 * read without verifying them and judged by {@link readSignInClaims}. Then its signature, by
 * {@link judgeSignedToken}, and a refusal names the token's subject only where that judgement
 * names it.
 *
 * @param credential the credential, as the request carried it.
 * @param context the calling application's id, the instant, the longest lifetime a sign-in token may
 *   have, and the verifier.
 */
export const judgeSignInCredential = async (
  credential: string,
  context: SignInJudgementContext,
): Promise<SignInJudgement> => {
  const shape = credentialShapeOf(credential);
  return shape === 'signedToken'
    ? judgeSignedToken(
        credential,
        contentsRefusalOf(credential, context),
        context,
      )
    : recorded(SHAPE_REASONS[shape]);
};
