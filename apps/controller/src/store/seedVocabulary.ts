import pg from 'pg';

import {
  CAPABILITY_VOCABULARY,
  type Capability,
  SEEDED_ROLES,
  type SeededRole,
} from '../capabilities/index.js';
import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import { ControllerError } from '../controllerError.js';
import type { StartProblem } from '../startRefusal.js';
import { writeOrRefuse } from './writeOrRefuse.js';

const UNWRITABLE: StartProblem = {
  rule: 'names a database role that may not write the capabilities and seeded roles the store lacks',
  variable: ENVIRONMENT_VARIABLES.databaseUrl,
};

type Qualify = (table: string) => string;

const heldNames = async (
  client: pg.ClientBase,
  query: string,
): Promise<ReadonlySet<string>> => {
  const { rows } = await client.query<{ name: string }>(query);
  return new Set(rows.map(({ name }) => name));
};

// A capability's display name is its action alone, as an interface shows it under its entity.
const insertCapabilities = async (
  client: pg.ClientBase,
  qualify: Qualify,
  missing: readonly Capability[],
): Promise<void> => {
  await writeOrRefuse(UNWRITABLE, () =>
    client.query(
      `INSERT INTO ${qualify('capabilities')} (action, display_name, entity, plane)
       SELECT action, action, entity, plane FROM unnest($1::text[], $2::text[], $3::text[]) AS capability (action, entity, plane)
       ON CONFLICT (entity, action) DO NOTHING`,
      [
        missing.map(({ action }) => action),
        missing.map(({ entity }) => entity),
        missing.map(({ plane }) => plane),
      ],
    ),
  );
};

// A role another writer adds by the same name between the read and the insert keeps what it carries.
const insertRoles = async (
  client: pg.ClientBase,
  qualify: Qualify,
  missing: ReadonlyMap<string, Readonly<SeededRole>>,
): Promise<readonly { id: string; name: string }[]> => {
  const { rows } = await writeOrRefuse(UNWRITABLE, () =>
    client.query<{ id: string; name: string }>(
      `INSERT INTO ${qualify('roles')} (name, plane)
       SELECT name, plane FROM unnest($1::text[], $2::text[]) AS role (name, plane)
       ON CONFLICT (name) DO NOTHING
       RETURNING id::text AS id, name`,
      [[...missing.keys()], [...missing.values()].map(({ plane }) => plane)],
    ),
  );
  return rows;
};

const insertPermissions = async (
  client: pg.ClientBase,
  qualify: Qualify,
  roles: ReadonlyMap<string, Readonly<SeededRole>>,
  written: readonly { id: string; name: string }[],
): Promise<void> => {
  const permissions = written.flatMap(({ id, name }) =>
    (roles.get(name)?.capabilities ?? []).map((capability) => ({
      capability,
      role: id,
    })),
  );
  const { rowCount } = await writeOrRefuse(UNWRITABLE, () =>
    client.query(
      `INSERT INTO ${qualify('role_permissions')} (role_id, capability_id)
       SELECT permission.role_id, capability.id
         FROM unnest($1::uuid[], $2::text[]) AS permission (role_id, capability)
         JOIN ${qualify('capabilities')} capability ON capability.entity || '.' || capability.action = permission.capability`,
      [
        permissions.map(({ role }) => role),
        permissions.map(({ capability }) => capability),
      ],
    ),
  );
  if (rowCount === permissions.length) {
    return;
  }
  throw new ControllerError(
    'a seeded role names a capability the store does not hold',
  );
};

/**
 * Writes the capability vocabulary and the seeded roles carrying it, as the start's system actor, each
 * row a change the audit triggers record: every capability of the vocabulary the store lacks, every
 * seeded role it lacks, and each written role's capabilities. Nothing the store holds is changed, so a
 * seeded role an administrator has changed since keeps the change, and a store holding them all is
 * written nothing.
 *
 * @param client a connection under the controller's role, in the start's transaction, its actor declared.
 * @param schema the controller's schema.
 * @throws {StartRefusal} naming the database URL's variable when the store lacks some of them and the
 *   database role may not write them.
 */
export const seedVocabulary = async (
  client: pg.ClientBase,
  schema: string,
): Promise<void> => {
  const qualify: Qualify = (table) => `${pg.escapeIdentifier(schema)}.${table}`;
  const heldCapabilities = await heldNames(
    client,
    `SELECT entity || '.' || action AS name FROM ${qualify('capabilities')}`,
  );
  const missingCapabilities = CAPABILITY_VOCABULARY.filter(
    ({ name }) => !heldCapabilities.has(name),
  );
  if (missingCapabilities.length > 0) {
    await insertCapabilities(client, qualify, missingCapabilities);
  }
  const heldRoles = await heldNames(
    client,
    `SELECT name FROM ${qualify('roles')}`,
  );
  const missingRoles: ReadonlyMap<string, Readonly<SeededRole>> = new Map(
    Object.entries(SEEDED_ROLES).filter(([name]) => !heldRoles.has(name)),
  );
  if (missingRoles.size > 0) {
    const written = await insertRoles(client, qualify, missingRoles);
    await insertPermissions(client, qualify, missingRoles, written);
  }
};
