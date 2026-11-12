import assert from 'node:assert/strict';
import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { createApplicationKeyCipher } from '../applications/index.js';
import type {
  Actor,
  AuditEvent,
  AuditTransaction,
  TrailConnection,
} from '../eventLog/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  createApplicationKeyRing,
  KEY_CHANGE_FAILED,
  KEY_READ_FAILED,
  KEY_RELOAD_INTERVAL_MILLISECONDS,
  KEY_UNREADABLE_UNRECORDED,
} from './createApplicationKeyRing.js';
import type {
  ApplicationKeyRingSettings,
  KeyStore,
  LiveApplicationKey,
} from './types.js';

interface KeyRow {
  applicationId: string;
  keyId: string | null;
  sealed: Buffer | null;
}

interface Line {
  fields: Readonly<Record<string, unknown>> | undefined;
  message: string;
}

interface Recorded {
  actor: Actor;
  event: AuditEvent;
}

const START = Date.UTC(2026, 10, 10, 12, 0, 0);

// How often the ring reads its clock, in real time, as the mocked timers advance it.
const CLOCK_READING_MILLISECONDS = 1000;

// Settles once the work already begun, a read of the fake store and what it records, has ended.
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const cipher = createApplicationKeyCipher(
  randomBytes(32).toString('base64url'),
);

// An application key, sealed as the store holds it, and its bytes, to derive what the bridge derives.
const issuedKey = (applicationId: string): { bytes: Buffer; row: KeyRow } => {
  const keyId = randomUUID();
  const bytes = randomBytes(32);
  return {
    bytes,
    row: {
      applicationId,
      keyId,
      sealed: cipher.seal({ applicationId, keyId }, bytes),
    },
  };
};

// The row of a key whose sealed bytes were altered in the store, so it no longer opens.
const alteredRow = (row: KeyRow): KeyRow => {
  const sealed = Buffer.from(row.sealed ?? Buffer.alloc(0));
  sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
  return { ...row, sealed };
};

// A store answering each read of the keys with the rows the test holds then, or a failure, keeping the
// instant of the clock given at which each read began.
const fakeStore = (
  initial: readonly KeyRow[] | Error,
  clock: ApplicationKeyRingSettings['clock'] = { now: () => START },
): {
  readAt: () => readonly number[];
  reads: () => number;
  setRows: (rows: readonly KeyRow[] | Error) => void;
  store: KeyStore;
} => {
  const state: { answer: readonly KeyRow[] | Error; readAt: number[] } = {
    answer: initial,
    readAt: [],
  };
  return {
    readAt: () => [...state.readAt],
    reads: () => state.readAt.length,
    setRows: (rows) => {
      state.answer = rows;
    },
    store: {
      query: async <Row extends pg.QueryResultRow>(): Promise<
        pg.QueryResult<Row>
      > => {
        state.readAt.push(clock.now());
        const { answer } = state;
        if (answer instanceof Error) {
          throw answer;
        }
        return { rows: [...answer] } as unknown as pg.QueryResult<Row>;
      },
    },
  };
};

const collectingLog = (): {
  error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  lines: Line[];
} => {
  const lines: Line[] = [];
  return {
    error: (message, fields) => {
      lines.push({ fields, message });
    },
    lines,
  };
};

const UNUSED_CONNECTION: TrailConnection = Object.freeze({
  query: async () => ({ command: 'SELECT' }),
  release: () => undefined,
});

// A trail keeping each event its transactions record once they commit, every transaction committing
// unless the test has given failures for the next ones to throw instead, one each, in turn.
const collectingTrail = (): {
  failNext: (...failures: readonly Error[]) => void;
  recorded: Recorded[];
  trail: ApplicationKeyRingSettings['trail'];
} => {
  const recorded: Recorded[] = [];
  const state: { failures: readonly Error[] } = { failures: [] };
  return {
    failNext: (...failures) => {
      state.failures = failures;
    },
    recorded,
    trail: {
      inTransaction: async <Result>(
        actor: Actor,
        work: (
          transaction: AuditTransaction<TrailConnection>,
        ) => Promise<Result>,
      ): Promise<Result> => {
        const written: AuditEvent[] = [];
        const result = await work({
          connection: UNUSED_CONNECTION,
          record: async (event) => {
            written.push(event);
            return randomUUID();
          },
        });
        const [failure, ...later] = state.failures;
        state.failures = later;
        if (failure !== undefined) {
          throw failure;
        }
        recorded.push(...written.map((event) => ({ actor, event })));
        return result;
      },
    },
  };
};

