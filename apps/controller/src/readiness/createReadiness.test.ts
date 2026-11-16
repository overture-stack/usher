import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { LineFields } from '../eventLog/index.js';
import { MIGRATION_UNKNOWN } from '../migrations/index.js';
import {
  createReadiness,
  READINESS_LOST,
  READINESS_RESTORED,
  STORE_PROBE_INTERVAL_MILLISECONDS,
} from './createReadiness.js';
import type { ReadinessLog, ReadinessSettings, StoreProbe } from './types.js';

interface Line {
  fields: LineFields | undefined;
  level: 'error' | 'info' | 'warning';
  message: string;
}

interface Lines {
  log: ReadinessLog;
  written: Line[];
}

const lines = (): Lines => {
  const written: Line[] = [];
  return {
    log: {
      error: (message, fields) => {
        written.push({ fields, level: 'error', message });
      },
      info: (message, fields) => {
        written.push({ fields, level: 'info', message });
      },
      warning: (message, fields) => {
        written.push({ fields, level: 'warning', message });
      },
    },
    written,
  };
};

const failureWith = (code: string | undefined): Error =>
  Object.assign(
    new Error('the store refused it'),
    code === undefined ? {} : { code },
  );

interface Probes {
  /** Answers the probes in flight, with the answer given or the failure. */
  answer(outcome: Error | StoreProbe): void;

  /** How many probes the store was asked. */
  asked(): number;

  probeStore(): Promise<StoreProbe>;
}

// A store each probe of which waits until the test answers it.
const heldProbes = (): Probes => {
  const state: {
    asked: number;
    waiting: ((outcome: Error | StoreProbe) => void)[];
  } = { asked: 0, waiting: [] };
  return {
    answer: (outcome) => {
      const { waiting } = state;
      state.waiting = [];
      waiting.forEach((settle) => settle(outcome));
    },
    asked: () => state.asked,
    probeStore: () => {
      state.asked += 1;
      return new Promise((resolve, reject) => {
        state.waiting.push((outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome),
        );
      });
    },
  };
};

