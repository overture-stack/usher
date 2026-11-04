import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type pg from 'pg';

import {
  ANA_ACTING,
  auditEntryRow,
  type ChangeRecord,
  committedChange,
  committedInsert,
  committedQuery,
  grantRow,
  insertRow,
  isStoreRefusal,
  markStore,
  mayKeepHistory,
  openSeededDatabase,
  recordedChangeKits,
  readChangeRecords,
  refusedByStore,
  resourceRow,
  run,
  selectRows,
  type Statement,
  stewardOf,
  SUBJECTS,
  writtenSince,
} from '../../test-support/fixtures/database.js';
import {
  type Actor,
  declareActor,
  inTurn,
  POLICY_TABLES,
  qualified,
  seededId,
  SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { applicationKeys, auditLog, changeRecords, grants, resources } =
  POLICY_TABLES;

const BO_ACTING: Actor = Object.freeze({ id: SUBJECTS.bo, type: 'human' });

const DESCRIPTION = "L'étude « Nord » \\ 北 \nseconde ligne";

const REVISED_DESCRIPTION = '« Sud » \\\\ 南\r\n"citée" l’étude';

const recordsCount = async (client: pg.ClientBase): Promise<number> =>
  (await readChangeRecords(client)).length;

const isRevoked = async (
  client: pg.ClientBase,
  grantId: string,
): Promise<boolean> =>
  (
    await selectRows<{ revoked: boolean }>(
      client,
      `SELECT ${grants.columns.revokedAt} IS NOT NULL AS revoked FROM ${qualified(grants)} WHERE ${grants.columns.id} = $1`,
      [grantId],
    )
  )[0]?.revoked === true;

const revokeGrant = (
  client: pg.ClientBase,
  grantId: string,
  revokedBy: string,
): Promise<unknown> =>
  client.query(
    `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.id} = $2`,
    [revokedBy, grantId],
  );

interface Attempt {
  accepted: boolean;

  /** The change records the attempt left on its table: none when the store refused it. */
  records: readonly ChangeRecord[];
}

const attempted = async (
  client: pg.ClientBase,
  table: { name: string },
  step: Statement,
): Promise<Attempt> => {
  const marker = await markStore(client);
  const accepted = await committedQuery(
    client,
    step.text,
    step.parameters,
  ).then(
    () => true,
    (error: unknown) => {
      if (isStoreRefusal(error)) {
        return false;
      }
      throw error;
    },
  );
  const { changeRecords: written } = await writtenSince(client, marker);
  return {
    accepted,
    records: written.filter(({ tableName }) => tableName === table.name),
  };
};

const recordedNothing = async (
  client: pg.ClientBase,
  attempt: () => Promise<unknown>,
): Promise<{ recordedNothing: boolean; refused: boolean }> => {
  const marker = await markStore(client);
  const refused = await refusedByStore(attempt());
  const { changeRecords: written } = await writtenSince(client, marker);
  return { recordedNothing: written.length === 0, refused };
};

suite('the change record of every policy change', () => {
  test('records every insert, update and delete on a policy table that the store accepts', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const kits = recordedChangeKits(seeded);

    const summaries = await inTurn(kits, async (kit) => {
      await inTurn(kit.prepare, (step) =>
        committedQuery(owner, step.text, step.parameters),
      );
      const inserted = await attempted(owner, kit.table, kit.insert);
      const updated = await attempted(owner, kit.table, kit.update);
      const deleted = await attempted(owner, kit.table, kit.delete);
      const [insertRecord] = inserted.records;
      const [updateRecord] = updated.records;
      const [deleteRecord] = deleted.records;
      const accepted = [inserted, updated, deleted].filter(
        (attempt) => attempt.accepted,
      );
      const acceptedRecords = accepted.flatMap(({ records }) => records);
      const valuesBeforeDelete = updated.accepted
        ? updateRecord?.newRow
        : insertRecord?.newRow;
      return {
        afterValuesCarried:
          (!updated.accepted ||
            isDeepStrictEqual(updateRecord?.oldRow, insertRecord?.newRow)) &&
          (!deleted.accepted ||
            isDeepStrictEqual(deleteRecord?.oldRow, valuesBeforeDelete)),
        insertAccepted: inserted.accepted,
        oneRecordForEachAccepted: accepted.every(
          ({ records }) => records.length === 1,
        ),
        operationsDistinct:
          new Set(acceptedRecords.map(({ operation }) => operation)).size ===
          acceptedRecords.length,
        refusedOnlyWhereHistoryIsKept:
          (updated.accepted || mayKeepHistory(kit.table, 'update')) &&
          (deleted.accepted || mayKeepHistory(kit.table, 'delete')),
        refusedRecordNothing: [updated, deleted]
          .filter((attempt) => !attempt.accepted)
          .every(({ records }) => records.length === 0),
        rowKeyShared: acceptedRecords.every(
          (record) =>
            record.rowKey !== null &&
            record.rowKey !== undefined &&
            (kit.updateMovesKey ||
              isDeepStrictEqual(record.rowKey, insertRecord?.rowKey)),
        ),
        table: kit.table.name,
        valuesBeforeAndAfter: [
          insertRecord?.oldRow === null && insertRecord.newRow !== null,
          !updated.accepted ||
            (updateRecord?.oldRow !== null &&
              updateRecord?.newRow !== null &&
              !isDeepStrictEqual(updateRecord?.oldRow, updateRecord?.newRow)),
          !deleted.accepted ||
            (deleteRecord?.oldRow !== null && deleteRecord?.newRow === null),
        ],
      };
    });

    assert.deepEqual(
      summaries,
      kits.map(({ table }) => ({
        afterValuesCarried: true,
        insertAccepted: true,
        oneRecordForEachAccepted: true,
        operationsDistinct: true,
        refusedOnlyWhereHistoryIsKept: true,
        refusedRecordNothing: true,
        rowKeyShared: true,
        table: table.name,
        valuesBeforeAndAfter: [true, true, true],
      })),
    );
  });

  test("records an application key's issue, confirmation and revocation without its encrypted_key, in neither its old values nor its new ones", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const keyId = randomUUID();
    const encrypted = randomBytes(60);
    const { columns } = applicationKeys;
    const marker = await markStore(owner);

    await committedInsert(owner, applicationKeys, {
      [columns.applicationId]: seededId(seeded.applications, 'ims-lyric'),
      [columns.encryptedKey]: encrypted,
      [columns.id]: keyId,
      [columns.issuedAt]: new Date(),
      [columns.issuedBy]: steward,
    });
    await committedQuery(
      owner,
      `UPDATE ${qualified(applicationKeys)} SET ${columns.confirmedAt} = now() WHERE ${columns.id} = $1`,
      [keyId],
    );
    await committedQuery(
      owner,
      `UPDATE ${qualified(applicationKeys)} SET ${columns.revokedAt} = now(), ${columns.revokedBy} = $1 WHERE ${columns.id} = $2`,
      [steward, keyId],
    );
    const records = (await writtenSince(owner, marker)).changeRecords.filter(
      ({ tableName }) => tableName === applicationKeys.name,
    );
    const valuesRecorded = records.flatMap(({ newRow, oldRow }) =>
      [oldRow, newRow].flatMap((values) => (values === null ? [] : [values])),
    );
    const recordedText = JSON.stringify(records);

    assert.equal(records.length, 3);
    assert.equal(valuesRecorded.length, 5);
    valuesRecorded.forEach((values) => {
      assert.equal(Object.hasOwn(values, columns.encryptedKey), false);
      assert.equal(values[columns.id], keyId);
    });
    assert.ok(
      valuesRecorded.some((values) => values[columns.confirmedAt] !== null),
    );
    assert.ok(
      valuesRecorded.some((values) => values[columns.revokedAt] !== null),
    );
    [encrypted.toString('hex'), encrypted.toString('base64')].forEach((form) =>
      assert.equal(recordedText.includes(form), false),
    );
  });

  test('records a change in the transaction that makes it', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const writer = await database.connect('migration');
    const grantId = seededId(seeded.grants, 'anaViews');
    const marker = await markStore(owner);
    const seen = async (
      client: pg.ClientBase,
    ): Promise<{ recorded: readonly string[]; revoked: boolean }> => ({
      recorded: (await writtenSince(client, marker)).changeRecords.map(
        ({ tableName }) => tableName,
      ),
      revoked: await isRevoked(client, grantId),
    });

    await writer.query('BEGIN');
    await declareActor(writer, SYSTEM_ACTOR);
    await revokeGrant(writer, grantId, stewardOf(seeded));
    const insideTransaction = await seen(writer);
    const elsewhereBeforeCommit = await seen(owner);
    await writer.query('COMMIT');
    const committed = await seen(owner);

    assert.deepEqual(elsewhereBeforeCommit, { recorded: [], revoked: false });
    assert.deepEqual(committed, insideTransaction);
    assert.deepEqual(committed, { recorded: [grants.name], revoked: true });
  });

  test('leaves no record of a change rolled back', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const writer = await database.connect('migration');
    const recordsBefore = await recordsCount(owner);

    await writer.query('BEGIN');
    await declareActor(writer, SYSTEM_ACTOR);
    await insertRow(
      writer,
      grants,
      grantRow({
        grantedBy: stewardOf(seeded),
        holderUserId: seededId(seeded.users, 'cy'),
        recordCategoryId: seededId(seeded.categories, 'controlled'),
        resourceId: seededId(seeded.resources, 'STUDY-A1'),
        roleId: seededId(seeded.roles, 'viewer'),
      }),
    );
    await writer.query('ROLLBACK');

    assert.equal(await recordsCount(owner), recordsBefore);
  });

  test('records each row a statement changes', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const studyA1 = seededId(seeded.resources, 'STUDY-A1');
    const cyGrant = await committedInsert(
      owner,
      grants,
      grantRow({
        grantedBy: stewardOf(seeded),
        holderUserId: seededId(seeded.users, 'cy'),
        recordCategoryId: seededId(seeded.categories, 'controlled'),
        resourceId: studyA1,
        roleId: seededId(seeded.roles, 'viewer'),
      }),
    );

    const { changeRecords: written } = await committedChange(owner, () =>
      owner.query(
        `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.resourceId} = $2 AND ${grants.columns.revokedAt} IS NULL`,
        [stewardOf(seeded), studyA1],
      ),
    );

    assert.deepEqual(
      written
        .filter(({ tableName }) => tableName === grants.name)
        .map(({ newRow }) => newRow?.[grants.columns.id])
        .sort(),
      [
        seededId(seeded.grants, 'anaViews'),
        seededId(seeded.grants, 'boOwns'),
        String(cyGrant[grants.columns.id]),
      ].sort(),
    );
  });

  test('records a change however it is written', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const controller = await database.connect('runtime');
    const actorsOf = (
      written: readonly ChangeRecord[],
    ): readonly Readonly<Record<string, string | null>>[] =>
      written.map(({ actorId, actorType, tableName }) => ({
        actorId: actorId === '' ? null : actorId,
        actorType,
        tableName,
      }));

    const underMigrationRole = await committedChange(owner, () =>
      owner.query(
        `UPDATE ${qualified(grants)} SET ${grants.columns.expiresAt} = $1 WHERE ${grants.columns.id} = $2`,
        [new Date('2027-06-30T00:00:00Z'), seededId(seeded.grants, 'anaViews')],
      ),
    );
    const underController = await committedChange(
      controller,
      () =>
        revokeGrant(
          controller,
          seededId(seeded.grants, 'anaViews'),
          seededId(seeded.users, 'bo'),
        ),
      BO_ACTING,
    );

    assert.deepEqual(actorsOf(underController.changeRecords), [
      { actorId: SUBJECTS.bo, actorType: 'human', tableName: grants.name },
    ]);
    assert.deepEqual(actorsOf(underMigrationRole.changeRecords), [
      { actorId: null, actorType: 'system', tableName: grants.name },
    ]);
  });

  test('records a change whose values hold quotes, backslashes and non-ASCII text', async (context) => {
    const { owner } = await openSeededDatabase(context);
    await committedQuery(
      owner,
      `UPDATE ${qualified(resources)} SET ${resources.columns.description} = $1 WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
      [DESCRIPTION],
    );

    const {
      changeRecords: [written],
    } = await committedChange(owner, () =>
      owner.query(
        `UPDATE ${qualified(resources)} SET ${resources.columns.description} = $1 WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
        [REVISED_DESCRIPTION],
      ),
    );

    assert.deepEqual(
      {
        after: written?.newRow?.[resources.columns.description],
        before: written?.oldRow?.[resources.columns.description],
      },
      { after: REVISED_DESCRIPTION, before: DESCRIPTION },
    );
  });

  test('records an actor for every policy change', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const kits = recordedChangeKits(seeded);
    const undeclared = await database.connect('migration');

    const refusals = await inTurn(kits, async (kit) => {
      await inTurn(kit.prepare, (step) =>
        committedQuery(owner, step.text, step.parameters),
      );
      const insert = await recordedNothing(owner, () => run(owner, kit.insert));
      await committedQuery(owner, kit.insert.text, kit.insert.parameters);
      const update = await recordedNothing(owner, () => run(owner, kit.update));
      await committedQuery(owner, kit.update.text, kit.update.parameters).catch(
        (error: unknown) => {
          if (!mayKeepHistory(kit.table, 'update')) {
            throw error;
          }
        },
      );
      const deletion = await recordedNothing(owner, () =>
        run(owner, kit.delete),
      );
      return { deletion, insert, table: kit.table.name, update };
    });
    const neverDeclared = await recordedNothing(undeclared, () =>
      insertRow(
        undeclared,
        resources,
        resourceRow('STUDY-N1', stewardOf(seeded)),
      ),
    );
    const byPerson = await committedChange(
      owner,
      () =>
        owner.query(
          `UPDATE ${qualified(resources)} SET ${resources.columns.name} = 'Cardiac Outcomes Registry' WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
        ),
      ANA_ACTING,
    );
    const bySystem = await committedChange(owner, () =>
      owner.query(
        `UPDATE ${qualified(resources)} SET ${resources.columns.name} = 'Members Registry' WHERE ${resources.columns.externalId} = 'STUDY-B2'`,
      ),
    );
    const actors = [byPerson, bySystem].map(({ changeRecords: written }) =>
      written.map(({ actorId, actorType }) => ({
        actorId: actorId === '' ? null : actorId,
        actorType,
      })),
    );

    const refusedUnrecorded = { recordedNothing: true, refused: true };
    assert.deepEqual(
      refusals,
      kits.map(({ table }) => ({
        deletion: refusedUnrecorded,
        insert: refusedUnrecorded,
        table: table.name,
        update: refusedUnrecorded,
      })),
    );
    assert.deepEqual(neverDeclared, refusedUnrecorded);
    assert.deepEqual(actors, [
      [{ actorId: SUBJECTS.ana, actorType: 'human' }],
      [{ actorId: null, actorType: 'system' }],
    ]);
  });

  test('keeps every audit entry and change record exactly as written', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const payload = {
      actorId: SUBJECTS.ana,
      nested: { count: 12_345_678_901_234, quote: "l'accès « contrôlé »" },
      reason: 'policyViolation',
    };
    const entry = auditEntryRow(payload);
    const writtenAt = entry[auditLog.columns.occurredAt];
    const stored = await committedInsert(owner, auditLog, entry);
    const entryId = String(stored[auditLog.columns.id]);
    const {
      changeRecords: [record],
    } = await committedChange(owner, () =>
      owner.query(
        `UPDATE ${qualified(resources)} SET ${resources.columns.description} = $1 WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
        [DESCRIPTION],
      ),
    );
    const [readBack] = await selectRows<{
      data: unknown;
      dataschema: string | null;
      occurredAt: Date;
      severity: string;
      source: string;
      specversion: string;
      type: string;
    }>(
      owner,
      `SELECT ${auditLog.columns.data} AS data, ${auditLog.columns.dataschema} AS dataschema, ${auditLog.columns.occurredAt} AS "occurredAt", ${auditLog.columns.severity} AS severity, ${auditLog.columns.source} AS source, ${auditLog.columns.specversion} AS specversion, ${auditLog.columns.type} AS type FROM ${qualified(auditLog)} WHERE ${auditLog.columns.id} = $1`,
      [entryId],
    );
    const asWritten = async (): Promise<readonly string[]> => [
      ...(
        await selectRows<{ text: string }>(
          owner,
          `SELECT row_to_json(entry)::text AS text FROM ${qualified(auditLog)} entry WHERE ${auditLog.columns.id} = $1`,
          [entryId],
        )
      ).map(({ text }) => text),
      ...(
        await selectRows<{ text: string }>(
          owner,
          `SELECT row_to_json(record)::text AS text FROM ${qualified(changeRecords)} record WHERE ${changeRecords.columns.id} = $1`,
          [record?.id],
        )
      ).map(({ text }) => text),
    ];
    const before = await asWritten();

    await committedQuery(
      owner,
      `UPDATE ${qualified(resources)} SET ${resources.columns.description} = $1 WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
      [REVISED_DESCRIPTION],
    );
    await committedQuery(
      owner,
      `UPDATE ${qualified(grants)} SET ${grants.columns.revokedAt} = now(), ${grants.columns.revokedBy} = $1 WHERE ${grants.columns.resourceId} = $2`,
      [stewardOf(seeded), seededId(seeded.resources, 'STUDY-A1')],
    );
    await committedInsert(
      owner,
      auditLog,
      auditEntryRow({ actorId: SUBJECTS.bo }),
    );

    assert.deepEqual(
      {
        ...readBack,
        occurredAt: readBack?.occurredAt.getTime(),
      },
      {
        data: payload,
        dataschema: entry[auditLog.columns.dataschema],
        occurredAt: writtenAt instanceof Date ? writtenAt.getTime() : writtenAt,
        severity: entry[auditLog.columns.severity],
        source: entry[auditLog.columns.source],
        specversion: entry[auditLog.columns.specversion],
        type: entry[auditLog.columns.type],
      },
    );
    assert.deepEqual(
      {
        after: record?.newRow?.[resources.columns.description],
        before: record?.oldRow?.[resources.columns.description],
      },
      { after: DESCRIPTION, before: null },
    );
    assert.equal(before.length, 2);
    assert.deepEqual(await asWritten(), before);
  });
});
