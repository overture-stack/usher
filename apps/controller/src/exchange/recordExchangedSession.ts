import pg from 'pg';

/** A session a sign-in exchange carried: the trusted issuer, its `sid`, its subject, and its expiry. */
export interface ExchangedSession {
  /** The sign-in token's `exp`, in seconds since the Unix epoch. */
  expiresAt: number;

  issuer: string;
  sid: string;

  /** The sign-in token's `sub`. */
  subject: string;
}

/**
 * Records a session a sign-in exchange carried, in the transaction given: its issuer, its `sid`, its
 * subject and the sign-in token's `exp`. A session recorded already keeps the subject first recorded
 * for it, and the later of its two expiries.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param session the issuer, the `sid`, the subject and the expiry.
 * @throws whatever the store throws.
 */
export const recordExchangedSession = async (
  connection: pg.ClientBase,
  schema: string,
  { expiresAt, issuer, sid, subject }: ExchangedSession,
): Promise<void> => {
  const table = `${pg.escapeIdentifier(schema)}.exchanged_sids`;
  await connection.query(
    `INSERT INTO ${table} AS exchanged (idp_issuer, sid, idp_subject_id, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idp_issuer, sid) DO UPDATE SET expires_at = greatest(exchanged.expires_at, EXCLUDED.expires_at)`,
    [issuer, sid, subject, new Date(expiresAt * 1000)],
  );
};
