import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { RecordAction } from '@overture-stack/usher-types';

import { anonymousCalculation } from './anonymousCalculation.js';
import { signedInCalculation } from './signedInCalculation.js';
import type {
  AudiencePolicy,
  PrincipalPolicy,
  ReachingGrant,
  ServedResource,
} from './types.js';

const VIEW: readonly RecordAction[] = ['view'];

const ISSUED_AT = 1_767_225_600;

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

const VIEWER = ['record.count', 'record.export', 'record.view'];

const EDITOR = [...VIEWER, 'record.create', 'record.update'];

const CURATOR = [...EDITOR, 'record.delete'];

// A grant on HEART_STUDY's controlled records at viewer, accepted as viewer, never expiring: a test
// names what departs from it.
const grant = (departures: Partial<ReachingGrant> = {}): ReachingGrant => ({
  expiresAt: null,
  externalId: 'HEART_STUDY',
  fieldCategory: null,
  latestDecision: { capabilities: VIEWER, decision: 'accepted' },
  plane: 'data',
  recordCategory: { name: 'controlled', scope: 'global' },
  roleCapabilities: VIEWER,
  ...departures,
});

// Two open resources, one of them offering a category of its own, one registered, one suppressed and
// one retired, all served, under global categories beside unmarked.
const GRANT_SERVED: readonly ServedResource[] = [
  resource('HEART_STUDY'),
  resource('REEF_ARCHIVE', { ownCategories: ['local-panel'] }),
  resource('MEMBERS_ARCHIVE', { baseTier: 'registered' }),
  resource('QUIET_STUDY', { suppressed: true }),
  resource('OLD_STUDY', { retired: true }),
];

const GRANT_GLOBALS = ['community-governed', 'controlled', 'unmarked'];

// The calculation for a principal holding the grants given, at ISSUED_AT, with both rules empty
// unless a test names them.
const holding = (
  grants: readonly ReachingGrant[],
  {
    baseline = [],
    signedInRule = [],
  }: {
    baseline?: readonly RecordAction[];
    signedInRule?: readonly RecordAction[];
  } = {},
): ReturnType<typeof signedInCalculation> =>
  signedInCalculation(
    { globalCategories: GRANT_GLOBALS, grants, served: GRANT_SERVED },
    { baseline, issuedAt: ISSUED_AT, signedInRule },
  );

// The same policy holding no grant, as the rule tests read it.
const ruleOnly = (policy: AudiencePolicy): PrincipalPolicy => ({
  ...policy,
  grants: [],
});

