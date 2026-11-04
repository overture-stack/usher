import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { ENFORCEMENT_RULES } from './enforcement.js';
import { READ_RULE } from './problems.js';
import {
  REQUEST_ACCESS_RULES,
  resultFor,
  subjectToLog,
  type UsherPrincipal,
  type UsherRequestAccess,
  validateRequestAccess,
} from './requestAccess.js';
import {
  assertAccepted,
  assertCarriesNoInput,
  assertEveryRuleBroken,
  assertInputMarked,
  assertRefusedFor,
  LEAK_MARKER,
  type LeakCase,
  throughJson,
} from './testSupport.js';

const PROTO = '__proto__';

const SUBJECT = '8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b';

const anonymousAccess = (): UsherRequestAccess => ({
  principal: { credential: 'none', openTierOnly: true, suspended: false },
  results: {
    analyses: { kind: 'deny', reason: 'no-grants' },
    files: {
      kind: 'narrow',
      sqon: {
        content: [
          {
            content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
            op: 'in',
          },
        ],
        op: 'or',
      },
    },
  },
  version: 1,
});

const signedInAccess = (): UsherRequestAccess => ({
  principal: {
    credential: 'confirmed',
    openTierOnly: false,
    subject: SUBJECT,
    suspended: false,
  },
  results: {
    analyses: { kind: 'deny', reason: 'unknown-resource' },
    files: {
      kind: 'narrow',
      sqon: {
        content: [
          {
            content: [
              {
                content: { fieldName: 'study_id', value: ['HEART_STUDY'] },
                op: 'in',
              },
              {
                content: { fieldName: 'data_category', value: ['controlled'] },
                op: 'in',
              },
            ],
            op: 'and',
          },
        ],
        op: 'or',
      },
    },
    reference: { kind: 'allow' },
  },
  version: 1,
});

const suspendedAccess = (): UsherRequestAccess => ({
  ...anonymousAccess(),
  principal: {
    attributionOnlySubject: SUBJECT,
    credential: 'confirmed',
    openTierOnly: true,
    suspended: true,
  },
});

const unconfirmedAccess = (): UsherRequestAccess => ({
  ...anonymousAccess(),
  principal: { credential: 'unconfirmed', openTierOnly: true, suspended: true },
});

const withAnyPrincipal = (principal: Record<string, unknown>): unknown => ({
  ...anonymousAccess(),
  principal,
});

const withMembers = (members: Record<string, unknown>): unknown => ({
  ...signedInAccess(),
  ...members,
});

const withoutMember = (member: string): unknown =>
  Object.fromEntries(
    Object.entries(signedInAccess()).filter(([key]) => key !== member),
  );

const withPrincipal = (principal: Record<string, unknown>): unknown =>
  withMembers({ principal: { ...signedInAccess().principal, ...principal } });

const withoutPrincipalMember = (member: string): unknown =>
  withMembers({
    principal: Object.fromEntries(
      Object.entries(signedInAccess().principal).filter(
        ([key]) => key !== member,
      ),
    ),
  });

const withResult = (result: unknown): unknown =>
  withMembers({ results: { ...signedInAccess().results, files: result } });

