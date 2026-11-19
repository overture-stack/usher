import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
  BASE_FIXTURE,
  BASELINE_NOTICE,
  capabilityId,
  categoryNotice,
  committedInsert,
  committedQuery,
  decisionRow,
  distinctContents,
  globalCategoryRow,
  GLOBAL_NOTICE,
  grantRow,
  insertRow,
  type NoticeContent,
  observeChange,
  type ObservedChange,
  openSeededDatabase,
  principalNotice,
  revocationRow,
  selectRows,
  servedResourcesNotice,
  stewardOf,
  SUBJECTS,
  writtenInItsTransaction,
} from '../../test-support/fixtures/database.js';
import {
  type Actor,
  declareActor,
  highestPosition,
  noticesAfter,
  type PolicyFixture,
  POLICY_TABLES,
  qualified,
  seededId,
  STEWARD_SUBJECT,
  SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const {
  applicationResources,
  categories,
  globalRevocations,
  grantDecisions,
  grants,
  groupUsers,
  principalRevocations,
  resourceCategories,
  resources,
  rolePermissions,
} = POLICY_TABLES;

const WITH_READERS_AND_A_SECOND_VIEWER: PolicyFixture = {
  ...BASE_FIXTURE,
  decisions: [
    { decision: 'accepted', grant: 'anaViews' },
    { decision: 'accepted', grant: 'cyViewsB2' },
  ],
  grants: {
    ...BASE_FIXTURE.grants,
    cyViewsB2: {
      category: 'unmarked',
      holder: { user: 'cy' },
      resource: 'STUDY-B2',
      role: 'viewer',
    },
  },
  groups: { readers: { members: ['bo', 'cy'], resource: 'STUDY-A1' } },
};

const assertWrittenWithChange = (
  observed: ObservedChange,
  expected: readonly NoticeContent[],
): void => {
  assert.equal(writtenInItsTransaction(observed), true);
  assert.deepEqual(
    distinctContents(observed.committed.notices),
    distinctContents(expected),
  );
};

const updating =
  (
    table: { name: string },
    assignments: string,
    where: string,
    parameters: readonly unknown[],
  ): ((client: pg.Client) => Promise<unknown>) =>
  (client) =>
    client.query(
      `UPDATE ${qualified(table)} SET ${assignments} WHERE ${where}`,
      [...parameters],
    );

const grantIdOf = async (
  client: pg.ClientBase,
  holderUserId: string,
  resourceId: string,
): Promise<string> => {
  const [row] = await selectRows<{ id: string }>(
    client,
    `SELECT ${grants.columns.id}::text AS id FROM ${qualified(grants)} WHERE ${grants.columns.holderUserId} = $1 AND ${grants.columns.resourceId} = $2 AND ${grants.columns.revokedAt} IS NULL`,
    [holderUserId, resourceId],
  );
  if (row !== undefined) {
    return row.id;
  }
  throw new Error('the store holds no such live grant');
};

suite('the notices each change writes', () => {
  test("writes a principal notice for a person's new grant, and for their answer to it", async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const cy = seededId(seeded.users, 'cy');
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');

    const created = await observeChange(database, (client) =>
      insertRow(
        client,
        grants,
        grantRow({
          grantedBy: stewardOf(seeded),
          holderUserId: cy,
          recordCategoryId: seededId(seeded.categories, 'controlled'),
          resourceId: studyA1,
          roleId: seededId(seeded.roles, 'viewer'),
        }),
      ),
    );
    const grantId = await grantIdOf(owner, cy, studyA1);
    const answered = await observeChange(database, (client) =>
      insertRow(
        client,
        grantDecisions,
        decisionRow({ decision: 'accepted', grantId, userId: cy }),
      ),
    );

    assertWrittenWithChange(created, [principalNotice(SUBJECTS.cy)]);
    assertWrittenWithChange(answered, [principalNotice(SUBJECTS.cy)]);
  });

  test("writes a principal notice when a person's grant changes its expiry or role, or is revoked", async (context) => {
    const { database, seeded } = await openSeededDatabase(context);
    const grantId = seededId(seeded.grants, 'anaViews');
    const byId = `${grants.columns.id} = $2`;

    const extended = await observeChange(
      database,
      updating(grants, `${grants.columns.expiresAt} = $1`, byId, [
        new Date('2027-06-30T00:00:00Z'),
        grantId,
      ]),
    );
    const recast = await observeChange(
      database,
      updating(grants, `${grants.columns.roleId} = $1`, byId, [
        seededId(seeded.roles, 'submitter'),
        grantId,
      ]),
    );
    const revoked = await observeChange(
      database,
      updating(
        grants,
        `${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1`,
        byId,
        [stewardOf(seeded), grantId],
      ),
    );

    assertWrittenWithChange(extended, [principalNotice(SUBJECTS.ana)]);
    assertWrittenWithChange(recast, [principalNotice(SUBJECTS.ana)]);
    assertWrittenWithChange(revoked, [principalNotice(SUBJECTS.ana)]);
  });

  test("writes a principal notice for each member a group's grant or membership reaches", async (context) => {
    const { database, seeded } = await openSeededDatabase(
      context,
      WITH_READERS_AND_A_SECOND_VIEWER,
    );
    const readers = seededId(seeded.groups, 'readers');

    const granted = await observeChange(database, (client) =>
      insertRow(
        client,
        grants,
        grantRow({
          grantedBy: stewardOf(seeded),
          holderGroupId: readers,
          recordCategoryId: seededId(seeded.categories, 'unmarked'),
          resourceId: seededId(seeded.resources, 'STUDY-A1'),
          roleId: seededId(seeded.roles, 'viewer'),
        }),
      ),
    );
    const joined = await observeChange(database, (client) =>
      insertRow(client, groupUsers, {
        [groupUsers.columns.groupId]: readers,
        [groupUsers.columns.userId]: seededId(seeded.users, 'ana'),
      }),
    );
    const left = await observeChange(database, (client) =>
      client.query(
        `DELETE FROM ${qualified(groupUsers)} WHERE ${groupUsers.columns.groupId} = $1 AND ${groupUsers.columns.userId} = $2`,
        [readers, seededId(seeded.users, 'cy')],
      ),
    );

    assertWrittenWithChange(granted, [
      principalNotice(SUBJECTS.bo),
      principalNotice(SUBJECTS.cy),
    ]);
    assertWrittenWithChange(joined, [principalNotice(SUBJECTS.ana)]);
    assertWrittenWithChange(left, [principalNotice(SUBJECTS.cy)]);
  });

  test("writes a principal notice when a person's identity is revoked, and when the revocation is lifted", async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const cy = seededId(seeded.users, 'cy');
    const steward = stewardOf(seeded);

    const revoked = await observeChange(database, (client) =>
      insertRow(
        client,
        principalRevocations,
        revocationRow({ revokedBy: steward, userId: cy }),
      ),
    );
    const lifted = await observeChange(
      database,
      updating(
        principalRevocations,
        `${principalRevocations.columns.liftedAt} = now(), ${principalRevocations.columns.liftedBy} = $1`,
        `${principalRevocations.columns.userId} = $2 AND ${principalRevocations.columns.liftedAt} IS NULL`,
        [steward, cy],
      ),
    );

    assertWrittenWithChange(revoked, [principalNotice(SUBJECTS.cy)]);
    assertWrittenWithChange(lifted, [principalNotice(SUBJECTS.cy)]);
    assert.equal(
      (
        await selectRows(
          owner,
          `SELECT 1 FROM ${qualified(principalRevocations)} WHERE ${principalRevocations.columns.userId} = $1 AND ${principalRevocations.columns.liftedAt} IS NOT NULL`,
          [cy],
        )
      ).length,
      1,
    );
  });

  test('writes a principal notice to each holder of a role whose capabilities change', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(
      context,
      WITH_READERS_AND_A_SECOND_VIEWER,
    );
    const viewer = seededId(seeded.roles, 'viewer');
    const recordCreate = await capabilityId(owner, 'record.create');
    const recordExport = await capabilityId(owner, 'record.export');

    const widened = await observeChange(database, (client) =>
      insertRow(client, rolePermissions, {
        [rolePermissions.columns.capabilityId]: recordCreate,
        [rolePermissions.columns.roleId]: viewer,
      }),
    );
    const narrowed = await observeChange(database, (client) =>
      client.query(
        `DELETE FROM ${qualified(rolePermissions)} WHERE ${rolePermissions.columns.roleId} = $1 AND ${rolePermissions.columns.capabilityId} = $2`,
        [viewer, recordExport],
      ),
    );

    const holders = [
      principalNotice(SUBJECTS.ana),
      principalNotice(SUBJECTS.cy),
    ];
    assertWrittenWithChange(widened, holders);
    assertWrittenWithChange(narrowed, holders);
  });

  test("writes a category notice when a resource's categories change", async (context) => {
    const { database, seeded } = await openSeededDatabase(context);
    const studyB2 = seededId(seeded.resources, 'STUDY-B2');

    const offered = await observeChange(database, (client) =>
      insertRow(client, resourceCategories, {
        [resourceCategories.columns.categoryId]: seededId(
          seeded.categories,
          'controlled',
        ),
        [resourceCategories.columns.resourceId]: studyB2,
      }),
    );
    const withdrawn = await observeChange(database, (client) =>
      client.query(
        `DELETE FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1 AND ${resourceCategories.columns.categoryId} = $2`,
        [studyB2, seededId(seeded.categories, 'unmarked')],
      ),
    );

    assertWrittenWithChange(offered, [categoryNotice('STUDY-B2')]);
    assertWrittenWithChange(withdrawn, [categoryNotice('STUDY-B2')]);
  });

  test('writes a category notice when a resource is suppressed', async (context) => {
    const { database } = await openSeededDatabase(context);

    const suppressed = await observeChange(
      database,
      updating(
        resources,
        `${resources.columns.suppressed} = $1`,
        `${resources.columns.externalId} = $2`,
        [true, 'STUDY-A1'],
      ),
    );

    assertWrittenWithChange(suppressed, [categoryNotice('STUDY-A1')]);
  });

  test("writes a baseline notice when a resource's base tier changes", async (context) => {
    const { database } = await openSeededDatabase(context);

    const narrowed = await observeChange(
      database,
      updating(
        resources,
        `${resources.columns.baseTier} = $1`,
        `${resources.columns.externalId} = $2`,
        ['grant', 'STUDY-B2'],
      ),
    );
    const widened = await observeChange(
      database,
      updating(
        resources,
        `${resources.columns.baseTier} = $1`,
        `${resources.columns.externalId} = $2`,
        ['open', 'STUDY-A1'],
      ),
    );

    assertWrittenWithChange(narrowed, [BASELINE_NOTICE]);
    assertWrittenWithChange(widened, [BASELINE_NOTICE]);
  });

  test('writes a baseline notice when a suppressed resource is restored', async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    await committedQuery(
      owner,
      `UPDATE ${qualified(resources)} SET ${resources.columns.suppressed} = true WHERE ${resources.columns.externalId} = 'STUDY-B2'`,
    );

    const restored = await observeChange(
      database,
      updating(
        resources,
        `${resources.columns.suppressed} = $1`,
        `${resources.columns.externalId} = $2`,
        [false, 'STUDY-B2'],
      ),
    );

    assertWrittenWithChange(restored, [BASELINE_NOTICE]);
  });

  test('writes a baseline notice when a global category is added, renamed or removed', async (context) => {
    const { database } = await openSeededDatabase(context);
    const named = (name: string): string =>
      `${categories.columns.scope} = 'global' AND ${categories.columns.name} = '${name}'`;

    const added = await observeChange(database, (client) =>
      insertRow(client, categories, globalCategoryRow('restricted')),
    );
    const renamed = await observeChange(
      database,
      updating(
        categories,
        `${categories.columns.name} = $1`,
        named('restricted'),
        ['embargoed'],
      ),
    );
    const removed = await observeChange(database, (client) =>
      client.query(
        `DELETE FROM ${qualified(categories)} WHERE ${named('embargoed')}`,
      ),
    );

    assertWrittenWithChange(added, [BASELINE_NOTICE]);
    assertWrittenWithChange(renamed, [BASELINE_NOTICE]);
    assertWrittenWithChange(removed, [BASELINE_NOTICE]);
  });

  test('writes a servedResources notice to the affected audience alone when a served set changes', async (context) => {
    const { database, seeded } = await openSeededDatabase(context);
    const arranger = seededId(seeded.applications, 'ims-arranger');
    const lyric = seededId(seeded.applications, 'ims-lyric');

    const added = await observeChange(database, (client) =>
      insertRow(client, applicationResources, {
        [applicationResources.columns.applicationId]: lyric,
        [applicationResources.columns.resourceId]: seededId(
          seeded.resources,
          'STUDY-B2',
        ),
      }),
    );
    const removed = await observeChange(database, (client) =>
      client.query(
        `DELETE FROM ${qualified(applicationResources)} WHERE ${applicationResources.columns.applicationId} = $1 AND ${applicationResources.columns.resourceId} = $2`,
        [arranger, seededId(seeded.resources, 'STUDY-A1')],
      ),
    );

    assertWrittenWithChange(added, [servedResourcesNotice(lyric)]);
    assertWrittenWithChange(removed, [servedResourcesNotice(arranger)]);
  });

  test('writes a category notice and a servedResources notice to each serving audience when a resource is retired', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const arranger = seededId(seeded.applications, 'ims-arranger');
    const lyric = seededId(seeded.applications, 'ims-lyric');
    await committedInsert(owner, applicationResources, {
      [applicationResources.columns.applicationId]: lyric,
      [applicationResources.columns.resourceId]: seededId(
        seeded.resources,
        'STUDY-B2',
      ),
    });

    const retired = await observeChange(
      database,
      updating(
        resources,
        `${resources.columns.retiredAt} = now(), ${resources.columns.retiredBy} = $1`,
        `${resources.columns.externalId} = $2`,
        [stewardOf(seeded), 'STUDY-B2'],
      ),
    );

    assertWrittenWithChange(retired, [
      categoryNotice('STUDY-B2'),
      servedResourcesNotice(arranger),
      servedResourcesNotice(lyric),
    ]);
  });

  test('writes a global notice, raises the policy generation and records the change when a global revocation is recorded, all in its transaction', async (context) => {
    const { database, seeded } = await openSeededDatabase(context);
    const administrator: Actor = { id: STEWARD_SUBJECT, type: 'human' };

    const revoked = await observeChange(
      database,
      (client) =>
        insertRow(client, globalRevocations, {
          [globalRevocations.columns.reasonCode]: 'securityIncident',
          [globalRevocations.columns.revokedAt]: new Date(),
          [globalRevocations.columns.revokedBy]: stewardOf(seeded),
        }),
      { actor: administrator },
    );

    const { before, committed, insideTransaction } = revoked;
    assertWrittenWithChange(revoked, [GLOBAL_NOTICE]);
    assert.equal(
      before.generation !== undefined &&
        insideTransaction.generation !== undefined &&
        insideTransaction.generation > before.generation,
      true,
    );
    assert.deepEqual(
      committed.changeRecords.map(
        ({ actorId, actorType, newRow, oldRow, tableName }) => ({
          actorId,
          actorType,
          reasonCode: newRow?.[globalRevocations.columns.reasonCode],
          revokedBy: newRow?.[globalRevocations.columns.revokedBy],
          tableName,
          valuesBefore: oldRow,
        }),
      ),
      [
        {
          actorId: STEWARD_SUBJECT,
          actorType: 'human',
          reasonCode: 'securityIncident',
          revokedBy: stewardOf(seeded),
          tableName: globalRevocations.name,
          valuesBefore: null,
        },
      ],
    );
  });

  test('commits a served-set change and its servedResources notices in one transaction', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const writer = await database.connect('migration');
    const studyB2 = seededId(seeded.resources, 'STUDY-B2');
    const lyric = seededId(seeded.applications, 'ims-lyric');
    const start = await highestPosition(owner);
    const serving = {
      [applicationResources.columns.applicationId]: lyric,
      [applicationResources.columns.resourceId]: studyB2,
    };
    const seen = async (
      client: pg.ClientBase,
    ): Promise<{ notices: readonly NoticeContent[]; served: number }> => ({
      notices: distinctContents(await noticesAfter(client, start)),
      served: (
        await selectRows(
          client,
          `SELECT 1 FROM ${qualified(applicationResources)} WHERE ${applicationResources.columns.applicationId} = $1 AND ${applicationResources.columns.resourceId} = $2`,
          [lyric, studyB2],
        )
      ).length,
    });
    const nothing = { notices: [], served: 0 };

    await writer.query('BEGIN');
    await declareActor(writer, SYSTEM_ACTOR);
    await insertRow(writer, applicationResources, serving);
    await writer.query('ROLLBACK');
    const afterRollback = await seen(owner);
    await writer.query('BEGIN');
    await declareActor(writer, SYSTEM_ACTOR);
    await insertRow(writer, applicationResources, serving);
    const insideTransaction = await seen(writer);
    const elsewhereBeforeCommit = await seen(owner);
    await writer.query('COMMIT');
    const committed = await seen(owner);

    assert.deepEqual(afterRollback, nothing);
    assert.deepEqual(elsewhereBeforeCommit, nothing);
    assert.deepEqual(committed, insideTransaction);
    assert.deepEqual(committed, {
      notices: [servedResourcesNotice(lyric)],
      served: 1,
    });
  });
});
