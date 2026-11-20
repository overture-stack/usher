import type { KeyObject } from 'node:crypto';

import type { Clock } from '../configuration/index.js';
import type { AuditTrail } from '../eventLog/index.js';

/**
 * Why an assertion the Controller could not verify was refused. One costs nothing to send, so it is
 * counted, as `channelAssertion.rejectionTally`, rather than recorded one by one.
 */
export type UnverifiedRejectionReason =
	'invalidSignature' | 'missingAssertion' | 'noLiveKey' | 'unknownApplication' | 'unreadableAssertion';

/**
 * Why an assertion that verifies under its application's key was refused anyway: `reusedAssertion` for
 * one presented to the stream a second time, which only a copy of it can be; `unrepresentableJti` for a
 * `jti` holding a NUL character or an unpaired surrogate; and each other for its claims. Each instance records the first refusal of each such assertion within its bounds as a
 * `channelAssertion.rejection`, and counts every later one, and any refusal past those bounds, in
 * `channelAssertion.rejectionTally`.
 */
export type VerifiedRejectionReason =
	| 'excessiveLifetime'
	| 'expiredAssertion'
	| 'notYetValid'
	| 'otherAudience'
	| 'reusedAssertion'
	| 'unrepresentableJti';

/** Why a channel assertion was refused, whether or not it verified. */
export type RejectionReason = UnverifiedRejectionReason | VerifiedRejectionReason;

/** A live key as the verifier reads it: its application, and the subkey assertions are signed under. */
export interface AssertionKey {
	applicationId: string;

	/** Verifies the channel assertion: HMAC-SHA256. */
	channelAssertion: KeyObject;
}

/** Where the verifier finds an application's live keys, in memory. */
export interface LiveKeys<Key extends AssertionKey> {
	/**
	 * An application's live keys: `undefined` when no application is registered under the id, and none
	 * for one holding no live key.
	 */
	liveKeysOf(applicationId: string): readonly Key[] | undefined;
}

/** A channel assertion the Controller accepted. */
export interface VerifiedAssertion<Key> {
	/** The last instant it is accepted at, in milliseconds since the Unix epoch: its `exp` and the clock tolerance. */
	acceptedUntil: number;

	/** Its `jti`, unique to it. */
	id: string;

	/** The live key it verified under, which names its application and answers it. */
	key: Key;

	/** What tells one assertion from another, as {@link SigningInputDigest} says. */
	signingInputDigest: SigningInputDigest;
}

/**
 * The SHA-256 of an assertion's signing input, in base64url: its header and payload segments exactly as
 * presented, joined by a dot, which are the bytes its HS256 signature covers. Every presentation of one
 * assertion gives the same, whatever encoding its signature segment arrives in. It is computed only for
 * an assertion that verified under its application's key.
 */
export type SigningInputDigest = string;

/** What checking a request's channel assertion gave. */
export type ChannelAssertionCheck<Key> =
	| {
			/** The application the assertion names, while one is registered under its `iss`. */
			applicationId?: string;

			kind: 'unverified';
			reason: UnverifiedRejectionReason;
	  }
	| {
			/** The application whose key the assertion verified under. */
			applicationId: string;

			kind: 'refused';
			reason: Exclude<VerifiedRejectionReason, 'reusedAssertion'>;
			signingInputDigest: SigningInputDigest;
	  }
	| { assertion: VerifiedAssertion<Key>; kind: 'verified' };

/** Checks the channel assertion a request carries. */
export interface ChannelAssertionVerifier<Key> {
	/**
	 * Checks a request's channel assertion, reading the application's keys from memory alone.
	 *
	 * @param rawHeaders the request's header names and values, alternating, as Node gives them.
	 */
	verify(rawHeaders: readonly string[]): Promise<ChannelAssertionCheck<Key>>;
}

/** One refusal of an assertion that verified under its application's key. */
export interface VerifiedRefusal {
	/** The application whose key it verified under. */
	applicationId: string;

	reason: VerifiedRejectionReason;
	signingInputDigest: SigningInputDigest;

	/** The address of the request that presented it. */
	sourceIp: string;
}

