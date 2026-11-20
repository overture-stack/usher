import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { PEOPLE } from './exchange.js';
import { type Harness, type HarnessApplication, startHarness } from './harness.js';
import { STARTUP_BOUND_MS } from './integration.js';
import { cleanupFor, eventually } from './waiting.js';
import { startBridge, subjectInForce, TIMING_PROFILES } from './vendoredBridge.js';
import { startWorkerBridge, type WorkerBridgeStart } from './workerBridge.js';

const PORTAL = 'Rotating portal';

const SIGN_IN_SECONDS = 3_600;

// The Bridge's one-per-audience refusal. The package's index does not export its rule table, so the
// message is matched as the core states it.
const AUDIENCE_IN_USE = /one bridge serves an audience in a process/;

const startOn = (harness: Harness, application: HarnessApplication): WorkerBridgeStart => ({
	application,
	controllerUrl: harness.url,
	issuer: harness.configuration.issuer,
	profile: 'compressed',
});

suite('a bridge hosted in a worker thread', () => {
	test('reaches normal mode against a harness and resolves a credential', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startHarness({
			applications: [PORTAL],
			configuration: TIMING_PROFILES.compressed.controller,
		});
		scope.defer(() => harness.stop());
		const portal = harness.application(PORTAL);

		const bridge = await startWorkerBridge(scope, startOn(harness, portal));
		const normal = await eventually(async () => (await bridge.core.mode()) === 'normal', STARTUP_BOUND_MS);
		const credential = await harness.tokens.signIn(PEOPLE.ana, {
			application: PORTAL,
			mint: { lifetimeSeconds: SIGN_IN_SECONDS },
		});

		assert.equal(normal, true);
		assert.equal(subjectInForce(await bridge.core.resolve(credential)), PEOPLE.ana.subject);
	});

	test('lets a second bridge for the same application start in the main thread beside it', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startHarness({
			applications: [PORTAL],
			configuration: TIMING_PROFILES.compressed.controller,
		});
		scope.defer(() => harness.stop());
		const portal = harness.application(PORTAL);
		const credential = await harness.tokens.signIn(PEOPLE.ana, {
			application: PORTAL,
			mint: { lifetimeSeconds: SIGN_IN_SECONDS },
		});

		const hosted = await startWorkerBridge(scope, startOn(harness, portal));
		const inThread = await startBridge({
			application: portal,
			controllerUrl: harness.url,
			issuer: harness.configuration.issuer,
			profile: 'compressed',
		});
		scope.defer(() => inThread.stop());

		assert.equal(subjectInForce(await hosted.core.resolve(credential)), PEOPLE.ana.subject);
		assert.equal(subjectInForce(await inThread.core.resolve(credential)), PEOPLE.ana.subject);
	});

	test('still refuses a second bridge for the same application in one thread', async (context) => {
		const scope = cleanupFor(context);
		const harness = await startHarness({
			applications: [PORTAL],
			configuration: TIMING_PROFILES.compressed.controller,
		});
		scope.defer(() => harness.stop());
		const portal = harness.application(PORTAL);
		const first = await startBridge({
			application: portal,
			controllerUrl: harness.url,
			issuer: harness.configuration.issuer,
			profile: 'compressed',
		});
		scope.defer(() => first.stop());

		await assert.rejects(
			startBridge({
				application: portal,
				controllerUrl: harness.url,
				issuer: harness.configuration.issuer,
				profile: 'compressed',
			}),
			AUDIENCE_IN_USE,
		);
	});
});
