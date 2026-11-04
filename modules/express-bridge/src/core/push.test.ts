import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

import type { Notice } from '@overture-stack/usher-types';

import { createChannelReader } from './channelReader.js';
import type { ControllerFetch } from './controllerClient.js';
import { createEventLog, type EventLog } from './events.js';
import { importApplicationKey } from './keys.js';
import { NOTICE_VERSIONS_HEADER } from './poll.js';
import {
  createPush,
  PUSH_BUFFER_CHARACTERS,
  type PushOptions,
} from './push.js';
import { mintNotice, TEST_KEY } from './testTokens.js';

const CONTROLLER = new URL('https://usher.example.org/controller/');
const IDLE_MS = 25_000;

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

const encoder = new TextEncoder();

interface Connection {
  close(): void;
  init: Parameters<ControllerFetch>[1];
  send(text: string): void;
  url: URL;
}

type Reply =
  | 'deaf'
  | 'deafStream'
  | 'network'
  | 'stream'
  | { bodiless?: boolean; contentType?: string; status: number };

/** A controller answering each connection as `reply` says; a test writes into each stream it opens. */
const fakeController = (
  reply: (index: number) => Promise<Reply> | Reply = () => 'stream',
) => {
  const connections: Connection[] = [];
  const fetch: ControllerFetch = async (url, init) => {
    const stream: {
      controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    } = { controller: undefined };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream.controller = controller;
      },
    });
    init.signal.addEventListener(
      'abort',
      () => {
        try {
          stream.controller?.error(new Error('aborted'));
        } catch {
          // already closed
        }
      },
      { once: true },
    );
    connections.push({
      close: () => stream.controller?.close(),
      init,
      send: (text) => stream.controller?.enqueue(encoder.encode(text)),
      url,
    });
    const answer = await reply(connections.length - 1);
    if (answer === 'network') {
      throw new TypeError('fetch failed');
    }
    if (answer === 'deaf') {
      return new Promise(() => undefined);
    }
    if (answer === 'deafStream') {
      return {
        body: new ReadableStream<Uint8Array>(),
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        status: 200,
      };
    }
    return answer === 'stream'
      ? {
          body,
          headers: new Headers({
            'content-type': 'text/event-stream; charset=utf-8',
          }),
          status: 200,
        }
      : {
          body: answer.bodiless === true ? null : body,
          headers: new Headers({
            'content-type': answer.contentType ?? 'text/plain',
          }),
          status: answer.status,
        };
  };
  return { connections, fetch };
};

/** One SSE event carrying `notice`, its id the cursor inside it unless the test names another, or none. */
const noticeEvent = async (
  notice: Readonly<Record<string, unknown>> & { cursor: string },
  id: string | null = notice.cursor,
): Promise<string> =>
  `${id === null ? '' : `id: ${id}\n`}event: notice\ndata: ${await mintNotice(notice)}\n\n`;

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

/** A promise and the function that settles it, for a step released by the test itself. */
const deferred = <T>() => {
  const settle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, resolve: (value: T) => settle.resolve(value) };
};

const pushWith = async (
  context: TestContext,
  fetch: ControllerFetch,
  options: Partial<PushOptions> = {},
) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
  const recorded = {
    applied: [] as Notice[],
    assertions: 0,
    defects: 0,
    events: [] as { data: unknown; name: string }[],
    historyLost: 0,
    silent: 0,
  };
  const head: { position: string | undefined } = { position: 'c-41' };
  const push = createPush({
    assertion: async () => {
      recorded.assertions += 1;
      return `assertion-${recorded.assertions}`;
    },
    controllerUrl: CONTROLLER,
    events: { emit: (name, data) => recorded.events.push({ data, name }) },
    fetch,
    headPosition: () => head.position,
    idleMs: IDLE_MS,
    maxBackoffMs: 30_000,
    random: () => 0.5,
    reader: createChannelReader({ noticeKey, pollAnswerKey }),
    sink: {
      applyNotice: (notice) => recorded.applied.push(notice),
      defect: () => {
        recorded.defects += 1;
      },
      historyLost: () => {
        recorded.historyLost += 1;
      },
      silent: () => {
        recorded.silent += 1;
      },
    },
    ...options,
  });
  return { head, push, recorded };
};

