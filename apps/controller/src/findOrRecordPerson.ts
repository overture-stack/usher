import pg from 'pg';

import { ControllerError } from './controllerError.js';

/** The identity a person is found by: the identity provider's issuer and its subject for them. */
export interface PersonIdentity {
  /** The issuer, exactly as its tokens name it. */
  issuer: string;

  /** The subject, the token's `sub`. */
  subject: string;
}

const UNIQUE_VIOLATION = '23505';

const FIRST_MEETING = 'first_meeting';

interface PersonRow {
  id: string;
}

const codeOf = (failure: unknown): unknown =>
  typeof failure === 'object' && failure !== null && 'code' in failure
    ? failure.code
    : undefined;

/**
 * Finds the person holding an identity, or records a person and that identity on first meeting
 * them, in the transaction given, so whatever the transaction records points at them. The person and
 * their identity are written together, Usher the one recording the identity; when a transaction
 * meeting the same identity commits first, this one finds the person it recorded instead.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param identity the issuer and subject.
 * @param recordedAt when the person is met, for a first meeting.
 * @returns the person's `users.id`, which never leaves the store.
 */
export const findOrRecordPerson = async (
  connection: pg.ClientBase,
  schema: string,
  { issuer, subject }: PersonIdentity,
  recordedAt: Date,
): Promise<string> => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  const found = async (): Promise<string | undefined> =>
    (
      await connection.query<PersonRow>(
        `SELECT user_id AS id FROM ${table('user_identities')} WHERE idp_issuer = $1 AND idp_subject_id = $2`,
        [issuer, subject],
      )
    ).rows[0]?.id;
  const existing = await found();
  if (existing !== undefined) {
    return existing;
  }
  await connection.query(`SAVEPOINT ${FIRST_MEETING}`);
  try {
    const { rows } = await connection.query<PersonRow>(
      `INSERT INTO ${table('users')} (created_at) VALUES ($1) RETURNING id`,
      [recordedAt],
    );
    const [person] = rows;
    if (person === undefined) {
      throw new ControllerError('the store recorded no person');
    }
    await connection.query(
      `INSERT INTO ${table('user_identities')} (user_id, idp_issuer, idp_subject_id, added_at) VALUES ($1, $2, $3, $4)`,
      [person.id, issuer, subject, recordedAt],
    );
    await connection.query(`RELEASE SAVEPOINT ${FIRST_MEETING}`);
    return person.id;
  } catch (failure) {
    if (codeOf(failure) === UNIQUE_VIOLATION) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${FIRST_MEETING}`);
      const recorded = await found();
      if (recorded !== undefined) {
        return recorded;
      }
    }
    throw failure;
  }
};
