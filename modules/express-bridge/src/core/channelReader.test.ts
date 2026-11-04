import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createChannelReader, NOTICE_VERSIONS } from './channelReader.js';
import { importApplicationKey, SUBKEY_LABELS } from './keys.js';
import {
  mintNotice,
  mintPollAnswer,
  subkeyBytes,
  TEST_KEY,
  TEST_KEY_BYTES,
} from './testTokens.js';

const PRINCIPAL = {
  cursor: 'c-42',
  kind: 'principal',
  subjectTag: 'tag-ana',
  v: 1,
};
const CATEGORY = {
  cursor: 'c-43',
  kind: 'category',
  resource: 'HEART_STUDY',
  v: 1,
};

const answerWith = (members: Record<string, unknown> = {}) => ({
  after: 'c-41',
  more: false,
  next: 'c-43',
  nonce: 'nonce-1',
  notices: [PRINCIPAL, CATEGORY],
  v: 1,
  ...members,
});

const reader = async () => {
  const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
  return createChannelReader({ noticeKey, pollAnswerKey });
};

const noticeReasonFor = async (jwe: string): Promise<unknown> => {
  const reading = await (await reader()).readNotice(jwe);
  return reading.kind === 'malformed' ? reading.reason : 'read';
};

const answerReasonFor = async (jwe: string): Promise<unknown> => {
  const reading = await (await reader()).readPollAnswer(jwe);
  return reading.kind === 'malformed' ? reading.reason : 'read';
};

/** A JSON plaintext with one byte that is not UTF-8 inside a string, where a lenient decoder would put U+FFFD. */
const withInvalidByte = (value: object, marker: string): Uint8Array => {
  const bytes = Buffer.from(JSON.stringify(value));
  bytes[bytes.indexOf(marker)] = 0xff;
  return new Uint8Array(bytes);
};

