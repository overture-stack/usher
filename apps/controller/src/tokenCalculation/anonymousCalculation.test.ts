import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { GrantRuleAction, GrantRules } from '../settings/index.js';
import { anonymousCalculation } from './anonymousCalculation.js';
import type { AudiencePolicy, ServedResource } from './types.js';

const BASELINE: readonly GrantRuleAction[] = ['count', 'view', 'export'];

// The grant rules giving everyone the actions on open resources' unmarked records.
const everyoneOpen = (actions: readonly GrantRuleAction[]): GrantRules => [
  {
    resources: [
      {
        accessLevel: 'open',
        categories: [{ actions, name: 'global.unmarked' }],
      },
    ],
    to: 'everyone',
  },
];

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

// Identifiers holding values JSON must escape, beside plain ones, and a resource at every tier.
const POLICY: AudiencePolicy = {
  globalCategories: ['community-governed', 'controlled', 'unmarked'],
  served: [
    resource('étude « Nord » "A1"', { ownCategories: ['local-panel'] }),
    resource('STUDY-B2'),
    resource('STUDY-C3', { baseTier: 'registered', ownCategories: ['vault'] }),
    resource('STUDY-D4', { baseTier: 'grant' }),
  ],
};

const UNMARKED_READ = { 'global.unmarked': { record: BASELINE } };

suite('the anonymous calculation', () => {
  test("confers everyone's actions on the unmarked records of every open resource the audience serves, and on no other resource's", () => {
    const { permissions } = anonymousCalculation(
      POLICY,
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(permissions, {
      'STUDY-B2': UNMARKED_READ,
      'étude « Nord » "A1"': UNMARKED_READ,
    });
  });

  test('lists every resource the audience serves in servedResources, held or not', () => {
    const { servedResources } = anonymousCalculation(
      POLICY,
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(servedResources, [
      'étude « Nord » "A1"',
      'STUDY-B2',
      'STUDY-C3',
      'STUDY-D4',
    ]);
  });

  test("lists each held resource's own categories under it, scoped, and names no resource it does not hold", () => {
    const { resourceCategories } = anonymousCalculation(
      POLICY,
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(resourceCategories, {
      'STUDY-B2': [],
      'étude « Nord » "A1"': ['resource.local-panel'],
    });
  });

  test('lists every concrete global category, scoped, whether or not anything holds it, and never global.unmarked', () => {
    const { globalCategories } = anonymousCalculation(
      POLICY,
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(globalCategories, [
      'global.community-governed',
      'global.controlled',
    ]);
  });

  test('leaves a suppressed resource out of permissions and resourceCategories, and keeps it in servedResources', () => {
    const calculation = anonymousCalculation(
      {
        ...POLICY,
        served: [
          resource('STUDY-F6', { suppressed: true }),
          resource('STUDY-B2'),
        ],
      },
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(Object.keys(calculation.permissions), ['STUDY-B2']);
    assert.deepEqual(Object.keys(calculation.resourceCategories), ['STUDY-B2']);
    assert.deepEqual(calculation.servedResources, ['STUDY-F6', 'STUDY-B2']);
  });

  test('names a retired resource in neither permissions, resourceCategories nor servedResources', () => {
    const calculation = anonymousCalculation(
      {
        ...POLICY,
        served: [resource('STUDY-B2', { retired: true }), resource('STUDY-E5')],
      },
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(Object.keys(calculation.permissions), ['STUDY-E5']);
    assert.deepEqual(Object.keys(calculation.resourceCategories), ['STUDY-E5']);
    assert.deepEqual(calculation.servedResources, ['STUDY-E5']);
  });

  test('confers exactly the actions the entry names, in its order', () => {
    const { permissions } = anonymousCalculation(
      POLICY,
      everyoneOpen(['view']),
    );

    assert.deepEqual(permissions['STUDY-B2'], {
      'global.unmarked': { record: ['view'] },
    });
  });

  test('confers nothing under an empty entry, still listing every offering', () => {
    const calculation = anonymousCalculation(POLICY, everyoneOpen([]));

    assert.deepEqual(calculation, {
      globalCategories: ['global.community-governed', 'global.controlled'],
      grantCount: 0,
      permissions: {},
      resourceCategories: {},
      rules: [],
      servedResources: [
        'étude « Nord » "A1"',
        'STUDY-B2',
        'STUDY-C3',
        'STUDY-D4',
      ],
    });
  });

  test('names everyone as the conferring recipient once it confers on any resource, and counts no recorded grant', () => {
    const { grantCount, rules } = anonymousCalculation(
      POLICY,
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(rules, ['everyone']);
    assert.equal(grantCount, 0);
  });

  test('names no conferring rule where no resource the audience serves is open', () => {
    const calculation = anonymousCalculation(
      {
        globalCategories: [],
        served: [resource('STUDY-C3', { baseTier: 'registered' })],
      },
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(calculation.permissions, {});
    assert.deepEqual(calculation.rules, []);
  });

  test('offers nothing to an audience serving no resource, the global categories aside', () => {
    const calculation = anonymousCalculation(
      { globalCategories: ['unmarked'], served: [] },
      everyoneOpen(BASELINE),
    );

    assert.deepEqual(calculation, {
      globalCategories: [],
      grantCount: 0,
      permissions: {},
      resourceCategories: {},
      rules: [],
      servedResources: [],
    });
  });

  test('confers nothing on an anonymous visitor through a signedIn entry, and names no rule for it', () => {
    const calculation = anonymousCalculation(POLICY, [
      {
        resources: [
          {
            accessLevel: 'open',
            categories: [{ actions: BASELINE, name: 'global.unmarked' }],
          },
        ],
        to: 'signedIn',
      },
    ]);

    assert.deepEqual(calculation.permissions, {});
    assert.deepEqual(calculation.rules, []);
  });
});
