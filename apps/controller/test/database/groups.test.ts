import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  BASE_FIXTURE,
  committedInsert,
  grantRow,
  INTEGRITY,
  openSeededDatabase,
  selectRows,
  stewardOf,
  violation,
} from '../../test-support/fixtures/database.js';
import {
  type PolicyFixture,
  POLICY_TABLES,
  qualified,
  seededId,
} from '../../test-support/policy.js';

const { grants, groupUsers, groups } = POLICY_TABLES;

const WITH_READERS: PolicyFixture = {
  ...BASE_FIXTURE,
  groups: { readers: { members: ['ana'], resource: 'STUDY-A1' } },
};

suite('groups', () => {
  test('names each group once within its resource, and lists each member once', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context, WITH_READERS);
    const steward = stewardOf(seeded);
    const groupOn = (externalId: string): Record<string, unknown> => ({
      [groups.columns.createdAt]: new Date(),
      [groups.columns.createdBy]: steward,
      [groups.columns.name]: 'readers',
      [groups.columns.resourceId]: seededId(seeded.resources, externalId),
    });

    await assert.rejects(
      committedInsert(owner, groups, groupOn('STUDY-A1')),
      violation(INTEGRITY.unique),
    );
    await assert.rejects(
      committedInsert(owner, groupUsers, {
        [groupUsers.columns.groupId]: seededId(seeded.groups, 'readers'),
        [groupUsers.columns.userId]: seededId(seeded.users, 'ana'),
      }),
      violation(INTEGRITY.unique),
    );
    await committedInsert(owner, groups, groupOn('STUDY-B2'));

    assert.deepEqual(
      await selectRows<{ count: number }>(
        owner,
        `SELECT count(*)::int AS count FROM ${qualified(groups)} WHERE ${groups.columns.name} = 'readers'`,
      ),
      [{ count: 2 }],
    );
    assert.deepEqual(
      await selectRows<{ count: number }>(
        owner,
        `SELECT count(*)::int AS count FROM ${qualified(groupUsers)}`,
      ),
      [{ count: 1 }],
    );
  });

  test("confines a group's grant to the group's own resource", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context, WITH_READERS);
    const groupGrant = (externalId: string): Record<string, unknown> =>
      grantRow({
        grantedBy: stewardOf(seeded),
        holderGroupId: seededId(seeded.groups, 'readers'),
        recordCategoryId: seededId(seeded.categories, 'unmarked'),
        resourceId: seededId(seeded.resources, externalId),
        roleId: seededId(seeded.roles, 'viewer'),
      });

    await assert.rejects(
      committedInsert(owner, grants, groupGrant('STUDY-B2')),
      violation(INTEGRITY.foreignKey),
    );
    await committedInsert(owner, grants, groupGrant('STUDY-A1'));

    assert.deepEqual(
      await selectRows<{ resourceId: string }>(
        owner,
        `SELECT ${grants.columns.resourceId}::text AS "resourceId" FROM ${qualified(grants)} WHERE ${grants.columns.holderGroupId} = $1`,
        [seededId(seeded.groups, 'readers')],
      ),
      [{ resourceId: seededId(seeded.resources, 'STUDY-A1') }],
    );
  });
});
