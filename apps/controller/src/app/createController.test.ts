import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect, createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { suite, test } from 'node:test';

import { type ControllerConfiguration, ENVIRONMENT_VARIABLES, readConfiguration } from '../configuration/index.js';
import { CONTROLLER_STARTED, createController } from './createController.js';

const LOOPBACK = '127.0.0.1';

// A port nothing listens on at the moment of asking.
const unusedPort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.once('error', reject);
		server.listen(0, LOOPBACK, () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});

const acceptsConnection = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = connect({ host: LOOPBACK, port });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => {
			socket.destroy();
			resolve(false);
		});
	});

// A configuration whose store nothing answers for: every start fails at its first connection.
const unreachableStore = async (): Promise<ControllerConfiguration> =>
	readConfiguration({
		[ENVIRONMENT_VARIABLES.backChannelLogoutAudiences]: 'portal-test',
		[ENVIRONMENT_VARIABLES.cursorKey]: randomBytes(32).toString('base64url'),
		[ENVIRONMENT_VARIABLES.databasePassword]: randomBytes(12).toString('hex'),
		[ENVIRONMENT_VARIABLES.databaseSchema]: 'usher',
		[ENVIRONMENT_VARIABLES.databaseUrl]: `postgres://usher_controller@${LOOPBACK}:${await unusedPort()}/usher`,
		[ENVIRONMENT_VARIABLES.host]: LOOPBACK,
		[ENVIRONMENT_VARIABLES.identityProviderIssuer]: 'http://127.0.0.1:8080/realms/usher-test',
		[ENVIRONMENT_VARIABLES.instanceName]: 'usher-test-1',
		[ENVIRONMENT_VARIABLES.keyEncryptionKey]: randomBytes(32).toString('base64url'),
		[ENVIRONMENT_VARIABLES.managementAudience]: 'usher-management-test',
		[ENVIRONMENT_VARIABLES.managementClients]: 'usher-ui-test',
		[ENVIRONMENT_VARIABLES.port]: String(await unusedPort()),
	});

suite('a controller', () => {
	test('settles a stop when it never started, and settles it again', async () => {
		const controller = createController(await unreachableStore());

		await controller.stop();
		await controller.stop();
	});

	test('refuses a start once stopped', async () => {
		const controller = createController(await unreachableStore());
		await controller.stop();

		await assert.rejects(controller.start(), {
			message: 'a controller starts once, and never once stopped',
		});
	});

	test('refuses a start where nothing accepts connections at its store, naming the database URL, before anything listens, and stops after it', async () => {
		const configuration = await unreachableStore();
		const controller = createController(configuration);

		await assert.rejects(controller.start(), {
			message:
				'the controller refuses to start: USHER_DATABASE_URL names an address at which no store accepts connections',
			name: 'StartRefusal',
			variables: ['USHER_DATABASE_URL'],
		});
		const listening = await acceptsConnection(configuration.port);
		await controller.stop();

		assert.equal(listening, false);
	});

	test('refuses a start on a store whose host does not resolve, naming the database URL and not the host', async () => {
		const configuration = {
			...(await unreachableStore()),
			databaseUrl: 'postgres://usher_controller@usher-store.invalid/usher',
		};
		const controller = createController(configuration);

		const refusal = await controller.start().catch((failure: unknown) => failure);
		await controller.stop();

		assert.ok(refusal instanceof Error);
		assert.equal(
			refusal.message,
			'the controller refuses to start: USHER_DATABASE_URL names a host that does not resolve',
		);
	});
});

suite("a controller's start allowing an unverified database connection", () => {
	// A log stream keeping each line it is written, parsed.
	const capturedLog = (): {
		lines: Readonly<Record<string, unknown>>[];
		logStream: Writable;
	} => {
		const lines: Readonly<Record<string, unknown>>[] = [];
		const logStream = new Writable({
			write: (chunk: Buffer, _encoding, done) => {
				chunk
					.toString('utf8')
					.split('\n')
					.filter((line) => line !== '')
					.forEach((line) => {
						lines.push(JSON.parse(line) as Readonly<Record<string, unknown>>);
					});
				done();
			},
		});
		return { lines, logStream };
	};

	test('writes one line at warning naming USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION at each start allowing it, before its store is reached, and none at a start not allowing it', async () => {
		const starts = await Promise.all(
			[true, false].map(async (databaseAllowUnverifiedConnection) => {
				const { lines, logStream } = capturedLog();
				const controller = createController({
					...(await unreachableStore()),
					databaseAllowUnverifiedConnection,
					logStream,
				});
				await controller.start().catch(() => undefined);
				await controller.stop();
				return lines
					.filter(({ message }) => message === 'store.unverifiedConnectionAllowed')
					.map(({ level, variable }) => ({ level, variable }));
			}),
		);

		assert.deepEqual(starts, [[{ level: 40, variable: 'USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION' }], []]);
	});
});

suite("a controller's refused start logging no controller.started", () => {
	test('logs no controller.started line, the refusal coming before anything listens', async () => {
		const lines: string[] = [];
		const logStream = new Writable({
			write: (chunk: unknown, _encoding, done) => {
				lines.push(String(chunk));
				done();
			},
		});
		const controller = createController({ ...(await unreachableStore()), logStream });

		await assert.rejects(controller.start(), { name: 'StartRefusal' });
		await controller.stop();

		const messages = lines
			.join('')
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => (JSON.parse(line) as { message?: unknown }).message);
		assert.equal(messages.includes(CONTROLLER_STARTED), false);
	});
});
