import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { auditRows, emittedType, jsonObjectOf } from '../../testing/harness/auditEvents.js';
import { captureLog, type LogCapture } from '../../testing/harness/controller.js';
import { type Harness, startHarness, startReadOnlyInstance } from '../../testing/harness/harness.js';
import { cleanupFor, eventually } from '../../testing/harness/waiting.js';
import { CONTROLLER_STARTED } from '../app/createController.js';

// pino's level for info, which the start's line is written at.
const INFO_LEVEL = 30;

// The start's lines in a log stream, each parsed, from a mark on.
const startLinesIn = (log: LogCapture, since: number = 0): readonly Readonly<Record<string, unknown>>[] =>
	log
		.lines()
		.slice(since)
		.map(jsonObjectOf)
		.filter((line) => line.message === CONTROLLER_STARTED);

// Waits until the log holds a start's line for an instance, and gives the start's lines.
const awaitStartLines = async (
	log: LogCapture,
	instance: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
	await eventually(async () => startLinesIn(log).some((line) => line.instance === instance), 10_000);
	return startLinesIn(log);
};

// Every audit row of the start's event type, which the start must never write.
const startRows = async (harness: Harness): Promise<number> =>
	(await auditRows(harness.clients.migration)).filter(({ type }) => type === emittedType(CONTROLLER_STARTED)).length;

suite("a controller's start logging controller.started", () => {
	test('writes exactly one controller.started line at info, naming the host, port and instance it listens on, no revision while none is set, and no audit row', async (context) => {
		const log = captureLog();
		const harness = await startHarness({
			applications: [],
			configuration: { logStream: log.stream },
		});
		cleanupFor(context).defer(() => harness.stop());

		const lines = await awaitStartLines(log, harness.configuration.instanceName);

		assert.equal(lines.length, 1);
		assert.deepEqual(lines[0], {
			host: harness.url.hostname,
			instance: harness.configuration.instanceName,
			level: INFO_LEVEL,
			message: CONTROLLER_STARTED,
			port: Number(harness.url.port),
			time: lines[0]?.time,
		});
		assert.equal(await startRows(harness), 0);
	});

	test('names the revision it runs in the start line while one is set', async (context) => {
		const log = captureLog();
		const revision = '6f976d8a0b1c2d3e4f5061728394a5b6c7d8e9f0';
		const harness = await startHarness({
			applications: [],
			configuration: { logStream: log.stream, revision },
		});
		cleanupFor(context).defer(() => harness.stop());

		const lines = await awaitStartLines(log, harness.configuration.instanceName);

		assert.deepEqual(
			lines.map((line) => line.revision),
			[revision],
		);
	});

	test('writes the start line under a role that may only read, naming its own instance', async (context) => {
		const log = captureLog();
		const harness = await startHarness({
			applications: [],
			configuration: { logStream: log.stream },
		});
		cleanupFor(context).defer(() => harness.stop());
		const reader = await startReadOnlyInstance(cleanupFor(context), harness);

		const lines = await awaitStartLines(log, reader.configuration.instanceName);

		assert.deepEqual(
			lines.map(({ host, instance, port }) => ({ host, instance, port })),
			[
				{
					host: harness.url.hostname,
					instance: harness.configuration.instanceName,
					port: Number(harness.url.port),
				},
				{
					host: reader.url.hostname,
					instance: reader.configuration.instanceName,
					port: Number(reader.url.port),
				},
			],
		);
	});
});
