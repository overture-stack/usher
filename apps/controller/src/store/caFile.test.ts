import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';

import { CA_FILE_CHANGED, CA_FILE_UNREADABLE, readCaFile } from './caFile.js';
import type { StoreLineFields } from './types.js';

const ISSUED = '-----BEGIN CERTIFICATE-----\nissued\n-----END CERTIFICATE-----\n';

const REISSUED = '-----BEGIN CERTIFICATE-----\nreissued\n-----END CERTIFICATE-----\n';

interface Line {
	fields: StoreLineFields;
	level: 'error' | 'warning';
	message: string;
}

interface CaFileStand {
	lines: Line[];
	path: string;
}

const caFileIn = async (context: TestContext): Promise<CaFileStand> => {
	const folder = await mkdtemp(join(tmpdir(), 'usher-ca-'));
	context.after(() => rm(folder, { force: true, recursive: true }));
	const path = join(folder, 'root.crt');
	await writeFile(path, ISSUED);
	return { lines: [], path };
};

const logInto = (lines: Line[]) => ({
	error: (message: string, fields: StoreLineFields) => {
		lines.push({ fields, level: 'error', message });
	},
	warning: (message: string, fields: StoreLineFields) => {
		lines.push({ fields, level: 'warning', message });
	},
});

const VARIABLE = 'USHER_DATABASE_URL';

suite('the CA file a database URL names, read for each connection', () => {
	test("gives the file's contents each time it is read, writing nothing while they stay the same", async (context) => {
		const { lines, path } = await caFileIn(context);
		const caFile = readCaFile(path, {
			log: logInto(lines),
			variable: VARIABLE,
		});

		const reads = [caFile(), caFile()];

		assert.deepEqual(reads, [ISSUED, ISSUED]);
		assert.deepEqual(lines, []);
	});

	test('gives a reissued certificate at the next read, writing one line at warning naming the variable for the change', async (context) => {
		const { lines, path } = await caFileIn(context);
		const caFile = readCaFile(path, {
			log: logInto(lines),
			variable: VARIABLE,
		});
		caFile();

		await writeFile(path, REISSUED);
		const reads = [caFile(), caFile()];

		assert.deepEqual(reads, [REISSUED, REISSUED]);
		assert.deepEqual(lines, [
			{
				fields: { variable: VARIABLE },
				level: 'warning',
				message: CA_FILE_CHANGED,
			},
		]);
		assert.equal(CA_FILE_CHANGED, 'store.caFileChanged');
	});

	test('trusts no certificate while the file cannot be read, writing one line at error naming the variable and the failure by its code', async (context) => {
		const { lines, path } = await caFileIn(context);
		const caFile = readCaFile(path, {
			log: logInto(lines),
			variable: VARIABLE,
		});
		caFile();

		await rm(path);
		const reads = [caFile(), caFile(), caFile()];

		assert.deepEqual(reads, [[], [], []]);
		assert.deepEqual(lines, [
			{
				fields: { code: 'ENOENT', variable: VARIABLE },
				level: 'error',
				message: CA_FILE_UNREADABLE,
			},
		]);
		assert.equal(CA_FILE_UNREADABLE, 'store.caFileUnreadable');
	});

	test('trusts no certificate from a file it may not read', async (context) => {
		const { lines, path } = await caFileIn(context);
		const caFile = readCaFile(path, {
			log: logInto(lines),
			variable: VARIABLE,
		});
		caFile();

		// A process running as the superuser reads a file whatever its mode.
		if (process.getuid?.() === 0) {
			context.skip('the superuser reads a file whatever its mode');
			return;
		}
		await chmod(path, 0o000);
		const read = caFile();

		assert.deepEqual(read, []);
		assert.deepEqual(
			lines.map(({ fields, message }) => ({ fields, message })),
			[
				{
					fields: { code: 'EACCES', variable: VARIABLE },
					message: CA_FILE_UNREADABLE,
				},
			],
		);
	});

	test('gives the file again once it can be read, writing one line for the change', async (context) => {
		const { lines, path } = await caFileIn(context);
		const caFile = readCaFile(path, {
			log: logInto(lines),
			variable: VARIABLE,
		});
		caFile();
		await rm(path);
		caFile();

		await writeFile(path, REISSUED);
		const read = caFile();

		assert.equal(read, REISSUED);
		assert.deepEqual(
			lines.map(({ message }) => message),
			[CA_FILE_UNREADABLE, CA_FILE_CHANGED],
		);
	});

	test('takes its first read as the file the start read, writing a line only when that read fails', async (context) => {
		const { lines, path } = await caFileIn(context);
		const found = readCaFile(path, { log: logInto(lines), variable: VARIABLE });
		const missing = readCaFile(`${path}.missing`, {
			log: logInto(lines),
			variable: VARIABLE,
		});

		const reads = [found(), missing()];

		assert.deepEqual(reads, [ISSUED, []]);
		assert.deepEqual(
			lines.map(({ message }) => message),
			[CA_FILE_UNREADABLE],
		);
	});
});
