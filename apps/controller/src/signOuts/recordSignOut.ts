import pg from 'pg';

import type { AuditTransaction } from '../eventLog/index.js';
import type {
  SignOut,
  SignOutRecordContext,
  SignOutRecording,
} from './types.js';

interface RecordedRow {
  subject: string | null;
}

const tableIn =
  (schema: string) =>
  (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;

// A session's sign-out is kept once, by issuer and session: one delivered again, or relayed through
// another client of the same session, finds it held and writes nothing. A held one that named no
// subject takes the subject a later token names, so the notice owed for that person is still written.
// A session the token names alone reaches the subject an exchange recorded it under.
const sessionSignOut = (schema: string): string => {
  const table = tableIn(schema);
  return `INSERT INTO ${table('sid_sign_outs')} AS held (idp_issuer, sid, idp_subject_id, signed_out_at, expires_at)
    VALUES ($1, $2, coalesce($3::text, (
      SELECT exchanged.idp_subject_id FROM ${table('exchanged_sids')} exchanged
       WHERE exchanged.idp_issuer = $1 AND exchanged.sid = $2
    )), $4, $5)
    ON CONFLICT (idp_issuer, sid) DO UPDATE SET idp_subject_id = EXCLUDED.idp_subject_id
     WHERE held.idp_subject_id IS NULL AND EXCLUDED.idp_subject_id IS NOT NULL
    RETURNING held.idp_subject_id AS subject`;
};

// A subject's sign-out keeps the latest the provider made: an earlier one, or the same one again,
// finds it held and writes nothing, so a repeat never moves the time sign-in tokens are judged by.
const subjectSignOut = (schema: string): string =>
  `INSERT INTO ${tableIn(schema)('subject_sign_outs')} AS held (idp_issuer, idp_subject_id, signed_out_at, expires_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (idp_issuer, idp_subject_id) DO UPDATE SET signed_out_at = EXCLUDED.signed_out_at, expires_at = EXCLUDED.expires_at
     WHERE held.signed_out_at < EXCLUDED.signed_out_at
    RETURNING held.idp_subject_id AS subject`;

const principalNotice = (schema: string): string =>
  `INSERT INTO ${tableIn(schema)('notices')} (kind, idp_subject_id, created_at) VALUES ('principal', $1, clock_timestamp())`;

const signOutStatement = (
  signOut: SignOut,
  { issuer, retentionSeconds, schema }: SignOutRecordContext,
): { text: string; values: readonly unknown[] } => {
  const signedOutAt = new Date(signOut.issuedAt * 1000);
  const endsAt = new Date((signOut.issuedAt + retentionSeconds) * 1000);
  return signOut.kind === 'session'
    ? {
        text: sessionSignOut(schema),
        values: [
          issuer,
          signOut.sessionId,
          signOut.subject ?? null,
          signedOutAt,
          endsAt,
        ],
      }
    : {
        text: subjectSignOut(schema),
        values: [issuer, signOut.subject, signedOutAt, endsAt],
      };
};

/**
 * Records a sign-out the identity provider relayed, in the transaction given: by session, for a
 * token naming a `sid`, so every sign-in token of that session is refused at the exchange; by
 * subject, for one naming a subject alone, so that subject's sign-in tokens issued at or before it
 * are refused. Either is kept from the time the provider signed the person out until the retention
 * given has passed. Every sign-out recorded writes the `identity.signOut` event, its actor the
 * system's, naming the request's address and, as `signedOutUserId`, the subject when one is known;
 * a known subject also gets one principal notice, and a session no exchange carried, naming no one,
 * gets none. A sign-out the store holds already writes nothing more.
 *
 * @param transaction the transaction, its actor the system.
 * @param context the store's schema, the trusted issuer, the retention, and the request's address.
 * @param signOut the sign-out.
 */
export const recordSignOut = async (
  { connection, record }: AuditTransaction<pg.ClientBase>,
  context: SignOutRecordContext,
  signOut: SignOut,
): Promise<SignOutRecording> => {
  const { text, values } = signOutStatement(signOut, context);
  const { rows } = await connection.query<RecordedRow>(text, [...values]);
  const [recorded] = rows;
  if (recorded === undefined) {
    return { kind: 'held' };
  }
  const subject = recorded.subject ?? undefined;
  if (subject !== undefined) {
    await connection.query(principalNotice(context.schema), [subject]);
  }
  await record({
    data: {
      result: 'succeeded',
      ...(subject === undefined ? {} : { signedOutUserId: subject }),
      sourceIp: context.sourceIp,
    },
    severity: 'info',
    type: 'identity.signOut',
  });
  return { kind: 'recorded', subject };
};
