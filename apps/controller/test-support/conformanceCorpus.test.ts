import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { validatePayload } from '@overture-stack/usher-types';

import {
  assertConformsToCorpus,
  comparablePayload,
  CONFORMANCE_APPLICATIONS,
  CONFORMANCE_CONFIGURATIONS,
  type ConformanceConfigurationName,
  CORPUS_ANA,
  CORPUS_CASES,
  type CorpusAudiences,
  CORPUS_FILES,
  type CorpusEntry,
  EXPECTATION_CASES,
  readCorpusEntry,
  readCorpusExpectation,
  readCorpusIndex,
} from './conformanceCorpus.js';
import { STARTED_STORE_TEMPLATE, startHarness } from './harness.js';
import { storedExternalIds } from './policy.js';

const PAYLOAD = Object.freeze({
  aud: 'arranger-prod',
  exp: 1_767_225_900,
  generatedAt: 1_767_225_600,
  globalCategories: ['global.community-governed', 'global.controlled'],
  iat: 1_767_225_600,
  iss: 'https://usher.example.org',
  payloadVersion: 1,
  permissions: {
    HEART_STUDY: {
      'global.controlled': {
        record: ['view', 'count', 'export', 'update'],
      },
      'global.unmarked': { record: ['count', 'view', 'export'] },
    },
  },
  resourceCategories: { HEART_STUDY: [] },
  servedResources: ['VOID_INDEX', 'HEART_STUDY'],
  sub: CORPUS_ANA.subject,
});

// The registered ids the comparison reads the corpus's audience labels as, one fresh uuid per label,
// as a harness's registrations give them.
const REGISTERED_IDS: ReadonlyMap<string, string> = new Map(
  Object.values(CONFORMANCE_APPLICATIONS).map((label) => [label, randomUUID()]),
);

const AUDIENCES: CorpusAudiences = {
  application: (label) => ({
    id: REGISTERED_IDS.get(label) ?? assert.fail(`no id for ${label}`),
  }),
};

const registeredIdOf = (label: string): string =>
  AUDIENCES.application(label).id;

const anonymousEntry = (actions: readonly string[]): object => ({
  case: '02',
  description: 'Anonymous, baseline on.',
  id: 'case-02',
  payload: {
    ...PAYLOAD,
    permissions: {
      HEART_STUDY: { 'global.unmarked': { record: actions } },
      LUNG_COHORT: { 'global.unmarked': { record: actions } },
    },
    sub: null,
  },
});

const PRINCIPALS = Object.freeze({
  omitted: [{ case: '25', reason: 'refused at writing' }],
  principals: [
    anonymousEntry(['count', 'view', 'export']),
    {
      case: '05',
      description: 'A grant accepted at curator.',
      id: 'case-05',
      payload: PAYLOAD,
    },
    {
      case: '21',
      description: 'Not yet implementable.',
      id: 'case-21',
      implementable: false,
      payload: PAYLOAD,
    },
    {
      case: '09',
      description: 'An entry in a shape version 1 refuses.',
      id: 'case-09',
      payload: { ...PAYLOAD, offeredCategories: {} },
    },
  ],
});

const EXPECTATIONS = Object.freeze({
  cases: [
    {
      keyRegistration: { kind: 'open' },
      principalId: 'case-05',
      records: [
        {
          fields: { study_id: 'HEART_STUDY' },
          outcome: 'served',
          reason: 'Unmarked, and held.',
        },
      ],
    },
    {
      keyRegistration: { kind: 'open' },
      principalId: 'case-10',
      records: [{ fields: { study_id: 'VOID_INDEX' }, outcome: 'hidden' }],
    },
  ],
  formatVersion: 1,
});

const corpusDirectory = async (
  context: TestContext,
  files: Readonly<Record<string, unknown>>,
): Promise<URL> => {
  const directory = await mkdtemp(join(tmpdir(), 'usher-corpus-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(join(directory, name), JSON.stringify(content)),
    ),
  );
  return pathToFileURL(`${directory}/`);
};

const CORRECTED_FORM = /the suites read its corrected form/u;

suite("the corpus's case lists", () => {
  test('name every case from 01 to 35 once, in one list each, each unreached or omitted case with its reason', () => {
    const named = [
      ...Object.keys(CORPUS_CASES.replayed),
      ...Object.keys(CORPUS_CASES.unreachable),
      ...Object.keys(CORPUS_CASES.omitted),
    ];
    const numbered = Array.from({ length: 35 }, (_, index) =>
      String(index + 1).padStart(2, '0'),
    );

    assert.equal(new Set(named).size, named.length);
    assert.deepEqual(
      named.toSorted(),
      [...numbered, '19b', '24b', '24c'].toSorted(),
    );
    assert.ok(
      [
        ...Object.values(CORPUS_CASES.unreachable),
        ...Object.values(CORPUS_CASES.omitted),
      ].every((reason) => reason.length > 20),
    );
    assert.ok(
      EXPECTATION_CASES.every((caseNumber) =>
        Object.hasOwn(CORPUS_CASES.replayed, caseNumber),
      ),
    );
  });
});

