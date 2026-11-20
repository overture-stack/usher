import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import {
	administratorCaller,
	APPLICATION_KEY_REVOCATION_REASONS,
	assertSucceeded,
	postBackChannelLogout,
	revokeApplicationKey,
} from '../../../testing/harness/admin.js';
import { RELAYED_PATHS } from '../../../testing/harness/containers.js';
import { type ControllerApplication, HARNESS_STORE_TIMEOUT_MILLISECONDS } from '../../../testing/harness/controller.js';
import { PEOPLE } from '../../../testing/harness/exchange.js';
import { issued } from '../../../testing/fixtures/applications.js';
import { logoutTokenFor } from '../../../testing/fixtures/channel.js';
import { DELIVERY_BOUND_MS, STARTUP_BOUND_MS } from '../../../testing/harness/integration.js';
import { type Harness, type HarnessApplication, startHarness } from '../../../testing/harness/harness.js';
import {
	eventsSince,
	INTERVAL_JITTER,
	nextNotice,
	type RecordedBridgeRequest,
	type RecordedPollPage,
	requestsTo,
	SCHEDULING_SLACK_MS,
	startBridge,
	type StartedBridge,
	subjectInForce,
	TIMING_PROFILES,
	untilMode,
} from '../../../testing/harness/vendoredBridge.js';
import { type BridgeHandle, startWorkerBridge } from '../../../testing/harness/workerBridge.js';
import { type Cleanup, cleanupFor, eventually } from '../../../testing/harness/waiting.js';

const PORTAL = 'Rotating portal';

const SIGN_IN_SECONDS = 3_600;

/**
 * A harness serving one application with two live keys, and a bridge on each key. The bridge on the new
 * key runs in a worker thread: a Bridge refuses a second one for an audience in its own thread, and the
 * worker has a thread of its own. Both are read through the same handle.
 */
interface TwoBridges {
	harness: Harness;
	onNewKey: BridgeHandle;
	onOldKey: BridgeHandle;

	/** The application, with its first key: the old one. */
	portal: HarnessApplication;
}

const startBridgeOn = async (
	scope: Cleanup,
	harness: Harness,
	application: ControllerApplication,
): Promise<StartedBridge> => {
	const bridge = await startBridge({
		application,
		controllerUrl: harness.url,
		issuer: harness.configuration.issuer,
		profile: 'compressed',
	});
	scope.defer(() => bridge.stop());
	await untilMode(bridge, 'normal', STARTUP_BOUND_MS);
	return bridge;
};

const startWorkerBridgeOn = async (
	scope: Cleanup,
	harness: Harness,
	application: ControllerApplication,
): Promise<BridgeHandle> => {
	const bridge = await startWorkerBridge(scope, {
		application,
		controllerUrl: harness.url,
		issuer: harness.configuration.issuer,
		profile: 'compressed',
	});
	if (!(await eventually(async () => (await bridge.core.mode()) === 'normal', STARTUP_BOUND_MS))) {
		throw new Error(`the bridge was not normal within ${STARTUP_BOUND_MS} ms`);
	}
	return bridge;
};

// A bridge on this thread, read through the handle a worker-hosted one is read through.
const handleOf = (bridge: StartedBridge): BridgeHandle => ({
	appliedNotices: async (kind, since = 0) =>
		eventsSince(bridge, 'notice.applied', since).filter(({ data }) => data['kind'] === kind),
	core: {
		mode: async () => bridge.core.mode(),
		resolve: (credential) => bridge.core.resolve(credential),
	},
	nextNotice: (kind, since, timeoutMs) => nextNotice(bridge, kind, since, timeoutMs),
	requests: async (path, since = 0) => requestsTo(bridge, path, since),
	stop: () => bridge.stop(),
	timing: bridge.timing,
});

// Both bridges reach the controller directly: the instance answering the issue and the revocation.
const startTwoBridges = async (scope: Cleanup): Promise<TwoBridges> => {
	const harness = await startHarness({
		applications: [PORTAL],
		// A whole start runs within the store timeout, and the profile's 250 ms is too short for a loaded
		// start. This suite never pauses the store, so the harness's own timeout costs it nothing.
		configuration: {
			...TIMING_PROFILES.compressed.controller,
			storeTimeoutMilliseconds: HARNESS_STORE_TIMEOUT_MILLISECONDS,
		},
	});
	scope.defer(() => harness.stop());
	const portal = harness.application(PORTAL);
	const newKey = await issued(await administratorCaller(harness), portal.id);
	const onOldKey = handleOf(await startBridgeOn(scope, harness, portal));
	const onNewKey = await startWorkerBridgeOn(scope, harness, {
		id: portal.id,
		key: newKey.value,
	});
	return { harness, onNewKey, onOldKey, portal };
};

