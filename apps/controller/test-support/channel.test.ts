import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { suite, type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CompactEncrypt } from 'jose';

import { plaintextOf, SUBKEY_LABELS, subkeyBytes } from './bridgeWire.js';
import {
  openRawStream,
  openStream,
  poll,
  pollAll,
  type StreamRead,
} from './channel.js';
import {
  type RecordedRequest,
  type RecordingServer,
  type ScriptedAnswer,
  startRecordingServer,
} from './recordingServer.js';

const KEY_BYTES = new Uint8Array(randomBytes(32));

const APPLICATION = Object.freeze({
  id: 'search-test',
  key: Buffer.from(KEY_BYTES).toString('base64url'),
});

const subkey = (label: string): Uint8Array =>
  new Uint8Array(hkdfSync('sha256', KEY_BYTES, new Uint8Array(0), label, 32));

const encrypted = (
  value: object,
  typ: string,
  label: string,
): Promise<string> =>
  new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ })
    .encrypt(subkey(label));

const noticeJwe = (value: object): Promise<string> =>
  encrypted(value, 'usher-notice+jwt', SUBKEY_LABELS.notice);

const queryOf = ({ target }: RecordedRequest): URLSearchParams =>
  new URL(target, 'http://127.0.0.1').searchParams;

const recording = async (
  context: TestContext,
  answer?: (request: RecordedRequest) => ScriptedAnswer,
): Promise<RecordingServer> => {
  const server = await startRecordingServer(answer);
  context.after(() => server.stop());
  return server;
};

interface Page {
  more: boolean;
  next: string;
  notices: readonly object[];
}

// Each page is encrypted as its request arrives, echoing the request's own nonce and cursor unless a
// test says otherwise.
const pages =
  (
    byCursor: Readonly<Record<string, Page>>,
    echoedNonce?: string,
  ): ((request: RecordedRequest) => ScriptedAnswer) =>
  (request) => ({
    respond: (response) => {
      const after = queryOf(request).get('after') ?? 'head';
      const page = byCursor[after];
      void (page === undefined
        ? Promise.resolve(response.writeHead(500).end())
        : encrypted(
            {
              after,
              nonce: echoedNonce ?? queryOf(request).get('nonce'),
              ...page,
              v: 1,
            },
            'usher-poll+jwt',
            SUBKEY_LABELS.pollAnswer,
          ).then((body) =>
            response
              .writeHead(200, { 'content-type': 'application/jose' })
              .end(`${body}\n`),
          ));
    },
  });

const NOTICES = Object.freeze([
  { cursor: 'c-1', kind: 'baseline', v: 1 },
  { cursor: 'c-2', kind: 'category', resource: 'STUDY-A1', v: 1 },
  { cursor: 'c-3', kind: 'global', v: 1 },
]);

const writes =
  (
    chunks: readonly string[],
    held: { response?: ServerResponse },
  ): (() => ScriptedAnswer) =>
  () => ({
    respond: (response) => {
      held.response = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      chunks.forEach((chunk) => response.write(chunk));
    },
  });

const readsUntil = async (
  next: () => Promise<StreamRead>,
  count: number,
  read: readonly StreamRead[] = [],
): Promise<readonly StreamRead[]> => {
  if (read.length < count) {
    return readsUntil(next, count, [...read, await next()]);
  }
  return read;
};

