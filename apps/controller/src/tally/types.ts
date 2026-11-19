import type { Clock } from '../configuration/index.js';
import type { AuditEvent, AuditTrail, TrailConnection } from '../eventLog/index.js';

/**
 * A tally: what it is given, counted over fixed intervals of the configured clock, each interval's
 * counts recorded as events once the clock has passed it.
 */
export interface Tally<Counted> {
	/** Counts one, in the interval the clock is in. */
	count(counted: Counted): void;

	/** Starts reading the clock for each interval's end; a second call does nothing. */
	start(): void;

	/** Stops reading the clock, records the counts it holds, whatever the interval, and settles once every recording has. */
	stop(): Promise<void>;
}

/** What a tally is created from: what each caller counts, and how each count is recorded. */
export interface TallySettings<Counted> {
	/** The clock each interval runs on. */
	clock: Clock;

	/**
	 * The event one count is recorded as.
	 *
	 * @param counted what was counted.
	 * @param count how many the interval held.
	 */
	eventOf(counted: Counted, count: number): AuditEvent;

	/** How long each interval is, in milliseconds of the clock, the intervals running from the Unix epoch. */
	intervalMilliseconds: number;

	/**
	 * The parts naming what is counted, each holding no newline. What is given the same parts is counted
	 * as one, and an interval's counts are recorded in the order of their parts, compared one part at a
	 * time by name.
	 *
	 * @param counted what is counted.
	 */
	partsOf(counted: Counted): readonly string[];

	/** Where each count's event is recorded, as the system. A failure it meets ends there. */
	trail: Pick<AuditTrail<TrailConnection>, 'recordEvent'>;
}
