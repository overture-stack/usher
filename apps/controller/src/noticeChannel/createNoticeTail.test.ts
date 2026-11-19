import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createNoticeTail, TAIL_READ_FAILED } from './createNoticeTail.js';
import type { LiveStream, NoticePage, NoticeReader, StoredNotice } from './types.js';

const EPOCH = '0d8e2c4a-6f1b-4c3d-9a7e-5b2f1e0c8d6a';

const OTHER_EPOCH = '7f3a9b1c-2d4e-4f6a-8b0c-1d2e3f4a5b6c';

const REREAD_MS = 2_000;

const baseline = (position: bigint): StoredNotice => ({
	createdAt: position * 10n,
	kind: 'baseline',
	position,
});

const pageOf = (
	notices: readonly StoredNotice[],
	{
		epoch = EPOCH,
		more = false,
		trimmedThrough = 0n,
	}: { epoch?: string; more?: boolean; trimmedThrough?: bigint } = {},
): NoticePage => ({
	createdAtPosition: undefined,
	epoch,
	head: {
		createdAt: undefined,
		epoch,
		position: notices.at(-1)?.position ?? 1_000n,
	},
	more,
	notices,
	trimmedThrough,
});

interface Read {
	after: bigint;
	audience: string | undefined;
}

// A reader answering each read with the next page scripted, holding a read open while the test holds it.
const scriptedReader = (
	pages: readonly (Error | NoticePage)[],
): {
	hold: () => () => void;
	reader: NoticeReader;
	reads: Read[];
} => {
	const state: { held: Promise<void> | undefined; next: number } = {
		held: undefined,
		next: 0,
	};
	const reads: Read[] = [];
	return {
		hold: () => {
			const release: { release: () => void } = { release: () => undefined };
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
				const answer = pages[state.next] ?? pageOf([]);
				state.next += 1;
				await state.held;
				if (answer instanceof Error) {
					throw answer;
				}
				return answer;
			},
			head: () => Promise.reject(new Error('the tail reads no head')),
		},
		reads,
	};
};

const liveStream = (
	scannedThrough: bigint,
	epoch = EPOCH,
): LiveStream & { ended: () => boolean; offered: bigint[][] } => {
	const state = { ended: false };
	const offered: bigint[][] = [];
	return {
		end: () => {
			state.ended = true;
		},
		ended: () => state.ended,
		epoch,
		offer: (notices) => {
			offered.push(notices.map(({ position }) => position));
		},
		offered,
		scannedThrough: () => scannedThrough,
	};
};

const settled = (): Promise<void> =>
	new Promise((resolve) => {
		setImmediate(resolve);
	});

const quietLog = (): {
	error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
	lines: { fields: unknown; message: string }[];
} => {
	const lines: { fields: unknown; message: string }[] = [];
	return {
		error: (message, fields) => {
			lines.push({ fields, message });
		},
		lines,
	};
};

