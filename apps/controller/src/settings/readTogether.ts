import type { RetentionDurations, SettingsProblem } from './types.js';

/** The largest notice retention floor the database column holds, in seconds. */
export const LARGEST_RETENTION_FLOOR_SECONDS = 2147483647;

const RETENTION_SETTINGS: readonly (keyof RetentionDurations)[] = [
	'retentionGraceSeconds',
	'retentionMarginSeconds',
	'tokenLifetimeSeconds',
];

/**
 * Applies the rules laid across settings read together: the notice retention floor is the sum of the
 * three durations it is made of, and the sum must not pass the largest the database column holds. Every
 * duration the sum passes is named, since each adds to it.
 *
 * @param durations the token lifetime, the grace period and the margin, as read.
 */
export const readTogether = (durations: RetentionDurations): readonly SettingsProblem[] => {
	const floor = durations.retentionGraceSeconds + durations.retentionMarginSeconds + durations.tokenLifetimeSeconds;
	return floor <= LARGEST_RETENTION_FLOOR_SECONDS
		? []
		: RETENTION_SETTINGS.map((setting) => ({
				rule: `adds to a retention floor of more than ${LARGEST_RETENTION_FLOOR_SECONDS} seconds, the most one may be`,
				setting,
			}));
};