// The page of each poll answered 200, once read by the recording fetch under the bridge's own key:
// `null` for a page refused by the bridge's channel reader.
const pagesRead = async (bridge: BridgeHandle, since?: number): Promise<readonly (RecordedPollPage | null)[]> =>
	(await bridge.requests(RELAYED_PATHS.notices, since)).flatMap(({ answer }) =>
		answer?.status === 200 && answer.poll !== undefined ? [answer.poll] : [],
	);

const answeredStatuses = (requests: readonly RecordedBridgeRequest[]): readonly number[] =>
	requests.flatMap(({ answer }) => (answer === undefined ? [] : [answer.status]));

const pollWithinMs = (bridge: BridgeHandle): number =>
	(1 + INTERVAL_JITTER) * bridge.timing.pollIntervalMs + bridge.timing.pollDeadlineMs + SCHEDULING_SLACK_MS;

suite('an application holding two live keys', () => {
	test('serves a bridge on the old key and a bridge on the new key alike, each reading the tokens and notices answered to it', async (context) => {
		const scope = cleanupFor(context);
		const { harness, onNewKey, onOldKey } = await startTwoBridges(scope);
		const bridges = [onOldKey, onNewKey];
		const credential = await harness.tokens.signIn(PEOPLE.ana, {
			application: PORTAL,
			mint: { lifetimeSeconds: SIGN_IN_SECONDS },
		});

		const subjects = await Promise.all(
			bridges.map(async (bridge) => subjectInForce(await bridge.core.resolve(credential))),
		);
		const sentAt = performance.now();
		assertSucceeded(
			await postBackChannelLogout(harness.url, await logoutTokenFor(harness, PEOPLE.ana)),
			"Ana's sign-out",
		);
		const applied = await Promise.all(
			bridges.map((bridge) => bridge.nextNotice('principal', sentAt, DELIVERY_BOUND_MS + SCHEDULING_SLACK_MS)),
		);
		const read = await Promise.all(
			bridges.map((bridge) => eventually(async () => (await pagesRead(bridge)).length > 0, pollWithinMs(bridge))),
		);

		assert.deepEqual(subjects, [PEOPLE.ana.subject, PEOPLE.ana.subject]);
		assert.equal(applied.length, 2);
		assert.deepEqual(read, [true, true]);
		for (const [index, bridge] of bridges.entries()) {
			const label = `the bridge on key ${index + 1}`;
			assert.equal((await pagesRead(bridge)).includes(null), false, label);
			assert.ok(
				answeredStatuses(await bridge.requests(RELAYED_PATHS.exchange)).every((status) => status === 200),
				label,
			);
		}
	});

	test('refuses the bridge on the old key once that key is revoked, serving the bridge on the new key on', async (context) => {
		const scope = cleanupFor(context);
		const { harness, onNewKey, onOldKey, portal } = await startTwoBridges(scope);
		const credential = await harness.tokens.signIn(PEOPLE.bo, {
			application: PORTAL,
			mint: { lifetimeSeconds: SIGN_IN_SECONDS },
		});

		assertSucceeded(
			await revokeApplicationKey(await administratorCaller(harness), portal.id, portal.keyId, {
				reason: APPLICATION_KEY_REVOCATION_REASONS.rotated,
			}),
			'revoking the old key',
		);
		const revokedAt = performance.now();
		const onOld = subjectInForce(await onOldKey.core.resolve(credential));
		const onNew = subjectInForce(await onNewKey.core.resolve(credential));
		const polled = await Promise.all([
			eventually(
				async () => answeredStatuses(await onOldKey.requests(RELAYED_PATHS.notices, revokedAt)).length > 0,
				pollWithinMs(onOldKey),
			),
			eventually(async () => (await pagesRead(onNewKey, revokedAt)).length > 0, pollWithinMs(onNewKey)),
		]);
		const oldAnswered = async (path: string): Promise<readonly number[]> =>
			answeredStatuses(await onOldKey.requests(path, revokedAt));

		assert.notEqual(onOld, PEOPLE.bo.subject);
		assert.equal(onNew, PEOPLE.bo.subject);
		assert.deepEqual(polled, [true, true]);
		assert.ok((await oldAnswered(RELAYED_PATHS.exchange)).length > 0);
		for (const path of [RELAYED_PATHS.exchange, RELAYED_PATHS.notices]) {
			assert.ok(
				(await oldAnswered(path)).every((status) => status === 401),
				`the old key's ${path} after the revocation`,
			);
		}
		assert.equal((await pagesRead(onNewKey, revokedAt)).includes(null), false);
	});
});
