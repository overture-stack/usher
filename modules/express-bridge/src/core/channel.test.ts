import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

import { type ChannelOptions, createChannel } from './channel.js';
import { createChannelReader } from './channelReader.js';
import type { ControllerFetch } from './controllerClient.js';
import { createEventLog, TALLY_INTERVAL_MS } from './events.js';
import { importApplicationKey } from './keys.js';
import { mintNotice, mintPollAnswer, TEST_KEY } from './testTokens.js';

const CONTROLLER = new URL('https://usher.example.org/controller/');
const DEADLINE_MS = 10_000;
const INTERVAL_MS = 30_000;
const IDLE_MS = 25_000;
const RECOVERY_INTERVAL_MS = 10_000;

/** An idle timeout longer than any test runs, so the push's silence never asks for a poll of its own. */
const UNREACHED_IDLE_MS = 3_600_000;

const encoder = new TextEncoder();

const principalAt = (position: number) => ({
  cursor: `c-${position}`,
  kind: 'principal',
  subjectTag: `tag-${position}`,
  v: 1,
});

interface StreamConnection {
  close(): void;
  lastEventId: string | undefined;
  send(text: string): void;
}

type Override = { status: number } | undefined;

/** A poll answered otherwise: with a status, never until its signal aborts, or not at all. */
type PollOverride = Override | 'hang' | 'network';

/**
 * A controller serving the poll and the push from one notice log, positions `c-<n>`. A test can move
 * head, or answer a poll or a stream connection otherwise.
 */
const noticeController = () => {
  const state: {
    committed: number[];
    head: number;
    pollOverride: (after: string | null) => PollOverride;
    pollRequests: { after: string | null; head: string | null }[];
    streamOverride: (index: number) => Override;
    streams: StreamConnection[];
  } = {
    committed: [],
    head: 41,
    pollOverride: () => undefined,
    pollRequests: [],
    streamOverride: () => undefined,
    streams: [],
  };

  const poll = async (url: URL, init: Parameters<ControllerFetch>[1]) => {
    const after = url.searchParams.get('after');
    state.pollRequests.push({ after, head: url.searchParams.get('head') });
    const override = state.pollOverride(after);
    if (override === 'network') {
      throw new TypeError('fetch failed');
    }
    if (override === 'hang') {
      return new Promise<never>((_, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      );
    }
    if (override !== undefined) {
      return {
        body: new Response('').body,
        headers: new Headers(),
        status: override.status,
      };
    }
    const from = after === null ? state.head : Number(after.slice(2));
    const positions = state.committed.filter((position) => position > from);
    const last = positions.at(-1) ?? (after === null ? state.head : from);
    return {
      body: new Response(
        await mintPollAnswer({
          after: after ?? 'head',
          more: false,
          next: `c-${last}`,
          nonce: url.searchParams.get('nonce'),
          notices: positions.map(principalAt),
          v: 1,
        }),
      ).body,
      headers: new Headers({ 'content-type': 'application/jose' }),
      status: 200,
    };
  };

  const stream = (init: Parameters<ControllerFetch>[1]) => {
    const handle: {
      controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    } = { controller: undefined };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        handle.controller = controller;
      },
    });
    init.signal.addEventListener(
      'abort',
      () => {
        try {
          handle.controller?.error(new Error('aborted'));
        } catch {
          // already closed
        }
      },
      { once: true },
    );
    state.streams.push({
      close: () => handle.controller?.close(),
      lastEventId: init.headers['last-event-id'],
      send: (text) => handle.controller?.enqueue(encoder.encode(text)),
    });
    const override = state.streamOverride(state.streams.length - 1);
    return {
      body,
      headers: new Headers({
        'content-type':
          override === undefined ? 'text/event-stream' : 'text/plain',
      }),
      status: override?.status ?? 200,
    };
  };

  const fetch: ControllerFetch = async (url, init) =>
    url.pathname.endsWith('/notices/stream') ? stream(init) : poll(url, init);

  return { fetch, state };
};

const pushed = async (position: number): Promise<string> =>
  `id: c-${position}\nevent: notice\ndata: ${await mintNotice(principalAt(position))}\n\n`;

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

const settle = async (rounds = 50): Promise<void> => {
  if (rounds > 0) {
    await flushed();
    return settle(rounds - 1);
  }
};

