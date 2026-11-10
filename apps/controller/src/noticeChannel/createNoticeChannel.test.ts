import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { compactDecrypt } from 'jose';

import {
  applicationSubkeys,
  type LiveApplicationKey,
} from '../applicationKeyRing/index.js';
import type {
  ChannelAssertionCheck,
  UnverifiedRejectionReason,
  VerifiedRejectionReason,
} from '../channelAssertion/index.js';
import type { Actor, AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createCursorCipher } from '../noticeStream/index.js';
import { StoreTimeout } from '../storeTimeout/index.js';
import {
  CHANNEL_PATHS,
  CHANNEL_STORE_FAILED,
  createNoticeChannel,
} from './createNoticeChannel.js';
import { createUsedAssertions } from './createUsedAssertions.js';
import type { NoticePage, NoticeReader, StreamPlace } from './types.js';

type Check = ChannelAssertionCheck<LiveApplicationKey>;

const EPOCH = '0d8e2c4a-6f1b-4c3d-9a7e-5b2f1e0c8d6a';

const NONCE = 'AbCdEfGhIjKlMnOp';

const VERSIONS = { 'usher-notice-versions': '1' };

const KEY: LiveApplicationKey = {
  applicationId: randomUUID(),
  keyId: randomUUID(),
  ...applicationSubkeys(randomBytes(32)),
};

const placeAt = (position: bigint): StreamPlace => ({
  createdAt: position * 10n,
  epoch: EPOCH,
  position,
});

const pageAfter = (
  after: bigint,
  positions: readonly bigint[],
  { head, more = false }: { head?: bigint; more?: boolean } = {},
): NoticePage => ({
  createdAtPosition: after * 10n,
  epoch: EPOCH,
  head: placeAt(head ?? positions.at(-1) ?? after),
  more,
  notices: positions.map((position) => ({
    createdAt: position * 10n,
    kind: 'baseline',
    position,
  })),
  trimmedThrough: 0n,
});

// An assertion that verified under the application's key, by its `jti`: a fresh one for each request
// unless a test presents one again.
const verifiedAs = (id: string): Check => ({
  assertion: { acceptedUntil: Date.now() + 90_000, id, key: KEY },
  kind: 'verified',
});

interface Stand {
  counted: { applicationId: string | undefined; reason: string }[];
  cursors: ReturnType<typeof createCursorCipher>;
  lines: { fields: unknown; message: string }[];
  recorded: { actor: Actor; event: AuditEvent }[];
  server: FastifyInstance;
  stop: () => Promise<void>;
}

// A server carrying the channel alone, its assertion verified as the test rules and its store read as
// the test scripts it.
const standUp = (
  context: TestContext,
  {
    check = () => verifiedAs(randomUUID()),
    reader = {
      after: async (after) => pageAfter(after, []),
      head: async () => placeAt(9n),
    },
    streamLimitPerAudience = 64,
  }: {
    check?: Check | (() => Check);
    reader?: NoticeReader;
    streamLimitPerAudience?: number;
  } = {},
): Stand => {
  const cursors = createCursorCipher(randomBytes(32).toString('base64url'));
  const lines: Stand['lines'] = [];
  const recorded: Stand['recorded'] = [];
  const counted: Stand['counted'] = [];
  const log = (message: string, fields?: unknown): void => {
    lines.push({ fields, message });
  };
  const channel = createNoticeChannel({
    cursors,
    eventLog: { error: log, warning: log },
    keyRing: { holds: () => true },
    reader,
    rejections: {
      count: (reason, applicationId) => {
        counted.push({ applicationId, reason });
      },
    },
    settings: {
      heartbeatMilliseconds: 10_000,
      noticePageLimit: 2,
      noticeRereadMilliseconds: 2_000,
      streamLimitPerAudience,
      streamMaximumLifetimeSeconds: 900,
      streamQueueLimit: 1_000,
    },
    trail: {
      recordEvent: async (actor, event) => {
        recorded.push({ actor, event });
        return randomUUID();
      },
    },
    usedAssertions: createUsedAssertions({ now: () => Date.now() }),
    verifier: {
      verify: async () => (typeof check === 'function' ? check() : check),
    },
  });
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  channel.routes.forEach((route) => {
    server.route(route);
  });
  const state: { stopping: Promise<void> | undefined } = {
    stopping: undefined,
  };
  const stop = (): Promise<void> => {
    state.stopping ??= channel.stop().then(() => server.close());
    return state.stopping;
  };
  context.after(stop);
  return { counted, cursors, lines, recorded, server, stop };
};

