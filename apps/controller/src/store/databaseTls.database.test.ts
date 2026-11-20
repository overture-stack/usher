import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'node:test';

import pg from 'pg';

import { readReadiness } from '../../testing/harness/admin.js';
import { startTlsPostgresql } from '../../testing/harness/containers.js';
import { captureLog } from '../../testing/harness/controller.js';
import { DATABASE_ROLES } from '../../testing/harness/database.js';
import { selectRows } from '../../testing/fixtures/database.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { cleanupFor, eventually } from '../../testing/harness/waiting.js';

// The lines the Controller writes as the CA file it verifies its store against changes.
const CA_FILE_LINES = Object.freeze({
	changed: 'store.caFileChanged',
	unreadable: 'store.caFileUnreadable',
});

// How long a change of the store's connections takes to show: a readiness probe's answer is reused
// for a second, and a connection refused or failing its handshake fails within the store timeout.
const SETTLES_WITHIN_MS = 15_000;

const withSuperuser = async <Result>(
	superuserUrl: string,
	work: (client: pg.Client) => Promise<Result>,
): Promise<Result> => {
	const client = new pg.Client({ connectionString: superuserUrl });
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
};

// The server process of each connection the runtime role holds over TLS: the Controller's alone,
// since the harness's own connections under that role never use TLS.
const controllerConnections = (superuserUrl: string): Promise<readonly number[]> =>
	withSuperuser(superuserUrl, async (client) =>
		(
			await selectRows<{ pid: number }>(
				client,
				'SELECT pid FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE usename = $1 AND ssl',
				[DATABASE_ROLES.runtime],
			)
		).map(({ pid }) => pid),
	);

// Ends every connection the Controller holds, so each query it makes next opens a new one, giving the
// server processes ended.
const endControllerConnections = async (superuserUrl: string): Promise<readonly number[]> => {
	const ended = await controllerConnections(superuserUrl);
	await withSuperuser(superuserUrl, (client) =>
		client.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) pid', [ended]),
	);
	return ended;
};

// Whether the Controller holds a connection over TLS opened since the ones given ended.
const reconnects = (superuserUrl: string, ended: readonly number[]): Promise<boolean> =>
	eventually(
		async () => (await controllerConnections(superuserUrl)).some((pid) => !ended.includes(pid)),
		SETTLES_WITHIN_MS,
		200,
	);

const readinessBecomes = (harness: Harness, status: number): Promise<boolean> =>
	eventually(async () => (await readReadiness(harness.url)).status === status, SETTLES_WITHIN_MS, 200);

const linesNamed = (lines: readonly string[], message: string): number =>
	lines.filter((line) => {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'message') === message;
	}).length;

suite("the database's CA file, read again as each connection opens", () => {
	test("takes a reissued CA certificate at the next connection, fails every connection while the file names a CA the server's certificate does not chain to or cannot be read, writes each change once, and connects again once the file names the CA", async (context) => {
		const scope = cleanupFor(context);
		const { certificates, postgresql } = await startTlsPostgresql();
		scope.defer(() => postgresql.remove());
		const folder = await mkdtemp(join(tmpdir(), 'usher-database-tls-'));
		scope.defer(() => rm(folder, { force: true, recursive: true }));
		const caFile = join(folder, 'root.crt');
		await writeFile(caFile, certificates.issued);
		const superuserUrl = postgresql.container.url;
		const log = captureLog();

		await withHarness(
			{
				applications: [],
				configuration: { logStream: log.stream },
				postgresql,
				startsController: false,
			},
			async (harness) => {
				const verifying = new URL(harness.configuration.databaseUrl);
				verifying.searchParams.set('sslmode', 'verify-full');
				verifying.searchParams.set('sslrootcert', caFile);
				await harness.startController({ databaseUrl: verifying.href });
				const readyAtStart = await readinessBecomes(harness, 200);
				const connectedAtStart = (await controllerConnections(superuserUrl)).length > 0;

				await writeFile(caFile, certificates.reissued);
				const reconnectedOnReissued = await reconnects(
					superuserUrl,
					await endControllerConnections(superuserUrl),
				);
				const readyOnReissued = await readinessBecomes(harness, 200);
				const changedOnReissued = linesNamed(log.lines(), CA_FILE_LINES.changed);

				await writeFile(caFile, certificates.unrelated);
				await endControllerConnections(superuserUrl);
				const unreadyOnUnrelated = await readinessBecomes(harness, 503);
				const heldOnUnrelated = await controllerConnections(superuserUrl);

				await rm(caFile);
				const unreadyWhileUnreadable = await readinessBecomes(harness, 503);
				// Several connections are tried meanwhile, each failing on the file it cannot read.
				const readyWhileUnreadable = await eventually(
					async () => (await readReadiness(harness.url)).status === 200,
					3000,
					200,
				);
				const heldWhileUnreadable = await controllerConnections(superuserUrl);

				await writeFile(caFile, certificates.issued);
				const readyAgain = await readinessBecomes(harness, 200);
				const lines = log.lines();

				assert.deepEqual(
					{
						changedOnReissued,
						connectedAtStart,
						heldOnUnrelated,
						heldWhileUnreadable,
						readyAgain,
						readyAtStart,
						readyOnReissued,
						readyWhileUnreadable,
						reconnectedOnReissued,
						unreadyOnUnrelated,
						unreadyWhileUnreadable,
					},
					{
						changedOnReissued: 1,
						connectedAtStart: true,
						heldOnUnrelated: [],
						heldWhileUnreadable: [],
						readyAgain: true,
						readyAtStart: true,
						readyOnReissued: true,
						readyWhileUnreadable: false,
						reconnectedOnReissued: true,
						unreadyOnUnrelated: true,
						unreadyWhileUnreadable: true,
					},
				);
				assert.deepEqual(
					{
						changed: linesNamed(lines, CA_FILE_LINES.changed),
						unreadable: linesNamed(lines, CA_FILE_LINES.unreadable),
					},
					{ changed: 3, unreadable: 1 },
				);
				assert.equal(
					lines.some((line) => line.includes(caFile)),
					false,
				);
			},
			context,
		);
	});
});