// A clock the test moves, as a test moves the controller's configured clock.
const movableClock = (): {
  clock: ApplicationKeyRingSettings['clock'];
  move: (milliseconds: number) => void;
} => {
  const time = { now: START };
  return {
    clock: { now: () => time.now },
    move: (milliseconds) => {
      time.now += milliseconds;
    },
  };
};

const ringSettings = (
  store: KeyStore,
  settings: Partial<ApplicationKeyRingSettings> = {},
): ApplicationKeyRingSettings => ({
  changed: () => undefined,
  cipher,
  clock: movableClock().clock,
  log: collectingLog(),
  schema: 'usher',
  store,
  trail: collectingTrail().trail,
  ...settings,
});

const unreadableEvent = ({ applicationId, keyId }: KeyRow): Recorded => ({
  actor: { type: 'system' },
  event: {
    data: { applicationId, keyId },
    severity: 'critical',
    type: 'applicationKey.unreadable',
  },
});

// The HMAC the bridge signs a channel assertion with, derived from the key's bytes as keys.ts does.
const bridgeSignature = (bytes: Buffer, text: string): string =>
  createHmac(
    'sha256',
    Buffer.from(
      hkdfSync(
        'sha256',
        bytes,
        Buffer.alloc(0),
        'usher/v1/channel-assertion',
        32,
      ),
    ),
  )
    .update(text)
    .digest('base64url');

const signatureUnder = (key: LiveApplicationKey, text: string): string =>
  createHmac('sha256', key.channelAssertion).update(text).digest('base64url');

suite('the ring of live application keys', () => {
  test('holds every live key of each registered application, and none for an application holding none', async () => {
    const searchId = randomUUID();
    const emptyId = randomUUID();
    const first = issuedKey(searchId);
    const second = issuedKey(searchId);
    const { store } = fakeStore([
      first.row,
      second.row,
      { applicationId: emptyId, keyId: null, sealed: null },
    ]);
    const ring = createApplicationKeyRing(ringSettings(store));

    await ring.start();
    await ring.stop();

    const keys = ring.liveKeysOf(searchId) ?? [];
    assert.deepEqual(
      keys.map(({ keyId }) => keyId),
      [first.row.keyId, second.row.keyId],
    );
    assert.deepEqual(ring.liveKeysOf(emptyId), []);
    assert.equal(ring.liveKeysOf(randomUUID()), undefined);
    assert.equal(
      signatureUnder(keys[0] ?? assert.fail('no key held'), 'signed'),
      bridgeSignature(first.bytes, 'signed'),
    );
  });

  test('counts every registered application as the last read found them, one holding no live key included, and none before its first read', async () => {
    const searchId = randomUUID();
    const reads = fakeStore([
      issuedKey(searchId).row,
      issuedKey(searchId).row,
      { applicationId: randomUUID(), keyId: null, sealed: null },
    ]);
    const ring = createApplicationKeyRing(ringSettings(reads.store));

    const beforeTheFirstRead = ring.registeredCount();
    await ring.start();
    const atTheStart = ring.registeredCount();
    reads.setRows([
      issuedKey(searchId).row,
      issuedKey(randomUUID()).row,
      issuedKey(randomUUID()).row,
      issuedKey(randomUUID()).row,
    ]);
    await ring.reload();
    const onceReloaded = ring.registeredCount();
    await ring.stop();

    assert.deepEqual([beforeTheFirstRead, atTheStart, onceReloaded], [0, 2, 4]);
  });

  test('holds a key issued, and drops a key revoked, once reloaded, calling changed for each change alone', async () => {
    const applicationId = randomUUID();
    const kept = issuedKey(applicationId);
    const issued = issuedKey(applicationId);
    const reads = fakeStore([kept.row]);
    const changes: string[] = [];
    const ring = createApplicationKeyRing(
      ringSettings(reads.store, {
        changed: () => {
          changes.push('changed');
        },
      }),
    );
    await ring.start();
    const issuedId = issued.row.keyId ?? '';

    reads.setRows([kept.row, issued.row]);
    await ring.reload();
    const heldAfterIssue = ring.holds({ applicationId, keyId: issuedId });
    await ring.reload();
    reads.setRows([issued.row]);
    await ring.reload();
    await ring.stop();

    assert.equal(heldAfterIssue, true);
    assert.equal(
      ring.holds({ applicationId, keyId: kept.row.keyId ?? '' }),
      false,
    );
    assert.equal(ring.holds({ applicationId, keyId: issuedId }), true);
    assert.deepEqual(changes, ['changed', 'changed', 'changed']);
  });

  test('keeps the keys it holds when a read fails, writing the failure to the log by its code alone', async () => {
    const applicationId = randomUUID();
    const held = issuedKey(applicationId);
    const reads = fakeStore([held.row]);
    const log = collectingLog();
    const ring = createApplicationKeyRing(ringSettings(reads.store, { log }));
    await ring.start();

    reads.setRows(
      Object.assign(new Error('relation "secret" does not exist'), {
        code: '42P01',
      }),
    );
    await ring.reload();
    await ring.stop();

    assert.equal(ring.liveKeysOf(applicationId)?.length, 1);
    assert.deepEqual(log.lines, [
      { fields: { code: '42P01' }, message: KEY_READ_FAILED },
    ]);
  });

  test('holds the keys a reload read when what a change calls throws, writing the failure by its code alone, and never rejects', async () => {
    const applicationId = randomUUID();
    const held = issuedKey(applicationId);
    const issued = issuedKey(applicationId);
    const reads = fakeStore([held.row]);
    const log = collectingLog();
    const state = { calls: 0 };
    const ring = createApplicationKeyRing(
      ringSettings(reads.store, {
        changed: () => {
          state.calls += 1;
          throw Object.assign(new Error('a stream quoted a value'), {
            code: 'ERR_STREAM_DESTROYED',
          });
        },
        log,
      }),
    );
    await ring.start();

    reads.setRows([held.row, issued.row]);
    await ring.reload();
    await ring.stop();

    assert.equal(state.calls, 2);
    assert.equal(
      ring.holds({ applicationId, keyId: issued.row.keyId ?? '' }),
      true,
    );
    assert.deepEqual(log.lines, [
      { fields: { code: 'ERR_STREAM_DESTROYED' }, message: KEY_CHANGE_FAILED },
      { fields: { code: 'ERR_STREAM_DESTROYED' }, message: KEY_CHANGE_FAILED },
    ]);
  });

  test('answers reloads asked for during a read with one read begun after it', async () => {
    const { reads, store } = fakeStore([]);
    const ring = createApplicationKeyRing(ringSettings(store));
    await ring.start();

    await Promise.all([ring.reload(), ring.reload(), ring.reload()]);
    await ring.stop();

    assert.equal(reads(), 3);
  });
});

