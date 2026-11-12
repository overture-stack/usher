import type { Clock } from '../configuration/index.js';
import type { Actor } from '../eventLog/index.js';
import { failureCodeOf } from '../failures/index.js';
import { CommitUnconfirmed } from '../storeTimeout/index.js';
import { rejectionEvent } from './rejectionEvents.js';
import { REJECTION_TALLY_INTERVAL_MILLISECONDS } from './rejectionTallyIntervalMilliseconds.js';
import type {
  AssertionRefusals,
  AssertionRefusalSettings,
  RecordingAdmission,
  RefusalLog,
  RefusalRecorder,
  RefusalRoute,
  VerifiedRefusal,
  VerifiedRejectionReason,
} from './types.js';

const SYSTEM: Actor = Object.freeze({ type: 'system' });

// A route admitting its recordings by its own limit alone runs each at once.
const RUN_AT_ONCE: RecordingAdmission = async (_applicationId, recording) => {
  await recording();
  return true;
};

// How often the clock is read for an interval's end, in real time, while a failed recording is held:
// the configured clock may be moved past an interval at any moment, and its lines are due soon after.
const CLOCK_READING_MILLISECONDS = 1000;

/**
 * The line naming the refusals whose `channelAssertion.rejection` the store did not take, refusing it
 * or not answering in time. A recording whose `COMMIT` the store did not confirm is not named here,
 * since its row may be there, and `audit.commitUnconfirmed` already names it by its event's id and
 * type. It is written at warning at most once per
 * application, reason and failure code for each interval of
 * {@link REJECTION_TALLY_INTERVAL_MILLISECONDS} on the configured clock, once the interval ends and
 * only for an interval holding such a failure, with `applicationId`, `reason`, the failure's `code`
 * where it carries one, and `count`, how many failed in the interval. Each of those refusals is
 * counted in `channelAssertion.rejectionTally` too.
 */
export const REJECTION_UNRECORDED = 'channelAssertion.rejectionUnrecorded';

/**
 * The most recordings of refused assertions a route may hold waiting on the store: half the
 * connections of the pool its trail uses, rounded down, and at least one, so those recordings never
 * hold every connection the route's own work needs.
 *
 * @param connections how many connections the route's pool holds at most.
 */
export const pendingRecordingLimit = (connections: number): number =>
  Math.max(1, Math.floor(connections / 2));

interface Unrecorded {
  applicationId: string;

  /** The failure's code, where it carries one that is an identifier. */
  code: string | undefined;

  count: number;
  reason: VerifiedRejectionReason;
}

interface HeldFailures {
  /** The counts by application, reason and code, joined by a newline, which none of them holds. */
  counts: ReadonlyMap<string, Unrecorded>;

  interval: number;
}

interface UnrecordedCounts {
  /** Counts one failed recording, in the interval the clock is in. */
  count(refusal: VerifiedRefusal, failure: unknown): void;

  /** Stops reading the clock and writes the counts it holds, whatever the interval. */
  stop(): void;
}

// Counts the failed recordings by application, reason and failure code over intervals running from
// the Unix epoch on the configured clock, as the tallies do, and writes each count as one line once
// the clock has passed its interval, reading the clock for that end only while a count is held. A
// line carries the failure's code alone, never its message, which may quote a value, nor the
// assertion's digest.
const createUnrecordedCounts = (
  clock: Clock,
  log: RefusalLog,
): UnrecordedCounts => {
  const intervalAt = (instant: number): number =>
    Math.floor(instant / REJECTION_TALLY_INTERVAL_MILLISECONDS);
  const state: { held: HeldFailures; timer: NodeJS.Timeout | undefined } = {
    held: { counts: new Map(), interval: intervalAt(clock.now()) },
    timer: undefined,
  };
  const writeHeld = (next: number): void => {
    state.held.counts.forEach(({ applicationId, code, count, reason }) => {
      log.warning(REJECTION_UNRECORDED, {
        applicationId,
        ...(code === undefined ? {} : { code }),
        count,
        reason,
      });
    });
    clearInterval(state.timer);
    state.timer = undefined;
    state.held = { counts: new Map(), interval: next };
  };
  const advance = (): void => {
    const interval = intervalAt(clock.now());
    if (interval !== state.held.interval) {
      writeHeld(interval);
    }
  };
  return {
    count: ({ applicationId, reason }, failure) => {
      advance();
      const code = failureCodeOf(failure);
      const key = [applicationId, reason, code ?? ''].join('\n');
      state.held = {
        ...state.held,
        counts: new Map([
          ...state.held.counts,
          [
            key,
            {
              applicationId,
              code,
              count: (state.held.counts.get(key)?.count ?? 0) + 1,
              reason,
            },
          ],
        ]),
      };
      state.timer ??= setInterval(advance, CLOCK_READING_MILLISECONDS).unref();
    },
    stop: () => {
      writeHeld(intervalAt(clock.now()));
    },
  };
};

