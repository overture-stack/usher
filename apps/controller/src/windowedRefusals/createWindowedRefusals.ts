import type { Actor } from '../eventLog/index.js';
import {
  type ClosedWindow,
  createRefusalWindows,
  type RefusalKey,
} from '../refusalWindows/index.js';
import type {
  WindowedRefusal,
  WindowedRefusals,
  WindowedRefusalSettings,
} from './types.js';

/** The line naming a closing event the store did not take, or did not confirm taking, carrying it whole. */
export const CLOSING_UNRECORDED = 'refusalWindow.closingUnrecorded';

/**
 * How often the clock is read for the windows due to close, in real time: the configured clock may
 * be moved past a window's close at any moment, and its closing event is due soon after.
 */
export const WINDOW_CLOCK_READING_MILLISECONDS = 1000;

const SYSTEM: Actor = Object.freeze({ type: 'system' });

const TYPE_PREFIX = 'bio.overture.';

/**
 * Creates an instance's windowed refusals, every window held in its memory alone and measured on the
 * configured clock, as {@link createRefusalWindows} keeps them. The refusal opening a window is
 * recorded by the route, as it records any refusal; every later one under its key writes nothing and
 * is counted. Every window's closing event, the route's own, is recorded as the system once its
 * opening has settled, naming that opening's event as `windowId` once it committed, its reason, the
 * application its key names if any, its count of every refusal in it, the opening one included, and
 * the instants of its first and latest refusals. Closing events are recorded one at a time, in the
 * order their windows closed.
 *
 * No refusal goes uncounted while the instance runs. A window whose opening event did not commit,
 * or whose opening threw, counts that refusal as any other, and its closing event names no
 * `windowId`. A
 * closing event the store does not take, or does not confirm taking, is written to the log at error
 * as {@link CLOSING_UNRECORDED}, carrying its type and every member it holds, none of which is a
 * token or a subject.
 *
 * @param settings the clock, each route's closing event, the log, and the trail.
 */
export const createWindowedRefusals = ({
  clock,
  closingEvents,
  log,
  trail,
}: WindowedRefusalSettings): WindowedRefusals => {
  const windows = createRefusalWindows(clock);
  // The id each open window's opening event committed under, or `undefined` for none, by the number
  // the window was given; an entry leaves once its window's closing is recorded.
  const openings = new Map<number, Promise<string | undefined>>();
  const state: {
    closings: Promise<void>;
    timer: NodeJS.Timeout | undefined;
  } = { closings: Promise.resolve(), timer: undefined };

  const recordClosing = async ({
    count,
    firstSeenAt,
    key,
    lastSeenAt,
    window,
  }: ClosedWindow): Promise<void> => {
    const windowId = await openings.get(window);
    openings.delete(window);
    const event = closingEvents[key.route]({
      ...(key.applicationId === undefined
        ? {}
        : { applicationId: key.applicationId }),
      count,
      firstSeenAt,
      lastSeenAt,
      reason: key.reason,
      ...(windowId === undefined ? {} : { windowId }),
    });
    const recorded = await trail.recordEvent(SYSTEM, event);
    if (recorded === undefined) {
      log.error(CLOSING_UNRECORDED, {
        data: event.data,
        eventType: `${TYPE_PREFIX}${event.type}`,
      });
    }
  };

  // Each closing waits for the one before it, so a burst of windows closing at once takes one store
  // connection at a time. A failure in one ends there, so the closings after it still run.
  const close = (closed: readonly ClosedWindow[]): void => {
    state.closings = closed.reduce(
      (earlier, window) =>
        earlier.then(() => recordClosing(window)).catch(() => undefined),
      state.closings,
    );
  };

  return {
    refuse: async <Opening>(
      key: RefusalKey,
      open: () => Promise<Opening>,
      openedId: (opening: Opening) => string | undefined,
    ): Promise<WindowedRefusal<Opening>> => {
      const counted = windows.count(key);
      close(counted.closed);
      if (counted.kind === 'counted') {
        return { kind: 'counted' };
      }
      const opening = (async () => open())();
      // An opening that threw, or an id that cannot be read, names no event.
      openings.set(
        counted.window,
        opening.then(openedId).catch(() => undefined),
      );
      return { kind: 'opened', opening: await opening };
    },
    start: () => {
      state.timer ??= setInterval(() => {
        close(windows.closeDue());
      }, WINDOW_CLOCK_READING_MILLISECONDS).unref();
    },
    stop: async () => {
      clearInterval(state.timer);
      state.timer = undefined;
      close(windows.closeAll());
      await state.closings;
    },
  };
};