suite("a stored key that does not open, as the ring's reads find it", () => {
  test('is left out of the ring, its application holding its other keys alone, and recorded at its start as applicationKey.unreadable, critical, naming the application and the key, its actor the system', async () => {
    const applicationId = randomUUID();
    const readable = issuedKey(applicationId);
    const altered = alteredRow(issuedKey(applicationId).row);
    const log = collectingLog();
    const { recorded, trail } = collectingTrail();
    const { store } = fakeStore([readable.row, altered]);
    const ring = createApplicationKeyRing(ringSettings(store, { log, trail }));

    await ring.start();
    const recordedAtStart = [...recorded];
    await ring.stop();

    assert.deepEqual(
      (ring.liveKeysOf(applicationId) ?? []).map(({ keyId }) => keyId),
      [readable.row.keyId],
    );
    assert.equal(
      ring.holds({ applicationId, keyId: altered.keyId ?? '' }),
      false,
    );
    assert.deepEqual(recordedAtStart, [unreadableEvent(altered)]);
    assert.deepEqual(log.lines, []);
  });

  test('is recorded once while it stays unreadable, however many reads find it so, and each key apart', async () => {
    const first = alteredRow(issuedKey(randomUUID()).row);
    const second = alteredRow(issuedKey(randomUUID()).row);
    const { recorded, trail } = collectingTrail();
    const reads = fakeStore([first]);
    const ring = createApplicationKeyRing(ringSettings(reads.store, { trail }));

    await ring.start();
    await ring.reload();
    reads.setRows([first, second]);
    await ring.reload();
    await ring.reload();
    await ring.stop();

    assert.deepEqual(recorded, [
      unreadableEvent(first),
      unreadableEvent(second),
    ]);
  });

  test('is recorded again once it has opened, or been revoked, and then stops opening', async () => {
    const applicationId = randomUUID();
    const issued = issuedKey(applicationId);
    const altered = alteredRow(issued.row);
    const { recorded, trail } = collectingTrail();
    const reads = fakeStore([altered]);
    const ring = createApplicationKeyRing(ringSettings(reads.store, { trail }));

    await ring.start();
    reads.setRows([issued.row]);
    await ring.reload();
    const heldOnceRestored = ring.holds({
      applicationId,
      keyId: issued.row.keyId ?? '',
    });
    reads.setRows([altered]);
    await ring.reload();
    reads.setRows([]);
    await ring.reload();
    reads.setRows([altered]);
    await ring.reload();
    await ring.stop();

    assert.equal(heldOnceRestored, true);
    assert.deepEqual(recorded, [
      unreadableEvent(altered),
      unreadableEvent(altered),
      unreadableEvent(altered),
    ]);
  });

  test("writes each recording that fails to the log as applicationKeyRing.unreadableUnrecorded, naming the application, the key and the failure's code alone, and records the key at the next read", async () => {
    const altered = alteredRow(issuedKey(randomUUID()).row);
    const { failNext, recorded, trail } = collectingTrail();
    const log = collectingLog();
    const { store } = fakeStore([altered]);
    const ring = createApplicationKeyRing(ringSettings(store, { log, trail }));

    failNext(
      Object.assign(new Error('permission denied for table audit_log'), {
        code: '42501',
      }),
      new TypeError('a message quoting a value'),
    );
    await ring.start();
    await ring.reload();
    const recordedWhileFailing = [...recorded];
    await ring.reload();
    await ring.reload();
    await ring.stop();

    const named = {
      applicationId: altered.applicationId,
      keyId: altered.keyId,
    };
    assert.deepEqual(recordedWhileFailing, []);
    assert.deepEqual(recorded, [unreadableEvent(altered)]);
    assert.deepEqual(log.lines, [
      {
        fields: { ...named, code: '42501' },
        message: KEY_UNREADABLE_UNRECORDED,
      },
      { fields: named, message: KEY_UNREADABLE_UNRECORDED },
    ]);
  });

  test('writes no line of its own for a recording whose commit went unconfirmed, and records the key at the next read', async () => {
    const altered = alteredRow(issuedKey(randomUUID()).row);
    const { failNext, recorded, trail } = collectingTrail();
    const log = collectingLog();
    const { store } = fakeStore([altered]);
    const ring = createApplicationKeyRing(ringSettings(store, { log, trail }));

    failNext(new CommitUnconfirmed());
    await ring.start();
    const recordedAtStart = [...recorded];
    await ring.reload();
    await ring.reload();
    await ring.stop();

    assert.deepEqual(recordedAtStart, []);
    assert.deepEqual(recorded, [unreadableEvent(altered)]);
    assert.deepEqual(log.lines, []);
  });

  test('is left out by a reload before its recording has ended', async () => {
    const applicationId = randomUUID();
    const issued = issuedKey(applicationId);
    const reads = fakeStore([issued.row]);
    const release: { recording: (() => void) | undefined } = {
      recording: undefined,
    };
    const ring = createApplicationKeyRing(
      ringSettings(reads.store, {
        trail: {
          inTransaction: <Result>(
            _actor: Actor,
            work: (
              transaction: AuditTransaction<TrailConnection>,
            ) => Promise<Result>,
          ): Promise<Result> =>
            work({
              connection: UNUSED_CONNECTION,
              record: () =>
                new Promise((resolve) => {
                  release.recording = () => {
                    resolve(randomUUID());
                  };
                }),
            }),
        },
      }),
    );
    await ring.start();

    reads.setRows([alteredRow(issued.row)]);
    const reloading = ring.reload();
    await settled();
    const heldWhileRecording = ring.holds({
      applicationId,
      keyId: issued.row.keyId ?? '',
    });
    release.recording?.();
    await reloading;
    await ring.stop();

    assert.equal(release.recording === undefined, false);
    assert.equal(heldWhileRecording, false);
  });
});

