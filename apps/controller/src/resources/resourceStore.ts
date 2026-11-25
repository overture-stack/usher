import pg from 'pg';

import type { StoreReader } from '../managementApi/index.js';
import { letterCaseKey } from '../store/index.js';
import {
	countedOwnerCondition,
	latestDecisionOf,
	liveGrantCondition,
	type ResourceStanding,
	standingColumns,
} from '../resourceStanding/index.js';
import type { ListingQuery, Registration, StoredResource } from './types.js';

// An id as the store generates one; any other text names no application, and is never sent to the
// store, which would refuse it as a uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface IdRow {
	id: string;
}

interface NamedRow {
	applicationId: string | null;
	externalId: string | null;
}

const tableIn =
	(schema: string) =>
	(name: string): string =>
		`${pg.escapeIdentifier(schema)}.${name}`;

// Whether an id is shaped as the store writes an application's.
const isApplicationIdForm = (id: string): boolean => UUID.test(id);

// Every member of a resource's answer, each principal named by the subject of the identity that
// acted, the trusted issuer's ($1) first, and its grant summary at the configured clock's instant,
// bound at the placeholder given. Each list is sorted, so two reads of one resource agree.
const resourceColumns = (schema: string, now: string): string => {
	const table = tableIn(schema);
	return `resource.base_tier AS "accessLevel",
          ARRAY(SELECT served.application_id::text FROM ${table('application_resources')} served
                 WHERE served.resource_id = resource.id
                 ORDER BY served.application_id::text COLLATE "C") AS applications,
          ARRAY(SELECT 'resource.' || own.name FROM ${table('categories')} own
                 WHERE own.scope = 'resource' AND own.resource_id = resource.id
                 ORDER BY own.name COLLATE "C") AS categories,
          resource.description,
          resource.name AS "displayName",
          resource.external_id AS "externalId",
          coalesce((SELECT json_object_agg(field.name, held.value ORDER BY field.name COLLATE "C")
                      FROM ${table('resource_field_values')} held
                      JOIN ${table('resource_fields')} field ON field.id = held.field_id
                     WHERE held.resource_id = resource.id), '{}'::json) AS fields,
          coalesce((SELECT json_object_agg(counted.role, counted.holders
                                           ORDER BY counted.role COLLATE "C")
                      FROM (SELECT role.name AS role,
                                   count(DISTINCT held.holder_user_id)::int AS holders
                              FROM ${table('grants')} held
                              JOIN ${table('roles')} role ON role.id = held.role_id
                             WHERE held.resource_id = resource.id
                               AND held.holder_user_id IS NOT NULL
                               AND ${liveGrantCondition('held', now)}
                               AND ${latestDecisionOf(schema, 'held')} = 'accepted'
                             GROUP BY role.name) counted), '{}'::json) AS "grantSummary",
          resource.registered_at AS "registeredAt",
          (SELECT identity.idp_subject_id FROM ${table('user_identities')} identity
            WHERE identity.user_id = resource.registered_by
            ORDER BY identity.idp_issuer = $1 DESC, identity.added_at, identity.id LIMIT 1) AS "registeredBy",
          resource.retired_at IS NOT NULL AS retired,
          resource.suppressed,
          resource.updated_at AS "updatedAt"`;
};

/**
 * Reads one resource by its externalId, matched exactly, with one principal's standing on it, in
 * one statement, so the two come from one snapshot. Whether the principal may see it is not judged
 * here.
 *
 * @param store where it is read.
 * @param schema the Controller's schema.
 * @param read the externalId as sent, the trusted issuer, whose identity names a principal holding
 *   several and under whose identity the principal is found, the principal's subject, and the
 *   configured clock's instant.
 * @returns the resource and the standing, or `undefined` when no resource has the externalId.
 */
