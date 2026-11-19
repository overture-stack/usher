import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
  capabilityId,
  committedInsert,
  committedQuery,
  INTEGRITY,
  openSeededDatabase,
  refusedByStore,
  type Row,
  selectRows,
  violation,
  writeOutcome,
} from '../../test-support/fixtures/database.js';
import {
  inTurn,
  POLICY_TABLES,
  qualified,
  seededId,
} from '../../test-support/policy.js';

const { capabilities, rolePermissions, roles } = POLICY_TABLES;

const capabilityRow = (name: string, plane: string | null): Row => {
  const [entity, action] = name.split('.');
  return {
    [capabilities.columns.action]: action,
    [capabilities.columns.displayName]: name,
    [capabilities.columns.entity]: entity,
    [capabilities.columns.plane]: plane,
  };
};

const roleRow = (name: string, plane: string): Row => ({
  [roles.columns.name]: name,
  [roles.columns.plane]: plane,
});

const permission = (roleId: string, heldCapability: string): Row => ({
  [rolePermissions.columns.capabilityId]: heldCapability,
  [rolePermissions.columns.roleId]: roleId,
});

const capabilitiesNamed = (
  client: pg.ClientBase,
  entity: string,
  action: string,
): Promise<readonly { plane: string }[]> =>
  selectRows<{ plane: string }>(
    client,
    `SELECT ${capabilities.columns.plane} AS plane FROM ${qualified(capabilities)} WHERE ${capabilities.columns.entity} = $1 AND ${capabilities.columns.action} = $2`,
    [entity, action],
  );

const heldBy = async (
  client: pg.ClientBase,
  roleId: string,
): Promise<readonly string[]> =>
  (
    await selectRows<{ name: string }>(
      client,
      `SELECT capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action} AS name
         FROM ${qualified(rolePermissions)} permission
         JOIN ${qualified(capabilities)} capability ON capability.${capabilities.columns.id} = permission.${rolePermissions.columns.capabilityId}
        WHERE permission.${rolePermissions.columns.roleId} = $1`,
      [roleId],
    )
  )
    .map(({ name }) => name)
    .sort();

