import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import { applicationSubkeys } from '../applicationKeyRing/index.js';
import { createCursorCipher } from '../noticeStream/index.js';
import { createNoticeStreams, SLOW_STREAM_CLOSED, STREAM_HEADERS } from './createNoticeStreams.js';
import type {
	ChannelKey,
	LiveStream,
	NoticePage,
	NoticeReader,
	NoticeTail,
	StoredNotice,
	StreamPlace,
} from './types.js';

const EPOCH = '0d8e2c4a-6f1b-4c3d-9a7e-5b2f1e0c8d6a';

const HEARTBEAT_MS = 10_000;

const LIFETIME_SECONDS = 900;

const cursors = createCursorCipher(randomBytes(32).toString('base64url'));

const keyOf = (applicationId: string): ChannelKey => ({
	applicationId,
	keyId: randomUUID(),
	...applicationSubkeys(randomBytes(32)),
});

const baseline = (position: bigint): StoredNotice => ({
	createdAt: position * 10n,
	kind: 'baseline',
	position,
});

const placeAt = (position: bigint): StreamPlace => ({
	createdAt: position * 10n,
	epoch: EPOCH,
	position,
});

// A page read after a place whose notice is stored as it was read, so history reaches it.
const pageAfter = (
	after: bigint,
	notices: readonly StoredNotice[],
	{
		head = notices.at(-1)?.position ?? after,
		more = false,
		trimmedThrough = 0n,
	}: { head?: bigint; more?: boolean; trimmedThrough?: bigint } = {},
): NoticePage => ({
	createdAtPosition: after * 10n,
	epoch: EPOCH,
	head: placeAt(head),
	more,
	notices,
	trimmedThrough,
});

interface FakeResponse {
	/** Has the socket take writes again, and tells the stream so. */
	drain(): void;

	response: ServerResponse;

	state: {
		accepting: boolean;
		chunks: string[];
		closing: 'destroy' | 'end' | undefined;
		headers: unknown;
		status: number | undefined;
	};
}

// A response whose socket takes every write while accepting, and holds back once told not to.
const fakeResponse = (): FakeResponse => {
	const emitter = new EventEmitter();
	const state: FakeResponse['state'] = {
		accepting: true,
		chunks: [],
		closing: undefined,
		headers: undefined,
		status: undefined,
	};
	const closeWith = (closing: 'destroy' | 'end'): void => {
		state.closing ??= closing;
		emitter.emit('close');
	};
	const response = Object.assign(emitter, {
		destroy: () => {
			closeWith('destroy');
		},
		end: () => {
			closeWith('end');
		},
		socket: { destroyed: false, setNoDelay: () => undefined },
		write: (text: string) => {
			state.chunks.push(text);
			return state.accepting;
		},
		writeHead: (status: number, headers: unknown) => {
			state.status = status;
			state.headers = headers;
		},
	});
	return {
		drain: () => {
			state.accepting = true;
			emitter.emit('drain');
		},
		// A fake standing in for the parts of a response the streams use.
		response: response as unknown as ServerResponse,
		state,
	};
};

// The positions the notice events written so far carry, read back from their cursors.
const eventPositions = (chunks: readonly string[]): readonly bigint[] =>
	chunks.flatMap((chunk) => {
		const id = /^id: (?<cursor>\S+)\nevent: notice\n/u.exec(chunk)?.groups?.['cursor'];
		const place = id === undefined ? undefined : cursors.open(id);
		return place === undefined ? [] : [place.position];
	});

const scriptedReader = (
	pages: readonly NoticePage[],
): {
	hold: () => () => void;
	reader: NoticeReader;
	reads: { after: bigint; audience: string | undefined }[];
} => {
	const state: { held: Promise<void> | undefined; next: number } = {
		held: undefined,
		next: 0,
	};
	const reads: { after: bigint; audience: string | undefined }[] = [];
	return {
		hold: () => {
			const release = { release: (): void => undefined };
			state.held = new Promise((resolve) => {
				release.release = resolve;
			});
			return () => {
				state.held = undefined;
				release.release();
			};
		},
		reader: {
			after: async (after, { audience }) => {
				reads.push({ after, audience });
				const page = pages[state.next] ?? pageAfter(after, []);
				state.next += 1;
				await state.held;
				return page;
			},
			head: () => Promise.reject(new Error('a stream reads no head')),
		},
		reads,
	};
};