/**
 * Creates the instance's recording of the channel assertions it refuses after they verify under their
 * application's key. Each route takes its recorder from it, every recorder sharing the one memory of
 * refused assertions, and each refusal is taken in this order:
 *
 * 1. an assertion the memory holds is counted, by reason and application;
 * 2. with the memory full, it is counted and not remembered;
 * 3. with the route holding its limit of recordings waiting on the store, it is counted and not
 *    remembered;
 * 4. otherwise it is remembered, and recorded as a `channelAssertion.rejection`, as the system, in a
 *    transaction of its own on the route's trail, within the share of the application it names for a
 *    route admitting its recordings so;
 * 5. a recording the share has no room for is never begun: the assertion is forgotten and the refusal
 *    counted, so its next refusal is taken as its first.
 *
 * No route waits on a recording: each runs beside the answer. A recording that does not commit, the
 * store refusing it, not answering in time, or not confirming its `COMMIT`, forgets the assertion and
 * counts the refusal, so the assertion's next refusal is taken as its first. A failure other than an
 * unconfirmed `COMMIT` is written to the log as {@link REJECTION_UNRECORDED}, at most once per
 * application, reason and failure code for each interval of
 * {@link REJECTION_TALLY_INTERVAL_MILLISECONDS}, with how many failed in it. An unconfirmed `COMMIT` is
 * taken as a failure too, forgotten and counted, since a second record of one refusal is preferred to
 * none, and is left to `audit.commitUnconfirmed`, since its row may be there.
 * The stop settles once every recording begun on any route has ended, writing the failed recordings
 * it holds, whatever the interval.
 *
 * @param settings the clock and the log the failed recordings are written on, the memory every route
 *   shares, and where a refusal not recorded is counted.
 */
export const createAssertionRefusals = ({
  clock,
  log,
  refusedAssertions,
  rejections,
}: AssertionRefusalSettings): AssertionRefusals => {
  const everyRoutePending = new Set<Promise<void>>();
  const unrecorded = createUnrecordedCounts(clock, log);

  const forRoute = ({
    pendingLimit,
    trail,
    within = RUN_AT_ONCE,
  }: RefusalRoute): RefusalRecorder => {
    const pending = new Set<Promise<void>>();

    // Forgotten and counted, so the assertion's next refusal is taken as its first.
    const forgetAndCount = (refusal: VerifiedRefusal): void => {
      refusedAssertions.forget(refusal.signingInputDigest);
      rejections.count(refusal.reason, refusal.applicationId);
    };

    // The route's limit is checked before a place in the share is asked for, so a refusal past the
    // limit takes no place; both are taken in the same turn as the refusal.
    const recorded = (refusal: VerifiedRefusal): void => {
      const recording = within(refusal.applicationId, async () => {
        await trail.inTransaction(SYSTEM, ({ record }) =>
          record(rejectionEvent(refusal)),
        );
      })
        .then(
          (admitted) => {
            if (!admitted) {
              forgetAndCount(refusal);
            }
          },
          (failure: unknown) => {
            forgetAndCount(refusal);
            if (!(failure instanceof CommitUnconfirmed)) {
              unrecorded.count(refusal, failure);
            }
          },
        )
        .finally(() => {
          pending.delete(recording);
          everyRoutePending.delete(recording);
        });
      pending.add(recording);
      everyRoutePending.add(recording);
    };

    return {
      refused: (refusal) => {
        const { applicationId, reason, signingInputDigest } = refusal;
        if (
          refusedAssertions.has(signingInputDigest) ||
          refusedAssertions.isFull() ||
          pending.size >= pendingLimit
        ) {
          rejections.count(reason, applicationId);
          return;
        }
        refusedAssertions.remember(signingInputDigest);
        recorded(refusal);
      },
    };
  };

  return {
    forRoute,
    stop: async () => {
      await Promise.all([...everyRoutePending]);
      unrecorded.stop();
    },
  };
};
