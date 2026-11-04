import type { NonEmpty } from './payload.js';
import {
  hasOnlyMembers,
  isNonEmptyString,
  isPlainRecord,
  listEntries,
  ownMember,
} from './plainData.js';
import {
  brokenRules,
  checkSnapshot,
  nestedPosition,
  ROOT_POSITION,
  type ValidationProblem,
} from './problems.js';
import { isUsableResource } from './sqonPrimitives.js';

/** One decrypted entry of the notice stream. */
export type Notice =
  /** A change to the baseline, invalidating every cached entry. */
  | { cursor: string; kind: 'baseline'; v: 1 }
  /** A category change, naming the resource as it is named by a payload's `permissions` keys. */
  | { cursor: string; kind: 'category'; resource: string; v: 1 }
  /** A global change, invalidating every cached entry. */
  | { cursor: string; kind: 'global'; v: 1 }
  /** A principal's revocation or sign-out, naming the subject by its tag. */
  | { cursor: string; kind: 'principal'; subjectTag: string; v: 1 }
  /**
   * A change to the audience's served set, the payload's `servedResources`, invalidating every
   * cached entry as a baseline change does.
   */
  | { cursor: string; kind: 'servedResources'; v: 1 };

/** A decrypted poll answer. */
export interface PollAnswer {
  /** The cursor the poll continued from, or `head`, echoed so a rewritten request is caught. */
  after: string;

  /** Whether a page limit cut the answer short, leaving further notices after `next`. */
  more: boolean;

  /** The cursor of the last notice returned, or `head` when there is none. */
  next: string;

  /** The nonce the poll sent, echoed so an old answer cannot stand in for a new one. */
  nonce: string;

  notices: Notice[];

  v: 1;
}

/** The outcome of {@link validateNotice}. */
export type NoticeValidationResult =
  | { notice: Notice; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/** The outcome of {@link validatePollAnswer}. */
export type PollAnswerValidationResult =
  | { answer: PollAnswer; success: true }
  | { problems: NonEmpty<ValidationProblem>; success: false };

/**
 * The wording of every rule held by {@link validateNotice}, keyed by a stable name, to match
 * against each problem's `rule`.
 */
export const NOTICE_RULES = {
  cursor: 'cursor is a non-empty string',
  isMap: 'a notice is a map',
  kind: 'kind is principal, category, baseline, global or servedResources',
  members: 'a notice carries only the members defined for its kind',
  resource:
    'a category notice names its resource, a non-empty string other than __proto__, holding no marker read specially by Arranger',
  subjectTag: 'a principal notice names its subject tag, a non-empty string',
  version: 'v is present and is the number 1',
} as const;

/**
 * The wording of every rule held by {@link validatePollAnswer}, keyed by a stable name, to match
 * against each problem's `rule`.
 */
export const POLL_ANSWER_RULES = {
  after: 'after is a non-empty string',
  isMap: 'a poll answer is a map',
  members: 'a poll answer carries only v, nonce, after, notices, next and more',
  more: 'more is a boolean',
  next: 'next is a non-empty string',
  nonce: 'nonce is a non-empty string',
  notices: 'notices is a list',
  version: 'v is present and is the number 1',
} as const;

/** The members of each kind of notice, looked up through a `Map` so an inherited name is never a kind. */
const MEMBERS_BY_KIND: ReadonlyMap<unknown, ReadonlySet<string>> = new Map(
  Object.entries({
    baseline: new Set(['cursor', 'kind', 'v']),
    category: new Set(['cursor', 'kind', 'resource', 'v']),
    global: new Set(['cursor', 'kind', 'v']),
    principal: new Set(['cursor', 'kind', 'subjectTag', 'v']),
    servedResources: new Set(['cursor', 'kind', 'v']),
  } satisfies Readonly<Record<Notice['kind'], ReadonlySet<string>>>),
);

const POLL_ANSWER_MEMBERS: ReadonlySet<string> = new Set(
  Object.keys({
    after: true,
    more: true,
    next: true,
    nonce: true,
    notices: true,
    v: true,
  } satisfies Readonly<Record<keyof PollAnswer, true>>),
);

const versionOneNoticeProblems = (
  value: Readonly<Record<string, unknown>>,
): readonly ValidationProblem[] => {
  const kind = ownMember(value, 'kind');
  const members = MEMBERS_BY_KIND.get(kind);

  if (members) {
    return [
      ...brokenRules(ROOT_POSITION, [
        [hasOnlyMembers(value, members), NOTICE_RULES.members],
      ]),
      ...brokenRules('cursor', [
        [isNonEmptyString(ownMember(value, 'cursor')), NOTICE_RULES.cursor],
      ]),
      ...(kind === 'category'
        ? brokenRules('resource', [
            [
              isUsableResource(ownMember(value, 'resource')),
              NOTICE_RULES.resource,
            ],
          ])
        : []),
      ...(kind === 'principal'
        ? brokenRules('subjectTag', [
            [
              isNonEmptyString(ownMember(value, 'subjectTag')),
              NOTICE_RULES.subjectTag,
            ],
          ])
        : []),
    ];
  }

  return [{ position: 'kind', rule: NOTICE_RULES.kind }];
};

const noticeProblems = (value: unknown): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    return ownMember(value, 'v') === 1
      ? versionOneNoticeProblems(value)
      : [{ position: 'v', rule: NOTICE_RULES.version }];
  }

  return [{ position: ROOT_POSITION, rule: NOTICE_RULES.isMap }];
};

