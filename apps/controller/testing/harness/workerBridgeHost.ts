import { parentPort } from 'node:worker_threads';

import { startBridge, type StartedBridge } from './vendoredBridge.js';
import {
	convertEvent,
	convertRequest,
	epochOf,
	type WorkerReply,
	type WorkerRequest,
	type WorkerStarted,
} from './workerBridge.js';

// The worker-thread side of `startWorkerBridge`: runs one vendored Bridge, as `startBridge` runs it on the
// main thread, and answers each call of the protocol in `workerBridge.ts`. It is loaded only as a worker.

const port = parentPort;
if (port === null) {
	throw new Error('the worker bridge host runs only in a worker thread');
}

let running: StartedBridge | undefined;

const runningBridge = (): StartedBridge => {
	if (running === undefined) {
		throw new Error('the bridge in this worker has not started');
	}
	return running;
};

const answer = async (request: WorkerRequest): Promise<unknown> => {
	switch (request.op) {
		case 'start': {
			running = await startBridge({
				...request.start,
				controllerUrl: new URL(request.start.controllerUrl),
			});
			const reply: WorkerStarted = { timing: running.timing };
			return reply;
		}
		case 'mode':
			return runningBridge().core.mode();
		case 'resolve':
			return runningBridge().core.resolve(request.credential);
		case 'requests':
			return runningBridge()
				.fetch.requests()
				.map((recorded) => convertRequest(recorded, epochOf))
				.filter(({ path, startedAt }) => path === request.path && startedAt >= request.since);
		case 'appliedNotices':
			return runningBridge()
				.logger.events('notice.applied')
				.map((event) => convertEvent(event, epochOf))
				.filter(({ arrivedAt, data }) => arrivedAt >= request.since && data['kind'] === request.kind);
		case 'stop': {
			const bridge = running;
			running = undefined;
			await bridge?.stop();
			return undefined;
		}
	}
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

port.on('message', (request: WorkerRequest) => {
	answer(request).then(
		(value) => {
			const reply: WorkerReply = { id: request.id, ok: true, value };
			port.postMessage(reply);
		},
		(error: unknown) => {
			const reply: WorkerReply = { id: request.id, message: messageOf(error), ok: false };
			port.postMessage(reply);
		},
	);
});
