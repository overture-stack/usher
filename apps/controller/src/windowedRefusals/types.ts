import type { Clock } from '../configuration/index.js';
import type pg from 'pg';

import type { AuditEvent, AuditTrail, EventLog } from '../eventLog/index.js';
import type { RefusalKey, WindowedRoute } from '../refusalWindows/index.js';

/** A window as its closing event records it. */
export interface WindowClosing {
	/** The application its key names, where its key names one. */
	applicationId?: string;

	/**
	 * Every refusal it counted, the one opening it included, whether or not its opening event
	 * committed.
	 */
	count: number;

	/** When the refusal opening it was made, in milliseconds of the clock. */
	firstSeenAt: number;

	/** When its latest refusal was made, in milliseconds of the clock. */
	lastSeenAt: number;

	reason: string;

	/** The id of its opening event, once that event committed; absent otherwise. */
	windowId?: string;
}

/**
 * What counting a refusal did: counted it in an open window, writing nothing; or opened a window, its
 * opening recorded, with what recording it gave.
 */
export type WindowedRefusal<Opening> = { kind: 'counted' } | { kind: 'opened'; opening: Opening };

/** What an instance's windowed refusals are created from. */
export interface WindowedRefusalSettings {
	/** The clock every window is measured on. */
	clock: Clock;

	/** The event each route closes its windows with. */
	closingEvents: Readonly<Record<WindowedRoute, (closing: WindowClosing) => AuditEvent>>;

	/** Where a closing event the store did not take is written. */
	log: Pick<EventLog, 'error'>;

	/** Where each closing event is recorded, as the system. */
	trail: Pick<AuditTrail<pg.ClientBase>, 'recordEvent'>;
}

/**
 * Where a route counts each refusal in windows, recording the refusal opening a window and each
 * window's closing, and writing nothing for any other refusal.
 */
export interface WindowedRefusals {
	/**
	 * Counts a refusal in the window its key names. One opening a window is recorded by `open`, whose
	 * result is given back, and the id of the event it committed, read by `openedId`, names the window
	 * in its closing event. Any other refusal writes nothing and is counted. A failure `open` throws is
	 * thrown again, and its window named by no event.
	 *
	 * @param key what the refusal is counted under.
	 * @param open records the refusal opening a window, as the route records a refusal.
	 * @param openedId the id of the event `open` committed, or `undefined` for none.
	 */
	refuse<Opening>(
		key: RefusalKey,
		open: () => Promise<Opening>,
		openedId: (opening: Opening) => string | undefined,
	): Promise<WindowedRefusal<Opening>>;

	/** Starts reading the clock for the windows due to close; a second call does nothing. */
	start(): void;

	/**
	 * Stops reading the clock, closes every open window, and settles once every closing event has been
	 * recorded or written to the log.
	 */
	stop(): Promise<void>;
}
