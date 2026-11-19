import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { settledWithin } from './waiting.js';

suite('a promise settled within a bound', () => {
  test('gives the value of a promise settling within the bound', async () => {
    assert.equal(await settledWithin(delay(10, 'answered'), 1_000), 'answered');
  });

  test('gives nothing for one still pending at the bound, and leaves it going on', async () => {
    const pending = delay(200, 'later');

    const within = await settledWithin(pending, 20);

    assert.equal(within, undefined);
    assert.equal(await pending, 'later');
  });

  test('throws a rejection that comes within the bound', async () => {
    await assert.rejects(
      settledWithin(Promise.reject(new Error('refused')), 1_000),
      { message: 'refused' },
    );
  });
});
