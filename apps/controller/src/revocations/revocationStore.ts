import pg from 'pg';

import type { PrincipalRevocationRecord, RevocationStore } from './types.js';

const tableIn =
	(schema: string) =>
	(name: string): string =>
		`${pg.escapeIdentifier(schema)}.${name}`;

interface RevocationRow {
	reason: string;
	revokedAt: Date;
}

/**
 * Creates the SQL store of the revocations, over one transaction's connection, every statement binding its
 * values and naming the schema's tables. A principal revocation is written `ON CONFLICT` on the partial unique
 * index of standing revocations, so the store itself refuses a second standing revocation of one person, even
 * one a concurrent change is still writing. A lift keeps the row it lifts.
 *
 * @param connection the transaction's connection.
 * @param schema the Controller's schema.
 */
export const sqlRevocationStore = (connection: pg.ClientBase, schema: string): RevocationStore => {
	const table = tableIn(schema);
	const standingOf = async (userId: string): Promise<PrincipalRevocationRecord | undefined> =>
		(
			await connection.query<RevocationRow>(
				`SELECT reason, revoked_at AS "revokedAt" FROM ${table('principal_revocations')}
                 WHERE user_id = $1::uuid AND lifted_at IS NULL`,
				[userId],
			)
		).rows[0];
	return {
		liftPrincipal: async (userId, { liftedAt, liftedBy }) =>
			(
				await connection.query<RevocationRow>(
					`UPDATE ${table('principal_revocations')} SET lifted_by = $2::uuid, lifted_at = $3
                     WHERE user_id = $1::uuid AND lifted_at IS NULL
                     RETURNING reason, revoked_at AS "revokedAt"`,
					[userId, liftedBy, liftedAt],
				)
			).rows[0],
		recordSignOutEveryone: async ({ reason, signedOutAt, signedOutBy }) => {
			await connection.query(
				`INSERT INTO ${table('everyone_sign_outs')} (signed_out_by, signed_out_at, reason_code) VALUES ($1::uuid, $2, $3)`,
				[signedOutBy, signedOutAt, reason],
			);
		},
		recordPrincipal: async ({ reason, revokedAt, revokedBy, userId }) => {
			const { rows } = await connection.query<{ id: string }>(
				`INSERT INTO ${table('principal_revocations')} (user_id, revoked_by, revoked_at, reason)
                 VALUES ($1::uuid, $2::uuid, $3, $4)
                 ON CONFLICT (user_id) WHERE lifted_at IS NULL DO NOTHING
                 RETURNING id`,
				[userId, revokedBy, revokedAt, reason],
			);
			return rows[0] !== undefined;
		},
		standingOf,
	};
};
