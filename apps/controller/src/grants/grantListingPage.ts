import pg from 'pg';

import type { StoreReader } from '../managementApi/index.js';
import { countedOwnerCondition } from '../resourceStanding/index.js';
import { viewedGrantColumns, viewedGrantOf, type ViewedGrantRow } from './grantColumns.js';
import type { GrantListing, ListedCapability, ViewedGrant } from './types.js';

/**
 * Whose grants a page lists: those on one resource, by its id; or those one person holds, by their
 * subject, only on resources another person, by subject, is a counted owner of where one is named.
 */
export type GrantListingScope =
	{ kind: 'held'; holderSubject: string; ownerSubject: string | undefined } | { kind: 'on'; resourceId: string };

/** A grant as a listing reads it: as an answer shows it, with what its role confers now. */
export interface ListedGrant extends ViewedGrant {
	/** What its role confers now, ordered by name. */
	capabilities: readonly ListedCapability[];
}

type ListedGrantRow = ViewedGrantRow & {
	capabilities: readonly ListedCapability[];
};

/**
 * Reads one page of the grants held by a person, never a group, in one statement, in the order of
 * their ids, revoked ones left out unless asked for. Those on one resource are read whatever its
 * standing. Those a person holds are found by the identity of their subject under the trusted
 * issuer, one no identity holds holding none; on a retired resource only a revoked one is read, and
 * where an owner is named, only one on a resource they are a counted owner of at the configured
 * clock's instant.
 *
 * @param store where the statement runs, outside any transaction.
 * @param schema the Controller's schema.
 * @param question the page, whether revoked grants are read, the trusted issuer, the configured
 *   clock's instant, and whose grants are read. One grant more than the page holds is read, so the
 *   page knows whether another follows.
 * @returns up to one more grant than the page holds.
 */
export const readGrantPage = async (
	store: StoreReader,
	schema: string,
	{
		after,
		includeRevoked,
		issuer,
		limit,
		now,
		scope,
	}: GrantListing & { issuer: string; now: Date; scope: GrantListingScope },
): Promise<readonly ListedGrant[]> => {
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const held = scope.kind === 'held' ? scope : undefined;
	const { rows } = await store.query<ListedGrantRow>(
		`SELECT ${viewedGrantColumns(schema, '$1')},
            coalesce((SELECT json_agg(json_build_object(
                                'description', capability.description,
                                'displayName', capability.display_name,
                                'name', capability.entity || '.' || capability.action)
                              ORDER BY (capability.entity || '.' || capability.action) COLLATE "C")
                        FROM ${table('role_permissions')} permission
                        JOIN ${table('capabilities')} capability
                          ON capability.id = permission.capability_id
                       WHERE permission.role_id = role.id), '[]'::json) AS capabilities
       FROM ${table('grants')} held
       JOIN ${table('resources')} resource ON resource.id = held.resource_id
       JOIN ${table('roles')} role ON role.id = held.role_id
       LEFT JOIN ${table('categories')} record ON record.id = held.record_category_id
      WHERE held.holder_user_id IS NOT NULL
        AND ($2::uuid IS NULL OR held.resource_id = $2::uuid)
        AND ($3::text IS NULL OR (
              held.holder_user_id IN (
                SELECT identity.user_id FROM ${table('user_identities')} identity
                 WHERE identity.idp_issuer = $1 AND identity.idp_subject_id = $3)
              AND (resource.retired_at IS NULL OR held.revoked_at IS NOT NULL)))
        AND ($4::text IS NULL OR EXISTS (
              SELECT 1 FROM ${table('grants')} owned
                JOIN ${table('user_identities')} owner ON owner.user_id = owned.holder_user_id
               WHERE owned.resource_id = held.resource_id
                 AND owner.idp_issuer = $1 AND owner.idp_subject_id = $4
                 AND ${countedOwnerCondition(schema, 'owned', '$5::timestamptz')}))
        AND ($6::boolean OR held.revoked_at IS NULL)
        AND ($7::text IS NULL OR held.id::text COLLATE "C" > $7::text)
      ORDER BY held.id::text COLLATE "C"
      LIMIT $8`,
		[
			issuer,
			scope.kind === 'on' ? scope.resourceId : null,
			held?.holderSubject ?? null,
			held?.ownerSubject ?? null,
			now,
			includeRevoked,
			after ?? null,
			limit + 1,
		],
	);
	return rows.map(viewedGrantOf);
};

/**
 * Whether a person is a counted owner of any resource at the configured clock's instant, found by
 * the identity of their subject under the trusted issuer; one no identity holds owns nothing.
 *
 * @param store where the statement runs, outside any transaction.
 * @param schema the Controller's schema.
 * @param question the trusted issuer, the person's subject, and the configured clock's instant.
 */
export const ownsAnyResource = async (
	store: StoreReader,
	schema: string,
	{ issuer, now, subject }: { issuer: string; now: Date; subject: string },
): Promise<boolean> => {
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const { rows } = await store.query<{ owns: boolean }>(
		`SELECT EXISTS (
       SELECT 1 FROM ${table('grants')} owned
         JOIN ${table('user_identities')} owner ON owner.user_id = owned.holder_user_id
        WHERE owner.idp_issuer = $1 AND owner.idp_subject_id = $2
          AND ${countedOwnerCondition(schema, 'owned', '$3::timestamptz')}) AS owns`,
		[issuer, subject, now],
	);
	return rows[0]?.owns === true;
};

/**
 * Reads every unrevoked grant held by a person, never a group, on any of the resources given, in
 * one statement, in the order of their ids, each with its resource's id.
 *
 * @param store where the statement runs, outside any transaction.
 * @param schema the Controller's schema.
 * @param question the trusted issuer, and the resources' ids.
 */
export const readGrantsOn = async (
	store: StoreReader,
	schema: string,
	{ issuer, resourceIds }: { issuer: string; resourceIds: readonly string[] },
): Promise<readonly (ViewedGrant & { resourceId: string })[]> => {
	if (resourceIds.length === 0) {
		return [];
	}
	const table = (name: string): string => `${pg.escapeIdentifier(schema)}.${name}`;
	const { rows } = await store.query<ViewedGrantRow & { resourceId: string }>(
		`SELECT ${viewedGrantColumns(schema, '$1')}, held.resource_id::text AS "resourceId"
       FROM ${table('grants')} held
       JOIN ${table('resources')} resource ON resource.id = held.resource_id
       JOIN ${table('roles')} role ON role.id = held.role_id
       LEFT JOIN ${table('categories')} record ON record.id = held.record_category_id
      WHERE held.holder_user_id IS NOT NULL AND held.revoked_at IS NULL
        AND held.resource_id = ANY ($2::uuid[])
      ORDER BY held.id::text COLLATE "C"`,
		[issuer, [...resourceIds]],
	);
	return rows.map(viewedGrantOf);
};
