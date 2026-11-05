import { randomBytes } from 'node:crypto';

import pg from 'pg';

import type { StoreReader } from '../managementApi/index.js';
import { APPLICATION_KEY_BYTES } from './applicationKeyCipher.js';
import type {
  ApplicationKeyCipher,
  IssuedApplicationKey,
  StoredApplication,
  StoredApplicationKey,
} from './types.js';

/** The most live keys one application holds at once. */
export const LIVE_KEY_LIMIT = 2;

// An id as the store generates one; any other text names nothing, and is never sent to the store,
// which would refuse it as a uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface IdRow {
  id: string;
}

interface KeyStateRow {
  /** The key's id, as the store gives it. */
  id: string;

  revoked: boolean;
}

type ApplicationRow = Omit<StoredApplication, 'keys'>;

interface NamedRow {
  applicationId: string;
  keyId: string | null;
}

const tableIn =
  (schema: string) =>
  (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;

// The subject of the identity a person acted under, the trusted issuer's first, as an answer names a
// principal: never the person's own id, which never leaves the store.
const subjectOf = (schema: string, person: string): string =>
  `(SELECT identity.idp_subject_id FROM ${tableIn(schema)('user_identities')} identity
     WHERE identity.user_id = ${person}
     ORDER BY identity.idp_issuer = $2 DESC, identity.added_at, identity.id LIMIT 1)`;

/**
 * Inserts an application, the store generating its id.
 *
 * @param connection a connection in the registration's transaction.
 * @param schema the controller's schema.
 * @param application its stored display name and description, and its registration.
 * @returns the application's id.
 */
export const insertApplication = async (
  connection: pg.ClientBase,
  schema: string,
  {
    description,
    displayName,
    registeredAt,
    registeredBy,
  }: {
    description: string | null;
    displayName: string;
    registeredAt: Date;
    registeredBy: string;
  },
): Promise<string> => {
  const { rows } = await connection.query<IdRow>(
    `INSERT INTO ${tableIn(schema)('applications')} (display_name, description, registered_by, registered_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [displayName, description, registeredBy, registeredAt],
  );
  const [application] = rows;
  if (application !== undefined) {
    return application.id;
  }
  throw new Error('the store answered the insert with no row');
};

/**
 * Generates a key for an application and inserts it sealed, the store generating its id first, since
 * the sealed key is bound to it.
 *
 * @param connection a connection in the issue's transaction.
 * @param schema the controller's schema.
 * @param cipher the cipher the key is sealed under.
 * @param issue the application's id as the store gives it, and the key's issue.
 * @returns the key's id and its value.
 */
export const insertKey = async (
  connection: pg.ClientBase,
  schema: string,
  cipher: ApplicationKeyCipher,
  {
    applicationId,
    issuedAt,
    issuedBy,
  }: { applicationId: string; issuedAt: Date; issuedBy: string },
): Promise<IssuedApplicationKey> => {
  const [generated] = (
    await connection.query<IdRow>('SELECT gen_random_uuid()::text AS id')
  ).rows;
  if (generated === undefined) {
    throw new Error('the store generated no id');
  }
  const key = randomBytes(APPLICATION_KEY_BYTES);
  try {
    await connection.query(
      `INSERT INTO ${tableIn(schema)('application_keys')} (id, application_id, encrypted_key, issued_by, issued_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        generated.id,
        applicationId,
        cipher.seal({ applicationId, keyId: generated.id }, key),
        issuedBy,
        issuedAt,
      ],
    );
    return { id: generated.id, value: key.toString('base64url') };
  } finally {
    key.fill(0);
  }
};

/**
 * Locks an application's row for the rest of the transaction, so issues to one application are
 * counted one at a time.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param applicationId the id as sent.
 * @returns the id as the store gives it, or `undefined` when no application has it.
 */
export const lockApplication = async (
  connection: pg.ClientBase,
  schema: string,
  applicationId: string,
): Promise<string | undefined> =>
  UUID.test(applicationId)
    ? (
        await connection.query<IdRow>(
          `SELECT id::text AS id FROM ${tableIn(schema)('applications')} WHERE id = $1 FOR UPDATE`,
          [applicationId],
        )
      ).rows[0]?.id
    : undefined;

/**
 * Counts an application's live keys: those issued and not revoked.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param applicationId the application's id.
 */
