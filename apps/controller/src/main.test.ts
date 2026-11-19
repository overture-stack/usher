import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

const LOOPBACK = '127.0.0.1';

interface Exit {
	code: number | null;
	stderr: string;
	stdout: string;
}

const unusedPort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, LOOPBACK, () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});

// Runs the process entry through tsx given exactly this environment, nothing inherited.
const runEntry = (environment: Readonly<Record<string, string>>): Promise<Exit> =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), ENTRY], {
			env: environment,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		// Bytes are joined before decoding, since a chunk may end inside a character.
		const output: { stderr: Buffer[]; stdout: Buffer[] } = {
			stderr: [],
			stdout: [],
		};
		child.stderr.on('data', (chunk: Buffer) => output.stderr.push(chunk));
		child.stdout.on('data', (chunk: Buffer) => output.stdout.push(chunk));
		child.once('error', reject);
		child.once('close', (code) =>
			resolve({
				code,
				stderr: Buffer.concat(output.stderr).toString('utf8'),
				stdout: Buffer.concat(output.stdout).toString('utf8'),
			}),
		);
	});

const validEnvironment = async (): Promise<Record<string, string>> => ({
	USHER_BACK_CHANNEL_LOGOUT_AUDIENCES: 'portal-test',
	USHER_CURSOR_KEY: randomBytes(32).toString('base64url'),
	USHER_DATABASE_PASSWORD: randomBytes(12).toString('hex'),
	USHER_DATABASE_SCHEMA: 'usher',
	USHER_DATABASE_URL: `postgres://usher_controller@${LOOPBACK}:${await unusedPort()}/usher`,
	USHER_HOST: LOOPBACK,
	USHER_IDENTITY_PROVIDER_ISSUER: 'http://127.0.0.1:8080/realms/usher-test',
	USHER_INSTANCE_NAME: 'usher-test-1',
	USHER_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
	USHER_MANAGEMENT_AUDIENCE: 'usher-management-test',
	USHER_MANAGEMENT_CLIENTS: 'usher-ui-test',
	USHER_PORT: String(await unusedPort()),
});

const linesOf = (text: string): readonly unknown[] =>
	text
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line): unknown => JSON.parse(line));

suite("the controller's process", () => {
	test('exits non-zero when its configuration is refused, writing one structured line naming the variable and never its value', async () => {
		const environment = await validEnvironment();
		const key = environment['USHER_KEY_ENCRYPTION_KEY'] ?? '';
		const padded = Buffer.from(key, 'base64url').toString('base64');

		const exit = await runEntry({
			...environment,
			USHER_KEY_ENCRYPTION_KEY: padded,
		});

		assert.equal(exit.code, 1);
		assert.equal(exit.stdout, '');
		assert.deepEqual(
			linesOf(exit.stderr).map((line) =>
				typeof line === 'object' && line !== null && 'variables' in line ? line.variables : line,
			),
			[['USHER_KEY_ENCRYPTION_KEY']],
		);
		[key, padded, environment['USHER_DATABASE_PASSWORD'] ?? ''].forEach((secret) =>
			assert.equal(exit.stderr.includes(secret), false),
		);
	});

	test("writes its refusal in the log stream's form, at the fatal level 60 with a message and a time", async () => {
		const environment = await validEnvironment();

		const exit = await runEntry({
			...environment,
			USHER_KEY_ENCRYPTION_KEY: 'too-short',
		});
		const [line] = linesOf(exit.stderr);

		assert.equal(exit.code, 1);
		assert.ok(typeof line === 'object' && line !== null);
		assert.deepEqual(Object.keys(line), ['level', 'variables', 'message', 'time']);
		assert.equal('level' in line ? line.level : undefined, 60);
		assert.equal('message' in line && typeof line.message === 'string', true);
	});

	test('refuses to start when nothing accepts connections where its store should be, writing one structured line naming the database URL and no secret', async () => {
		const environment = await validEnvironment();

		const exit = await runEntry(environment);

		assert.equal(exit.code, 1);
		assert.deepEqual(
			linesOf(exit.stderr).map((line) =>
				typeof line === 'object' && line !== null && 'variables' in line ? line.variables : line,
			),
			[['USHER_DATABASE_URL']],
		);
		assert.match(exit.stderr, /the controller refuses to start/u);
		assert.equal(exit.stderr.includes(environment['USHER_DATABASE_URL'] ?? ''), false);
		[environment['USHER_DATABASE_PASSWORD'] ?? '', environment['USHER_KEY_ENCRYPTION_KEY'] ?? ''].forEach(
			(secret) => assert.equal(exit.stderr.includes(secret), false),
		);
	});
});