const versionOnePollAnswerProblems = (
  value: Readonly<Record<string, unknown>>,
): readonly ValidationProblem[] => {
  const notices = listEntries(ownMember(value, 'notices'));

  return [
    ...brokenRules(ROOT_POSITION, [
      [hasOnlyMembers(value, POLL_ANSWER_MEMBERS), POLL_ANSWER_RULES.members],
    ]),
    ...brokenRules('nonce', [
      [isNonEmptyString(ownMember(value, 'nonce')), POLL_ANSWER_RULES.nonce],
    ]),
    ...brokenRules('after', [
      [isNonEmptyString(ownMember(value, 'after')), POLL_ANSWER_RULES.after],
    ]),
    ...brokenRules('next', [
      [isNonEmptyString(ownMember(value, 'next')), POLL_ANSWER_RULES.next],
    ]),
    ...brokenRules('more', [
      [typeof ownMember(value, 'more') === 'boolean', POLL_ANSWER_RULES.more],
    ]),
    ...(notices
      ? notices.flatMap((notice, index) =>
          noticeProblems(notice).map(({ position, rule }) => ({
            position: nestedPosition(`notices[${index}]`, position),
            rule,
          })),
        )
      : [{ position: 'notices', rule: POLL_ANSWER_RULES.notices }]),
  ];
};

const pollAnswerProblems = (value: unknown): readonly ValidationProblem[] => {
  if (isPlainRecord(value)) {
    return ownMember(value, 'v') === 1
      ? versionOnePollAnswerProblems(value)
      : [{ position: 'v', rule: POLL_ANSWER_RULES.version }];
  }

  return [{ position: ROOT_POSITION, rule: POLL_ANSWER_RULES.isMap }];
};

/**
 * Validates a decrypted notice against version 1: a known kind carrying exactly the members defined
 * for it, a non-empty cursor, a subject tag on a principal notice, and on a category notice a
 * resource that is neither empty nor `__proto__` and holds no marker read specially by Arranger. A
 * notice of any other version is read no further. Never throws, whatever `value` is.
 *
 * @param value a decrypted notice, untrusted.
 * @returns a copy of the notice's own data, or every problem found, none naming its content.
 */
export const validateNotice = (value: unknown): NoticeValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, noticeProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { notice: snapshot as Notice, success: true };
};

/**
 * Validates a decrypted poll answer against version 1: exactly its six members, a non-empty nonce,
 * `after` and `next`, a boolean `more`, and a list of notices each valid under
 * {@link validateNotice}. An answer of any other version is read no further. Never throws, whatever
 * `value` is.
 *
 * @param value a decrypted poll answer, untrusted.
 * @returns a copy of the answer's own data, or every problem found, none naming its content.
 */
export const validatePollAnswer = (
  value: unknown,
): PollAnswerValidationResult => {
  const {
    problems: [firstProblem, ...otherProblems],
    snapshot,
  } = checkSnapshot(value, pollAnswerProblems);

  return firstProblem
    ? { problems: [firstProblem, ...otherProblems], success: false }
    : { answer: snapshot as PollAnswer, success: true };
};
