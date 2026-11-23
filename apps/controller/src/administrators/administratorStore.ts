import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import { findOrRecordPerson, type PersonIdentity } from '../findOrRecordPerson.js';
import type { AdministratorStatus, StoreReader } from '../managementApi/index.js';
import type { AdministratorStore, ListedNomination, NominationRecord, StoredNomination } from './types.js';

/**
 * The key of the transaction-scoped advisory lock every nomination and answer takes first, so they
 * run one at a time across the instances sharing a store.
 */
export const NOMINATIONS_LOCK = 8_617_207_005;

const tableIn =
	(schema: string) =>
	(name: string): string =>
		`${pg.escapeIdentifier(schema)}.${name}`;

// The subject naming the person a column holds, the trusted issuer's identity ($1) first.
const subjectOf = (schema: string, column: string): string =>
	`(SELECT identity.idp_subject_id FROM ${tableIn(schema)('user_identities')} identity
     WHERE identity.user_id = ${column}
     ORDER BY identity.idp_issuer = $1 DESC, identity.added_at, identity.id LIMIT 1)`;

// The answers a nomination may hold, each joined beside it as `held`, `declined` and `revoked`: at
// most one of the three exists for any nomination the store writes.
const answersOf = (schema: string): string => {
	const table = tableIn(schema);
	return `LEFT JOIN ${table('administrators')} held ON held.nomination_id = nomination.id
       LEFT JOIN ${table('nomination_declines')} declined ON declined.nomination_id = nomination.id
       LEFT JOIN ${table('nomination_revocations')} revoked ON revoked.nomination_id = nomination.id`;
};

// A nomination's state, as the answers joined by answersOf and the later nominations give it, in the
// order the state is derived.
const stateOf = (schema: string): string =>
	`CASE
       WHEN held.nomination_id IS NOT NULL THEN 'accepted'
       WHEN declined.nomination_id IS NOT NULL THEN 'declined'
       WHEN revoked.nomination_id IS NOT NULL THEN 'revoked'
       WHEN EXISTS (SELECT 1 FROM ${tableIn(schema)('nominations')} later
                     WHERE later.nominated_at > nomination.nominated_at) THEN 'replaced'
       ELSE 'pending'
     END`;

interface IdRow {
	id: string;
}

/**
 * Reads the admin status of the person holding an identity: whether Usher has an administrator yet,
 * and whether that person is one. It reads the store each time it is asked.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 * @param identity the trusted issuer and the principal's subject.
 */
export const readAdministratorStatus = async (
	store: StoreReader,
	schema: string,
	{ issuer, subject }: PersonIdentity,
): Promise<AdministratorStatus> => {
	const table = tableIn(schema);
	const { rows } = await store.query<AdministratorStatus>(
		`SELECT EXISTS (
              SELECT 1 FROM ${table('administrators')} held
                JOIN ${table('user_identities')} identity ON identity.user_id = held.user_id
               WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $2
            ) AS administrator,
            EXISTS (SELECT 1 FROM ${table('administrators')}) AS "anyAdministrator"`,
		[issuer, subject],
	);
	return {
		administrator: rows[0]?.administrator === true,
		anyAdministrator: rows[0]?.anyAdministrator === true,
	};
};

/**
 * Lists the nominations naming the person holding an identity, oldest first, each by its id, its
 * nominator's subject, its instant and its state; none for a person never met.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 * @param identity the trusted issuer and the nominee's subject.
 */
export const listNominations = async (
	store: StoreReader,
	schema: string,
	{ issuer, subject }: PersonIdentity,
): Promise<readonly ListedNomination[]> => {
	const table = tableIn(schema);
	const { rows } = await store.query<ListedNomination>(
		`SELECT nomination.id::text AS id,
            nomination.nominated_at AS "nominatedAt",
            ${subjectOf(schema, 'nomination.nominated_by')} AS "nominatorSubject",
            ${stateOf(schema)} AS state
       FROM ${table('nominations')} nomination
       ${answersOf(schema)}
       JOIN ${table('user_identities')} nominee ON nominee.user_id = nomination.nominee_id
      WHERE nominee.idp_issuer = $1 AND nominee.idp_subject_id = $2
      ORDER BY nomination.nominated_at`,
		[issuer, subject],
	);
	return rows;
};

/**
 * Whether any administrator has accepted, read from the store outside any transaction: the first
 * check of a nomination, which the transaction holding the nominations lock repeats.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 */
export const administratorExistsOn = async (store: StoreReader, schema: string): Promise<boolean> => {
	const { rows } = await store.query<{ administratorExists: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM ${tableIn(schema)('administrators')}) AS "administratorExists"`,
	);
	return rows[0]?.administratorExists === true;
};

/**
 * Whether Usher has met the person holding an identity, read from the store outside any transaction:
 * a person met is one with an identity under the trusted issuer.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 * @param identity the trusted issuer and the subject.
 */
export const isPersonMet = async (
	store: StoreReader,
	schema: string,
	{ issuer, subject }: PersonIdentity,
): Promise<boolean> => {
	const { rows } = await store.query<{ met: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM ${tableIn(schema)('user_identities')}
                     WHERE idp_issuer = $1 AND idp_subject_id = $2) AS met`,
		[issuer, subject],
	);
	return rows[0]?.met === true;
};