/**
 * The channel over `fetch`, recording what it hands the core and logs, and passing each event on to an
 * event log over the host's logger. A test can make the core throw on every notice offered, the signer
 * throw on its next `signing` signatures, or the host's logger throw on each event, through the faults
 * returned.
 */
const channelWith = async (
  context: TestContext,
  fetch: ControllerFetch,
  overrides: Partial<ChannelOptions> = {},
) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const { noticeKey, pollAnswerKey } = await importApplicationKey(TEST_KEY);
  const recorded = {
    applied: [] as string[],
    assertions: 0,
    confirmed: [] as number[],
    events: [] as string[],
    logged: [] as { data: unknown; name: string }[],
    resets: 0,
  };
  const faults = { applying: false, logging: false, signing: 0 };
  const hostLogger = (): void => {
    if (faults.logging) {
      throw new Error('a defect in the host logger');
    }
  };
  const log = createEventLog({
    logger: { error: hostLogger, info: hostLogger, warn: hostLogger },
    source: 'https://search.example.org/usher-bridge',
    wallClock: { now: () => Date.now() },
  });
  const channel = createChannel({
    assertion: async () => {
      recorded.assertions += 1;
      if (faults.signing > 0) {
        faults.signing -= 1;
        throw new Error('a defect in the signer');
      }
      return 'assertion';
    },
    controllerUrl: CONTROLLER,
    core: {
      applyNotice: (notice) => {
        recorded.applied.push(notice.cursor);
        if (faults.applying) {
          throw new Error('a defect in the core');
        }
      },
      confirmChannel: (checkStartedAt) =>
        recorded.confirmed.push(checkStartedAt),
      reset: () => {
        recorded.resets += 1;
      },
    },
    deadlineMs: DEADLINE_MS,
    events: {
      emit: (name, data) => {
        recorded.events.push(
          `${name}:${(data as { reason?: string }).reason ?? ''}`,
        );
        recorded.logged.push({ data, name });
        log.emit(name, data);
      },
    },
    fetch,
    idleMs: IDLE_MS,
    intervalMs: INTERVAL_MS,
    monotonicClock: { now: () => Date.now() },
    random: () => 0.5,
    reader: createChannelReader({ noticeKey, pollAnswerKey }),
    recoveryIntervalMs: RECOVERY_INTERVAL_MS,
    responseCapBytes: 1_048_576,
    ...overrides,
  });
  return { channel, faults, recorded };
};

/** Every `revocationChannel.failure` logged, as its cause and count. */
const channelFailures = (logged: readonly { data: unknown; name: string }[]) =>
  logged
    .filter(({ name }) => name === 'revocationChannel.failure')
    .map(({ data }) => data);

/** Starts the channel and lets the head poll answer and the push open from it. */
const opened = async (
  context: TestContext,
  controller: ReturnType<typeof noticeController>,
  overrides: Partial<ChannelOptions> = {},
) => {
  const started = await channelWith(context, controller.fetch, overrides);
  started.channel.start();
  await until(() => started.recorded.confirmed.length === 1);
  await settle();
  context.mock.timers.tick(500);
  await until(() => controller.state.streams.length === 1);
  return started;
};

