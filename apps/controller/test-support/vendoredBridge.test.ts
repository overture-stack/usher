import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import { CONFIGURATION_DEFAULTS } from '@overture-stack/usher-express-bridge';
import { CompactEncrypt } from 'jose';

import { SUBKEY_LABELS, subkeyBytes } from './bridgeWire.js';
import { COMPRESSED_CONTROLLER_TIMING } from './harness.js';
import { type RecordedRequest, type ScriptedAnswer, startRecordingServer } from './recordingServer.js';
import {
	afterCursorOf,
	blockGlobalDispatcher,
	createRecordingFetch,
	createRecordingLogger,
	exchangedCredentialOf,
	isHeadPoll,
	principalOf,
	reaches,
	RECORDED_BODY_CHARACTERS,
	requestsTo,
	resolvedBridgeTiming,
	settledPollStart,
	startBridge,
	TIMING_PROFILES,
	type TimingProfileName,
} from './vendoredBridge.js';
import { cleanupFor, eventually } from './waiting.js';

const syntheticKey = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

const APPLICATION = Object.freeze({
	id: 'arranger-test',
	key: syntheticKey(9),
});

const ISSUER = 'https://usher.example.org';

// A poll's answer, sealed under the application's poll-answer subkey as the Controller seals one,
// echoing the request's own cursor and nonce.
const pollAnswer = async (
	request: RecordedRequest,
	{ more, next }: { more: boolean; next: string },
): Promise<string> => {
	const query = new URL(request.target, 'http://127.0.0.1').searchParams;
	return new CompactEncrypt(
		new TextEncoder().encode(
			JSON.stringify({
				after: query.get('after') ?? 'head',
				more,
				next,
				nonce: query.get('nonce'),
				notices: [],
				v: 1,
			}),
		),
	)
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'usher-poll+jwt' })
		.encrypt(subkeyBytes(APPLICATION.key, SUBKEY_LABELS.pollAnswer));
};

// A stand-in for the Controller answering each poll by the cursor it asks after, each check from
// c-1 two pages long, and every other request 503.
const pagedController = (request: RecordedRequest): ScriptedAnswer => {
	const url = new URL(request.target, 'http://127.0.0.1');
	if (!url.pathname.endsWith('/notices')) {
		return { body: 'unavailable', status: 503 };
	}
	const after = url.searchParams.get('after');
	const page =
		after === null
			? { more: false, next: 'c-1' }
			: after === 'c-1'
				? { more: true, next: 'c-2' }
				: { more: false, next: 'c-1' };
	return {
		respond: (response) => {
			void pollAnswer(request, page).then((body) =>
				response.writeHead(200, { 'content-type': 'application/jose' }).end(`${body}\n`),
			);
		},
	};
};

suite("the bridge's timing profiles", () => {
	test("maps #217's letters to the bridge's settings, and keeps the bridge's order between them", () => {
		const compressed = resolvedBridgeTiming('compressed');

		assert.deepEqual(compressed, {
			exchangeTimeoutMs: 1000,
			failureHoldMs: 1000,
			graceMs: 4000,
			pollDeadlineMs: 500,
			pollIntervalMs: 2000,
			pollRecoveryIntervalMs: 1000,
			pushIdleMs: 1500,
			tokenTtlMs: 10_000,
		});
		assert.ok(compressed.pushIdleMs <= compressed.pollIntervalMs);
		assert.ok(compressed.pollRecoveryIntervalMs <= compressed.pollIntervalMs);
		assert.ok(11 * compressed.pollIntervalMs + 20 * compressed.pollDeadlineMs < 10 * compressed.graceMs);
		assert.ok(compressed.pushIdleMs >= 2 * COMPRESSED_CONTROLLER_TIMING.heartbeatMilliseconds);
		assert.equal(TIMING_PROFILES.compressed.controller, COMPRESSED_CONTROLLER_TIMING);
	});

	test("sets a test's override over a profile, the failure hold among the stores' settings", () => {
		assert.deepEqual(
			resolvedBridgeTiming('compressed', {
				exchangeTimeoutMs: 3000,
				stores: { failureHoldMs: 2000 },
			}),
			{
				...resolvedBridgeTiming('compressed'),
				exchangeTimeoutMs: 3000,
				failureHoldMs: 2000,
			},
		);
		assert.deepEqual(resolvedBridgeTiming('ims', { pollIntervalMs: 20_000 }), {
			...resolvedBridgeTiming('ims'),
			pollIntervalMs: 20_000,
		});
	});

	test("gives the iMS profile the bridge's defaults and the controller's production ones", () => {
		assert.deepEqual(resolvedBridgeTiming('ims'), {
			exchangeTimeoutMs: CONFIGURATION_DEFAULTS.exchangeTimeoutMs,
			failureHoldMs: CONFIGURATION_DEFAULTS.stores.failureHoldMs,
			graceMs: 60_000,
			pollDeadlineMs: 10_000,
			pollIntervalMs: 30_000,
			pollRecoveryIntervalMs: 10_000,
			pushIdleMs: 25_000,
			tokenTtlMs: CONFIGURATION_DEFAULTS.tokenTtlMs,
		});
		assert.deepEqual(TIMING_PROFILES.ims.controller, {});
	});
});