/** The event log over a host logger that throws on every call, counting the calls. */
const throwingEventLog = (): {
  events: EventLog;
  logger: { calls: number };
} => {
  const logger = { calls: 0 };
  const log = (): void => {
    logger.calls += 1;
    throw new Error('a defect in the host logger');
  };
  return {
    events: createEventLog({
      logger: { error: log, info: log, warn: log },
      source: 'https://search.example.org/usher-bridge',
      wallClock: { now: () => 0 },
    }),
    logger,
  };
};

const eventNames = (events: readonly { data: unknown; name: string }[]) =>
  events.map(
    ({ data, name }) => `${name}:${(data as { reason?: string }).reason ?? ''}`,
  );

const lastEventIds = (connections: readonly Connection[]) =>
  connections.map(({ init }) => init.headers['last-event-id']);

suite('createPush', () => {
  suite('a connection', () => {
    test('opens notices/stream from the head the poll read, with a fresh assertion and the versions listed', async (context) => {
      const controller = fakeController();
      const { push } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await push.stop();

      const [connection] = controller.connections;
      assert.equal(connection?.url.pathname, '/controller/notices/stream');
      assert.deepEqual(connection?.init.headers, {
        accept: 'text/event-stream',
        authorization: 'Bearer assertion-1',
        'last-event-id': 'c-41',
        [NOTICE_VERSIONS_HEADER]: '1',
      });
      assert.deepEqual(
        [connection?.init.method, connection?.init.redirect],
        ['GET', 'error'],
      );
    });

    test('applies each notice in order and moves the push position', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        (await noticeEvent(PRINCIPAL)) + (await noticeEvent(CATEGORY)),
      );
      await until(() => recorded.applied.length === 2);
      const position = push.position();
      await push.stop();

      assert.deepEqual(recorded.applied, [PRINCIPAL, CATEGORY]);
      assert.equal(position, 'c-43');
      assert.deepEqual(recorded.events, []);
    });

    test('reads a notice split across chunks', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);
      const event = await noticeEvent(PRINCIPAL);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(event.slice(0, 40));
      await settle();
      const early = recorded.applied.length;
      controller.connections[0]?.send(event.slice(40));
      await until(() => recorded.applied.length === 1);
      await push.stop();

      assert.equal(early, 0);
      assert.deepEqual(recorded.applied, [PRINCIPAL]);
    });

    test('passes over comments and events of other kinds', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        ': heartbeat\n\nevent: marker\ndata: replayed\n\nretry: 10\n\n' +
          (await noticeEvent(PRINCIPAL)),
      );
      await until(() => recorded.applied.length === 1);
      await push.stop();

      assert.deepEqual(recorded.applied, [PRINCIPAL]);
      assert.deepEqual(recorded.events, []);
    });

    test('resumes after its own position when a stream ends, with a fresh assertion', async (context) => {
      const controller = fakeController();
      const { head, push } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(await noticeEvent(PRINCIPAL));
      await until(() => push.position() === 'c-42');
      head.position = 'c-50';
      controller.connections[0]?.close();
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-42']);
      assert.equal(
        controller.connections[1]?.init.headers.authorization,
        'Bearer assertion-2',
      );
    });
  });

  suite('a notice the bridge cannot apply', () => {
    test('ends the connection at a notice it cannot read, applying none after it, and resumes from the last applied', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        (await noticeEvent(PRINCIPAL)) +
          'id: c-43\nevent: notice\ndata: not.a.jwe\n\n' +
          (await noticeEvent({ ...CATEGORY, cursor: 'c-44' })),
      );
      await until(() => recorded.events.length === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(recorded.applied, [PRINCIPAL]);
      assert.deepEqual(eventNames(recorded.events), [
        'revocationChannel.malformed:noticeUnreadable',
      ]);
      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-42']);
    });

    test('logs versionUnlisted for a notice in a version the bridge does not list', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        await noticeEvent({ ...PRINCIPAL, v: 2 }),
      );
      await until(() => recorded.events.length === 1);
      await push.stop();

      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(eventNames(recorded.events), [
        'revocationChannel.malformed:versionUnlisted',
      ]);
    });

    for (const [description, id] of [
      ['an SSE id other than its cursor', 'c-99'],
      ['no SSE id', null],
    ] as const) {
      test(`refuses a notice with ${description}, logging idMismatch and keeping its position`, async (context) => {
        const controller = fakeController();
        const { push, recorded } = await pushWith(context, controller.fetch);

        push.start();
        await until(() => controller.connections.length === 1);
        controller.connections[0]?.send(await noticeEvent(PRINCIPAL, id));
        await until(() => recorded.events.length === 1);
        const position = push.position();
        await push.stop();

        assert.deepEqual(recorded.applied, []);
        assert.equal(position, undefined);
        assert.deepEqual(eventNames(recorded.events), [
          'revocationChannel.malformed:idMismatch',
        ]);
      });
    }

    test('logs parserOverflow for an event past the buffer, applying nothing, and reconnects', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        `id: c-42\nevent: notice\ndata: ${'x'.repeat(PUSH_BUFFER_CHARACTERS + 1)}`,
      );
      await until(() => recorded.events.length === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(recorded.applied, []);
      assert.deepEqual(eventNames(recorded.events), [
        'revocationChannel.malformed:parserOverflow',
      ]);
    });

    test('buffers an unfinished line just within the buffer across chunks', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);
      const event = await noticeEvent(PRINCIPAL);
      const filler = 'x'.repeat(PUSH_BUFFER_CHARACTERS - 'data: '.length);

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(`event: marker\ndata: ${filler}`);
      await settle();
      controller.connections[0]?.send(`\n\n${event}`);
      await until(() => recorded.applied.length === 1);
      await push.stop();

      assert.deepEqual(recorded.events, []);
    });
  });

  suite('a defect', () => {
    test('reports a defect thrown while applying a notice, applies none after it, and resumes from the last applied', async (context) => {
      const controller = fakeController();
      const seen = { applied: [] as string[], defects: 0 };
      const { push, recorded } = await pushWith(context, controller.fetch, {
        sink: {
          applyNotice: (notice) => {
            if (notice.cursor === CATEGORY.cursor) {
              throw new Error('a defect in the core');
            }
            seen.applied.push(notice.cursor);
          },
          defect: () => {
            seen.defects += 1;
          },
          historyLost: () => undefined,
          silent: () => undefined,
        },
      });

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(
        (await noticeEvent(PRINCIPAL)) +
          (await noticeEvent(CATEGORY)) +
          (await noticeEvent({ ...PRINCIPAL, cursor: 'c-44' })),
      );
      await until(() => seen.defects === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(seen.applied, ['c-42']);
      assert.equal(seen.defects, 1);
      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-42']);
      assert.deepEqual(recorded.events, []);
    });

    test('reports a defect thrown while handing a 410 to the channel, and reconnects from the head the poll reads', async (context) => {
      const controller = fakeController((index) =>
        index === 0 ? { status: 410 } : 'stream',
      );
      const seen = { defects: 0, historyLost: 0 };
      const { head, push, recorded } = await pushWith(
        context,
        controller.fetch,
        {
          sink: {
            applyNotice: () => undefined,
            defect: () => {
              seen.defects += 1;
            },
            historyLost: () => {
              seen.historyLost += 1;
              throw new Error('a defect in the core');
            },
            silent: () => undefined,
          },
        },
      );

      push.start();
      await until(() => seen.defects === 1);
      head.position = 'c-60';
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.equal(seen.historyLost, 1);
      assert.equal(seen.defects, 1);
      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-60']);
      assert.deepEqual(recorded.events, []);
    });

    for (const [description, reply] of [
      ['a refused assertion, 401', { status: 401 }],
      ['a network failure', 'network'],
    ] as const) {
      test(`reports no defect for ${description}, which only reconnects`, async (context) => {
        const controller = fakeController((index) =>
          index === 0 ? reply : 'stream',
        );
        const { push, recorded } = await pushWith(context, controller.fetch);

        push.start();
        await until(() => controller.connections.length === 1);
        await settle();
        context.mock.timers.tick(500);
        await until(() => controller.connections.length === 2);
        await push.stop();

        assert.equal(recorded.defects, 0);
      });
    }
  });

  suite('an answer other than a stream', () => {
    test('hands a 410 to the channel, drops its position, and opens next from the head the poll reads', async (context) => {
      const controller = fakeController((index) =>
        index === 1 ? { status: 410 } : 'stream',
      );
      const { head, push, recorded } = await pushWith(
        context,
        controller.fetch,
      );

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(await noticeEvent(PRINCIPAL));
      await until(() => push.position() === 'c-42');
      controller.connections[0]?.close();
      await settle();
      context.mock.timers.tick(500);
      await until(() => recorded.historyLost === 1);
      const position = push.position();
      head.position = 'c-60';
      await settle();
      context.mock.timers.tick(1_000);
      await until(() => controller.connections.length === 3);
      await push.stop();

      assert.equal(position, undefined);
      assert.deepEqual(lastEventIds(controller.connections), [
        'c-41',
        'c-42',
        'c-60',
      ]);
      assert.deepEqual(recorded.events, []);
    });

    test('logs versionsRefused on a 406 and reconnects', async (context) => {
      const controller = fakeController((index) =>
        index === 0 ? { status: 406 } : 'stream',
      );
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => recorded.events.length === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(eventNames(recorded.events), [
        'revocationChannel.malformed:versionsRefused',
      ]);
    });

    test('reconnects after a 406 when the logger throws as the refusal is logged', async (context) => {
      const controller = fakeController((index) =>
        index === 0 ? { status: 406 } : 'stream',
      );
      const { events, logger } = throwingEventLog();
      const { push } = await pushWith(context, controller.fetch, { events });

      push.start();
      await until(() => logger.calls === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-41']);
    });

    for (const [description, reply] of [
      ['a page of its own', { contentType: 'text/html', status: 200 }],
      [
        'no body',
        { bodiless: true, contentType: 'text/event-stream', status: 200 },
      ],
    ] as const) {
      test(`logs streamMissing on a 200 answered with ${description}, and reconnects from the same position`, async (context) => {
        const controller = fakeController((index) =>
          index === 0 ? reply : 'stream',
        );
        const { push, recorded } = await pushWith(context, controller.fetch);

        push.start();
        await until(() => controller.connections.length === 1);
        await settle();
        context.mock.timers.tick(500);
        await until(() => controller.connections.length === 2);
        await push.stop();

        assert.deepEqual(eventNames(recorded.events), [
          'revocationChannel.malformed:streamMissing',
        ]);
        assert.deepEqual(lastEventIds(controller.connections), [
          'c-41',
          'c-41',
        ]);
        assert.equal(recorded.historyLost, 0);
      });
    }

    for (const [description, reply] of [
      ['a refused assertion, 401', { status: 401 }],
      ['an unavailable controller, 503', { status: 503 }],
      ['a network failure', 'network'],
    ] as const) {
      test(`reconnects after ${description}, logging nothing`, async (context) => {
        const controller = fakeController((index) =>
          index === 0 ? reply : 'stream',
        );
        const { push, recorded } = await pushWith(context, controller.fetch);

        push.start();
        await until(() => controller.connections.length === 1);
        await settle();
        context.mock.timers.tick(500);
        await until(() => controller.connections.length === 2);
        await push.stop();

        assert.deepEqual(recorded.events, []);
        assert.equal(recorded.historyLost, 0);
      });
    }

    test('waits, connecting nowhere, until the poll has read head', async (context) => {
      const controller = fakeController();
      const { head, push } = await pushWith(context, controller.fetch);
      head.position = undefined;

      push.start();
      await settle();
      context.mock.timers.tick(500);
      await settle();
      const before = controller.connections.length;
      head.position = 'c-41';
      context.mock.timers.tick(1_000);
      await until(() => controller.connections.length === 1);
      await push.stop();

      assert.equal(before, 0);
      assert.deepEqual(lastEventIds(controller.connections), ['c-41']);
    });
  });

  suite('silence', () => {
    test('replaces a push silent past its idle timer: logs pushReconnect, tells the channel, reconnects', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      context.mock.timers.tick(IDLE_MS - 1);
      await settle();
      const early = recorded.silent;
      context.mock.timers.tick(1);
      await until(() => recorded.silent === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.equal(early, 0);
      assert.deepEqual(eventNames(recorded.events), [
        'revocationChannel.pushReconnect:idleTimeout',
      ]);
    });

    test('replaces a push silent past its idle timer when the logger throws as the reconnect is logged, containing the throw within its timer', async (context) => {
      const controller = fakeController();
      const { events, logger } = throwingEventLog();
      const { push, recorded } = await pushWith(context, controller.fetch, {
        events,
      });

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      assert.doesNotThrow(() => context.mock.timers.tick(IDLE_MS));
      await until(() => recorded.silent === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.equal(logger.calls, 1);
    });

    test('reports a defect thrown while telling the channel of a silent push, containing the throw within its timer', async (context) => {
      const controller = fakeController();
      const seen = { defects: 0 };
      const { push } = await pushWith(context, controller.fetch, {
        sink: {
          applyNotice: () => undefined,
          defect: () => {
            seen.defects += 1;
          },
          historyLost: () => undefined,
          silent: () => {
            throw new Error('a defect in the core');
          },
        },
      });

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      assert.doesNotThrow(() => context.mock.timers.tick(IDLE_MS));
      await push.stop();

      assert.equal(seen.defects, 1);
    });

    test('re-arms its idle timer on every heartbeat', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      context.mock.timers.tick(IDLE_MS - 1);
      controller.connections[0]?.send(':\n');
      await settle();
      context.mock.timers.tick(IDLE_MS - 1);
      await settle();
      const silentBefore = recorded.silent;
      context.mock.timers.tick(1);
      await until(() => recorded.silent === 1);
      await push.stop();

      assert.equal(silentBefore, 0);
      assert.equal(controller.connections.length, 1);
    });
  });

  suite('a fetch that ignores its signal', () => {
    for (const [description, reply] of [
      ['whose headers never arrive', 'deaf'],
      ['whose stream never delivers and ignores its abort', 'deafStream'],
    ] as const) {
      test(`replaces a connection ${description} at its idle timer, armed when it opens`, async (context) => {
        const controller = fakeController((index) =>
          index === 0 ? reply : 'stream',
        );
        const { push, recorded } = await pushWith(context, controller.fetch);

        push.start();
        await until(() => controller.connections.length === 1);
        await settle();
        context.mock.timers.tick(IDLE_MS - 1);
        await settle();
        const early = recorded.silent;
        context.mock.timers.tick(1);
        await until(() => recorded.silent === 1);
        await settle();
        context.mock.timers.tick(500);
        await until(() => controller.connections.length === 2);
        await push.stop();

        assert.equal(early, 0);
        assert.deepEqual(eventNames(recorded.events), [
          'revocationChannel.pushReconnect:idleTimeout',
        ]);
      });
    }

    test('stops promptly with a connection whose headers never arrive', async (context) => {
      const controller = fakeController(() => 'deaf');
      const { push } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await push.stop();

      assert.equal(controller.connections.length, 1);
    });
  });

  suite('the backoff', () => {
    test('waits a full-jitter delay that doubles with each failure, up to its cap', async (context) => {
      const controller = fakeController(() => 'network');
      const { push } = await pushWith(context, controller.fetch, {
        maxBackoffMs: 3_000,
      });
      const waited: number[] = [];

      push.start();
      await until(() => controller.connections.length === 1);
      const step = async (remaining: readonly number[]): Promise<void> => {
        const [expected, ...rest] = remaining;
        if (expected === undefined) {
          return;
        }
        const before = controller.connections.length;
        await settle();
        context.mock.timers.tick(expected - 1);
        await settle();
        waited.push(controller.connections.length - before);
        context.mock.timers.tick(1);
        await until(() => controller.connections.length === before + 1);
        return step(rest);
      };
      await step([500, 1_000, 1_500, 1_500]);
      await push.stop();

      assert.deepEqual(waited, [0, 0, 0, 0]);
      assert.equal(controller.connections.length, 5);
    });

    test('keeps backing off while bytes arrive but no notice can be applied', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);
      const waited: number[] = [];

      push.start();
      const round = async (index: number, delay: number): Promise<void> => {
        await until(() => controller.connections.length === index + 1);
        controller.connections[index]?.send(
          ':\nid: c-42\nevent: notice\ndata: not.a.jwe\n\n',
        );
        await until(() => recorded.events.length === index + 1);
        await settle();
        context.mock.timers.tick(delay - 1);
        await settle();
        waited.push(controller.connections.length - (index + 1));
        context.mock.timers.tick(1);
      };
      await round(0, 500);
      await round(1, 1_000);
      await round(2, 2_000);
      await until(() => controller.connections.length === 4);
      await push.stop();

      assert.deepEqual(waited, [0, 0, 0]);
      assert.deepEqual(recorded.applied, []);
    });

    test('draws each delay across the whole range, down to none', async (context) => {
      const controller = fakeController((index) =>
        index === 0 ? 'network' : 'stream',
      );
      const { push } = await pushWith(context, controller.fetch, {
        random: () => 0,
      });

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.equal(controller.connections.length, 2);
    });

    test('starts its backoff again once a connection applies a notice', async (context) => {
      const controller = fakeController((index) =>
        index < 2 ? 'network' : 'stream',
      );
      const { push } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await settle();
      context.mock.timers.tick(1_000);
      await until(() => controller.connections.length === 3);
      controller.connections[2]?.send(await noticeEvent(PRINCIPAL));
      await until(() => push.position() === 'c-42');
      controller.connections[2]?.close();
      await settle();
      context.mock.timers.tick(499);
      await settle();
      const early = controller.connections.length;
      context.mock.timers.tick(1);
      await until(() => controller.connections.length === 4);
      await push.stop();

      assert.equal(early, 3);
    });
  });

  suite('forgetting and stopping', () => {
    test('applies no notice read once forgotten, drops the position it held, and opens next from the head the poll reads', async (context) => {
      const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
      const channel = createChannelReader({ noticeKey, pollAnswerKey });
      const gate = deferred<undefined>();
      const reading = { count: 0 };
      const controller = fakeController();
      const { head, push, recorded } = await pushWith(
        context,
        controller.fetch,
        {
          reader: {
            readNotice: async (jwe) => {
              reading.count += 1;
              if (reading.count === 2) {
                await gate.promise;
              }
              return channel.readNotice(jwe);
            },
          },
        },
      );

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(await noticeEvent(PRINCIPAL));
      await until(() => push.position() === 'c-42');
      controller.connections[0]?.send(await noticeEvent(CATEGORY));
      await until(() => reading.count === 2);
      head.position = undefined;
      push.forget();
      gate.resolve(undefined);
      await settle();
      const position = push.position();
      head.position = 'c-70';
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.deepEqual(recorded.applied, [PRINCIPAL]);
      assert.equal(position, undefined);
      assert.deepEqual(lastEventIds(controller.connections), ['c-41', 'c-70']);
    });

    test('stops: applies nothing read afterwards and never reconnects', async (context) => {
      const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
      const channel = createChannelReader({ noticeKey, pollAnswerKey });
      const gate = deferred<undefined>();
      const reading = { started: false };
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch, {
        reader: {
          readNotice: async (jwe) => {
            reading.started = true;
            await gate.promise;
            return channel.readNotice(jwe);
          },
        },
      });

      push.start();
      await until(() => controller.connections.length === 1);
      controller.connections[0]?.send(await noticeEvent(PRINCIPAL));
      await until(() => reading.started);
      const stopped = push.stop();
      gate.resolve(undefined);
      await stopped;
      context.mock.timers.tick(IDLE_MS * 4);
      await settle();

      assert.deepEqual(recorded.applied, []);
      assert.equal(push.position(), undefined);
      assert.equal(controller.connections.length, 1);
      assert.deepEqual(recorded.events, []);
    });

    test('logs nothing for a chunk that arrives as it stops', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      controller.connections[0]?.send(
        `data: ${'x'.repeat(PUSH_BUFFER_CHARACTERS + 1)}`,
      );
      await push.stop();

      assert.deepEqual(recorded.events, []);
    });

    test('hands nothing up when it stops while reading an answer it already has', async (context) => {
      const holder: { stop: () => void } = { stop: () => undefined };
      const answered: ControllerFetch = () =>
        Promise.resolve({
          body: null,
          headers: {
            get: () => {
              holder.stop();
              return null;
            },
          },
          status: 410,
        });
      const { push, recorded } = await pushWith(context, answered);
      const stopping: Promise<void>[] = [];
      holder.stop = () => {
        stopping.push(push.stop());
      };

      push.start();
      await until(() => stopping.length === 1);
      await Promise.all(stopping);

      assert.equal(recorded.historyLost, 0);
      assert.deepEqual(recorded.events, []);
    });

    test('logs nothing for a chunk it has read when it stops', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);
      const stopping: Promise<void>[] = [];

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      controller.connections[0]?.send(
        `data: ${'x'.repeat(PUSH_BUFFER_CHARACTERS + 1)}`,
      );
      queueMicrotask(() => stopping.push(push.stop()));
      await until(() => stopping.length === 1);
      await Promise.all(stopping);

      assert.deepEqual(recorded.events, []);
    });

    test('hands up no 410 that arrives as it stops', async (context) => {
      const reply = deferred<Reply>();
      const controller = fakeController(() => reply.promise);
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      reply.resolve({ bodiless: true, status: 410 });
      await push.stop();

      assert.equal(recorded.historyLost, 0);
      assert.equal(push.position(), undefined);
    });

    test('logs no refusal of its versions that arrives as it stops', async (context) => {
      const reply = deferred<Reply>();
      const controller = fakeController(() => reply.promise);
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      reply.resolve({ bodiless: true, status: 406 });
      await push.stop();

      assert.deepEqual(recorded.events, []);
    });

    test('never opens once stopped, even when started afterwards', async (context) => {
      const controller = fakeController();
      const { push } = await pushWith(context, controller.fetch);

      await push.stop();
      push.start();
      await settle();
      context.mock.timers.tick(30_000);
      await settle();

      assert.equal(controller.connections.length, 0);
    });

    test('waits out its backoff when started again', async (context) => {
      const controller = fakeController((index) =>
        index === 0 ? 'network' : 'stream',
      );
      const { push } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await settle();
      push.start();
      await settle();
      const early = controller.connections.length;
      context.mock.timers.tick(500);
      await until(() => controller.connections.length === 2);
      await push.stop();

      assert.equal(early, 1);
    });

    test('stops a stream that is open and silent', async (context) => {
      const controller = fakeController();
      const { push, recorded } = await pushWith(context, controller.fetch);

      push.start();
      await until(() => controller.connections.length === 1);
      await push.stop();
      context.mock.timers.tick(IDLE_MS * 4);
      await settle();

      assert.equal(controller.connections.length, 1);
      assert.deepEqual(recorded.events, []);
      assert.equal(recorded.silent, 0);
    });
  });
});
