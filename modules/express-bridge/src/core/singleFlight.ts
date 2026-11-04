import { positiveWhole } from './numbers.js';

/** The work of one flight: handed the flight's abort signal, it settles to the flight's outcome. */
export type FlightWork<Outcome> = (signal: AbortSignal) => Promise<Outcome>;

/** Runs one flight per key at a time, within a bound on new flights. */
export interface SingleFlight<Outcome> {
  /**
   * Runs `work` for the key, or joins the flight already running for it, even from inside that
   * flight's work. Every caller of a flight gets its outcome, or its rejection when `work` rejects.
   * The timeout aborts the work's signal but does not itself settle the flight. A caller that would
   * start a flight beyond the bound gets the overloaded outcome, `onOverload` is called, and the work
   * does not run.
   */
  run(key: string, work: FlightWork<Outcome>): Promise<Outcome>;

  /**
   * Settles once no flight is held, waiting as well for any flight started while it waits. It aborts
   * none of them, and never rejects, whatever they settle to.
   */
  whenIdle(): Promise<void>;
}

/** What {@link createSingleFlight} needs. */
export interface SingleFlightOptions<Outcome> {
  /** The most flights running at once. Callers joining a running flight do not count against it. */
  max: number;

  /** Called for each caller turned away by the bound. */
  onOverload: () => void;

  /** The outcome a caller turned away by the bound gets. */
  overloaded: Outcome;

  /** How long a flight runs before its signal is aborted. */
  timeoutMs: number;
}

/**
 * Creates a single flight, under which concurrent callers with one key share one run of the work.
 * Each flight has its own abort signal, aborted once the timeout has passed, so no one caller can
 * cancel work still awaited by others.
 *
 * @throws {RangeError} for a bound or a timeout that is not a positive whole number.
 */
export const createSingleFlight = <Outcome>({
  max,
  onOverload,
  overloaded,
  timeoutMs,
}: SingleFlightOptions<Outcome>): SingleFlight<Outcome> => {
  const bound = positiveWhole(max, 'the in-flight bound');
  const timeout = positiveWhole(timeoutMs, 'the exchange timeout');
  const flights = new Map<string, Promise<Outcome>>();

  const start = (key: string, work: FlightWork<Outcome>): Promise<Outcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    // The work is deferred by one microtask, so the flight is registered before it starts and a
    // caller arriving from inside the work joins it.
    const flight: Promise<Outcome> = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        clearTimeout(timer);
        // Only this flight's own entry is forgotten, never one started for the key after it.
        if (flights.get(key) === flight) {
          flights.delete(key);
        }
      });
    flights.set(key, flight);
    return flight;
  };

  const whenIdle = (): Promise<void> =>
    flights.size === 0
      ? Promise.resolve()
      : Promise.allSettled(flights.values()).then(() => whenIdle());

  return {
    run: (key, work) => {
      const running = flights.get(key);
      if (running !== undefined) {
        return running;
      }
      if (flights.size < bound) {
        return start(key, work);
      }
      onOverload();
      return Promise.resolve(overloaded);
    },

    whenIdle,
  };
};
