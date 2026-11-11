import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { readAudiencePolicy } from './readAudiencePolicy.js';
import type { ServedResource } from './types.js';

const AUDIENCE = '0d4c7e2a-8b1f-4a63-9e05-3f7a2c9d1b68';

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
      { globalCategories: ['controlled', 'unmarked'], served: SERVED },
    ]);

    const policy = await readAudiencePolicy(
      connection,
      'usher "test"',
      AUDIENCE,
    );

    assert.deepEqual(policy, {
      globalCategories: ['controlled', 'unmarked'],
      served: SERVED,
    });
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0]?.values, [AUDIENCE]);
    ['application_resources', 'categories', 'resources'].forEach((table) =>
      assert.ok(
        statements[0]?.text.includes(`"usher ""test""".${table}`),
        table,
      ),
    );
  });

  test('throws when the store answers the read with no row', async () => {
    const { connection } = answering([]);

    await assert.rejects(readAudiencePolicy(connection, 'usher', AUDIENCE), {
      message: "the read of an audience's policy answered no row",
    });
  });
});
