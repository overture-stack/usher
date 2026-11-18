import {
  type AuditEvent,
  eventInstant,
  REFUSED_SUBJECT_MAXIMUM_LENGTH,
} from '../eventLog/index.js';
import type { SignInRefusal, StoredRefusal } from '../signInTokens/index.js';
import type { ConferringRule } from '../tokenCalculation/index.js';
import type { WindowClosing } from '../windowedRefusals/index.js';

/**
 * Why a fault kept an exchange from being answered, the code answered: the identity provider's keys
 * could not be had, or the store failed the exchange's work.
 */
export type ExchangeFault = 'identityProviderUnavailable' | 'storeUnavailable';

/**
 * Why a credential's exchange was denied: the judgement's refusal; a signing key not confirmed yet,
 * which a made-up key id or a routine key rotation produces, so no fault in the Controller; a service
 * account's token (`serviceAccountNotPermitted`); or the store's refusal of the principal.
 */
export type ExchangeDenial =
  | SignInRefusal
  | StoredRefusal
  | 'serviceAccountNotPermitted'
  | 'signingKeyUnconfirmed';

/** An Usher token issued, as its `token.exchange` records it. */
export interface Issuance {
  /** The application the token was issued for. */
  audience: string;

  /** When its permissions were computed, in seconds since the Unix epoch. */
  generatedAt: number;

  /** The recorded grants that reached it. */
  grantCount: number;

  /** The rules that conferred an entry. */
  rules: readonly ConferringRule[];

  sourceIp: string;

  /** Its `sub`: the identity provider's subject, or `null` for the anonymous visitor. */
  subject: string | null;

  /** Its lifetime, `exp` less `iat`, in seconds. */
  tokenTtl: number;
}

const TYPE = 'token.exchange';

/**
 * The `token.exchange` of a token issued, at info: `succeeded`, its subject as `userId`, its lifetime
 * as `tokenTtl`, the recorded grants counted as `grantCount`, never their values, the conferring
 * `rules`, its `audience`, and `generatedAt` as an instant.
 *
 * @param issuance what was issued, and for whom.
 */
export const issuedExchangeEvent = ({
  audience,
  generatedAt,
  grantCount,
  rules,
  sourceIp,
  subject,
  tokenTtl,
}: Issuance): AuditEvent => ({
  data: {
    audience,
    generatedAt: eventInstant(generatedAt * 1000),
    grantCount,
    result: 'succeeded',
    rules: [...rules],
    sourceIp,
    tokenTtl,
    userId: subject,
  },
  severity: 'info',
  type: TYPE,
});

/**
 * The `token.exchange` of a credential refused, or of one whose signing key is not confirmed yet, at
 * warning: `denied`, under its reason, naming no `userId`. It names the subject given in
 * `refusedSubject` whole when that is at most {@link REFUSED_SUBJECT_MAXIMUM_LENGTH} characters, and
 * leaves the member out for a longer one, never cut short, or where none is given. A subject given
 * must be that of a token whose signature verified, so a forged token can put no subject in the trail.
 * The application given, the one whose channel assertion verified, is named as `applicationId`, as a
 * refusal of a credential that did not verify names it.
 *
 * @param refusal the reason, the verified token's subject if it is named, the application if it is
 *   named, and the request's address.
 */
export const deniedExchangeEvent = ({
  applicationId,
  reason,
  refusedSubject,
  sourceIp,
}: {
  applicationId?: string;
  reason: ExchangeDenial;
  refusedSubject?: string;
  sourceIp: string;
}): AuditEvent => ({
  data: {
    ...(applicationId === undefined ? {} : { applicationId }),
    reason,
    ...(refusedSubject !== undefined &&
    refusedSubject.length <= REFUSED_SUBJECT_MAXIMUM_LENGTH
      ? { refusedSubject }
      : {}),
    result: 'denied',
    sourceIp,
    userId: null,
  },
  severity: 'warning',
  type: TYPE,
});

/** An Usher token not issued for passing the token limit, as its `token.exchange` records it. */
export interface OverLimitToken {
  /** How many resources its payload holds an entry for. */
  heldResourceCount: number;

  sourceIp: string;

  /** Its `sub`: the identity provider's subject, or `null` for the anonymous visitor. */
  subject: string | null;

  /** Its size in bytes, as the `200` body would have sent it. */
  tokenBytes: number;
}

/**
 * The `token.exchange` of an exchange whose token would pass the token limit, at error: `failed`,
 * under `tokenOverResponseCap`, with the resources its payload holds as `heldResourceCount`, the
 * token's size as `tokenBytes`, and its subject as `userId`. It names no resource, no grant count and
 * no rule.
 *
 * @param token the token's subject, its size and the resources it holds, and the request's address.
 */
export const overLimitExchangeEvent = ({
  heldResourceCount,
  sourceIp,
  subject,
  tokenBytes,
}: OverLimitToken): AuditEvent => ({
  data: {
    heldResourceCount,
    reason: 'tokenOverResponseCap',
    result: 'failed',
    sourceIp,
    tokenBytes,
    userId: subject,
  },
  severity: 'error',
  type: TYPE,
});

/**
 * The `token.exchange` of an exchange a fault kept from being answered, at error: `failed`, under the
 * code answered, naming no `userId`.
 *
 * @param failure the code answered, and the request's address.
 */
export const failedExchangeEvent = ({
  reason,
  sourceIp,
}: {
  reason: ExchangeFault;
  sourceIp: string;
}): AuditEvent => ({
  data: { reason, result: 'failed', sourceIp, userId: null },
  severity: 'error',
  type: TYPE,
});

/**
 * The `token.exchangeRefusalTally` closing a window of credentials the exchange refused `denied`, at
 * warning, its actor the system: its reason, its count, the instants of its first and latest
 * refusals, the application its key names where it names one, and as `windowId` the
 * `token.exchange` that opened it, where that event committed. Nothing a credential carried is named.
 *
 * @param closing the window as it closed.
 */
export const exchangeRefusalTallyEvent = ({
  applicationId,
  count,
  firstSeenAt,
  lastSeenAt,
  reason,
  windowId,
}: WindowClosing): AuditEvent => ({
  data: {
    ...(applicationId === undefined ? {} : { applicationId }),
    count,
    firstSeenAt: eventInstant(firstSeenAt),
    lastSeenAt: eventInstant(lastSeenAt),
    reason,
    ...(windowId === undefined ? {} : { windowId }),
  },
  severity: 'warning',
  type: 'token.exchangeRefusalTally',
});
