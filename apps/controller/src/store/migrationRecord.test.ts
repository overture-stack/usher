import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { StoreTimeout } from '../storeTimeout/index.js';
import { readStoreProbe, unknownMigrationsProblem } from './migrationRecord.js';

interface Asked {
	text: string;
	values: readonly unknown[] | undefined;
}

// A pool's reader answering every statement with the rows given, or failing as given, keeping each
// statement it was asked.
const answering = (
	answer: readonly Readonly<Record<string, unknown>>[] | Error,
): { asked: Asked[]; reader: Parameters<typeof readStoreProbe>[0] } => {
	const asked: Asked[] = [];
	return {
		asked,
		reader: {
			query: async <Row extends pg.QueryResultRow>(
				text: string,
				values?: readonly unknown[],
			): Promise<pg.QueryResult<Row>> => {
				asked.push({ text, values });
				if (answer instanceof Error) {
					throw answer;
				}
				return { rows: [...answer] } as unknown as pg.QueryResult<Row>;
			},
		},
	};
};

const databaseError = (code: string): pg.DatabaseError =>
	Object.assign(new pg.DatabaseError('refused at 10.0.0.5', 0, 'error'), {
		code,
	});

// The grant rules the store holds when they are valid: none, as a list.
const VALID_GRANT_RULES: readonly unknown[] = [];

const RECORDED = [
	{ checksum: 'a1'.repeat(32), name: '0001_policy_store' },
	{ checksum: 'b2'.repeat(32), name: '0002_notice_stream' },
];

suite("readiness's probe of the store", () => {
	test('asks one statement reading the session as read-only or not and the record of applied migrations in the schema, its name quoted', async () => {
		const { asked, reader } = answering([{ readOnly: 'off', recorded: RECORDED }]);

		await readStoreProbe(reader, 'usher "tenant"');

		assert.equal(asked.length, 1);
		assert.match(asked[0]?.text ?? '', /current_setting\('transaction_read_only'\)/u);
		assert.equal(asked[0]?.text.includes('"usher ""tenant"""."schema_migrations"'), true);
	});

	test('gives the record as the store answered it, and the store as read-only for any answer but off', async () => {
		const answers = await Promise.all(
			['off', 'on', 'unexpected'].map((readOnly) =>
				readStoreProbe(
					answering([{ grantRules: VALID_GRANT_RULES, readOnly, recorded: RECORDED }]).reader,
					'usher',
				),
			),
		);

		assert.deepEqual(answers, [
			{ grantRulesValid: true, readOnly: false, recorded: RECORDED },
			{ grantRulesValid: true, readOnly: true, recorded: RECORDED },
			{ grantRulesValid: true, readOnly: true, recorded: RECORDED },
		]);
	});

	test('reads the stored grant rules as invalid when the stored value breaks their rule, and as valid when it does not', async () => {
		const [invalid, missing] = await Promise.all(
			[[{ resources: [], to: 'anyone' }], null].map((grantRules) =>
				readStoreProbe(answering([{ grantRules, readOnly: 'off', recorded: RECORDED }]).reader, 'usher'),
			),
		);

		assert.equal(invalid?.grantRulesValid, false);
		assert.equal(missing?.grantRulesValid, false);
	});

	test('fails naming the record unreadable when the schema holds no record, the role may not read it, or the store gives no answer', async () => {
		const failures = await Promise.all(
			[databaseError('42P01'), databaseError('42501'), []].map((answer) =>
				readStoreProbe(answering(answer).reader, 'usher').catch((failure: unknown) => failure),
			),
		);

		assert.deepEqual(
			failures.map((failure) => (failure instanceof Error && 'code' in failure ? failure.code : failure)),
			['migrationRecordUnreadable', 'migrationRecordUnreadable', 'migrationRecordUnreadable'],
		);
		assert.equal(JSON.stringify(failures.map(String)).includes('10.0.0.5'), false);
	});

	test('passes on any other failure as it was thrown', async () => {
		const timeout = new StoreTimeout();
		const terminated = databaseError('57P01');

		const failures = await Promise.all(
			[timeout, terminated].map((failure) =>
				readStoreProbe(answering(failure).reader, 'usher').catch((thrown: unknown) => thrown),
			),
		);

		assert.equal(failures[0], timeout);
		assert.equal(failures[1], terminated);
	});
});

suite("the start's refusal of a database recording migrations this release does not know", () => {
	test("names the schema's variable and each migration, saying where its checksum differs", () => {
		const problem = unknownMigrationsProblem([
			{ checksumDiffers: true, name: '0001_policy_store' },
			{ checksumDiffers: false, name: '0099_later_release' },
			{ checksumDiffers: false, name: 'a name not in migration form' },
		]);

		assert.deepEqual(problem, {
			rule: "names a schema recording migrations this release does not know: 0001_policy_store (its checksum differs from this release's), 0099_later_release, a name not in migration form",
			variable: 'USHER_DATABASE_SCHEMA',
		});
	});
});