suite("the instance's tail of the notice stream", () => {
	test('reads nothing while no stream is live', async () => {
		const { reader, reads } = scriptedReader([]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});

		tail.wake();
		await settled();
		await tail.stop();

		assert.deepEqual(reads, []);
		assert.equal(tail.position(), undefined);
	});

	test("reads every audience's notices after the first live stream's position, a page at a time, handing each page to every live stream", async () => {
		const { reader, reads } = scriptedReader([
			pageOf([baseline(6n), baseline(7n)], { more: true }),
			pageOf([baseline(8n)]),
		]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		const first = liveStream(5n);
		const second = liveStream(5n);

		const joined = [tail.join(first), tail.join(second)];
		tail.wake();
		await settled();
		await tail.stop();

		assert.deepEqual(joined, [true, true]);
		assert.deepEqual(reads, [
			{ after: 5n, audience: undefined },
			{ after: 7n, audience: undefined },
		]);
		assert.deepEqual(first.offered, [[6n, 7n], [8n]]);
		assert.deepEqual(second.offered, first.offered);
	});

	test('takes a stream that has passed its position, and turns away one behind it', async () => {
		const { reader } = scriptedReader([pageOf([baseline(9n)])]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		tail.join(liveStream(5n));
		tail.wake();
		await settled();

		const behind = tail.join(liveStream(8n));
		const level = tail.join(liveStream(9n));
		const ahead = tail.join(liveStream(12n));
		await tail.stop();

		assert.deepEqual([behind, level, ahead], [false, true, true]);
	});

	test('answers every wake arriving during a read with one read after it', async () => {
		const scripted = scriptedReader([pageOf([baseline(6n)]), pageOf([baseline(7n)])]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader: scripted.reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		tail.join(liveStream(5n));
		const release = scripted.hold();

		tail.wake();
		tail.wake();
		tail.wake();
		release();
		await settled();
		await settled();
		await tail.stop();

		assert.deepEqual(
			scripted.reads.map(({ after }) => after),
			[5n, 6n],
		);
	});

	test('reads at every reread interval while a stream is live, and no more once none is', async (context) => {
		context.mock.timers.enable({ apis: ['setInterval'] });
		const { reader, reads } = scriptedReader([]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		const stream = liveStream(5n);
		tail.join(stream);

		context.mock.timers.tick(REREAD_MS);
		await settled();
		context.mock.timers.tick(REREAD_MS);
		await settled();
		tail.leave(stream);
		context.mock.timers.tick(REREAD_MS);
		await settled();
		await tail.stop();

		assert.equal(reads.length, 2);
		assert.equal(tail.position(), undefined);
	});

	test('re-arms its reread interval at the first tick reading a changed value, so a live tail reads at the new interval from then on', async (context) => {
		context.mock.timers.enable({ apis: ['setInterval'] });
		const { reader, reads } = scriptedReader([]);
		let milliseconds = REREAD_MS;
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => milliseconds,
		});
		tail.join(liveStream(5n));

		milliseconds = REREAD_MS / 4;
		context.mock.timers.tick(REREAD_MS);
		await settled();
		assert.equal(reads.length, 1);

		context.mock.timers.tick(REREAD_MS / 4);
		await settled();
		assert.equal(reads.length, 2);
		await tail.stop();
	});

	test('ends every live stream once a read finds the epoch replaced, the watermark past its position, or the newest notice below it', async () => {
		const cases = [
			pageOf([baseline(6n)], { epoch: OTHER_EPOCH }),
			pageOf([baseline(9n)], { trimmedThrough: 8n }),
			{ ...pageOf([]), head: { createdAt: 30n, epoch: EPOCH, position: 3n } },
		];

		const outcomes = await Promise.all(
			cases.map(async (page) => {
				const { reader } = scriptedReader([page]);
				const tail = createNoticeTail({
					log: quietLog(),
					pageLimit: () => 2,
					reader,
					rereadMilliseconds: () => REREAD_MS,
				});
				const streams = [liveStream(5n), liveStream(6n)];
				streams.forEach((stream) => tail.join(stream));
				tail.wake();
				await settled();
				await tail.stop();
				return {
					ended: streams.map((stream) => stream.ended()),
					offered: streams.flatMap((stream) => stream.offered),
					position: tail.position(),
				};
			}),
		);

		outcomes.forEach((outcome) => {
			assert.deepEqual(outcome, {
				ended: [true, true],
				offered: [],
				position: undefined,
			});
		});
	});

	test("ends the live streams of an older epoch when a stream of the store's newer epoch joins", async () => {
		const { reader } = scriptedReader([]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		const older = liveStream(50n);
		const newer = liveStream(3n, OTHER_EPOCH);
		tail.join(older);

		const joined = tail.join(newer);
		await tail.stop();

		assert.equal(joined, true);
		assert.equal(older.ended(), true);
		assert.equal(newer.ended(), false);
	});

	test('keeps its position when a read fails, writing the failure by its code alone, and reads from it again', async () => {
		const log = quietLog();
		const failure = Object.assign(new Error('the statement quoted a value'), {
			code: 'storeTimeout',
		});
		const { reader, reads } = scriptedReader([failure, pageOf([baseline(6n)])]);
		const tail = createNoticeTail({
			log,
			pageLimit: () => 2,
			reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		const stream = liveStream(5n);
		tail.join(stream);

		tail.wake();
		await settled();
		tail.wake();
		await settled();
		await tail.stop();

		assert.deepEqual(
			reads.map(({ after }) => after),
			[5n, 5n],
		);
		assert.deepEqual(stream.offered, [[6n]]);
		assert.deepEqual(log.lines, [{ fields: { code: 'storeTimeout' }, message: TAIL_READ_FAILED }]);
	});

	test('settles its stop once the read in flight has ended, handing nothing it read after', async () => {
		const scripted = scriptedReader([pageOf([baseline(6n)])]);
		const tail = createNoticeTail({
			log: quietLog(),
			pageLimit: () => 2,
			reader: scripted.reader,
			rereadMilliseconds: () => REREAD_MS,
		});
		const stream = liveStream(5n);
		tail.join(stream);
		const release = scripted.hold();
		tail.wake();
		await settled();

		const stopping = tail.stop();
		const state = { stopped: false };
		void stopping.then(() => {
			state.stopped = true;
		});
		await settled();
		const stoppedBeforeRelease = state.stopped;
		release();
		await stopping;
		tail.wake();
		await settled();

		assert.equal(stoppedBeforeRelease, false);
		assert.deepEqual(stream.offered, []);
		assert.equal(scripted.reads.length, 1);
		assert.equal(tail.join(liveStream(9n)), false);
	});
});
