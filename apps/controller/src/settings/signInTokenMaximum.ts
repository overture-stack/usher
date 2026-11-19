/**
 * One change of the sign-in token maximum: the instant the store recorded it, in seconds since the Unix
 * epoch, and the maximum it set.
 */
export interface SignInTokenMaximumRecord {
	/** The instant the change was recorded, in seconds since the Unix epoch. */
	recordedAt: number;

	/** The longest lifetime, in seconds, a sign-in token may have from the change on. */
	seconds: number;
}

/** Every change of the sign-in token maximum the store holds, oldest first, the first one the seeding's. */
export type SignInTokenMaximumHistory = readonly [SignInTokenMaximumRecord, ...SignInTokenMaximumRecord[]];

/**
 * Gives the longest lifetime a token issued at an instant may have, judged over the maximum's history.
 * The maximum in force at the issue is the latest record at or before it, or the first record's value for
 * an issue before the first. Every record after the issue was in force at some moment since, so each
 * counts, and the token's maximum is the smallest of them. A lowering therefore applies to every token
 * already issued, and a raise only to tokens issued after it.
 *
 * @param history every change of the maximum, oldest first.
 * @param issuedAt the token's `iat`, in seconds since the Unix epoch.
 */
export const signInTokenMaximumOf = (history: SignInTokenMaximumHistory, issuedAt: number): number => {
	const [first] = history;
	const inForceAtIssue = history.filter((record) => record.recordedAt <= issuedAt).at(-1) ?? first;
	const recordedAfterIssue = history.filter((record) => record.recordedAt > issuedAt);
	return Math.min(inForceAtIssue.seconds, ...recordedAfterIssue.map((record) => record.seconds));
};