/**
 * Lists every nomination, oldest first, each with its nominee and nominator by subject, its instant,
 * its state, and the instant it was answered or revoked where it was.
 *
 * @param store the store reader.
 * @param schema the Controller's schema.
 * @param issuer the trusted issuer the subjects are read under.
 */
export const listEveryNomination = async (
	store: StoreReader,
	schema: string,
	issuer: string,
): Promise<readonly NominationRecord[]> => {
	const { rows } = await store.query<NominationRecord>(
		`SELECT nomination.id::text AS id,
            nomination.nominated_at AS "nominatedAt",
            ${subjectOf(schema, 'nomination.nominated_by')} AS "nominatorSubject",
            ${subjectOf(schema, 'nomination.nominee_id')} AS "nomineeSubject",
            ${stateOf(schema)} AS state,
            coalesce(held.accepted_at, declined.declined_at) AS "decidedAt",
            revoked.revoked_at AS "revokedAt"
       FROM ${tableIn(schema)('nominations')} nomination
       ${answersOf(schema)}
      ORDER BY nomination.nominated_at`,
		[issuer],
	);
	return rows;
};

/**
 * The administrator store over one transaction's connection, every statement binding its values and
 * naming the schema's tables.
 *
 * @param connection the transaction's connection.
 * @param settings the Controller's schema and the trusted issuer.
 */
export const sqlAdministratorStore = (
	connection: pg.ClientBase,
	{ issuer, schema }: { issuer: string; schema: string },
): AdministratorStore => {
	const table = tableIn(schema);
	return {
		administratorExists: async () =>
			(
				await connection.query<{ exists: boolean }>(
					`SELECT EXISTS (SELECT 1 FROM ${table('administrators')}) AS exists`,
				)
			).rows[0]?.exists === true,
		appendNomination: async ({ nominatedBy, nomineeUserId, now }) => {
			const { rows } = await connection.query<IdRow & { nominatedAt: Date }>(
				`INSERT INTO ${table('nominations')} (nominee_id, nominated_by, nominated_at)
         SELECT $1::uuid, $2::uuid,
                greatest($3::timestamptz,
                         (SELECT max(earlier.nominated_at) + interval '1 millisecond'
                            FROM ${table('nominations')} earlier))
         RETURNING id::text AS id, nominated_at AS "nominatedAt"`,
				[nomineeUserId, nominatedBy, now],
			);
			const [written] = rows;
			if (written === undefined) {
				throw new ControllerError('the store recorded no nomination');
			}
			return written;
		},
		declineNomination: async ({ nominationId, now }) => {
			await connection.query(
				`INSERT INTO ${table('nomination_declines')} (nomination_id, declined_at) VALUES ($1, $2)`,
				[nominationId, now],
			);
		},
		findOrRecordPerson: (subject, now) => findOrRecordPerson(connection, schema, { issuer, subject }, now),
		findPerson: async (subject) =>
			(
				await connection.query<IdRow>(
					`SELECT user_id AS id FROM ${table('user_identities')}
            WHERE idp_issuer = $1 AND idp_subject_id = $2`,
					[issuer, subject],
				)
			).rows[0]?.id,
		insertAdministrator: async ({ acceptedAt, nominationId, userId }) => {
			await connection.query(
				`INSERT INTO ${table('administrators')} (user_id, nomination_id, accepted_at)
         VALUES ($1, $2, $3)`,
				[userId, nominationId, acceptedAt],
			);
		},
		lockNominations: async () => {
			await connection.query('SELECT pg_advisory_xact_lock($1)', [NOMINATIONS_LOCK]);
		},
		readNomination: async (id) =>
			(
				await connection.query<StoredNomination>(
					`SELECT nomination.id::text AS id,
                  nomination.nominated_at AS "nominatedAt",
                  ${subjectOf(schema, 'nomination.nominated_by')} AS "nominatorSubject",
                  ${subjectOf(schema, 'nomination.nominee_id')} AS "nomineeSubject",
                  nomination.nominee_id AS "nomineeUserId",
                  ${stateOf(schema)} AS state,
                  coalesce(held.accepted_at, declined.declined_at) AS "decidedAt",
                  revoked.revoked_at AS "revokedAt"
             FROM ${table('nominations')} nomination
             ${answersOf(schema)}
            WHERE nomination.id = $2::uuid`,
					[issuer, id],
				)
			).rows[0],
		revokeNomination: async ({ nominationId, now }) => {
			await connection.query(
				`INSERT INTO ${table('nomination_revocations')} (nomination_id, revoked_at) VALUES ($1, $2)`,
				[nominationId, now],
			);
		},
	};
};
