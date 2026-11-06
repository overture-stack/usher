import { createHmac, type KeyObject } from 'node:crypto';

import type { Notice, PollAnswer } from '@overture-stack/usher-types';
import { CompactEncrypt } from 'jose';

import type { ChannelKey, StoredNotice } from './types.js';

/** The request header listing the notice versions a bridge reads, comma-separated. */
export const NOTICE_VERSIONS_HEADER = 'usher-notice-versions';

/** The one notice version the controller serves. */
export const SERVED_NOTICE_VERSION = 1;

/** The `typ` of a pushed notice. */
export const NOTICE_TYPE = 'usher-notice+jwt';

/** The `typ` of a poll answer. */
export const POLL_ANSWER_TYPE = 'usher-poll+jwt';

/**
 * A comment alone, which keeps a stream's connection open and carries no notice: the stream's first
 * byte, and its heartbeat.
 */
export const HEARTBEAT = ':\n\n';

const PLAINTEXT_ENCODER = new TextEncoder();

/**
 * Whether a notice versions header lists the version served: its comma-separated entries, each with
 * the spaces around it left out, holding `1` exactly. An absent header lists none.
 *
 * @param header the header's value, as received.
 */
export const listsServedVersion = (header: string | undefined): boolean =>
  (header ?? '')
    .split(',')
    .some((listed) => listed.trim() === String(SERVED_NOTICE_VERSION));

/**
 * Whether an audience receives a notice: every principal, baseline and global notice; a
 * servedResources notice naming it; and a category notice whose resource it served when the notice
 * was read.
 *
 * @param notice the notice, as read.
 * @param applicationId the audience's id.
 */
export const reaches = (
  notice: StoredNotice,
  applicationId: string,
): boolean => {
  if (notice.kind === 'servedResources') {
    return notice.audience === applicationId;
  }
  return notice.kind === 'category'
    ? notice.servedBy.includes(applicationId)
    : true;
};

/**
 * A subject's tag for one audience: HMAC-SHA256 of the subject under that audience's subject-tag
 * subkey, base64url without padding, as the bridge computes it for the subjects it holds.
 *
 * @param key the subject-tag subkey.
 * @param subject the identity provider's subject.
 */
export const subjectTag = (key: KeyObject, subject: string): string =>
  createHmac('sha256', key).update(subject, 'utf8').digest('base64url');

/**
 * A notice as version 1 carries it to one audience: its kind and cursor, the subject's tag on a
 * principal notice, and the resource on a category notice, nothing else.
 *
 * @param notice the notice, as read.
 * @param cursor the cursor of its place.
 * @param key the audience's key answering the request.
 */
export const noticeOf = (
  notice: StoredNotice,
  cursor: string,
  key: Pick<ChannelKey, 'subjectTag'>,
): Notice => {
  if (notice.kind === 'principal') {
    return {
      cursor,
      kind: 'principal',
      subjectTag: subjectTag(key.subjectTag, notice.subject),
      v: SERVED_NOTICE_VERSION,
    };
  }
  if (notice.kind === 'category') {
    return {
      cursor,
      kind: 'category',
      resource: notice.resource,
      v: SERVED_NOTICE_VERSION,
    };
  }
  return { cursor, kind: notice.kind, v: SERVED_NOTICE_VERSION };
};

const encrypted = (
  plaintext: object,
  typ: string,
  key: KeyObject,
): Promise<string> =>
  new CompactEncrypt(PLAINTEXT_ENCODER.encode(JSON.stringify(plaintext)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ })
    .encrypt(key);

/**
 * A poll answer as its body carries it: a compact JWE under `dir` and A256GCM, typed
 * `usher-poll+jwt`, under the poll-answer subkey of the key answering the request.
 *
 * @param answer the answer's plaintext.
 * @param key the key answering the request.
 */
export const sealedPollAnswer = (
  answer: PollAnswer,
  key: Pick<ChannelKey, 'pollAnswer'>,
): Promise<string> => encrypted(answer, POLL_ANSWER_TYPE, key.pollAnswer);

/**
 * One notice as a stream's event: named `notice`, its `id` the notice's cursor and its `data` a
 * compact JWE under `dir` and A256GCM, typed `usher-notice+jwt`, under the notice subkey of the key
 * answering the request.
 *
 * @param notice the notice as version 1 carries it.
 * @param key the key answering the request.
 */
export const noticeEvent = async (
  notice: Notice,
  key: Pick<ChannelKey, 'notice'>,
): Promise<string> =>
  `id: ${notice.cursor}\nevent: notice\ndata: ${await encrypted(notice, NOTICE_TYPE, key.notice)}\n\n`;