const signedInUnder = (
  policy: AudiencePolicy,
  baseline: readonly RecordAction[],
  signedInRule: readonly RecordAction[],
): ReturnType<typeof signedInCalculation> =>
  signedInCalculation(ruleOnly(policy), {
    baseline,
    issuedAt: ISSUED_AT,
    signedInRule,
  });

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
      const { permissions } = signedInUnder(RULE_POLICY, VIEW, VIEW);

      assert.deepEqual(permissions, {
        HEART_STUDY: UNMARKED_VIEW,
        MEMBERS_ARCHIVE: UNMARKED_VIEW,
        OPEN_ATLAS: UNMARKED_VIEW,
      });
    });

    test('case 31: gives a signed-in principal holding no grant the registered resource alone with the baseline off, reaching no open resource', () => {
      const { permissions } = signedInUnder(RULE_POLICY, [], VIEW);

      assert.deepEqual(permissions, { MEMBERS_ARCHIVE: UNMARKED_VIEW });
    });

    test("case 32: accumulates the rules' entries and an accepted viewer grant on HEART_STUDY's controlled records, neither replacing the other", () => {
      const { permissions } = signedInCalculation(
        { ...RULE_POLICY, grants: [grant()] },
        { baseline: VIEW, issuedAt: ISSUED_AT, signedInRule: VIEW },
      );

      assert.deepEqual(permissions, {
        HEART_STUDY: {
          'global.controlled': { record: ['count', 'view', 'export'] },
          'global.unmarked': { record: ['view'] },
        },
        MEMBERS_ARCHIVE: UNMARKED_VIEW,
        OPEN_ATLAS: UNMARKED_VIEW,
      });
    });

    test("case 35: reaches a by-grant resource's unmarked records through an accepted grant on unmarked", () => {
      const { permissions } = signedInCalculation(
        {
          ...RULE_POLICY,
          grants: [
            grant({
              externalId: 'SEALED_ARCHIVE',
              recordCategory: { name: 'unmarked', scope: 'global' },
            }),
          ],
        },
        { baseline: VIEW, issuedAt: ISSUED_AT, signedInRule: VIEW },
      );

      assert.deepEqual(permissions['SEALED_ARCHIVE'], {
        'global.unmarked': { record: ['count', 'view', 'export'] },
      });
    });
  });

  test("confers each rule's own actions, in its order: the baseline's on open resources and the signed-in rule's on registered ones", () => {
    const { permissions } = signedInUnder(
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

  test('gives a resource whose unmarked records are by grant nothing through the rules, and counts no recorded grant', () => {
    const { grantCount, permissions } = signedInUnder(RULE_POLICY, VIEW, VIEW);

    assert.equal(Object.hasOwn(permissions, 'SEALED_ARCHIVE'), false);
    assert.equal(grantCount, 0);
  });

  test('names both rules, the baseline first, when each confers on a resource', () => {
    const { rules } = signedInUnder(RULE_POLICY, VIEW, VIEW);

    assert.deepEqual(rules, ['baseline', 'signedIn']);
  });

  test('names the signed-in rule alone under an empty baseline', () => {
    const { rules } = signedInUnder(RULE_POLICY, [], VIEW);

    assert.deepEqual(rules, ['signedIn']);
  });

  test('confers nothing under an empty signed-in rule and names no signed-in rule, the baseline conferring as for anyone', () => {
    const calculation = signedInUnder(RULE_POLICY, VIEW, []);

    assert.deepEqual(calculation.permissions, {
      HEART_STUDY: UNMARKED_VIEW,
      OPEN_ATLAS: UNMARKED_VIEW,
    });
    assert.deepEqual(calculation.rules, ['baseline']);
  });

  test('names no rule where neither rule reaches a resource the audience serves', () => {
    const calculation = signedInUnder(
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
    const calculation = signedInUnder(
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
    const calculation = signedInUnder(
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
    const calculation = signedInUnder(
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

  test('confers nothing with both rules empty and no grant, still listing every offering', () => {
    const calculation = signedInUnder(RULE_POLICY, [], []);

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

  suite('the recorded grants reaching a signed-in principal', () => {
    test("keeps a grant whose holder's latest decision accepts it, and leaves out one whose latest decision rejects it and one never decided on", () => {
      const calculation = holding([
        grant(),
        grant({
          externalId: 'REEF_ARCHIVE',
          latestDecision: { capabilities: VIEWER, decision: 'rejected' },
        }),
        grant({ externalId: 'MEMBERS_ARCHIVE', latestDecision: null }),
      ]);

      assert.deepEqual(calculation.permissions, {
        HEART_STUDY: {
          'global.controlled': { record: ['count', 'view', 'export'] },
        },
      });
      assert.equal(calculation.grantCount, 1);
    });

    test('keeps a grant only while it expires after the second the token is issued in, never expiring included', () => {
      const lapsing = (expiresAt: number, externalId: string): ReachingGrant =>
        grant({ expiresAt, externalId });

      const calculation = holding([
        lapsing(ISSUED_AT * 1000 - 1, 'HEART_STUDY'),
        lapsing(ISSUED_AT * 1000 + 999, 'REEF_ARCHIVE'),
        lapsing((ISSUED_AT + 1) * 1000, 'MEMBERS_ARCHIVE'),
        grant({
          externalId: 'REEF_ARCHIVE',
          recordCategory: { name: 'community-governed', scope: 'global' },
        }),
      ]);

      assert.deepEqual(calculation.permissions, {
        MEMBERS_ARCHIVE: {
          'global.controlled': { record: ['count', 'view', 'export'] },
        },
        REEF_ARCHIVE: {
          'global.community-governed': {
            record: ['count', 'view', 'export'],
          },
        },
      });
      assert.equal(calculation.grantCount, 2);
    });

    test("confers its role's capabilities as the role stands now, intersected with what its holder accepted, so a narrowed role confers less and a widened one nothing unaccepted", () => {
      const calculation = holding([
        grant({
          latestDecision: { capabilities: CURATOR, decision: 'accepted' },
          roleCapabilities: VIEWER,
        }),
        grant({
          externalId: 'REEF_ARCHIVE',
          latestDecision: { capabilities: VIEWER, decision: 'accepted' },
          roleCapabilities: CURATOR,
        }),
      ]);

      assert.deepEqual(calculation.permissions, {
        HEART_STUDY: {
          'global.controlled': { record: ['count', 'view', 'export'] },
        },
        REEF_ARCHIVE: {
          'global.controlled': { record: ['count', 'view', 'export'] },
        },
      });
    });

    test('confers nothing outside its role whatever its decision records', () => {
      const calculation = holding([
        grant({
          latestDecision: {
            capabilities: [...VIEWER, 'artifact.create', 'record.delete'],
            decision: 'accepted',
          },
        }),
      ]);

      assert.deepEqual(calculation.permissions['HEART_STUDY'], {
        'global.controlled': { record: ['count', 'view', 'export'] },
      });
    });

    test('confers nothing through a control-plane role, whatever capabilities it carries, and counts no such grant', () => {
      const owner = [
        'grant.create',
        'grant.revoke',
        'resource.update',
        'record.view',
      ];

      const calculation = holding([
        grant({
          latestDecision: { capabilities: owner, decision: 'accepted' },
          plane: 'control',
          recordCategory: null,
          roleCapabilities: owner,
        }),
        grant({
          externalId: 'REEF_ARCHIVE',
          latestDecision: { capabilities: owner, decision: 'accepted' },
          plane: 'control',
          roleCapabilities: owner,
        }),
      ]);

      assert.deepEqual(calculation.permissions, {});
      assert.equal(calculation.grantCount, 0);
    });

    test('carries only the actions payload version 1 lists, artifact actions under artifact, record actions under record and revision actions under revision, in the order it declares them', () => {
      const carried = [
        'record.annotate',
        'revision.export',
        'grant.create',
        'artifact.create',
        'field.view',
        'record.view',
        'artifact.view',
      ];

      const calculation = holding([
        grant({
          latestDecision: { capabilities: carried, decision: 'accepted' },
          roleCapabilities: carried,
        }),
      ]);

      assert.deepEqual(calculation.permissions['HEART_STUDY'], {
        'global.controlled': {
          artifact: ['view', 'create'],
          record: ['view'],
          revision: ['export'],
        },
      });
    });

    test('confers every action payload version 1 lists for artifacts, records and revisions, given a role carrying each', () => {
      const every = [
        ...['count', 'view', 'export', 'create', 'update', 'delete'].flatMap(
          (action) => [`artifact.${action}`, `record.${action}`],
        ),
        'revision.view',
        'revision.export',
      ];

      const calculation = holding([
        grant({
          latestDecision: { capabilities: every, decision: 'accepted' },
          roleCapabilities: every,
        }),
      ]);

      assert.deepEqual(calculation.permissions['HEART_STUDY'], {
        'global.controlled': {
          artifact: ['count', 'view', 'export', 'create', 'update', 'delete'],
          record: ['count', 'view', 'export', 'create', 'update', 'delete'],
          revision: ['view', 'export'],
        },
      });
    });

    test('leaves out a category and a resource a kept grant confers no action on, counting no such grant and keeping the resource served', () => {
      const calculation = holding([
        grant({
          latestDecision: {
            capabilities: ['record.view'],
            decision: 'accepted',
          },
          roleCapabilities: [],
        }),
        grant({
          externalId: 'REEF_ARCHIVE',
          latestDecision: { capabilities: [], decision: 'accepted' },
        }),
      ]);

      assert.deepEqual(calculation.permissions, {});
      assert.deepEqual(calculation.resourceCategories, {});
      assert.equal(calculation.grantCount, 0);
      assert.deepEqual(calculation.servedResources, [
        'HEART_STUDY',
        'REEF_ARCHIVE',
        'MEMBERS_ARCHIVE',
        'QUIET_STUDY',
      ]);
    });

    test('unions the actions of grants on one category into one entry, each action named once, the first conferred first', () => {
      const calculation = holding([
        grant(),
        grant({
          latestDecision: { capabilities: EDITOR, decision: 'accepted' },
          roleCapabilities: EDITOR,
        }),
      ]);

      assert.deepEqual(calculation.permissions['HEART_STUDY'], {
        'global.controlled': {
          record: ['count', 'view', 'export', 'create', 'update'],
        },
      });
      assert.equal(calculation.grantCount, 2);
    });

    test("unions a grant on unmarked with the rule's entry there, the rule's actions first", () => {
      const calculation = holding(
        [
          grant({
            latestDecision: { capabilities: EDITOR, decision: 'accepted' },
            recordCategory: { name: 'unmarked', scope: 'global' },
            roleCapabilities: EDITOR,
          }),
        ],
        { baseline: ['view', 'count'] },
      );

      assert.deepEqual(calculation.permissions['HEART_STUDY'], {
        'global.unmarked': {
          record: ['view', 'count', 'export', 'create', 'update'],
        },
      });
      assert.deepEqual(calculation.rules, ['baseline']);
      assert.equal(calculation.grantCount, 1);
    });

    test('keeps each grant on one resource under its own category, at its own role', () => {
      const calculation = holding([
        grant({
          latestDecision: { capabilities: CURATOR, decision: 'accepted' },
          roleCapabilities: CURATOR,
        }),
        grant({ recordCategory: { name: 'unmarked', scope: 'global' } }),
      ]);

      assert.deepEqual(calculation.permissions, {
        HEART_STUDY: {
          'global.controlled': {
            record: ['count', 'view', 'export', 'create', 'update', 'delete'],
          },
          'global.unmarked': { record: ['count', 'view', 'export'] },
        },
      });
    });

    test('confers nothing through a grant on a resource the audience does not serve or has retired, and nothing through one on a suppressed resource, which stays served', () => {
      const calculation = holding([
        grant({ externalId: 'UNSERVED_STUDY' }),
        grant({ externalId: 'OLD_STUDY' }),
        grant({ externalId: 'QUIET_STUDY' }),
      ]);

      assert.deepEqual(calculation.permissions, {});
      assert.equal(calculation.grantCount, 0);
      assert.equal(calculation.servedResources.includes('QUIET_STUDY'), true);
      assert.equal(calculation.servedResources.includes('OLD_STUDY'), false);
      assert.equal(
        calculation.servedResources.includes('UNSERVED_STUDY'),
        false,
      );
    });

    test("keeps a grant on a global category wherever its resource is served, whatever the resource offers, and names a grant on a resource's own category in that resource's scope", () => {
      const calculation = holding([
        grant({
          externalId: 'REEF_ARCHIVE',
          recordCategory: { name: 'community-governed', scope: 'global' },
        }),
        grant({
          externalId: 'REEF_ARCHIVE',
          recordCategory: { name: 'local-panel', scope: 'resource' },
        }),
      ]);

      assert.deepEqual(calculation.permissions, {
        REEF_ARCHIVE: {
          'global.community-governed': {
            record: ['count', 'view', 'export'],
          },
          'resource.local-panel': { record: ['count', 'view', 'export'] },
        },
      });
      assert.deepEqual(calculation.resourceCategories, {
        REEF_ARCHIVE: ['resource.local-panel'],
      });
    });

    test('confers nothing through a grant naming no record category, the control plane wildcard', () => {
      const calculation = holding([grant({ recordCategory: null })]);

      assert.deepEqual(calculation.permissions, {});
      assert.equal(calculation.grantCount, 0);
    });

    test('leaves out a grant naming a field category entirely: it confers nothing, is not counted, and bounds no expiry', () => {
      const calculation = holding([
        grant({
          expiresAt: (ISSUED_AT + 60) * 1000,
          fieldCategory: { name: 'clinician', scope: 'global' },
        }),
      ]);

      assert.deepEqual(calculation.permissions, {});
      assert.equal(calculation.grantCount, 0);
      assert.equal(Object.hasOwn(calculation, 'earliestGrantExpiry'), false);
    });

    test('gives the earliest expiry among the grants it drew on, rounded down to the whole second, and none of a grant it did not draw on', () => {
      const calculation = holding([
        grant({ expiresAt: (ISSUED_AT + 200) * 1000 }),
        grant({
          expiresAt: (ISSUED_AT + 100) * 1000 + 700,
          externalId: 'REEF_ARCHIVE',
        }),
        grant({
          expiresAt: (ISSUED_AT + 10) * 1000,
          externalId: 'MEMBERS_ARCHIVE',
          latestDecision: { capabilities: VIEWER, decision: 'rejected' },
        }),
        grant({
          expiresAt: (ISSUED_AT + 20) * 1000,
          externalId: 'UNSERVED_STUDY',
        }),
        grant({
          expiresAt: (ISSUED_AT + 30) * 1000,
          roleCapabilities: [],
        }),
      ]);

      assert.equal(calculation.earliestGrantExpiry, ISSUED_AT + 100);
    });

    test('gives no expiry where no grant it drew on expires', () => {
      const calculation = holding([
        grant(),
        grant({
          expiresAt: (ISSUED_AT + 10) * 1000,
          latestDecision: null,
        }),
      ]);

      assert.equal(Object.hasOwn(calculation, 'earliestGrantExpiry'), false);
    });

    test('counts every recorded grant it drew on, two on one category apart, and never a rule', () => {
      const calculation = holding([grant(), grant()], { baseline: VIEW });

      assert.equal(calculation.grantCount, 2);
      assert.deepEqual(calculation.rules, ['baseline']);
    });

    test("lists a resource held through a grant alone under resourceCategories with its own categories, and names no rule for a grant's entry", () => {
      const calculation = holding([
        grant({
          externalId: 'REEF_ARCHIVE',
          recordCategory: { name: 'unmarked', scope: 'global' },
        }),
      ]);

      assert.deepEqual(calculation.resourceCategories, {
        REEF_ARCHIVE: ['resource.local-panel'],
      });
      assert.deepEqual(calculation.rules, []);
    });
  });
});