suite('the recording fetch', () => {
	test("records each request's start, method, path, query and Last-Event-ID, and passes it on through an Agent of its own", async (context) => {
		const scope = cleanupFor(context);
		await blockGlobalDispatcher(scope);
		const server = await startRecordingServer(() => ({
			body: 'answered',
			status: 200,
		}));
		scope.defer(() => server.stop());
		const recording = createRecordingFetch(new URL('usher/', server.url));
		scope.defer(() => recording.close());
		const before = performance.now();

		const exchanged = await recording.fetch(new URL('usher/exchange', server.url), {
			body: '{}',
			headers: { accept: 'application/jwt' },
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(2000),
		});
		const streamed = await recording.fetch(new URL('usher/notices/stream', server.url), {
			headers: { 'last-event-id': 'c-1_x' },
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(2000),
		});
		const polled = await recording.fetch(new URL('usher/notices?head=true&nonce=n0', server.url), {
			headers: {},
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(2000),
		});
		const globalFetch = await fetch(new URL('usher/exchange', server.url)).then(
			() => 'reached',
			() => 'blocked',
		);

		assert.deepEqual([exchanged.status, streamed.status, polled.status], [200, 200, 200]);
		assert.equal(globalFetch, 'blocked');
		assert.deepEqual(
			recording.requests().map(({ lastEventId, method, path, query }) => ({
				lastEventId,
				method,
				path,
				query,
			})),
			[
				{ lastEventId: undefined, method: 'POST', path: 'exchange', query: '' },
				{
					lastEventId: 'c-1_x',
					method: 'GET',
					path: 'notices/stream',
					query: '',
				},
				{
					lastEventId: undefined,
					method: 'GET',
					path: 'notices',
					query: 'head=true&nonce=n0',
				},
			],
		);
		assert.ok(recording.requests().every(({ startedAt }) => startedAt >= before));
		assert.deepEqual(
			server.requests.map(({ method, target }) => `${method} ${target}`),
			['POST /usher/exchange', 'GET /usher/notices/stream', 'GET /usher/notices?head=true&nonce=n0'],
		);
	});

	test("records each request's body, cut at its limit, each answer's status and arrival, and a request that failed", async (context) => {
		const scope = cleanupFor(context);
		const server = await startRecordingServer(({ target }) => ({
			status: target.endsWith('/exchange') ? 403 : 204,
		}));
		scope.defer(() => server.stop());
		const recording = createRecordingFetch(server.url);
		scope.defer(() => recording.close());
		const init = {
			headers: {},
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(2000),
		} as const;
		const signedIn = JSON.stringify({
			credential: 'a.b.c',
			payloadVersions: [1],
		});
		const anonymous = JSON.stringify({ payloadVersions: [1] });
		const long = 'x'.repeat(RECORDED_BODY_CHARACTERS + 10);
		const sentAt = performance.now();

		await recording.fetch(new URL('exchange', server.url), {
			...init,
			body: signedIn,
		});
		await recording.fetch(new URL('exchange', server.url), {
			...init,
			body: anonymous,
		});
		await recording.fetch(new URL('other', server.url), {
			...init,
			body: long,
		});
		const failed = await recording
			.fetch(new URL('exchange', 'http://127.0.0.1:9/'), {
				...init,
				body: signedIn,
			})
			.then(
				() => 'answered',
				() => 'failed',
			);
		const [first, second, third, fourth] = recording.requests();

		assert.equal(failed, 'failed');
		assert.deepEqual(
			[first, second, third].map((request) => request?.answer?.status),
			[403, 403, 204],
		);
		assert.ok(
			[first, second, third].every(
				(request) =>
					request !== undefined &&
					request.answer !== undefined &&
					request.answer.arrivedAt >= request.startedAt &&
					request.startedAt >= sentAt &&
					request.answer.poll === undefined,
			),
		);
		assert.equal(first?.body, signedIn);
		assert.equal(third?.body?.length, RECORDED_BODY_CHARACTERS);
		assert.deepEqual(
			recording.requests().map((request) => exchangedCredentialOf(request)),
			['a.b.c', null, undefined, undefined],
		);
		assert.equal(fourth?.answer, undefined);
		assert.ok((fourth?.failedAt ?? 0) >= (fourth?.startedAt ?? Infinity));
	});
});

