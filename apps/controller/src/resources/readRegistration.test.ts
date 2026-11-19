import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { ACCESS_LEVELS, readRegistration } from './readRegistration.js';

// The subject of the platform administrator registering.
const CALLER = 'subject-administrator';

const read = (
  body: Readonly<Record<string, unknown>> | undefined,
): ReturnType<typeof readRegistration> => readRegistration(body, CALLER);

const REGISTRATION = Object.freeze({
  accessLevel: 'registered',
  displayName: 'Synthetic study',
  externalId: 'STUDY-A1',
});

const codeOf = (reading: ReturnType<typeof readRegistration>): string =>
  reading.kind === 'refused' ? reading.problem.code : 'read';

const statusOf = (reading: ReturnType<typeof readRegistration>): number =>
  reading.kind === 'refused' ? reading.problem.status : 200;

suite("reading a resource's registration", () => {
  test('reads each access level, and the display name, the description and the applications exactly as sent', () => {
    const readings = ACCESS_LEVELS.map((accessLevel) =>
      read({
        ...REGISTRATION,
        accessLevel,
        applications: ['b', 'a'],
        description: 'Café survey',
        displayName: 'Étude',
        fields: {},
        owners: [],
      }),
    );

    assert.deepEqual(
      readings,
      ACCESS_LEVELS.map((accessLevel) => ({
        input: {
          accessLevel,
          applications: ['b', 'a'],
          description: 'Cafe\u0301 survey',
          displayName: 'E\u0301tude',
          externalId: 'STUDY-A1',
          owners: [],
        },
        kind: 'read',
      })),
    );
  });

  test('reads a registration leaving out description, applications, fields and owners as having none of each', () => {
    assert.deepEqual(read(REGISTRATION), {
      input: {
        accessLevel: 'registered',
        applications: [],
        description: null,
        displayName: 'Synthetic study',
        externalId: 'STUDY-A1',
        owners: [],
      },
      kind: 'read',
    });
  });

  test('refuses a body by its shape 400 unreadableBody: none, a member not taken, a required member missing, or a member of another type, null included', () => {
    const bodies = [
      undefined,
      { ...REGISTRATION, retired: false },
      { accessLevel: 'open', displayName: 'Synthetic study' },
      { accessLevel: 'open', externalId: 'STUDY-A1' },
      { ...REGISTRATION, accessLevel: null },
      { ...REGISTRATION, accessLevel: 1 },
      { ...REGISTRATION, description: null },
      { ...REGISTRATION, displayName: ['Synthetic study'] },
      { ...REGISTRATION, applications: 'arranger' },
      { ...REGISTRATION, applications: [1] },
      { ...REGISTRATION, fields: [] },
      { ...REGISTRATION, fields: { organization: null } },
      { ...REGISTRATION, owners: {} },
      { ...REGISTRATION, owners: ['ana@example.org'] },
    ];

    const readings = bodies.map((body) => read(body));

    assert.deepEqual(
      readings.map((reading) => [statusOf(reading), codeOf(reading)]),
      bodies.map(() => [400, 'unreadableBody']),
    );
  });

  test('names in a refusal of its shape the rule broken, never a value sent', () => {
    const readings = [
      read({ ...REGISTRATION, sentByTheCaller: 'x' }),
      read({ accessLevel: 'open', externalId: 'STUDY-A1' }),
      read({ ...REGISTRATION, accessLevel: null }),
    ];

    assert.deepEqual(
      readings.map((reading) =>
        reading.kind === 'refused' ? reading.problem.detail : undefined,
      ),
      [
        'The body holds a member this operation does not take: it takes accessLevel, applications, description, displayName, externalId, fields and owners alone.',
        'The body lacks the member displayName.',
        'The body holds accessLevel as something other than a string.',
      ],
    );
  });

  test('refuses a registration naming no access level 422 accessLevelRequired, and one naming another 422 unknownAccessLevel', () => {
    const unnamed = Object.fromEntries(
      Object.entries(REGISTRATION).filter(([name]) => name !== 'accessLevel'),
    );

    const readings = [
      read(unnamed),
      ...['', 'Open', 'controlled', 'public'].map((accessLevel) =>
        read({ ...REGISTRATION, accessLevel }),
      ),
    ];

    assert.deepEqual(readings.map(codeOf), [
      'accessLevelRequired',
      'unknownAccessLevel',
      'unknownAccessLevel',
      'unknownAccessLevel',
      'unknownAccessLevel',
    ]);
    assert.deepEqual(
      readings.map(statusOf),
      readings.map(() => 422),
    );
  });

  test('refuses an externalId breaking a rule of its form 422, naming the rule', () => {
    const externalIds = [
      'ÉTUDE',
      '',
      'A'.repeat(129),
      '__proto__',
      'A__missing__B',
    ];

    assert.deepEqual(
      externalIds.map((externalId) =>
        codeOf(read({ ...REGISTRATION, externalId })),
      ),
      [
        'externalIdNotNormalized',
        'externalIdLength',
        'externalIdLength',
        'externalIdCharacters',
        'externalIdFilterMarker',
      ],
    );
  });

  test('counts a display name and a description once normalized to NFC, refusing a blank name, a longer name and a longer description 422', () => {
    const decomposed = (count: number): string => 'é'.repeat(count);

    const readings = [
      read({ ...REGISTRATION, displayName: decomposed(256) }),
      read({ ...REGISTRATION, displayName: decomposed(257) }),
      read({ ...REGISTRATION, displayName: ' \t\n' }),
      read({ ...REGISTRATION, displayName: '' }),
      read({ ...REGISTRATION, description: decomposed(4096) }),
      read({ ...REGISTRATION, description: decomposed(4097) }),
    ];

    assert.deepEqual(readings.map(codeOf), [
      'read',
      'displayNameTooLong',
      'displayNameBlank',
      'displayNameBlank',
      'read',
      'descriptionTooLong',
    ]);
  });

  test('accepts a decomposed description at the limit once normalized to NFC, keeping it decomposed, and refuses one a character past it', () => {
    const atLimit = 'e\u0301'.repeat(4096);
    const pastLimit = `${atLimit}e\u0301`;

    const accepted = read({
      ...REGISTRATION,
      description: atLimit,
    });
    const refusedPast = read({
      ...REGISTRATION,
      description: pastLimit,
    });

    assert.equal(atLimit.length, 8192);
    assert.equal(
      accepted.kind === 'read' ? accepted.input.description : undefined,
      atLimit,
    );
    assert.deepEqual(
      [statusOf(refusedPast), codeOf(refusedPast)],
      [422, 'descriptionTooLong'],
    );
  });

  test('judges a display name blank by its text once trimmed, and keeps a name with whitespace around it as given', () => {
    assert.equal(
      codeOf(read({ ...REGISTRATION, displayName: '\u00a0 \t' })),
      'displayNameBlank',
    );
    const spaced = read({
      ...REGISTRATION,
      displayName: '  Synthetic study ',
    });
    assert.equal(
      spaced.kind === 'read' ? spaced.input.displayName : undefined,
      '  Synthetic study ',
    );
  });

  test('refuses any value for a resource field 422 unknownResourceField', () => {
    const reading = read({
      ...REGISTRATION,
      fields: { organization: 'Lakeshore Example Institute' },
    });

    assert.deepEqual(
      [statusOf(reading), codeOf(reading)],
      [422, 'unknownResourceField'],
    );
  });

  test('reads its owners in the order named, each one person by subject or by address, as given', () => {
    const reading = read({
      ...REGISTRATION,
      owners: [{ subject: 'subject-ana' }, { email: 'Owner.Bo@Example.org' }],
    });

    assert.deepEqual(reading.kind === 'read' ? reading.input.owners : reading, [
      { kind: 'subject', subject: 'subject-ana' },
      { email: 'Owner.Bo@Example.org', kind: 'address' },
    ]);
  });

  test('refuses an owner naming its subject or address as anything but a string 400, and one naming other than one person, or an address out of form, 422', () => {
    const readings = [
      { email: 7 },
      { group: 'study-team' },
      { email: 'ana@example.org', subject: 'subject-ana' },
      { email: 'ana@' },
    ].map((owner) => read({ ...REGISTRATION, owners: [owner] }));

    assert.deepEqual(
      readings.map((reading) => [statusOf(reading), codeOf(reading)]),
      [
        [400, 'unreadableBody'],
        [422, 'holderNotOnePerson'],
        [422, 'holderNotOnePerson'],
        [422, 'addressForm'],
      ],
    );
  });

  test('refuses one person named twice 422 ownerNamedTwice, by the same subject or by an address in any letter case', () => {
    const readings = [
      [{ subject: 'subject-ana' }, { subject: 'subject-ana' }],
      [{ email: 'ana@example.org' }, { email: 'Ana@Example.org' }],
    ].map((owners) => read({ ...REGISTRATION, owners }));
    const apart = read({
      ...REGISTRATION,
      owners: [{ subject: 'subject-ana' }, { subject: 'Subject-Ana' }],
    });

    assert.deepEqual(
      readings.map((reading) => [statusOf(reading), codeOf(reading)]),
      [
        [422, 'ownerNamedTwice'],
        [422, 'ownerNamedTwice'],
      ],
    );
    assert.equal(apart.kind, 'read');
  });

  test('refuses the caller named an owner 403 administratorSelfOwnership, once every rule of the body holds', () => {
    const named = read({
      ...REGISTRATION,
      owners: [{ subject: 'subject-ana' }, { subject: CALLER }],
    });
    const brokenFirst = read({
      ...REGISTRATION,
      owners: [{ subject: CALLER }, { email: 'ana@' }],
    });

    assert.deepEqual(
      [statusOf(named), codeOf(named)],
      [403, 'administratorSelfOwnership'],
    );
    assert.deepEqual(
      [statusOf(brokenFirst), codeOf(brokenFirst)],
      [422, 'addressForm'],
    );
  });

  test('judges a body by its shape before any rule, and the externalId before the other rules', () => {
    const readings = [
      read({
        accessLevel: null,
        displayName: '',
        externalId: '',
      }),
      read({
        displayName: '',
        externalId: '',
        owners: [{ subject: 'subject-ana' }],
      }),
      read({
        displayName: '',
        externalId: 'STUDY-A1',
        owners: [{ subject: 'subject-ana' }],
      }),
    ];

    assert.deepEqual(readings.map(codeOf), [
      'unreadableBody',
      'externalIdLength',
      'displayNameBlank',
    ]);
  });
});
