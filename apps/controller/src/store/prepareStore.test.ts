import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import type { AuditTrail } from '../eventLog/index.js';
import { StartRefusal } from '../failures/index.js';
import { CommitUnconfirmed, StoreTimeout } from '../storeTimeout/index.js';
import { prepareStore } from './prepareStore.js';
import type { StoreSettings } from './types.js';

const SETTINGS: StoreSettings = {
  baseline: ['count'],
  clock: { now: () => Date.UTC(2026, 10, 5) },
  databaseSchema: 'usher',
  keyEncryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  signedInRule: ['count', 'view', 'export'],
  storeTimeoutMilliseconds: 5000,
};

const QUIET = Object.freeze({ warning: () => undefined });

// A trail whose every transaction fails as given, before any statement.
const failingTrail = (
  failure: unknown,
): Pick<AuditTrail<pg.ClientBase>, 'inTransaction'> => ({
  inTransaction: () => Promise.reject(failure),
});

suite("preparing the store at the controller's start", () => {
  test('refuses the start, naming the database URL as the variable at fault and the store timeout in the rule, when the store does not answer it within the store timeout', async () => {
    const refusal = await prepareStore(
      failingTrail(new StoreTimeout()),
      SETTINGS,
      QUIET,
    ).catch((failure: unknown) => failure);

    assert.ok(refusal instanceof StartRefusal);
    assert.deepEqual(refusal.variables, ['USHER_DATABASE_URL']);
    assert.equal(
      refusal.message,
      'the controller refuses to start: USHER_DATABASE_URL names a store that did not answer the start within the time USHER_STORE_TIMEOUT_MILLISECONDS allows',
    );
  });

  test("refuses the start, naming the database URL, when the store does not confirm the start's commit", async () => {
    const refusal = await prepareStore(
      failingTrail(new CommitUnconfirmed()),
      SETTINGS,
      QUIET,
    ).catch((failure: unknown) => failure);

    assert.ok(refusal instanceof StartRefusal);
    assert.equal(
      refusal.message,
      "the controller refuses to start: USHER_DATABASE_URL names a store that did not confirm the start's commit within the time USHER_STORE_TIMEOUT_MILLISECONDS allows",
    );
  });

  test('refuses the start, naming the variable at fault, when the store cannot be reached or signed in to', async () => {
    const refusals = await Promise.all(
      ['ECONNREFUSED', '28P01'].map((code) =>
        prepareStore(
          failingTrail(
            Object.assign(new Error(`refused at 10.0.0.5: ${code}`), { code }),
          ),
          SETTINGS,
          QUIET,
        ).catch((failure: unknown) => failure),
      ),
    );

    assert.deepEqual(
      refusals.map((refusal) =>
        refusal instanceof StartRefusal ? refusal.variables : refusal,
      ),
      [['USHER_DATABASE_URL'], ['USHER_DATABASE_PASSWORD']],
    );
    assert.equal(
      JSON.stringify(refusals.map(String)).includes('10.0.0.5'),
      false,
    );
  });

  test("passes on any other failure of the start's transaction as it was thrown", async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });

    await assert.rejects(
      prepareStore(failingTrail(reset), SETTINGS, QUIET),
      (thrown) => thrown === reset,
    );
  });
});
