import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { suite, test } from 'node:test';

import * as usherTypes from './index.js';
import type {
  ArtifactAction,
  CategoryCondition,
  CategoryConditions,
  CategoryConditionValidationResult,
  CategoryName,
  CategoryPermissions,
  ControlEntity,
  DataEntity,
  Enforcement,
  EnforcementValidationResult,
  Entity,
  FieldAction,
  HeldResource,
  KeyRegistration,
  NonEmpty,
  Notice,
  NoticeValidationResult,
  OpenKeyRegistration,
  ParsedExclusion,
  ParsedRecordNarrowing,
  ParsedScopedCondition,
  ParsedUnmarked,
  PayloadValidationResult,
  PermissionsPayload,
  PollAnswer,
  PollAnswerValidationResult,
  RecordAction,
  RecordKeyRegistration,
  RecordNarrowingDescription,
  RecordNarrowingParseResult,
  RegistrationValidationResult,
  RequestAccessValidationResult,
  ResourceIdentifier,
  ResourcePermissions,
  RevisionAction,
  UsherPrincipal,
  UsherRequestAccess,
  ValidationProblem,
} from './index.js';

const sourceDirectory = new URL('.', import.meta.url);

/** The files built into the package: every module here except tests and their support. */
const shippedSourceFiles = (): readonly string[] =>
  readdirSync(sourceDirectory).filter(
    (name) =>
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      name !== 'testSupport.ts',
  );

/** Every module specifier named in a source file, in a static or dynamic import or a re-export. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;

const specifiersOf = (name: string): readonly string[] =>
  Array.from(
    readFileSync(new URL(name, sourceDirectory), 'utf8').matchAll(SPECIFIER),
    ([, specifier]) => specifier ?? '',
  );

/** The source files of this package a file imports, by file name. */
const localImportsOf = (name: string): readonly string[] =>
  specifiersOf(name)
    .filter((specifier) => specifier.startsWith('./'))
    .map((specifier) => specifier.slice(2).replace(/\.js$/u, '.ts'));

/** Every source file reached by following imports from `start`, `start` itself only through a cycle. */
const reachableFrom = (start: string): ReadonlySet<string> => {
  const visit = (
    pending: readonly string[],
    seen: ReadonlySet<string>,
  ): ReadonlySet<string> => {
    const [next, ...rest] = pending;

    if (next === undefined) {
      return seen;
    }

    return seen.has(next)
      ? visit(rest, seen)
      : visit([...rest, ...localImportsOf(next)], new Set([...seen, next]));
  };

  return visit(localImportsOf(start), new Set());
};

