import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { ResourceStanding } from '../resourceStanding/index.js';
import { grantAuthority } from './grantAuthority.js';
import type { GrantAuthority, GrantAuthorityQuestion } from './types.js';

const standing = (over: Partial<ResourceStanding> = {}): ResourceStanding => ({
  accessLevel: 'grant',
  countedOwner: false,
  externalId: 'STUDY-A1',
  holder: false,
  id: '00000000-0000-4000-8000-000000000001',
  retired: false,
  suppressed: false,
  ...over,
});

const OWNER = standing({ countedOwner: true, holder: true });

const asked = (
  over: Partial<GrantAuthorityQuestion>,
): GrantAuthorityQuestion => ({
  administrator: false,
  holderIsCaller: false,
  role: 'viewer',
  standing: OWNER,
  ...over,
});

// What a decision comes to, as its kind, the code answered, and the reason its event records.
const outcomeOf = (authority: GrantAuthority): readonly unknown[] =>
  authority.kind === 'issue'
    ? ['issue']
    : [
        'refuse',
        authority.problem.status,
        authority.problem.code,
        authority.recordedReason ?? authority.problem.code,
      ];

const decided = (over: Partial<GrantAuthorityQuestion>): readonly unknown[] =>
  outcomeOf(grantAuthority(asked(over)));

suite("deciding a grant's authority", () => {
  test("issues a counted owner's grant of any role on their resource, owner included", () => {
    assert.deepEqual(
      ['viewer', 'curator', 'submitter', 'owner'].map((role) =>
        decided({ role }),
      ),
      [['issue'], ['issue'], ['issue'], ['issue']],
    );
  });

  test("issues a platform administrator's submitter and owner grants on any resource they may see, owned or not", () => {
    assert.deepEqual(
      ['submitter', 'owner'].flatMap((role) =>
        [standing(), standing({ accessLevel: 'open' })].map((seen) =>
          decided({ administrator: true, role, standing: seen }),
        ),
      ),
      [['issue'], ['issue'], ['issue'], ['issue']],
    );
  });

  test("refuses a platform administrator's grant of any other role 403 administratorGrantsNoConsumerAccess, alike whether or not the resource exists", () => {
    const refused = ['viewer', 'editor', 'curator', 'reviewer'].flatMap(
      (role) =>
        [OWNER, undefined].map((seen) =>
          decided({ administrator: true, role, standing: seen }),
        ),
    );

    assert.deepEqual(
      refused,
      refused.map(() => [
        'refuse',
        403,
        'administratorGrantsNoConsumerAccess',
        'administratorGrantsNoConsumerAccess',
      ]),
    );
  });

  test('refuses a platform administrator naming themself an owner 403 administratorSelfOwnership, ahead of every other rule', () => {
    assert.deepEqual(
      [OWNER, undefined].map((seen) =>
        decided({
          administrator: true,
          holderIsCaller: true,
          role: 'owner',
          standing: seen,
        }),
      ),
      [
        [
          'refuse',
          403,
          'administratorSelfOwnership',
          'administratorSelfOwnership',
        ],
        [
          'refuse',
          403,
          'administratorSelfOwnership',
          'administratorSelfOwnership',
        ],
      ],
    );
  });

  test('refuses a principal naming themself 422 selfNamed, an administrator at a consumer role included, ahead of the refusal of consumer access', () => {
    assert.deepEqual(
      [
        decided({ holderIsCaller: true }),
        decided({ administrator: true, holderIsCaller: true }),
        decided({ holderIsCaller: true, role: 'owner' }),
        decided({ holderIsCaller: true, standing: undefined }),
      ],
      [
        ['refuse', 422, 'selfNamed', 'selfNamed'],
        ['refuse', 422, 'selfNamed', 'selfNamed'],
        ['refuse', 422, 'selfNamed', 'selfNamed'],
        ['refuse', 422, 'selfNamed', 'selfNamed'],
      ],
    );
  });

  test('refuses a resource that does not exist, and a retired one, 404 resourceNotFound, recorded as not found', () => {
    assert.deepEqual(
      [
        decided({ standing: undefined }),
        decided({ standing: { ...OWNER, retired: true } }),
        decided({
          administrator: true,
          role: 'owner',
          standing: standing({ retired: true }),
        }),
      ],
      [
        ['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
        ['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
        ['refuse', 404, 'resourceNotFound', 'resourceNotFound'],
      ],
    );
  });

  test('refuses a principal who may not see the resource 404 resourceNotFound, recorded as a refusal of authority', () => {
    assert.deepEqual(decided({ standing: standing() }), [
      'refuse',
      404,
      'resourceNotFound',
      'noAuthorityOnResource',
    ]);
  });

  test('refuses a principal who may see the resource and owns it not 403 noAuthorityOnResource: a holder, a pending owner, or anyone on an open or registered one', () => {
    const seenWithoutAuthority = [
      standing({ holder: true }),
      standing({ accessLevel: 'open' }),
      standing({ accessLevel: 'registered', holder: true }),
    ];

    assert.deepEqual(
      seenWithoutAuthority.map((seen) => decided({ standing: seen })),
      seenWithoutAuthority.map(() => [
        'refuse',
        403,
        'noAuthorityOnResource',
        'noAuthorityOnResource',
      ]),
    );
  });
});
