/** The route a refusal is made at, each recording its windows under event types of its own. */
export type WindowedRoute = 'exchange' | 'logout' | 'management';

/**
 * What a refusal is counted under. A refusal of a token that verified is counted under the token's
 * digest and the reason; one of a credential that did not verify, under the reason alone, and at the
 * exchange under the application whose channel assertion verified as well. Nothing read from a
 * credential that did not verify is ever part of a key.
 */
export interface RefusalKey {
	/** The application whose channel assertion verified, for a credential refused at the exchange without verifying. */
	applicationId?: string;

	/** Why the credential was refused: a fixed code, holding no newline. */
	reason: string;

	route: WindowedRoute;

	/** The SHA-256 digest of the whole token, for a token that verified: never the token itself. */
	tokenDigest?: string;
}

/** A window once closed: what it counted, between which instants, and under which key. */
export interface ClosedWindow {
	/** Every refusal counted in it, the one opening it included. */
	count: number;

	/** When the refusal opening it was made, in milliseconds of the clock. */
	firstSeenAt: number;

	/**
	 * The key it counted under: the refusal's own, or for an overflow window its route and reason
	 * alone.
	 */
	key: RefusalKey;

	/** When its latest refusal was made, in milliseconds of the clock: its opening's instant when it saw no other. */
	lastSeenAt: number;

	/** The number the instance gave it when it opened, unique among its windows. */
	window: number;
}

/**
 * What counting one refusal did: opened a window, naming it, or counted the refusal in the window
 * open under its key; with the windows it closed first, each due by the clock.
 */
export type WindowCount =
	| { closed: readonly ClosedWindow[]; kind: 'counted' }
	| { closed: readonly ClosedWindow[]; kind: 'opened'; window: number };

/**
 * One instance's windows: the refusals it counts, each under its key, in memory alone. A window opens
 * at its key's first refusal and closes once its key has gone without a refusal for the cooldown, or
 * once the ceiling has passed since it opened, whichever comes first.
 */
export interface RefusalWindows {
	/** Closes every open window, whatever the clock: the instance's stop. */
	closeAll(): readonly ClosedWindow[];

	/** Closes every window due at the clock's instant. */
	closeDue(): readonly ClosedWindow[];

	/**
	 * Counts one refusal at the clock's instant: in the window open under its key, or in a window it
	 * opens there.
	 *
	 * @param key what the refusal is counted under.
	 */
	count(key: RefusalKey): WindowCount;
}
