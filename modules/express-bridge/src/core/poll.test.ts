import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

import type { Notice } from '@overture-stack/usher-types';

import { createChannelReader } from './channelReader.js';
import type { ControllerFetch } from './controllerClient.js';
import { importApplicationKey } from './keys.js';
import {
  createPoll,
  NOTICE_VERSIONS_HEADER,
  type Poll,
  type PollOptions,
} from './poll.js';
import { mintPollAnswer, TEST_KEY } from './testTokens.js';

const CONTROLLER = new URL('https://usher.example.org/controller/');
const DEADLINE_MS = 10_000;
const INTERVAL_MS = 30_000;
const RECOVERY_INTERVAL_MS = 10_000;

const PRINCIPAL = {
  cursor: 'c-42',
  kind: 'principal',
  subjectTag: 'tag-ana',
  v: 1,
} as const;
const CATEGORY = {
  cursor: 'c-43',
  kind: 'category',
  resource: 'HEART_STUDY',
  v: 1,
} as const;

interface SeenRequest {
  after: string | null;
  head: string | null;
  init: Parameters<ControllerFetch>[1];
  nonce: string;
  url: URL;
}

type Answer =
  | 'deaf'
  | 'deafBody'
  | 'hang'
  | 'hangBody'
  | 'network'
  | { body?: string; headers?: Record<string, string>; status: number };

const rejectOnAbort = (signal: AbortSignal, reject: (error: Error) => void) => {
  if (signal.aborted) {
    reject(new Error('aborted'));
  }
  signal.addEventListener('abort', () => reject(new Error('aborted')), {
    once: true,
  });
};

/** A controller answering each request as `respond` says, recording what it was asked. */
const fakeController = (
  respond: (request: SeenRequest, index: number) => Answer | Promise<Answer>,
) => {
  const requests: SeenRequest[] = [];
  const fetch: ControllerFetch = async (url, init) => {
    const request = {
      after: url.searchParams.get('after'),
      head: url.searchParams.get('head'),
      init,
      nonce: url.searchParams.get('nonce') ?? '',
      url,
    };
    requests.push(request);
    const answer = await respond(request, requests.length - 1);
    if (answer === 'network') {
      throw new TypeError('fetch failed');
    }
    if (answer === 'hang') {
      return new Promise((_, reject) => rejectOnAbort(init.signal, reject));
    }
    if (answer === 'deaf') {
      return new Promise(() => undefined);
    }
    if (answer === 'deafBody') {
      return {
        body: new ReadableStream<Uint8Array>(),
        headers: new Headers(),
        status: 200,
      };
    }
    if (answer === 'hangBody') {
      return {
        body: new ReadableStream<Uint8Array>({
          start: (stream) =>
            rejectOnAbort(init.signal, (error) => stream.error(error)),
        }),
        headers: new Headers(),
        status: 200,
      };
    }
    return {
      body: new Response(answer.body ?? '').body,
      headers: new Headers(answer.headers ?? {}),
      status: answer.status,
    };
  };
  return { fetch, requests };
};

/** A 200 answering `request` as the controller would, echoing its nonce and `after`. */
const echoing = async (
  request: SeenRequest,
  members: Record<string, unknown> = {},
): Promise<Answer> => ({
  body: await mintPollAnswer({
    after: request.after ?? 'head',
    more: false,
    next: 'c-41',
    nonce: request.nonce,
    notices: [],
    v: 1,
    ...members,
  }),
  status: 200,
});

/** A promise and the function that settles it, for an answer released by the test itself. */
const deferred = <T>() => {
  const settle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, resolve: (value: T) => settle.resolve(value) };
};

/**
 * Lets queued callbacks and crypto run until `condition` holds, through setImmediate, which the mock
 * timers leave alone; fails the test after 5 s of real time.
 */
const until = async (
  condition: () => boolean,
  giveUpAt = performance.now() + 5_000,
): Promise<void> => {
  if (condition()) {
    return;
  }
  assert.ok(performance.now() < giveUpAt, 'the awaited condition never held');
  await flushed();
  return until(condition, giveUpAt);
};

/** Lets everything already queued run, before checking that something did not happen. */
const settle = async (rounds = 50): Promise<void> => {
  if (rounds > 0) {
    await flushed();
    return settle(rounds - 1);
  }
};

/**
 * Counts the timers set through the global `setTimeout` from now on that have neither been cleared
 * nor fired, calling through to the real timers.
 */
const liveTimers = (context: TestContext): (() => number) => {
  const live = new Set<unknown>();
  const { clearTimeout: clear, setTimeout: set } = globalThis;
  context.mock.method(
    globalThis,
    'setTimeout',
    (callback: () => void, delayMs?: number) => {
      const timer = set(() => {
        live.delete(timer);
        callback();
      }, delayMs);
      live.add(timer);
      return timer;
    },
  );
  context.mock.method(
    globalThis,
    'clearTimeout',
    (timer: Parameters<typeof clearTimeout>[0]) => {
      live.delete(timer);
      clear(timer);
    },
  );
  return () => live.size;
};

const pollWith = async (
  fetch: ControllerFetch,
  options: Partial<PollOptions> & { clock?: () => number } = {},
) => {
  const { clock: readClock, ...overrides } = options;
  const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
  const recorded = {
    applied: [] as Notice[],
    assertions: 0,
    confirmed: [] as number[],
    events: [] as { data: unknown; name: string }[],
    failures: [] as string[],
    resets: 0,
  };
  const clock = { now: 0 };
  const poll = createPoll({
    assertion: async () => {
      recorded.assertions += 1;
      return `assertion-${recorded.assertions}`;
    },
    controllerUrl: CONTROLLER,
    deadlineMs: DEADLINE_MS,
    events: { emit: (name, data) => recorded.events.push({ data, name }) },
    fetch,
    intervalMs: INTERVAL_MS,
    monotonicClock: { now: readClock ?? (() => clock.now) },
    random: () => 0.5,
    reader: createChannelReader({ noticeKey, pollAnswerKey }),
    recoveryIntervalMs: RECOVERY_INTERVAL_MS,
    responseCapBytes: 1_048_576,
    sink: {
      applyNotice: (notice) => recorded.applied.push(notice),
      confirmChannel: (checkStartedAt) =>
        recorded.confirmed.push(checkStartedAt),
      failed: (cause) => recorded.failures.push(cause),
      reset: () => {
        recorded.resets += 1;
      },
    },
    ...overrides,
  });
  return { clock, poll, recorded };
};

