import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { readAudiencePolicy, readPrincipalPolicy } from './readAudiencePolicy.js';
import type { ReachingGrant, ServedResource } from './types.js';

const AUDIENCE = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

const PERSON = '4e8b1c2d-7a3f-4b9e-8d6c-5f2a1e9b3c70';

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

const SERVED: readonly ServedResource[] = [
	{
		baseTier: 'open',
		externalId: 'étude « Nord » "A1"',
		ownCategories: ['local-panel'],
		retired: false,
		suppressed: false,
	},
	{
		baseTier: 'grant',
		externalId: 'STUDY-D4',
		ownCategories: [],
		retired: true,
		suppressed: true,
	},
];

const GRANTS: readonly ReachingGrant[] = [
	{
		expiresAt: 1_767_225_600_700,
		externalId: 'étude « Nord » "A1"',
		fieldCategory: null,
		latestDecision: { capabilities: ['record.view'], decision: 'accepted' },
		plane: 'data',
		recordCategory: { name: 'controlled', scope: 'global' },
		roleCapabilities: ['record.count', 'record.export', 'record.view'],
	},
	{
		expiresAt: null,
		externalId: 'STUDY-D4',
		fieldCategory: { name: 'clinician', scope: 'resource' },
		latestDecision: null,
		plane: 'control',
		recordCategory: null,
		roleCapabilities: ['grant.create'],
	},
];

// A client that never connects, each statement answered with the rows given.
const answering = (
	rows: readonly Record<string, unknown>[],
): { connection: pg.ClientBase; statements: Statement[] } => {
	const statements: Statement[] = [];
	const query = async (text: string, values?: readonly unknown[]) => {
		statements.push({ text, values });
		return { rows };
	};
	return {
		connection: Object.assign(new pg.Client(), { query }),
		statements,
	};
};

suite("reading an audience's policy", () => {
	test("reads the global categories and the audience's served resources in one statement, so from one snapshot, binding the audience and naming the schema's tables", async () => {
		const { connection, statements } = answering([
			{
				globalCategories: ['controlled', 'unmarked'],
				grantRules: [],
				served: SERVED,
			},
		]);

		const policy = await readAudiencePolicy(connection, 'usher "test"', AUDIENCE);

		assert.deepEqual(policy, {
			globalCategories: ['controlled', 'unmarked'],
			grantRules: { kind: 'read', rules: [] },
			served: SERVED,
		});
		assert.equal(statements.length, 1);
		assert.deepEqual(statements[0]?.values, [AUDIENCE]);
		['application_resources', 'categories', 'resources', 'settings'].forEach((table) =>
			assert.ok(statements[0]?.text.includes(`"usher ""test""".${table}`), table),
		);
	});

	test('gives the grant rules the store holds as refused, with the rule they break, where the stored value breaks it', async () => {
		const { connection } = answering([
			{
				globalCategories: [],
				grantRules: [{ resources: [], to: 'anyone' }],
				served: SERVED,
			},
		]);

		const policy = await readAudiencePolicy(connection, 'usher', AUDIENCE);

		assert.equal(policy.grantRules.kind, 'refused');
	});

	test('throws when the store answers the read with no row', async () => {
		const { connection } = answering([]);

		await assert.rejects(readAudiencePolicy(connection, 'usher', AUDIENCE), {
			message: "the read of an audience's policy answered no row",
		});
	});

	suite('for a signed-in principal', () => {
		test("reads the global categories, the audience's served resources and the grants reaching the principal in one statement, so from one snapshot, binding the audience and the person and naming the schema's tables", async () => {
			const { connection, statements } = answering([
				{
					globalCategories: ['controlled', 'unmarked'],
					grantRules: [],
					grants: GRANTS,
					served: SERVED,
				},
			]);

			const policy = await readPrincipalPolicy(connection, 'usher "test"', AUDIENCE, PERSON);

			assert.deepEqual(policy, {
				globalCategories: ['controlled', 'unmarked'],
				grantRules: { kind: 'read', rules: [] },
				grants: GRANTS,
				served: SERVED,
			});
			assert.equal(statements.length, 1);
			assert.deepEqual(statements[0]?.values, [AUDIENCE, PERSON]);
			[
				'application_resources',
				'capabilities',
				'categories',
				'grant_decisions',
				'grants',
				'group_users',
				'resources',
				'role_permissions',
				'roles',
			].forEach((table) => assert.ok(statements[0]?.text.includes(`"usher ""test""".${table} `), table));
		});

		test('reads only unrevoked grants held by the person or by a group they belong to, with only their own decisions', async () => {
			const { connection, statements } = answering([{ globalCategories: [], grants: [], served: [] }]);

			await readPrincipalPolicy(connection, 'usher', AUDIENCE, PERSON);
			const text = statements[0]?.text ?? '';

			assert.ok(text.includes('direct.holder_user_id = $2::uuid'));
			assert.ok(text.includes('membership.user_id = $2::uuid'));
			assert.ok(text.includes('answer.user_id = $2::uuid'));
			assert.equal(text.match(/\.revoked_at IS NULL/gu)?.length, 2);
		});

		test('throws when the store answers the read with no row', async () => {
			const { connection } = answering([]);

			await assert.rejects(readPrincipalPolicy(connection, 'usher', AUDIENCE, PERSON), {
				message: "the read of a principal's policy answered no row",
			});
		});
	});
});
