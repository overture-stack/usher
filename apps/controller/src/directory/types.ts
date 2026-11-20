import type { ControllerConfiguration } from '../configuration/index.js';
import type { EventLog } from '../eventLog/index.js';

/**
 * What the directory is created from: the clock its token's expiry is judged on, and where it reads
 * the identity provider's accounts. An empty `directoryUrl` is no directory, which resolves
 * nothing.
 */
export type DirectorySettings = Pick<
	ControllerConfiguration,
	'clock' | 'directoryClientId' | 'directoryClientSecret' | 'directoryRealm' | 'directoryUrl'
>;

/** Where the directory writes a lookup it could not answer. */
export type DirectoryLog = Pick<EventLog, 'error'>;

/**
 * How far one lookup goes: `deadlineMilliseconds`, the real time from its start to its answer, the
 * token it takes included; and `answerLimitBytes`, the most of any one answer's body it reads.
 */
export interface DirectoryBounds {
	answerLimitBytes: number;
	deadlineMilliseconds: number;
}

/**
 * Why a lookup could not be answered, as the line naming it says: no answer within the deadline
 * (`timeout`); no connection, or one cut (`unreachable`); a status it does not take (`status`); a
 * credential refused, by the token endpoint or by the admin API once a fresh token is refused too
 * (`credentialRefused`); an answer longer than its bound (`answerTooLarge`); or one it cannot read
 * (`malformedAnswer`).
 */
export type DirectoryFailure =
	'answerTooLarge' | 'credentialRefused' | 'malformedAnswer' | 'status' | 'timeout' | 'unreachable';

/**
 * What an address resolves to: the subject of the one account holding it verified, which the
 * trusted issuer's tokens carry as `sub`; no single account (`unheld`); a directory unable to
 * answer (`unavailable`); or no directory configured (`unconfigured`).
 */
export type AddressResolution =
	{ kind: 'resolved'; subject: string } | { kind: 'unavailable' } | { kind: 'unconfigured' } | { kind: 'unheld' };

/** An account as the directory holds it now: `null` for a name or an address it holds none of. */
export interface DirectoryAccount {
	email: string | null;
	familyName: string | null;
	givenName: string | null;
}

/**
 * What a subject's account reads as: the account; no account holding the subject (`absent`), as
 * for one deleted; a directory unable to answer (`unavailable`); or no directory configured
 * (`unconfigured`).
 */
export type AccountReading =
	| { account: DirectoryAccount; kind: 'held' }
	| { kind: 'absent' }
	| { kind: 'unavailable' }
	| { kind: 'unconfigured' };

/**
 * The identity provider's directory of accounts, read through its admin API. Neither lookup ever
 * rejects: a failure is answered `unavailable`.
 */
export interface Directory {
	/**
	 * Reads the account holding a subject.
	 *
	 * @param subject the subject, as the trusted issuer's tokens carry it.
	 */
	accountOf(subject: string): Promise<AccountReading>;

	/**
	 * Resolves an address to the subject of the one account holding it verified.
	 *
	 * @param address the address, as given.
	 */
	resolveAddress(address: string): Promise<AddressResolution>;
}