suite('the poll client', () => {
  test('asks for head as the bridge does: head=true, a fresh 16-byte nonce, the versions it reads and a channel assertion', async (context) => {
    const server = await recording(context, () => ({ status: 503 }));

    const answered = await poll(server.url, { application: APPLICATION });
    const [request] = server.requests;

    assert.equal(request?.method, 'GET');
    assert.match(
      request?.target ?? '',
      /^\/notices\?head=true&nonce=[\w-]{22}$/u,
    );
    assert.equal(request?.headers.accept, 'application/jose');
    assert.equal(request?.headers['usher-notice-versions'], '1');
    assert.match(
      String(request?.headers.authorization),
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u,
    );
    assert.equal(answered.sent.after, 'head');
    assert.equal(
      request?.target.endsWith(`nonce=${answered.sent.nonce}`),
      true,
    );
    assert.equal(answered.status, 503);
    assert.equal(answered.answer, undefined);
  });

  test('asks after a cursor as the bridge does, the cursor encoded, then the nonce', async (context) => {
    const server = await recording(context, () => ({ status: 410 }));

    await poll(server.url, {
      after: 'e0 c/1+=',
      application: APPLICATION,
      nonce: 'n0nce',
    });

    assert.equal(
      server.requests[0]?.target,
      '/notices?after=e0+c%2F1%2B%3D&nonce=n0nce',
    );
  });

  test('reads a 200 through the channel reader, as the bridge reads a page', async (context) => {
    const server = await recording(
      context,
      pages({ 'c-0': { more: false, next: 'c-3', notices: NOTICES } }),
    );

    const answered = await poll(server.url, {
      after: 'c-0',
      application: APPLICATION,
    });

    assert.deepEqual(answered.answer, {
      answer: {
        after: 'c-0',
        more: false,
        next: 'c-3',
        nonce: answered.sent.nonce,
        notices: NOTICES,
        v: 1,
      },
      kind: 'answer',
    });
  });

  test("sends what a malformed-request test asks for in place of the bridge's request", async (context) => {
    const server = await recording(context, () => ({ status: 400 }));

    await poll(server.url, {
      application: APPLICATION,
      assertion: null,
      query: 'head=true&after=c-1',
    });
    await poll(server.url, {
      application: APPLICATION,
      headers: { accept: undefined },
      versions: '2',
    });

    assert.equal(server.requests[0]?.target, '/notices?head=true&after=c-1');
    assert.equal(server.requests[0]?.headers.authorization, undefined);
    assert.equal(server.requests[1]?.headers['usher-notice-versions'], '2');
    assert.equal(server.requests[1]?.headers.accept, '*/*');
  });
});

suite('polling to the newest notice', () => {
  test('pages while each answer asks for more, gathering every notice in order', async (context) => {
    const server = await recording(
      context,
      pages({
        'c-0': { more: true, next: 'c-2', notices: NOTICES.slice(0, 2) },
        'c-2': { more: false, next: 'c-3', notices: NOTICES.slice(2) },
      }),
    );

    const caughtUp = await pollAll(server.url, {
      after: 'c-0',
      application: APPLICATION,
    });

    assert.deepEqual(caughtUp, { next: 'c-3', notices: NOTICES, pages: 2 });
  });

  test('starts from head when given no cursor, giving the cursor a test calls c0', async (context) => {
    const server = await recording(
      context,
      pages({ head: { more: false, next: 'c-3', notices: [] } }),
    );

    const caughtUp = await pollAll(server.url, { application: APPLICATION });

    assert.deepEqual(caughtUp, { next: 'c-3', notices: [], pages: 1 });
  });

  test('refuses an answer echoing another request, one asking for more from a cursor already asked after, and any status but 200', async (context) => {
    const echoing = await recording(
      context,
      pages({ head: { more: false, next: 'c-1', notices: [] } }, 'stale-nonce'),
    );
    const repeating = await recording(
      context,
      pages({ 'c-0': { more: true, next: 'c-0', notices: [] } }),
    );
    const refusing = await recording(context, () => ({ status: 410 }));

    await assert.rejects(pollAll(echoing.url, { application: APPLICATION }), {
      message: "the poll after head was answered with another request's echo",
    });
    await assert.rejects(
      pollAll(repeating.url, { after: 'c-0', application: APPLICATION }),
      {
        message:
          'the poll after c-0 asked for more from a cursor already asked after',
      },
    );
    await assert.rejects(
      pollAll(refusing.url, { after: 'c-0', application: APPLICATION }),
      {
        message: 'the poll after c-0 was answered 410',
      },
    );
  });
});