suite("a bridge's checks, observed", () => {
	test("reads each poll's next and more under the application key, and times a check from its first page", async (context) => {
		const scope = cleanupFor(context);
		const controller = await startRecordingServer(pagedController);
		scope.defer(() => controller.stop());
		const bridge = await startBridge({
			application: APPLICATION,
			controllerUrl: controller.url,
			issuer: ISSUER,
			profile: 'compressed',
		});
		scope.defer(() => bridge.stop());

		await eventually(
			() =>
				Promise.resolve(
					requestsTo(bridge, 'notices').some((poll) => isHeadPoll(poll) && poll.answer?.poll !== undefined),
				),
			5000,
			10,
		);
		const start = await settledPollStart(bridge);
		const polls = requestsTo(bridge, 'notices');
		const index = polls.findIndex(({ startedAt }) => startedAt === start);
		const [first, second] = polls.slice(index);

		assert.ok(first !== undefined && second !== undefined);
		assert.equal(afterCursorOf(first), 'c-1');
		assert.deepEqual(first.answer?.poll, { more: true, next: 'c-2' });
		assert.equal(afterCursorOf(second), 'c-2');
		assert.deepEqual(second.answer?.poll, { more: false, next: 'c-1' });
		assert.ok(second.startedAt >= (first.answer?.arrivedAt ?? Infinity));
		assert.ok(polls.filter(isHeadPoll).every(({ answer }) => answer?.poll?.next === 'c-1'));
	});

	test('fails naming why when the first check from now fails', async (context) => {
		const scope = cleanupFor(context);
		const controller = await startRecordingServer(() => ({
			body: 'unavailable',
			status: 503,
		}));
		scope.defer(() => controller.stop());
		const bridge = await startBridge({
			application: APPLICATION,
			controllerUrl: controller.url,
			issuer: ISSUER,
			profile: 'compressed',
		});
		scope.defer(() => bridge.stop());

		await assert.rejects(settledPollStart(bridge), {
			message: "the bridge's first check from now failed: a page was answered 503",
		});
	});

	test('reads no principal and reaches no record through an outcome the controller left unavailable', async (context) => {
		const scope = cleanupFor(context);
		const controller = await startRecordingServer(() => ({
			body: 'unavailable',
			status: 503,
		}));
		scope.defer(() => controller.stop());
		const bridge = await startBridge({
			application: APPLICATION,
			controllerUrl: controller.url,
			issuer: ISSUER,
			profile: 'compressed',
		});
		scope.defer(() => bridge.stop());

		const outcome = await bridge.core.resolve(null);

		assert.notEqual(outcome.kind, 'access');
		assert.equal(principalOf(outcome), undefined);
		assert.equal(reaches(outcome, { data_category: 'controlled', study_id: 'STUDY-A1' }), false);
	});
});

suite('the recording logger', () => {
	test('records each event with its arrival, its level, its name and its data, and waits for one', async () => {
		const recording = createRecordingLogger();
		const before = performance.now();

		recording.logger.warn(
			{
				data: { actorId: null, actorType: 'system', cause: 'network' },
				type: 'bio.overture.revocationChannel.failure',
			},
			'bio.overture.revocationChannel.failure',
		);
		const arriving = recording.nextEvent('revocationChannel.modeChange', {
			timeoutMs: 1000,
		});
		setTimeout(() => {
			recording.logger.info(
				{
					data: { mode: 'normal' },
					type: 'bio.overture.revocationChannel.modeChange',
				},
				'bio.overture.revocationChannel.modeChange',
			);
		}, 50);
		const arrived = await arriving;

		assert.deepEqual(
			recording.events().map(({ data, level, name }) => ({ data, level, name })),
			[
				{
					data: { actorId: null, actorType: 'system', cause: 'network' },
					level: 'warn',
					name: 'revocationChannel.failure',
				},
				{
					data: { mode: 'normal' },
					level: 'info',
					name: 'revocationChannel.modeChange',
				},
			],
		);
		assert.ok(arrived.arrivedAt >= before);
		await assert.rejects(recording.nextEvent('revocationChannel.reset', { timeoutMs: 100 }), {
			message: 'the bridge logged no revocationChannel.reset within 100 ms',
		});
	});
});

suite('a bridge started against a controller', () => {
	for (const profile of ['compressed', 'ims'] as const satisfies readonly TimingProfileName[]) {
		test(`starts on the ${profile} profile, reaching the controller through the recording fetch and staying cold while it answers 503`, async (context) => {
			const scope = cleanupFor(context);
			const controller = await startRecordingServer(() => ({
				body: 'unavailable',
				status: 503,
			}));
			scope.defer(() => controller.stop());

			const bridge = await startBridge({
				application: APPLICATION,
				controllerUrl: controller.url,
				issuer: ISSUER,
				profile,
				timing: { exchangeTimeoutMs: 3000 },
			});
			scope.defer(() => bridge.stop());
			await eventually(
				() => Promise.resolve(bridge.fetch.requests().some(({ path }) => path === 'notices')),
				5000,
				10,
			);
			const served = await fetch(bridge.url);

			assert.equal(bridge.core.mode(), 'cold');
			assert.equal(served.status, 503);
			assert.ok(bridge.fetch.requests().some(({ method, path }) => method === 'POST' && path === 'exchange'));
			assert.ok(
				bridge.fetch.requests().some(({ path, query }) => path === 'notices' && query.startsWith('head=true')),
			);
			assert.equal(bridge.logger.events('bridge.startRefusal').length, 0);
			assert.ok(bridge.logger.events().length > 0);
			assert.deepEqual(bridge.timing, {
				...resolvedBridgeTiming(profile),
				exchangeTimeoutMs: 3000,
			});
		});
	}
});