const unverified = (
  reason: UnverifiedRejectionReason,
  applicationId?: string,
): Check =>
  applicationId === undefined
    ? { kind: 'unverified', reason }
    : { applicationId, kind: 'unverified', reason };

const refused = (
  reason: Exclude<VerifiedRejectionReason, 'reusedAssertion'>,
  applicationId: string,
): Check => ({ applicationId, kind: 'refused', reason });

const polled = (
  server: FastifyInstance,
  query: string,
  headers: Readonly<Record<string, string>> = VERSIONS,
): Promise<LightMyRequestResponse> =>
  server.inject({
    headers: { authorization: 'Bearer assertion', ...headers },
    method: 'GET',
    url: `${CHANNEL_PATHS.poll}?${query}`,
  });

const answerOf = async (
  body: string,
): Promise<Readonly<Record<string, unknown>>> =>
  JSON.parse(
    new TextDecoder().decode(
      (await compactDecrypt(body, KEY.pollAnswer)).plaintext,
    ),
  ) as Readonly<Record<string, unknown>>;

const codeOf = (body: string): unknown =>
  (JSON.parse(body) as Readonly<Record<string, unknown>>)['code'];

interface RawAnswer {
  body: () => string;
  headers: IncomingMessage['headers'];
  response: IncomingMessage;
  status: number;
}

// A stream opened over a socket of its own, its body read as it arrives.
const openedStream = async (
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<RawAnswer> => {
  const sent = httpRequest(new URL(CHANNEL_PATHS.stream, url), {
    agent: false,
    headers: { authorization: 'Bearer assertion', ...headers },
  });
  sent.on('error', () => undefined);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    sent.once('response', resolve);
    sent.once('error', reject);
    sent.end();
  });
  response.on('error', () => undefined);
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return {
    body: () => Buffer.concat(chunks).toString('utf8'),
    headers: response.headers,
    response,
    status: response.statusCode ?? 0,
  };
};

const listening = async (stand: Stand): Promise<string> =>
  stand.server.listen({ host: '127.0.0.1', port: 0 });