suite('the stream client', () => {
  test('opens the stream as the bridge does: its accept, last-event-id, the versions it reads and a channel assertion', async (context) => {
    const held: { response?: ServerResponse } = {};
    const server = await recording(context, writes([':\n\n'], held));

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());
    const [request] = server.requests;

    assert.equal(stream.status, 200);
    assert.equal(request?.target, '/notices/stream');
    assert.equal(request?.headers.accept, 'text/event-stream');
    assert.equal(request?.headers['last-event-id'], 'c-0');
    assert.equal(request?.headers['usher-notice-versions'], '1');
    assert.match(String(request?.headers.authorization), /^Bearer /u);
  });

  test('leaves last-event-id out when told to', async (context) => {
    const server = await recording(context, writes([], {}));

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: null,
      signal: AbortSignal.timeout(5_000),
    });
    context.after(() => stream.close());

    assert.equal(server.requests[0]?.headers['last-event-id'], undefined);
  });

  test('yields each event as it arrives, with its bytes, its comments and the notice it carries, however the chunks split it', async (context) => {
    const first = await noticeJwe(NOTICES[0] ?? {});
    const second = await noticeJwe(NOTICES[1] ?? {});
    const held: { response?: ServerResponse } = {};
    const server = await recording(
      context,
      writes(
        [
          ': heartbeat\r\n\r\n',
          `id: c-1\nevent: notice\nda`,
          `ta: ${first}\n\n`,
        ],
        held,
      ),
    );

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());
    const [heartbeat, replayed] = await readsUntil(() => stream.next(), 2);
    const writtenAt = performance.now();
    held.response?.write(`id: c-2\r\nevent: notice\r\ndata: ${second}\r\n\r`);
    held.response?.write('\n');
    const [live] = await readsUntil(() => stream.next(), 1);

    assert.equal(heartbeat?.kind, 'event');
    assert.deepEqual(
      heartbeat?.kind === 'event' && {
        comments: heartbeat.comments,
        message: heartbeat.message,
        text: new TextDecoder().decode(heartbeat.bytes),
      },
      {
        comments: ['heartbeat'],
        message: undefined,
        text: ': heartbeat\r\n\r\n',
      },
    );
    assert.deepEqual(
      replayed?.kind === 'event' && {
        message: replayed.message,
        notice: replayed.notice,
        text: new TextDecoder().decode(replayed.bytes),
      },
      {
        message: { data: first, event: 'notice', id: 'c-1' },
        notice: { kind: 'notice', notice: NOTICES[0] },
        text: `id: c-1\nevent: notice\ndata: ${first}\n\n`,
      },
    );
    assert.deepEqual(live?.kind === 'event' && live.notice, {
      kind: 'notice',
      notice: NOTICES[1],
    });
    assert.ok(live !== undefined && live.arrivedAt >= writtenAt);
  });

  test('reads a notice the bridge would refuse as the bridge reads it', async (context) => {
    const versionTwo = await noticeJwe({ cursor: 'c-1', kind: 'global', v: 2 });
    const server = await recording(
      context,
      writes(
        [
          `id: c-1\nevent: notice\ndata: ${versionTwo}\n\n`,
          'event: notice\ndata: not a jwe\n\n',
        ],
        {},
      ),
    );

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());
    const [unlisted, unreadable] = await readsUntil(() => stream.next(), 2);

    assert.deepEqual(unlisted?.kind === 'event' && unlisted.notice, {
      kind: 'malformed',
      reason: 'versionUnlisted',
    });
    assert.deepEqual(unreadable?.kind === 'event' && unreadable.notice, {
      kind: 'malformed',
      reason: 'noticeUnreadable',
    });
  });

  test('stops waiting for the headers once its signal aborts', async (context) => {
    const server = await recording(context, () => ({
      respond: () => undefined,
    }));

    await assert.rejects(
      openStream(server.url, {
        application: APPLICATION,
        lastEventId: 'c-0',
        signal: AbortSignal.timeout(200),
      }),
      { name: 'TimeoutError' },
    );
  });

  test("ends as overflowed once the bridge's parser would buffer more than its limit", async (context) => {
    const server = await recording(
      context,
      writes([':\n', `data: ${'x'.repeat(70_000)}`], {}),
    );

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());

    assert.equal((await stream.next()).kind, 'overflow');
    assert.equal((await stream.next()).kind, 'ended');
  });

  test('ends when the controller ends the stream, the events before it delivered first', async (context) => {
    const held: { response?: ServerResponse } = {};
    const server = await recording(context, writes(['data: last\n\n'], held));

    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());
    const [last] = await readsUntil(() => stream.next(), 1);
    held.response?.end();

    assert.deepEqual(last?.kind === 'event' && last.message, {
      data: 'last',
      event: undefined,
      id: undefined,
    });
    assert.equal((await stream.next()).kind, 'ended');
  });

  test('closes its connection when closed, after which every read is ended', async (context) => {
    const held: { response?: ServerResponse } = {};
    const server = await recording(context, writes([':\n\n'], held));
    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    await stream.next();
    const ended = new Promise<number>((resolve) => {
      held.response?.once('close', () => resolve(performance.now()));
    });

    const closing = performance.now();
    await stream.close();
    const farEndClosed = await Promise.race([
      ended,
      delay(1_000).then(() => undefined),
    ]);

    assert.ok(farEndClosed !== undefined && farEndClosed >= closing);
    assert.equal((await stream.next()).kind, 'ended');
  });
});

