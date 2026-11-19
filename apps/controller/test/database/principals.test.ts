import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type pg from 'pg';

import { untilBlocked } from '../../test-support/database.js';
import {
  ANA_ACTING,
  type ChangeRecord,
  committedChange,
  committedInsert,
  committedPerson,
  committedQuery,
  identityRow,
  insertPerson,
  insertRow,
  INTEGRITY,
  markStore,
  openDatabase,
  openSeededDatabase,
  readPolicyGeneration,
  refusedByStore,
  revocationRow,
  run,
  SECOND_ISSUER,
  selectRows,
  shapeProblems,
  type Statement,
  stewardOf,
  userRow,
  violation,
  writeOutcome,
  writtenSince,
} from '../../test-support/fixtures/database.js';
import {
  type Actor,
  declareActor,
  DEFAULT_FIXTURE_ISSUER,
  inTransactionAs,
  inTurn,
  POLICY_CONSTRAINTS,
  POLICY_TABLES,
  qualified,
  seededId,
  STEWARD_SUBJECT,
  SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { principalRevocations, resources, userIdentities, users } =
  POLICY_TABLES;

const identitiesBySubject = (
  client: pg.ClientBase,
  subjects: readonly string[],
): Promise<readonly { issuer: string; person: string; subject: string }[]> =>
  selectRows<{ issuer: string; person: string; subject: string }>(
    client,
    `SELECT ${userIdentities.columns.idpIssuer} AS issuer, ${userIdentities.columns.userId}::text AS person, ${userIdentities.columns.idpSubjectId} AS subject FROM ${qualified(userIdentities)} WHERE ${userIdentities.columns.idpSubjectId} = ANY ($1) ORDER BY ${userIdentities.columns.idpSubjectId} COLLATE "C", ${userIdentities.columns.idpIssuer} COLLATE "C"`,
    [subjects],
  );

const rowCount = async (
  client: pg.ClientBase,
  table: { name: string },
): Promise<number> =>
  (
    await selectRows<{ count: number }>(
      client,
      `SELECT count(*)::int AS count FROM ${qualified(table)}`,
    )
  )[0]?.count ?? 0;

const revocationsOf = (
  client: pg.ClientBase,
  userId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
  selectRows<Readonly<Record<string, unknown>>>(
    client,
    `SELECT * FROM ${qualified(principalRevocations)} WHERE ${principalRevocations.columns.userId} = $1 ORDER BY ${principalRevocations.columns.revokedAt}`,
    [userId],
  );

// Whoever runs a manual fix: an operator, acting as themself.
const OPERATOR: Actor = Object.freeze({ id: STEWARD_SUBJECT, type: 'human' });

const identityRecords = (
  written: readonly ChangeRecord[],
): readonly Readonly<Record<string, unknown>>[] =>
  written
    .filter(({ tableName }) => tableName === userIdentities.name)
    .map(({ actorId, actorType, newRow, oldRow }) => ({
      actorId: actorId === '' ? null : actorId,
      actorType,
      issuer: newRow?.[userIdentities.columns.idpIssuer],
      subject: newRow?.[userIdentities.columns.idpSubjectId],
      valuesBefore: oldRow,
    }));

suite('principals', () => {
  test("holds each person's identities in a table of their own, as ruled", async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');

    const problems = await shapeProblems(owner);

    assert.deepEqual(
      problems.filter((problem) =>
        [users.name, userIdentities.name].some(
          (table) =>
            problem.startsWith(`${table}.`) ||
            problem === `${table} is missing`,
        ),
      ),
      [],
    );
  });

  test('gives each identity, an issuer and subject together, to one person', async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    const subject = '0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';
    const first = await committedPerson(owner, subject, DEFAULT_FIXTURE_ISSUER);
    const second = await committedPerson(owner, 'auth0|second-person-7c1d');

    await assert.rejects(
      committedInsert(
        owner,
        userIdentities,
        identityRow(second, subject, DEFAULT_FIXTURE_ISSUER),
      ),
      violation(INTEGRITY.unique, POLICY_CONSTRAINTS.identity),
    );
    const underAnotherIssuer = await writeOutcome(
      committedInsert(
        owner,
        userIdentities,
        identityRow(second, subject, SECOND_ISSUER),
      ),
    );
    const aSecondOfTheFirst = await writeOutcome(
      committedInsert(
        owner,
        userIdentities,
        identityRow(first, 'login-subject-of-the-first', SECOND_ISSUER),
      ),
    );

    assert.deepEqual(
      [underAnotherIssuer, aSecondOfTheFirst],
      ['accepted', 'accepted'],
    );
    assert.deepEqual(await identitiesBySubject(owner, [subject]), [
      { issuer: DEFAULT_FIXTURE_ISSUER, person: first, subject },
      { issuer: SECOND_ISSUER, person: second, subject },
    ]);
  });

  test('keeps subjects and issuers exactly as the provider wrote them', async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    const lower = 'f00d-cafe-subject';
    const upper = 'F00D-CAFE-SUBJECT';
    const issuerWithSlash = `${DEFAULT_FIXTURE_ISSUER}/`;
    await committedPerson(owner, lower);

    await committedPerson(owner, upper);
    await committedPerson(owner, lower, issuerWithSlash);

    assert.deepEqual(
      (await identitiesBySubject(owner, [lower, upper])).map(
        ({ issuer, subject }) => ({ issuer, subject }),
      ),
      [
        { issuer: DEFAULT_FIXTURE_ISSUER, subject: upper },
        { issuer: DEFAULT_FIXTURE_ISSUER, subject: lower },
        { issuer: issuerWithSlash, subject: lower },
      ],
    );
  });

  test('leaves one person when two first exchanges of one identity race', async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    const first = await database.connect('migration');
    const second = await database.connect('migration');
    const subject = 'racing-first-meeting-9b3f';
    const persons = await rowCount(owner, users);

    await first.query('BEGIN');
    await declareActor(first, SYSTEM_ACTOR);
    await insertPerson(first, subject);
    await second.query('BEGIN');
    await declareActor(second, SYSTEM_ACTOR);
    const racing = writeOutcome(insertPerson(second, subject));
    await untilBlocked(owner, racing);
    await first.query('COMMIT');
    const raced = await racing;
    await second.query('ROLLBACK');

    assert.equal(raced, INTEGRITY.unique);
    assert.equal((await identitiesBySubject(owner, [subject])).length, 1);
    assert.equal(await rowCount(owner, users), persons + 1);
  });

  test("refuses to commit a person holding no identity, from the migration role, a manual fix as the schema's owner and the controller's runtime role", async (context) => {
    const database = await openDatabase(context);
    const owner = await database.connect('migration');
    const controller = await database.connect('runtime');
    const writers: readonly {
      actor: Actor;
      client: pg.ClientBase;
      subject: string;
    }[] = [
      { actor: SYSTEM_ACTOR, client: owner, subject: 'met-by-the-migration' },
      { actor: OPERATOR, client: owner, subject: 'met-by-a-manual-fix' },
      {
        actor: SYSTEM_ACTOR,
        client: controller,
        subject: 'met-by-the-runtime',
      },
    ];
    const counts = async (): Promise<Readonly<Record<string, number>>> => ({
      identities: await rowCount(owner, userIdentities),
      persons: await rowCount(owner, users),
    });

    const alone = await inTurn(writers, async ({ actor, client }) => {
      const before = await counts();
      const refused = await refusedByStore(
        inTransactionAs(client, actor, () =>
          insertRow(client, users, userRow()),
        ),
      );
      return { refused, unchanged: isDeepStrictEqual(await counts(), before) };
    });
    const withTheirIdentity = await inTurn(
      writers,
      ({ actor, client, subject }) =>
        writeOutcome(
          inTransactionAs(client, actor, () => insertPerson(client, subject)),
        ),
    );

    assert.deepEqual(
      alone,
      writers.map(() => ({ refused: true, unchanged: true })),
    );
    assert.deepEqual(
      withTheirIdentity,
      writers.map(() => 'accepted'),
    );
  });

  test("records each identity written, a first meeting's under the system actor and any other under the actor it declares", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);

    const firstMeeting = await committedChange(owner, () =>
      insertPerson(owner, 'first-met-subject'),
    );
    const added = await committedChange(
      owner,
      () =>
        insertRow(
          owner,
          userIdentities,
          identityRow(
            seededId(seeded.users, 'ana'),
            'ana-at-the-second-provider',
            SECOND_ISSUER,
            stewardOf(seeded),
          ),
        ),
      OPERATOR,
    );

    assert.deepEqual(identityRecords(firstMeeting.changeRecords), [
      {
        actorId: null,
        actorType: 'system',
        issuer: DEFAULT_FIXTURE_ISSUER,
        subject: 'first-met-subject',
        valuesBefore: null,
      },
    ]);
    assert.deepEqual(identityRecords(added.changeRecords), [
      {
        actorId: STEWARD_SUBJECT,
        actorType: 'human',
        issuer: SECOND_ISSUER,
        subject: 'ana-at-the-second-provider',
        valuesBefore: null,
      },
    ]);
  });

  test('refuses an identity write declaring no actor, recording nothing', async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const undeclared = await database.connect('migration');
    const ana = seededId(seeded.users, 'ana');
    await committedInsert(
      owner,
      userIdentities,
      identityRow(ana, 'ana-second-identity', SECOND_ISSUER, stewardOf(seeded)),
      OPERATOR,
    );
    const insertion: Statement = {
      parameters: [ana, 'ana-third-identity', SECOND_ISSUER, new Date()],
      text: `INSERT INTO ${qualified(userIdentities)} (${userIdentities.columns.userId}, ${userIdentities.columns.idpSubjectId}, ${userIdentities.columns.idpIssuer}, ${userIdentities.columns.addedAt}) VALUES ($1, $2, $3, $4)`,
    };
    // Moving an identity to another person changes whose grants its sign-ins reach.
    const writes: readonly Statement[] = [
      insertion,
      {
        parameters: [seededId(seeded.users, 'bo'), 'ana-second-identity'],
        text: `UPDATE ${qualified(userIdentities)} SET ${userIdentities.columns.userId} = $1 WHERE ${userIdentities.columns.idpSubjectId} = $2`,
      },
      {
        parameters: ['ana-second-identity'],
        text: `DELETE FROM ${qualified(userIdentities)} WHERE ${userIdentities.columns.idpSubjectId} = $1`,
      },
    ];
    const identities = (): Promise<readonly unknown[]> =>
      selectRows(
        owner,
        `SELECT * FROM ${qualified(userIdentities)} ORDER BY ${userIdentities.columns.id}`,
      );
    const unrecorded = async (
      attempt: () => Promise<unknown>,
    ): Promise<{ recordedNothing: boolean; refused: boolean }> => {
      const marker = await markStore(owner);
      const before = await identities();
      const refused = await refusedByStore(attempt());
      return {
        recordedNothing:
          (await writtenSince(owner, marker)).changeRecords.length === 0 &&
          isDeepStrictEqual(await identities(), before),
        refused,
      };
    };

    const withoutAnActor = await inTurn(writes, (write) =>
      unrecorded(() => run(owner, write)),
    );
    const neverDeclared = await unrecorded(() => run(undeclared, insertion));
    const declaring = await inTurn(writes, (write) =>
      committedChange(owner, () => run(owner, write), OPERATOR).then(
        ({ changeRecords: written }) => identityRecords(written).length,
      ),
    );

    const refusedUnrecorded = { recordedNothing: true, refused: true };
    assert.deepEqual(
      withoutAnActor,
      writes.map(() => refusedUnrecorded),
    );
    assert.deepEqual(neverDeclared, refusedUnrecorded);
    assert.deepEqual(declaring, [1, 1, 1]);
  });

  test('raises no policy generation for an identity written', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const before = await readPolicyGeneration(owner);

    await committedPerson(owner, 'generation-probe-subject');
    await committedInsert(
      owner,
      userIdentities,
      identityRow(
        seededId(seeded.users, 'ana'),
        'ana-generation-probe',
        SECOND_ISSUER,
        stewardOf(seeded),
      ),
      OPERATOR,
    );
    const afterIdentities = await readPolicyGeneration(owner);
    await committedQuery(
      owner,
      `UPDATE ${qualified(resources)} SET ${resources.columns.name} = 'Cardiac Outcomes Registry' WHERE ${resources.columns.externalId} = 'STUDY-A1'`,
    );
    const afterAPolicyChange = await readPolicyGeneration(owner);

    assert.notEqual(before, undefined);
    assert.equal(afterIdentities, before);
    assert.equal(
      afterAPolicyChange !== undefined &&
        afterIdentities !== undefined &&
        afterAPolicyChange > afterIdentities,
      true,
    );
  });

  test('holds at most one standing revocation per principal', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const cy = seededId(seeded.users, 'cy');
    const first = await committedInsert(
      owner,
      principalRevocations,
      revocationRow({
        revokedAt: new Date('2026-10-01T12:00:00Z'),
        revokedBy: steward,
        userId: cy,
      }),
    );
    const firstId = String(first[principalRevocations.columns.id]);

    await assert.rejects(
      committedInsert(
        owner,
        principalRevocations,
        revocationRow({
          revokedAt: new Date('2026-10-01T13:00:00Z'),
          revokedBy: steward,
          userId: cy,
        }),
      ),
      violation(INTEGRITY.unique),
    );
    await committedQuery(
      owner,
      `UPDATE ${qualified(principalRevocations)} SET ${principalRevocations.columns.liftedAt} = $1, ${principalRevocations.columns.liftedBy} = $2 WHERE ${principalRevocations.columns.id} = $3`,
      [new Date('2026-10-01T18:00:00Z'), steward, firstId],
    );
    const second = await committedInsert(
      owner,
      principalRevocations,
      revocationRow({
        revokedAt: new Date('2026-10-02T12:00:00Z'),
        revokedBy: steward,
        userId: cy,
      }),
    );

    const kept = await revocationsOf(owner, cy);
    assert.deepEqual(
      kept.map((row) => ({
        id: row[principalRevocations.columns.id],
        lifted: row[principalRevocations.columns.liftedAt] !== null,
      })),
      [
        { id: firstId, lifted: true },
        { id: second[principalRevocations.columns.id], lifted: false },
      ],
    );
  });

  test('records who lifted a revocation whenever it records when', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const ana = seededId(seeded.users, 'ana');
    const bo = seededId(seeded.users, 'bo');
    const cy = seededId(seeded.users, 'cy');

    await assert.rejects(
      committedInsert(owner, principalRevocations, {
        ...revocationRow({ revokedBy: steward, userId: ana }),
        [principalRevocations.columns.liftedBy]: steward,
      }),
      violation(INTEGRITY.check),
    );
    await assert.rejects(
      committedInsert(owner, principalRevocations, {
        ...revocationRow({ revokedBy: steward, userId: cy }),
        [principalRevocations.columns.liftedAt]: new Date(),
      }),
      violation(INTEGRITY.check),
    );
    await committedInsert(
      owner,
      principalRevocations,
      revocationRow({
        lifted: { at: new Date(), by: steward },
        revokedBy: steward,
        userId: bo,
      }),
    );

    assert.equal((await revocationsOf(owner, ana)).length, 0);
    assert.equal((await revocationsOf(owner, cy)).length, 0);
    assert.equal((await revocationsOf(owner, bo)).length, 1);
  });

  test("keeps a revocation's lift once recorded", async (context) => {
    const { database, owner, seeded } = await openSeededDatabase(context);
    const steward = stewardOf(seeded);
    const cy = seededId(seeded.users, 'cy');
    const liftedAt = new Date('2026-10-02T12:00:00Z');
    await committedInsert(
      owner,
      principalRevocations,
      revocationRow({
        lifted: { at: liftedAt, by: steward },
        revokedBy: steward,
        userId: cy,
      }),
    );
    const before = await revocationsOf(owner, cy);
    const controller = await database.connect('runtime');
    const rewrites = [
      {
        parameters: [new Date('2026-10-03T12:00:00Z'), cy],
        text: `UPDATE ${qualified(principalRevocations)} SET ${principalRevocations.columns.liftedAt} = $1 WHERE ${principalRevocations.columns.userId} = $2`,
      },
      {
        parameters: [seededId(seeded.users, 'ana'), cy],
        text: `UPDATE ${qualified(principalRevocations)} SET ${principalRevocations.columns.liftedBy} = $1 WHERE ${principalRevocations.columns.userId} = $2`,
      },
      {
        parameters: [cy],
        text: `UPDATE ${qualified(principalRevocations)} SET ${principalRevocations.columns.liftedAt} = NULL, ${principalRevocations.columns.liftedBy} = NULL WHERE ${principalRevocations.columns.userId} = $1`,
      },
    ];

    const attempts = [owner, controller].flatMap((client) =>
      rewrites.map((rewrite) => ({ client, rewrite })),
    );

    const outcomes = await inTurn(attempts, ({ client, rewrite }) =>
      refusedByStore(
        committedQuery(client, rewrite.text, rewrite.parameters, ANA_ACTING),
      ),
    );

    assert.deepEqual(
      outcomes,
      attempts.map(() => true),
    );
    assert.deepEqual(await revocationsOf(owner, cy), before);
  });
});
