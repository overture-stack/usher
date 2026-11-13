import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { RecordAction } from '@overture-stack/usher-types';

import { anonymousCalculation } from './anonymousCalculation.js';
import { signedInCalculation } from './signedInCalculation.js';
import type { AudiencePolicy, ServedResource } from './types.js';

const VIEW: readonly RecordAction[] = ['view'];

const resource = (
  externalId: string,
  departures: Partial<Omit<ServedResource, 'externalId'>> = {},
): ServedResource => ({
  baseTier: 'open',
  externalId,
  ownCategories: [],
  retired: false,
  suppressed: false,
  ...departures,
});

// The configuration of token-calculation.md's "The signed-in rule, against its own configuration":
// one resource at each tier, and an open one offering a restricting category.
const RULE_POLICY: AudiencePolicy = {
  globalCategories: ['controlled', 'unmarked'],
  served: [
    resource('OPEN_ATLAS'),
    resource('MEMBERS_ARCHIVE', { baseTier: 'registered' }),
    resource('SEALED_ARCHIVE', { baseTier: 'grant' }),
    resource('HEART_STUDY'),
  ],
};

const UNMARKED_VIEW = { 'global.unmarked': { record: ['view'] } };

suite('the signed-in calculation', () => {
  suite('the signed-in rule, against its own configuration', () => {
    test('case 28: gives an anonymous visitor under the baseline the open resources alone, neither the registered nor the granted one', () => {
      const { permissions } = anonymousCalculation(RULE_POLICY, VIEW);

      assert.deepEqual(permissions, {
        HEART_STUDY: UNMARKED_VIEW,
        OPEN_ATLAS: UNMARKED_VIEW,
      });
    });

    test('case 29: gives an anonymous visitor nothing with the baseline off', () => {
      const { permissions } = anonymousCalculation(RULE_POLICY, []);

      assert.deepEqual(permissions, {});
    });

    test("case 30: gives a signed-in principal holding no grant case 28's entries and the registered resource's unmarked records under the signed-in rule", () => {
      const { permissions } = signedInCalculation(RULE_POLICY, VIEW, VIEW);

      assert.deepEqual(permissions, {
        HEART_STUDY: UNMARKED_VIEW,
        MEMBERS_ARCHIVE: UNMARKED_VIEW,
        OPEN_ATLAS: UNMARKED_VIEW,
      });
    });

    test('case 31: gives a signed-in principal holding no grant the registered resource alone with the baseline off, reaching no open resource', () => {
      const { permissions } = signedInCalculation(RULE_POLICY, [], VIEW);

      assert.deepEqual(permissions, { MEMBERS_ARCHIVE: UNMARKED_VIEW });
    });
  });

  test("confers each rule's own actions, in its order: the baseline's on open resources and the signed-in rule's on registered ones", () => {
    const { permissions } = signedInCalculation(
      RULE_POLICY,
      ['count', 'view', 'export'],
      ['view', 'count'],
    );

    assert.deepEqual(permissions, {
      HEART_STUDY: {
        'global.unmarked': { record: ['count', 'view', 'export'] },
      },
      MEMBERS_ARCHIVE: { 'global.unmarked': { record: ['view', 'count'] } },
      OPEN_ATLAS: {
        'global.unmarked': { record: ['count', 'view', 'export'] },
      },
    });
  });

  test('gives a resource whose unmarked records are by grant nothing, and counts no recorded grant', () => {
    const { grantCount, permissions } = signedInCalculation(
      RULE_POLICY,
      VIEW,
      VIEW,
    );

    assert.equal(Object.hasOwn(permissions, 'SEALED_ARCHIVE'), false);
    assert.equal(grantCount, 0);
  });

  test('names both rules, the baseline first, when each confers on a resource', () => {
    const { rules } = signedInCalculation(RULE_POLICY, VIEW, VIEW);

    assert.deepEqual(rules, ['baseline', 'signedIn']);
  });

  test('names the signed-in rule alone under an empty baseline', () => {
    const { rules } = signedInCalculation(RULE_POLICY, [], VIEW);

    assert.deepEqual(rules, ['signedIn']);
  });

  test('confers nothing under an empty signed-in rule and names no signed-in rule, the baseline conferring as for anyone', () => {
    const calculation = signedInCalculation(RULE_POLICY, VIEW, []);

    assert.deepEqual(calculation.permissions, {
      HEART_STUDY: UNMARKED_VIEW,
      OPEN_ATLAS: UNMARKED_VIEW,
    });
    assert.deepEqual(calculation.rules, ['baseline']);
  });

  test('names no rule where neither rule reaches a resource the audience serves', () => {
    const calculation = signedInCalculation(
      {
        globalCategories: [],
        served: [
          resource('SEALED_ARCHIVE', { baseTier: 'grant' }),
          resource('OPEN_ATLAS'),
        ],
      },
      [],
      VIEW,
    );

    assert.deepEqual(calculation.permissions, {});
    assert.deepEqual(calculation.rules, []);
  });

  test('leaves a suppressed resource out of permissions and resourceCategories at either tier, and keeps it in servedResources', () => {
    const calculation = signedInCalculation(
      {
        globalCategories: [],
        served: [
          resource('MEMBERS_ARCHIVE', {
            baseTier: 'registered',
            suppressed: true,
          }),
          resource('OPEN_ATLAS', { suppressed: true }),
          resource('HEART_STUDY'),
        ],
      },
      VIEW,
      VIEW,
    );

    assert.deepEqual(Object.keys(calculation.permissions), ['HEART_STUDY']);
    assert.deepEqual(Object.keys(calculation.resourceCategories), [
      'HEART_STUDY',
    ]);
    assert.deepEqual(calculation.servedResources, [
      'MEMBERS_ARCHIVE',
      'OPEN_ATLAS',
      'HEART_STUDY',
    ]);
    assert.deepEqual(calculation.rules, ['baseline']);
  });

  test('names a retired resource in neither permissions, resourceCategories nor servedResources, at either tier', () => {
    const calculation = signedInCalculation(
      {
        globalCategories: [],
        served: [
          resource('MEMBERS_ARCHIVE', {
            baseTier: 'registered',
            retired: true,
          }),
          resource('OPEN_ATLAS', { retired: true }),
          resource('HEART_STUDY'),
        ],
      },
      VIEW,
      VIEW,
    );

    assert.deepEqual(Object.keys(calculation.permissions), ['HEART_STUDY']);
    assert.deepEqual(Object.keys(calculation.resourceCategories), [
      'HEART_STUDY',
    ]);
    assert.deepEqual(calculation.servedResources, ['HEART_STUDY']);
    assert.deepEqual(calculation.rules, ['baseline']);
  });

  test("offers what the anonymous calculation offers: every concrete global category, every held resource's own categories, and every resource served", () => {
    const calculation = signedInCalculation(
      {
        globalCategories: ['community-governed', 'controlled', 'unmarked'],
        served: [
          resource('OPEN_ATLAS', { ownCategories: ['local-panel'] }),
          resource('MEMBERS_ARCHIVE', {
            baseTier: 'registered',
            ownCategories: ['vault'],
          }),
          resource('SEALED_ARCHIVE', {
            baseTier: 'grant',
            ownCategories: ['sealed'],
          }),
        ],
      },
      VIEW,
      VIEW,
    );

    assert.deepEqual(calculation.globalCategories, [
      'global.community-governed',
      'global.controlled',
    ]);
    assert.deepEqual(calculation.resourceCategories, {
      MEMBERS_ARCHIVE: ['resource.vault'],
      OPEN_ATLAS: ['resource.local-panel'],
    });
    assert.deepEqual(calculation.servedResources, [
      'OPEN_ATLAS',
      'MEMBERS_ARCHIVE',
      'SEALED_ARCHIVE',
    ]);
  });

  test('confers nothing with both rules empty, still listing every offering', () => {
    const calculation = signedInCalculation(RULE_POLICY, [], []);

    assert.deepEqual(calculation, {
      globalCategories: ['global.controlled'],
      grantCount: 0,
      permissions: {},
      resourceCategories: {},
      rules: [],
      servedResources: [
        'OPEN_ATLAS',
        'MEMBERS_ARCHIVE',
        'SEALED_ARCHIVE',
        'HEART_STUDY',
      ],
    });
  });
});