suite('the ring reading its keys again on the configured clock', () => {
  test('fails its start when the first read fails', async () => {
    const failing = fakeStore(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );
    const ring = createApplicationKeyRing(ringSettings(failing.store));

    await assert.rejects(ring.start(), { code: 'ECONNREFUSED' });
  });

  test('reads again within a second of real time once its clock comes within one clock reading of the reload interval since its last read, and never once stopped', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { clock, move } = movableClock();
    const { reads, store } = fakeStore([]);
    const ring = createApplicationKeyRing(ringSettings(store, { clock }));
    await ring.start();

    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsWithTheClockStill = reads();
    move(KEY_RELOAD_INTERVAL_MILLISECONDS - CLOCK_READING_MILLISECONDS - 1);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsJustShortOfDue = reads();
    move(1);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsOnceDue = reads();
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsASecondLater = reads();
    await ring.stop();
    move(KEY_RELOAD_INTERVAL_MILLISECONDS);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);

    assert.deepEqual(
      [
        readsWithTheClockStill,
        readsJustShortOfDue,
        readsOnceDue,
        readsASecondLater,
        reads(),
      ],
      [1, 1, 2, 2, 2],
    );
  });

  test('begins each read its clock paces within the reload interval of the last read, its clock running in step with real time: one clock reading short of it at the earliest, a millisecond short at the latest', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { clock, move } = movableClock();
    const { readAt, store } = fakeStore([], clock);
    const ring = createApplicationKeyRing(ringSettings(store, { clock }));
    const pass = (milliseconds: number, times = 1): void => {
      Array.from({ length: times }).forEach(() => {
        move(milliseconds);
        context.mock.timers.tick(milliseconds);
      });
    };
    await ring.start();

    // Read on a reading of the clock: the earliest a paced read can begin.
    pass(CLOCK_READING_MILLISECONDS, 29);
    await settled();
    // Read a millisecond after a reading of the clock: the latest a paced read can begin.
    pass(1);
    await ring.reload();
    pass(CLOCK_READING_MILLISECONDS - 1);
    pass(CLOCK_READING_MILLISECONDS, 29);
    await settled();
    await ring.stop();

    const [started = 0, earliest = 0, asked = 0, latest = 0] = readAt();
    assert.deepEqual(
      readAt().map((instant) => instant - START),
      [0, 29_000, 29_001, 59_000],
    );
    assert.deepEqual(
      [earliest - started, latest - asked],
      [
        KEY_RELOAD_INTERVAL_MILLISECONDS - CLOCK_READING_MILLISECONDS,
        KEY_RELOAD_INTERVAL_MILLISECONDS - 1,
      ],
    );
  });

  test('measures the interval from its last read, a reload asked for included', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { clock, move } = movableClock();
    const { reads, store } = fakeStore([]);
    const ring = createApplicationKeyRing(ringSettings(store, { clock }));
    await ring.start();

    move(KEY_RELOAD_INTERVAL_MILLISECONDS / 2);
    await ring.reload();
    move(KEY_RELOAD_INTERVAL_MILLISECONDS / 2);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsAnIntervalAfterTheStart = reads();
    move(KEY_RELOAD_INTERVAL_MILLISECONDS / 2);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    await ring.stop();

    assert.equal(readsAnIntervalAfterTheStart, 2);
    assert.equal(reads(), 3);
  });

  test('reads again within a second of real time once its clock reads earlier than its last read', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { clock, move } = movableClock();
    const { reads, store } = fakeStore([]);
    const ring = createApplicationKeyRing(ringSettings(store, { clock }));
    await ring.start();

    move(-1);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    const readsOnceMovedBack = reads();
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    await ring.stop();

    assert.equal(readsOnceMovedBack, 2);
    assert.equal(reads(), 2);
  });

  test('records an unreadable key found by a read the clock paced', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { clock, move } = movableClock();
    const issued = issuedKey(randomUUID());
    const altered = alteredRow(issued.row);
    const { recorded, trail } = collectingTrail();
    const reads = fakeStore([issued.row]);
    const ring = createApplicationKeyRing(
      ringSettings(reads.store, { clock, trail }),
    );
    await ring.start();

    reads.setRows([altered]);
    move(KEY_RELOAD_INTERVAL_MILLISECONDS);
    context.mock.timers.tick(CLOCK_READING_MILLISECONDS);
    await settled();
    await ring.stop();

    assert.deepEqual(recorded, [unreadableEvent(altered)]);
    assert.equal(
      ring.holds({
        applicationId: issued.row.applicationId,
        keyId: issued.row.keyId ?? '',
      }),
      false,
    );
  });
});