export const readResource = async (
	store: StoreReader,
	schema: string,
	{ externalId, issuer, now, subject }: { externalId: string; issuer: string; now: Date; subject: string },
): Promise<(ResourceStanding & StoredResource) | undefined> => {
	const { rows } = await store.query<ResourceStanding & StoredResource>(
		`SELECT ${resourceColumns(schema, '$3::timestamptz')},
            resource.id::text AS id,
            ${standingColumns(schema, {
				issuer: '$1::text',
				now: '$3::timestamptz',
				subject: '$4::text',
			})}
       FROM ${tableIn(schema)('resources')} resource
      WHERE resource.external_id = $2`,
		[issuer, externalId, now, subject],
	);
	return rows[0];
};

/**
 * Reads one page of the resources listed, in the stable order of their externalIds in any letter
 * case, starting after the externalId the query names, retired ones left out unless the query asks
 * for them: every resource, or, where an owner is named, those the person holding the owner's
 * identity under the trusted issuer is a counted owner of at the configured clock's instant. One
 * resource more than the page holds is read, so the caller can tell whether another page follows.
 *
 * @param store where they are read.
 * @param schema the Controller's schema.
 * @param query where the page starts, its size, and whether it lists retired resources, with the
 *   trusted issuer, whose identity names a principal holding several, the configured clock's instant,
 *   and the owner's subject or none, naming the owner whose resources are listed.
 */
export const readResourcePage = async (
	store: StoreReader,
	schema: string,
	{
		after,
		includeRetired,
		issuer,
		limit,
		now,
		ownerSubject,
	}: ListingQuery & {
		issuer: string;
		now: Date;
		ownerSubject: string | undefined;
	},
): Promise<readonly (StoredResource & { id: string })[]> => {
	const table = tableIn(schema);
	const key = letterCaseKey('resource.external_id');
	const { rows } = await store.query<StoredResource & { id: string }>(
		`SELECT ${resourceColumns(schema, '$5::timestamptz')}, resource.id::text AS id
       FROM ${table('resources')} resource
      WHERE ($2::boolean OR resource.retired_at IS NULL)
        AND ($3::text IS NULL OR ${key} > ${letterCaseKey('$3::text')})
        AND ($6::text IS NULL OR EXISTS (
              SELECT 1 FROM ${table('grants')} owned
                JOIN ${table('user_identities')} owner ON owner.user_id = owned.holder_user_id
               WHERE owned.resource_id = resource.id
                 AND owner.idp_issuer = $1 AND owner.idp_subject_id = $6
                 AND ${countedOwnerCondition(schema, 'owned', '$5::timestamptz')}))
      ORDER BY ${key}
      LIMIT $4`,
		[issuer, includeRetired, after ?? null, limit + 1, now, ownerSubject ?? null],
	);
	return rows;
};

/**
 * The applications among those named that are registered, by the ids the store gives them, each
 * once: an id naming none, a malformed one among them, is left out.
 *
 * @param connection a connection in the registration's transaction.
 * @param schema the Controller's schema.
 * @param ids the ids sent.
 */
export const registeredApplications = async (
	connection: pg.ClientBase,
	schema: string,
	ids: readonly string[],
): Promise<readonly string[]> => {
	const wellFormed = ids.filter(isApplicationIdForm);
	return wellFormed.length === 0
		? []
		: (
				await connection.query<IdRow>(
					`SELECT id::text AS id FROM ${tableIn(schema)('applications')}
            WHERE id = ANY ($1::uuid[]) ORDER BY id::text COLLATE "C"`,
					[wellFormed],
				)
			).rows.map(({ id }) => id);
};

/**
 * Inserts a resource, unless one holds its externalId in some letter case, a retired one included:
 * a registration racing another for it waits until that one ends, and writes nothing once it commits.
 *
 * @param connection a connection in the registration's transaction.
 * @param schema the Controller's schema.
 * @param resource what is registered, when, and by whom.
 * @returns the resource's id, which never leaves the store's own statements, or `undefined` when the
 *   externalId is held already.
 */
