import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import type {
  Actor,
  AuditEvent,
  AuditTransaction,
  LineFields,
} from '../eventLog/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import {
  createKeyConfirmations,
  KEY_CONFIRMATION_FAILED,
} from './createKeyConfirmations.js';
import type { KeyConfirmations } from './types.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0, 250);

const KEY = Object.freeze({
  applicationId: '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68',
  keyId: '6a1e9c3b-2f4d-4b8a-9c7e-1d5f3a8b2e90',
});

const OTHER_KEY = Object.freeze({
  applicationId: KEY.applicationId,
  keyId: 'b3d8f1a2-7c4e-4e9b-8a6d-5f2c1e9a7b34',
});

interface Statement {
  text: string;
  values: readonly unknown[] | undefined;
}

/** One transaction the stand ran: its actor, its statements, and the events recorded in it. */
interface Transaction {
  actor: Actor;
  recorded: AuditEvent[];
  statements: Statement[];
}

interface Stand {
  confirmations: KeyConfirmations;
  lines: { fields: LineFields | undefined; message: string }[];
  transactions: Transaction[];
}

interface StandOptions {
  /** Settles when a transaction may run its work: at once by default. */
  begun?: Promise<void>;

  /** What each transaction throws once its work has run, in turn, as a store failing at its commit does. */
  failures?: readonly unknown[];

  /** Whether the store finds the key still unconfirmed, for each write in turn: true by default. */
  unconfirmed?: readonly boolean[];
}

const standUp = ({
  begun = Promise.resolve(),
  failures = [],
  unconfirmed = [],
}: StandOptions = {}): Stand => {
  const stand: Omit<Stand, 'confirmations'> = { lines: [], transactions: [] };
  const confirmations = createKeyConfirmations({
    eventLog: {
      error: (message, fields) => {
        stand.lines.push({ fields, message });
      },
    },
    settings: { clock: { now: () => NOW }, databaseSchema: 'usher' },
    trail: {
      inTransaction: async (actor, work) => {
        const turn = stand.transactions.length;
        const transaction: Transaction = {
          actor,
          recorded: [],
          statements: [],
        };
        stand.transactions.push(transaction);
        await begun;
        const query = async (text: string, values?: readonly unknown[]) => {
          transaction.statements.push({ text, values });
          return {
            rows: (unconfirmed[turn] ?? true) ? [{ id: KEY.keyId }] : [],
          };
        };
        const opened: AuditTransaction<pg.ClientBase> = {
          // A client that never connects, its query answered here.
          connection: Object.assign(new pg.Client(), { query }),
          record: async (event) => {
            transaction.recorded.push(event);
            return 'event-id';
          },
        };
        const result = await work(opened);
        const failure = failures[turn];
        if (failure !== undefined) {
          throw failure;
        }
        return result;
      },
    },
  });
  return { ...stand, confirmations };
};

const storeFailure = (code: string): Error =>
  Object.assign(new Error('the store refused the statement'), { code });

suite("an application key's confirmation", () => {
  test("sets a key's confirmed_at by the clock where it is still unset, and records applicationKey.confirmation naming the application and the key, in one transaction its own, its actor the system", async () => {
    const stand = standUp();

    await stand.confirmations.confirm(KEY);

    assert.equal(stand.transactions.length, 1);
    const [transaction] = stand.transactions;
    assert.deepEqual(transaction?.actor, { type: 'system' });
    assert.equal(transaction?.statements.length, 1);
    assert.match(
      transaction?.statements[0]?.text ?? '',
      /^UPDATE "usher"\.application_keys SET confirmed_at = \$3\s.*confirmed_at IS NULL/su,
    );
    assert.deepEqual(transaction?.statements[0]?.values, [
      KEY.keyId,
      KEY.applicationId,
      new Date(NOW),
    ]);
    assert.deepEqual(transaction?.recorded, [
      {
        data: { applicationId: KEY.applicationId, keyId: KEY.keyId },
        severity: 'info',
        type: 'applicationKey.confirmation',
      },
    ]);
  });

  test('records no event where the store finds the key confirmed already, as by another instance first', async () => {
    const stand = standUp({ unconfirmed: [false] });

    await stand.confirmations.confirm(KEY);

    assert.equal(stand.transactions[0]?.statements.length, 1);
    assert.deepEqual(stand.transactions[0]?.recorded, []);
  });

  test('writes nothing more for a key once it is known confirmed, whether it confirmed the key or found it confirmed', async () => {
    const confirming = standUp();
    const finding = standUp({ unconfirmed: [false] });

    await confirming.confirmations.confirm(KEY);
    await confirming.confirmations.confirm(KEY);
    await finding.confirmations.confirm(KEY);
    await finding.confirmations.confirm(KEY);

    assert.equal(confirming.transactions.length, 1);
    assert.equal(finding.transactions.length, 1);
  });

  test('shares one write among exchanges racing on one key, each settling once it has', async () => {
    const held: { release: () => void } = { release: () => undefined };
    const begun = new Promise<void>((resolve) => {
      held.release = resolve;
    });
    const stand = standUp({ begun });

    const racing = [1, 2, 3].map(() => stand.confirmations.confirm(KEY));
    await delay(0);
    const settledBefore = await Promise.race([
      Promise.all(racing).then(() => true),
      delay(10).then(() => false),
    ]);
    held.release();
    await Promise.all(racing);

    assert.equal(settledBefore, false);
    assert.equal(stand.transactions.length, 1);
    assert.equal(stand.transactions[0]?.recorded.length, 1);
  });

  test("confirms each key apart, a key known confirmed leaving its application's other key to its own first exchange", async () => {
    const stand = standUp();

    await stand.confirmations.confirm(KEY);
    await stand.confirmations.confirm(OTHER_KEY);

    assert.deepEqual(
      stand.transactions.map(({ statements }) => statements[0]?.values?.[0]),
      [KEY.keyId, OTHER_KEY.keyId],
    );
  });

  test("settles when its write fails, writing a line naming the application, the key and the failure's code alone, and remembering nothing, so the next exchange tries again", async () => {
    const stand = standUp({ failures: [storeFailure('57P01')] });

    await stand.confirmations.confirm(KEY);
    await stand.confirmations.confirm(KEY);

    assert.deepEqual(stand.lines, [
      {
        fields: {
          applicationId: KEY.applicationId,
          code: '57P01',
          keyId: KEY.keyId,
        },
        message: KEY_CONFIRMATION_FAILED,
      },
    ]);
    assert.equal(stand.transactions.length, 2);
  });

  test("settles when its commit goes unconfirmed, writing no line of its own and remembering nothing, the store's answer to the next write deciding", async () => {
    const stand = standUp({
      failures: [new CommitUnconfirmed()],
      unconfirmed: [true, false],
    });

    await stand.confirmations.confirm(KEY);
    await stand.confirmations.confirm(KEY);

    assert.deepEqual(stand.lines, []);
    assert.equal(stand.transactions.length, 2);
    assert.deepEqual(stand.transactions[1]?.recorded, []);
  });
});