suite('createChannel', () => {
  test('reads head with the poll, then opens the push from it', async (context) => {
    const controller = noticeController();

    const { channel } = await opened(context, controller);
    await channel.stop();

    assert.deepEqual(controller.state.pollRequests, [
      { after: null, head: 'true' },
    ]);
    assert.equal(controller.state.streams[0]?.lastEventId, 'c-41');
  });

  test('recovers through the poll a notice the push lost, applying again what the push delivered', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);

    controller.state.committed.push(42, 43);
    controller.state.streams[0]?.send(await pushed(43));
    await until(() => recorded.applied.length === 1);
    context.mock.timers.tick(INTERVAL_MS);
    await until(() => recorded.confirmed.length === 2);
    await channel.stop();

    assert.deepEqual(recorded.applied, ['c-43', 'c-42', 'c-43']);
    assert.deepEqual(controller.state.pollRequests.at(-1), {
      after: 'c-41',
      head: null,
    });
    assert.equal(recorded.resets, 0);
  });

  test('on a 410 to the poll, resets once, drops the push and its position, and reopens it from the next head', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    controller.state.committed.push(42);
    controller.state.streams[0]?.send(await pushed(42));
    await until(() => recorded.applied.length === 1);
    controller.state.head = 60;
    controller.state.pollOverride = (after) =>
      after === 'c-41' ? { status: 410 } : undefined;

    context.mock.timers.tick(20_000);
    controller.state.streams[0]?.send(':\n');
    await settle();
    context.mock.timers.tick(INTERVAL_MS - 20_000);
    await until(() => recorded.resets === 1);
    await settle();
    context.mock.timers.tick(0);
    await until(() => recorded.confirmed.length === 2);
    await settle();
    context.mock.timers.tick(500);
    await until(() => controller.state.streams.length === 2);
    await channel.stop();

    assert.equal(recorded.resets, 1);
    assert.deepEqual(
      controller.state.pollRequests.map(({ head }) => head),
      ['true', null, 'true'],
    );
    assert.equal(controller.state.streams[1]?.lastEventId, 'c-60');
    assert.deepEqual(recorded.events, []);
  });

  test('on a 410 to the push, resets once, polls head at once, and reopens the push from it', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    controller.state.head = 70;
    controller.state.streamOverride = (index) =>
      index === 1 ? { status: 410 } : undefined;

    controller.state.committed.push(42);
    controller.state.streams[0]?.send(await pushed(42));
    await until(() => recorded.applied.length === 1);
    controller.state.streams[0]?.close();
    await settle();
    context.mock.timers.tick(500);
    await until(() => recorded.resets === 1);
    await until(() => recorded.confirmed.length === 2);
    await settle();
    context.mock.timers.tick(1_000);
    await until(() => controller.state.streams.length === 3);
    await channel.stop();

    assert.equal(recorded.resets, 1);
    assert.deepEqual(
      controller.state.pollRequests.map(({ head }) => head),
      ['true', 'true'],
    );
    assert.equal(controller.state.streams[2]?.lastEventId, 'c-70');
  });

  test('polls at once when the push stays silent past its idle timer', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);

    context.mock.timers.tick(IDLE_MS);
    await until(() => controller.state.pollRequests.length === 2);
    await channel.stop();

    assert.deepEqual(recorded.events, [
      'revocationChannel.pushReconnect:idleTimeout',
    ]);
    assert.deepEqual(controller.state.pollRequests.at(-1), {
      after: 'c-41',
      head: null,
    });
  });

  test('retries at once a poll the silent push asked for, when it fails', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    const failures = { left: 1 };
    controller.state.pollOverride = (after) => {
      if (after === 'c-41' && failures.left > 0) {
        failures.left -= 1;
        return { status: 503 };
      }
      return undefined;
    };

    context.mock.timers.tick(IDLE_MS);
    await until(() => controller.state.pollRequests.length === 2);
    await settle();
    context.mock.timers.tick(0);
    await until(() => recorded.confirmed.length === 2);
    await channel.stop();

    assert.deepEqual(
      controller.state.pollRequests.map(({ after }) => after),
      [null, 'c-41', 'c-41'],
    );
  });

  test('polls at the recovery interval once a poll the silent push asked for, and its retry, both fail', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    const failures = { left: 2 };
    controller.state.pollOverride = (after) => {
      if (after === 'c-41' && failures.left > 0) {
        failures.left -= 1;
        return { status: 503 };
      }
      return undefined;
    };

    context.mock.timers.tick(IDLE_MS);
    await until(() => controller.state.pollRequests.length === 2);
    await settle();
    context.mock.timers.tick(0);
    await until(() => controller.state.pollRequests.length === 3);
    await settle();
    context.mock.timers.tick(RECOVERY_INTERVAL_MS - 1);
    await settle();
    const beforeRecovery = controller.state.pollRequests.length;
    context.mock.timers.tick(1);
    await until(() => recorded.confirmed.length === 2);
    await channel.stop();

    assert.equal(beforeRecovery, 3);
  });

  test('resets and reads head at once when a poll the silent push asked for meets a 410', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    controller.state.head = 80;
    controller.state.pollOverride = (after) =>
      after === 'c-41' ? { status: 410 } : undefined;

    context.mock.timers.tick(IDLE_MS);
    await until(() => recorded.resets === 1);
    await settle();
    context.mock.timers.tick(0);
    await until(() => recorded.confirmed.length === 2);
    await channel.stop();

    assert.deepEqual(
      controller.state.pollRequests.map(({ head }) => head),
      ['true', null, 'true'],
    );
  });

  test('retries at once the head poll a 410 on the push asked for, when it fails', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);
    const failures = { left: 1 };
    controller.state.streamOverride = (index) =>
      index === 1 ? { status: 410 } : undefined;
    controller.state.pollOverride = (after) => {
      if (after === null && failures.left > 0) {
        failures.left -= 1;
        return { status: 503 };
      }
      return undefined;
    };

    controller.state.committed.push(42);
    controller.state.streams[0]?.send(await pushed(42));
    await until(() => recorded.applied.length === 1);
    controller.state.streams[0]?.close();
    await settle();
    context.mock.timers.tick(500);
    await until(() => recorded.resets === 1);
    await until(() => controller.state.pollRequests.length === 2);
    await settle();
    context.mock.timers.tick(0);
    await until(() => recorded.confirmed.length === 2);
    await channel.stop();

    assert.deepEqual(
      controller.state.pollRequests.map(({ head }) => head),
      ['true', 'true', 'true'],
    );
  });

  test('stops the poll and the push alike', async (context) => {
    const controller = noticeController();
    const { channel, recorded } = await opened(context, controller);

    await channel.stop();
    context.mock.timers.tick(INTERVAL_MS * 4);
    await settle();
    context.mock.timers.tick(INTERVAL_MS * 4);
    await settle();

    assert.equal(controller.state.pollRequests.length, 1);
    assert.equal(controller.state.streams.length, 1);
    assert.deepEqual(recorded.events, []);
  });

  suite('failed checks', () => {
    type Controller = ReturnType<typeof noticeController>;
    type Faults = Awaited<ReturnType<typeof channelWith>>['faults'];

    /** Answers the first `times` polls for head as `override` says, and every other as usual. */
    const failingHead = (
      controller: Controller,
      override: PollOverride,
      times: number,
    ): void => {
      const left = { count: times };
      controller.state.pollOverride = (after) => {
        if (after === null && left.count > 0) {
          left.count -= 1;
          return override;
        }
        return undefined;
      };
    };

    /**
     * Ticks to 1 ms before an interval from `firstFailureAt` has passed, then to its end, settling
     * after each, and returns the failures logged before it ended.
     */
    const throughTheInterval = async (
      context: TestContext,
      firstFailureAt: number,
      logged: readonly { data: unknown; name: string }[],
    ): Promise<unknown[]> => {
      context.mock.timers.tick(
        firstFailureAt + TALLY_INTERVAL_MS - 1 - Date.now(),
      );
      await settle();
      const beforeTheInterval = channelFailures(logged);
      context.mock.timers.tick(1);
      await settle();
      return beforeTheInterval;
    };

    const failures: readonly [
      string,
      (controller: Controller, faults: Faults) => void,
    ][] = [
      ['status', (controller) => failingHead(controller, { status: 503 }, 2)],
      ['network', (controller) => failingHead(controller, 'network', 2)],
      [
        'defect',
        (_, faults) => {
          faults.signing = 2;
        },
      ],
    ];
    for (const [cause, failTwice] of failures) {
      test(`logs a head poll and its retry failing with cause ${cause} as one revocationChannel.failure counting both, an interval after the first`, async (context) => {
        const controller = noticeController();
        const { channel, faults, recorded } = await channelWith(
          context,
          controller.fetch,
          { idleMs: UNREACHED_IDLE_MS },
        );
        failTwice(controller, faults);

        channel.start();
        await until(() => recorded.assertions === 1);
        const firstFailureAt = Date.now();
        await settle();
        context.mock.timers.tick(0);
        await until(() => recorded.assertions === 2);
        await settle();
        context.mock.timers.tick(INTERVAL_MS);
        await until(() => recorded.confirmed.length === 1);
        await settle();
        const beforeTheInterval = await throughTheInterval(
          context,
          firstFailureAt,
          recorded.logged,
        );
        await channel.stop();

        assert.deepEqual(beforeTheInterval, []);
        assert.deepEqual(channelFailures(recorded.logged), [
          { cause, count: 2 },
        ]);
      });
    }

    test('logs a head poll and its retry both aborted at the deadline as one revocationChannel.failure with cause timeout counting both', async (context) => {
      const controller = noticeController();
      failingHead(controller, 'hang', 2);
      const { channel, recorded } = await channelWith(
        context,
        controller.fetch,
        { idleMs: UNREACHED_IDLE_MS },
      );

      channel.start();
      await until(() => controller.state.pollRequests.length === 1);
      await settle();
      context.mock.timers.tick(DEADLINE_MS);
      const firstFailureAt = Date.now();
      await settle();
      context.mock.timers.tick(0);
      await until(() => controller.state.pollRequests.length === 2);
      await settle();
      context.mock.timers.tick(DEADLINE_MS);
      await settle();
      context.mock.timers.tick(INTERVAL_MS - DEADLINE_MS);
      await until(() => recorded.confirmed.length === 1);
      await settle();
      const beforeTheInterval = await throughTheInterval(
        context,
        firstFailureAt,
        recorded.logged,
      );
      await channel.stop();

      assert.deepEqual(beforeTheInterval, []);
      assert.deepEqual(channelFailures(recorded.logged), [
        { cause: 'timeout', count: 2 },
      ]);
    });

    test('logs pushed notices that threw as they were applied as one revocationChannel.failure with cause defect counting each', async (context) => {
      const controller = noticeController();
      const { channel, faults, recorded } = await opened(context, controller, {
        idleMs: UNREACHED_IDLE_MS,
      });
      faults.applying = true;

      controller.state.streams[0]?.send(await pushed(42));
      await until(() => recorded.applied.length === 1);
      const firstFailureAt = Date.now();
      await settle();
      context.mock.timers.tick(1_000);
      await until(() => controller.state.streams.length === 2);
      controller.state.streams[1]?.send(await pushed(42));
      await until(() => recorded.applied.length === 2);
      await settle();
      context.mock.timers.tick(INTERVAL_MS - Date.now());
      await until(() => recorded.confirmed.length === 2);
      await settle();
      const beforeTheInterval = await throughTheInterval(
        context,
        firstFailureAt,
        recorded.logged,
      );
      await channel.stop();

      assert.deepEqual(beforeTheInterval, []);
      assert.deepEqual(channelFailures(recorded.logged), [
        { cause: 'defect', count: 2 },
      ]);
      assert.equal(recorded.resets, 0);
    });

    test('logs the failures it holds when it stops, before their interval has passed, and nothing after', async (context) => {
      const controller = noticeController();
      failingHead(controller, { status: 503 }, 1);
      const { channel, recorded } = await channelWith(
        context,
        controller.fetch,
        { idleMs: UNREACHED_IDLE_MS },
      );

      channel.start();
      await until(() => controller.state.pollRequests.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.confirmed.length === 1);
      const beforeStopping = channelFailures(recorded.logged);
      await channel.stop();
      const whenStopped = channelFailures(recorded.logged);
      context.mock.timers.tick(INTERVAL_MS * 3);
      await settle();

      assert.deepEqual(beforeStopping, []);
      assert.deepEqual(whenStopped, [{ cause: 'status', count: 1 }]);
      assert.deepEqual(channelFailures(recorded.logged), whenStopped);
    });

    test('resolves stop when the logger throws on the held failures, logging those failures alone and stopping the poll and the push', async (context) => {
      const controller = noticeController();
      failingHead(controller, { status: 503 }, 1);
      const { channel, faults, recorded } = await channelWith(
        context,
        controller.fetch,
        { idleMs: UNREACHED_IDLE_MS },
      );

      channel.start();
      await until(() => controller.state.pollRequests.length === 1);
      await settle();
      context.mock.timers.tick(0);
      await until(() => recorded.confirmed.length === 1);
      faults.logging = true;
      await assert.doesNotReject(channel.stop());
      const requestsWhenStopped = {
        polls: controller.state.pollRequests.length,
        streams: controller.state.streams.length,
      };
      context.mock.timers.tick(INTERVAL_MS * 3);
      await settle();

      assert.deepEqual(channelFailures(recorded.logged), [
        { cause: 'status', count: 1 },
      ]);
      assert.deepEqual(
        {
          polls: controller.state.pollRequests.length,
          streams: controller.state.streams.length,
        },
        requestsWhenStopped,
      );
    });
  });
});