export const insertResource = async (
	connection: pg.ClientBase,
	schema: string,
	{
		accessLevel,
		description,
		displayName,
		externalId,
		registeredAt,
		registeredBy,
	}: Omit<Registration, 'applications'> & {
		registeredAt: Date;
		registeredBy: string;
	},
): Promise<string | undefined> =>
	(
		await connection.query<IdRow>(
			`INSERT INTO ${tableIn(schema)('resources')}
         (external_id, name, description, base_tier, registered_by, registered_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT DO NOTHING RETURNING id::text AS id`,
			[externalId, displayName, description, accessLevel, registeredBy, registeredAt],
		)
	).rows[0]?.id;

/**
 * Finds a resource by its externalId, matched exactly.
 *
 * @param connection a connection in a transaction.
 * @param schema the Controller's schema.
 * @param externalId the externalId as sent.
 * @returns its id and its externalId as stored, or `undefined` when no resource has it.
 */
export const findResource = async (
	connection: pg.ClientBase,
	schema: string,
	externalId: string,
): Promise<{ externalId: string; id: string } | undefined> =>
	(
		await connection.query<{ externalId: string; id: string }>(
			`SELECT id::text AS id, external_id AS "externalId" FROM ${tableIn(schema)('resources')}
        WHERE external_id = $1`,
			[externalId],
		)
	).rows[0];

/**
 * Adds applications to a resource's served set, in order of their ids, each one it holds already
 * left as it is.
 *
 * @param connection a connection in the change's transaction.
 * @param schema the Controller's schema.
 * @param served the resource's id, and the applications' ids as the store gives them.
 * @returns the applications added, in order of their ids: none for each the set held already.
 */
export const serveResource = async (
	connection: pg.ClientBase,
	schema: string,
	{ applicationIds, resourceId }: { applicationIds: readonly string[]; resourceId: string },
): Promise<readonly string[]> =>
	applicationIds.length === 0
		? []
		: (
				await connection.query<IdRow>(
					`INSERT INTO ${tableIn(schema)('application_resources')} (application_id, resource_id)
           SELECT named.id, $2::uuid FROM unnest($1::uuid[]) AS named (id) ORDER BY named.id
           ON CONFLICT DO NOTHING RETURNING application_id::text AS id`,
					[applicationIds, resourceId],
				)
			).rows
				.map(({ id }) => id)
				.toSorted();

/**
 * Removes one application from a resource's served set.
 *
 * @param connection a connection in the change's transaction.
 * @param schema the Controller's schema.
 * @param served the resource's id, and the application's id as the store gives it.
 * @returns whether the set held the application.
 */
export const stopServingResource = async (
	connection: pg.ClientBase,
	schema: string,
	{ applicationId, resourceId }: { applicationId: string; resourceId: string },
): Promise<boolean> =>
	(
		await connection.query(
			`DELETE FROM ${tableIn(schema)('application_resources')}
        WHERE application_id = $1 AND resource_id = $2`,
			[applicationId, resourceId],
		)
	).rowCount === 1;

/**
 * The resource and the application a serving change names and the store holds, for the event
 * recording its refusal: an identifier naming neither, a malformed application id among them, is
 * left out.
 *
 * @param store where they are read.
 * @param schema the Controller's schema.
 * @param named the resource's externalId as sent, and the application's id.
 */
export const readNamedServing = async (
	store: StoreReader,
	schema: string,
	{ applicationId, externalId }: { applicationId: string; externalId: string },
): Promise<{ applicationId?: string; resourceId?: string }> => {
	const table = tableIn(schema);
	const [named = { applicationId: null, externalId: null }] = (
		await store.query<NamedRow>(
			`SELECT (SELECT external_id FROM ${table('resources')} WHERE external_id = $1) AS "externalId",
              (SELECT id::text FROM ${table('applications')} WHERE id = $2::uuid) AS "applicationId"`,
			[externalId, isApplicationIdForm(applicationId) ? applicationId : null],
		)
	).rows;
	return {
		...(named.applicationId === null ? {} : { applicationId: named.applicationId }),
		...(named.externalId === null ? {} : { resourceId: named.externalId }),
	};
};
