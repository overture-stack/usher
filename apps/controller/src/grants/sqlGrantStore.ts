import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import { findOrRecordPerson } from '../findOrRecordPerson.js';
import { countedOwnerCondition, liveGrantCondition, readResourceStanding } from '../resourceStanding/index.js';
import { letterCaseKey } from '../store/index.js';
import { viewedGrantColumns, viewedGrantOf, type ViewedGrantRow } from './grantColumns.js';
import { requestColumns } from './grantRequestPage.js';
import type { GrantStore, StoredGrant, StoredGrantRequest, StoredRole } from './types.js';

const requestUnwritten = (): never => {
	throw new ControllerError('the store wrote no grant request, and named none');
};

// A category as a payload names it: its scope, a dot, and a name holding no dot.
const SCOPED_NAME = /^(?<scope>global|resource)\.(?<name>[^.]+)$/u;

interface IdRow {
	id: string;
}

// A grant's row as read, its latest answer as JSON, whose instant arrives as text.
type GrantRow = Omit<StoredGrant, 'decision'> & ViewedGrantRow;

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
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const idOf = async (text: string, values: readonly unknown[]): Promise<string | undefined> =>
		(await connection.query<IdRow>(text, [...values])).rows[0]?.id;

	return {
		appendDecision: async ({ capabilities, decision, grantId, now, userId }) => {
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
		changeGrant: async ({ expiresAt, grantId, roleId }) => {
			await connection.query(`UPDATE ${table('grants')} SET expires_at = $2, role_id = $3 WHERE id = $1`, [
				grantId,
				expiresAt,
				roleId,
			]);
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
		countedOwnersOf: async ({ now, resourceId }) =>
			(
				await connection.query<IdRow>(
					`SELECT DISTINCT owned.holder_user_id::text AS id FROM ${table('grants')} owned
            WHERE owned.resource_id = $1
              AND ${countedOwnerCondition(schema, 'owned', '$2::timestamptz')}
            ORDER BY id`,
					[resourceId, now],
				)
			).rows.map(({ id }) => id),
		endExpiredGrant: async ({ holderUserId, recordCategoryId, resourceId, roleId }, now) =>
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
			const { rows } = await connection.query<{ id: string; scopedName: string }>(
				`SELECT id::text AS id, scope || '.' || name AS "scopedName" FROM ${table('categories')}
          WHERE scope = $1 AND resource_id IS NOT DISTINCT FROM $2::uuid
            AND ${letterCaseKey('name')} = ${letterCaseKey('$3::text')}`,
				[named['scope'], named['scope'] === 'global' ? null : resourceId, named['name']],
			);
			return rows[0];
		},
		findOrRecordPerson: (subject, now) => findOrRecordPerson(connection, schema, { issuer, subject }, now),
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
		holdsLiveGrant: async ({ holderUserId, recordCategoryId, resourceId, roleId }, now) =>
			(
				await connection.query(
					`SELECT 1 FROM ${table('grants')} held
            WHERE held.holder_user_id = $1 AND held.resource_id = $2
              AND held.record_category_id IS NOT DISTINCT FROM $3 AND held.role_id = $4
              AND ${liveGrantCondition('held', '$5::timestamptz')}`,
					[holderUserId, resourceId, recordCategoryId, roleId, now],
				)
			).rowCount !== 0,
		holdsPendingRequest: async ({ holderUserId, kind, now, recordCategoryId, requestedBy, resourceId, roleId }) =>
			(
				await connection.query(
					`SELECT 1 FROM ${table('grant_requests')} asked
            WHERE asked.requested_by = $1 AND asked.holder_user_id = $2
              AND asked.kind = $3 AND asked.resource_id = $4
              AND asked.record_category_id IS NOT DISTINCT FROM $5 AND asked.role_id = $6
              AND asked.decision IS NULL AND asked.expires_at > $7`,
					[requestedBy, holderUserId, kind, resourceId, recordCategoryId, roleId, now],
				)
			).rowCount !== 0,
		insertGrant: ({
			expiresAt,
			grantedAt,
			grantedBy,
			holderUserId,
			recordCategoryId,
			requestedBy,
			resourceId,
			roleId,
		}) =>
			idOf(
				`INSERT INTO ${table('grants')}
           (resource_id, record_category_id, holder_user_id, role_id, granted_by, granted_at,
            expires_at, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING RETURNING id::text AS id`,
				[resourceId, recordCategoryId, holderUserId, roleId, grantedBy, grantedAt, expiresAt, requestedBy],
			),
		insertGrantRequest: async ({
			capabilities,
			expiresAt,
			holderUserId,
			kind,
			recordCategoryId,
			requestedAt,
			requestedBy,
			resourceId,
			roleId,
		}) => {
			const id = await idOf(
				`INSERT INTO ${table('grant_requests')}
           (kind, requested_by, holder_user_id, resource_id, record_category_id, role_id,
            expires_at, capabilities, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9)
         RETURNING id::text AS id`,
				[
					kind,
					requestedBy,
					holderUserId,
					resourceId,
					recordCategoryId,
					roleId,
					expiresAt,
					[...capabilities],
					requestedAt,
				],
			);
			return id ?? requestUnwritten();
		},
		liveGrantIdsOf: async ({ holderUserId, now, resourceId, roleId }) =>
			(
				await connection.query<IdRow>(
					`SELECT held.id::text AS id FROM ${table('grants')} held
            WHERE held.holder_user_id = $1 AND held.resource_id = $2 AND held.role_id = $3
              AND ${liveGrantCondition('held', '$4::timestamptz')}
            ORDER BY held.granted_at, held.id
              FOR UPDATE`,
					[holderUserId, resourceId, roleId, now],
				)
			).rows.map(({ id }) => id),
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
		locateGrantRequest: async (requestId) =>
			(
				await connection.query<{ resourceId: string }>(
					`SELECT resource_id::text AS "resourceId" FROM ${table('grant_requests')}
            WHERE id = $1::uuid`,
					[requestId],
				)
			).rows[0],
		lockResource: async (resourceId) => {
			await connection.query(`SELECT 1 FROM ${table('resources')} WHERE id = $1 FOR NO KEY UPDATE`, [resourceId]);
		},
		readGrant: async (grantId) => {
			const { rows } = await connection.query<GrantRow>(
				`SELECT ${viewedGrantColumns(schema, '$1')},
                held.holder_user_id::text AS "holderUserId",
                resource.id::text AS "resourceId",
                resource.retired_at IS NOT NULL AS "resourceRetired",
                CASE WHEN held.requested_by = held.holder_user_id
                     THEN coalesce((SELECT asked.requested_at FROM ${table('grant_requests')} asked
                                     WHERE asked.grant_id = held.id),
                                   held.granted_at)
                     WHEN held.granted_by = held.holder_user_id THEN held.granted_at
                END AS "selfGrantSince"
           FROM ${table('grants')} held
           JOIN ${table('resources')} resource ON resource.id = held.resource_id
           JOIN ${table('roles')} role ON role.id = held.role_id
           LEFT JOIN ${table('categories')} record ON record.id = held.record_category_id
          WHERE held.id = $2::uuid AND held.holder_user_id IS NOT NULL
          FOR UPDATE OF held`,
				[issuer, grantId],
			);
			const [row] = rows;
			return row === undefined ? undefined : viewedGrantOf(row);
		},
		readGrantRequest: async (requestId) =>
			(
				await connection.query<StoredGrantRequest>(
					`SELECT ${requestColumns(schema, '$1')},
                  request.capabilities,
                  request.holder_user_id::text AS "holderUserId",
                  request.record_category_id::text AS "recordCategoryId",
                  request.requested_by::text AS "requestedBy",
                  resource.id::text AS "resourceId",
                  resource.retired_at IS NOT NULL AS "resourceRetired",
                  role.id::text AS "roleId"
             FROM ${table('grant_requests')} request
             JOIN ${table('resources')} resource ON resource.id = request.resource_id
             JOIN ${table('roles')} role ON role.id = request.role_id
             LEFT JOIN ${table('categories')} record ON record.id = request.record_category_id
            WHERE request.id = $2::uuid
            FOR UPDATE OF request`,
					[issuer, requestId],
				)
			).rows[0],
		readStanding: ({ externalId, lock, now, subject }) =>
			readResourceStanding(connection, schema, {
				externalId,
				issuer,
				lock,
				now,
				subject,
			}),
		recordDecision: async ({ decidedAt, decidedBy, decision, grantId, requestId }) => {
			await connection.query(
				`UPDATE ${table('grant_requests')}
            SET decided_at = $2, decided_by = $3, decision = $4, grant_id = $5
          WHERE id = $1 AND decision IS NULL`,
				[requestId, decidedAt, decidedBy, decision, grantId],
			);
		},
		revokeGrant: async ({ grantId, now, revokedBy }) => {
			await connection.query(
				`UPDATE ${table('grants')} SET revoked_at = $2, revoked_by = $3
          WHERE id = $1 AND revoked_at IS NULL`,
				[grantId, now, revokedBy],
			);
		},
		writeNotifications: async ({ createdAt, kind, recipients, reference }) => {
			await connection.query(
				`INSERT INTO ${table('notification_outbox')}
           (kind, grant_id, request_id, recipient_user_id, created_at)
         SELECT $1, CASE WHEN $1 = 'selfGrant' THEN $2::uuid END,
                CASE WHEN $1 = 'grantRequest' THEN $2::uuid END, recipient, $4
           FROM unnest($3::uuid[]) AS recipient`,
				[kind, reference, [...recipients], createdAt],
			);
		},
	};
};
