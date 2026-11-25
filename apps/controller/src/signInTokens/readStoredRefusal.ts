import pg from 'pg';

import type { StandingQuestion, StoredRefusal, StoreReader } from './types.js';

interface StandingRow {
	liftedSince: boolean;
	revoked: boolean;
	signedOutEveryone: boolean;
	signedOut: boolean;
}

const standingQuery = (schema: string): string => {
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	return `
  SELECT EXISTS (
           SELECT 1 FROM ${table('user_identities')} identity
             JOIN ${table('principal_revocations')} revocation
               ON revocation.user_id = identity.user_id AND revocation.lifted_at IS NULL
            WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
         ) AS revoked,
         EXISTS (
           SELECT 1 FROM ${table('principal_revocations')} revocation
             JOIN ${table('user_identities')} identity ON identity.user_id = revocation.user_id
            WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
              AND revocation.lifted_at IS NOT NULL
              AND ($4::timestamptz IS NULL OR $4::timestamptz <= revocation.lifted_at)
         ) AS "liftedSince",
         EXISTS (
           SELECT 1 FROM ${table('everyone_sign_outs')}
            WHERE $4::timestamptz IS NULL OR $4::timestamptz < signed_out_at
         ) AS "signedOutEveryone",
         EXISTS (SELECT 1 FROM ${table('sid_sign_outs')} WHERE idp_issuer = $1 AND sid = $3)
           OR EXISTS (
                SELECT 1 FROM ${table('subject_sign_outs')}
                 WHERE idp_issuer = $1 AND idp_subject_id = $2
                   AND ($4::timestamptz IS NULL OR $4::timestamptz <= signed_out_at)
              ) AS "signedOut"`;
};

/**
 * Reads whether the store refuses a principal: a standing revocation of the person holding the
 * identity, or a lifted one the token was issued at or before; a sign-out of everyone recorded
 * after the token was issued; or a sign-out the identity provider relayed for the token's session,
 * or for its subject at or after the second the token was issued, in that order when more than one
 * holds. A lift needs a fresh sign-in: `lifted_at` is read on the store's clock and the token's `iat`
 * on the identity provider's, so a sign-in a few seconds after a lift can be refused when the
 * provider's clock runs behind, and the person signs in again. A token naming no `iat` is read as
 * issued before every sign-out of everyone, every sign-out of its subject and every lift of the
 * person's revocation, and one naming no `sid` as of no session signed out.
 *
 * @param store where the revocations and sign-outs are read.
 * @param schema the Controller's schema.
 * @param identity the trusted issuer, the token's subject, and its session.
 */
export const readStoredRefusal = async (
	store: StoreReader,
	schema: string,
	{ issuer, session, subject }: StandingQuestion,
): Promise<StoredRefusal | undefined> => {
	const { rows } = await store.query<StandingRow>(standingQuery(schema), [
		issuer,
		subject,
		session.sid ?? null,
		session.issuedAt === undefined ? null : new Date(session.issuedAt * 1000),
	]);
	const [standing] = rows;
	if (standing?.revoked === true || standing?.liftedSince === true) {
		return 'revokedPrincipal';
	}
	if (standing?.signedOutEveryone === true) {
		return 'signedOutEveryone';
	}
	return standing?.signedOut === true ? 'signedOutSession' : undefined;
};
