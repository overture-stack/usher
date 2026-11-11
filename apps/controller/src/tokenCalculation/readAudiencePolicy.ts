import pg from 'pg';

import { ControllerError } from '../failures/index.js';
import type { AudiencePolicy, ServedResource } from './types.js';

interface PolicyRow {
  globalCategories: readonly string[];
  served: readonly ServedResource[];
}

// One statement, so every part of the read comes from one snapshot: a resource retired or suppressed
// meanwhile is read as it stood beside the categories read with it.
const policyQuery = (schema: string): string => {
  const table = (name: string): string =>
    `${pg.escapeIdentifier(schema)}.${name}`;
  return `
  SELECT ARRAY(
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
};

/**
 * Reads what the calculation needs of the store for one audience, in one statement so all of it comes
 * from one snapshot: the name of every global category, and every resource the audience serves, retired
 * ones included, each with its base tier, whether it is suppressed or retired, and its own categories'
 * names. Nothing is judged here: what is held and what is offered is the calculation's to decide.
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
