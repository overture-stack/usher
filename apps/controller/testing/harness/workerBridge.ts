import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

import type { BridgeMode, ResolveOutcome } from '@overture-stack/usher-bridge--express';

import { type Cleanup, eventually } from './waiting.js';
import type {
	BridgeStart,
	RecordedBridgeEvent,
	RecordedBridgeRequest,
	ResolvedBridgeTiming,
} from './vendoredBridge.js';

// A Bridge hosted in a worker thread, so that a second Bridge for one audience can run in the same process:
// the audience rule (`audienceInUse`) is per thread, and a worker loads its own modules. The worker runs the
// vendored Bridge exactly as `startBridge` runs it on the main thread (`workerBridgeHost.ts`), and answers
// the calls below over a message port.

/**
 * What starting a worker-hosted Bridge takes: a Bridge's start, without its wall clock, since a function
 * cannot cross to a worker.
 */
export type WorkerBridgeStart = Omit<BridgeStart, 'wallClock'>;

/** A start as it crosses to the worker, its Controller's URL as text. */
export type SerializedBridgeStart = Omit<WorkerBridgeStart, 'controllerUrl'> & { controllerUrl: string };

/**
 * A call to the worker. The instants a call carries, and those a reply carries, are epoch milliseconds, so
 * each thread converts them to its own `performance.now()` basis.
 */
export type WorkerCall =
	| { op: 'mode' }
	| { op: 'requests'; path: string; since: number }
	| { op: 'appliedNotices'; kind: string; since: number }
	| { op: 'resolve'; credential: string | null }
	| { op: 'start'; start: SerializedBridgeStart }
	| { op: 'stop' };

/** A call with the correlation id its reply carries back. */
export type WorkerRequest = WorkerCall & { id: number };

/** The worker's reply to one call: its value, or the message of the error the call raised. */
export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; message: string; ok: false };

/** The reply to `start`: the Bridge's timing as it resolves it. */
export interface WorkerStarted {
	timing: ResolvedBridgeTiming;
}

/**
 * A Bridge's handle, the same whether the Bridge runs on the main thread or in a worker. Each call is
 * answered asynchronously, since a worker's answer crosses a message port; a main-thread Bridge's answers
 * are the same values, given as promises.
 */
export interface BridgeHandle {
	/** The Bridge's core: its mode and its resolution of a credential, each answered asynchronously. */
	core: {
		mode(): Promise<BridgeMode>;
		resolve(credential: string | null): Promise<ResolveOutcome>;
	};

	/** The notices of a kind the Bridge applied at or after an instant, by `performance.now()`. */
	appliedNotices(kind: string, since?: number): Promise<readonly RecordedBridgeEvent[]>;

	/**
	 * The requests the Bridge started to a path at or after an instant, each with its answer as far as the
	 * recording fetch has it, by `performance.now()`.
	 */
	requests(path: string, since?: number): Promise<readonly RecordedBridgeRequest[]>;

	/**
	 * The first notice of a kind applied at or after an instant, waiting for it. Polls {@link appliedNotices}
	 * at each 10 ms, which a main-thread Bridge's `nextNotice` waits on without polling.
	 *
	 * @throws naming the notice, when none is applied in time.
	 */
	nextNotice(kind: string, since: number, timeoutMs: number): Promise<RecordedBridgeEvent>;

	/** Stops the Bridge, then ends its worker thread. Repeated calls do nothing further. */
	stop(): Promise<void>;

	/** The Bridge's timing as it resolves it, in milliseconds. */
	timing: ResolvedBridgeTiming;
}

/**
 * An instant on this thread's `performance.now()` basis, as an epoch millisecond: each thread has its own
 * time origin, so the same instant reads differently in each, and the epoch is the common reading.
 *
 * @param instant an instant, by `performance.now()` on this thread.
 */
export const epochOf = (instant: number): number => performance.timeOrigin + instant;

/**
 * An epoch millisecond on this thread's `performance.now()` basis, the inverse of {@link epochOf}.
 *
 * @param epoch an instant, as an epoch millisecond.
 */
export const localOf = (epoch: number): number => epoch - performance.timeOrigin;

/**
 * A recorded request with each of its instants converted: its start, its failure and its answer's arrival.
 *
 * @param request the recorded request.
 * @param convert how each instant is converted.
 */
