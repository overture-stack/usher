import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { CommitUnconfirmed } from './commitUnconfirmed.js';
import { StoreTimeout } from './storeTimeout.js';
import type { Lease, PooledConnection } from './types.js';
import { withinStoreTimeout } from './withinStoreTimeout.js';

const TIMEOUT_MILLISECONDS = 250;

interface FakePool {
  connect(): Promise<PooledConnection>;

  /** The one connection it hands out. */
  connection: PooledConnection;

  /** Hands out the connection a pool holding one back was asked for. */
  handOut(): void;

  /** Each release reaching the pool, true for a connection discarded. */
  releases: (boolean | undefined)[];
}

// A pool of one connection, handed out at once, or held back until the test hands it out.
const fakePool = ({ holdsBack = false } = {}): FakePool => {
  const handing: { handOut: () => void } = { handOut: () => undefined };
  const releases: (boolean | undefined)[] = [];
  const connection: PooledConnection = {
    release: (destroy) => {
      releases.push(destroy);
    },
  };
  return {
    connect: () =>
      holdsBack
        ? new Promise((resolve) => {
            handing.handOut = () => resolve(connection);
          })
        : Promise.resolve(connection),
    connection,
    handOut: () => handing.handOut(),
    releases,
  };
};

// Lets every callback already due run, timers aside.
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// Work that runs until the test ends it.
const heldWork = (): {
  end(result: string): void;
  fail(failure: Error): void;
  ran: () => boolean;
  work: () => Promise<string>;
} => {
  const state: {
    end: (result: string) => void;
    fail: (failure: Error) => void;
    ran: boolean;
  } = { end: () => undefined, fail: () => undefined, ran: false };
  return {
    end: (result) => state.end(result),
    fail: (failure) => state.fail(failure),
    ran: () => state.ran,
    work: () =>
      new Promise((resolve, reject) => {
        state.ran = true;
        state.end = resolve;
        state.fail = reject;
      }),
  };
};

