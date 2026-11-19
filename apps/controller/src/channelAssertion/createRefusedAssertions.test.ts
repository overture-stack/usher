import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  type Clock,
  CLOCK_TOLERANCE_MILLISECONDS,
} from '../configuration/index.js';
import { CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS } from './createChannelAssertionVerifier.js';
import {
  createRefusedAssertions,
  REFUSED_ASSERTION_WINDOW_MILLISECONDS,
  REFUSED_ASSERTIONS_LIMIT,
} from './createRefusedAssertions.js';

// A clock a test moves by hand.
const handClock = (): Clock & { at: number } => {
  const clock = {
    at: 1_762_300_000_000,
    now: (): number => clock.at,
  };
  return clock;
};

const digests = (count: number, prefix: string): readonly string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

suite("an instance's memory of refused assertions", () => {
  test('keeps each assertion for the longest an assertion may live and the clock tolerance', () => {
    assert.equal(
      REFUSED_ASSERTION_WINDOW_MILLISECONDS,
      CHANNEL_ASSERTION_MAXIMUM_LIFETIME_SECONDS * 1000 +
        CLOCK_TOLERANCE_MILLISECONDS,
    );
    assert.equal(REFUSED_ASSERTIONS_LIMIT, 10_000);
  });

  test('remembers an assertion for the window from its first refusal, then lets its next refusal be taken as its first', () => {
    const clock = handClock();
    const memory = createRefusedAssertions(clock);
    const start = clock.at;

    memory.remember('digest-1');
    clock.at = start + REFUSED_ASSERTION_WINDOW_MILLISECONDS - 1;
    const withinTheWindow = memory.has('digest-1');
    clock.at = start + REFUSED_ASSERTION_WINDOW_MILLISECONDS;
    const pastTheWindow = memory.has('digest-1');

    assert.equal(withinTheWindow, true);
    assert.equal(pastTheWindow, false);
  });

  test('holds at most its limit of assertions, remembering none past it while full', () => {
    const memory = createRefusedAssertions(handClock());
    const held = digests(REFUSED_ASSERTIONS_LIMIT, 'held');

    held.forEach((digest) => {
      memory.remember(digest);
    });
    memory.remember('one-too-many');

    assert.equal(memory.isFull(), true);
    assert.equal(memory.has('one-too-many'), false);
    assert.equal(memory.has(held[0] ?? ''), true);
  });

  test('drops the expired assertions from the front, keeping those still within their window and making room for new ones', () => {
    const clock = handClock();
    const memory = createRefusedAssertions(clock);
    const start = clock.at;
    const later = digests(REFUSED_ASSERTIONS_LIMIT - 1, 'later');

    memory.remember('first');
    clock.at = start + 1000;
    later.forEach((digest) => {
      memory.remember(digest);
    });
    const fullBefore = memory.isFull();
    clock.at = start + REFUSED_ASSERTION_WINDOW_MILLISECONDS;
    const fullAfter = memory.isFull();
    memory.remember('new');

    assert.equal(fullBefore, true);
    assert.equal(fullAfter, false);
    assert.equal(memory.has('first'), false);
    assert.equal(memory.has(later[0] ?? ''), true);
    assert.equal(memory.has('new'), true);
  });

  test('forgets an assertion it is told to forget', () => {
    const memory = createRefusedAssertions(handClock());

    memory.remember('digest-1');
    memory.forget('digest-1');

    assert.equal(memory.has('digest-1'), false);
  });
});