suite('the poll', () => {
  test('answers every refused assertion with one 401 naming the Bearer scheme, counting one it could not verify by reason and named application, and recording one it verified as the system', async (context) => {
    const checks: readonly Check[] = [
      unverified('missingAssertion'),
      unverified('noLiveKey', KEY.applicationId),
      refused('expiredAssertion', KEY.applicationId),
      unverified('unknownApplication'),
      refused('notYetValid', KEY.applicationId),
    ];
    const state = { next: 0 };
    const stand = standUp(context, {
      check: () => {
        const check = checks[state.next] ?? unverified('missingAssertion');
        state.next += 1;
        return check;
      },
    });

    const answers = await checks.reduce<
      Promise<readonly LightMyRequestResponse[]>
    >(
      async (earlier) => [
        ...(await earlier),
        await polled(stand.server, `head=true&nonce=${NONCE}`),
      ],
      Promise.resolve([]),
    );

    answers.forEach((answer) => {
      assert.equal(answer.statusCode, 401);
      assert.equal(answer.headers['www-authenticate'], 'Bearer');
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.body, answers[0]?.body);
      assert.equal(codeOf(answer.body), 'channelAssertionRefused');
    });
    assert.deepEqual(stand.counted, [
      { applicationId: undefined, reason: 'missingAssertion' },
      { applicationId: KEY.applicationId, reason: 'noLiveKey' },
      { applicationId: undefined, reason: 'unknownApplication' },
    ]);
    assert.deepEqual(
      stand.recorded.map(({ actor, event }) => ({
        actor,
        data: event.data,
        type: event.type,
      })),
      [
        {
          actor: { type: 'system' },
          data: {
            applicationId: KEY.applicationId,
            reason: 'expiredAssertion',
            result: 'denied',
            sourceIp: '127.0.0.1',
          },
          type: 'channelAssertion.rejection',
        },
        {
          actor: { type: 'system' },
          data: {
            applicationId: KEY.applicationId,
            reason: 'notYetValid',
            result: 'denied',
            sourceIp: '127.0.0.1',
          },
          type: 'channelAssertion.rejection',
        },
      ],
    );
  });

  test('checks the assertion, then the notice versions, then the query, then the cursor, reading the store for the cursor alone', async (context) => {
    const reads: bigint[] = [];
    const reader: NoticeReader = {
      after: async (after) => {
        reads.push(after);
        return pageAfter(after, []);
      },
      head: async () => placeAt(9n),
    };
    const refused = standUp(context, {
      check: unverified('missingAssertion'),
      reader,
    });
    const accepted = standUp(context, { reader });
    const badVersions = { 'usher-notice-versions': '2' };
    const badQuery = `nonce=${NONCE}`;
    const badCursor = `after=invented-cursor&nonce=${NONCE}`;

    const statuses = await Promise.all([
      polled(refused.server, badQuery, badVersions),
      polled(accepted.server, badQuery, badVersions),
      polled(accepted.server, badQuery),
      polled(accepted.server, badCursor),
      polled(accepted.server, badCursor, {}),
    ]);

    assert.deepEqual(
      statuses.map(({ body, statusCode }) => [statusCode, codeOf(body)]),
      [
        [401, 'channelAssertionRefused'],
        [406, 'noticeVersionUnserved'],
        [400, 'unreadableQuery'],
        [410, 'cursorGone'],
        [406, 'noticeVersionUnserved'],
      ],
    );
    assert.deepEqual(reads, []);
  });

  test('answers a cursor history no longer reaches 410, before anything else of the store is read', async (context) => {
    const stand = standUp(context, {
      reader: {
        after: async (after) => ({
          ...pageAfter(after, [8n]),
          trimmedThrough: 7n,
        }),
        head: async () => placeAt(9n),
      },
    });
    const cursor = stand.cursors.seal(placeAt(5n));

    const answer = await polled(stand.server, `after=${cursor}&nonce=${NONCE}`);

    assert.equal(answer.statusCode, 410);
    assert.equal(codeOf(answer.body), 'cursorGone');
    assert.equal(answer.headers['cache-control'], 'no-store');
  });

  test('answers a head poll with no notices and a cursor for the newest place, echoing the nonce and head, encrypted under the key that verified the assertion', async (context) => {
    const stand = standUp(context);

    const answer = await polled(stand.server, `head=true&nonce=${NONCE}`);
    const opened = await answerOf(answer.body);

    assert.equal(answer.statusCode, 200);
    assert.equal(answer.headers['content-type'], 'application/jose');
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.deepEqual(
      { ...opened, next: undefined },
      {
        after: 'head',
        more: false,
        next: undefined,
        nonce: NONCE,
        notices: [],
        v: 1,
      },
    );
    assert.deepEqual(stand.cursors.open(String(opened['next'])), placeAt(9n));
  });

  test("answers a poll after a cursor with the audience's notices after it, next naming the last one while more wait and the newest place once none does", async (context) => {
    const audiences: (string | undefined)[] = [];
    const stand = standUp(context, {
      reader: {
        after: async (after, { audience }) => {
          audiences.push(audience);
          return after === 5n
            ? pageAfter(5n, [6n, 7n], { head: 12n, more: true })
            : pageAfter(after, [8n], { head: 12n });
        },
        head: async () => placeAt(12n),
      },
    });
    const first = stand.cursors.seal(placeAt(5n));

    const firstAnswer = await answerOf(
      (await polled(stand.server, `after=${first}&nonce=${NONCE}`)).body,
    );
    const second = String(firstAnswer['next']);
    const secondAnswer = await answerOf(
      (await polled(stand.server, `after=${second}&nonce=${NONCE}`)).body,
    );

    const positionsOf = (answer: Readonly<Record<string, unknown>>): unknown =>
      (Array.isArray(answer['notices']) ? answer['notices'] : []).map(
        (notice: { cursor: string }) =>
          stand.cursors.open(notice.cursor)?.position,
      );
    assert.deepEqual(
      [firstAnswer['after'], firstAnswer['more'], positionsOf(firstAnswer)],
      [first, true, [6n, 7n]],
    );
    assert.equal(stand.cursors.open(second)?.position, 7n);
    assert.deepEqual(
      [secondAnswer['after'], secondAnswer['more'], positionsOf(secondAnswer)],
      [second, false, [8n]],
    );
    assert.deepEqual(
      stand.cursors.open(String(secondAnswer['next'])),
      placeAt(12n),
    );
    assert.deepEqual(audiences, [KEY.applicationId, KEY.applicationId]);
  });

  test('answers 503 while the store cannot be read, writing the failure by its code alone', async (context) => {
    const stand = standUp(context, {
      reader: {
        after: () => Promise.reject(new StoreTimeout()),
        head: () =>
          Promise.reject(
            Object.assign(new Error('the server said: secret'), {
              code: '57P01',
            }),
          ),
      },
    });
    const cursor = stand.cursors.seal(placeAt(5n));

    const answers = await Promise.all([
      polled(stand.server, `head=true&nonce=${NONCE}`),
      polled(stand.server, `after=${cursor}&nonce=${NONCE}`),
    ]);

    answers.forEach((answer) => {
      assert.equal(answer.statusCode, 503);
      assert.equal(codeOf(answer.body), 'storeUnavailable');
    });
    assert.deepEqual(
      stand.lines
        .map(({ fields, message }) => ({ fields, message }))
        .toSorted((first, second) =>
          JSON.stringify(first).localeCompare(JSON.stringify(second)),
        ),
      [
        {
          fields: { code: '57P01', route: CHANNEL_PATHS.poll },
          message: CHANNEL_STORE_FAILED,
        },
        {
          fields: { code: 'storeTimeout', route: CHANNEL_PATHS.poll },
          message: CHANNEL_STORE_FAILED,
        },
      ],
    );
  });
});

