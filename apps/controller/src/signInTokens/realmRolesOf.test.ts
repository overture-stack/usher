import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { realmRolesOf } from './realmRolesOf.js';

suite("reading a token's realm roles", () => {
  test('gives the roles its realm_access lists, as listed', () => {
    assert.deepEqual(
      realmRolesOf({
        realm_access: { roles: ['offline_access', 'usher-platform-admin'] },
      }),
      ['offline_access', 'usher-platform-admin'],
    );
  });

  test('gives no role for a realm_access that is absent, not an object, or holding no list of roles', () => {
    const readings = [
      {},
      { realm_access: null },
      { realm_access: ['usher-platform-admin'] },
      { realm_access: 'usher-platform-admin' },
      { realm_access: { roles: 'usher-platform-admin' } },
      { realm_access: {} },
    ].map((claims) => realmRolesOf(claims));

    assert.deepEqual(
      readings,
      readings.map(() => []),
    );
  });
});
