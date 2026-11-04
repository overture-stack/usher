import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createSingleFlight } from './singleFlight.js';

type Outcome = 'granted' | 'overloaded' | 'refused' | 'timeout';

/** Work settled by hand, recording each signal it is given. */
const deferredWork = (): {
  calls: AbortSignal[];
  settle: (outcome: Outcome) => void;
  work: (signal: AbortSignal) => Promise<Outcome>;
} => {
  const calls: AbortSignal[] = [];
  const settlers: ((outcome: Outcome) => void)[] = [];

  return {
    calls,
    settle: (outcome) => settlers.forEach((settler) => settler(outcome)),
    work: (signal) => {
      calls.push(signal);
      return new Promise((resolve) => settlers.push(resolve));
    },
  };
};

const flightOf = (max: number, timeoutMs = 5_000) => {
  const shed = { count: 0 };
  const flight = createSingleFlight<Outcome>({
    max,
    onOverload: () => {
      shed.count += 1;
    },
    overloaded: 'overloaded',
    timeoutMs,
  });

  return { flight, shed };
};

suite('createSingleFlight', () => {
  test('runs the work once for ten concurrent callers on one digest, each getting its outcome', async () => {
    const { flight } = flightOf(4);
    const exchange = deferredWork();

    const waiting = Array.from({ length: 10 }, () =>
      flight.run('digest-ana', exchange.work),
    );
    await Promise.resolve();
    exchange.settle('granted');

    assert.deepEqual(await Promise.all(waiting), Array(10).fill('granted'));
    assert.equal(exchange.calls.length, 1);
  });

  test('registers a flight before its work starts, so a caller arriving from inside the work joins it', async () => {
    const { flight } = flightOf(4);
    const joined: Promise<Outcome>[] = [];
    const counted = { calls: 0 };

    const first = flight.run('digest-ana', () => {
      counted.calls += 1;
      joined.push(flight.run('digest-ana', () => Promise.resolve('refused')));
      return Promise.resolve('granted');
    });

    assert.equal(await first, 'granted');
    assert.equal(await joined[0], 'granted');
    assert.equal(counted.calls, 1);
  });

  test('starts a fresh flight for a digest once its previous flight has settled', async () => {
    const { flight } = flightOf(4);

    const first = await flight.run('digest-ana', () =>
      Promise.resolve('refused'),
    );
    const second = await flight.run('digest-ana', () =>
      Promise.resolve('granted'),
    );

    assert.deepEqual([first, second], ['refused', 'granted']);
  });

  test('answers overloaded beyond the bound without running the work, counting each shed caller', async () => {
    const { flight, shed } = flightOf(3);
    const exchange = deferredWork();

    const outcomes = ['a', 'b', 'c', 'd', 'e'].map((digest) =>
      flight.run(`digest-${digest}`, exchange.work),
    );
    await Promise.resolve();

    assert.equal(exchange.calls.length, 3);
    assert.equal(shed.count, 2);
    assert.equal(await outcomes[3], 'overloaded');
    assert.equal(await outcomes[4], 'overloaded');
    exchange.settle('granted');
    assert.deepEqual(await Promise.all(outcomes.slice(0, 3)), [
      'granted',
      'granted',
      'granted',
    ]);
  });

  test('lets a caller join a running flight while the bound is full, since joining starts no exchange', async () => {
    const { flight, shed } = flightOf(1);
    const exchange = deferredWork();

    const first = flight.run('digest-ana', exchange.work);
    const joining = flight.run('digest-ana', exchange.work);
    await Promise.resolve();
    exchange.settle('granted');

    assert.deepEqual(await Promise.all([first, joining]), [
      'granted',
      'granted',
    ]);
    assert.equal(shed.count, 0);
  });

  test('frees its place in the bound once a flight settles', async () => {
    const { flight, shed } = flightOf(1);

    await flight.run('digest-ana', () => Promise.resolve('granted'));
    const next = await flight.run('digest-ben', () =>
      Promise.resolve('granted'),
    );

    assert.equal(next, 'granted');
    assert.equal(shed.count, 0);
  });

  test(
    'aborts a flight at its timeout, under mock timers with setTimeout alone',
    { timeout: 5_000 },
    async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { flight } = flightOf(4, 300);

      const outcome = flight.run(
        'digest-ana',
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve('timeout'));
          }),
      );
      await Promise.resolve();
      context.mock.timers.tick(299);
      const settledEarly = await Promise.race([
        outcome,
        Promise.resolve('open'),
      ]);
      context.mock.timers.tick(1);

      assert.equal(settledEarly, 'open');
      assert.equal(await outcome, 'timeout');
    },
  );

  test('clears its timer once the flight settles, so the signal is never aborted afterward', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { flight } = flightOf(4, 300);
    const exchange = deferredWork();

    const outcome = flight.run('digest-ana', exchange.work);
    await Promise.resolve();
    exchange.settle('granted');
    await outcome;
    context.mock.timers.tick(1_000);

    assert.equal(exchange.calls[0]?.aborted, false);
  });

  test('rejects every waiter alike when the work rejects, and leaves no flight behind', async () => {
    const { flight } = flightOf(1);
    const failing = (): Promise<Outcome> =>
      Promise.reject(new Error('a defect in the work'));

    const waiting = [
      flight.run('digest-ana', failing),
      flight.run('digest-ana', failing),
    ];
    const settled = await Promise.allSettled(waiting);
    const after = await flight.run('digest-ben', () =>
      Promise.resolve('granted'),
    );

    assert.deepEqual(
      settled.map(({ status }) => status),
      ['rejected', 'rejected'],
    );
    assert.equal(after, 'granted');
  });

  test('settles whenIdle only once no flight is held, a flight started while it waited included', async () => {
    const { flight } = flightOf(4);
    const first = deferredWork();
    const second = deferredWork();
    const idle = { settled: false };

    const firstOutcome = flight.run('digest-ana', first.work);
    const idling = flight.whenIdle();
    void idling.then(() => {
      idle.settled = true;
    });
    const secondOutcome = flight.run('digest-ben', second.work);
    await Promise.resolve();
    first.settle('granted');
    await firstOutcome;
    await new Promise((resolve) => setImmediate(resolve));
    const settledAfterFirst = idle.settled;
    second.settle('refused');
    await secondOutcome;
    await idling;

    assert.equal(settledAfterFirst, false);
  });

  test('resolves whenIdle when a flight rejects', async () => {
    const { flight } = flightOf(4);

    const failing = flight.run('digest-ana', () =>
      Promise.reject(new Error('a defect in the work')),
    );
    const [idle, outcome] = await Promise.allSettled([
      flight.whenIdle(),
      failing,
    ]);

    assert.deepEqual([idle.status, outcome.status], ['fulfilled', 'rejected']);
  });

  for (const [what, max, timeoutMs] of [
    ['a bound of 0', 0, 300],
    ['a fractional bound', 1.5, 300],
    ['a timeout of 0', 4, 0],
    ['an infinite timeout', 4, Number.POSITIVE_INFINITY],
  ] as const) {
    test(`refuses ${what}`, () => {
      assert.throws(() =>
        createSingleFlight<Outcome>({
          max,
          onOverload: () => undefined,
          overloaded: 'overloaded',
          timeoutMs,
        }),
      );
    });
  }
});
