import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { AppliedMigration, Migration } from './types.js';
import { MIGRATION_UNKNOWN, migrationUnknownFields, unknownMigrations } from './unknownMigrations.js';

const NOT_IN_MIGRATION_FORM = 'a name not in migration form';

const KNOWN: readonly Migration[] = [
	{ checksum: 'a1'.repeat(32), name: '0001_policy_store', sql: '' },
	{ checksum: 'b2'.repeat(32), name: '0002_notice_stream', sql: '' },
	{ checksum: 'c3'.repeat(32), name: '0003_policy_rules', sql: '' },
];

const applied = ({ checksum, name }: Migration): AppliedMigration => ({
	checksum,
	name,
});

suite('the migrations a database records that this release does not know', () => {
	test("finds none in a record of exactly this release's migrations, nor in one behind it, nor in an empty one", () => {
		const found = [KNOWN, KNOWN.slice(0, 2), []].map((record) => unknownMigrations(KNOWN, record.map(applied)));

		assert.deepEqual(found, [[], [], []]);
	});

	test('finds each recorded migration this release does not hold, and each it holds whose checksum differs, in the order of the record', () => {
		const record: readonly AppliedMigration[] = [
			{ checksum: 'a1'.repeat(32), name: '0001_policy_store' },
			{ checksum: 'ff'.repeat(32), name: '0002_notice_stream' },
			{ checksum: 'c3'.repeat(32), name: '0003_policy_rules' },
			{ checksum: 'd4'.repeat(32), name: '0004_sign_in_suspensions' },
		];

		const found = unknownMigrations(KNOWN, record);

		assert.deepEqual(found, [
			{ checksumDiffers: true, name: '0002_notice_stream' },
			{ checksumDiffers: false, name: '0004_sign_in_suspensions' },
		]);
	});

	test('names a recorded name in migration form as recorded, and any other by a fixed phrase, never giving back a recorded value otherwise', () => {
		const outOfForm = [
			"0004_x'); DROP TABLE grants; --",
			'0004',
			'0004_Upper',
			'004_short',
			'0004_trailing_',
			'0004__doubled',
			'0004_sql.sql',
			' 0004_padded',
			'',
		];
		const record: readonly AppliedMigration[] = [
			...outOfForm.map((name) => ({ checksum: 'e5'.repeat(32), name })),
			{ checksum: 'e5'.repeat(32), name: '0099_v2_later_release' },
		];

		const found = unknownMigrations(KNOWN, record);

		assert.deepEqual(found, [
			...outOfForm.map(() => ({
				checksumDiffers: false,
				name: NOT_IN_MIGRATION_FORM,
			})),
			{ checksumDiffers: false, name: '0099_v2_later_release' },
		]);
		assert.equal(
			outOfForm.filter((name) => name !== '').some((name) => JSON.stringify(found).includes(name)),
			false,
		);
		assert.equal(JSON.stringify(found).includes('e5e5'), false);
	});
});

suite("the line naming a database's migrations this release does not know", () => {
	test('is named schema.migrationUnknown', () => {
		assert.equal(MIGRATION_UNKNOWN, 'schema.migrationUnknown');
	});

	test('names each migration, says its checksum differs only where it does, and carries what refused', () => {
		const unknown = [
			{ checksumDiffers: true, name: '0002_notice_stream' },
			{ checksumDiffers: false, name: '0004_sign_in_suspensions' },
			{ checksumDiffers: false, name: NOT_IN_MIGRATION_FORM },
		];

		const fields = (['start', 'readiness'] as const).map((refused) => migrationUnknownFields(unknown, refused));

		assert.deepEqual(
			fields,
			['start', 'readiness'].map((refused) => ({
				migrations: [
					{ checksumDiffers: true, name: '0002_notice_stream' },
					{ name: '0004_sign_in_suspensions' },
					{ name: NOT_IN_MIGRATION_FORM },
				],
				refused,
			})),
		);
	});
});