suite("reading the corpus's entries", () => {
  test('gives a case its entry, its payload as version 1 reads it', async (context) => {
    const directory = await corpusDirectory(context, {
      [CORPUS_FILES.expectations]: EXPECTATIONS,
      [CORPUS_FILES.principals]: PRINCIPALS,
    });

    const entry = readCorpusEntry('05', directory);
    const unimplementable = readCorpusEntry('21', directory);

    assert.deepEqual(
      { case: entry.case, id: entry.id, sub: entry.payload.sub },
      { case: '05', id: 'case-05', sub: CORPUS_ANA.subject },
    );
    assert.equal(unimplementable.implementable, false);
    assert.equal(Object.hasOwn(entry, 'implementable'), false);
    assert.deepEqual(readCorpusIndex(directory), {
      entries: ['02', '05', '21', '09'],
      omitted: ['25'],
    });
  });

  test('fails naming the corpus and the branch it comes with, for a file or an entry missing, or an entry version 1 refuses', async (context) => {
    const directory = await corpusDirectory(context, {
      [CORPUS_FILES.expectations]: EXPECTATIONS,
      [CORPUS_FILES.principals]: PRINCIPALS,
    });
    const principalsAlone = await corpusDirectory(context, {
      [CORPUS_FILES.principals]: PRINCIPALS,
    });
    const empty = await corpusDirectory(context, {});

    assert.throws(() => readCorpusEntry('05', empty), {
      message: /principals\.json\) is missing here/u,
    });
    assert.throws(() => readCorpusEntry('05', empty), {
      message: CORRECTED_FORM,
    });
    assert.throws(() => readCorpusIndex(empty), { message: CORRECTED_FORM });
    assert.throws(() => readCorpusEntry('17', directory), {
      message: /holds no entry for case 17 here/u,
    });
    assert.throws(() => readCorpusEntry('09', directory), {
      message: /in a form usher-types' validatePayload refuses/u,
    });
    assert.throws(() => readCorpusExpectation('05', principalsAlone), {
      message: /expectations\.json\) is missing here/u,
    });
  });

  test('refuses the corpus in its old form, naming it and the branch its corrected form comes with', async (context) => {
    const withoutExpectations = await corpusDirectory(context, {
      [CORPUS_FILES.principals]: PRINCIPALS,
    });
    const viewAlone = await corpusDirectory(context, {
      [CORPUS_FILES.expectations]: EXPECTATIONS,
      [CORPUS_FILES.principals]: {
        ...PRINCIPALS,
        principals: [
          anonymousEntry(['view']),
          ...PRINCIPALS.principals.slice(1),
        ],
      },
    });

    [
      () => readCorpusEntry('05', withoutExpectations),
      () => readCorpusIndex(withoutExpectations),
    ].forEach((read) => {
      assert.throws(read, { message: /expectations\.json\) is missing here/u });
      assert.throws(read, { message: CORRECTED_FORM });
    });
    [
      () => readCorpusEntry('05', viewAlone),
      () => readCorpusIndex(viewAlone),
      () => readCorpusExpectation('05', viewAlone),
    ].forEach((read) => {
      assert.throws(read, {
        message:
          /principals\.json\) is the old corpus here, its baseline granting view alone/u,
      });
      assert.throws(read, { message: CORRECTED_FORM });
    });
  });

  test('gives an expectations case its key and records, refusing a record whose outcome it does not name', async (context) => {
    const directory = await corpusDirectory(context, {
      [CORPUS_FILES.expectations]: EXPECTATIONS,
      [CORPUS_FILES.principals]: PRINCIPALS,
    });

    const expectation = readCorpusExpectation('05', directory);

    assert.deepEqual(expectation, {
      keyRegistration: { kind: 'open' },
      principalId: 'case-05',
      records: [
        {
          fields: { study_id: 'HEART_STUDY' },
          outcome: 'served',
          reason: 'Unmarked, and held.',
        },
      ],
    });
    assert.throws(() => readCorpusExpectation('10', directory), {
      message: CORRECTED_FORM,
    });
    assert.throws(() => readCorpusExpectation('22', directory), {
      message: /holds no case for case-22 here/u,
    });
  });
});