// A store answering each probe at once, as the test sets it.
const answeringStore = (): {
  answers: { outcome: Error | StoreProbe };
  asked: () => number;
  probeStore: () => Promise<StoreProbe>;
} => {
  const state = { asked: 0 };
  const answers: { outcome: Error | StoreProbe } = {
    outcome: { readOnly: false, unknownMigrations: [] },
  };
  return {
    answers,
    asked: () => state.asked,
    probeStore: async () => {
      state.asked += 1;
      const { outcome } = answers;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  };
};

const clockAt = (
  start: number,
): { advance(by: number): void; now(): number } => {
  const state = { now: start };
  return {
    advance: (by) => {
      state.now += by;
    },
    now: () => state.now,
  };
};

// A controller that serves, whose log stream takes its lines and whose role writes, over the store
// and clock given.
const serving = (
  overrides: Partial<ReadinessSettings> & Pick<ReadinessSettings, 'probeStore'>,
): ReadinessSettings => ({
  isLogWritable: () => true,
  isServing: () => true,
  log: lines().log,
  monotonicNow: clockAt(0).now,
  writesStore: () => true,
  ...overrides,
});

// A migration of this release recorded with another checksum, and one this release does not hold.
const CHANGED = Object.freeze({
  checksumDiffers: true,
  name: '0001_policy_store',
});

const LATER = Object.freeze({
  checksumDiffers: false,
  name: '0099_later_release',
});

suite("the controller's readiness", () => {
  test('is unready, asking the store nothing, while the controller is not serving, writing that it is stopping', async () => {
    const store = answeringStore();
    const { log, written } = lines();
    const readiness = createReadiness(
      serving({ isServing: () => false, log, probeStore: store.probeStore }),
    );

    assert.equal(await readiness.isReady(), false);
    assert.equal(store.asked(), 0);
    assert.deepEqual(written, [
      {
        fields: { cause: 'stopping' },
        level: 'warning',
        message: READINESS_LOST,
      },
    ]);
  });

  test('is unready, asking the store nothing, while the log stream cannot take a line, naming that cause', async () => {
    const store = answeringStore();
    const { log, written } = lines();
    const readiness = createReadiness(
      serving({
        isLogWritable: () => false,
        log,
        probeStore: store.probeStore,
      }),
    );

    assert.equal(await readiness.isReady(), false);
    assert.equal(store.asked(), 0);
    assert.deepEqual(
      written.map(({ fields }) => fields),
      [{ cause: 'logUnwritable' }],
    );
  });

  test('is ready while the store answers and unready while it does not, judging each answer afresh once the interval has passed', async () => {
    const store = answeringStore();
    const clock = clockAt(1000);
    const readiness = createReadiness(
      serving({ monotonicNow: clock.now, probeStore: store.probeStore }),
    );

    const answering = await readiness.isReady();
    store.answers.outcome = failureWith('storeTimeout');
    clock.advance(STORE_PROBE_INTERVAL_MILLISECONDS);
    const unanswering = await readiness.isReady();
    store.answers.outcome = { readOnly: false, unknownMigrations: [] };
    clock.advance(STORE_PROBE_INTERVAL_MILLISECONDS);
    const answeringAgain = await readiness.isReady();

    assert.deepEqual(
      [answering, unanswering, answeringAgain],
      [true, false, true],
    );
    assert.equal(store.asked(), 3);
  });

  test('writes one line when it becomes unready, at warning naming the cause, and one at info when it is ready again, however many probes fail between', async () => {
    const store = answeringStore();
    const clock = clockAt(0);
    const { log, written } = lines();
    const readiness = createReadiness(
      serving({ log, monotonicNow: clock.now, probeStore: store.probeStore }),
    );
    const askAfterInterval = async (): Promise<boolean> => {
      clock.advance(STORE_PROBE_INTERVAL_MILLISECONDS);
      return readiness.isReady();
    };

    await readiness.isReady();
    store.answers.outcome = failureWith('57P01');
    await askAfterInterval();
    await askAfterInterval();
    store.answers.outcome = failureWith('storeTimeout');
    await askAfterInterval();
    store.answers.outcome = { readOnly: false, unknownMigrations: [] };
    await askAfterInterval();
    await askAfterInterval();

    assert.deepEqual(written, [
      { fields: { cause: '57P01' }, level: 'warning', message: READINESS_LOST },
      { fields: undefined, level: 'info', message: READINESS_RESTORED },
    ]);
  });

  test('names a failure carrying no code storeFailed', async () => {
    const store = answeringStore();
    const { log, written } = lines();
    store.answers.outcome = failureWith(undefined);
    const readiness = createReadiness(
      serving({ log, probeStore: store.probeStore }),
    );

    assert.equal(await readiness.isReady(), false);
    assert.deepEqual(
      written.map(({ fields }) => fields),
      [{ cause: 'storeFailed' }],
    );
  });

  test('is unready while the store reads as read-only on an instance whose role writes, and ready on one whose role only reads', async () => {
    const store = answeringStore();
    store.answers.outcome = { readOnly: true, unknownMigrations: [] };
    const writing = lines();
    const reading = lines();
    const writer = createReadiness(
      serving({ log: writing.log, probeStore: store.probeStore }),
    );
    const reader = createReadiness(
      serving({
        log: reading.log,
        probeStore: store.probeStore,
        writesStore: () => false,
      }),
    );

    assert.equal(await writer.isReady(), false);
    assert.equal(await reader.isReady(), true);
    assert.deepEqual(
      writing.written.map(({ fields }) => fields),
      [{ cause: 'readOnly' }],
    );
    assert.deepEqual(reading.written, []);
  });

  test('asks the store once for every request arriving while its probe is in flight', async () => {
    const probes = heldProbes();
    const readiness = createReadiness(
      serving({ probeStore: probes.probeStore }),
    );

    const asking = Array.from({ length: 50 }, () => readiness.isReady());
    probes.answer(failureWith('storeTimeout'));
    const answers = await Promise.all(asking);

    assert.equal(probes.asked(), 1);
    assert.deepEqual(
      answers,
      asking.map(() => false),
    );
  });

  test("reuses the store's answer until the interval after its probe began has passed, then asks again", async () => {
    const store = answeringStore();
    const clock = clockAt(0);
    const readiness = createReadiness(
      serving({ monotonicNow: clock.now, probeStore: store.probeStore }),
    );

    await readiness.isReady();
    clock.advance(STORE_PROBE_INTERVAL_MILLISECONDS - 1);
    await readiness.isReady();
    await readiness.isReady();
    const askedWithin = store.asked();
    clock.advance(1);
    await readiness.isReady();

    assert.equal(askedWithin, 1);
    assert.equal(store.asked(), 2);
  });

  test('asks the store again only once a probe outlasting the interval has settled, so probes never overlap', async () => {
    const probes = heldProbes();
    const clock = clockAt(0);
    const readiness = createReadiness(
      serving({ monotonicNow: clock.now, probeStore: probes.probeStore }),
    );

    const first = readiness.isReady();
    clock.advance(3 * STORE_PROBE_INTERVAL_MILLISECONDS);
    const whileInFlight = readiness.isReady();
    const askedInFlight = probes.asked();
    probes.answer(failureWith('storeTimeout'));
    const answers = await Promise.all([first, whileInFlight]);
    const next = readiness.isReady();
    probes.answer({ readOnly: false, unknownMigrations: [] });

    assert.equal(askedInFlight, 1);
    assert.deepEqual(answers, [false, false]);
    assert.equal(await next, true);
    assert.equal(probes.asked(), 2);
  });

  test('is unready while the store records a migration this release does not know, naming that cause before a read-only store, whether its role writes or only reads', async () => {
    const store = answeringStore();
    store.answers.outcome = { readOnly: true, unknownMigrations: [LATER] };
    const writing = lines();
    const reading = lines();
    const writer = createReadiness(
      serving({ log: writing.log, probeStore: store.probeStore }),
    );
    const reader = createReadiness(
      serving({
        log: reading.log,
        probeStore: store.probeStore,
        writesStore: () => false,
      }),
    );

    const answers = [await writer.isReady(), await reader.isReady()];

    assert.deepEqual(answers, [false, false]);
    assert.deepEqual(
      [writing, reading].map(({ written }) =>
        written
          .filter(({ message }) => message === READINESS_LOST)
          .map(({ fields }) => fields),
      ),
      [[{ cause: 'migrationUnknown' }], [{ cause: 'migrationUnknown' }]],
    );
  });

  test('writes schema.migrationUnknown at error, naming each migration and that readiness refused, once each time it turns unready for that reason, however many probes and requests find one', async () => {
    const store = answeringStore();
    const clock = clockAt(0);
    const { log, written } = lines();
    const readiness = createReadiness(
      serving({ log, monotonicNow: clock.now, probeStore: store.probeStore }),
    );
    const askAfterInterval = async (): Promise<void> => {
      clock.advance(STORE_PROBE_INTERVAL_MILLISECONDS);
      await Promise.all(Array.from({ length: 5 }, () => readiness.isReady()));
    };

    await readiness.isReady();
    store.answers.outcome = {
      readOnly: false,
      unknownMigrations: [CHANGED, LATER],
    };
    await askAfterInterval();
    await askAfterInterval();
    store.answers.outcome = { readOnly: false, unknownMigrations: [LATER] };
    await askAfterInterval();
    store.answers.outcome = { readOnly: false, unknownMigrations: [] };
    await askAfterInterval();
    store.answers.outcome = failureWith('storeTimeout');
    await askAfterInterval();
    store.answers.outcome = { readOnly: false, unknownMigrations: [LATER] };
    await askAfterInterval();
    await askAfterInterval();

    assert.deepEqual(written, [
      {
        fields: { cause: 'migrationUnknown' },
        level: 'warning',
        message: READINESS_LOST,
      },
      {
        fields: {
          migrations: [
            { checksumDiffers: true, name: '0001_policy_store' },
            { name: '0099_later_release' },
          ],
          refused: 'readiness',
        },
        level: 'error',
        message: MIGRATION_UNKNOWN,
      },
      { fields: undefined, level: 'info', message: READINESS_RESTORED },
      {
        fields: { cause: 'storeTimeout' },
        level: 'warning',
        message: READINESS_LOST,
      },
      {
        fields: {
          migrations: [{ name: '0099_later_release' }],
          refused: 'readiness',
        },
        level: 'error',
        message: MIGRATION_UNKNOWN,
      },
    ]);
  });
});
