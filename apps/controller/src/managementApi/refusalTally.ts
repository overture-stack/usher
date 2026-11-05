import type {
  RefusalTally,
  RefusalTallySettings,
  TallyReason,
} from './types.js';

/** The interval the refusals are counted over, in milliseconds of the configured clock. */
export const REFUSAL_TALLY_INTERVAL_MILLISECONDS = 60_000;

// How often the clock is read for an interval's end, in real time: the configured clock may be moved
// past an interval at any moment, and its tallies are due soon after.
const CLOCK_READING_MILLISECONDS = 1000;

interface Held {
  counts: ReadonlyMap<TallyReason, number>;
  interval: number;
}

const intervalAt = (instant: number): number =>
  Math.floor(instant / REFUSAL_TALLY_INTERVAL_MILLISECONDS);

/**
 * Creates the tally of management credentials that could not be read or verified. Each is counted by
 * reason in the interval its count falls in, the intervals of
 * {@link REFUSAL_TALLY_INTERVAL_MILLISECONDS} running from the Unix epoch on the configured clock; once
 * the clock has passed an interval, its counts are recorded, one per reason counted at least once, in
 * the order of the reasons' names. Its stop records the counts it holds, whatever the interval, and
 * settles once every recording has.
 *
 * @param settings the clock, and what records one reason's count.
 */
export const createRefusalTally = ({
  clock,
  record,
}: RefusalTallySettings): RefusalTally => {
  const state: {
    held: Held;
    recordings: Set<Promise<void>>;
    timer: NodeJS.Timeout | undefined;
  } = {
    held: { counts: new Map(), interval: intervalAt(clock.now()) },
    recordings: new Set(),
    timer: undefined,
  };
  const recordHeld = ({ counts }: Held): void => {
    [...counts.entries()]
      .filter(([, count]) => count > 0)
      .toSorted(([first], [second]) => first.localeCompare(second))
      .forEach(([reason, count]) => {
        // A recording runs unawaited between stops, so a failure in it must end there.
        const recording = record(reason, count)
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            state.recordings.delete(recording);
          });
        state.recordings.add(recording);
      });
  };
  const advanceTo = (interval: number): void => {
    if (interval !== state.held.interval) {
      recordHeld(state.held);
      state.held = { counts: new Map(), interval };
    }
  };
  return {
    count: (reason) => {
      advanceTo(intervalAt(clock.now()));
      state.held = {
        ...state.held,
        counts: new Map([
          ...state.held.counts,
          [reason, (state.held.counts.get(reason) ?? 0) + 1],
        ]),
      };
    },
    start: () => {
      state.timer ??= setInterval(() => {
        advanceTo(intervalAt(clock.now()));
      }, CLOCK_READING_MILLISECONDS).unref();
    },
    stop: async () => {
      clearInterval(state.timer);
      state.timer = undefined;
      recordHeld(state.held);
      state.held = { counts: new Map(), interval: intervalAt(clock.now()) };
      await Promise.all([...state.recordings]);
    },
  };
};
