/** Which exchange takes a place: the anonymous visitor's, or one recording a refusal. */
export type ExchangeKind = 'anonymous' | 'credential';

/** What work run within a share gave: its result, or a refusal over the share, the work never begun. */
export type Admitted<Result> = { kind: 'admitted'; result: Result } | { kind: 'overShare' };

/**
 * Each application's share of one instance's exchange pool, counted by the exchanges in flight, every
 * application's together and each one's.
 */
export interface Admission {
	/**
	 * How many exchanges the instance has admitted and not yet seen settle, every application's
	 * together, as the last admission or settlement left it.
	 */
	inFlight(): number;

	/**
	 * Runs an exchange's store work as `createAdmission` admits it: a place is taken before the work
	 * begins, in the same turn as the check, and released once it settles, however it settles, a work
	 * throwing before it returns a promise included, whose failure is passed on. An exchange not
	 * admitted never begins its work, and is given `overShare` at once.
	 *
	 * @param applicationId the application the exchange is for, as its channel assertion verified it.
	 * @param kind the exchange's kind.
	 * @param work the exchange's store work.
	 */
	within<Result>(applicationId: string, kind: ExchangeKind, work: () => Promise<Result>): Promise<Admitted<Result>>;
}

/** What admission is created from. */
export interface AdmissionSettings {
	/**
	 * How many connections the instance's exchange pool holds: what the shares divide, and the count of
	 * exchanges in flight below which one over its share is still admitted.
	 */
	poolSize: number;

	/** How many applications are registered, as the instance holds them now. */
	registeredCount(): number;
}
