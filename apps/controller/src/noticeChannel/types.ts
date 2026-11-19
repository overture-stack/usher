import type { KeyObject } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import type { RouteOptions } from 'fastify';

import type { ChannelAssertionCheck, RefusalRecorder, UnverifiedRejectionReason } from '../channelAssertion/index.js';
import type { ControllerSettings } from '../settings/index.js';

/**
 * A place in the notice stream, as a cursor carries it: a position within an epoch, and the creation
 * instant of the notice stored at that position, by which a position a restore reused is told from
 * the one the cursor was issued for.
 */
export interface StreamPlace {
	/**
	 * When the notice at the position was created, in microseconds since the Unix epoch; absent for a
	 * position no notice held when the place was read, the trim watermark of an emptied stream.
	 */
	createdAt: bigint | undefined;

	/** The epoch the position belongs to, as the store gives it. */
	epoch: string;

	position: bigint;
}

interface StoredNoticeBase {
	/** When it was created, in microseconds since the Unix epoch. */
	createdAt: bigint;

	position: bigint;
}

/** One notice as the store holds it, with what its delivery to an audience is judged by. */
export type StoredNotice =
	| (StoredNoticeBase & {
			/** The application whose served set changed. */
			audience: string;
			kind: 'servedResources';
	  })
	| (StoredNoticeBase & { kind: 'baseline' | 'global' })
	| (StoredNoticeBase & {
			kind: 'category';

			/** The resource's external id, as a payload names it. */
			resource: string;

			/** The applications serving the resource when the notice was read. */
			servedBy: readonly string[];
	  })
	| (StoredNoticeBase & {
			kind: 'principal';

			/** The identity provider's subject the notice names. */
			subject: string;
	  });

/** One read of the notices after a position, and the state of the stream it was read in. */
export interface NoticePage {
	/** When the notice at the position read after was created, while one is stored there. */
	createdAtPosition: bigint | undefined;

	epoch: string;

	/** The newest place when the page was read. */
	head: StreamPlace;

	/** Whether notices beyond the page's limit wait after its last. */
	more: boolean;

	/** The notices after the position, oldest first. */
	notices: readonly StoredNotice[];

	/** The highest position trimming has reached. */
	trimmedThrough: bigint;
}

/** What a read of the notices after a position is limited to. */
export interface NoticeReadOptions {
	/** The application whose notices alone are read; every notice when absent. */
	audience?: string;

	/** The most notices one page holds. */
	limit: number;
}

/**
 * Where the channel reads the notice stream, each read one statement within the store timeout, so
 * every part of a read comes from one snapshot.
 */
export interface NoticeReader {
	/**
	 * The notices after a position, oldest first, with the epoch, the watermark and the head the page
	 * was read beside, and the creation instant of the notice at the position.
	 *
	 * @throws {StoreTimeout} when the store does not answer within the store timeout; otherwise
	 *   whatever the store throws.
	 */
	after(position: bigint, options: NoticeReadOptions): Promise<NoticePage>;

	/**
	 * The newest place: the newest notice's, or the trim watermark while the stream holds no notice.
	 *
	 * @throws {StoreTimeout} when the store does not answer within the store timeout; otherwise
	 *   whatever the store throws.
	 */
	head(): Promise<StreamPlace>;
}

/** How the channel turns places into cursors, opaque to every holder but the Controller, and back. */
export interface CursorCipher {
	/**
	 * Reads a cursor.
	 *
	 * @returns the place it carries, or `undefined` for a cursor altered, of another form, or sealed
	 *   under another cursor key.
	 */
	open(cursor: string): StreamPlace | undefined;

	/** Seals a place as a cursor, a fresh one at every call, of one length whatever the place. */
	seal(place: StreamPlace): string;
}

/** An application's live key as the channel uses it: what names it, and the subkeys answering with it. */
export interface ChannelKey {
	applicationId: string;
	keyId: string;

	/** Encrypts pushed notices: AES-256-GCM. */
	notice: KeyObject;

	/** Encrypts poll answers: AES-256-GCM. */
	pollAnswer: KeyObject;

	/** Tags a subject as principal notices name it: HMAC-SHA256. */
	subjectTag: KeyObject;
}

/** Where the channel checks each request's channel assertion. */
export interface AssertionVerifier {
	/**
	 * Checks a request's channel assertion, from memory alone.
	 *
	 * @param rawHeaders the request's header names and values, alternating, as Node gives them.
	 */
	verify(rawHeaders: readonly string[]): Promise<ChannelAssertionCheck<ChannelKey>>;
}

/** Where the channel learns whether a key it answered under is still live. */
export interface KeyHolder {
	/** Whether a key is held as live. */
	holds(key: Pick<ChannelKey, 'applicationId' | 'keyId'>): boolean;
}

/** Where the channel counts each refusal of an assertion that could not be verified. */
export interface RejectionCounter {
	/**
	 * Counts one refusal.
	 *
	 * @param reason why it was refused.
	 * @param applicationId the registered application the assertion names, or `undefined` for none.
	 */
	count(reason: UnverifiedRejectionReason, applicationId?: string): void;
}

/** Where the channel writes its operational lines, each named by its message. */
export interface ChannelLog {
	/** Writes a line at error. */
	error(message: string, fields?: Readonly<Record<string, string>>): void;

	/** Writes a line at warning. */
	warning(message: string, fields?: Readonly<Record<string, string>>): void;
}

