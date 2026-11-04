import { type Enforcement, enforcementProblems } from './enforcement.js';
import type { NonEmpty } from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  isUsableKey,
  ownEntries,
  ownMember,
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  nestedPosition,
  ROOT_POSITION,
  type ValidationProblem,
} from './problems.js';

/** A principal presenting no credential: the anonymous visitor. */
interface NoCredentialPrincipal {
  credential: 'none';
  openTierOnly: true;
  suspended: false;
}

/**
 * A principal presenting a credential not confirmed by the bridge, served only while suspended and
 * carrying no subject.
 */
interface UnconfirmedPrincipal {
  credential: 'unconfirmed';
  openTierOnly: true;
  suspended: true;
}

/** A principal whose confirmed credential's grants hold. */
interface ConfirmedPrincipal {
  credential: 'confirmed';

  /**
   * Whether the results hold the open tier alone. It never says whether anything was withheld from a
   * result.
   */
  openTierOnly: boolean;

  /**
   * The identity vouched for by the controller, for log events and for decisions about its own
   * data.
   */
  subject: string;

  suspended: false;
}

/** A principal whose confirmed credential's grants are on hold. */
interface SuspendedPrincipal {
  /**
   * The identity vouched for by the controller, for attribution in log events alone and never a
   * basis for any decision.
   */
  attributionOnlySubject: string;

  credential: 'confirmed';
  openTierOnly: true;
  suspended: true;
}

/**
 * Who a request is served as, told apart by `credential`:
 * - `none`: no credential is presented;
 * - `unconfirmed`: the credential presented is not confirmed by the bridge;
 * - `confirmed`: the controller vouched for the credential's subject.
 *
 * A confirmed principal is also told apart by `suspended`. Only one whose grants hold carries
 * `subject`, so the type gives access to `subject` only once `suspended` is known to be false. A
 * suspended one carries `attributionOnlySubject` instead.
 */
export type UsherPrincipal =
  | ConfirmedPrincipal
  | NoCredentialPrincipal
  | SuspendedPrincipal
  | UnconfirmedPrincipal;

/**
 * A request's access, the same from every bridge: plain, JSON-shaped data carrying decisions,
 * never the token, the payload or the grants behind them.
 */
export interface UsherRequestAccess {
  principal: UsherPrincipal;

  /** One enforcement result for each key registered by the adapter. */
  results: Record<string, Enforcement>;

  /** The shape's version: a value carrying any other version has another shape. */
  version: 1;
}

/**
 * The result of {@link validateRequestAccess}: a copy of the value's own data, typed, when it holds
 * to version 1, and otherwise every problem found, each value-free.
 */
