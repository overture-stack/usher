import type {
  RejectionTally,
  RejectionTallySettings,
  UnverifiedRejectionReason,
} from './types.js';

/** The interval the refusals are counted over, in milliseconds of the configured clock. */
export const REJECTION_TALLY_INTERVAL_MILLISECONDS = 60_000;

// How often the clock is read for an interval's end, in real time: the configured clock may be moved
// past an interval at any moment, and its tallies are due soon after.
const CLOCK_READING_MILLISECONDS = 1000;

/** One count's key: its reason, and the registered application named, or none. */
interface Counted {
  applicationId: string | undefined;
  reason: UnverifiedRejectionReason;
}

interface Held {
  /** The counts by their key, written as {@link keyOf} writes it. */
  counts: ReadonlyMap<string, { count: number; counted: Counted }>;
  interval: number;
}

const intervalAt = (instant: number): number =>
  Math.floor(instant / REJECTION_TALLY_INTERVAL_MILLISECONDS);

// A reason and an application id hold no newline, so the two joined by one name the pair alone.
const keyOf = ({ applicationId, reason }: Counted): string =>
  `${reason}\n${applicationId ?? ''}`;

/**
 * Creates the tally of channel assertions refused before they could be verified. Each is counted by
 * reason and by the registered application it names, or none, in the interval its count falls in, the
 * intervals of {@link REJECTION_TALLY_INTERVAL_MILLISECONDS} running from the Unix epoch on the
 * configured clock; once the clock has passed an interval, its counts are recorded, one per reason and
 * application counted at least once, in the order of the reasons' names and then the applications',
 * the count naming none first. Its stop records the counts it holds, whatever the interval, and
 * settles once every recording has.
 *
 * @param settings the clock, and what records one count.
 */
export const createRejectionTally = ({
  clock,
  record,
}: RejectionTallySettings): RejectionTally => {
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
    [...counts.values()]
      .filter(({ count }) => count > 0)
      .toSorted(({ counted: first }, { counted: second }) =>
        first.reason === second.reason
          ? (first.applicationId ?? '').localeCompare(
              second.applicationId ?? '',
            )
          : first.reason.localeCompare(second.reason),
      )
      .forEach(({ count, counted }) => {
        // A recording runs unawaited between stops, so a failure in it must end there.
        const recording = record(counted.reason, counted.applicationId, count)
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
    count: (reason, applicationId) => {
      advanceTo(intervalAt(clock.now()));
      const counted = { applicationId, reason };
      const key = keyOf(counted);
      state.held = {
        ...state.held,
        counts: new Map([
          ...state.held.counts,
          [
            key,
            { count: (state.held.counts.get(key)?.count ?? 0) + 1, counted },
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
