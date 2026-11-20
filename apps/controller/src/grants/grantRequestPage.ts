import pg from 'pg';

import type { StoreReader } from '../managementApi/index.js';
import { countedOwnerCondition } from '../resourceStanding/index.js';
import type { GrantRequestListing, ViewedGrantRequest } from './types.js';

/**
 * The columns, in SQL, giving a grant request as {@link ViewedGrantRequest} holds it, from a
 * statement naming the request `request`, its resource `resource`, its role `role` and its record
 * category, left joined, `record`; the principal who asked for it is named by the subject of their
 * identity under the trusted issuer first, bound at the placeholder given.
 *
 * @param schema the controller's schema.
 * @param issuer the placeholder the trusted issuer is bound to, such as `$1`.
 */
export const requestColumns = (schema: string, issuer: string): string =>
	`CASE WHEN record.id IS NULL THEN NULL ELSE record.scope || '.' || record.name END
     AS category,
   request.decided_at AS "decidedAt",
   request.decision,
   request.expires_at AS "expiresAt",
   request.grant_id::text AS "grantId",
   request.id::text AS id,
   request.kind,
   request.requested_at AS "requestedAt",
   (SELECT identity.idp_subject_id FROM ${pg.escapeIdentifier(schema)}.user_identities identity
     WHERE identity.user_id = request.requested_by
     ORDER BY identity.idp_issuer = ${issuer} DESC, identity.added_at, identity.id LIMIT 1)
     AS "requestedBySubject",
   resource.external_id AS resource,
   role.name AS role`;

/**
 * Reads one page of the grant requests a principal is listed, in one statement, in the order of
 * their ids: those on a resource not retired that the principal asked for, in any state, and those
 * undecided and not lapsed on the configured clock that the principal may decide, neither asked for
 * by them nor held by them, on a resource they are a counted owner of, or on any resource for a
 * platform administrator. The principal is the person holding the identity of their subject under
 * the trusted issuer; a subject no identity holds asked for nothing and owns nothing.
 *
 * @param store where the statement runs, outside any transaction.
 * @param schema the controller's schema.
 * @param question the trusted issuer, the principal's subject and whether they are a platform
 *   administrator, the configured clock's instant, and the page: the id it begins after, and the
 *   most requests on it, one more read so the page knows whether another follows.
 * @returns up to one more request than the page holds.
 */
export const readGrantRequestPage = async (
	store: StoreReader,
	schema: string,
	{
		administrator,
		after,
		issuer,
		limit,
		now,
		subject,
	}: GrantRequestListing & {
		administrator: boolean;
		issuer: string;
		now: Date;
		subject: string;
	},
): Promise<readonly ViewedGrantRequest[]> => {
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const { rows } = await store.query<ViewedGrantRequest>(
		`WITH caller AS (
       SELECT identity.user_id FROM ${table('user_identities')} identity
        WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
     )
     SELECT ${requestColumns(schema, '$1')}
       FROM ${table('grant_requests')} request
       JOIN ${table('resources')} resource ON resource.id = request.resource_id
       JOIN ${table('roles')} role ON role.id = request.role_id
       LEFT JOIN ${table('categories')} record ON record.id = request.record_category_id
      WHERE resource.retired_at IS NULL
        AND ($5::text IS NULL OR request.id::text COLLATE "C" > $5::text)
        AND (
          request.requested_by IN (SELECT user_id FROM caller)
          OR (
            request.decision IS NULL AND request.expires_at > $3::timestamptz
            AND request.requested_by NOT IN (SELECT user_id FROM caller)
            AND request.holder_user_id NOT IN (SELECT user_id FROM caller)
            AND (
              $4::boolean
              OR EXISTS (
                SELECT 1 FROM ${table('grants')} owned
                 WHERE owned.resource_id = resource.id
                   AND owned.holder_user_id IN (SELECT user_id FROM caller)
                   AND ${countedOwnerCondition(schema, 'owned', '$3::timestamptz')}
              )
            )
          )
        )
      ORDER BY request.id::text COLLATE "C"
      LIMIT $6`,
		[issuer, subject, now, administrator, after ?? null, limit + 1],
	);
	return rows;
};