const mockTime = (context: TestContext): (() => number) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  return () => Date.now();
};

const malformedReasons = (events: readonly { data: unknown; name: string }[]) =>
  events
    .filter(({ name }) => name === 'revocationChannel.malformed')
    .map(({ data }) => (data as { reason: string }).reason);

suite('createPoll', () => {
  suite('a check', () => {
    test('asks for head explicitly first, and records the check at its start once answered', async () => {
      const controller = fakeController((request) =>
        echoing(request, { next: 'c-41' }),
      );
      const { clock, poll, recorded } = await pollWith(controller.fetch);
      clock.now = 5_000;

      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.deepEqual(
        controller.requests.map(({ after, head }) => ({ after, head })),
        [{ after: null, head: 'true' }],
      );
      assert.deepEqual(recorded.confirmed, [5_000]);
      assert.equal(poll.position(), 'c-41');
    });

    test('asks after its position once it holds one, and applies each notice in order', async () => {
      const controller = fakeController((request, index) =>
        index === 0
          ? echoing(request, { next: 'c-41' })
          : echoing(request, { next: 'c-43', notices: [PRINCIPAL, CATEGORY] }),
      );
      const { poll, recorded } = await pollWith(controller.fetch);

      await poll.check();
      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.deepEqual(
        controller.requests.map(({ after, head }) => ({ after, head })),
        [
          { after: null, head: 'true' },
          { after: 'c-41', head: null },
        ],
      );
      assert.deepEqual(recorded.applied, [PRINCIPAL, CATEGORY]);
      assert.equal(poll.position(), 'c-43');
      assert.equal(recorded.confirmed.length, 2);
    });

    test('sends back a cursor needing encoding exactly as the controller gave it', async () => {
      const cursor = 'c+/=&after=c-1?#42';
      const controller = fakeController((request) =>
        echoing(request, { next: cursor }),
      );
      const { poll } = await pollWith(controller.fetch);

      await poll.check();
      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.equal(controller.requests[1]?.after, cursor);
      assert.equal(
        controller.requests[1]?.url.searchParams.getAll('after').length,
        1,
      );
    });

    test('sends each page to notices under the controller with a fresh nonce and assertion, its versions listed', async () => {
      const controller = fakeController((request, index) =>
        echoing(request, { more: index === 0, next: `c-${42 + index}` }),
      );
      const { poll } = await pollWith(controller.fetch);

      await poll.check();

      const [first, second] = controller.requests;
      assert.equal(controller.requests.length, 2);
      assert.equal(first?.url.pathname, '/controller/notices');
      assert.notEqual(first?.nonce, second?.nonce);
      assert.ok((first?.nonce.length ?? 0) >= 16);
      assert.deepEqual(
        controller.requests.map(({ init }) => init.headers),
        [1, 2].map((count) => ({
          accept: 'application/jose',
          authorization: `Bearer assertion-${count}`,
          [NOTICE_VERSIONS_HEADER]: '1',
        })),
      );
      assert.deepEqual(
        controller.requests.map(({ init }) => [init.method, init.redirect]),
        [
          ['GET', 'error'],
          ['GET', 'error'],
        ],
      );
    });

    test("follows more at once from next, recording one check at the first page's start", async () => {
      const { clock, poll, recorded } = await pollWith(
        fakeController((request, index) => {
          clock.now = 1_000 + index * 2_000;
          return index === 0
            ? echoing(request, {
                more: true,
                next: 'c-42',
                notices: [PRINCIPAL],
              })
            : echoing(request, { next: 'c-43', notices: [CATEGORY] });
        }).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.deepEqual(recorded.applied, [PRINCIPAL, CATEGORY]);
      assert.deepEqual(recorded.confirmed, [0]);
      assert.equal(poll.position(), 'c-43');
    });

    test('joins a check already running rather than starting a second', async () => {
      const controller = fakeController((request) => echoing(request));
      const { poll } = await pollWith(controller.fetch);

      const [first, second] = await Promise.all([poll.check(), poll.check()]);

      assert.deepEqual([first, second], ['checked', 'checked']);
      assert.equal(controller.requests.length, 1);
    });
  });

  suite('the cursors a check asks after', () => {
    const GLOBAL = { cursor: 'c-44', kind: 'global', v: 1 } as const;

    interface ScriptedPage {
      more: boolean;
      next: string;
      notices?: readonly Readonly<Record<string, unknown>>[];
    }

    /**
     * A controller answering each request from `script`, keyed by the cursor asked after or `head`,
     * and 503 for one it has no page for or once `limit` requests have been made, so a check that
     * never stops asking still ends.
     */
    const scriptedController = (
      script: Readonly<Record<string, ScriptedPage>>,
      limit = 8,
    ) =>
      fakeController((request, index) => {
        const page = script[request.after ?? 'head'];
        return page === undefined || index >= limit
          ? { status: 503 }
          : echoing(request, {
              more: page.more,
              next: page.next,
              notices: page.notices ?? [],
            });
      });

    for (const [description, head, checksBefore, asked, applied] of [
      [
        'the first page of a check started from that cursor',
        { more: false, next: 'c-41' },
        1,
        ['c-41'],
        [],
      ],
      [
        'a later page',
        { more: true, next: 'c-41', notices: [PRINCIPAL] },
        0,
        [null, 'c-41'],
        [PRINCIPAL],
      ],
    ] as const) {
      test(`refuses ${description} asking for more from the cursor it was sent with, applying nothing from it and logging cursorRepeated`, async () => {
        const controller = scriptedController({
          'c-41': { more: true, next: 'c-41', notices: [CATEGORY] },
          head,
        });
        const { poll, recorded } = await pollWith(controller.fetch);
        await Promise.all(
          Array.from({ length: checksBefore }, () => poll.check()),
        );

        const outcome = await poll.check();

        assert.equal(outcome, 'failed');
        assert.deepEqual(
          controller.requests.slice(checksBefore).map(({ after }) => after),
          asked,
        );
        assert.deepEqual(recorded.applied, applied);
        assert.equal(poll.position(), 'c-41');
        assert.equal(recorded.confirmed.length, checksBefore);
        assert.deepEqual(malformedReasons(recorded.events), ['cursorRepeated']);
      });
    }

    for (const [description, script, asked, applied, position] of [
      [
        'back to the cursor the check started from, A to B to A',
        {
          'c-41': { more: true, next: 'c-42', notices: [PRINCIPAL] },
          'c-42': { more: true, next: 'c-41', notices: [CATEGORY] },
        },
        ['c-41', 'c-42'],
        [PRINCIPAL],
        'c-42',
      ],
      [
        'back to a cursor followed since, A to B to C to B',
        {
          'c-41': { more: true, next: 'c-42', notices: [PRINCIPAL] },
          'c-42': { more: true, next: 'c-43', notices: [CATEGORY] },
          'c-43': { more: true, next: 'c-42', notices: [GLOBAL] },
        },
        ['c-41', 'c-42', 'c-43'],
        [PRINCIPAL, CATEGORY],
        'c-43',
      ],
    ] as const) {
      test(`refuses a page whose next loops ${description}, keeping the pages applied before it, with no check`, async () => {
        const controller = scriptedController({
          ...script,
          head: { more: false, next: 'c-41' },
        });
        const { poll, recorded } = await pollWith(controller.fetch);
        await poll.check();

        const outcome = await poll.check();

        assert.equal(outcome, 'failed');
        assert.deepEqual(
          controller.requests.slice(1).map(({ after }) => after),
          asked,
        );
        assert.deepEqual(recorded.applied, applied);
        assert.equal(poll.position(), position);
        assert.equal(recorded.confirmed.length, 1);
        assert.deepEqual(malformedReasons(recorded.events), ['cursorRepeated']);
      });
    }

    test('follows every page whose next is a cursor its check has not asked after, recording one check', async () => {
      const controller = scriptedController({
        'c-41': { more: true, next: 'c-42', notices: [CATEGORY] },
        'c-42': { more: false, next: 'c-44', notices: [GLOBAL] },
        head: { more: true, next: 'c-41', notices: [PRINCIPAL] },
      });
      const { poll, recorded } = await pollWith(controller.fetch);

      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.deepEqual(
        controller.requests.map(({ after }) => after),
        [null, 'c-41', 'c-42'],
      );
      assert.deepEqual(recorded.applied, [PRINCIPAL, CATEGORY, GLOBAL]);
      assert.equal(poll.position(), 'c-44');
      assert.deepEqual(recorded.confirmed, [0]);
      assert.deepEqual(recorded.events, []);
    });

    test('records a check whose last page, asking for no more, names the cursor it was sent with as next', async () => {
      const controller = scriptedController({
        'c-41': { more: false, next: 'c-41' },
        head: { more: false, next: 'c-41' },
      });
      const { poll, recorded } = await pollWith(controller.fetch);
      await poll.check();

      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.equal(poll.position(), 'c-41');
      assert.equal(recorded.confirmed.length, 2);
      assert.deepEqual(recorded.events, []);
    });
  });

  suite('an answer that does not bind to its request', () => {
    for (const [description, members] of [
      ['another nonce', { nonce: 'nonce-from-another-poll' }],
      ['another after', { after: 'c-40' }],
    ] as const) {
      test(`records no check for an answer echoing ${description}, applying nothing and logging echoMismatch`, async () => {
        const controller = fakeController((request, index) =>
          index === 0
            ? echoing(request, { next: 'c-41' })
            : echoing(request, {
                next: 'c-43',
                notices: [PRINCIPAL],
                ...members,
              }),
        );
        const { poll, recorded } = await pollWith(controller.fetch);
        await poll.check();

        const outcome = await poll.check();

        assert.equal(outcome, 'failed');
        assert.deepEqual(recorded.applied, []);
        assert.equal(recorded.confirmed.length, 1);
        assert.equal(poll.position(), 'c-41');
        assert.deepEqual(malformedReasons(recorded.events), ['echoMismatch']);
      });
    }

    test('records no check for an answer to head echoing a cursor', async () => {
      const { poll, recorded } = await pollWith(
        fakeController((request) => echoing(request, { after: 'c-40' })).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(recorded.confirmed, []);
      assert.equal(poll.position(), undefined);
    });
  });

  suite('an answer the bridge cannot read', () => {
    test('applies none of its notices when one is in a version not listed, logging versionUnlisted', async () => {
      const { poll, recorded } = await pollWith(
        fakeController((request) =>
          echoing(request, { notices: [PRINCIPAL, { ...CATEGORY, v: 2 }] }),
        ).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(recorded.confirmed, []);
      assert.equal(poll.position(), undefined);
      assert.deepEqual(malformedReasons(recorded.events), ['versionUnlisted']);
    });

    test('refuses a body past the cap unread, logging answerUnreadable', async () => {
      const { poll, recorded } = await pollWith(
        fakeController((request) => echoing(request)).fetch,
        { responseCapBytes: 64 },
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(recorded.confirmed, []);
      assert.deepEqual(malformedReasons(recorded.events), ['answerUnreadable']);
    });

    test('refuses a declared length past the cap before reading the body', async () => {
      const { poll, recorded } = await pollWith(
        fakeController(() => ({
          body: '',
          headers: { 'content-length': '65' },
          status: 200,
        })).fetch,
        { responseCapBytes: 64 },
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(malformedReasons(recorded.events), ['answerUnreadable']);
    });

    test('reads an answer whose body starts and ends with a newline', async () => {
      const { poll, recorded } = await pollWith(
        fakeController(async (request) => {
          const answer = await echoing(request);
          return typeof answer === 'object'
            ? { ...answer, body: `\n${answer.body ?? ''}\n` }
            : answer;
        }).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'checked');
      assert.equal(recorded.confirmed.length, 1);
    });
  });

  suite('a status other than 200', () => {
    test('resets on a 410 and asks for head next, taking nothing from its body', async () => {
      const controller = fakeController((request, index) =>
        index === 1
          ? { body: 'c-99', status: 410 }
          : echoing(request, { next: 'c-41' }),
      );
      const { poll, recorded } = await pollWith(controller.fetch);
      await poll.check();

      const outcome = await poll.check();
      await poll.check();

      assert.equal(outcome, 'reset');
      assert.equal(recorded.resets, 1);
      assert.equal(recorded.confirmed.length, 2);
      assert.deepEqual(
        controller.requests.map(({ after, head }) => ({ after, head })),
        [
          { after: null, head: 'true' },
          { after: 'c-41', head: null },
          { after: null, head: 'true' },
        ],
      );
    });

    test('records no check on a 406, logging versionsRefused', async () => {
      const { poll, recorded } = await pollWith(
        fakeController(() => ({ status: 406 })).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(recorded.confirmed, []);
      assert.deepEqual(malformedReasons(recorded.events), ['versionsRefused']);
    });

    for (const [description, answer, cause] of [
      ['a refused assertion, 401', { status: 401 }, 'status'],
      ['an unavailable controller, 503', { status: 503 }, 'status'],
      ['an unknown endpoint, 404', { status: 404 }, 'status'],
      [
        'a redirect, 302',
        {
          headers: { location: 'https://elsewhere.example.org/' },
          status: 302,
        },
        'status',
      ],
      ['a network failure', 'network', 'network'],
    ] as const) {
      test(`records no check for ${description}, reporting a ${cause} failure, logging nothing itself and resetting nothing`, async () => {
        const { poll, recorded } = await pollWith(
          fakeController(() => answer).fetch,
        );

        const outcome = await poll.check();

        assert.equal(outcome, 'failed');
        assert.deepEqual(recorded.confirmed, []);
        assert.deepEqual(recorded.failures, [cause]);
        assert.deepEqual(recorded.events, []);
        assert.equal(recorded.resets, 0);
      });
    }

    test('keeps the pages applied before a later page fails, and their position, with no check', async () => {
      const { poll, recorded } = await pollWith(
        fakeController((request, index) =>
          index === 0
            ? echoing(request, {
                more: true,
                next: 'c-42',
                notices: [PRINCIPAL],
              })
            : { status: 503 },
        ).fetch,
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(recorded.applied, [PRINCIPAL]);
      assert.equal(poll.position(), 'c-42');
      assert.deepEqual(recorded.confirmed, []);
    });
  });

  suite('a fetch that ignores its signal', () => {
    for (const answer of ['deaf', 'deafBody'] as const) {
      test(`ends at the deadline a check whose ${answer === 'deaf' ? 'request' : 'answer body'} never settles`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController(() => answer);
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
        });

        const outcome = poll.check();
        await until(() => controller.requests.length === 1);
        await settle();
        context.mock.timers.tick(DEADLINE_MS);

        assert.equal(await outcome, 'failed');
        assert.deepEqual(recorded.confirmed, []);
      });
    }

    test('stops promptly with a request that never settles', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'deaf');
      const { poll } = await pollWith(controller.fetch, { clock: now });

      const outcome = poll.check();
      await until(() => controller.requests.length === 1);
      await poll.stop();

      assert.equal(await outcome, 'stopped');
    });
  });

  suite('the deadline', () => {
    test('aborts a check still unanswered at the deadline, as no check', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'hang');
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });
      const settled: { outcome?: string } = {};

      const outcome = poll.check().then((value) => {
        settled.outcome = value;
        return value;
      });
      await until(() => controller.requests.length === 1);
      context.mock.timers.tick(DEADLINE_MS - 1);
      await settle();
      const before = settled.outcome;
      context.mock.timers.tick(1);

      assert.equal(before, undefined);
      assert.equal(await outcome, 'failed');
      assert.deepEqual(recorded.confirmed, []);
    });

    test("aborts a later page at the deadline timed from the first page's start", async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index === 0
          ? echoing(request, { more: true, next: 'c-42', notices: [PRINCIPAL] })
          : 'hang',
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      const outcome = poll.check();
      await until(() => controller.requests.length === 2);
      context.mock.timers.tick(DEADLINE_MS);

      assert.equal(await outcome, 'failed');
      assert.deepEqual(recorded.applied, [PRINCIPAL]);
      assert.equal(poll.position(), 'c-42');
      assert.deepEqual(recorded.confirmed, []);
    });

    test('aborts an answer whose body is still arriving at the deadline', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'hangBody');
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      const outcome = poll.check();
      await until(() => controller.requests.length === 1);
      await settle();
      context.mock.timers.tick(DEADLINE_MS);

      assert.equal(await outcome, 'failed');
      assert.deepEqual(recorded.confirmed, []);
      assert.deepEqual(recorded.events, []);
    });
  });

  suite('a failed check', () => {
    const pageThenHang = (
      request: SeenRequest,
      index: number,
    ): Answer | Promise<Answer> =>
      index === 0 ? echoing(request, { more: true, next: 'c-42' }) : 'hang';
    for (const [description, respond, requests] of [
      ['its request', (): Answer => 'hang', 1],
      ['an answer whose body is still arriving', (): Answer => 'hangBody', 1],
      ['a later page', pageThenHang, 2],
    ] as const) {
      test(`reports a timeout when the deadline aborts ${description}`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController(respond);
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
        });

        const outcome = poll.check();
        await until(() => controller.requests.length === requests);
        await settle();
        context.mock.timers.tick(DEADLINE_MS);

        assert.equal(await outcome, 'failed');
        assert.deepEqual(recorded.failures, ['timeout']);
        assert.deepEqual(recorded.events, []);
      });
    }

    const signerDefect: Partial<PollOptions> = {
      assertion: () => Promise.reject(new Error('a defect in the signer')),
    };
    const readerDefect: Partial<PollOptions> = {
      reader: {
        readNotice: () => Promise.reject(new Error('a defect in the reader')),
        readPollAnswer: () =>
          Promise.reject(new Error('a defect in the reader')),
      },
    };
    for (const [description, overrides] of [
      ["signing a page's assertion", signerDefect],
      ['reading a page', readerDefect],
    ] as const) {
      test(`reports a defect thrown while ${description}, recording no check`, async () => {
        const { poll, recorded } = await pollWith(
          fakeController((request) => echoing(request)).fetch,
          overrides,
        );

        const outcome = await poll.check();

        assert.equal(outcome, 'failed');
        assert.deepEqual(recorded.confirmed, []);
        assert.deepEqual(recorded.failures, ['defect']);
        assert.deepEqual(recorded.events, []);
      });
    }

    test("reports a defect thrown while applying a page's notice, recording no check", async () => {
      const failures: string[] = [];
      const confirmed: number[] = [];
      const { poll } = await pollWith(
        fakeController((request) => echoing(request, { notices: [PRINCIPAL] }))
          .fetch,
        {
          sink: {
            applyNotice: () => {
              throw new Error('a defect in the core');
            },
            confirmChannel: (checkStartedAt) => confirmed.push(checkStartedAt),
            failed: (cause) => failures.push(cause),
            reset: () => undefined,
          },
        },
      );

      const outcome = await poll.check();

      assert.equal(outcome, 'failed');
      assert.deepEqual(confirmed, []);
      assert.deepEqual(failures, ['defect']);
    });

    test('reports no failure for a check a stop or a forget abandons, whatever then ends it', async (context) => {
      const now = mockTime(context);
      const gate = deferred<undefined>();
      const reading = { started: false };
      const controller = fakeController((request, index) =>
        index === 0 ? 'hang' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
        reader: {
          readNotice: () => Promise.reject(new Error('a defect in the reader')),
          readPollAnswer: async () => {
            reading.started = true;
            await gate.promise;
            throw new Error('a defect in the reader');
          },
        },
      });

      const forgotten = poll.check();
      await until(() => controller.requests.length === 1);
      poll.forget();
      const forgottenOutcome = await forgotten;
      const stopped = poll.check();
      await until(() => reading.started);
      const stopping = poll.stop();
      gate.resolve(undefined);
      await Promise.all([stopping, stopped]);

      assert.equal(forgottenOutcome, 'reset');
      assert.deepEqual(recorded.confirmed, []);
      assert.deepEqual(recorded.failures, []);
    });

    test('ends a check abandoned during a read that throws as the forget or the stop that abandoned it', async (context) => {
      const now = mockTime(context);
      const gates = [deferred<undefined>(), deferred<undefined>()];
      const reads = { started: 0 };
      const controller = fakeController((request) => echoing(request));
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
        reader: {
          readNotice: () => Promise.reject(new Error('a defect in the reader')),
          readPollAnswer: async () => {
            const gate = gates[reads.started];
            reads.started += 1;
            await gate?.promise;
            throw new Error('a defect in the reader');
          },
        },
      });

      const forgotten = poll.check();
      await until(() => reads.started === 1);
      poll.forget();
      gates[0]?.resolve(undefined);
      const forgottenOutcome = await forgotten;
      const stopped = poll.check();
      await until(() => reads.started === 2);
      const stopping = poll.stop();
      gates[1]?.resolve(undefined);
      const [stoppedOutcome] = await Promise.all([stopped, stopping]);

      assert.equal(forgottenOutcome, 'reset');
      assert.equal(stoppedOutcome, 'stopped');
      assert.deepEqual(recorded.failures, []);
    });

    for (const [description, status, logged] of [
      ['a 406, logged as malformed', 406, ['versionsRefused']],
      ['a 410, which resets', 410, []],
    ] as const) {
      test(`reports no failure for ${description}`, async () => {
        const controller = fakeController((request, index) =>
          index === 1 ? { status } : echoing(request, { next: 'c-41' }),
        );
        const { poll, recorded } = await pollWith(controller.fetch);
        await poll.check();

        await poll.check();

        assert.deepEqual(recorded.failures, []);
        assert.deepEqual(malformedReasons(recorded.events), logged);
      });
    }
  });

  suite('a 410 to a head request', () => {
    test('is a malformed answer: no reset, logged, retried once at once and then at the recovery interval', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => ({ status: 410 }));
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => controller.requests.length === 2);
      await settle();
      context.mock.timers.tick(RECOVERY_INTERVAL_MS - 1);
      await settle();
      const beforeRecovery = controller.requests.length;
      context.mock.timers.tick(1);
      await until(() => malformedReasons(recorded.events).length === 3);
      await poll.stop();

      assert.equal(beforeRecovery, 2);
      assert.equal(controller.requests.length, 3);
      assert.equal(recorded.resets, 0);
      assert.deepEqual(malformedReasons(recorded.events), [
        'answerUnreadable',
        'answerUnreadable',
        'answerUnreadable',
      ]);
    });
  });

  suite('forgetting', () => {
    test('forgets its position, so the next check asks for head', async () => {
      const controller = fakeController((request) =>
        echoing(request, { next: 'c-41' }),
      );
      const { poll } = await pollWith(controller.fetch);
      await poll.check();

      poll.forget();
      const position = poll.position();
      await poll.check();

      assert.equal(position, undefined);
      assert.deepEqual(
        controller.requests.map(({ head }) => head),
        ['true', 'true'],
      );
    });

    test('abandons the check in flight: nothing it read is applied, no check recorded, and the next starts afresh', async () => {
      const first = deferred<Answer>();
      const controller = fakeController((request, index) =>
        index === 0 ? first.promise : echoing(request, { next: 'c-50' }),
      );
      const { poll, recorded } = await pollWith(controller.fetch);

      const abandoned = poll.check();
      await until(() => controller.requests.length === 1);
      poll.forget();
      const fresh = poll.check();
      await until(() => controller.requests.length === 2);
      const [request] = controller.requests;
      first.resolve(
        request === undefined
          ? 'network'
          : await echoing(request, { next: 'c-42', notices: [PRINCIPAL] }),
      );

      assert.equal(await abandoned, 'reset');
      assert.equal(await fresh, 'checked');
      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(recorded.confirmed, [0]);
      assert.equal(poll.position(), 'c-50');
      assert.equal(recorded.resets, 0);
    });

    test('stops promptly with a forgotten check still waiting on the controller', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'hang');
      const { poll } = await pollWith(controller.fetch, { clock: now });

      const abandoned = poll.check();
      await until(() => controller.requests.length === 1);
      poll.forget();
      const fresh = poll.check();
      await until(() => controller.requests.length === 2);
      await poll.stop();

      assert.deepEqual(await Promise.all([abandoned, fresh]), [
        'reset',
        'stopped',
      ]);
    });

    test('joins the fresh check once the abandoned one has ended, rather than starting another', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'hang');
      const { poll } = await pollWith(controller.fetch, { clock: now });

      const abandoned = poll.check();
      await until(() => controller.requests.length === 1);
      poll.forget();
      const fresh = poll.check();
      await abandoned;
      const joined = poll.check();
      await settle();
      const requests = controller.requests.length;
      await poll.stop();

      assert.equal(requests, 2);
      assert.equal(joined, fresh);
    });

    test('asks for head at once on the schedule once a check is abandoned', async (context) => {
      const now = mockTime(context);
      const first = deferred<Answer>();
      const controller = fakeController((request, index) =>
        index === 0 ? first.promise : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      poll.forget();
      first.resolve({ status: 503 });
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.confirmed.length === 1);
      await poll.stop();

      assert.deepEqual(
        controller.requests.map(({ head }) => head),
        ['true', 'true'],
      );
    });
  });

  suite('a check confirmed late', () => {
    test('records no check when it is forgotten after its last page but before it confirms', async () => {
      const confirmed: number[] = [];
      const holder: { forget: () => void } = { forget: () => undefined };
      const { poll } = await pollWith(
        fakeController((request) => echoing(request, { notices: [PRINCIPAL] }))
          .fetch,
        {
          sink: {
            applyNotice: () => queueMicrotask(() => holder.forget()),
            confirmChannel: (checkStartedAt) => confirmed.push(checkStartedAt),
            failed: () => undefined,
            reset: () => undefined,
          },
        },
      );
      holder.forget = () => poll.forget();

      const outcome = await poll.check();

      assert.equal(outcome, 'reset');
      assert.deepEqual(confirmed, []);
      assert.equal(poll.position(), undefined);
    });
  });

  suite('the schedule', () => {
    for (const [description, random, delay] of [
      ['at its least, 0.9 of the interval', 0, 27_000],
      ['at its middle, the interval', 0.5, 30_000],
      ['towards its most, 1.1 of the interval', 0.999_999, 32_999],
    ] as const) {
      test(`runs a check at once on start, then the next one interval later jittered ${description}`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController((request) => echoing(request));
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
          random: () => random,
        });

        poll.start();
        await until(() => recorded.confirmed.length === 1);
        context.mock.timers.tick(delay - 1);
        await settle();
        const before = controller.requests.length;
        context.mock.timers.tick(1);
        await until(() => controller.requests.length === 2);
        await poll.stop();

        assert.equal(before, 1);
        assert.equal(controller.requests.length, 2);
      });
    }

    test("times the next check from the previous check's start, not its end", async (context) => {
      const now = mockTime(context);
      const firstAnswer = deferred<Answer>();
      const controller = fakeController((_, index) =>
        index === 0 ? firstAnswer.promise : 'hang',
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      context.mock.timers.tick(4_000);
      const [first] = controller.requests;
      firstAnswer.resolve(
        first === undefined ? 'network' : await echoing(first),
      );
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(INTERVAL_MS - 4_000);
      await until(() => controller.requests.length === 2);
      await poll.stop();

      assert.deepEqual(recorded.confirmed, [0]);
      assert.equal(controller.requests.length, 2);
    });

    test('times the next poll from the start of the check it joined', async (context) => {
      const now = mockTime(context);
      const late = deferred<Answer>();
      const controller = fakeController((request, index) =>
        index === 1 ? late.promise : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(25_000);
      const direct = poll.check();
      await until(() => controller.requests.length === 2);
      context.mock.timers.tick(5_000);
      await settle();
      const joined = controller.requests.length;
      const [, second] = controller.requests;
      late.resolve(second === undefined ? 'network' : await echoing(second));
      await direct;
      await settle();
      context.mock.timers.tick(24_999);
      await settle();
      const early = controller.requests.length;
      context.mock.timers.tick(1);
      await until(() => controller.requests.length === 3);
      await poll.stop();

      assert.equal(joined, 2);
      assert.equal(early, 2);
      assert.deepEqual(recorded.confirmed, [0, 25_000]);
    });

    test('polls at once when asked, retrying a failure at once and timing the next poll from that check', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index === 1 ? { status: 503 } : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(10_000);
      poll.pollNow();
      await until(() => controller.requests.length === 2);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.confirmed.length === 2);
      context.mock.timers.tick(INTERVAL_MS - 1);
      await settle();
      const early = controller.requests.length;
      context.mock.timers.tick(1);
      await until(() => controller.requests.length === 4);
      await poll.stop();

      assert.equal(early, 3);
      assert.deepEqual(recorded.confirmed, [0, 10_000]);
    });

    test('retries a failed check at once, and a failed retry waits for the recovery interval', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index < 2 ? 'network' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => controller.requests.length === 2);
      await settle();
      context.mock.timers.tick(RECOVERY_INTERVAL_MS - 1);
      await settle();
      const beforeSchedule = controller.requests.length;
      context.mock.timers.tick(1);
      await until(() => recorded.confirmed.length === 1);
      await poll.stop();

      assert.equal(beforeSchedule, 2);
      assert.equal(controller.requests.length, 3);
    });

    test('asks for head at once after a 410', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index === 1 ? { status: 410 } : echoing(request, { next: 'c-41' }),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(INTERVAL_MS);
      await until(() => recorded.resets === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.confirmed.length === 2);
      await poll.stop();

      assert.deepEqual(
        controller.requests.map(({ head }) => head),
        ['true', null, 'true'],
      );
    });

    test('stops a check still waiting on the controller by aborting it', async (context) => {
      const now = mockTime(context);
      const controller = fakeController(() => 'hang');
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      await poll.stop();

      assert.deepEqual(recorded.confirmed, []);
      assert.equal(await poll.check(), 'stopped');
    });

    test('runs one schedule when started twice', async (context) => {
      const now = mockTime(context);
      const draws = [0, 0.999_999];
      const controller = fakeController((request) => echoing(request));
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
        random: () => draws.shift() ?? 0.5,
      });

      poll.start();
      poll.start();
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(27_000);
      await until(() => recorded.confirmed.length === 2);
      context.mock.timers.tick(6_000);
      await settle();
      await poll.stop();

      assert.equal(controller.requests.length, 2);
    });

    test('applies no 410 that arrives once stopped', async (context) => {
      const now = mockTime(context);
      const answer = deferred<Answer>();
      const controller = fakeController(() => answer.promise);
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      const stopped = poll.stop();
      answer.resolve({ status: 410 });
      await stopped;

      assert.equal(recorded.resets, 0);
    });

    test('applies nothing from an answer whose reading ends once stopped', async (context) => {
      const now = mockTime(context);
      const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
      const channel = createChannelReader({ noticeKey, pollAnswerKey });
      const gate = deferred<undefined>();
      const reading = { started: false };
      const { poll, recorded } = await pollWith(
        fakeController((request) => echoing(request, { notices: [PRINCIPAL] }))
          .fetch,
        {
          clock: now,
          reader: {
            readNotice: channel.readNotice,
            readPollAnswer: async (jwe) => {
              reading.started = true;
              await gate.promise;
              return channel.readPollAnswer(jwe);
            },
          },
        },
      );

      poll.start();
      await until(() => reading.started);
      const stopped = poll.stop();
      gate.resolve(undefined);
      await stopped;

      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(recorded.confirmed, []);
      assert.equal(poll.position(), undefined);
    });

    test('stops: the check in flight applies nothing it read, and no check follows', async (context) => {
      const now = mockTime(context);
      const answer = deferred<Answer>();
      const controller = fakeController(() => answer.promise);
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      const running = poll.check();
      const stopped = poll.stop();
      const [first] = controller.requests;
      answer.resolve(
        first === undefined
          ? 'network'
          : await echoing(first, { notices: [PRINCIPAL] }),
      );
      await stopped;
      const outcome = await running;
      context.mock.timers.tick(INTERVAL_MS * 3);
      await settle();

      assert.equal(outcome, 'stopped');
      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(recorded.confirmed, []);
      assert.equal(controller.requests.length, 1);
      assert.equal(await poll.check(), 'stopped');
    });

    test('leaves no timer behind once stopped, even when a throw ends the check in flight after the stop', async (context) => {
      const timersLeft = liveTimers(context);
      const gate = deferred<undefined>();
      const reading = { started: false };
      const { poll, recorded } = await pollWith(
        fakeController((request) => echoing(request)).fetch,
        {
          reader: {
            readNotice: () =>
              Promise.reject(new Error('a defect in the reader')),
            readPollAnswer: async () => {
              reading.started = true;
              await gate.promise;
              throw new Error('a defect in the reader');
            },
          },
        },
      );

      poll.start();
      await until(() => reading.started);
      const stopping = poll.stop();
      gate.resolve(undefined);
      await stopping;

      assert.equal(timersLeft(), 0);
      assert.deepEqual(recorded.failures, []);
    });
  });

  suite('while checks are failing', () => {
    /**
     * Ticks to 1 ms before `delayMs` has passed, then to its end, and returns how many requests the
     * controller had seen before it ended.
     */
    const requestsBefore = async (
      context: TestContext,
      requests: readonly SeenRequest[],
      delayMs: number,
    ): Promise<number> => {
      context.mock.timers.tick(delayMs - 1);
      await settle();
      const before = requests.length;
      context.mock.timers.tick(1);
      return before;
    };

    /**
     * Starts the poll and lets its first check end unrecorded, then the immediate retry, with `ended`
     * counting the checks ended so far.
     */
    const startedFailingTwice = async (
      context: TestContext,
      poll: Poll,
      ended: () => number,
    ): Promise<void> => {
      poll.start();
      await until(() => ended() === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => ended() === 2);
      await settle();
    };

    const readerDefect: Partial<PollOptions> = {
      reader: {
        readNotice: () => Promise.reject(new Error('a defect in the reader')),
        readPollAnswer: () =>
          Promise.reject(new Error('a defect in the reader')),
      },
    };
    for (const [description, respond, overrides] of [
      [
        'an answer other than 200, 406 or 410',
        (): Answer => ({ status: 503 }),
        {},
      ],
      [
        'a defect thrown while reading a page',
        (request: SeenRequest) => echoing(request),
        readerDefect,
      ],
    ] as const) {
      test(`times the next poll at the recovery interval once a check and its retry both fail with ${description}`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController(respond);
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
          ...overrides,
        });

        await startedFailingTwice(
          context,
          poll,
          () => recorded.failures.length,
        );
        const beforeRecovery = await requestsBefore(
          context,
          controller.requests,
          RECOVERY_INTERVAL_MS,
        );
        await until(() => controller.requests.length === 3);
        await poll.stop();

        assert.equal(beforeRecovery, 2);
      });
    }

    test('times the next poll at the recovery interval from the start of a retry aborted at the deadline', async (context) => {
      const now = mockTime(context);
      const deadlineMs = 4_000;
      const controller = fakeController(() => 'hang');
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
        deadlineMs,
      });

      poll.start();
      await until(() => controller.requests.length === 1);
      await settle();
      context.mock.timers.tick(deadlineMs);
      await until(() => recorded.failures.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => controller.requests.length === 2);
      await settle();
      context.mock.timers.tick(deadlineMs);
      await until(() => recorded.failures.length === 2);
      await settle();
      const beforeRecovery = await requestsBefore(
        context,
        controller.requests,
        RECOVERY_INTERVAL_MS - deadlineMs,
      );
      await until(() => controller.requests.length === 3);
      await poll.stop();

      assert.equal(beforeRecovery, 2);
      assert.deepEqual(recorded.failures, ['timeout', 'timeout']);
    });

    for (const [description, respond, requestsBeforeRecovery] of [
      ['refusing the versions listed', (): Answer => ({ status: 406 }), 2],
      [
        'echoing another nonce',
        (request: SeenRequest) => echoing(request, { nonce: 'another' }),
        2,
      ],
      [
        'asking for more from a cursor its check already asked after',
        (request: SeenRequest) =>
          echoing(request, { more: true, next: 'c-loop' }),
        3,
      ],
    ] as const) {
      test(`times the next poll at the recovery interval once a check and its retry are both malformed, ${description}`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController(respond);
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
        });

        await startedFailingTwice(
          context,
          poll,
          () => malformedReasons(recorded.events).length,
        );
        const beforeRecovery = await requestsBefore(
          context,
          controller.requests,
          RECOVERY_INTERVAL_MS,
        );
        await until(() => controller.requests.length > requestsBeforeRecovery);
        await poll.stop();

        assert.equal(beforeRecovery, requestsBeforeRecovery);
        assert.deepEqual(recorded.failures, []);
      });
    }

    for (const [description, random, delay] of [
      ['at its least, 0.9 of it', 0, 9_000],
      ['towards its most, 1.1 of it', 0.999_999, 10_999],
    ] as const) {
      test(`jitters the recovery interval by 10% either way, as it does the poll interval: ${description}`, async (context) => {
        const now = mockTime(context);
        const controller = fakeController(() => 'network');
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
          random: () => random,
        });

        await startedFailingTwice(
          context,
          poll,
          () => recorded.failures.length,
        );
        const beforeRecovery = await requestsBefore(
          context,
          controller.requests,
          delay,
        );
        await until(() => controller.requests.length === 3);
        await poll.stop();

        assert.equal(beforeRecovery, 2);
      });
    }

    test('keeps the recovery interval while checks keep failing, retrying each failed poll at once', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index < 4 ? 'network' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      await startedFailingTwice(context, poll, () => recorded.failures.length);
      const beforeFirstRecovery = await requestsBefore(
        context,
        controller.requests,
        RECOVERY_INTERVAL_MS,
      );
      await until(() => recorded.failures.length === 3);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.failures.length === 4);
      await settle();
      const beforeSecondRecovery = await requestsBefore(
        context,
        controller.requests,
        RECOVERY_INTERVAL_MS,
      );
      await until(() => recorded.confirmed.length === 1);
      await poll.stop();

      assert.deepEqual([beforeFirstRecovery, beforeSecondRecovery], [2, 4]);
      assert.deepEqual(recorded.confirmed, [2 * RECOVERY_INTERVAL_MS]);
    });

    test('returns to the poll interval once a check is recorded', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index < 2 ? 'network' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      await startedFailingTwice(context, poll, () => recorded.failures.length);
      context.mock.timers.tick(RECOVERY_INTERVAL_MS);
      await until(() => recorded.confirmed.length === 1);
      await settle();
      const beforeInterval = await requestsBefore(
        context,
        controller.requests,
        INTERVAL_MS,
      );
      await until(() => controller.requests.length === 4);
      await poll.stop();

      assert.equal(beforeInterval, 3);
      assert.deepEqual(recorded.confirmed, [RECOVERY_INTERVAL_MS]);
    });

    for (const [description, answer, abandon] of [
      ['a forget', 'hang', (poll: Poll) => poll.forget()],
      ['a 410', { status: 410 }, () => undefined],
    ] as const) {
      test(`asks for head at once when ${description} ends a poll at the recovery interval, and returns to the poll interval once that head check is recorded`, async (context) => {
        const now = mockTime(context);
        const scripted = new Map<number, Answer>([
          [1, 'network'],
          [2, 'network'],
          [3, answer],
        ]);
        const controller = fakeController(
          (request, index) =>
            scripted.get(index) ?? echoing(request, { next: 'c-41' }),
        );
        const { poll, recorded } = await pollWith(controller.fetch, {
          clock: now,
        });

        poll.start();
        await until(() => recorded.confirmed.length === 1);
        context.mock.timers.tick(INTERVAL_MS);
        await until(() => recorded.failures.length === 1);
        await settle();
        context.mock.timers.tick(0);
        await until(() => recorded.failures.length === 2);
        await settle();
        context.mock.timers.tick(RECOVERY_INTERVAL_MS);
        await until(() => controller.requests.length === 4);
        abandon(poll);
        await settle();
        context.mock.timers.tick(0);
        await until(() => recorded.confirmed.length === 2);
        await settle();
        const beforeInterval = await requestsBefore(
          context,
          controller.requests,
          INTERVAL_MS,
        );
        await until(() => controller.requests.length === 6);
        await poll.stop();

        assert.equal(beforeInterval, 5);
        assert.deepEqual(
          controller.requests.map(({ head }) => head),
          ['true', null, null, null, 'true', null],
        );
        assert.deepEqual(recorded.confirmed, [
          0,
          INTERVAL_MS + RECOVERY_INTERVAL_MS,
        ]);
      });
    }

    test('arms no timer and polls no more once stopped while waiting for the recovery interval', async (context) => {
      const now = mockTime(context);
      const timersLeft = liveTimers(context);
      const controller = fakeController(() => 'network');
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      await startedFailingTwice(context, poll, () => recorded.failures.length);
      context.mock.timers.tick(RECOVERY_INTERVAL_MS);
      await until(() => recorded.failures.length === 3);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.failures.length === 4);
      await settle();
      const armedBeforeStop = timersLeft();
      await poll.stop();
      const armedOnceStopped = timersLeft();
      context.mock.timers.tick(INTERVAL_MS * 3);
      await settle();

      assert.deepEqual([armedBeforeStop, armedOnceStopped], [1, 0]);
      assert.equal(controller.requests.length, 4);
    });

    test('polls at once when asked while recovering, replacing the poll armed at the recovery interval, and returns to the poll interval once that check is recorded', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index < 4 ? 'network' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      await startedFailingTwice(context, poll, () => recorded.failures.length);
      context.mock.timers.tick(RECOVERY_INTERVAL_MS);
      await until(() => recorded.failures.length === 3);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.failures.length === 4);
      await settle();
      context.mock.timers.tick(5_000);
      poll.pollNow();
      await until(() => recorded.confirmed.length === 1);
      await settle();
      const beforeInterval = await requestsBefore(
        context,
        controller.requests,
        INTERVAL_MS,
      );
      await until(() => controller.requests.length === 6);
      await poll.stop();

      assert.equal(beforeInterval, 5);
      assert.deepEqual(recorded.confirmed, [RECOVERY_INTERVAL_MS + 5_000]);
    });

    test('times the next poll at the recovery interval once a poll asked for and its retry both fail', async (context) => {
      const now = mockTime(context);
      const controller = fakeController((request, index) =>
        index === 1 || index === 2 ? 'network' : echoing(request),
      );
      const { poll, recorded } = await pollWith(controller.fetch, {
        clock: now,
      });

      poll.start();
      await until(() => recorded.confirmed.length === 1);
      context.mock.timers.tick(5_000);
      poll.pollNow();
      await until(() => recorded.failures.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.failures.length === 2);
      await settle();
      const beforeRecovery = await requestsBefore(
        context,
        controller.requests,
        RECOVERY_INTERVAL_MS,
      );
      await until(() => recorded.confirmed.length === 2);
      await poll.stop();

      assert.equal(beforeRecovery, 3);
      assert.deepEqual(recorded.confirmed, [0, 5_000 + RECOVERY_INTERVAL_MS]);
    });
  });
});
