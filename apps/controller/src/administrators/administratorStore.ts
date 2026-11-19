import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import { findOrRecordPerson, type PersonIdentity } from '../findOrRecordPerson.js';
import type { AdministratorStatus, StoreReader } from '../managementApi/index.js';
import type { AdministratorStore, ListedNomination, StoredNomination } from './types.js';

/**
 * The key of the transaction-scoped advisory lock every nomination and acceptance takes first, so
 * they run one at a time across the instances sharing a store.
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

// Whether no nomination is later than the one a column names.
const latestOf = (schema: string, alias: string): string =>
	`NOT EXISTS (SELECT 1 FROM ${tableIn(schema)('nominations')} later
                WHERE later.nominated_at > ${alias}.nominated_at)`;

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
 * nominator's subject, its instant and whether it is the latest; none for a person never met.
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
            ${latestOf(schema, 'nomination')} AS latest,
            nomination.nominated_at AS "nominatedAt",
            ${subjectOf(schema, 'nomination.nominated_by')} AS "nominatorSubject"
       FROM ${table('nominations')} nomination
       JOIN ${table('user_identities')} nominee ON nominee.user_id = nomination.nominee_id
      WHERE nominee.idp_issuer = $1 AND nominee.idp_subject_id = $2
      ORDER BY nomination.nominated_at`,
		[issuer, subject],
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
		appendNomination: async ({ nominatedBy, nomineeId, now }) => {
			const { rows } = await connection.query<IdRow & { nominatedAt: Date }>(
				`INSERT INTO ${table('nominations')} (nominee_id, nominated_by, nominated_at)
         SELECT $1::uuid, $2::uuid,
                greatest($3::timestamptz,
                         (SELECT max(earlier.nominated_at) + interval '1 millisecond'
                            FROM ${table('nominations')} earlier))
         RETURNING id::text AS id, nominated_at AS "nominatedAt"`,
				[nomineeId, nominatedBy, now],
			);
			const [written] = rows;
			if (written === undefined) {
				throw new ControllerError('the store recorded no nomination');
			}
			return written;
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
                  ${latestOf(schema, 'nomination')} AS latest,
                  ${subjectOf(schema, 'nomination.nominated_by')} AS "nominatorSubject",
                  nomination.nominee_id AS "nomineeId"
             FROM ${table('nominations')} nomination
            WHERE nomination.id = $2::uuid`,
					[issuer, id],
				)
			).rows[0],
	};
};