suite('reading the stream with a time limit, and at the socket', () => {
  test('gives up a wait at its limit, and keeps the read that arrives afterwards for the next call', async (context) => {
    const held: { response?: ServerResponse } = {};
    const server = await recording(context, writes([], held));
    const stream = await openStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => stream.close());

    const givenUp = await stream.nextWithin(100);
    held.response?.write('data: late\n\n');
    await delay(100);
    const kept = await stream.nextWithin(1000);

    assert.equal(givenUp, undefined);
    assert.deepEqual(kept?.kind === 'event' && kept.message, {
      data: 'late',
      event: undefined,
      id: undefined,
    });
  });

  test('reads the body at the socket chunk by chunk, each timed, and stops reading while paused', async (context) => {
    const held: { response?: ServerResponse } = {};
    const server = await recording(context, writes([':\n\n'], held));

    const raw = await openRawStream(server.url, {
      application: APPLICATION,
      lastEventId: 'c-0',
    });
    context.after(() => raw.close());
    await delay(100);
    raw.pause();
    held.response?.write('data: while paused\n\n');
    await delay(100);
    const whilePaused = raw.chunks().length;
    raw.resume();
    await delay(100);
    const [request] = server.requests;

    assert.equal(raw.status, 200);
    assert.equal(request?.headers['last-event-id'], 'c-0');
    assert.equal(request?.headers.accept, 'text/event-stream');
    assert.equal(whilePaused, 1);
    assert.equal(raw.text(), ':\n\ndata: while paused\n\n');
    assert.ok(
      raw.chunks().every(({ arrivedAt }) => arrivedAt >= raw.headersAt),
    );
    assert.ok(raw.headersAt >= raw.sentAt);
    await raw.close();
    assert.equal(typeof (await raw.ended), 'number');
  });
});

suite("the bridge's key and plaintext helpers", () => {
  test('derives the subkey bytes the bridge derives, and reads a notice plaintext under them', async () => {
    const notice = await noticeJwe(NOTICES[0] ?? {});

    assert.deepEqual(
      subkeyBytes(APPLICATION.key, SUBKEY_LABELS.notice),
      subkey(SUBKEY_LABELS.notice),
    );
    assert.deepEqual(
      JSON.parse(
        await plaintextOf(
          notice,
          subkeyBytes(APPLICATION.key, SUBKEY_LABELS.notice),
        ),
      ),
      NOTICES[0],
    );
    await assert.rejects(
      plaintextOf(
        notice,
        subkeyBytes(APPLICATION.key, SUBKEY_LABELS.pollAnswer),
      ),
    );
  });
});