suite('the push', () => {
  test('refuses a stream as the poll does: the assertion, the notice versions, a missing cursor, then a cursor history no longer reaches', async (context) => {
    const refused = standUp(context, { check: unverified('missingAssertion') });
    const accepted = standUp(context, {
      reader: {
        after: async (after) => ({
          ...pageAfter(after, []),
          trimmedThrough: 7n,
        }),
        head: async () => placeAt(9n),
      },
    });
    const gone = accepted.cursors.seal(placeAt(5n));
    const inject = (
      stand: Stand,
      headers: Readonly<Record<string, string>>,
    ): Promise<LightMyRequestResponse> =>
      stand.server.inject({
        headers: { authorization: 'Bearer assertion', ...headers },
        method: 'GET',
        url: CHANNEL_PATHS.stream,
      });

    const answers = await Promise.all([
      inject(refused, {
        'last-event-id': 'invented',
        'usher-notice-versions': '2',
      }),
      inject(accepted, {
        'last-event-id': 'invented',
        'usher-notice-versions': '2',
      }),
      inject(accepted, VERSIONS),
      inject(accepted, { ...VERSIONS, 'last-event-id': '' }),
      inject(accepted, { ...VERSIONS, 'last-event-id': 'invented' }),
      inject(accepted, { ...VERSIONS, 'last-event-id': gone }),
    ]);

    assert.deepEqual(
      answers.map(({ body, headers, statusCode }) => [
        statusCode,
        codeOf(body),
        String(headers['content-type']).split(';')[0],
      ]),
      [
        [401, 'channelAssertionRefused', 'application/problem+json'],
        [406, 'noticeVersionUnserved', 'application/problem+json'],
        [400, 'cursorMissing', 'application/problem+json'],
        [400, 'cursorMissing', 'application/problem+json'],
        [410, 'cursorGone', 'application/problem+json'],
        [410, 'cursorGone', 'application/problem+json'],
      ],
    );
  });

  test('opens no more streams for one application than its limit on the instance, answering 503 past it', async (context) => {
    const state = { next: 0 };
    const stand = standUp(context, {
      check: () => {
        state.next += 1;
        return {
          assertion: {
            acceptedUntil: Date.now() + 90_000,
            id: `assertion-${state.next}`,
            key: KEY,
          },
          kind: 'verified',
        };
      },
      streamLimitPerAudience: 2,
    });
    const url = await listening(stand);
    const headers = {
      ...VERSIONS,
      'last-event-id': stand.cursors.seal(placeAt(5n)),
    };

    const first = await openedStream(url, headers);
    const second = await openedStream(url, headers);
    const third = await openedStream(url, headers);
    await stand.stop();

    assert.deepEqual(
      [first.status, second.status, third.status],
      [200, 200, 503],
    );
    assert.equal(codeOf(third.body()), 'streamLimitReached');
    assert.deepEqual(
      [
        first.headers['cache-control'],
        first.headers['content-type'],
        first.headers['x-accel-buffering'],
      ],
      ['no-store', 'text/event-stream', 'no'],
    );
  });

  test('refuses an assertion presented to the stream a second time with the one 401, recording it as reusedAssertion from memory, whatever else its request carries', async (context) => {
    const reads: bigint[] = [];
    const stand = standUp(context, {
      check: verifiedAs('presented-once'),
      reader: {
        after: async (after) => {
          reads.push(after);
          return pageAfter(after, []);
        },
        head: async () => placeAt(9n),
      },
      streamLimitPerAudience: 1,
    });
    const url = await listening(stand);
    const cursor = stand.cursors.seal(placeAt(5n));
    // Presented again, each would otherwise be refused for the stream limit, the version list, a
    // missing cursor, a cursor it cannot read, and a cursor ahead of head.
    const presentations: readonly Readonly<Record<string, string>>[] = [
      { ...VERSIONS, 'last-event-id': cursor },
      { 'last-event-id': cursor, 'usher-notice-versions': '2' },
      VERSIONS,
      { ...VERSIONS, 'last-event-id': 'invented' },
      { ...VERSIONS, 'last-event-id': stand.cursors.seal(placeAt(500n)) },
    ];

    const first = await openedStream(url, {
      ...VERSIONS,
      'last-event-id': cursor,
    });
    const readsOnOpening = reads.length;
    const again = await presentations.reduce<
      Promise<readonly LightMyRequestResponse[]>
    >(
      async (earlier, headers) => [
        ...(await earlier),
        await stand.server.inject({
          headers: { authorization: 'Bearer assertion', ...headers },
          method: 'GET',
          url: CHANNEL_PATHS.stream,
        }),
      ],
      Promise.resolve([]),
    );
    await stand.stop();

    assert.equal(first.status, 200);
    again.forEach((answer) => {
      assert.equal(answer.statusCode, 401);
      assert.equal(codeOf(answer.body), 'channelAssertionRefused');
      assert.equal(answer.headers['www-authenticate'], 'Bearer');
    });
    assert.equal(reads.length, readsOnOpening);
    assert.deepEqual(
      stand.recorded.map(({ actor, event }) => ({
        actor,
        data: event.data,
        type: event.type,
      })),
      presentations.map(() => ({
        actor: { type: 'system' },
        data: {
          applicationId: KEY.applicationId,
          reason: 'reusedAssertion',
          result: 'denied',
          sourceIp: '127.0.0.1',
        },
        type: 'channelAssertion.rejection',
      })),
    );
  });

  test('serves every poll an assertion presents within its lifetime, one presented to the stream included', async (context) => {
    const stand = standUp(context, { check: verifiedAs('presented-often') });
    const url = await listening(stand);

    const opened = await openedStream(url, {
      ...VERSIONS,
      'last-event-id': stand.cursors.seal(placeAt(5n)),
    });
    const polls = await Promise.all(
      [0, 1].map(() => polled(stand.server, `head=true&nonce=${NONCE}`)),
    );
    await stand.stop();

    assert.equal(opened.status, 200);
    polls.forEach(({ statusCode }) => {
      assert.equal(statusCode, 200);
    });
    assert.deepEqual(stand.recorded, []);
  });

  test('ends every stream it holds when it stops, leaving no connection open', async (context) => {
    const stand = standUp(context, {
      check: () => ({
        assertion: {
          acceptedUntil: Date.now() + 90_000,
          id: randomUUID(),
          key: KEY,
        },
        kind: 'verified',
      }),
    });
    const url = await listening(stand);
    const cursor = stand.cursors.seal(placeAt(5n));

    const streams = await Promise.all(
      [0, 1].map(() =>
        openedStream(url, { ...VERSIONS, 'last-event-id': cursor }),
      ),
    );
    const ended = Promise.all(
      streams.map(
        ({ response }) =>
          new Promise((resolve) => {
            response.once('close', resolve);
          }),
      ),
    );
    await stand.stop();
    await ended;

    streams.forEach((stream) => {
      assert.equal(stream.status, 200);
      assert.equal(stream.body().startsWith(':\n\n'), true);
    });
  });
});
