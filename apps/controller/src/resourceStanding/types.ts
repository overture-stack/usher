import type pg from 'pg';

/** A resource's access level, its base tier, as the API names it. */
export type AccessLevel = 'grant' | 'open' | 'registered';

/**
 * Where one principal stands on one resource, as one read of the store gives it, beside what of the
 * resource that standing is judged with.
 */
export interface ResourceStanding {
	accessLevel: AccessLevel;

	/**
	 * Whether the principal is a counted owner of it: they hold an owner grant on it that is live,
	 * and their latest answer to it accepted it.
	 */
	countedOwner: boolean;

	/** As stored. */
	externalId: string;

	/**
	 * Whether the principal holds a live grant on it, an owner grant included, that their latest
	 * answer did not reject: pending or accepted.
	 */
	holder: boolean;

	/** Its id, which never leaves the store's own statements. */
	id: string;

	retired: boolean;
	suppressed: boolean;
}

/**
 * Who looks at a resource: whether a platform administrator, and whether asking for a retired one.
 */
export interface Onlooker {
	administrator: boolean;

	/**
	 * Whether they ask to be shown a retired resource, which a platform administrator alone is shown.
	 */
	asksForRetired: boolean;
}

/** A grant's ends, which decide whether it is live. */
export interface GrantEnds {
	/** When a grant on its terms replaced it once it had expired; `null` while it has not been. */
	endedAt: Date | null;

	/** `null` for a grant that never expires. */
	expiresAt: Date | null;

	revokedAt: Date | null;
}

/** How a read of a standing locks the resource's row for the rest of its transaction. */
export type StandingLock = 'noKeyUpdate' | 'none' | 'share';

/** What a read of one principal's standing on one resource is given. */
export interface StandingQuestion {
	/** The externalId as sent, matched exactly. */
	externalId: string;

	/** The trusted issuer, under whose identity the principal is found. */
	issuer: string;

	lock: StandingLock;

	/** The configured clock's instant, against which a grant's expiry is judged. */
	now: Date;

	/** The principal's subject, the token's `sub`. */
	subject: string;
}

/** The placeholders a statement binds the values a standing is read with to, such as `$2::text`. */
export interface StandingPlaceholders {
	/** The trusted issuer. */
	issuer: string;

	/** The configured clock's instant. */
	now: string;

	/** The principal's subject. */
	subject: string;
}

/**
 * Where a standing is read: one statement at a time, on a transaction's connection or outside one.
 */
export interface StatementRunner {
	/**
	 * Runs one statement.
	 *
	 * @param text the statement, every value bound.
	 * @param values the values bound to it.
	 */
	query<Row extends pg.QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<Pick<pg.QueryResult<Row>, 'rows'>>;
}