// A tail taking each stream as told, keeping the streams it took.
const fakeTail = (answers: readonly boolean[] = []): NoticeTail & { joined: LiveStream[]; left: LiveStream[] } => {
	const state = { next: 0 };
	const joined: LiveStream[] = [];
	const left: LiveStream[] = [];
	return {
		join: (stream) => {
			const joins = answers[state.next] ?? true;
			state.next += 1;
			if (joins) {
				joined.push(stream);
			}
			return joins;
		},
		joined,
		leave: (stream) => {
			left.push(stream);
		},
		left,
		position: () => undefined,
		stop: async () => undefined,
		wake: () => undefined,
	};
};

const lines = (): {
	error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
	logged: { fields: unknown; message: string }[];
	warning: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
} => {
	const logged: { fields: unknown; message: string }[] = [];
	const write = (message: string, fields?: Readonly<Record<string, unknown>>): void => {
		logged.push({ fields, message });
	};
	return { error: write, logged, warning: write };
};

const settled = async (rounds = 20): Promise<void> => {
	await Array.from({ length: rounds }).reduce<Promise<void>>(
		(earlier) =>
			earlier.then(
				() =>
					new Promise((resolve) => {
						setImmediate(resolve);
					}),
			),
		Promise.resolve(),
	);
};

// Waits until a condition holds, for at most five seconds of real time, checking after the work already
// due has run, since encrypting a notice settles off the event loop; the test's assertions then judge
// what was found.
const until = async (condition: () => boolean, deadline = performance.now() + 5_000): Promise<void> => {
	if (condition() || performance.now() > deadline) {
		return;
	}
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
	await until(condition, deadline);
};

const streamsWith = ({
	limit = 64,
	queueLimit = 1_000,
	reader = scriptedReader([]).reader,
	tail = fakeTail(),
	log = lines(),
}: {
	limit?: number;
	log?: ReturnType<typeof lines>;
	queueLimit?: number;
	reader?: NoticeReader;
	tail?: NoticeTail;
} = {}): ReturnType<typeof createNoticeStreams> =>
	createNoticeStreams({
		cursors,
		eventLog: log,
		reader,
		settings: {
			heartbeatMilliseconds: HEARTBEAT_MS,
			noticePageLimit: 2,
			streamLimitPerAudience: limit,
			streamMaximumLifetimeSeconds: LIFETIME_SECONDS,
			streamQueueLimit: queueLimit,
		},
		tail,
	});

const opened = (
	streams: ReturnType<typeof createNoticeStreams>,
	{
		firstPage,
		key = keyOf(randomUUID()),
		place = placeAt(5n),
	}: { firstPage: NoticePage; key?: ChannelKey; place?: StreamPlace },
): FakeResponse => {
	const fake = fakeResponse();
	const reserved = streams.reserve(key.applicationId);
	if (reserved.kind !== 'reserved') {
		throw new Error(`the stream's place was ${reserved.kind}`);
	}
	reserved.reservation.open({
		firstPage,
		key,
		place,
		response: fake.response,
	});
	return fake;
};