/** Where a refusal not recorded one by one is counted, for `channelAssertion.rejectionTally`. */
export interface RefusalCounter {
	/**
	 * Counts one refusal.
	 *
	 * @param reason why it was refused.
	 * @param applicationId the application whose key the assertion verified under.
	 */
	count(reason: VerifiedRejectionReason, applicationId: string): void;
}

/** Where the refusals whose recording failed are written, as lines at warning. */
export interface RefusalLog {
	/** Writes an operational line at warning. */
	warning(message: string, fields?: Readonly<Record<string, number | string>>): void;
}

/**
 * The instance's memory of the assertions it refused after they verified, each kept for
 * {@link REFUSED_ASSERTION_WINDOW_MILLISECONDS} from its first refusal, on the configured clock, and at
 * most {@link REFUSED_ASSERTIONS_LIMIT} at once.
 */
export interface RefusedAssertions {
	/** Forgets an assertion, so its next refusal is taken as its first. */
	forget(signingInputDigest: SigningInputDigest): void;

	/** Whether an assertion is remembered as refused, within its window. */
	has(signingInputDigest: SigningInputDigest): boolean;

	/** Whether the memory holds as many assertions as it may. */
	isFull(): boolean;

	/** Remembers an assertion as refused now, for its window; nothing happens while the memory is full. */
	remember(signingInputDigest: SigningInputDigest): void;
}

/** Where one route's recordings of refused assertions are written, as the system, each in a transaction of its own. */
export type RefusalTrail = Pick<AuditTrail<unknown>, 'inTransaction'>;

/**
 * Runs one recording within the share of the application its refused assertion names: `true` once the
 * recording has run, and `false` when the share had no room, the recording never begun. A recording
 * that fails rejects, as the recording did.
 *
 * @param applicationId the application whose key the assertion verified under.
 * @param recording the recording's transaction.
 */
export type RecordingAdmission = (applicationId: string, recording: () => Promise<void>) => Promise<boolean>;

/** What one route's recorder of refused assertions writes through, and how many recordings it may hold waiting. */
export interface RefusalRoute {
	/**
	 * The most recordings the route may hold waiting on the store at once, as
	 * {@link pendingRecordingLimit} gives it from the size of the pool its trail uses.
	 */
	pendingLimit: number;

	/** Where the route's recordings are written. */
	trail: RefusalTrail;

	/**
	 * Where the route takes a place for each recording in the share of the application it names, a
	 * bound beside its own limit; a route giving none runs each recording within its limit alone.
	 */
	within?: RecordingAdmission;
}

/** One route's recorder of refused assertions. */
export interface RefusalRecorder {
	/**
	 * Takes one refusal of an assertion that verified, never waiting on the store: it is recorded as a
	 * `channelAssertion.rejection` when it is the instance's first refusal of the assertion and the
	 * bounds allow, and counted otherwise.
	 *
	 * @param refusal the application, the reason, the assertion's digest and the request's address.
	 */
	refused(refusal: VerifiedRefusal): void;
}

/** The instance's recording of refused assertions, every route sharing its memory. */
export interface AssertionRefusals {
	/**
	 * A recorder for one route, writing through the route's trail and holding at most its own limit of
	 * recordings waiting, each within its application's share where the route admits them so.
	 *
	 * @param route the route's trail, its limit, and where it takes a place in a share.
	 */
	forRoute(route: RefusalRoute): RefusalRecorder;

	/**
	 * Settles once every recording begun, on any route, has ended, committed or counted, writing to the
	 * log the failed recordings it holds, whatever the interval.
	 */
	stop(): Promise<void>;
}

/** What the instance's recording of refused assertions is created from. */
export interface AssertionRefusalSettings {
	/** The configured clock the intervals of failed recordings run on. */
	clock: Clock;

	/** Where the failed recordings are written, as `channelAssertion.rejectionUnrecorded` at warning. */
	log: RefusalLog;

	/** The memory of refused assertions every route shares. */
	refusedAssertions: RefusedAssertions;

	/** Where each refusal not recorded one by one is counted. */
	rejections: RefusalCounter;
}
