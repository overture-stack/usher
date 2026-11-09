import type { Tally, TallySettings } from './types.js';

// How often the clock is read for an interval's end, in real time: the configured clock may be moved
// past an interval at any moment, and its tallies are due soon after.
const CLOCK_READING_MILLISECONDS = 1000;

interface Held<Counted> {
  /** The counts by their parts, joined by a newline, which no part holds, so the key names them alone. */
  counts: ReadonlyMap<
    string,
    { count: number; counted: Counted; parts: readonly string[] }
  >;

  interval: number;
}

// Two counts' parts compared one part at a time by name, the first that differs deciding.
const compareParts = (
  first: readonly string[],
  second: readonly string[],
): number =>
  first.reduce(
    (order, part, index) =>
      order === 0 ? part.localeCompare(second[index] ?? '') : order,
    0,
  );

/**
 * Creates a tally. Each count falls in the interval the clock is in, the intervals of
 * `intervalMilliseconds` running from the Unix epoch on the configured clock; once the clock has
 * passed an interval, its counts are recorded, one event per thing counted at least once, as the
 * system, in the order of their parts. Its stop records the counts it holds, whatever the interval,
 * and settles once every recording has. A recording that fails ends there, so a stop still settles.
 *
 * @param settings the clock, the interval, how what is counted is named and becomes an event, and
 *   the trail recording it.
 */
export const createTally = <Counted>({
  clock,
  eventOf,
  intervalMilliseconds,
  partsOf,
  trail,
}: TallySettings<Counted>): Tally<Counted> => {
  const intervalAt = (instant: number): number =>
    Math.floor(instant / intervalMilliseconds);
  const state: {
    held: Held<Counted>;
    recordings: Set<Promise<void>>;
    timer: NodeJS.Timeout | undefined;
  } = {
    held: { counts: new Map(), interval: intervalAt(clock.now()) },
    recordings: new Set(),
    timer: undefined,
  };
  const recordHeld = ({ counts }: Held<Counted>): void => {
    [...counts.values()]
      .filter(({ count }) => count > 0)
      .toSorted((first, second) => compareParts(first.parts, second.parts))
      .forEach(({ count, counted }) => {
        // A recording runs unawaited between stops, so a failure in it must end there.
        const recording = trail
          .recordEvent({ type: 'system' }, eventOf(counted, count))
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
    count: (counted) => {
      advanceTo(intervalAt(clock.now()));
      const parts = partsOf(counted);
      const key = parts.join('\n');
      state.held = {
        ...state.held,
        counts: new Map([
          ...state.held.counts,
          [
            key,
            {
              count: (state.held.counts.get(key)?.count ?? 0) + 1,
              counted,
              parts,
            },
          ],
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
