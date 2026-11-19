import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import {
  adjustableClock,
  fixedClock,
  KEY_REFETCH_COOLDOWN_MS,
  untilMonotonicTime,
  untilWallTime,
} from './clocks.js';

suite('the clocks a test configures', () => {
  test('reads a fixed clock as the one instant it was given', () => {
    const clock = fixedClock(1_767_225_600_123);

    assert.equal(clock.now(), 1_767_225_600_123);
    assert.equal(clock.now(), 1_767_225_600_123);
  });

  test("moves an adjustable clock forward by what the test advances, from the system's time", () => {
    const { advance, clock } = adjustableClock();
    const before = Date.now();

    advance(KEY_REFETCH_COOLDOWN_MS);
    advance(1);
    const read = clock.now();

    assert.ok(read >= before + KEY_REFETCH_COOLDOWN_MS + 1);
    assert.ok(read <= Date.now() + KEY_REFETCH_COOLDOWN_MS + 1);
  });

  test("puts the signing-key cache's refetch cooldown at 30 s (#208 Q5)", () => {
    assert.equal(KEY_REFETCH_COOLDOWN_MS, 30_000);
  });
});

suite('waiting until an instant', () => {
  test('waits until an instant of the monotonic clock, and settles at once for one past', async () => {
    const target = performance.now() + 60;

    await untilMonotonicTime(target);
    const reached = performance.now();
    const pastFrom = performance.now();
    await untilMonotonicTime(pastFrom - 1_000);

    assert.ok(reached >= target);
    assert.ok(performance.now() - pastFrom < 50);
  });

  test('waits until an instant of the wall clock, and settles at once for one past', async () => {
    const target = Date.now() + 60;

    await untilWallTime(target);
    const reached = Date.now();
    const pastFrom = performance.now();
    await untilWallTime(Date.now() - 1_000);

    assert.ok(reached >= target);
    assert.ok(performance.now() - pastFrom < 50);
  });
});
