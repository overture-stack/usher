/** The fewest exchanges an application's share admits at once, however many applications are registered. */
export const SHARE_FLOOR = 1;

/**
 * How many of an application's exchanges one instance always admits at once, whatever every other
 * application holds: its exchange pool's connections divided equally among the registered
 * applications, rounded down, and never fewer than {@link SHARE_FLOOR}, so with more applications
 * registered than connections the shares together exceed the pool. A count below one is read as one,
 * since an exchange is admitted only for a registered application.
 *
 * @param poolSize how many connections the instance's exchange pool holds.
 * @param registeredCount how many applications are registered.
 */
export const admissionShare = (poolSize: number, registeredCount: number): number =>
	Math.max(SHARE_FLOOR, Math.floor(poolSize / Math.max(1, registeredCount)));
