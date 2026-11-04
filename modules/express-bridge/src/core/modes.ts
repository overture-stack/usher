import type { Clock } from './clocks.js';
import type { BridgeEventData, BridgeMode, EventLog } from './events.js';
import { positiveWhole } from './numbers.js';

type ModeChangeReason =
  BridgeEventData['revocationChannel.modeChange']['reason'];

/** Mismatches shown by the anonymous fetch while the mode is cold, each logged once. */
type MismatchReason = Extract<
  ModeChangeReason,
  'probableAudienceMismatch' | 'probableKeyMismatch'
>;

/**
 * Derives the mode from the checks and anonymous payloads recorded on it, timing the grace period on
 * the monotonic clock.
 */
export interface ModeMachine {
  /**
   * Records that an anonymous payload is accepted and held, which can make the mode normal; any
   * change is logged.
   */
  anonymousAccepted(): void;

  /**
   * Records that the anonymous payload was dropped, so the mode falls to cold rather than uncertain
   * once the grace period lapses; any change is logged.
   */
  anonymousDropped(): void;

  /**
   * Records a confirmed check, which keeps the mode normal for the grace period from the check's
   * start; any change is logged. It assumes every notice carried by the check has been applied. A
   * check that started before the latest one recorded never shortens the grace period.
   *
   * @param checkStartedAt the check's start, read from the monotonic clock.
   */
  confirmCheck(checkStartedAt: number): void;

  /** The mode now, logging any change brought by the passing of time since the last reading. */
  mode(): BridgeMode;

  /**
   * Logs a probable audience mismatch, shown by the anonymous token's refusal for its audience: at
   * most once, and only while the mode is cold.
   */
  probableAudienceMismatch(): void;

  /**
   * Logs a probable key mismatch, shown by a failed startup self-test: at most once, and only while
   * the mode is cold.
   */
  probableKeyMismatch(): void;

  /** Cancels the timer that logs a lapse while nothing reads the mode. */
  stop(): void;
}

/** A change found on reading the clock can only be the grace period lapsing. */
const lapseReason = (toMode: BridgeMode): ModeChangeReason =>
  toMode === 'uncertain' ? 'gracePeriodLapsed' : 'anonymousPayloadMissing';

/**
 * Creates the mode machine, which starts cold. The mode is:
 * - `cold` until an anonymous payload has been accepted since start and a check confirmed;
 * - `normal` while the latest check started no more than the grace period ago, timed on the
 *   monotonic clock;
 * - past the grace period, `uncertain` while an anonymous payload is held, and `cold` once none is.
 *
 * Every reading sees a lapse at once, and a lapse is logged even when nothing reads the mode. Every
 * change is logged once, as `revocationChannel.modeChange`, with the reason that caused it.
 *
 * @throws {RangeError} for a grace period that is not a positive whole number.
 */
export const createModeMachine = ({
  events,
  graceMs,
  monotonicClock,
}: {
  events: EventLog;
  graceMs: number;
  monotonicClock: Clock;
}): ModeMachine => {
  const grace = positiveWhole(graceMs, 'the grace period');
  const state: {
    acceptedSinceStart: boolean;
    held: boolean;
    lastCheckAt: number | undefined;
    mismatchesReported: ReadonlySet<MismatchReason>;
    reported: BridgeMode;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    acceptedSinceStart: false,
    held: false,
    lastCheckAt: undefined,
    mismatchesReported: new Set(),
    reported: 'cold',
    timer: undefined,
  };

  // Derived on every reading rather than stored, so a reading sees a lapse whether or not the
  // timer has fired.
  const derived = (): BridgeMode => {
    if (state.acceptedSinceStart && state.lastCheckAt !== undefined) {
      if (monotonicClock.now() - state.lastCheckAt <= grace) {
        return 'normal';
      }
      return state.held ? 'uncertain' : 'cold';
    }
    return 'cold';
  };

  const settle = (
    reason: (toMode: BridgeMode) => ModeChangeReason,
  ): BridgeMode => {
    const current = derived();
    if (current !== state.reported) {
      events.emit('revocationChannel.modeChange', {
        fromMode: state.reported,
        reason: reason(current),
        toMode: current,
      });
      state.reported = current;
    }
    return current;
  };

  const reportMismatch = (reason: MismatchReason): void => {
    if (
      !state.mismatchesReported.has(reason) &&
      settle(lapseReason) === 'cold'
    ) {
      events.emit('revocationChannel.modeChange', {
        fromMode: 'cold',
        reason,
        toMode: 'cold',
      });
      state.mismatchesReported = new Set([...state.mismatchesReported, reason]);
    }
  };

  // An unreferenced timer, re-armed at each check and after any firing that still reads normal, logs
  // a lapse even when nothing reads the mode.
  const arm = (): void => {
    clearTimeout(state.timer);
    if (state.lastCheckAt !== undefined) {
      const remaining = state.lastCheckAt + grace - monotonicClock.now();
      state.timer = setTimeout(
        () => {
          state.timer = undefined;
          if (settle(lapseReason) === 'normal') {
            arm();
          }
        },
        // derived() still reads normal at exactly the grace period, so fire one millisecond past it.
        Math.max(0, remaining) + 1,
      );
      state.timer.unref?.();
    }
  };

  return {
    anonymousAccepted: () => {
      settle(lapseReason);
      state.acceptedSinceStart = true;
      state.held = true;
      settle(() => 'anonymousPayloadAccepted');
    },

    anonymousDropped: () => {
      settle(lapseReason);
      state.held = false;
      settle(() => 'anonymousPayloadMissing');
    },

    confirmCheck: (checkStartedAt) => {
      settle(lapseReason);
      state.lastCheckAt = Math.max(
        state.lastCheckAt ?? Number.NEGATIVE_INFINITY,
        checkStartedAt,
      );
      settle(() => 'checkConfirmed');
      arm();
    },

    mode: () => settle(lapseReason),

    probableAudienceMismatch: () => reportMismatch('probableAudienceMismatch'),

    probableKeyMismatch: () => reportMismatch('probableKeyMismatch'),

    stop: () => {
      clearTimeout(state.timer);
      state.timer = undefined;
    },
  };
};
