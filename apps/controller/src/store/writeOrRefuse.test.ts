import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { StartRefusal } from '../startRefusal.js';
import { writeOrRefuse } from './writeOrRefuse.js';

const PROBLEM = Object.freeze({
  rule: 'names a database role that may not write what the start needs',
  variable: 'USHER_DATABASE_URL',
});

const storeError = (code: string): pg.DatabaseError =>
  Object.assign(new pg.DatabaseError('refused', 0, 'error'), { code });

suite('a write the start needs', () => {
  test("gives the write's result when the store takes it", async () => {
    assert.equal(await writeOrRefuse(PROBLEM, async () => 3), 3);
  });

  test('refuses the start with the problem given when the database role may not write', async () => {
    const outcome = await writeOrRefuse(PROBLEM, () =>
      Promise.reject(storeError('42501')),
    ).catch((error: unknown) => error);

    assert.ok(outcome instanceof StartRefusal);
    assert.deepEqual(outcome.variables, [PROBLEM.variable]);
    assert.equal(
      outcome.message,
      `the controller refuses to start: ${PROBLEM.variable} ${PROBLEM.rule}`,
    );
  });

  test('passes on any other failure as it was thrown', async () => {
    const unique = storeError('23505');
    const unreachable = new Error('connection terminated');

    await assert.rejects(
      writeOrRefuse(PROBLEM, () => Promise.reject(unique)),
      (error) => error === unique,
    );
    await assert.rejects(
      writeOrRefuse(PROBLEM, () => Promise.reject(unreachable)),
      (error) => error === unreachable,
    );
  });
});