suite('a unit of store work', () => {
  test('gives the work its connection, and returns the connection to the pool once, when the work succeeds in time', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();

    const given: PooledConnection[] = [];

    const result = await withinStoreTimeout(
      pool,
      TIMEOUT_MILLISECONDS,
      async ({ connection }) => {
        given.push(connection);
        return 'answered';
      },
    );
    context.mock.timers.tick(TIMEOUT_MILLISECONDS);

    assert.equal(result, 'answered');
    assert.deepEqual(given, [pool.connection]);
    assert.deepEqual(pool.releases, [undefined]);
  });

  test("discards the connection and throws the work's failure when the work fails in time", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();
    const failure = new Error('the statement was refused');

    await assert.rejects(
      withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, async () => {
        throw failure;
      }),
      (thrown) => thrown === failure,
    );

    assert.deepEqual(pool.releases, [true]);
  });

  test('leaves the connection as the work released it, reaching the pool once', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();

    await assert.rejects(
      withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, async ({ release }) => {
        release(false);
        release(true);
        throw new Error('rolled back');
      }),
    );

    assert.deepEqual(pool.releases, [false]);
  });

  test('fails with StoreTimeout once the timeout runs out with the work still running, discarding its connection at once', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();
    const held = heldWork();
    const unit = withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, held.work);
    const outcome = unit.then(
      () => 'resolved',
      (failure: unknown) => failure,
    );
    await settled();

    context.mock.timers.tick(TIMEOUT_MILLISECONDS - 1);
    await settled();
    const releasedBefore = [...pool.releases];
    context.mock.timers.tick(1);
    const failure = await outcome;
    const releasedAtTimeout = [...pool.releases];
    held.fail(new Error('Connection terminated'));
    await settled();

    assert.deepEqual(releasedBefore, []);
    assert.ok(failure instanceof StoreTimeout);
    assert.equal(failure.code, 'storeTimeout');
    assert.deepEqual(releasedAtTimeout, [true]);
    assert.deepEqual(pool.releases, [true]);
  });

  test('stays failed with StoreTimeout when the work succeeds after the timeout ran out, releasing the connection once', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();
    const held = heldWork();
    const unit = withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, held.work);
    const outcome = unit.then(
      () => 'resolved',
      (failure: unknown) => failure,
    );
    await settled();

    context.mock.timers.tick(TIMEOUT_MILLISECONDS);
    held.end('answered late');
    await settled();

    assert.ok((await outcome) instanceof StoreTimeout);
    assert.deepEqual(pool.releases, [true]);
  });

  test('fails with StoreTimeout while the pool has not handed out a connection, discarding it once it arrives and never running the work', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool({ holdsBack: true });
    const held = heldWork();
    const unit = withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, held.work);
    const outcome = unit.then(
      () => 'resolved',
      (failure: unknown) => failure,
    );

    context.mock.timers.tick(TIMEOUT_MILLISECONDS);
    const failure = await outcome;
    const releasedBeforeArrival = [...pool.releases];
    pool.handOut();
    await settled();

    assert.ok(failure instanceof StoreTimeout);
    assert.deepEqual(releasedBeforeArrival, []);
    assert.deepEqual(pool.releases, [true]);
    assert.equal(held.ran(), false);
  });

  test('gives a unit one more timeout from sending its COMMIT, the answer arriving within it deciding the outcome', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();
    const held = heldWork();
    const leases: Lease<PooledConnection>[] = [];
    const outcome = withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, (lease) => {
      leases.push(lease);
      return held.work();
    }).then(
      (result) => result,
      (failure: unknown) => failure,
    );
    await settled();

    context.mock.timers.tick(TIMEOUT_MILLISECONDS - 1);
    leases[0]?.sendingCommit();
    context.mock.timers.tick(TIMEOUT_MILLISECONDS - 1);
    held.end('committed');

    assert.equal(await outcome, 'committed');
    assert.deepEqual(pool.releases, [undefined]);
  });

  test('fails with CommitUnconfirmed, discarding the connection, when the COMMIT is not answered within one more timeout', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pool = fakePool();
    const held = heldWork();
    const leases: Lease<PooledConnection>[] = [];
    const outcome = withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, (lease) => {
      leases.push(lease);
      return held.work();
    }).then(
      () => 'committed',
      (failure: unknown) => failure,
    );
    await settled();

    context.mock.timers.tick(TIMEOUT_MILLISECONDS - 1);
    leases[0]?.sendingCommit();
    context.mock.timers.tick(TIMEOUT_MILLISECONDS);
    const failure = await outcome;
    held.end('answered late');
    await settled();

    assert.ok(failure instanceof CommitUnconfirmed);
    assert.equal(failure.code, 'commitUnconfirmed');
    assert.deepEqual(pool.releases, [true]);
  });

  test('gives one more timeout for the first COMMIT sent alone, and none once the unit was abandoned', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const twice = fakePool();
    const late = fakePool();
    const leases: Lease<PooledConnection>[] = [];
    const work = (lease: Lease<PooledConnection>): Promise<string> => {
      leases.push(lease);
      return heldWork().work();
    };
    const sentTwice = withinStoreTimeout(
      twice,
      TIMEOUT_MILLISECONDS,
      work,
    ).then(
      () => 'committed',
      (failure: unknown) => failure,
    );
    const sentLate = withinStoreTimeout(late, TIMEOUT_MILLISECONDS, work).then(
      () => 'committed',
      (failure: unknown) => failure,
    );
    await settled();

    leases[0]?.sendingCommit();
    context.mock.timers.tick(TIMEOUT_MILLISECONDS - 1);
    leases[0]?.sendingCommit();
    context.mock.timers.tick(1);
    leases[1]?.sendingCommit();
    context.mock.timers.tick(TIMEOUT_MILLISECONDS);

    assert.ok((await sentTwice) instanceof CommitUnconfirmed);
    assert.ok((await sentLate) instanceof StoreTimeout);
    assert.deepEqual([twice.releases, late.releases], [[true], [true]]);
  });

  test("throws the pool's failure to hand out a connection in time, releasing nothing", async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const pool = {
      connect: (): Promise<PooledConnection> => Promise.reject(refused),
    };

    await assert.rejects(
      withinStoreTimeout(pool, TIMEOUT_MILLISECONDS, async () => 'never run'),
      (thrown) => thrown === refused,
    );
  });
});
