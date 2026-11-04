import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { SPECIAL_VALUE_MARKERS } from '@overture-stack/usher-types';
import type pg from 'pg';

import { untilBlocked } from '../../test-support/database.js';
import {
  ANA_ACTING,
  committedInsert,
  committedQuery,
  globalCategoryRow,
  grantRow,
  insertRow,
  INSUFFICIENT_PRIVILEGE,
  INTEGRITY,
  openSeededDatabase,
  refusedByStore,
  resourceCategoryRow,
  resourceRow,
  type Row,
  selectRows,
  stewardOf,
  violation,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  declareActor,
  inTurn,
  POLICY_TABLES,
  qualified,
  seededId,
  SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { categories, grants, resourceCategories, resources } = POLICY_TABLES;

const externalIdsLike = async (
  client: pg.ClientBase,
  lowered: string,
): Promise<readonly string[]> =>
  (
    await selectRows<{ externalId: string }>(
      client,
      `SELECT ${resources.columns.externalId} AS "externalId" FROM ${qualified(resources)} WHERE lower(${resources.columns.externalId}) = $1 ORDER BY ${resources.columns.externalId}`,
      [lowered],
    )
  ).map(({ externalId }) => externalId);

const offeringsOf = async (
  client: pg.ClientBase,
  resourceId: string,
): Promise<readonly string[]> =>
  (
    await selectRows<{ categoryId: string }>(
      client,
      `SELECT ${resourceCategories.columns.categoryId}::text AS "categoryId" FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1 ORDER BY ${resourceCategories.columns.categoryId}::text COLLATE "C"`,
      [resourceId],
    )
  ).map(({ categoryId }) => categoryId);

const categoriesNamed = (
  client: pg.ClientBase,
  name: string,
): Promise<readonly { resourceId: string | null; scope: string }[]> =>
  selectRows<{ resourceId: string | null; scope: string }>(
    client,
    `SELECT ${categories.columns.resourceId}::text AS "resourceId", ${categories.columns.scope} AS scope FROM ${qualified(categories)} WHERE ${categories.columns.name} = $1 ORDER BY ${categories.columns.scope} COLLATE "C", ${categories.columns.resourceId}::text COLLATE "C"`,
    [name],
  );

suite('resources and categories', () => {
  test('names each resource by one external identifier, always present and never shared', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);

    await assert.rejects(
      committedInsert(owner, resources, resourceRow('STUDY-A1', steward)),
      violation(INTEGRITY.unique),
    );
    await assert.rejects(
      committedInsert(owner, resources, {
        ...resourceRow('STUDY-Z9', steward),
        [resources.columns.externalId]: null,
      }),
      violation(INTEGRITY.notNull),
    );

    assert.deepEqual(await externalIdsLike(owner, 'study-a1'), ['STUDY-A1']);
    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT 1 FROM ${qualified(resources)} WHERE ${resources.columns.externalId} IS NULL OR ${resources.columns.name} = 'Study STUDY-Z9'`,
      ),
      [],
    );
  });

  test('lets two resources share a display name', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);

    await committedInsert(owner, resources, {
      ...resourceRow('STUDY-F6', stewardOf(seeded)),
      [resources.columns.name]: 'Cardiac Outcomes',
    });

    assert.deepEqual(
      await selectRows<{ externalId: string }>(
        owner,
        `SELECT ${resources.columns.externalId} AS "externalId" FROM ${qualified(resources)} WHERE ${resources.columns.name} = 'Cardiac Outcomes' ORDER BY ${resources.columns.externalId} COLLATE "C"`,
      ),
      [{ externalId: 'STUDY-A1' }, { externalId: 'STUDY-F6' }],
    );
  });

  test('accepts only the three base tiers', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const register = (tier: string, externalId: string): Promise<unknown> =>
      committedInsert(owner, resources, {
        ...resourceRow(externalId, steward),
        [resources.columns.baseTier]: tier,
      });

    await inTurn(['open', 'registered', 'grant'], (tier) =>
      register(tier, `TIER-${tier}`),
    );
    const refusals = await inTurn(
      ['controlled', 'public', 'Open', ''],
      (tier) => writeOutcome(register(tier, `REFUSED-${tier.length}-${tier}`)),
    );

    assert.deepEqual(
      await selectRows<{ tier: string }>(
        owner,
        `SELECT ${resources.columns.baseTier} AS tier FROM ${qualified(resources)} WHERE ${resources.columns.externalId} LIKE 'TIER-%' ORDER BY ${resources.columns.baseTier} COLLATE "C"`,
      ),
      [{ tier: 'grant' }, { tier: 'open' }, { tier: 'registered' }],
    );
    assert.deepEqual(refusals, [
      INTEGRITY.check,
      INTEGRITY.check,
      INTEGRITY.check,
      INTEGRITY.check,
    ]);
  });

  test('registers a resource unsuppressed unless told otherwise', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);

    const stored = await committedInsert(
      owner,
      resources,
      resourceRow('STUDY-G7', stewardOf(seeded)),
    );

    assert.equal(stored[resources.columns.suppressed], false);
  });

  test('holds one global category per name', async (context) => {
    const { owner } = await openSeededDatabase(context);

    await assert.rejects(
      committedInsert(owner, categories, globalCategoryRow('controlled')),
      violation(INTEGRITY.unique),
    );

    assert.deepEqual(await categoriesNamed(owner, 'controlled'), [
      { resourceId: null, scope: 'global' },
    ]);
  });

  test('holds one category per name within a resource, and lets resources reuse a name', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const studyB2 = seededId(seeded.resources, 'STUDY-B2');
    await committedInsert(
      owner,
      categories,
      resourceCategoryRow('restricted', studyA1),
    );

    await assert.rejects(
      committedInsert(
        owner,
        categories,
        resourceCategoryRow('restricted', studyA1),
      ),
      violation(INTEGRITY.unique),
    );
    await committedInsert(
      owner,
      categories,
      resourceCategoryRow('restricted', studyB2),
    );
    await committedInsert(owner, categories, globalCategoryRow('restricted'));

    assert.deepEqual(await categoriesNamed(owner, 'restricted'), [
      { resourceId: null, scope: 'global' },
      ...[studyA1, studyB2]
        .sort()
        .map((resourceId) => ({ resourceId, scope: 'resource' })),
    ]);
  });

  test('ties a resource category to its resource and a global category to none', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);

    await assert.rejects(
      committedInsert(owner, categories, {
        ...resourceCategoryRow(
          'cohort',
          seededId(seeded.resources, 'STUDY-A1'),
        ),
        [categories.columns.resourceId]: null,
      }),
      violation(INTEGRITY.check),
    );
    await assert.rejects(
      committedInsert(owner, categories, {
        ...globalCategoryRow('cohort'),
        [categories.columns.resourceId]: seededId(seeded.resources, 'STUDY-A1'),
      }),
      violation(INTEGRITY.check),
    );

    assert.deepEqual(await categoriesNamed(owner, 'cohort'), []);
  });

  test('offers a category to a resource once', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const offered = await offeringsOf(owner, studyA1);

    await assert.rejects(
      committedInsert(owner, resourceCategories, {
        [resourceCategories.columns.categoryId]: seededId(
          seeded.categories,
          'controlled',
        ),
        [resourceCategories.columns.resourceId]: studyA1,
      }),
      violation(INTEGRITY.unique),
    );

    assert.deepEqual(await offeringsOf(owner, studyA1), offered);
  });

  test('lets a category be withdrawn from a resource while grants still name it', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const controlled = seededId(seeded.categories, 'controlled');
    const grantBefore = await selectRows(
      owner,
      `SELECT * FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
      [seededId(seeded.grants, 'anaViews')],
    );

    await committedQuery(
      owner,
      `DELETE FROM ${qualified(resourceCategories)} WHERE ${resourceCategories.columns.resourceId} = $1 AND ${resourceCategories.columns.categoryId} = $2`,
      [studyA1, controlled],
    );

    assert.equal(
      (await offeringsOf(owner, studyA1)).includes(controlled),
      false,
    );
    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT * FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
        [seededId(seeded.grants, 'anaViews')],
      ),
      grantBefore,
    );
  });

  test('holds one resource per external identifier whatever its letter case', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const racing = async (
      committing: string,
      racer: string,
    ): Promise<string> => {
      const first = await database.connect('migration');
      const second = await database.connect('migration');
      await first.query('BEGIN');
      await declareActor(first, SYSTEM_ACTOR);
      await insertRow(first, resources, resourceRow(committing, steward));
      await second.query('BEGIN');
      await declareActor(second, SYSTEM_ACTOR);
      const registering = writeOutcome(
        insertRow(second, resources, resourceRow(racer, steward)),
      );
      await untilBlocked(owner, registering);
      await first.query('COMMIT');
      const outcome = await registering;
      await second.query('ROLLBACK');
      await Promise.all([first.end(), second.end()]);
      return outcome;
    };

    const sequential = await writeOutcome(
      committedInsert(owner, resources, resourceRow('study-a1', steward)),
    );
    const raced = [
      await racing('STUDY-D4', 'study-d4'),
      await racing('ÉTUDE-1', 'étude-1'),
    ];

    assert.equal(sequential, INTEGRITY.unique);
    assert.deepEqual(raced, [INTEGRITY.unique, INTEGRITY.unique]);
    assert.deepEqual(await externalIdsLike(owner, 'study-a1'), ['STUDY-A1']);
    assert.deepEqual(await externalIdsLike(owner, 'study-d4'), ['STUDY-D4']);
    assert.deepEqual(await externalIdsLike(owner, 'étude-1'), ['ÉTUDE-1']);
  });

  test('holds only category names a payload can carry', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const refused = [
      globalCategoryRow(''),
      globalCategoryRow('controlled.extra'),
      globalCategoryRow('__proto__'),
      resourceCategoryRow('unmarked', studyA1),
      resourceCategoryRow('cohort.extra', studyA1),
      resourceCategoryRow('', studyA1),
    ];

    const outcomes = await inTurn(refused, (row) =>
      writeOutcome(committedInsert(owner, categories, row)),
    );
    await committedInsert(
      owner,
      categories,
      globalCategoryRow('community-governed'),
    );
    await committedInsert(
      owner,
      categories,
      resourceCategoryRow('restricted', studyA1),
    );

    assert.deepEqual(
      outcomes,
      refused.map(() => INTEGRITY.check),
    );
    assert.equal(
      (await categoriesNamed(owner, 'community-governed')).length,
      1,
    );
    assert.equal((await categoriesNamed(owner, 'restricted')).length, 1);
  });

  test('holds only resource identifiers a payload can carry', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const refused = [
      '',
      '__proto__',
      'A__missing__B',
      ...SPECIAL_VALUE_MARKERS.map((marker) => `STUDY${marker}H8`),
    ];

    const outcomes = await inTurn(refused, (externalId) =>
      writeOutcome(
        committedInsert(owner, resources, resourceRow(externalId, steward)),
      ),
    );
    await committedInsert(owner, resources, resourceRow('study.c_4', steward));

    assert.deepEqual(
      outcomes,
      refused.map(() => INTEGRITY.check),
    );
    assert.deepEqual(await externalIdsLike(owner, 'study.c_4'), ['study.c_4']);
  });

  test("confines a resource category to its own resource's grants and offerings", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const studyB2 = seededId(seeded.resources, 'STUDY-B2');
    const ownCategory = async (name: string): Promise<string> =>
      String(
        (
          await committedInsert(
            owner,
            categories,
            resourceCategoryRow(name, studyA1),
          )
        )[categories.columns.id],
      );
    const restricted = await ownCategory('restricted');
    const cohort = await ownCategory('cohort');
    const unreferenced = await ownCategory('unreferenced');
    const viewing = (
      resourceId: string,
      holder: string,
      recordCategoryId: string,
    ): Row =>
      grantRow({
        grantedBy: steward,
        holderUserId: seededId(seeded.users, holder),
        recordCategoryId,
        resourceId,
        roleId: seededId(seeded.roles, 'viewer'),
      });
    const offering = (resourceId: string): Row => ({
      [resourceCategories.columns.categoryId]: restricted,
      [resourceCategories.columns.resourceId]: resourceId,
    });
    const cyOnStudyB2 = String(
      (
        await committedInsert(
          owner,
          grants,
          viewing(studyB2, 'cy', seededId(seeded.categories, 'unmarked')),
        )
      )[grants.columns.id],
    );

    const refusedInserts = [
      await refusedByStore(
        committedInsert(owner, grants, viewing(studyB2, 'bo', restricted)),
      ),
      await refusedByStore(
        committedInsert(owner, resourceCategories, offering(studyB2)),
      ),
    ];
    await committedInsert(owner, grants, viewing(studyA1, 'cy', restricted));
    await committedInsert(owner, resourceCategories, offering(studyA1));
    const refusedUpdates = await inTurn(
      [
        {
          parameters: [studyB2, restricted],
          text: `UPDATE ${qualified(categories)} SET ${categories.columns.resourceId} = $1 WHERE ${categories.columns.id} = $2`,
        },
        {
          parameters: [studyB2, studyA1, restricted],
          text: `UPDATE ${qualified(resourceCategories)} SET ${resourceCategories.columns.resourceId} = $1 WHERE ${resourceCategories.columns.resourceId} = $2 AND ${resourceCategories.columns.categoryId} = $3`,
        },
        {
          parameters: [restricted, cyOnStudyB2],
          text: `UPDATE ${qualified(grants)} SET ${grants.columns.recordCategoryId} = $1 WHERE ${grants.columns.id} = $2`,
        },
      ],
      ({ parameters, text }) =>
        refusedByStore(committedQuery(owner, text, parameters)),
    );
    const acceptedUpdates = [
      await writeOutcome(
        committedQuery(
          owner,
          `UPDATE ${qualified(resourceCategories)} SET ${resourceCategories.columns.categoryId} = $1 WHERE ${resourceCategories.columns.resourceId} = $2 AND ${resourceCategories.columns.categoryId} = $3`,
          [cohort, studyA1, restricted],
        ),
      ),
      await writeOutcome(
        committedQuery(
          owner,
          `UPDATE ${qualified(categories)} SET ${categories.columns.resourceId} = $1 WHERE ${categories.columns.id} = $2`,
          [studyB2, unreferenced],
        ),
      ),
    ];

    assert.deepEqual(refusedInserts, [true, true]);
    assert.deepEqual(refusedUpdates, [true, true, true]);
    assert.deepEqual(acceptedUpdates, ['accepted', 'accepted']);
    assert.deepEqual(await offeringsOf(owner, studyB2), [
      seededId(seeded.categories, 'unmarked'),
    ]);
    assert.deepEqual(
      await selectRows<{ resourceId: string }>(
        owner,
        `SELECT ${grants.columns.resourceId}::text AS "resourceId" FROM ${qualified(grants)} WHERE ${grants.columns.recordCategoryId} = $1`,
        [restricted],
      ),
      [{ resourceId: studyA1 }],
    );
    assert.deepEqual(
      await selectRows<{ id: string; resourceId: string }>(
        owner,
        `SELECT ${categories.columns.id}::text AS id, ${categories.columns.resourceId}::text AS "resourceId" FROM ${qualified(categories)} WHERE ${categories.columns.id} = ANY ($1) ORDER BY ${categories.columns.name} COLLATE "C"`,
        [[restricted, unreferenced]],
      ),
      [
        { id: restricted, resourceId: studyA1 },
        { id: unreferenced, resourceId: studyB2 },
      ],
    );
  });

  test("keeps a resource's external identifier once registered", async (context) => {
    const { database, owner } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');

    await assert.rejects(
      committedQuery(
        controller,
        `UPDATE ${qualified(resources)} SET ${resources.columns.externalId} = 'STUDY-A1-RENAMED' WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
        [],
        ANA_ACTING,
      ),
      violation(INSUFFICIENT_PRIVILEGE),
    );
    await committedQuery(
      controller,
      `UPDATE ${qualified(resources)} SET ${resources.columns.name} = 'Cardiac Outcomes Registry' WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
      [],
      ANA_ACTING,
    );

    assert.deepEqual(
      await selectRows<{ externalId: string; name: string }>(
        owner,
        `SELECT ${resources.columns.externalId} AS "externalId", ${resources.columns.name} AS name FROM ${qualified(resources)} WHERE lower(${resources.columns.externalId}) LIKE 'study-a1%'`,
      ),
      [{ externalId: 'STUDY-A1', name: 'Cardiac Outcomes Registry' }],
    );
  });
});
