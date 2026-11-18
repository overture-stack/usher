import pg from 'pg';

import { findOrRecordPerson } from '../findOrRecordPerson.js';
import {
  countedOwnerCondition,
  readResourceStanding,
} from '../resourceStanding/index.js';
import type {
  GrantStore,
  StoredDecision,
  StoredGrant,
  StoredRole,
} from './types.js';

// A category as a payload names it: its scope, a dot, and a name holding no dot.
const SCOPED_NAME = /^(?<scope>global|resource)\.(?<name>[^.]+)$/u;

interface IdRow {
  id: string;
}

// A grant's row as read, its latest answer as JSON, whose instant arrives as text.
interface GrantRow extends Omit<StoredGrant, 'decision'> {
  decision: (Omit<StoredDecision, 'decidedAt'> & { decidedAt: string }) | null;
}

/**
 * The grant store over one transaction's connection, every statement binding its values and naming
 * the schema's tables. A person is found by the identity of a subject under the trusted issuer, and
 * named by the subject of their identity under that issuer first.
 *
 * @param connection the transaction's connection.
 * @param settings the Controller's schema and the trusted issuer.
 */
export const sqlGrantStore = (
  connection: pg.ClientBase,
  { issuer, schema }: { issuer: string; schema: string },
): GrantStore => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  // The subject naming the person a column holds, the trusted issuer's identity ($1) first.
  const subjectOf = (column: string): string =>
    `(SELECT identity.idp_subject_id FROM ${table('user_identities')} identity
       WHERE identity.user_id = ${column}
       ORDER BY identity.idp_issuer = $1 DESC, identity.added_at, identity.id LIMIT 1)`;
  const idOf = async (
    text: string,
    values: readonly unknown[],
  ): Promise<string | undefined> =>
    (await connection.query<IdRow>(text, [...values])).rows[0]?.id;

  return {
    appendDecision: async ({
      capabilities,
      decision,
      grantId,
      now,
      userId,
    }) => {
      const { rows } = await connection.query<{ decidedAt: Date }>(
        `INSERT INTO ${table('grant_decisions')}
           (user_id, grant_id, decision, capabilities, decided_at)
         SELECT $1::uuid, $2::uuid, $3::text, $4::text[],
                greatest($5::timestamptz,
                         (SELECT max(earlier.decided_at) + interval '1 millisecond'
                            FROM ${table('grant_decisions')} earlier
                           WHERE earlier.user_id = $1 AND earlier.grant_id = $2))
         RETURNING decided_at AS "decidedAt"`,
        [userId, grantId, decision, [...capabilities], now],
      );
      return rows[0]?.decidedAt ?? now;
    },
    countedOwnersBesides: async ({ grantId, now, resourceId }) => {
      const { rows } = await connection.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table('grants')} owned
          WHERE owned.resource_id = $1 AND owned.id <> $2
            AND ${countedOwnerCondition(schema, 'owned', '$3::timestamptz')}`,
        [resourceId, grantId, now],
      );
      return rows[0]?.count ?? 0;
    },
    endExpiredGrant: async (
      { holderUserId, recordCategoryId, resourceId, roleId },
      now,
    ) =>
      (
        await connection.query(
          `UPDATE ${table('grants')} SET ended_at = $5
            WHERE holder_user_id = $1 AND holder_group_id IS NULL AND resource_id = $2
              AND record_category_id IS NOT DISTINCT FROM $3 AND role_id = $4
              AND revoked_at IS NULL AND ended_at IS NULL
              AND expires_at IS NOT NULL AND expires_at <= $5`,
          [holderUserId, resourceId, recordCategoryId, roleId, now],
        )
      ).rowCount !== 0,
    findOfferedCategory: async (scopedName, resourceId) => {
      const named = SCOPED_NAME.exec(scopedName)?.groups;
      if (named === undefined) {
        return undefined;
      }
      return named['scope'] === 'global'
        ? idOf(
            `SELECT id::text AS id FROM ${table('categories')}
              WHERE scope = 'global' AND name = $1`,
            [named['name']],
          )
        : idOf(
            `SELECT id::text AS id FROM ${table('categories')}
              WHERE scope = 'resource' AND resource_id = $2 AND name = $1`,
            [named['name'], resourceId],
          );
    },
    findOrRecordPerson: (subject, now) =>
      findOrRecordPerson(connection, schema, { issuer, subject }, now),
    findPerson: (subject) =>
      idOf(
        `SELECT user_id::text AS id FROM ${table('user_identities')}
          WHERE idp_issuer = $1 AND idp_subject_id = $2`,
        [issuer, subject],
      ),
    findRole: async (name) =>
      (
        await connection.query<StoredRole>(
          `SELECT role.id::text AS id, role.name, role.plane,
                  ARRAY(SELECT capability.entity || '.' || capability.action
                          FROM ${table('role_permissions')} permission
                          JOIN ${table('capabilities')} capability
                            ON capability.id = permission.capability_id
                         WHERE permission.role_id = role.id
                         ORDER BY (capability.entity || '.' || capability.action) COLLATE "C")
                    AS capabilities
             FROM ${table('roles')} role
            WHERE role.name = $1`,
          [name],
        )
      ).rows[0],
    insertGrant: ({
      expiresAt,
      grantedAt,
      grantedBy,
      holderUserId,
      recordCategoryId,
      resourceId,
      roleId,
    }) =>
      idOf(
        `INSERT INTO ${table('grants')}
           (resource_id, record_category_id, holder_user_id, role_id, granted_by, granted_at,
            expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING RETURNING id::text AS id`,
        [
          resourceId,
          recordCategoryId,
          holderUserId,
          roleId,
          grantedBy,
          grantedAt,
          expiresAt,
        ],
      ),
    locateGrant: async (grantId) =>
      (
        await connection.query<{ externalId: string; resourceId: string }>(
          `SELECT resource.external_id AS "externalId", resource.id::text AS "resourceId"
             FROM ${table('grants')} held
             JOIN ${table('resources')} resource ON resource.id = held.resource_id
            WHERE held.id = $1::uuid AND held.holder_user_id IS NOT NULL`,
          [grantId],
        )
      ).rows[0],
    lockResource: async (resourceId) => {
      await connection.query(
        `SELECT 1 FROM ${table('resources')} WHERE id = $1 FOR NO KEY UPDATE`,
        [resourceId],
      );
    },
    readGrant: async (grantId) => {
      const { rows } = await connection.query<GrantRow>(
        `SELECT CASE WHEN record.id IS NULL THEN NULL ELSE record.scope || '.' || record.name END
                  AS category,
                (SELECT json_build_object('capabilities', answer.capabilities,
                                          'decidedAt', answer.decided_at,
                                          'decision', answer.decision)
                   FROM ${table('grant_decisions')} answer
                  WHERE answer.grant_id = held.id AND answer.user_id = held.holder_user_id
                  ORDER BY answer.decided_at DESC LIMIT 1) AS decision,
                held.ended_at AS "endedAt",
                held.expires_at AS "expiresAt",
                held.granted_at AS "grantedAt",
                ${subjectOf('held.granted_by')} AS "granterSubject",
                ${subjectOf('held.holder_user_id')} AS "holderSubject",
                held.holder_user_id::text AS "holderUserId",
                held.id::text AS id,
                resource.external_id AS resource,
                resource.id::text AS "resourceId",
                resource.retired_at IS NOT NULL AS "resourceRetired",
                held.revoked_at AS "revokedAt",
                ${subjectOf('held.revoked_by')} AS "revokerSubject",
                role.name AS role,
                held.granted_by = held.holder_user_id AS "selfGrant"
           FROM ${table('grants')} held
           JOIN ${table('resources')} resource ON resource.id = held.resource_id
           JOIN ${table('roles')} role ON role.id = held.role_id
           LEFT JOIN ${table('categories')} record ON record.id = held.record_category_id
          WHERE held.id = $2::uuid AND held.holder_user_id IS NOT NULL
          FOR UPDATE OF held`,
        [issuer, grantId],
      );
      const [row] = rows;
      return row === undefined
        ? undefined
        : {
            ...row,
            decision:
              row.decision === null
                ? null
                : {
                    ...row.decision,
                    decidedAt: new Date(row.decision.decidedAt),
                  },
          };
    },
    readStanding: ({ externalId, lock, now, subject }) =>
      readResourceStanding(connection, schema, {
        externalId,
        issuer,
        lock,
        now,
        subject,
      }),
    revokeGrant: async ({ grantId, now, revokedBy }) => {
      await connection.query(
        `UPDATE ${table('grants')} SET revoked_at = $2, revoked_by = $3
          WHERE id = $1 AND revoked_at IS NULL`,
        [grantId, now, revokedBy],
      );
    },
  };
};