export const countLiveKeys = async (
  connection: pg.ClientBase,
  schema: string,
  applicationId: string,
): Promise<number> => {
  const { rows } = await connection.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${tableIn(schema)('application_keys')} WHERE application_id = $1 AND revoked_at IS NULL`,
    [applicationId],
  );
  return rows[0]?.count ?? 0;
};

/**
 * Finds whether an application exists, as the store gives its id.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param applicationId the id as sent.
 * @returns the id as the store gives it, or `undefined` when no application has it.
 */
export const findApplication = async (
  connection: pg.ClientBase,
  schema: string,
  applicationId: string,
): Promise<string | undefined> =>
  UUID.test(applicationId)
    ? (
        await connection.query<IdRow>(
          `SELECT id::text AS id FROM ${tableIn(schema)('applications')} WHERE id = $1`,
          [applicationId],
        )
      ).rows[0]?.id
    : undefined;

/**
 * Locks one of an application's keys for the rest of the transaction, so two revocations of it are
 * judged one after the other.
 *
 * @param connection a connection in a transaction.
 * @param schema the controller's schema.
 * @param key the application's id as the store gives it, and the key's as sent.
 * @returns its id as the store gives it and whether it is revoked, or `undefined` when the application
 *   holds no such key.
 */
export const lockKey = async (
  connection: pg.ClientBase,
  schema: string,
  { applicationId, keyId }: { applicationId: string; keyId: string },
): Promise<KeyStateRow | undefined> =>
  UUID.test(keyId)
    ? (
        await connection.query<KeyStateRow>(
          `SELECT id::text AS id, revoked_at IS NOT NULL AS revoked FROM ${tableIn(schema)('application_keys')} WHERE id = $1 AND application_id = $2 FOR UPDATE`,
          [keyId, applicationId],
        )
      ).rows[0]
    : undefined;

/**
 * Revokes a key, recording who revoked it and when.
 *
 * @param connection a connection in the revocation's transaction.
 * @param schema the controller's schema.
 * @param revocation the key's id, and the revocation.
 */
export const revokeKey = async (
  connection: pg.ClientBase,
  schema: string,
  {
    keyId,
    revokedAt,
    revokedBy,
  }: { keyId: string; revokedAt: Date; revokedBy: string },
): Promise<void> => {
  await connection.query(
    `UPDATE ${tableIn(schema)('application_keys')} SET revoked_at = $2, revoked_by = $3 WHERE id = $1`,
    [keyId, revokedAt, revokedBy],
  );
};

/**
 * Reads an application and every key it was issued, in order of issue, each principal named by the
 * subject of the identity that acted.
 *
 * @param store where it is read.
 * @param schema the controller's schema.
 * @param issuer the trusted issuer, whose identity names a principal holding several.
 * @param applicationId the id as sent.
 */
export const readStoredApplication = async (
  store: StoreReader,
  schema: string,
  issuer: string,
  applicationId: string,
): Promise<StoredApplication | undefined> => {
  const table = tableIn(schema);
  const [application] = UUID.test(applicationId)
    ? (
        await store.query<ApplicationRow>(
          `SELECT application.id::text AS id, application.display_name AS "displayName",
                  application.description, application.registered_at AS "registeredAt",
                  ${subjectOf(schema, 'application.registered_by')} AS "registeredBy"
             FROM ${table('applications')} application WHERE application.id = $1`,
          [applicationId, issuer],
        )
      ).rows
    : [];
  if (application === undefined) {
    return undefined;
  }
  const { rows: keys } = await store.query<StoredApplicationKey>(
    `SELECT held.id::text AS id, held.issued_at AS "issuedAt", held.confirmed_at AS "confirmedAt",
            held.revoked_at AS "revokedAt",
            ${subjectOf(schema, 'held.issued_by')} AS "issuedBy",
            ${subjectOf(schema, 'held.revoked_by')} AS "revokedBy"
       FROM ${table('application_keys')} held WHERE held.application_id = $1
      ORDER BY held.issued_at, held.id`,
    [applicationId, issuer],
  );
  return { ...application, keys };
};

/**
 * The application, and the key of it, that a request names and the store holds, for the event
 * recording the request's refusal: an id naming neither, a malformed one among them, is left out.
 *
 * @param store where they are read.
 * @param schema the controller's schema.
 * @param named the application's id as sent, and the key's, or none.
 */
export const readNamedEntities = async (
  store: StoreReader,
  schema: string,
  {
    applicationId,
    keyId,
  }: { applicationId: string; keyId: string | undefined },
): Promise<{ applicationId?: string; keyId?: string }> => {
  const table = tableIn(schema);
  const [named] = UUID.test(applicationId)
    ? (
        await store.query<NamedRow>(
          `SELECT application.id::text AS "applicationId", held.id::text AS "keyId"
             FROM ${table('applications')} application
             LEFT JOIN ${table('application_keys')} held
               ON held.application_id = application.id AND held.id = $2::uuid
            WHERE application.id = $1`,
          [
            applicationId,
            keyId !== undefined && UUID.test(keyId) ? keyId : null,
          ],
        )
      ).rows
    : [];
  if (named === undefined) {
    return {};
  }
  return named.keyId === null
    ? { applicationId: named.applicationId }
    : { applicationId: named.applicationId, keyId: named.keyId };
};
