import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { pendingMigrations } from './pendingMigrations.js';
import type { AppliedMigration, Migration } from './types.js';

const migration = (name: string): Migration => ({
	checksum: `checksum of ${name}`,
	name,
	sql: `SELECT '${name}';`,
});

const KNOWN: readonly Migration[] = [migration('0001_first'), migration('0002_second'), migration('0003_third')];

const recordOf = ({ checksum, name }: Migration): AppliedMigration => ({
	checksum,
	name,
});

const namesOf = (migrations: readonly Migration[]): readonly string[] => migrations.map(({ name }) => name);

suite('the migrations a run applies', () => {
	test('applies every migration in order to a database recording none', () => {
		assert.deepEqual(namesOf(pendingMigrations(KNOWN, [])), ['0001_first', '0002_second', '0003_third']);
	});

	test('applies only the migrations after the last one applied', () => {
		const applied = KNOWN.slice(0, 2).map(recordOf);

		assert.deepEqual(namesOf(pendingMigrations(KNOWN, applied)), ['0003_third']);
	});

	test('applies nothing to a database recording every migration', () => {
		assert.deepEqual(pendingMigrations(KNOWN, KNOWN.map(recordOf)), []);
	});

	test('stops at the target, applying it', () => {
		assert.deepEqual(namesOf(pendingMigrations(KNOWN, [], '0002_second')), ['0001_first', '0002_second']);
	});

	test('applies nothing when the target is already applied', () => {
		const applied = KNOWN.slice(0, 2).map(recordOf);

		assert.deepEqual(pendingMigrations(KNOWN, applied, '0001_first'), []);
	});

	test('refuses a target naming no migration of the release', () => {
		assert.throws(() => pendingMigrations(KNOWN, [], '0004_fourth'), {
			message: 'the schema migrations refuse to run: target names no migration of this release',
		});
	});

	test('refuses a record holding a migration the release does not hold', () => {
		const applied = [...KNOWN.map(recordOf), { checksum: 'checksum', name: '0004_fourth' }];

		assert.throws(() => pendingMigrations(KNOWN, applied), {
			message:
				'the schema migrations refuse to run: the database records a migration as applied that this release does not hold',
		});
	});

	test('refuses a record departing from the release without naming anything the record holds, only what the release holds', () => {
		const marker = `marker_${randomUUID().replaceAll('-', '')}`;
		const records: readonly (readonly AppliedMigration[])[] = [
			[...KNOWN.map(recordOf), { checksum: marker, name: `0004_${marker}` }],
			[{ checksum: marker, name: marker }],
			[recordOf(migration('0001_first')), { checksum: marker, name: '0002_second' }],
		];

		const messages = records.map((applied) => {
			try {
				pendingMigrations(KNOWN, applied);
			} catch (refusal) {
				return refusal instanceof Error ? refusal.message : String(refusal);
			}
			return assert.fail('the record was taken, where a refusal was expected');
		});

		assert.deepEqual(messages, [
			'the schema migrations refuse to run: the database records a migration as applied that this release does not hold',
			'the schema migrations refuse to run: the database records a migration as applied that this release does not hold',
			'the schema migrations refuse to run: 0002_second has changed since it was applied; a correction is a new migration',
		]);
		assert.equal(
			messages.some((message) => message.includes(marker)),
			false,
		);
	});

	test('refuses a record whose checksum differs from the migration of that name', () => {
		const applied = [recordOf(migration('0001_first')), { checksum: 'tampered', name: '0002_second' }];

		assert.throws(() => pendingMigrations(KNOWN, applied), {
			message:
				'the schema migrations refuse to run: 0002_second has changed since it was applied; a correction is a new migration',
		});
	});

	test('refuses a release holding an unapplied migration below one applied', () => {
		const applied = [KNOWN[0], KNOWN[2]].flatMap((known) => (known === undefined ? [] : [recordOf(known)]));

		assert.throws(() => pendingMigrations(KNOWN, applied), {
			message:
				'the schema migrations refuse to run: 0002_second comes before 0003_third, which is applied, and is not applied itself',
		});
	});
});
