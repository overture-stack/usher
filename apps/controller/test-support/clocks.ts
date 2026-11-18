import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import type { Clock } from './controller.js';

// The clocks a test configures the Controller with, the durations the Controller measures on its
// configured clock that a test moves past, and the waits until an instant of either of the process's
// own clocks: the monotonic one the Bridge times its checks and its grace period on, and the wall clock
// tokens and the store's rows are dated by. The two are kept apart by name, since an instant of one
// read as an instant of the other is off by decades. A timer may fire a fraction of a millisecond
// before its clock reads the instant, so each wait reads its clock again before it settles.

/**
 * The signing-key cache's refetch cooldown (#208 Q5), in milliseconds: the Controller fetches the
 * identity provider's keys again for a key it lacks at most once in this long, measured on its
 * configured clock, so a test moves past it by advancing an {@link adjustableClock}.
 */
export const KEY_REFETCH_COOLDOWN_MS = 30_000;

/**
 * A clock fixed at one instant, for the tests needing a known now (#209 Q2), given to the Controller
 * through its configuration and never the environment.
 *
 * @param instant milliseconds since the Unix epoch.
 */
export const fixedClock = (instant: number): Clock =>
  Object.freeze({ now: () => instant });

/** A clock a test moves forward, configured as the Controller's own (#209 Q2). */
export interface AdjustableClock {
  /** Moves the clock forward. */
  advance(milliseconds: number): void;

  clock: Clock;
}

/** A clock reading the system's time plus however far the test has moved it forward. */
export const adjustableClock = (): AdjustableClock => {
  const state = { offset: 0 };
  return {
    advance: (milliseconds) => {
      state.offset += milliseconds;
    },
    clock: { now: () => Date.now() + state.offset },
  };
};

/**
 * Waits until an instant of the monotonic clock, `performance.now()`, as the Bridge's recording fetch
 * and logger time what they record: the end of a window a test observes, never a guess at how long
 * something takes. An instant already past settles at once.
 *
 * @param at the instant, by `performance.now()`.
 */
export const untilMonotonicTime = async (at: number): Promise<void> => {
  const remaining = at - performance.now();
  if (remaining > 0) {
    await delay(Math.ceil(remaining));
    await untilMonotonicTime(at);
  }
};

/**
 * Waits until an instant of the wall clock, `Date.now()`, such as a token's expiry or the time an
 * operation must fall after. An instant already past settles at once.
 *
 * @param epochMs the instant, in milliseconds since the Unix epoch.
 */
export const untilWallTime = async (epochMs: number): Promise<void> => {
  const remaining = epochMs - Date.now();
  if (remaining > 0) {
    await delay(Math.ceil(remaining));
    await untilWallTime(epochMs);
  }
};
