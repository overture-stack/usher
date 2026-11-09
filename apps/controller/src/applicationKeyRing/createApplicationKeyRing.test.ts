import assert from 'node:assert/strict';
import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { createApplicationKeyCipher } from '../applications/index.js';
import {
  createApplicationKeyRing,
  KEY_CHANGE_FAILED,
  KEY_READ_FAILED,
  KEY_RELOAD_INTERVAL_MILLISECONDS,
  KEY_UNREADABLE,
} from './createApplicationKeyRing.js';
import type { KeyStore, LiveApplicationKey } from './types.js';

interface KeyRow {
  applicationId: string;
  keyId: string | null;
  sealed: Buffer | null;
}

interface Line {
  fields: Readonly<Record<string, unknown>> | undefined;
  message: string;
}

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

// A store answering each read of the keys with the rows the test holds then, or a failure.
const fakeStore = (
  initial: readonly KeyRow[] | Error,
): {
  reads: () => number;
  setRows: (rows: readonly KeyRow[] | Error) => void;
  store: KeyStore;
} => {
  const state: { answer: readonly KeyRow[] | Error; reads: number } = {
    answer: initial,
    reads: 0,
  };
  return {
    reads: () => state.reads,
    setRows: (rows) => {
      state.answer = rows;
    },
    store: {
      query: async <Row extends pg.QueryResultRow>(): Promise<
        pg.QueryResult<Row>
      > => {
        state.reads += 1;
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
    const ring = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log: collectingLog(),
      schema: 'usher',
      store,
    });

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

  test('leaves out a key that does not open, writing its ids to the log once while it stays so', async () => {
    const applicationId = randomUUID();
    const readable = issuedKey(applicationId);
    const altered = issuedKey(applicationId);
    const sealed = Buffer.from(altered.row.sealed ?? Buffer.alloc(0));
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
    const log = collectingLog();
    const { store } = fakeStore([readable.row, { ...altered.row, sealed }]);
    const ring = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log,
      schema: 'usher',
      store,
    });

    await ring.start();
    await ring.reload();
    await ring.stop();

    assert.deepEqual(
      (ring.liveKeysOf(applicationId) ?? []).map(({ keyId }) => keyId),
      [readable.row.keyId],
    );
    assert.deepEqual(log.lines, [
      {
        fields: { applicationId, keyId: altered.row.keyId },
        message: KEY_UNREADABLE,
      },
    ]);
  });

  test('holds a key issued, and drops a key revoked, once reloaded, calling changed for each change alone', async () => {
    const applicationId = randomUUID();
    const kept = issuedKey(applicationId);
    const issued = issuedKey(applicationId);
    const reads = fakeStore([kept.row]);
    const changes: string[] = [];
    const ring = createApplicationKeyRing({
      changed: () => {
        changes.push('changed');
      },
      cipher,
      log: collectingLog(),
      schema: 'usher',
      store: reads.store,
    });
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
    const ring = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log,
      schema: 'usher',
      store: reads.store,
    });
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
    const ring = createApplicationKeyRing({
      changed: () => {
        state.calls += 1;
        throw Object.assign(new Error('a stream quoted a value'), {
          code: 'ERR_STREAM_DESTROYED',
        });
      },
      cipher,
      log,
      schema: 'usher',
      store: reads.store,
    });
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
    const ring = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log: collectingLog(),
      schema: 'usher',
      store,
    });
    await ring.start();

    await Promise.all([ring.reload(), ring.reload(), ring.reload()]);
    await ring.stop();

    assert.equal(reads(), 3);
  });

  test('fails its start when the first read fails, and reads at every reload interval once started until stopped', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const failing = fakeStore(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );
    const refused = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log: collectingLog(),
      schema: 'usher',
      store: failing.store,
    });
    const { reads, store } = fakeStore([]);
    const ring = createApplicationKeyRing({
      changed: () => undefined,
      cipher,
      log: collectingLog(),
      schema: 'usher',
      store,
    });

    await assert.rejects(refused.start(), { code: 'ECONNREFUSED' });
    await ring.start();
    context.mock.timers.tick(KEY_RELOAD_INTERVAL_MILLISECONDS);
    await ring.reload();
    await ring.stop();
    context.mock.timers.tick(KEY_RELOAD_INTERVAL_MILLISECONDS);
    await ring.reload();

    assert.equal(reads(), 3);
  });
});