export const convertRequest = (
	request: RecordedBridgeRequest,
	convert: (instant: number) => number,
): RecordedBridgeRequest => ({
	...request,
	answer:
		request.answer === undefined ? undefined : { ...request.answer, arrivedAt: convert(request.answer.arrivedAt) },
	failedAt: request.failedAt === undefined ? undefined : convert(request.failedAt),
	startedAt: convert(request.startedAt),
});

/**
 * A recorded event with its arrival converted.
 *
 * @param event the recorded event.
 * @param convert how its arrival is converted.
 */
export const convertEvent = (
	event: RecordedBridgeEvent,
	convert: (instant: number) => number,
): RecordedBridgeEvent => ({ ...event, arrivedAt: convert(event.arrivedAt) });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Starts a Bridge in a worker thread, with the same options `startBridge` takes, and resolves once the
 * Bridge has started. The worker is ended by the handle's `stop`, or by the cleanup when the test ends,
 * whether it passed or failed: the cleanup is registered before the worker is started.
 *
 * A worker started under the test command inherits its loader and conditions, so it loads the Bridge's
 * source as the main thread does.
 *
 * @param scope the test's cleanup, which ends the worker.
 * @param start the application, the Controller's URL and issuer, the profile, and the keys, the timing
 *   override when not the defaults.
 * @throws with the message of the error the Bridge raised when it fails to start.
 */
export const startWorkerBridge = async (scope: Cleanup, start: WorkerBridgeStart): Promise<BridgeHandle> => {
	const worker = new Worker(new URL('./workerBridgeHost.ts', import.meta.url));
	const waiting = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();
	let nextId = 0;
	let exited = false;

	const failAll = (error: Error): void => {
		waiting.forEach(({ reject }, id) => {
			waiting.delete(id);
			reject(error);
		});
	};
	worker.on('message', (reply: WorkerReply) => {
		const pending = waiting.get(reply.id);
		if (pending === undefined) {
			return;
		}
		waiting.delete(reply.id);
		if (reply.ok) {
			pending.resolve(reply.value);
		} else {
			pending.reject(new Error(reply.message));
		}
	});
	worker.on('error', (error: Error) => failAll(error));
	worker.on('exit', () => {
		exited = true;
		failAll(new Error("the bridge's worker thread exited"));
	});

	// The reply's type is the one the call names: the worker answers each call with the value that call asks for.
	const call = <Result>(request: WorkerCall): Promise<Result> =>
		new Promise<unknown>((resolve, reject) => {
			if (exited) {
				reject(new Error("the bridge's worker thread has exited"));
				return;
			}
			nextId += 1;
			waiting.set(nextId, { reject, resolve });
			const message: WorkerRequest = { ...request, id: nextId };
			worker.postMessage(message);
		}) as Promise<Result>;

	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			try {
				if (!exited) {
					await call({ op: 'stop' });
				}
			} finally {
				await worker.terminate();
			}
		})();
		return stopping;
	};
	scope.defer(stop);

	const started = await call<WorkerStarted>({
		op: 'start',
		start: { ...start, controllerUrl: start.controllerUrl.href },
	});
	const appliedNotices = async (kind: string, since = 0): Promise<readonly RecordedBridgeEvent[]> =>
		(await call<readonly RecordedBridgeEvent[]>({ kind, op: 'appliedNotices', since: epochOf(since) })).map(
			(event) => convertEvent(event, localOf),
		);
	const requests = async (path: string, since = 0): Promise<readonly RecordedBridgeRequest[]> =>
		(await call<readonly RecordedBridgeRequest[]>({ op: 'requests', path, since: epochOf(since) })).map((request) =>
			convertRequest(request, localOf),
		);
	const nextNotice = async (kind: string, since: number, timeoutMs: number): Promise<RecordedBridgeEvent> => {
		const arrived = await eventually(async () => (await appliedNotices(kind, since)).length > 0, timeoutMs, 10);
		if (!arrived) {
			throw new Error(`the bridge applied no ${kind} notice within ${timeoutMs} ms`);
		}
		const [event] = await appliedNotices(kind, since);
		if (event === undefined) {
			throw new Error(`the bridge applied no ${kind} notice within ${timeoutMs} ms`);
		}
		return event;
	};
	return {
		appliedNotices,
		core: {
			mode: () => call<BridgeMode>({ op: 'mode' }),
			resolve: (credential) => call<ResolveOutcome>({ credential, op: 'resolve' }),
		},
		nextNotice,
		requests,
		stop,
		timing: started.timing,
	};
};
