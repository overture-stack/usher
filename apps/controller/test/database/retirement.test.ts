import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
  type ChangeRecord,
  committedChange,
  committedInsert,
  committedQuery,
  INTEGRITY,
  openSeededDatabase,
  readChangeRecords,
  resourceRow,
  RESTRICTED_DELETE_CODES,
  selectRows,
  stewardOf,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  inTurn,
  POLICY_TABLES,
  qualified,
  seededId,
} from '../../test-support/policy.js';

const { applicationResources, grants, resourceCategories, resources } =
  POLICY_TABLES;

const resourcesLike = async (
  client: pg.ClientBase,
  lowered: string,
): Promise<readonly string[]> =>
  (
    await selectRows<{ externalId: string }>(
      client,
      `SELECT ${resources.columns.externalId} AS "externalId" FROM ${qualified(resources)} WHERE lower(${resources.columns.externalId}) = $1`,
      [lowered],
    )
  ).map(({ externalId }) => externalId);

suite('retiring and deleting a resource', () => {
  test('keeps a resource that ever held a grant', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    await committedQuery(
      owner,
      `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.resourceId} = $2 AND ${grants.columns.revokedAt} IS NULL`,
      [stewardOf(seeded), studyA1],
    );

    const outcome = await writeOutcome(
      committedChange(owner, async () => {
        await owner.query(
          `DELETE FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1`,
          [studyA1],
        );
        await owner.query(
          `DELETE FROM ${qualified(applicationResources)} WHERE ${applicationResources.columns.resourceId} = $1`,
          [studyA1],
        );
        await owner.query(
          `DELETE FROM ${qualified(resources)} WHERE ${resources.columns.id} = $1`,
          [studyA1],
        );
      }),
    );

    assert.ok(
      RESTRICTED_DELETE_CODES.has(outcome),
      `the delete came to ${outcome}`,
    );
    assert.deepEqual(await resourcesLike(owner, 'study-a1'), ['STUDY-A1']);
  });

  test('deletes a registration that never held a grant, freeing its external identifier and keeping its creation and deletion on record', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyC3 = seededId(seeded.resources, 'study.c_3');
    const creationOf = (
      records: readonly ChangeRecord[],
    ): readonly ChangeRecord[] =>
      records.filter(
        ({ newRow, oldRow, tableName }) =>
          tableName === resources.name &&
          oldRow === null &&
          newRow?.[resources.columns.id] === studyC3,
      );
    const createdBefore = creationOf(await readChangeRecords(owner));

    const deletion = await committedChange(owner, async () => {
      await owner.query(
        `DELETE FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1`,
        [studyC3],
      );
      await owner.query(
        `DELETE FROM ${qualified(resources)} WHERE ${resources.columns.id} = $1`,
        [studyC3],
      );
    });
    await committedInsert(
      owner,
      resources,
      resourceRow('study.c_3', stewardOf(seeded)),
    );

    assert.equal(createdBefore.length, 1);
    assert.deepEqual(creationOf(await readChangeRecords(owner)), createdBefore);
    assert.deepEqual(
      deletion.changeRecords
        .filter(({ tableName }) => tableName === resources.name)
        .map(({ newRow, oldRow }) => ({
          deleted: oldRow?.[resources.columns.externalId],
          left: newRow,
        })),
      [{ deleted: 'study.c_3', left: null }],
    );
    assert.deepEqual(await resourcesLike(owner, 'study.c_3'), ['study.c_3']);
  });

  test("reserves a retired resource's external identifier, case variants included", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    await committedQuery(
      owner,
      `UPDATE ${qualified(resources)} SET ${resources.columns.retiredAt} = now(), ${resources.columns.retiredBy} = $1 WHERE ${resources.columns.externalId} = 'STUDY-B2'`,
      [steward],
    );

    const outcomes = await inTurn(
      ['STUDY-B2', 'study-b2', 'Study-B2'],
      (externalId) =>
        writeOutcome(
          committedInsert(owner, resources, resourceRow(externalId, steward)),
        ),
    );

    assert.deepEqual(outcomes, [
      INTEGRITY.unique,
      INTEGRITY.unique,
      INTEGRITY.unique,
    ]);
    assert.deepEqual(await resourcesLike(owner, 'study-b2'), ['STUDY-B2']);
  });
});