suite("the instance's streams", () => {
	test('opens a stream with its headers and a first byte at once, then writes each notice of its first page in order', async () => {
		const tail = fakeTail();
		const streams = streamsWith({ tail });

		const fake = opened(streams, {
			firstPage: pageAfter(5n, [baseline(6n), baseline(7n)]),
		});
		const atOnce = [...fake.state.chunks];
		await until(() => tail.joined.length === 1);
		await streams.stop();

		assert.equal(fake.state.status, 200);
		assert.deepEqual(fake.state.headers, STREAM_HEADERS);
		assert.deepEqual(atOnce, [':\n\n']);
		assert.deepEqual(eventPositions(fake.state.chunks), [6n, 7n]);
		assert.equal(tail.joined.length, 1);
	});

	test("reads on from where a page reached while more wait, and from the page's head while the tail is ahead, joining it once passed", async () => {
		const applicationId = randomUUID();
		const tail = fakeTail([false, true]);
		const scripted = scriptedReader([
			pageAfter(6n, [baseline(8n)], { head: 9n }),
			pageAfter(9n, [], { head: 10n }),
		]);
		const streams = streamsWith({ reader: scripted.reader, tail });

		const fake = opened(streams, {
			firstPage: pageAfter(5n, [baseline(6n)], { more: true }),
			key: keyOf(applicationId),
		});
		await until(() => tail.joined.length === 1);
		await streams.stop();

		assert.deepEqual(scripted.reads, [
			{ after: 6n, audience: applicationId },
			{ after: 9n, audience: applicationId },
		]);
		assert.deepEqual(eventPositions(fake.state.chunks), [6n, 8n]);
		assert.equal(tail.joined.length, 1);
		assert.equal(tail.joined[0]?.scannedThrough(), 10n);
	});

	test('delivers each live notice reaching its audience after what it passed, in order, and nothing else', async () => {
		const applicationId = randomUUID();
		const tail = fakeTail();
		const streams = streamsWith({ tail });
		const fake = opened(streams, {
			firstPage: pageAfter(5n, [baseline(6n)], { head: 7n }),
			key: keyOf(applicationId),
		});
		await until(() => tail.joined.length === 1);

		tail.joined[0]?.offer([
			baseline(7n),
			{ ...baseline(8n), audience: randomUUID(), kind: 'servedResources' },
			{ ...baseline(9n), audience: applicationId, kind: 'servedResources' },
			{
				...baseline(10n),
				kind: 'category',
				resource: 'STUDY-A1',
				servedBy: [randomUUID()],
			},
			baseline(11n),
		]);
		await until(() => eventPositions(fake.state.chunks).length === 3);
		await streams.stop();

		assert.deepEqual(eventPositions(fake.state.chunks), [6n, 9n, 11n]);
		assert.equal(tail.joined[0]?.scannedThrough(), 11n);
	});

	test('ends a stream whose replay finds history no longer reaching where it got to', async () => {
		const scripted = scriptedReader([pageAfter(6n, [baseline(8n)], { trimmedThrough: 7n })]);
		const tail = fakeTail();
		const streams = streamsWith({ reader: scripted.reader, tail });

		const fake = opened(streams, {
			firstPage: pageAfter(5n, [baseline(6n)], { more: true }),
		});
		await until(() => fake.state.closing !== undefined);
		await streams.stop();

		assert.equal(fake.state.closing, 'end');
		assert.deepEqual(eventPositions(fake.state.chunks), [6n]);
		assert.deepEqual(tail.joined, []);
	});

	test('ends a stream that finds nothing past what it read while the tail is ahead of it, as after a restore that kept the epoch', async () => {
		const scripted = scriptedReader([pageAfter(5n, [], { head: 5n })]);
		const tail = fakeTail([false]);
		const streams = streamsWith({ reader: scripted.reader, tail });

		const fake = opened(streams, {
			firstPage: pageAfter(5n, [], { head: 5n }),
		});
		await until(() => fake.state.closing !== undefined);
		await streams.stop();

		assert.equal(fake.state.closing, 'end');
		assert.equal(scripted.reads.length, 1);
		assert.deepEqual(tail.joined, []);
	});

	test('gives back the place of a stream whose reader left before it opened, sending nothing', async () => {
		const applicationId = randomUUID();
		const streams = streamsWith({ limit: 1 });
		const fake = fakeResponse();
		Object.assign(fake.response, {
			socket: { destroyed: true, setNoDelay: () => undefined },
		});
		const reserved = streams.reserve(applicationId);
		if (reserved.kind !== 'reserved') {
			throw new Error('no place reserved');
		}

		reserved.reservation.open({
			firstPage: pageAfter(5n, [baseline(6n)]),
			key: keyOf(applicationId),
			place: placeAt(5n),
			response: fake.response,
		});
		await settled();
		const again = streams.reserve(applicationId).kind;
		await streams.stop();

		assert.equal(fake.state.closing, 'destroy');
		assert.equal(fake.state.status, undefined);
		assert.deepEqual(fake.state.chunks, []);
		assert.equal(again, 'reserved');
	});

	test('waits for its reader to drain what the socket could not take before writing more, then goes on in order', async () => {
		const streams = streamsWith();
		const fake = fakeResponse();
		fake.state.accepting = false;
		const key = keyOf(randomUUID());
		const reserved = streams.reserve(key.applicationId);
		if (reserved.kind !== 'reserved') {
			throw new Error('no place reserved');
		}

		reserved.reservation.open({
			firstPage: pageAfter(5n, [baseline(6n), baseline(7n)]),
			key,
			place: placeAt(5n),
			response: fake.response,
		});
		await settled();
		const beforeDrain = [...fake.state.chunks];
		fake.drain();
		await until(() => eventPositions(fake.state.chunks).length === 2);
		await streams.stop();

		assert.deepEqual(beforeDrain, [':\n\n']);
		assert.deepEqual(eventPositions(fake.state.chunks), [6n, 7n]);
	});

	test('closes at once a live stream whose reader stopped reading while more than the queue limit of notices wait, naming its application in the log', async () => {
		const applicationId = randomUUID();
		const log = lines();
		const tail = fakeTail();
		const streams = streamsWith({ log, queueLimit: 2, tail });
		const fake = opened(streams, {
			firstPage: pageAfter(5n, []),
			key: keyOf(applicationId),
		});
		await until(() => tail.joined.length === 1);

		fake.state.accepting = false;
		tail.joined[0]?.offer([baseline(6n)]);
		await until(() => eventPositions(fake.state.chunks).length === 1);
		tail.joined[0]?.offer([baseline(7n), baseline(8n)]);
		const closedAtTheLimit = fake.state.closing;
		tail.joined[0]?.offer([baseline(9n)]);
		await settled();
		await streams.stop();

		assert.equal(closedAtTheLimit, undefined);
		assert.equal(fake.state.closing, 'destroy');
		assert.deepEqual(log.logged, [{ fields: { applicationId }, message: SLOW_STREAM_CLOSED }]);
		assert.deepEqual(tail.left, tail.joined);
	});

	test('writes a heartbeat after each silence of the heartbeat interval, and none while its reader is not draining', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const streams = streamsWith();
		const fake = opened(streams, { firstPage: pageAfter(5n, []) });
		await settled();
		const heartbeats = (): number => fake.state.chunks.filter((chunk) => chunk === ':\n\n').length;

		context.mock.timers.tick(HEARTBEAT_MS - 1);
		const beforeSilence = heartbeats();
		context.mock.timers.tick(1);
		const afterSilence = heartbeats();
		fake.state.accepting = false;
		context.mock.timers.tick(HEARTBEAT_MS);
		const whenHeldBack = heartbeats();
		context.mock.timers.tick(3 * HEARTBEAT_MS);
		const whileHeldBack = heartbeats();
		await streams.stop();

		assert.deepEqual([beforeSilence, afterSilence, whenHeldBack, whileHeldBack], [1, 2, 3, 3]);
	});

	test('ends a stream at its maximum lifetime', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const streams = streamsWith();
		const fake = opened(streams, { firstPage: pageAfter(5n, []) });
		await settled();

		context.mock.timers.tick(LIFETIME_SECONDS * 1000 - 1);
		const beforeLifetime = fake.state.closing;
		context.mock.timers.tick(1);
		await streams.stop();

		assert.equal(beforeLifetime, undefined);
		assert.equal(fake.state.closing, 'end');
	});

	test("refuses an application's place past its limit, counting places reserved and streams open, and frees each place given back or ended", async () => {
		const applicationId = randomUUID();
		const tail = fakeTail();
		const streams = streamsWith({ limit: 2, tail });
		const first = opened(streams, {
			firstPage: pageAfter(5n, []),
			key: keyOf(applicationId),
		});
		const second = streams.reserve(applicationId);

		const atLimit = streams.reserve(applicationId).kind;
		const otherApplication = streams.reserve(randomUUID()).kind;
		if (second.kind === 'reserved') {
			second.reservation.release();
		}
		const afterRelease = streams.reserve(applicationId).kind;
		const full = streams.reserve(applicationId).kind;
		first.response.emit('close');
		const afterClose = streams.reserve(applicationId).kind;
		await streams.stop();

		assert.equal(second.kind, 'reserved');
		assert.deepEqual(
			[atLimit, otherApplication, afterRelease, full, afterClose],
			['full', 'reserved', 'reserved', 'full', 'reserved'],
		);
	});

	test('ends every stream opened under a key matching a test, and no other', async () => {
		const revoked = keyOf(randomUUID());
		const streams = streamsWith();
		const ended = opened(streams, {
			firstPage: pageAfter(5n, []),
			key: revoked,
		});
		const kept = opened(streams, { firstPage: pageAfter(5n, []) });
		await settled();

		streams.endWhere(({ key }) => key.keyId === revoked.keyId);
		const keptOpen = kept.state.closing;
		await streams.stop();

		assert.equal(ended.state.closing, 'end');
		assert.equal(keptOpen, undefined);
	});

	test('closes every stream at its stop, reserves no place after, and settles once each replay read has ended', async () => {
		const scripted = scriptedReader([pageAfter(6n, [])]);
		const tail = fakeTail();
		const streams = streamsWith({ reader: scripted.reader, tail });
		const release = scripted.hold();
		const fake = opened(streams, {
			firstPage: pageAfter(5n, [baseline(6n)], { more: true }),
		});
		await until(() => scripted.reads.length === 1);

		const stopping = streams.stop();
		const state = { stopped: false };
		void stopping.then(() => {
			state.stopped = true;
		});
		await settled();
		const stoppedBeforeRead = state.stopped;
		release();
		await stopping;

		assert.equal(fake.state.closing, 'destroy');
		assert.equal(stoppedBeforeRead, false);
		assert.equal(streams.reserve(randomUUID()).kind, 'stopping');
		assert.deepEqual(tail.joined, []);
	});
});
