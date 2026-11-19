import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'node:test';

import {
  checksOn,
  committedInsert,
  committedQuery,
  INTEGRITY,
  type InvitationParts,
  invitationRow,
  openSeededDatabase,
  selectRows,
  stewardOf,
  violation,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  inTurn,
  POLICY_TABLES,
  qualified,
  seededId,
  type SeededPolicy,
} from '../../test-support/policy.js';

const { invitations } = POLICY_TABLES;

const ADDRESSES = [
  'Ana.Example@Example.ORG',
  'bo+STUDY-A1@example.org',
  'İnci.Yılmaz@example.org',
  'STRAßE@example.org',
];

const toStudyA1 = (seeded: SeededPolicy, email: string): InvitationParts => ({
  email,
  invitedBy: stewardOf(seeded),
  recordCategoryId: seededId(seeded.categories, 'controlled'),
  resourceId: seededId(seeded.resources, 'STUDY-A1'),
  roleId: seededId(seeded.roles, 'viewer'),
});

suite('invitations', () => {
  test("stores only a hash of an invitation's link, unique across invitations", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const linkTokenHash = randomBytes(32);
    await committedInsert(owner, invitations, {
      ...invitationRow(toStudyA1(seeded, 'ana@example.org')),
      [invitations.columns.linkTokenHash]: linkTokenHash,
    });

    await assert.rejects(
      committedInsert(owner, invitations, {
        ...invitationRow(toStudyA1(seeded, 'bo@example.org')),
        [invitations.columns.linkTokenHash]: linkTokenHash,
      }),
      violation(INTEGRITY.unique),
    );
    await assert.rejects(
      committedInsert(owner, invitations, {
        ...invitationRow(toStudyA1(seeded, 'cy@example.org')),
        [invitations.columns.linkTokenHash]: null,
      }),
      violation(INTEGRITY.notNull),
    );

    assert.deepEqual(
      await selectRows<{ email: string }>(
        owner,
        `SELECT ${invitations.columns.email} AS email FROM ${qualified(invitations)}`,
      ),
      [{ email: 'ana@example.org' }],
    );
  });

  test("stores an invitation's address in lower case", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const { columns } = invitations;
    const lowered = await inTurn(ADDRESSES, async (email) => {
      const [row] = await selectRows<{ lowered: string }>(
        owner,
        'SELECT lower($1) AS lowered',
        [email],
      );
      return row?.lowered ?? email;
    });

    const rawOutcomes = await inTurn(ADDRESSES, (email) =>
      writeOutcome(
        committedInsert(
          owner,
          invitations,
          invitationRow(toStudyA1(seeded, email)),
        ),
      ),
    );
    const storedThroughSql = await inTurn(ADDRESSES, async (email) => {
      const parts = invitationRow(toStudyA1(seeded, email));
      const { rows } = await committedQuery(
        owner,
        `INSERT INTO ${qualified(invitations)} (${columns.email}, ${columns.expiresAt}, ${columns.invitedAt}, ${columns.invitedBy}, ${columns.linkTokenHash}, ${columns.recordCategoryId}, ${columns.resourceId}, ${columns.roleId}) VALUES (lower($1), NULL, now(), $2, $3, $4, $5, $6) RETURNING ${columns.email} AS email`,
        [
          email,
          parts[columns.invitedBy],
          parts[columns.linkTokenHash],
          parts[columns.recordCategoryId],
          parts[columns.resourceId],
          parts[columns.roleId],
        ],
      );
      return rows[0]?.['email'];
    });

    assert.deepEqual(
      rawOutcomes.filter(
        (outcome) => outcome !== 'accepted' && outcome !== INTEGRITY.check,
      ),
      [],
    );
    assert.deepEqual(storedThroughSql, lowered);
    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT ${columns.email} AS email FROM ${qualified(invitations)} WHERE ${columns.email} <> lower(${columns.email})`,
      ),
      [],
    );
    assert.equal(
      (await checksOn(owner, invitations, columns.email)).some((definition) =>
        definition.includes('lower('),
      ),
      true,
    );
  });

  test('promises only a grant the grants table accepts', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const field = seededId(seeded.categories, 'controlled');
    const record = seededId(seeded.categories, 'unmarked');
    const unscoped = (email: string): InvitationParts => ({
      email,
      invitedBy: stewardOf(seeded),
      resourceId: seededId(seeded.resources, 'STUDY-A1'),
      roleId: seededId(seeded.roles, 'viewer'),
    });

    const outcomes = await inTurn(
      [
        invitationRow({
          ...unscoped('ana@example.org'),
          fieldCategoryId: field,
        }),
        invitationRow({
          ...unscoped('bo@example.org'),
          recordCategoryId: record,
        }),
        invitationRow({
          ...unscoped('cy@example.org'),
          fieldCategoryId: field,
          recordCategoryId: record,
        }),
      ],
      (row) => writeOutcome(committedInsert(owner, invitations, row)),
    );

    assert.deepEqual(outcomes, [INTEGRITY.check, 'accepted', 'accepted']);
    assert.deepEqual(
      await selectRows<{ expiresAt: Date | null }>(
        owner,
        `SELECT ${invitations.columns.expiresAt} AS "expiresAt" FROM ${qualified(invitations)}`,
      ),
      [{ expiresAt: null }, { expiresAt: null }],
    );
  });
});