suite('the package root', () => {
  test('exports every function defined by the contract', () => {
    const exported = [
      usherTypes.attachAccess,
      usherTypes.canonicalOperatorOf,
      usherTypes.canonicalRecordNarrowing,
      usherTypes.fieldNamesReadBy,
      usherTypes.isCategoryName,
      usherTypes.isLiteralValue,
      usherTypes.keySegment,
      usherTypes.normalizedCondition,
      usherTypes.parseRecordNarrowing,
      usherTypes.readAccess,
      usherTypes.resultFor,
      usherTypes.subjectToLog,
      usherTypes.validateCategoryCondition,
      usherTypes.validateEnforcement,
      usherTypes.validateNotice,
      usherTypes.validatePayload,
      usherTypes.validatePollAnswer,
      usherTypes.validateRegistration,
      usherTypes.validateRequestAccess,
    ];

    const kinds = exported.map((member) => typeof member);

    assert.deepEqual(
      kinds,
      exported.map(() => 'function'),
    );
  });

  test("exports the values a client reads off the bridge's answers: the suspended header and its value, and the challenge's error codes, frozen", () => {
    const wire = {
      challengeErrors: usherTypes.CHALLENGE_ERRORS,
      suspendedHeader: usherTypes.SUSPENDED_HEADER,
      suspendedValue: usherTypes.SUSPENDED_VALUE,
    };

    assert.deepEqual(wire, {
      challengeErrors: {
        invalidRequest: 'invalid_request',
        invalidToken: 'invalid_token',
      },
      suspendedHeader: 'Usher-Suspended',
      suspendedValue: 'true',
    });
    assert.equal(Object.isFrozen(wire.challengeErrors), true);
  });

  test('exports the markers read specially in a value, frozen so no caller can narrow what is refused', () => {
    const markers = usherTypes.SPECIAL_VALUE_MARKERS;

    assert.deepEqual(markers, ['*', '__missing__', 'set_id:']);
    assert.equal(Object.isFrozen(markers), true);
  });

  test("exports the payload's member names, frozen, for a reader to require as claims", () => {
    const names = usherTypes.PAYLOAD_MEMBER_NAMES;

    assert.deepEqual([...names].toSorted(), [
      'aud',
      'exp',
      'generatedAt',
      'globalCategories',
      'iat',
      'iss',
      'payloadVersion',
      'permissions',
      'resourceCategories',
      'servedResources',
      'sub',
    ]);
    assert.equal(Object.isFrozen(names), true);
  });

  test('exports the payload version validatePayload reads, for a reader to select it by rather than by a copy written by hand', () => {
    const refusesVersion = (payloadVersion: number): boolean => {
      const result = usherTypes.validatePayload({ payloadVersion });
      return (
        !result.success &&
        result.problems.some(({ position }) => position === 'payloadVersion')
      );
    };

    assert.equal(usherTypes.PAYLOAD_VERSION, 1);
    assert.equal(refusesVersion(usherTypes.PAYLOAD_VERSION), false);
    assert.equal(refusesVersion(usherTypes.PAYLOAD_VERSION + 1), true);
  });

  test('exports the wording of every rule held by the condition, registration and record narrowing validators, so a caller can name each one', () => {
    const rules = [
      ...Object.values(usherTypes.CONDITION_RULES),
      ...Object.values(usherTypes.RECORD_NARROWING_RULES),
      ...Object.values(usherTypes.REGISTRATION_RULES),
      ...Object.values(usherTypes.RENDERED_NARROWING_RULES),
    ];

    const kinds = rules.map((rule) => typeof rule);

    assert.ok(rules.length > 0);
    assert.deepEqual(
      kinds,
      rules.map(() => 'string'),
    );
  });

  test('exports one error class, which is an Error', () => {
    const error = new usherTypes.UsherContractError('a rule was broken');

    assert.equal(error instanceof Error, true);
  });

  test('exports every type defined by the contract', () => {
    const recordActions: NonEmpty<RecordAction> = ['view'];
    const fieldActions: NonEmpty<FieldAction> = ['view'];
    const revisionActions: NonEmpty<RevisionAction> = ['view'];
    const artifactActions: NonEmpty<ArtifactAction> = ['view'];
    const categoryName: CategoryName = 'global.unmarked';
    const resource: ResourceIdentifier = 'HEART_STUDY';
    const categoryPermissions: CategoryPermissions = {
      artifact: artifactActions,
      field: { 'global.basic': fieldActions },
      record: recordActions,
      revision: revisionActions,
    };
    const resourcePermissions: ResourcePermissions = {
      [categoryName]: categoryPermissions,
    };
    const payload: PermissionsPayload = {
      payloadVersion: 1,
      sub: null,
      iss: 'https://usher.example.org',
      aud: 'arranger-prod',
      iat: 1767225600,
      exp: 1767225900,
      generatedAt: 1767225600,
      permissions: { [resource]: resourcePermissions },
      globalCategories: [],
      resourceCategories: { [resource]: [] },
      servedResources: [resource],
    };
    const entities: readonly Entity[] = [
      'record' satisfies DataEntity,
      'grant' satisfies ControlEntity,
    ];
    const condition: CategoryCondition = {
      content: { fieldName: 'data_category', value: ['controlled'] },
      op: 'in',
    };
    const heldResource: HeldResource = {
      heldCategories: ['global.controlled'],
      resource,
      resourceCategories: {},
      unmarkedHeld: false,
    };
    const recordDescription: RecordNarrowingDescription = {
      globalCategories: { 'global.controlled': condition },
      heldResources: [heldResource],
      knownResources: [resource],
      resourceFieldName: 'study_id',
    };
    const recordEnforcement: Enforcement = {
      kind: 'narrow',
      sqon: usherTypes.canonicalRecordNarrowing(recordDescription),
    };
    const unmappedDenial: Enforcement = {
      kind: 'deny',
      reason: 'unmapped-category',
    };
    const principal: UsherPrincipal = {
      credential: 'none',
      openTierOnly: true,
      suspended: false,
    };
    const access: UsherRequestAccess = {
      principal,
      results: {
        files: recordEnforcement,
        samples: unmappedDenial,
      },
      version: 1,
    };

    const payloadResult: PayloadValidationResult =
      usherTypes.validatePayload(payload);
    const enforcementResult: EnforcementValidationResult =
      usherTypes.validateEnforcement(recordEnforcement);
    const accessResult: RequestAccessValidationResult =
      usherTypes.validateRequestAccess(access);
    const notice: Notice = {
      cursor: 'c-42',
      kind: 'principal',
      subjectTag: 'tag-ana',
      v: 1,
    };
    const answer: PollAnswer = {
      after: 'head',
      more: false,
      next: 'c-42',
      nonce: 'nonce-1',
      notices: [notice],
      v: 1,
    };
    const noticeResult: NoticeValidationResult =
      usherTypes.validateNotice(notice);
    const answerResult: PollAnswerValidationResult =
      usherTypes.validatePollAnswer(answer);
    const categories: CategoryConditions = {
      global: { 'global.controlled': condition },
      resource: {
        [resource]: {
          'resource.pilot': {
            content: { fieldName: 'cohort', value: ['pilot'] },
            op: 'in',
          },
        },
      },
    };
    const registrations: readonly KeyRegistration[] = [
      {
        absentCategories: ['global.embargoed'],
        categories,
        kind: 'record',
        resourceFieldName: 'study_id',
        resources: [resource],
      } satisfies RecordKeyRegistration,
      { kind: 'open' } satisfies OpenKeyRegistration,
    ];
    const parseResult: RecordNarrowingParseResult =
      usherTypes.parseRecordNarrowing(recordEnforcement.sqon);
    const parsed: ParsedRecordNarrowing | undefined = parseResult.success
      ? parseResult.narrowing
      : undefined;
    const exclusions: readonly ParsedExclusion[] = parsed?.exclusions ?? [];
    const unmarked: ParsedUnmarked | undefined = parsed?.unmarked;
    const scoped: readonly ParsedScopedCondition[] =
      unmarked?.scopedConditions ?? [];
    const conditionResult: CategoryConditionValidationResult =
      usherTypes.validateCategoryCondition(condition);
    const registrationResults: readonly RegistrationValidationResult[] =
      registrations.map(usherTypes.validateRegistration);
    const problems: readonly ValidationProblem[] = [
      payloadResult,
      enforcementResult,
      accessResult,
      noticeResult,
      answerResult,
      conditionResult,
      parseResult,
      ...registrationResults,
    ].flatMap((result) => (result.success ? [] : result.problems));

    assert.deepEqual(problems, []);
    assert.deepEqual(exclusions, []);
    assert.deepEqual(unmarked?.lacking, [resource]);
    assert.deepEqual(scoped, []);
    assert.equal(entities.length, 2);
    assert.deepEqual(usherTypes.fieldNamesReadBy(condition), ['data_category']);
  });
});

suite('the package source', () => {
  test('imports zod in no shipped file, so no schema here can compose SqonSchema into its own', () => {
    const files = shippedSourceFiles();

    const zodImports = files.filter((name) =>
      specifiersOf(name).some(
        (specifier) => specifier === 'zod' || specifier.startsWith('zod/'),
      ),
    );

    assert.ok(files.length >= 8, `read only ${files.join(', ')}`);
    assert.ok(
      files.flatMap(specifiersOf).includes('@overture-stack/sqon'),
      'the scan finds @overture-stack/sqon, imported by the source',
    );
    assert.deepEqual(zodImports, []);
  });

  test('imports no module that imports it back, so no cycle runs through the package', () => {
    const files = shippedSourceFiles();

    const cyclic = files.filter((name) => reachableFrom(name).has(name));

    assert.ok(reachableFrom('recordNarrowing.ts').has('enforcement.ts'));
    assert.deepEqual(cyclic, []);
  });

  test('reads SQON operators and values in a module importing none of the validators', () => {
    const imported = localImportsOf('sqonPrimitives.ts');

    assert.deepEqual(imported, ['plainData.ts']);
  });
});
