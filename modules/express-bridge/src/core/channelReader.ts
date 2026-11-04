import {
  type NonEmpty,
  type Notice,
  type PollAnswer,
  validateNotice,
  validatePollAnswer,
} from '@overture-stack/usher-types';
import { compactDecrypt, decodeProtectedHeader } from 'jose';

import type { BridgeEventData } from './events.js';
import type { CryptoKey } from './keys.js';

type MalformedReason = BridgeEventData['revocationChannel.malformed']['reason'];

/** What reading a pushed notice resolves to. */
export type NoticeReading =
  | { kind: 'malformed'; reason: MalformedReason }
  | { kind: 'notice'; notice: Notice };

/** What reading a poll answer resolves to. */
export type PollAnswerReading =
  | { answer: PollAnswer; kind: 'answer' }
  | { kind: 'malformed'; reason: MalformedReason };

/** Reads what the channel carries, from its header to the `usher-types` validator. */
export interface ChannelReader {
  readNotice(jwe: string): Promise<NoticeReading>;
  readPollAnswer(jwe: string): Promise<PollAnswerReading>;
}

/** The notice versions that can be read; a notice in any other is `versionUnlisted`. */
export const NOTICE_VERSIONS: Readonly<NonEmpty<number>> = Object.freeze([
  1,
] as const);

const NOTICE_TYPE = 'usher-notice+jwt';
const POLL_ANSWER_TYPE = 'usher-poll+jwt';

/** The only protected header members allowed on a notice or a poll answer, as on the Usher token. */
const HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'enc', 'typ']);

const PLAINTEXT = new TextDecoder('utf-8', { fatal: true });

const malformed = (
  reason: MalformedReason,
): { kind: 'malformed'; reason: MalformedReason } => ({
  kind: 'malformed',
  reason,
});

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * Whether `value` has an own `v` outside {@link NOTICE_VERSIONS}. A value that is not a map, or has
 * no own `v`, is left for the validator to refuse.
 */
const namesUnlistedVersion = (value: unknown): boolean =>
  isObject(value) &&
  Object.hasOwn(value, 'v') &&
  !NOTICE_VERSIONS.some((listed) => listed === value['v']);

/**
 * Decrypts one compact JWE of type `type` to its parsed plaintext, or `undefined` for any failure.
 * No error leaves it, since jose's and `JSON.parse`'s messages can quote the plaintext.
 */
const decrypted = async (
  jwe: string,
  type: string,
  key: CryptoKey,
): Promise<{ value: unknown } | undefined> => {
  try {
    const header = decodeProtectedHeader(jwe);
    // The header is checked before jose reads anything else, as for the Usher token.
    const isExpectedHeader =
      header.typ === type &&
      Object.keys(header).every((member) => HEADER_MEMBERS.has(member));
    if (isExpectedHeader) {
      // `compactDecrypt`, never `jwtDecrypt`: the plaintext is checked by the `usher-types`
      // validator, not as JWT claims. A `maxDecompressedLength` of 0 refuses any compressed JWE.
      const { plaintext } = await compactDecrypt(jwe, key, {
        contentEncryptionAlgorithms: ['A256GCM'],
        keyManagementAlgorithms: ['dir'],
        maxDecompressedLength: 0,
      });
      return { value: JSON.parse(PLAINTEXT.decode(plaintext)) as unknown };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** What the channel reader needs: the two subkeys derived from the application key. */
export interface ChannelReaderOptions {
  /** Decrypts pushed notices: AES-GCM under the notice subkey. */
  noticeKey: CryptoKey;

  /** Decrypts poll answers: AES-GCM under the poll-answer subkey. */
  pollAnswerKey: CryptoKey;
}

/**
 * Creates the channel reader, which reads a pushed notice or a poll answer by the Usher token's
 * rules. Each read resolves to the value read or to a fixed reason, and no error, plaintext or
 * member leaves it.
 *
 * - `typ` must be exactly `usher-notice+jwt` or `usher-poll+jwt`, and the protected header may carry
 *   only `alg`, `enc` and `typ`.
 * - Each is decrypted under its own subkey, with only `dir` and A256GCM accepted and no compression.
 * - A notice in a version not listed in {@link NOTICE_VERSIONS}, alone or inside a poll answer, is
 *   `versionUnlisted`.
 * - Every other failure is `noticeUnreadable` or `answerUnreadable`.
 */
export const createChannelReader = ({
  noticeKey,
  pollAnswerKey,
}: ChannelReaderOptions): ChannelReader => ({
  readNotice: async (jwe) => {
    const read = await decrypted(jwe, NOTICE_TYPE, noticeKey);
    if (read === undefined) {
      return malformed('noticeUnreadable');
    }
    if (namesUnlistedVersion(read.value)) {
      return malformed('versionUnlisted');
    }
    const result = validateNotice(read.value);
    return result.success
      ? { kind: 'notice', notice: result.notice }
      : malformed('noticeUnreadable');
  },

  readPollAnswer: async (jwe) => {
    const read = await decrypted(jwe, POLL_ANSWER_TYPE, pollAnswerKey);
    if (read === undefined) {
      return malformed('answerUnreadable');
    }
    const notices =
      isObject(read.value) && Object.hasOwn(read.value, 'notices')
        ? read.value['notices']
        : undefined;
    if (Array.isArray(notices) && notices.some(namesUnlistedVersion)) {
      return malformed('versionUnlisted');
    }
    const result = validatePollAnswer(read.value);
    return result.success
      ? { answer: result.answer, kind: 'answer' }
      : malformed('answerUnreadable');
  },
});
