import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import type {
  AudiencePolicy,
  PrincipalPolicy,
  ReachingGrant,
  ServedResource,
} from './types.js';

interface PolicyRow {
  globalCategories: readonly string[];
  served: readonly ServedResource[];
}

interface PrincipalPolicyRow extends PolicyRow {
  grants: readonly ReachingGrant[];
}

const tablesIn =
  (schema: string) =>
  (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;

// The global categories, and every resource served by the audience bound as $1.
const offeringColumns = (table: (name: string) => string): string => `
  ARRAY(
    SELECT category.name FROM ${table('categories')} category
     WHERE category.scope = 'global'
     ORDER BY category.name
  ) AS "globalCategories",
  coalesce((
    SELECT json_agg(json_build_object(
             'baseTier', resource.base_tier,
             'externalId', resource.external_id,
             'ownCategories', ARRAY(
               SELECT own.name FROM ${table('categories')} own
                WHERE own.scope = 'resource' AND own.resource_id = resource.id
                ORDER BY own.name
             ),
             'retired', resource.retired_at IS NOT NULL,
             'suppressed', resource.suppressed
           ) ORDER BY resource.external_id)
      FROM ${table('application_resources')} served
      JOIN ${table('resources')} resource ON resource.id = served.resource_id
     WHERE served.application_id = $1::uuid
  ), '[]'::json) AS served`;

// A category a grant names, by scope and name, or null where it names none.
const namedCategory = (alias: string): string =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('name', ${alias}.name, 'scope', ${alias}.scope) END`;

// Every unrevoked grant held by the person bound as $2, directly or through a group they belong to, on a
// resource served by the audience bound as $1, with the person's own latest decision on it and what its
// role carries. A grant has one holder and a person belongs to a group once, so no grant is read twice.
const grantsColumn = (table: (name: string) => string): string => `
  coalesce((
    SELECT json_agg(json_build_object(
             'expiresAt', extract(epoch FROM held.expires_at) * 1000,
             'externalId', resource.external_id,
             'fieldCategory', ${namedCategory('field_category')},
             'latestDecision', (
               SELECT json_build_object('capabilities', answer.capabilities, 'decision', answer.decision)
                 FROM ${table('grant_decisions')} answer
                WHERE answer.grant_id = held.id AND answer.user_id = $2::uuid
                ORDER BY answer.decided_at DESC
                LIMIT 1
             ),
             'plane', role.plane,
             'recordCategory', ${namedCategory('record_category')},
             'roleCapabilities', ARRAY(
               SELECT capability.entity || '.' || capability.action
                 FROM ${table('role_permissions')} permission
                 JOIN ${table('capabilities')} capability ON capability.id = permission.capability_id
                WHERE permission.role_id = role.id
                ORDER BY 1
             )
           ) ORDER BY resource.external_id, held.id)
      FROM (
        SELECT direct.id, direct.resource_id, direct.record_category_id, direct.field_category_id,
               direct.role_id, direct.expires_at
          FROM ${table('grants')} direct
         WHERE direct.holder_user_id = $2::uuid AND direct.revoked_at IS NULL
        UNION ALL
        SELECT grouped.id, grouped.resource_id, grouped.record_category_id, grouped.field_category_id,
               grouped.role_id, grouped.expires_at
          FROM ${table('grants')} grouped
          JOIN ${table('group_users')} membership ON membership.group_id = grouped.holder_group_id
         WHERE membership.user_id = $2::uuid AND grouped.revoked_at IS NULL
      ) held
      JOIN ${table('application_resources')} serving
        ON serving.resource_id = held.resource_id AND serving.application_id = $1::uuid
      JOIN ${table('resources')} resource ON resource.id = held.resource_id
      JOIN ${table('roles')} role ON role.id = held.role_id
      LEFT JOIN ${table('categories')} record_category ON record_category.id = held.record_category_id
      LEFT JOIN ${table('categories')} field_category ON field_category.id = held.field_category_id
  ), '[]'::json) AS grants`;

// One statement, so every part of the read comes from one snapshot: a resource retired or suppressed
// meanwhile is read as it stood beside the categories read with it.
const policyQuery = (schema: string): string =>
  `SELECT ${offeringColumns(tablesIn(schema))}`;

// One statement, so a grant, a decision, a membership or a role changed meanwhile is read as it stood
// beside the resources and categories read with it.
const principalPolicyQuery = (schema: string): string => {
  const table = tablesIn(schema);
  return `SELECT ${offeringColumns(table)}, ${grantsColumn(table)}`;
};

/**
 * Reads what the calculation needs of the store for one audience, in one statement so all of it comes
 * from one snapshot: the name of every global category, and every resource the audience serves, retired
 * ones included, each with its base tier, whether it is suppressed or retired, and its own categories'
 * names. It returns them as the store holds them and judges none: a retired or suppressed resource is
 * read as any other.
 *
 * @param connection where the statement runs: the exchange's transaction.
 * @param schema the controller's schema.
 * @param audience the application's id.
 * @throws whatever the store throws.
 */
export const readAudiencePolicy = async (
  connection: pg.ClientBase,
  schema: string,
  audience: string,
): Promise<AudiencePolicy> => {
  const { rows } = await connection.query<PolicyRow>(policyQuery(schema), [
    audience,
  ]);
  const [row] = rows;
  if (row === undefined) {
    throw new ControllerError(
      "the read of an audience's policy answered no row",
    );
  }
  return { globalCategories: row.globalCategories, served: row.served };
};

/**
 * Reads what the calculation needs of the store for a signed-in principal and one audience, in one
 * statement so all of it comes from one snapshot: the name of every global category; every resource
 * the audience serves, retired ones included, each with its base tier, whether it is suppressed or
 * retired, and its own categories' names; and every unrevoked grant held by the person or by a group
 * they belong to on a resource the audience serves. Each grant is read with its resource's
 * identifier, its record category and any field category it names, its expiry, the plane of its role
 * and the capabilities that role carries as the snapshot holds them, and the person's own latest
 * decision on it by its instant, with the capabilities that decision was given on. It returns them as
 * the store holds them and judges none: a retired or suppressed resource, and a grant undecided,
 * rejected, expired, at a control-plane role or naming a field category, are read as any other.
 *
 * @param connection where the statement runs: the exchange's transaction.
 * @param schema the controller's schema.
 * @param audience the application's id.
 * @param person the person's `users.id`.
 * @throws whatever the store throws.
 */
export const readPrincipalPolicy = async (
  connection: pg.ClientBase,
  schema: string,
  audience: string,
  person: string,
): Promise<PrincipalPolicy> => {
  const { rows } = await connection.query<PrincipalPolicyRow>(
    principalPolicyQuery(schema),
    [audience, person],
  );
  const [row] = rows;
  if (row === undefined) {
    throw new ControllerError(
      "the read of a principal's policy answered no row",
    );
  }
  return {
    globalCategories: row.globalCategories,
    grants: row.grants,
    served: row.served,
  };
};