suite('validateRequestAccess', () => {
  suite('valid values', () => {
    for (const [description, access] of [
      ['an anonymous principal', anonymousAccess()],
      ['a signed-in principal', signedInAccess()],
      ['a suspended principal served the open tier alone', suspendedAccess()],
      [
        'a principal whose credential the bridge has not confirmed',
        unconfirmedAccess(),
      ],
    ] as const) {
      test(`accepts the access of ${description} and returns it unchanged`, () => {
        const result = validateRequestAccess(access);

        assertAccepted(result);
        assert.deepEqual(result.success && result.access, access);
      });
    }

    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      test(`accepts a result key named ${key}, since a key is the adapter's own name`, () => {
        const access = withMembers({ results: { [key]: { kind: 'allow' } } });

        const result = validateRequestAccess(access);

        assertAccepted(result);
      });
    }
  });

  suite('the version', () => {
    for (const version of [0, 2, '1', null]) {
      test(`refuses version ${JSON.stringify(version)}, which this reader was not built for`, () => {
        const access = withMembers({ version });

        const result = validateRequestAccess(access);

        assertRefusedFor(result, 'version', REQUEST_ACCESS_RULES.version);
      });
    }

    test('refuses a value with no version', () => {
      const access = withoutMember('version');

      const result = validateRequestAccess(access);

      assertRefusedFor(result, 'version', REQUEST_ACCESS_RULES.version);
    });
  });

  suite('members', () => {
    test('refuses a value missing principal', () => {
      const access = withoutMember('principal');

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal',
        REQUEST_ACCESS_RULES.principalIsMap,
      );
    });

    test('refuses a value missing results', () => {
      const access = withoutMember('results');

      const result = validateRequestAccess(access);

      assertRefusedFor(result, 'results', REQUEST_ACCESS_RULES.results);
    });

    for (const [member, rule] of [
      ['credential', REQUEST_ACCESS_RULES.credential],
      ['openTierOnly', REQUEST_ACCESS_RULES.openTierOnlyIsBoolean],
      ['subject', REQUEST_ACCESS_RULES.subject],
      ['suspended', REQUEST_ACCESS_RULES.suspendedIsBoolean],
    ] as const) {
      test(`refuses a principal missing ${member}`, () => {
        const access = withoutPrincipalMember(member);

        const result = validateRequestAccess(access);

        assertRefusedFor(result, `principal.${member}`, rule);
      });
    }

    test('refuses a suspended principal missing attributionOnlySubject', () => {
      const access = withAnyPrincipal({
        credential: 'confirmed',
        openTierOnly: true,
        suspended: true,
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal.attributionOnlySubject',
        REQUEST_ACCESS_RULES.attributionOnlySubject,
      );
    });

    test('refuses an unknown member at the root', () => {
      const access = withMembers({ token: 'opaque' });

      const result = validateRequestAccess(access);

      assertRefusedFor(result, '(root)', REQUEST_ACCESS_RULES.members);
    });

    test('refuses an unknown member on the principal', () => {
      const access = withPrincipal({ email: 'opaque' });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal',
        REQUEST_ACCESS_RULES.principalMembers,
      );
    });

    test('refuses an unknown member on a result', () => {
      const access = withResult({ grants: [], kind: 'allow' });

      const result = validateRequestAccess(access);

      assertRefusedFor(result, 'results.<key>', ENFORCEMENT_RULES.armMembers);
    });

    for (const [member, value, rule] of [
      ['credential', 'anonymous', REQUEST_ACCESS_RULES.credential],
      ['credential', null, REQUEST_ACCESS_RULES.credential],
      ['credential', 1, REQUEST_ACCESS_RULES.credential],
      ['subject', 42, REQUEST_ACCESS_RULES.subject],
      ['subject', null, REQUEST_ACCESS_RULES.subject],
      ['subject', undefined, REQUEST_ACCESS_RULES.subject],
      ['subject', '', REQUEST_ACCESS_RULES.subject],
      ['openTierOnly', 'true', REQUEST_ACCESS_RULES.openTierOnlyIsBoolean],
      ['openTierOnly', 1, REQUEST_ACCESS_RULES.openTierOnlyIsBoolean],
      ['suspended', 'false', REQUEST_ACCESS_RULES.suspendedIsBoolean],
      ['suspended', 0, REQUEST_ACCESS_RULES.suspendedIsBoolean],
    ] as const) {
      test(`refuses a principal whose ${member} is ${JSON.stringify(value) ?? 'undefined'}`, () => {
        const access = withPrincipal({ [member]: value });

        const result = validateRequestAccess(access);

        assertRefusedFor(result, `principal.${member}`, rule);
      });
    }

    for (const [description, value] of [
      ['undefined', undefined],
      ['null', null],
      ['a string', 'usher'],
      ['a list', [signedInAccess()]],
    ] as const) {
      test(`refuses ${description} as request access, returning the refusal rather than throwing`, () => {
        const result = validateRequestAccess(value);

        assertRefusedFor(result, '(root)', REQUEST_ACCESS_RULES.isMap);
      });
    }
  });

  suite('the principal', () => {
    test('refuses a principal presenting no credential that is suspended, since only a credential can be suspended', () => {
      const access = withAnyPrincipal({
        credential: 'none',
        openTierOnly: true,
        suspended: true,
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal.suspended',
        REQUEST_ACCESS_RULES.noCredentialNeverSuspended,
      );
    });

    test('refuses an unconfirmed principal that is not suspended, since the bridge serves an unconfirmed credential only while suspended', () => {
      const access = withAnyPrincipal({
        credential: 'unconfirmed',
        openTierOnly: true,
        suspended: false,
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal.suspended',
        REQUEST_ACCESS_RULES.unconfirmedServedSuspended,
      );
    });

    for (const credential of ['none', 'unconfirmed'] as const) {
      test(`refuses a principal whose credential is ${credential} not marked open-tier only, since the open tier is all it can hold`, () => {
        const access = withAnyPrincipal({
          credential,
          openTierOnly: false,
          suspended: credential === 'unconfirmed',
        });

        const result = validateRequestAccess(access);

        assertRefusedFor(
          result,
          'principal.openTierOnly',
          REQUEST_ACCESS_RULES.unconfirmedOpenTierOnly,
        );
      });

      for (const member of ['subject', 'attributionOnlySubject']) {
        test(`refuses a principal whose credential is ${credential} carrying ${member}, since only a confirmed credential names a subject`, () => {
          const access = withAnyPrincipal({
            credential,
            [member]: SUBJECT,
            openTierOnly: true,
            suspended: credential === 'unconfirmed',
          });

          const result = validateRequestAccess(access);

          assertRefusedFor(
            result,
            'principal',
            REQUEST_ACCESS_RULES.principalMembers,
          );
        });
      }
    }

    test('refuses a suspended principal carrying subject, since a suspended principal names its subject for attribution alone', () => {
      const access = withAnyPrincipal({
        credential: 'confirmed',
        openTierOnly: true,
        subject: SUBJECT,
        suspended: true,
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal',
        REQUEST_ACCESS_RULES.principalMembers,
      );
      assertRefusedFor(
        result,
        'principal.attributionOnlySubject',
        REQUEST_ACCESS_RULES.attributionOnlySubject,
      );
    });

    test('refuses a principal whose grants hold carrying attributionOnlySubject', () => {
      const access = withPrincipal({ attributionOnlySubject: SUBJECT });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal',
        REQUEST_ACCESS_RULES.principalMembers,
      );
    });

    test('refuses a suspended principal not marked open-tier only, since suspension serves the open tier alone', () => {
      const access = withAnyPrincipal({
        attributionOnlySubject: SUBJECT,
        credential: 'confirmed',
        openTierOnly: false,
        suspended: true,
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(
        result,
        'principal.suspended',
        REQUEST_ACCESS_RULES.suspendedServesOpenTier,
      );
    });
  });

  suite('the results', () => {
    test('refuses an empty results map', () => {
      const access = withMembers({ results: {} });

      const result = validateRequestAccess(access);

      assertRefusedFor(result, 'results', REQUEST_ACCESS_RULES.results);
    });

    for (const [description, results] of [
      ['a list', [{ kind: 'allow' }]],
      ['null', null],
    ] as const) {
      test(`refuses results that are ${description} rather than a map`, () => {
        const access = withMembers({ results });

        const result = validateRequestAccess(access);

        assertRefusedFor(result, 'results', REQUEST_ACCESS_RULES.results);
      });
    }

    for (const key of ['', PROTO]) {
      test(`refuses ${JSON.stringify(key)} as a result key`, () => {
        const access = throughJson(
          withMembers({ results: { [key]: { kind: 'allow' } } }),
        );

        const result = validateRequestAccess(access);

        assertRefusedFor(
          result,
          'results.<key>',
          REQUEST_ACCESS_RULES.resultKey,
        );
      });
    }

    for (const [description, entry, position, rule] of [
      [
        'a narrowing holding an exclusion',
        {
          kind: 'narrow',
          sqon: {
            content: { fieldName: 'data_category', value: ['controlled'] },
            op: 'not-in',
          },
        },
        'results.<key>.sqon',
        ENFORCEMENT_RULES.exclusion,
      ],
      [
        'a narrowing holding an empty group',
        { kind: 'narrow', sqon: { content: [], op: 'or' } },
        'results.<key>.sqon',
        ENFORCEMENT_RULES.combinationNotEmpty,
      ],
      [
        'a deny with an unknown reason',
        { kind: 'deny', reason: 'expired' },
        'results.<key>.reason',
        ENFORCEMENT_RULES.denyReason,
      ],
      [
        'a value that is not an enforcement result',
        'allow',
        'results.<key>',
        ENFORCEMENT_RULES.isMap,
      ],
    ] as const) {
      test(`refuses a result the enforcement validator refuses: ${description}`, () => {
        const access = withResult(entry);

        const result = validateRequestAccess(access);

        assertRefusedFor(result, position, rule);
      });
    }
  });

  suite('what it returns', () => {
    test('returns a copy, so a later change to the input reaches nothing returned', () => {
      const access = signedInAccess();

      const result = validateRequestAccess(access);
      access.results['analyses'] = { kind: 'allow' };

      assert.deepEqual(result.success && result.access, signedInAccess());
    });

    test('refuses a value holding a getter that throws, returning the refusal rather than throwing', () => {
      const access = Object.defineProperty(signedInAccess(), 'principal', {
        enumerable: true,
        get: (): never => {
          throw new Error('unreadable');
        },
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(result, '(root)', READ_RULE);
    });
  });

  suite('what problems carry', () => {
    const MARKED_KEY = `${LEAK_MARKER}_key`;

    /** The words fixed by the contract, carried unmarked by a leak input. */
    const CONTRACT_WORDS: ReadonlySet<string> = new Set([
      '',
      PROTO,
      'attributionOnlySubject',
      'confirmed',
      'content',
      'credential',
      'deny',
      'fieldName',
      'in',
      'kind',
      'narrow',
      'none',
      'not-in',
      'op',
      'openTierOnly',
      'principal',
      'reason',
      'results',
      'sqon',
      'subject',
      'suspended',
      'unconfirmed',
      'value',
      'version',
    ]);

    const markedResult = (): Record<string, unknown> => ({
      kind: 'narrow',
      sqon: {
        content: {
          fieldName: `${LEAK_MARKER}_field`,
          value: [`${LEAK_MARKER}_value`],
        },
        op: 'in',
      },
    });

    /** A valid value in which every identifier and value carries the marker. */
    const markedAccess = (): Record<string, unknown> => ({
      principal: {
        credential: 'confirmed',
        openTierOnly: false,
        subject: `${LEAK_MARKER}_subject`,
        suspended: false,
      },
      results: { [MARKED_KEY]: markedResult() },
      version: 1,
    });

    const markedWith = (members: Record<string, unknown>): unknown =>
      throughJson({ ...markedAccess(), ...members });

    const markedPrincipal = (principal: Record<string, unknown>): unknown =>
      markedWith({
        principal: {
          credential: 'confirmed',
          openTierOnly: false,
          subject: `${LEAK_MARKER}_subject`,
          suspended: false,
          ...principal,
        },
      });

    const leakCases: readonly LeakCase[] = [
      {
        description: 'request access that is not a map',
        input: [markedAccess()],
        position: '(root)',
        rule: REQUEST_ACCESS_RULES.isMap,
      },
      {
        description: 'a version that is a string',
        input: markedWith({ version: `${LEAK_MARKER}_version` }),
        position: 'version',
        rule: REQUEST_ACCESS_RULES.version,
      },
      {
        description: 'an unknown member at the root',
        input: markedWith({
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value`,
        }),
        position: '(root)',
        rule: REQUEST_ACCESS_RULES.members,
      },
      {
        description: 'a principal that is not a map',
        input: markedWith({ principal: [`${LEAK_MARKER}_subject`] }),
        position: 'principal',
        rule: REQUEST_ACCESS_RULES.principalIsMap,
      },
      {
        description: 'an unknown member on the principal',
        input: markedPrincipal({
          [`${LEAK_MARKER}_member`]: `${LEAK_MARKER}_value`,
        }),
        position: 'principal',
        rule: REQUEST_ACCESS_RULES.principalMembers,
      },
      {
        description: 'an open-tier flag that is a string',
        input: markedPrincipal({ openTierOnly: `${LEAK_MARKER}_flag` }),
        position: 'principal.openTierOnly',
        rule: REQUEST_ACCESS_RULES.openTierOnlyIsBoolean,
      },
      {
        description: 'a subject that is not a string',
        input: markedPrincipal({
          subject: { [LEAK_MARKER]: `${LEAK_MARKER}_subject` },
        }),
        position: 'principal.subject',
        rule: REQUEST_ACCESS_RULES.subject,
      },
      {
        description: 'a suspension flag that is a string',
        input: markedPrincipal({ suspended: `${LEAK_MARKER}_flag` }),
        position: 'principal.suspended',
        rule: REQUEST_ACCESS_RULES.suspendedIsBoolean,
      },
      {
        description: 'a credential state that is not one of the three',
        input: markedPrincipal({ credential: `${LEAK_MARKER}_credential` }),
        position: 'principal.credential',
        rule: REQUEST_ACCESS_RULES.credential,
      },
      {
        description: 'a suspended principal presenting no credential',
        input: markedWith({
          principal: {
            credential: 'none',
            openTierOnly: true,
            suspended: true,
          },
        }),
        position: 'principal.suspended',
        rule: REQUEST_ACCESS_RULES.noCredentialNeverSuspended,
      },
      {
        description: 'an unconfirmed principal that is not suspended',
        input: markedWith({
          principal: {
            credential: 'unconfirmed',
            openTierOnly: true,
            suspended: false,
          },
        }),
        position: 'principal.suspended',
        rule: REQUEST_ACCESS_RULES.unconfirmedServedSuspended,
      },
      {
        description: 'an unconfirmed principal not marked open-tier only',
        input: markedWith({
          principal: {
            credential: 'unconfirmed',
            openTierOnly: false,
            suspended: true,
          },
        }),
        position: 'principal.openTierOnly',
        rule: REQUEST_ACCESS_RULES.unconfirmedOpenTierOnly,
      },
      {
        description:
          'an attribution-only subject that is not a string on a suspended principal',
        input: markedWith({
          principal: {
            attributionOnlySubject: { [LEAK_MARKER]: `${LEAK_MARKER}_subject` },
            credential: 'confirmed',
            openTierOnly: true,
            suspended: true,
          },
        }),
        position: 'principal.attributionOnlySubject',
        rule: REQUEST_ACCESS_RULES.attributionOnlySubject,
      },
      {
        description: 'a suspended principal not marked open-tier only',
        input: markedWith({
          principal: {
            attributionOnlySubject: `${LEAK_MARKER}_subject`,
            credential: 'confirmed',
            openTierOnly: false,
            suspended: true,
          },
        }),
        position: 'principal.suspended',
        rule: REQUEST_ACCESS_RULES.suspendedServesOpenTier,
      },
      {
        description: 'an empty result key',
        input: markedWith({ results: { '': markedResult() } }),
        position: 'results.<key>',
        rule: REQUEST_ACCESS_RULES.resultKey,
      },
      {
        description: 'a result key named __proto__',
        input: markedWith({ results: { [PROTO]: markedResult() } }),
        position: 'results.<key>',
        rule: REQUEST_ACCESS_RULES.resultKey,
      },
      {
        description: 'results that are not a map',
        input: markedWith({ results: [markedResult()] }),
        position: 'results',
        rule: REQUEST_ACCESS_RULES.results,
      },
      {
        description: 'a result key holding a refused result',
        input: markedWith({
          results: {
            [MARKED_KEY]: { kind: 'deny', reason: `${LEAK_MARKER}_reason` },
          },
        }),
        position: 'results.<key>.reason',
        rule: ENFORCEMENT_RULES.denyReason,
      },
      {
        description: 'a filter holding an exclusion',
        input: markedWith({
          results: {
            [MARKED_KEY]: {
              kind: 'narrow',
              sqon: {
                content: {
                  fieldName: `${LEAK_MARKER}_field`,
                  value: [`${LEAK_MARKER}_value`],
                },
                op: 'not-in',
              },
            },
          },
        }),
        position: 'results.<key>.sqon',
        rule: ENFORCEMENT_RULES.exclusion,
      },
    ];

    test('starts from a marked value that is itself accepted', () => {
      const access = markedAccess();

      const result = validateRequestAccess(access);

      assertInputMarked(access, CONTRACT_WORDS);
      assertAccepted(result);
    });

    for (const { description, input, position, rule } of leakCases) {
      test(`names no content of the input in the problems for ${description}`, () => {
        assertInputMarked(input, CONTRACT_WORDS);

        const result = validateRequestAccess(input);

        assertRefusedFor(result, position, rule);
        assertCarriesNoInput(result);
      });
    }

    test('names no content of an error thrown by a getter while the value is read', () => {
      const access = Object.defineProperty(markedAccess(), 'results', {
        enumerable: true,
        get: (): never => {
          throw new Error(`${LEAK_MARKER}_thrown`);
        },
      });

      const result = validateRequestAccess(access);

      assertRefusedFor(result, '(root)', READ_RULE);
      assertCarriesNoInput(result);
    });

    test('breaks every rule held by the validator, between the inputs above', () => {
      const cases = leakCases;

      assertEveryRuleBroken(cases, REQUEST_ACCESS_RULES);
    });
  });
});

suite('subjectToLog', () => {
  for (const [description, access, subject] of [
    ['a principal whose grants hold', signedInAccess(), SUBJECT],
    ['a suspended principal', suspendedAccess(), SUBJECT],
    ['a principal presenting no credential', anonymousAccess(), null],
    [
      'a principal whose credential the bridge has not confirmed',
      unconfirmedAccess(),
      null,
    ],
  ] as const) {
    test(`names ${subject === null ? 'no subject' : 'the confirmed subject'} for ${description}`, () => {
      const logged = subjectToLog(access.principal);

      assert.equal(logged, subject);
    });
  }
});

suite('UsherPrincipal', () => {
  test("lets no read of a confirmed principal's subject compile until the suspended case is named, so an ownership check never takes an attribution-only subject", () => {
    const principal: UsherPrincipal = suspendedAccess().principal;

    const owners =
      principal.credential === 'confirmed'
        ? // @ts-expect-error a confirmed principal may be suspended, whose subject is for attribution alone
          [principal.subject]
        : [];

    assert.deepEqual(owners, [undefined]);
  });

  test('gives the subject of a confirmed principal whose grants hold once the suspended case is named', () => {
    const principal: UsherPrincipal = signedInAccess().principal;

    const owners =
      principal.credential === 'confirmed' && !principal.suspended
        ? [principal.subject]
        : [];

    assert.deepEqual(owners, [SUBJECT]);
  });
});

suite('resultFor', () => {
  test('returns the result held for a key', () => {
    const access = signedInAccess();

    const result = resultFor(access, 'reference');

    assert.deepEqual(result, { kind: 'allow' });
  });

  for (const key of [
    'missing',
    'constructor',
    'toString',
    'hasOwnProperty',
    PROTO,
  ]) {
    test(`returns undefined for ${key}, a key absent from the access`, () => {
      const access = signedInAccess();

      const result = resultFor(access, key);

      assert.equal(result, undefined);
    });
  }
});
