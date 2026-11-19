import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { namesFieldCategory } from './grantEntries.js';
import type { ReachingGrant } from './types.js';

const GRANT: ReachingGrant = {
  expiresAt: null,
  externalId: 'HEART_STUDY',
  fieldCategory: null,
  latestDecision: { capabilities: ['record.view'], decision: 'accepted' },
  plane: 'data',
  recordCategory: { name: 'controlled', scope: 'global' },
  roleCapabilities: ['record.view'],
};

suite('the grants reaching a signed-in principal', () => {
  test("tells a grant naming a field category, global or its resource's own, from one naming none", () => {
    const named = [
      { name: 'clinician', scope: 'global' },
      { name: 'basic', scope: 'resource' },
      null,
    ] as const;

    const told = named.map((fieldCategory) =>
      namesFieldCategory({ ...GRANT, fieldCategory }),
    );

    assert.deepEqual(told, [true, true, false]);
  });
});