/** A poll as its query names it: where it starts, and the nonce its answer echoes. */
export interface PollRequest {
	nonce: string;
	start: { cursor: string; kind: 'after' } | { kind: 'head' };
}

/** The channel assertions presented to the stream, each refused a second time while it is accepted. */
export interface UsedAssertions {
	/**
	 * Records an assertion as presented to the stream, whatever the stream then answers.
	 *
	 * @param applicationId the application it names.
	 * @param id its `jti`.
	 * @param acceptedUntil the last instant it is accepted at, in milliseconds since the Unix epoch.
	 * @returns whether it was recorded now: false for one already recorded.
	 */
	record(applicationId: string, id: string, acceptedUntil: number): boolean;
}

/** A stream as the instance's tail of the notice stream hands it notices. */
export interface LiveStream {
	/** The epoch the stream's cursor belongs to. */
	epoch: string;

	/** Ends the stream, its Bridge to open it again from its own cursor. */
	end(): void;

	/** Hands the stream every notice the tail read in one page, oldest first, for each audience alike. */
	offer(notices: readonly StoredNotice[]): void;

	/** The highest position the stream has delivered or passed over. */
	scannedThrough(): bigint;
}

/** The instance's one reader of the newest notices, handing each to every live stream. */
export interface NoticeTail {
	/**
	 * Starts handing a stream every page read after the tail's position, once the stream has passed
	 * over every notice up to that position; a stream behind it reads on from the store, and joins
	 * after. The first stream to join sets the tail's position and epoch; a stream of another epoch
	 * than the live streams' ends each of theirs first.
	 *
	 * @returns whether the stream joined.
	 */
	join(stream: LiveStream): boolean;

	/** Stops handing a stream notices. */
	leave(stream: LiveStream): void;

	/** The position the tail has read through, or `undefined` while no stream is live. */
	position(): bigint | undefined;

	/** Stops reading, settling once a read in flight has ended. */
	stop(): Promise<void>;

	/** Reads the newest notices now, or once the read in flight has ended. */
	wake(): void;
}

/** What the revocation channel is created from. */
export interface NoticeChannelSettings {
	/**
	 * Takes each refusal of an assertion that verified, recording the instance's first refusal of each
	 * assertion and counting the rest, never holding up the answer.
	 */
	assertionRefusals: RefusalRecorder;

	/** Seals and opens cursors. */
	cursors: CursorCipher;

	/** Where the channel writes its operational lines. */
	eventLog: ChannelLog;

	/** Holds the live application keys. */
	keyRing: KeyHolder;

	/** Reads the notice stream from the store. */
	reader: NoticeReader;

	/** The page limit, the timings and the stream limits. */
	settings: Pick<
		ControllerSettings,
		| 'heartbeatMilliseconds'
		| 'noticePageLimit'
		| 'noticeRereadMilliseconds'
		| 'streamLimitPerAudience'
		| 'streamMaximumLifetimeSeconds'
		| 'streamQueueLimit'
	>;

	/** Where each refusal of an assertion that could not be verified is counted. */
	rejections: RejectionCounter;

	/** Records the assertions presented to the stream. */
	usedAssertions: UsedAssertions;

	/** Checks each request's channel assertion. */
	verifier: AssertionVerifier;
}

/** The revocation channel: the poll, the push, and the instance's streams. */
export interface NoticeChannel {
	/** Ends every stream opened under a key the key ring no longer holds as live. */
	keysChanged(): void;

	/** The routes serving the poll and the push. */
	routes: readonly RouteOptions[];

	/**
	 * Ends every stream and refuses any new one, settling once every stream has ended and every read in
	 * flight for one has settled.
	 */
	stop(): Promise<void>;

	/** Has the instance read the newest notices now, as after a change it committed. */
	wake(): void;
}

/** An open stream as the instance's set of streams holds it. */
export interface HeldStream {
	/** Closes the stream's connection at once, whatever is left unwritten. */
	close(): void;

	/** Ends the stream at an event's end, or at once while its reader is not draining it. */
	end(): void;

	/** The live key the stream's assertion verified under, which answers it. */
	key: ChannelKey;
}

/** A stream's place reserved on the instance, before its first byte is sent. */
export interface StreamReservation {
	/**
	 * Opens the stream on the response: its headers and a first byte at once, then every notice of the
	 * first page and after, each as it can be written.
	 *
	 * @param stream the response, the key answering it, the place its cursor carries, and the first page
	 *   read after that place, already judged reachable.
	 */
	open(stream: { firstPage: NoticePage; key: ChannelKey; place: StreamPlace; response: ServerResponse }): void;

	/** Gives the place back unused. */
	release(): void;
}

/** What reserving a stream's place gave. */
export type Reservation =
	{ kind: 'full' } | { kind: 'reserved'; reservation: StreamReservation } | { kind: 'stopping' };

/** The streams open on the instance. */
export interface NoticeStreams {
	/** Ends every open stream matching a test. */
	endWhere(test: (stream: HeldStream) => boolean): void;

	/**
	 * Reserves a stream's place for an application: refused while it holds as many streams on the
	 * instance as it may, reserved places included, and once the instance is stopping.
	 */
	reserve(applicationId: string): Reservation;

	/** Ends every stream and reserves no more, settling once each stream's work has ended. */
	stop(): Promise<void>;
}
