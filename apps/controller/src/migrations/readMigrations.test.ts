import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { readMigrations } from './readMigrations.js';

const folderHolding = async (context: TestContext, files: Readonly<Record<string, string>>): Promise<URL> => {
	const path = await mkdtemp(join(tmpdir(), 'usher-migrations-'));
	context.after(() => rm(path, { force: true, recursive: true }));
	await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(path, name), text)));
	return pathToFileURL(`${path}/`);
};

suite("reading the controller's migrations", () => {
	test('reads each file in the order its number gives, named without its extension, its checksum the SHA-256 of its bytes', async (context) => {
		const second = 'CREATE TABLE b (note text);\n';
		const folder = await folderHolding(context, {
			'0001_first_step.sql': 'CREATE TABLE a (note text);\n',
			'0002_second.sql': second,
		});

		const migrations = await readMigrations(folder);

		assert.deepEqual(
			migrations.map(({ name }) => name),
			['0001_first_step', '0002_second'],
		);
		assert.deepEqual(migrations[1], {
			checksum: createHash('sha256').update(second).digest('hex'),
			name: '0002_second',
			sql: second,
		});
	});

	test('refuses a folder holding a file not named as a migration', async (context) => {
		const folder = await folderHolding(context, {
			'0001_first.sql': 'SELECT 1;',
			'0002-second.sql': 'SELECT 2;',
		});

		await assert.rejects(readMigrations(folder), {
			message:
				'the migrations folder holds 0002-second.sql, which is not named as a migration: four digits, then lower-case words joined by underscores, then .sql',
		});
	});

	test('refuses two migrations sharing a number', async (context) => {
		const folder = await folderHolding(context, {
			'0001_first.sql': 'SELECT 1;',
			'0001_other.sql': 'SELECT 2;',
		});

		await assert.rejects(readMigrations(folder), {
			message: 'the migrations folder holds 0001_other.sql, whose number another migration already has',
		});
	});

	test("holds the controller's own migrations, each numbered once", async () => {
		const migrations = await readMigrations();
		const numbers = migrations.map(({ name }) => name.slice(0, 4));

		assert.equal(migrations.length > 0, true);
		assert.equal(new Set(numbers).size, numbers.length);
	});
});
