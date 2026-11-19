import pg from 'pg';

import type { StandingQuestion, StoredRefusal, StoreReader } from './types.js';

interface StandingRow {
  revoked: boolean;
  revokedPlatform: boolean;
  signedOut: boolean;
}

const standingQuery = (schema: string): string => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  return `
  SELECT EXISTS (
           SELECT 1 FROM ${table('user_identities')} identity
             JOIN ${table('principal_revocations')} revocation
               ON revocation.user_id = identity.user_id AND revocation.lifted_at IS NULL
            WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
         ) AS revoked,
         EXISTS (
           SELECT 1 FROM ${table('global_revocations')}
            WHERE $4::timestamptz IS NULL OR $4::timestamptz < revoked_at
         ) AS "revokedPlatform",
         EXISTS (SELECT 1 FROM ${table('sid_sign_outs')} WHERE idp_issuer = $1 AND sid = $3)
           OR EXISTS (
                SELECT 1 FROM ${table('subject_sign_outs')}
                 WHERE idp_issuer = $1 AND idp_subject_id = $2
                   AND ($4::timestamptz IS NULL OR $4::timestamptz <= signed_out_at)
              ) AS "signedOut"`;
};

/**
 * Reads whether the store refuses a principal: a standing revocation of the person holding the
 * identity; a revocation of the whole platform after the token was issued; or a sign-out the
 * identity provider relayed for the token's session, or for its subject at or after the second the
 * token was issued, in that order when more than one holds. A token naming no `iat` is read as
 * issued before every platform revocation and every sign-out of its subject, and one naming no
 * `sid` as of no session signed out.
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
  if (standing?.revoked === true) {
    return 'revokedPrincipal';
  }
  if (standing?.revokedPlatform === true) {
    return 'revokedPlatform';
  }
  return standing?.signedOut === true ? 'signedOutSession' : undefined;
};
