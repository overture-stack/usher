import assert from 'node:assert/strict';
import {
  createHmac,
  createSecretKey,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { suite, test } from 'node:test';

import {
  validateNotice,
  validatePollAnswer,
} from '@overture-stack/usher-types';
import { compactDecrypt, decodeProtectedHeader } from 'jose';

import { applicationSubkeys } from '../applicationKeyRing/index.js';
import type { StoredNotice } from './types.js';
import {
  HEARTBEAT,
  listsServedVersion,
  noticeEvent,
  noticeOf,
  reaches,
  sealedPollAnswer,
} from './wireFormat.js';

const AUDIENCE = randomUUID();

const OTHER_AUDIENCE = randomUUID();

const KEY_BYTES = randomBytes(32);

const KEY = applicationSubkeys(KEY_BYTES);

// A subkey as the bridge derives it from the application key's bytes.
const bridgeSubkey = (label: string): Uint8Array =>
  new Uint8Array(hkdfSync('sha256', KEY_BYTES, Buffer.alloc(0), label, 32));

const BASE = { createdAt: 1_000n, position: 7n };

const NOTICES: readonly StoredNotice[] = [
  { ...BASE, kind: 'baseline' },
  { ...BASE, kind: 'global' },
  {
    ...BASE,
    kind: 'principal',
    subject: 'a3f9c2e1-0d4b-4e8a-9c7f-2b6d1e5a8f30',
  },
  {
    ...BASE,
    kind: 'category',
    resource: 'STUDY-A1',
    servedBy: [AUDIENCE],
  },
  { ...BASE, audience: AUDIENCE, kind: 'servedResources' },
];

const plaintextOf = async (jwe: string, label: string): Promise<unknown> =>
  JSON.parse(
    new TextDecoder().decode(
      (await compactDecrypt(jwe, bridgeSubkey(label))).plaintext,
    ),
  ) as unknown;

suite('the notice versions header', () => {
  test('lists the version served when any entry, spaces around it left out, is 1', () => {
    ['1', '1,2', ' 1 , 2 ', '2,1', '2, 1'].forEach((header) => {
      assert.equal(listsServedVersion(header), true, header);
    });
  });

  test('lists no version served when absent, empty, or naming 1 only in another form', () => {
    [undefined, '', '2', 'abc', '1.0', 'v1', '01', '12'].forEach((header) => {
      assert.equal(listsServedVersion(header), false, String(header));
    });
  });
});

suite('which audiences a notice reaches', () => {
  test('reaches every audience with a principal, baseline or global notice', () => {
    NOTICES.filter(({ kind }) =>
      ['baseline', 'global', 'principal'].includes(kind),
    ).forEach((notice) => {
      assert.equal(reaches(notice, OTHER_AUDIENCE), true, notice.kind);
    });
  });

  test('reaches only the audiences serving its resource with a category notice, and only the audience named with a servedResources notice', () => {
    const [, , , category, served] = NOTICES;

    assert.deepEqual(
      [category, served].map((notice) =>
        notice === undefined
          ? []
          : [reaches(notice, AUDIENCE), reaches(notice, OTHER_AUDIENCE)],
      ),
      [
        [true, false],
        [true, false],
      ],
    );
  });
});

suite('a notice as version 1 carries it', () => {
  test('carries exactly the members its kind defines, each valid as the bridge validates it', () => {
    const notices = NOTICES.map((notice) => noticeOf(notice, 'cursor-7', KEY));

    assert.deepEqual(
      notices.map((notice) => Object.keys(notice).toSorted()),
      [
        ['cursor', 'kind', 'v'],
        ['cursor', 'kind', 'v'],
        ['cursor', 'kind', 'subjectTag', 'v'],
        ['cursor', 'kind', 'resource', 'v'],
        ['cursor', 'kind', 'v'],
      ],
    );
    notices.forEach((notice) => {
      assert.equal(validateNotice(notice).success, true);
    });
  });

  test("names a principal by the tag the audience's bridge computes for the subject, never by the subject", () => {
    const subject = 'a3f9c2e1-0d4b-4e8a-9c7f-2b6d1e5a8f30';
    const expected = createHmac(
      'sha256',
      createSecretKey(bridgeSubkey('usher/v1/subject-tag')),
    )
      .update(subject)
      .digest('base64url');

    const notice = noticeOf(
      { ...BASE, kind: 'principal', subject },
      'cursor-7',
      KEY,
    );

    assert.deepEqual(notice, {
      cursor: 'cursor-7',
      kind: 'principal',
      subjectTag: expected,
      v: 1,
    });
    assert.equal(JSON.stringify(notice).includes(subject), false);
  });
});

suite('what the channel encrypts', () => {
  test("seals a poll answer as a compact JWE typed usher-poll+jwt that the bridge's poll-answer subkey opens", async () => {
    const answer = {
      after: 'head',
      more: false,
      next: 'cursor-8',
      nonce: 'AbCdEfGhIjKlMnOp',
      notices: NOTICES.map((notice) => noticeOf(notice, 'cursor-7', KEY)),
      v: 1 as const,
    };

    const sealed = await sealedPollAnswer(answer, KEY);

    assert.deepEqual(decodeProtectedHeader(sealed), {
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'usher-poll+jwt',
    });
    const opened = await plaintextOf(sealed, 'usher/v1/poll-answer');
    assert.deepEqual(opened, answer);
    assert.equal(validatePollAnswer(opened).success, true);
  });

  test("frames a notice as one event named notice, its id the cursor and its data a compact JWE typed usher-notice+jwt that the bridge's notice subkey opens", async () => {
    const notice = noticeOf(
      { ...BASE, kind: 'category', resource: 'STUDY-A1', servedBy: [AUDIENCE] },
      'cursor-7',
      KEY,
    );

    const event = await noticeEvent(notice, KEY);

    const lines = event.split('\n');
    assert.deepEqual(lines.slice(0, 2), ['id: cursor-7', 'event: notice']);
    assert.deepEqual(lines.slice(3), ['', '']);
    const data = lines[2]?.replace(/^data: /u, '') ?? '';
    assert.match(data, /^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/u);
    assert.deepEqual(decodeProtectedHeader(data), {
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'usher-notice+jwt',
    });
    assert.deepEqual(
      await plaintextOf(data, 'usher/v1/notice-encryption'),
      notice,
    );
  });

  test('keeps a heartbeat to a comment alone, which carries no field', () => {
    assert.equal(HEARTBEAT, ':\n\n');
  });
});