export type RequestAccessValidationResult =
  | { access: UsherRequestAccess; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/** The wording of every rule held by {@link validateRequestAccess}, keyed by a stable name. */
export const REQUEST_ACCESS_RULES = {
  attributionOnlySubject:
    'attributionOnlySubject is a non-empty string, naming a suspended confirmed principal for attribution alone',
  credential: 'credential is none, unconfirmed or confirmed',
  isMap: 'request access is a map of principal, results and version',
  members: 'request access carries only principal, results and version',
  noCredentialNeverSuspended:
    'a principal presenting no credential is never suspended',
  openTierOnlyIsBoolean: 'openTierOnly is a boolean',
  principalIsMap:
    "principal is a map of credential, openTierOnly and suspended, and a confirmed principal's subject",
  principalMembers:
    'a principal carries credential, openTierOnly and suspended, and once confirmed its subject: subject while its grants hold, attributionOnlySubject while suspended',
  resultKey: 'a result key is a non-empty string other than __proto__',
  results: 'results is a map holding at least one enforcement result',
  subject:
    'subject is a non-empty string, naming a confirmed principal whose grants hold',
  suspendedIsBoolean: 'suspended is a boolean',
  suspendedServesOpenTier:
    'a suspended principal is served the open tier alone, so it is marked openTierOnly',
  unconfirmedOpenTierOnly:
    'a principal without a confirmed credential holds only the open tier, so it is marked openTierOnly',
  unconfirmedServedSuspended:
    'a credential not confirmed by the bridge is served only while suspended',
  version: 'version is present and is the number 1',
} as const;

const ACCESS_MEMBERS: ReadonlySet<string> = new Set(
  Object.keys({
    principal: true,
    results: true,
    version: true,
  } satisfies Readonly<Record<keyof UsherRequestAccess, true>>),
);

const CREDENTIAL_STATES: ReadonlySet<unknown> = new Set(
  Object.keys({
    confirmed: true,
    none: true,
    unconfirmed: true,
  } satisfies Readonly<Record<UsherPrincipal['credential'], true>>),
);

const SHARED_MEMBERS = Object.keys({
  credential: true,
  openTierOnly: true,
  suspended: true,
} satisfies Readonly<Record<keyof UsherPrincipal, true>>);

const SUBJECT_MEMBER = Object.freeze({
  inForce: 'subject',
  suspended: 'attributionOnlySubject',
} satisfies Readonly<
  Record<
    'inForce' | 'suspended',
    keyof ConfirmedPrincipal | keyof SuspendedPrincipal
  >
>);

const subjectMemberOf = (
  credential: unknown,
  suspended: unknown,
): string | undefined => {
  if (credential === 'confirmed' && suspended === false) {
    return SUBJECT_MEMBER.inForce;
  }
  if (credential === 'confirmed' && suspended === true) {
    return SUBJECT_MEMBER.suspended;
  }
  return undefined;
};

const RESULT_POSITION = 'results.<key>';

const principalProblems = (
  principal: unknown,
): readonly ValidationProblem[] => {
  if (isPlainRecord(principal)) {
    const credential = ownMember(principal, 'credential');
    const openTierOnly = ownMember(principal, 'openTierOnly');
    const suspended = ownMember(principal, 'suspended');
    const subjectMember = subjectMemberOf(credential, suspended);
    const confirmed = credential === 'confirmed';

    return [
      ...brokenRules('principal', [
        [
          hasOnlyMembers(
            principal,
            new Set(
              subjectMember === undefined
                ? SHARED_MEMBERS
                : [...SHARED_MEMBERS, subjectMember],
            ),
          ),
          REQUEST_ACCESS_RULES.principalMembers,
        ],
      ]),
      ...brokenRules('principal.credential', [
        [CREDENTIAL_STATES.has(credential), REQUEST_ACCESS_RULES.credential],
      ]),
      ...brokenRules('principal.openTierOnly', [
        [
          typeof openTierOnly === 'boolean',
          REQUEST_ACCESS_RULES.openTierOnlyIsBoolean,
        ],
        [
          confirmed || openTierOnly === true,
          REQUEST_ACCESS_RULES.unconfirmedOpenTierOnly,
        ],
      ]),
      ...(subjectMember === undefined
        ? []
        : brokenRules(`principal.${subjectMember}`, [
            [
              isNonEmptyString(ownMember(principal, subjectMember)),
              subjectMember === SUBJECT_MEMBER.inForce
                ? REQUEST_ACCESS_RULES.subject
                : REQUEST_ACCESS_RULES.attributionOnlySubject,
            ],
          ])),
      ...brokenRules('principal.suspended', [
        [
          typeof suspended === 'boolean',
          REQUEST_ACCESS_RULES.suspendedIsBoolean,
        ],
        [
          credential === 'none' ? suspended === false : true,
          REQUEST_ACCESS_RULES.noCredentialNeverSuspended,
        ],
        [
          credential === 'unconfirmed' ? suspended === true : true,
          REQUEST_ACCESS_RULES.unconfirmedServedSuspended,
        ],
        [
          suspended === true ? openTierOnly === true : true,
          REQUEST_ACCESS_RULES.suspendedServesOpenTier,
        ],
      ]),
    ];
  }

  return [{ position: 'principal', rule: REQUEST_ACCESS_RULES.principalIsMap }];
};

const resultsProblems = (results: unknown): readonly ValidationProblem[] => {
  const entries = ownEntries(results);

  if (entries !== undefined && entries.length > 0) {
    return entries.flatMap(([key, result]) => [
      ...brokenRules(RESULT_POSITION, [
        [isUsableKey(key), REQUEST_ACCESS_RULES.resultKey],
      ]),
      ...enforcementProblems(result).map(({ position, rule }) => ({
        position: nestedPosition(RESULT_POSITION, position),
        rule,
      })),
    ]);
  }

  return [{ position: 'results', rule: REQUEST_ACCESS_RULES.results }];
};

const requestAccessProblems = (
  value: unknown,
): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    // Version 1 says how to read the rest, so a value of any other version is read no further.
    return ownMember(value, 'version') === 1
      ? [
          ...brokenRules(ROOT_POSITION, [
            [
              hasOnlyMembers(value, ACCESS_MEMBERS),
              REQUEST_ACCESS_RULES.members,
            ],
          ]),
          ...principalProblems(ownMember(value, 'principal')),
          ...resultsProblems(ownMember(value, 'results')),
        ]
      : [{ position: 'version', rule: REQUEST_ACCESS_RULES.version }];
  }

  return [{ position: ROOT_POSITION, rule: REQUEST_ACCESS_RULES.isMap }];
};

/**
 * Validates a request's access against version 1, never throwing, whatever `value` is. A value of
 * any other version is refused for its version alone and read no further. A value of version 1 is
 * accepted only when:
 * - the root carries `principal`, `results` and `version` and nothing else;
 * - the principal carries `credential`, `openTierOnly` and `suspended` and nothing else, besides a
 *   non-empty `subject` when confirmed and not suspended, or a non-empty `attributionOnlySubject`
 *   when confirmed and suspended;
 * - a principal presenting no credential is never suspended, an unconfirmed one is always
 *   suspended, and both are marked open-tier only;
 * - a suspended principal is marked open-tier only;
 * - `results` is a non-empty map whose every key is neither empty nor `__proto__` and whose every
 *   entry passes `validateEnforcement`.
 *
 * @param value a request's access, untrusted.
 * @returns a copy of the value's own data, typed, which is exactly what was checked, or every
 *   problem found, none naming content of the value.
 */
export const validateRequestAccess = (
  value: unknown,
): RequestAccessValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, requestAccessProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { access: snapshot as UsherRequestAccess, success: true };
};

/**
 * The enforcement result held in `access` for `key`, or `undefined` when it holds none. Only an own
 * member is read, so a key named like a member of `Object.prototype`, such as `constructor`, finds
 * nothing rather than a function.
 *
 * @param key a key registered by the adapter.
 */
export const resultFor = (
  access: UsherRequestAccess,
  key: string,
): Enforcement | undefined =>
  Object.hasOwn(access.results, key) ? access.results[key] : undefined;

/**
 * The subject naming `principal` in a log event, whatever its state: the subject of a confirmed
 * principal, suspended or not, or `null` for a principal without a confirmed credential. `null`
 * alone does not tell `none` from `unconfirmed`; `principal.credential` does. A suspended
 * principal carries no `subject`, so the value returned for it is its `attributionOnlySubject`,
 * fit for attribution alone.
 */
export const subjectToLog = (principal: UsherPrincipal): string | null => {
  if (principal.credential === 'confirmed') {
    return principal.suspended
      ? principal.attributionOnlySubject
      : principal.subject;
  }
  return null;
};