suite('roles and capabilities', () => {
  test('names each capability once by entity and action', async (context) => {
    const { owner } = await openSeededDatabase(context);

    await assert.rejects(
      committedInsert(
        owner,
        capabilities,
        capabilityRow('record.view', 'data'),
      ),
      violation(INTEGRITY.unique),
    );
    await committedInsert(
      owner,
      capabilities,
      capabilityRow('field.view', 'data'),
    );

    assert.equal((await capabilitiesNamed(owner, 'record', 'view')).length, 1);
    assert.equal((await capabilitiesNamed(owner, 'field', 'view')).length, 1);
  });

  test('names each role once, and pairs it with a capability once', async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const viewer = seededId(seeded.roles, 'viewer');
    const held = await heldBy(owner, viewer);

    await assert.rejects(
      committedInsert(owner, roles, roleRow('viewer', 'data')),
      violation(INTEGRITY.unique),
    );
    await assert.rejects(
      committedInsert(
        owner,
        rolePermissions,
        permission(viewer, await capabilityId(owner, 'record.view')),
      ),
      violation(INTEGRITY.unique),
    );

    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT count(*)::int AS count FROM ${qualified(roles)} WHERE ${roles.columns.name} = 'viewer'`,
      ),
      [{ count: 1 }],
    );
    assert.deepEqual(await heldBy(owner, viewer), held);
  });

  test('places every role in the data plane or the control plane', async (context) => {
    const { owner } = await openSeededDatabase(context);
    const planes = ['data', 'control', 'Data', 'both', ''];

    const outcomes = await inTurn(planes, (plane) =>
      writeOutcome(
        committedInsert(
          owner,
          roles,
          roleRow(`role-${plane.length}-${plane}`, plane),
        ),
      ),
    );

    assert.deepEqual(outcomes, [
      'accepted',
      'accepted',
      INTEGRITY.check,
      INTEGRITY.check,
      INTEGRITY.check,
    ]);
  });

  test('places every capability in the data plane or the control plane', async (context) => {
    const { owner } = await openSeededDatabase(context);
    const planes = ['data', 'control', 'Data', 'both', '', null];

    const outcomes = await inTurn(planes, (plane) =>
      writeOutcome(
        committedInsert(
          owner,
          capabilities,
          capabilityRow(
            `artifact.probe${String(plane).length}${String(plane)}`,
            plane,
          ),
        ),
      ),
    );

    assert.deepEqual(outcomes, [
      'accepted',
      'accepted',
      INTEGRITY.check,
      INTEGRITY.check,
      INTEGRITY.check,
      INTEGRITY.notNull,
    ]);
  });

  test("keeps a role's capabilities within the role's own plane", async (context) => {
    const { owner, seeded } = await openSeededDatabase(context);
    const viewer = seededId(seeded.roles, 'viewer');
    const ownerRole = seededId(seeded.roles, 'owner');
    await committedInsert(
      owner,
      capabilities,
      capabilityRow('resource.update', 'control'),
    );
    const viewerHeld = await heldBy(owner, viewer);
    const ownerHeld = await heldBy(owner, ownerRole);

    const refusals = [
      await refusedByStore(
        committedInsert(
          owner,
          rolePermissions,
          permission(viewer, await capabilityId(owner, 'grant.create')),
        ),
      ),
      await refusedByStore(
        committedInsert(
          owner,
          rolePermissions,
          permission(ownerRole, await capabilityId(owner, 'record.view')),
        ),
      ),
    ];
    await committedInsert(
      owner,
      rolePermissions,
      permission(viewer, await capabilityId(owner, 'record.create')),
    );
    await committedInsert(
      owner,
      rolePermissions,
      permission(ownerRole, await capabilityId(owner, 'resource.update')),
    );
    await committedInsert(
      owner,
      capabilities,
      capabilityRow('record.delete', 'data'),
    );
    await committedInsert(owner, roles, roleRow('curator', 'data'));
    const recordView = await capabilityId(owner, 'record.view');
    const refusedUpdates = await inTurn(
      [
        {
          parameters: [
            await capabilityId(owner, 'grant.create'),
            viewer,
            recordView,
          ],
          text: `UPDATE ${qualified(rolePermissions)} SET ${rolePermissions.columns.capabilityId} = $1 WHERE ${rolePermissions.columns.roleId} = $2 AND ${rolePermissions.columns.capabilityId} = $3`,
        },
        {
          parameters: [viewer],
          text: `UPDATE ${qualified(roles)} SET ${roles.columns.plane} = 'control' WHERE ${roles.columns.id} = $1`,
        },
        {
          parameters: [recordView],
          text: `UPDATE ${qualified(capabilities)} SET ${capabilities.columns.plane} = 'control' WHERE ${capabilities.columns.id} = $1`,
        },
      ],
      ({ parameters, text }) =>
        refusedByStore(committedQuery(owner, text, parameters)),
    );
    const acceptedUpdates = [
      await writeOutcome(
        committedQuery(
          owner,
          `UPDATE ${qualified(rolePermissions)} SET ${rolePermissions.columns.capabilityId} = $1 WHERE ${rolePermissions.columns.roleId} = $2 AND ${rolePermissions.columns.capabilityId} = $3`,
          [
            await capabilityId(owner, 'record.delete'),
            viewer,
            await capabilityId(owner, 'record.create'),
          ],
        ),
      ),
      await writeOutcome(
        committedQuery(
          owner,
          `UPDATE ${qualified(roles)} SET ${roles.columns.plane} = 'control' WHERE ${roles.columns.name} = 'curator'`,
        ),
      ),
    ];

    assert.deepEqual(refusals, [true, true]);
    assert.deepEqual(refusedUpdates, [true, true, true]);
    assert.deepEqual(acceptedUpdates, ['accepted', 'accepted']);
    assert.deepEqual(
      await heldBy(owner, viewer),
      [...viewerHeld, 'record.delete'].sort(),
    );
    assert.deepEqual(
      await selectRows(
        owner,
        `SELECT role.${roles.columns.plane} AS "rolePlane", capability.${capabilities.columns.plane} AS "capabilityPlane" FROM ${qualified(roles)} role, ${qualified(capabilities)} capability WHERE role.${roles.columns.id} = $1 AND capability.${capabilities.columns.id} = $2`,
        [viewer, recordView],
      ),
      [{ capabilityPlane: 'data', rolePlane: 'data' }],
    );
    assert.deepEqual(
      await heldBy(owner, ownerRole),
      [...ownerHeld, 'resource.update'].sort(),
    );
  });
});
