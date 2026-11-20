import pg from 'pg';

import type { StoredDecision, ViewedGrant } from './types.js';

/** A grant's row as read with {@link viewedGrantColumns}: its latest answer as JSON. */
export type ViewedGrantRow = Omit<ViewedGrant, 'decision'> & {
	decision: (Omit<StoredDecision, 'decidedAt'> & { decidedAt: string }) | null;
};

/**
 * The columns, in SQL, giving a grant as {@link ViewedGrant} holds it, from a statement naming the
 * grant `held`, its resource `resource`, its role `role` and its record category, left joined,
 * `record`. Each person is named by the subject of their identity under the trusted issuer first,
 * bound at the placeholder given. The holder's latest answer arrives as JSON, read with {@link
 * viewedGrantOf}.
 *
 * @param schema the Controller's schema.
 * @param issuer the placeholder the trusted issuer is bound to, such as `$1`.
 */
export const viewedGrantColumns = (schema: string, issuer: string): string => {
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const subjectOf = (column: string): string =>
		`(SELECT identity.idp_subject_id FROM ${table('user_identities')} identity
       WHERE identity.user_id = ${column}
       ORDER BY identity.idp_issuer = ${issuer} DESC, identity.added_at, identity.id LIMIT 1)`;
	return `CASE WHEN record.id IS NULL THEN NULL ELSE record.scope || '.' || record.name END
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
          held.id::text AS id,
          resource.external_id AS resource,
          held.revoked_at AS "revokedAt",
          ${subjectOf('held.revoked_by')} AS "revokerSubject",
          role.name AS role,
          (held.granted_by = held.holder_user_id
           OR held.requested_by IS NOT DISTINCT FROM held.holder_user_id) AS "selfGrant"`;
};

/**
 * A grant's row read with {@link viewedGrantColumns}, its latest answer's instant read as one.
 *
 * @param row the row, with any further columns, which are kept.
 */
export const viewedGrantOf = <Row extends ViewedGrantRow>(
	row: Row,
): Omit<Row, 'decision'> & Pick<ViewedGrant, 'decision'> => ({
	...row,
	decision: row.decision === null ? null : { ...row.decision, decidedAt: new Date(row.decision.decidedAt) },
});