suite('createChannelReader', () => {
  test('lists notice version 1 alone, frozen', () => {
    assert.deepEqual(NOTICE_VERSIONS, [1]);
    assert.equal(Object.isFrozen(NOTICE_VERSIONS), true);
  });

  suite('readNotice', () => {
    for (const notice of [
      PRINCIPAL,
      CATEGORY,
      { cursor: 'c-44', kind: 'baseline', v: 1 },
      { cursor: 'c-45', kind: 'global', v: 1 },
      { cursor: 'c-46', kind: 'servedResources', v: 1 },
    ]) {
      test(`reads a ${notice.kind} notice the controller minted`, async () => {
        const reading = await (
          await reader()
        ).readNotice(await mintNotice(notice));

        assert.deepEqual(reading, { kind: 'notice', notice });
      });
    }

    for (const [description, typ] of [
      ["the poll answer's typ", 'usher-poll+jwt'],
      ["the Usher token's typ", 'usher+jwt'],
      ['a typ differing only in case', 'USHER-NOTICE+JWT'],
      ['a typ with the media-type prefix', 'application/usher-notice+jwt'],
    ] as const) {
      test(`refuses ${description} as noticeUnreadable, though it decrypts`, async () => {
        const jwe = await mintNotice(PRINCIPAL, { header: { typ } });

        assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
      });
    }

    for (const [description, header] of [
      ['a cty', { cty: 'JSON' }],
      ['a kid, which joins only with rotation', { kid: 'k1' }],
    ] as const) {
      test(`refuses a header carrying ${description} as noticeUnreadable, though it decrypts`, async () => {
        const jwe = await mintNotice(PRINCIPAL, { header });

        assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
      });
    }

    for (const [description, key] of [
      ['the poll-answer subkey', subkeyBytes(SUBKEY_LABELS.pollAnswer)],
      ['the application key itself', TEST_KEY_BYTES],
      [
        "another application's notice subkey",
        subkeyBytes(SUBKEY_LABELS.notice, new Uint8Array(32).fill(9)),
      ],
    ] as const) {
      test(`refuses a notice under ${description} as noticeUnreadable`, async () => {
        const jwe = await mintNotice(PRINCIPAL, { key });

        assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
      });
    }

    test('refuses a key-wrapping algorithm as noticeUnreadable', async () => {
      const jwe = await mintNotice(PRINCIPAL, { header: { alg: 'A256KW' } });

      assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
    });

    test('refuses another content encryption with a key of the same length as noticeUnreadable', async () => {
      const jwe = await mintNotice(PRINCIPAL, {
        header: { enc: 'A128CBC-HS256' },
      });

      assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
    });

    test('refuses altered ciphertext as noticeUnreadable', async () => {
      const parts = (await mintNotice(PRINCIPAL)).split('.');
      const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
      ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
      parts[3] = ciphertext.toString('base64url');

      assert.equal(await noticeReasonFor(parts.join('.')), 'noticeUnreadable');
    });

    test('refuses text that is no JWE as noticeUnreadable', async () => {
      assert.equal(await noticeReasonFor('not.a.jwe'), 'noticeUnreadable');
    });

    test('refuses a plaintext that is not JSON as noticeUnreadable', async () => {
      const jwe = await mintNotice(new TextEncoder().encode('subject-ana'));

      assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
    });

    test('refuses a plaintext that is not UTF-8 as noticeUnreadable, even inside a string', async () => {
      const jwe = await mintNotice(withInvalidByte(PRINCIPAL, 'tag-ana'));

      assert.equal(await noticeReasonFor(jwe), 'noticeUnreadable');
    });

    for (const [description, notice] of [
      ['version 2', { ...PRINCIPAL, v: 2 }],
      ['version 1 as a string', { ...PRINCIPAL, v: '1' }],
    ] as const) {
      test(`refuses a notice in ${description} as versionUnlisted`, async () => {
        assert.equal(
          await noticeReasonFor(await mintNotice(notice)),
          'versionUnlisted',
        );
      });
    }

    for (const [description, plaintext] of [
      ['carrying no v', { cursor: 'c-42', kind: 'global' }],
      ['that is a list', [PRINCIPAL]],
      ['that is null', new TextEncoder().encode('null')],
      ['of an unknown kind', { ...PRINCIPAL, kind: 'refresh' }],
      ['without its subject tag', { cursor: 'c-42', kind: 'principal', v: 1 }],
    ] as const) {
      test(`refuses a notice ${description} as noticeUnreadable`, async () => {
        assert.equal(
          await noticeReasonFor(await mintNotice(plaintext)),
          'noticeUnreadable',
        );
      });
    }

    test('refuses a poll answer offered as a notice as noticeUnreadable', async () => {
      assert.equal(
        await noticeReasonFor(await mintPollAnswer(answerWith())),
        'noticeUnreadable',
      );
    });
  });

  suite('readPollAnswer', () => {
    test('reads an answer the controller minted, with its notices', async () => {
      const answer = answerWith();

      const reading = await (
        await reader()
      ).readPollAnswer(await mintPollAnswer(answer));

      assert.deepEqual(reading, { answer, kind: 'answer' });
    });

    test('reads an answer from head carrying no notices', async () => {
      const answer = answerWith({ after: 'head', notices: [] });

      const reading = await (
        await reader()
      ).readPollAnswer(await mintPollAnswer(answer));

      assert.deepEqual(reading, { answer, kind: 'answer' });
    });

    test('refuses a notice offered as a poll answer as answerUnreadable', async () => {
      assert.equal(
        await answerReasonFor(await mintNotice(PRINCIPAL)),
        'answerUnreadable',
      );
    });

    test("refuses the notice's typ under the poll-answer subkey as answerUnreadable, though it decrypts", async () => {
      const jwe = await mintPollAnswer(answerWith(), {
        header: { typ: 'usher-notice+jwt' },
      });

      assert.equal(await answerReasonFor(jwe), 'answerUnreadable');
    });

    test('refuses a header carrying a kid as answerUnreadable, though it decrypts', async () => {
      const jwe = await mintPollAnswer(answerWith(), { header: { kid: 'k1' } });

      assert.equal(await answerReasonFor(jwe), 'answerUnreadable');
    });

    test('refuses an answer under the notice subkey as answerUnreadable', async () => {
      const jwe = await mintPollAnswer(answerWith(), {
        key: subkeyBytes(SUBKEY_LABELS.notice),
      });

      assert.equal(await answerReasonFor(jwe), 'answerUnreadable');
    });

    test('refuses a plaintext that is not UTF-8 as answerUnreadable, even inside a string', async () => {
      const jwe = await mintPollAnswer(
        withInvalidByte(answerWith(), 'nonce-1'),
      );

      assert.equal(await answerReasonFor(jwe), 'answerUnreadable');
    });

    test('refuses a plaintext that is not JSON as answerUnreadable', async () => {
      const jwe = await mintPollAnswer(new TextEncoder().encode('{"v":1,'));

      assert.equal(await answerReasonFor(jwe), 'answerUnreadable');
    });

    test('refuses an answer carrying a notice in a version not listed as versionUnlisted', async () => {
      const jwe = await mintPollAnswer(
        answerWith({ notices: [PRINCIPAL, { ...CATEGORY, v: 2 }] }),
      );

      assert.equal(await answerReasonFor(jwe), 'versionUnlisted');
    });

    for (const [description, answer] of [
      ['in version 2', answerWith({ v: 2 })],
      [
        'whose notices are not a list',
        answerWith({ notices: { 0: PRINCIPAL } }),
      ],
      [
        'carrying a malformed notice',
        answerWith({ notices: [{ ...PRINCIPAL, cursor: '' }] }),
      ],
      ['that is a list', [answerWith()]],
      ['that is null', new TextEncoder().encode('null')],
    ] as const) {
      test(`refuses an answer ${description} as answerUnreadable`, async () => {
        assert.equal(
          await answerReasonFor(await mintPollAnswer(answer)),
          'answerUnreadable',
        );
      });
    }
  });

  test('returns a reading for each malformed input, carrying only its reason', async () => {
    const channel = await reader();
    const readings = await Promise.all([
      channel.readNotice(await mintNotice({ ...PRINCIPAL, kind: 'refresh' })),
      channel.readNotice(
        await mintNotice(PRINCIPAL, { header: { typ: 'JWT' } }),
      ),
      channel.readPollAnswer(
        await mintPollAnswer(new TextEncoder().encode('tag-ana')),
      ),
      channel.readPollAnswer(
        await mintPollAnswer(answerWith({ nonce: '', notices: [PRINCIPAL] })),
      ),
    ]);

    for (const reading of readings) {
      assert.deepEqual(Object.keys(reading).toSorted(), ['kind', 'reason']);
      assert.equal(JSON.stringify(reading).includes('tag-ana'), false);
    }
  });
});