suite("a payload compared with the corpus's", () => {
  const entryOf = (payload: unknown): CorpusEntry => {
    const validated = validatePayload(payload);
    assert.ok(validated.success);
    return {
      case: '05',
      description: 'A grant accepted at curator.',
      id: 'case-05',
      payload: validated.payload,
    };
  };

  test('compares lists as sets and never the temporal claims', () => {
    const issued = {
      ...PAYLOAD,
      aud: registeredIdOf(PAYLOAD.aud),
      exp: 1_800_000_300,
      generatedAt: 1_800_000_000,
      globalCategories: ['global.controlled', 'global.community-governed'],
      iat: 1_800_000_000,
      permissions: {
        HEART_STUDY: {
          'global.controlled': {
            record: ['update', 'export', 'count', 'view'],
          },
          'global.unmarked': { record: ['export', 'view', 'count'] },
        },
      },
      servedResources: ['HEART_STUDY', 'VOID_INDEX'],
    };

    assert.doesNotThrow(() =>
      assertConformsToCorpus(issued, entryOf(PAYLOAD), AUDIENCES),
    );
  });

  test('fails for an action, a served resource, the subject or the audience differing, the audience named by its label included, and for a payload version 1 refuses', () => {
    const issued = { ...PAYLOAD, aud: registeredIdOf(PAYLOAD.aud) };
    const differing = [
      {
        ...issued,
        permissions: {
          HEART_STUDY: {
            ...PAYLOAD.permissions.HEART_STUDY,
            'global.unmarked': { record: ['count', 'view'] },
          },
        },
      },
      { ...issued, servedResources: ['HEART_STUDY'] },
      { ...issued, sub: 'another-subject' },
      { ...issued, aud: registeredIdOf(CONFORMANCE_APPLICATIONS.lyricExample) },
      { ...issued, aud: PAYLOAD.aud },
      { ...issued, iat: PAYLOAD.exp },
    ];

    assert.doesNotThrow(() =>
      assertConformsToCorpus(issued, entryOf(PAYLOAD), AUDIENCES),
    );
    differing.forEach((departing) =>
      assert.throws(
        () => assertConformsToCorpus(departing, entryOf(PAYLOAD), AUDIENCES),
        { name: 'AssertionError' },
      ),
    );
    assert.deepEqual(
      Object.keys(comparablePayload(entryOf(PAYLOAD).payload)).toSorted(),
      [
        'aud',
        'globalCategories',
        'iss',
        'payloadVersion',
        'permissions',
        'resourceCategories',
        'servedResources',
        'sub',
      ],
    );
  });
});

suite('the configurations the corpus was computed against', () => {
  test('seed as fixtures, A by A and B by B, their settings as #215 defines them', async () => {
    const seen = await Promise.all(
      (
        Object.entries(CONFORMANCE_CONFIGURATIONS) as [
          ConformanceConfigurationName,
          (typeof CONFORMANCE_CONFIGURATIONS)[ConformanceConfigurationName],
        ][]
      ).map(async ([name, { applications, configuration, fixture }]) => {
        const harness = await startHarness({
          applications,
          configuration,
          fixture,
          startsController: false,
          template: STARTED_STORE_TEMPLATE,
        });
        try {
          return {
            autoAccept: harness.configuration.autoAccept,
            baseline: harness.configuration.baseline,
            externalIds: await storedExternalIds(harness.clients.migration),
            heartStudy: fixture.resources?.['HEART_STUDY']?.baseTier,
            issuer: harness.configuration.issuer,
            name,
          };
        } finally {
          await harness.stop();
        }
      }),
    );

    assert.deepEqual(
      seen.map(({ autoAccept, baseline, heartStudy, name }) => ({
        autoAccept,
        baseline: baseline.length,
        heartStudy,
        name,
      })),
      [
        { autoAccept: false, baseline: 3, heartStudy: 'grant', name: "A'" },
        { autoAccept: false, baseline: 3, heartStudy: 'open', name: 'A' },
        { autoAccept: true, baseline: 3, heartStudy: 'open', name: 'A-auto' },
        { autoAccept: false, baseline: 0, heartStudy: 'open', name: 'A-off' },
        { autoAccept: false, baseline: 3, heartStudy: 'open', name: 'B' },
        { autoAccept: false, baseline: 0, heartStudy: 'open', name: 'B-off' },
      ],
    );
    assert.ok(
      seen.every(({ issuer }) => issuer === 'https://usher.example.org'),
    );
    assert.deepEqual(seen.find(({ name }) => name === 'A')?.externalIds, [
      'HEART_STUDY',
      'LUNG_COHORT',
      'REEF_ARCHIVE',
      'STUDY-A1',
      'VOID_INDEX',
    ]);
    assert.deepEqual(seen.find(({ name }) => name === 'B')?.externalIds, [
      'HEART_STUDY',
      'MEMBERS_ARCHIVE',
      'OPEN_ATLAS',
      'SEALED_ARCHIVE',
    ]);
  });
});
