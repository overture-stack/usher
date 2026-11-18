import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import type { ResourceStanding } from '../resourceStanding/index.js';
import { createGrantRoutes } from './createGrantRoutes.js';
import type {
  GrantStore,
  NewDecision,
  NewGrant,
  StoredGrant,
  StoredRole,
} from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const GRANT_ID = '6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e';

const UNKNOWN_GRANT_ID = '0c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f';

const VIEWER: StoredRole = {
  capabilities: ['record.count', 'record.export', 'record.view'],
  id: 'role-viewer',
  name: 'viewer',
  plane: 'data',
};

const ROLES: Readonly<Record<string, StoredRole>> = {
  owner: {
    capabilities: ['grant.create', 'grant.revoke', 'resource.view'],
    id: 'role-owner',
    name: 'owner',
    plane: 'control',
  },
  submitter: {
    capabilities: ['record.create', 'record.update'],
    id: 'role-submitter',
    name: 'submitter',
    plane: 'data',
  },
  viewer: VIEWER,
};

const STUDY_A1: ResourceStanding = {
  accessLevel: 'grant',
  countedOwner: false,
  externalId: 'STUDY-A1',
  holder: false,
  id: 'resource-a1',
  retired: false,
  suppressed: false,
};

// Cy's pending viewer grant on STUDY-A1 under `global.controlled`, granted by Ana.
const PENDING: StoredGrant = {
  category: 'global.controlled',
  decision: null,
  endedAt: null,
  expiresAt: null,
  grantedAt: new Date(NOW - 60_000),
  granterSubject: 'subject-ana',
  holderSubject: 'subject-cy',
  holderUserId: 'person-cy',
  id: GRANT_ID,
  resource: 'STUDY-A1',
  resourceId: 'resource-a1',
  resourceRetired: false,
  revokedAt: null,
  revokerSubject: null,
  role: 'viewer',
  selfGrant: false,
};

/** What the fake store holds for one test. */
interface World {
  /** The categories every resource offers, by scoped name, each with its id. */
  categories: Readonly<Record<string, string>>;

  /** What failure the transaction's COMMIT meets, where one does. */
  commitFailure?: unknown;

  /** How many counted owners a resource has besides a grant's holder. */
  countedOwnersBesides: number;

  /** The grant the store holds, by its id. */
  grant: StoredGrant | undefined;

  /** Whether a creation finds its terms held already. */
  held: boolean;

  /** The externalIds of the resources the store holds, whatever their standing. */
  registered: readonly string[];

  /** Where each subject stands on STUDY-A1. */
  standings: Readonly<Record<string, Partial<ResourceStanding>>>;
}

interface Call {
  method: keyof GrantStore;
  values: readonly unknown[];
}

interface Stand {
  calls: Call[];
  recorded: AuditEvent[];
  server: FastifyInstance;

  /** How many transactions the grant operations began, as they began. */
  transactions: { count: number };
}

const WORLD: World = {
  categories: {
    'global.controlled': 'category-controlled',
    'global.unmarked': 'category-unmarked',
  },
  countedOwnersBesides: 1,
  grant: PENDING,
  held: false,
  registered: [STUDY_A1.externalId],
  standings: {
    'subject-administrator': {},
    'subject-ana': { countedOwner: true, holder: true },
    'subject-bo': { holder: true },
    'subject-cy': { holder: true },
  },
};

// A store answering from the world given, keeping each call made of it in order.
const fakeStore = (world: World, calls: Call[]): GrantStore => {
  const called = (method: keyof GrantStore, ...values: unknown[]): void => {
    calls.push({ method, values });
  };
  return {
    appendDecision: async (decision: NewDecision) => {
      called('appendDecision', decision);
      return decision.now;
    },
    countedOwnersBesides: async (question) => {
      called('countedOwnersBesides', question);
      return world.countedOwnersBesides;
    },
    endExpiredGrant: async (terms, now) => {
      called('endExpiredGrant', terms, now);
      return true;
    },
    findOfferedCategory: async (scopedName, resourceId) => {
      called('findOfferedCategory', scopedName, resourceId);
      return world.categories[scopedName];
    },
    findOrRecordPerson: async (subject, now) => {
      called('findOrRecordPerson', subject, now);
      return `person-${subject.replace('subject-', '')}`;
    },
    findPerson: async (subject) => {
      called('findPerson', subject);
      return `person-${subject.replace('subject-', '')}`;
    },
    findRole: async (name) => {
      called('findRole', name);
      return ROLES[name];
    },
    insertGrant: async (grant: NewGrant) => {
      called('insertGrant', grant);
      return world.held ? undefined : GRANT_ID;
    },
    locateGrant: async (grantId) => {
      called('locateGrant', grantId);
      return world.grant?.id === grantId
        ? {
            externalId: world.grant.resource,
            resourceId: world.grant.resourceId,
          }
        : undefined;
    },
    lockResource: async (resourceId) => {
      called('lockResource', resourceId);
    },
    readGrant: async (grantId) => {
      called('readGrant', grantId);
      return world.grant?.id === grantId ? world.grant : undefined;
    },
    readStanding: async (question) => {
      called('readStanding', question);
      const standing = world.standings[question.subject] ?? {};
      return question.externalId === STUDY_A1.externalId
        ? { ...STUDY_A1, ...standing }
        : undefined;
    },
    revokeGrant: async (revocation) => {
      called('revokeGrant', revocation);
    },
  };
};

const tokenOf = (subject: string) => ({
  claims: {
    aud: ['usher-management'],
    azp: 'usher-ui',
    exp: SECONDS + 300,
    iat: SECONDS - 10,
    iss: ISSUER,
    sub: subject,
    typ: 'Bearer',
  },
  header: { alg: 'RS256', typ: 'JWT' },
  kind: 'verified' as const,
});

// The bearer credential each caller sends, by the caller's name.
const TOKENS: Readonly<Record<string, ReturnType<typeof tokenOf>>> = {
  administrator: tokenOf('subject-administrator'),
  ana: tokenOf('subject-ana'),
  bo: tokenOf('subject-bo'),
  cy: tokenOf('subject-cy'),
};

// The one platform administrator the store holds.
const ADMINISTRATOR_SUBJECT = 'subject-administrator';

const standUp = (
  context: TestContext,
  world: Partial<World> = {},
  autoAccept = false,
): Stand => {
  const known: World = { ...WORLD, ...world };
  const stand = {
    calls: [] as Call[],
    recorded: [] as AuditEvent[],
    transactions: { count: 0 },
  };
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  createGrantRoutes(
    {
      grantStoreOf: () => fakeStore(known, stand.calls),
      settings: {
        autoAccept,
        clock: { now: () => NOW },
        databaseSchema: 'usher',
        identityProviderIssuer: ISSUER,
        submitterCategory: 'global.unmarked',
      },
      store: {
        // Whether the store holds the resource a refused request's body names by its externalId,
        // for a question reading the resources, or else the grant its id names.
        query: async <Row extends pg.QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<pg.QueryResult<Row>> =>
          ({
            rows: [
              {
                exists: /\.resources\b/u.test(text)
                  ? known.registered.includes(String(values[0]))
                  : values[0] === known.grant?.id,
              },
            ],
          }) as unknown as pg.QueryResult<Row>,
      },
      trail: {
        inTransaction: async (_actor, work) => {
          stand.transactions.count += 1;
          const recorded: AuditEvent[] = [];
          const result = await work({
            connection: Object.assign(new pg.Client(), {
              release: () => undefined,
            }),
            record: async (event) => {
              recorded.push(event);
              return 'event-id';
            },
          });
          if (known.commitFailure !== undefined) {
            throw known.commitFailure;
          }
          stand.recorded.push(...recorded);
          return result;
        },
      },
    },
    {
      administratorStatus: async ({ subject }) => ({
        administrator: subject === ADMINISTRATOR_SUBJECT,
        anyAdministrator: true,
      }),
      eventLog: { error: () => undefined },
      refusalTally: { count: () => undefined },
      runAfterCommit: async () => undefined,
      settings: {
        clock: { now: () => NOW },
        firstUserRole: 'usher-first-user',
        identityProviderIssuer: ISSUER,
        managementAudience: 'usher-management',
        managementClients: ['usher-ui'],
        serviceAccountRole: 'usher-service-account',
        signInTokenMaximumLifetimeSeconds: 3600,
      },
      storedRefusal: async () => undefined,
      tokenVerifier: {
        verify: async (token) =>
          TOKENS[token] ?? { kind: 'unverified', reason: 'invalidSignature' },
      },
      trail: {
        recordEvent: async (_actor, event) => {
          stand.recorded.push(event);
          return 'event-id';
        },
      },
    },
  ).forEach((route) => {
    server.route(route);
  });
  context.after(() => server.close());
  return { ...stand, server };
};

const send = (
  { server }: Stand,
  caller: string,
  {
    body,
    method,
    url,
  }: { body?: unknown; method: 'DELETE' | 'POST'; url: string },
) =>
  server.inject({
    headers: {
      authorization: `Bearer ${caller}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method,
    url,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

const VIEWER_CREATION = {
  category: 'global.controlled',
  holder: { subject: 'subject-cy' },
  resource: 'STUDY-A1',
  role: 'viewer',
};

const create = (
  stand: Stand,
  caller: string,
  body: unknown = VIEWER_CREATION,
) => send(stand, caller, { body, method: 'POST', url: '/admin/grants' });

const answer = (
  stand: Stand,
  caller: string,
  body: unknown,
  grantId: string = GRANT_ID,
) =>
  send(stand, caller, {
    body,
    method: 'POST',
    url: `/admin/grants/${encodeURIComponent(grantId)}/decisions`,
  });

const revoke = (
  stand: Stand,
  caller: string,
  grantId: string = GRANT_ID,
  body?: unknown,
) =>
  send(stand, caller, {
    body,
    method: 'DELETE',
    url: `/admin/grants/${encodeURIComponent(grantId)}`,
  });

const parsed = (answered: {
  body: string;
}): Readonly<Record<string, unknown>> =>
  JSON.parse(answered.body) as Readonly<Record<string, unknown>>;

const outcomeOf = (answered: {
  body: string;
  statusCode: number;
}): readonly unknown[] => [
  answered.statusCode,
  answered.statusCode < 300 ? undefined : parsed(answered)['code'],
];

const methodsCalled = ({ calls }: Stand): readonly string[] =>
  calls.map(({ method }) => method);

const eventData = ({
  recorded,
}: Stand): readonly Readonly<Record<string, unknown>>[] =>
  recorded.map(({ data, type }) => ({ type, ...data }));

const ACCEPTING = { capabilities: VIEWER.capabilities, decision: 'accepted' };

suite('creating a grant', () => {
  test("records an unmet holder, ends an expired grant on the grant's terms before writing it, and answers 201 with the grant", async (context) => {
    const stand = standUp(context);

    const created = await create(stand, 'ana');

    assert.equal(created.statusCode, 201);
    assert.deepEqual(parsed(created), {
      category: 'global.controlled',
      decision: null,
      expiresAt: null,
      grantedAt: '2026-11-12T12:00:00.000Z',
      grantedBy: { subject: 'subject-ana' },
      holder: { hasAccount: true, subject: 'subject-cy' },
      id: GRANT_ID,
      resource: 'STUDY-A1',
      revokedAt: null,
      revokedBy: null,
      role: 'viewer',
      selfGrant: false,
      state: 'pending',
    });
    assert.deepEqual(methodsCalled(stand), [
      'findRole',
      'readStanding',
      'findOfferedCategory',
      'findOrRecordPerson',
      'findOrRecordPerson',
      'endExpiredGrant',
      'insertGrant',
    ]);
    const terms = {
      holderUserId: 'person-cy',
      recordCategoryId: 'category-controlled',
      resourceId: 'resource-a1',
      roleId: 'role-viewer',
    };
    assert.deepEqual(
      stand.calls.filter(({ method }) =>
        ['endExpiredGrant', 'insertGrant', 'readStanding'].includes(method),
      ),
      [
        {
          method: 'readStanding',
          values: [
            {
              externalId: 'STUDY-A1',
              lock: 'share',
              now: new Date(NOW),
              subject: 'subject-ana',
            },
          ],
        },
        { method: 'endExpiredGrant', values: [terms, new Date(NOW)] },
        {
          method: 'insertGrant',
          values: [
            {
              ...terms,
              expiresAt: null,
              grantedAt: new Date(NOW),
              grantedBy: 'person-ana',
            },
          ],
        },
      ],
    );
    assert.deepEqual(eventData(stand), [
      {
        category: 'global.controlled',
        grantId: GRANT_ID,
        granteeId: 'subject-cy',
        resourceId: 'STUDY-A1',
        result: 'succeeded',
        role: 'viewer',
        sourceIp: '127.0.0.1',
        type: 'grant.creation',
      },
    ]);
  });

  test("records the holder's acceptance, showing what the role confers now, with the grant when auto-accept is on", async (context) => {
    const stand = standUp(context, {}, true);

    const created = await create(stand, 'ana');

    assert.equal(created.statusCode, 201);
    assert.deepEqual(parsed(created)['decision'], {
      capabilities: VIEWER.capabilities,
      decidedAt: '2026-11-12T12:00:00.000Z',
      decision: 'accepted',
    });
    assert.equal(parsed(created)['state'], 'accepted');
    assert.deepEqual(
      stand.calls.find(({ method }) => method === 'appendDecision')?.values,
      [
        {
          capabilities: VIEWER.capabilities,
          decision: 'accepted',
          grantId: GRANT_ID,
          now: new Date(NOW),
          userId: 'person-cy',
        },
      ],
    );
  });

  test("gives a submitter grant naming no category the instance's submitter category", async (context) => {
    const stand = standUp(context);

    const created = await create(stand, 'administrator', {
      holder: { subject: 'subject-cy' },
      resource: 'STUDY-A1',
      role: 'submitter',
    });

    assert.equal(created.statusCode, 201);
    assert.equal(parsed(created)['category'], 'global.unmarked');
    assert.deepEqual(
      stand.calls.find(({ method }) => method === 'findOfferedCategory')
        ?.values,
      ['global.unmarked', 'resource-a1'],
    );
  });

  test('answers terms held already 409 alreadyHolds, recording it denied, naming the resource and no grant', async (context) => {
    const stand = standUp(context, { held: true });

    const refused = await create(stand, 'ana');

    assert.deepEqual(outcomeOf(refused), [409, 'alreadyHolds']);
    assert.deepEqual(eventData(stand), [
      {
        reason: 'alreadyHolds',
        resourceId: 'STUDY-A1',
        result: 'denied',
        sourceIp: '127.0.0.1',
        type: 'grant.creation',
      },
    ]);
  });

  test('answers a principal who may not see the resource as for an absent one, recording a refusal of authority naming the resource, and a resource that does not exist as not found naming none', async (context) => {
    const stand = standUp(context, {
      standings: { ...WORLD.standings, 'subject-bo': {} },
    });

    const hidden = await create(stand, 'bo');
    const absent = await create(stand, 'bo', {
      ...VIEWER_CREATION,
      resource: 'STUDY-Z9',
    });

    assert.deepEqual(outcomeOf(hidden), [404, 'resourceNotFound']);
    assert.equal(hidden.body, absent.body);
    assert.deepEqual(eventData(stand), [
      {
        reason: 'noAuthorityOnResource',
        resourceId: 'STUDY-A1',
        result: 'denied',
        sourceIp: '127.0.0.1',
        type: 'grant.creation',
      },
      {
        reason: 'resourceNotFound',
        result: 'denied',
        sourceIp: '127.0.0.1',
        type: 'grant.creation',
      },
    ]);
    assert.equal(methodsCalled(stand).includes('insertGrant'), false);
  });

  test("names in a refused creation's event the resource its body names when one is registered under that externalId, whatever the refusal and the resource's standing, and none for text naming no registered resource", async (context) => {
    const stand = standUp(context, {
      standings: { ...WORLD.standings, 'subject-bo': { retired: true } },
    });
    const unknownRole = { ...VIEWER_CREATION, role: 'Viewer' };

    const answers = [
      await create(stand, 'ana', unknownRole),
      await create(stand, 'bo'),
      await create(stand, 'ana', { ...unknownRole, resource: 'STUDY-Z9' }),
      await create(stand, 'administrator', {
        ...VIEWER_CREATION,
        resource: 'STUDY-Z9',
      }),
    ];

    assert.deepEqual(answers.map(outcomeOf), [
      [422, 'unknownRole'],
      [404, 'resourceNotFound'],
      [422, 'unknownRole'],
      [403, 'administratorGrantsNoConsumerAccess'],
    ]);
    assert.deepEqual(
      eventData(stand).map((data) =>
        Object.hasOwn(data, 'resourceId')
          ? [data['reason'], data['resourceId']]
          : [data['reason']],
      ),
      [
        ['unknownRole', 'STUDY-A1'],
        ['resourceNotFound', 'STUDY-A1'],
        ['unknownRole'],
        ['administratorGrantsNoConsumerAccess'],
      ],
    );
  });

  test('refuses a holder of a grant on the resource who owns it not 403 noAuthorityOnResource, writing nothing', async (context) => {
    const stand = standUp(context);

    const refused = await create(stand, 'bo');

    assert.deepEqual(outcomeOf(refused), [403, 'noAuthorityOnResource']);
    assert.equal(methodsCalled(stand).includes('insertGrant'), false);
  });

  test("refuses an administrator's consumer grant 403 alike on an absent resource, and a self-named one 422 ahead of it", async (context) => {
    const stand = standUp(context);

    const onKnown = await create(stand, 'administrator');
    const onAbsent = await create(stand, 'administrator', {
      ...VIEWER_CREATION,
      resource: 'STUDY-Z9',
    });
    const selfNamed = await create(stand, 'administrator', {
      ...VIEWER_CREATION,
      holder: { subject: 'subject-administrator' },
    });
    const selfOwned = await create(stand, 'administrator', {
      holder: { subject: 'subject-administrator' },
      resource: 'STUDY-A1',
      role: 'owner',
    });

    assert.deepEqual(outcomeOf(onKnown), [
      403,
      'administratorGrantsNoConsumerAccess',
    ]);
    assert.equal(onKnown.body, onAbsent.body);
    assert.deepEqual(outcomeOf(selfNamed), [422, 'selfNamed']);
    assert.match(String(parsed(selfNamed)['detail']), /\/admin\/grants\/self/u);
    assert.deepEqual(outcomeOf(selfOwned), [403, 'administratorSelfOwnership']);
  });

  test('refuses a role the instance does not define, and a data-plane role naming no category, 422 before any authority is judged', async (context) => {
    const stand = standUp(context);

    const answers = [
      await create(stand, 'bo', { ...VIEWER_CREATION, role: 'Viewer' }),
      await create(stand, 'bo', {
        holder: { subject: 'subject-cy' },
        resource: 'STUDY-A1',
        role: 'viewer',
      }),
    ];

    assert.deepEqual(answers.map(outcomeOf), [
      [422, 'unknownRole'],
      [422, 'categoryRequired'],
    ]);
    assert.equal(methodsCalled(stand).includes('readStanding'), false);
  });

  test('refuses a category the resource does not offer 422 once authority is judged', async (context) => {
    const stand = standUp(context);

    const refused = await create(stand, 'ana', {
      ...VIEWER_CREATION,
      category: 'resource.internal',
    });

    assert.deepEqual(outcomeOf(refused), [422, 'categoryNotOffered']);
    assert.equal(methodsCalled(stand).includes('insertGrant'), false);
  });

  test('answers a holder named by address 503 directoryUnavailable once the rest is judged, recording no person and writing no grant', async (context) => {
    const stand = standUp(context);
    const byAddress = {
      holder: { email: 'sub.bo@example.org' },
      resource: 'STUDY-A1',
      role: 'submitter',
    };

    const unavailable = await create(stand, 'administrator', byAddress);
    const hidden = await create(stand, 'cy', {
      ...byAddress,
      resource: 'STUDY-Z9',
    });

    assert.deepEqual(outcomeOf(unavailable), [503, 'directoryUnavailable']);
    assert.deepEqual(outcomeOf(hidden), [404, 'resourceNotFound']);
    assert.equal(methodsCalled(stand).includes('findOrRecordPerson'), false);
  });

  test('answers a retirement committed first 404 resourceNotFound, as for a retired resource', async (context) => {
    const stand = standUp(context, {
      commitFailure: Object.assign(new Error('a retired resource'), {
        code: '23514',
        constraint: 'resources_retired_without_live_grants',
      }),
    });

    const refused = await create(stand, 'ana');

    assert.deepEqual(outcomeOf(refused), [404, 'resourceNotFound']);
  });
});

suite('answering a grant', () => {
  test("appends the holder's answer, showing what the role confers now, locking the resource before the grant, and answers 204", async (context) => {
    const stand = standUp(context);

    const answered = await answer(stand, 'cy', {
      capabilities: [...VIEWER.capabilities].reverse(),
      decision: 'accepted',
    });

    assert.deepEqual(outcomeOf(answered), [204, undefined]);
    assert.equal(answered.body, '');
    assert.deepEqual(methodsCalled(stand), [
      'locateGrant',
      'lockResource',
      'readGrant',
      'findPerson',
      'findRole',
      'appendDecision',
    ]);
    assert.deepEqual(
      stand.calls.find(({ method }) => method === 'appendDecision')?.values,
      [
        {
          capabilities: VIEWER.capabilities,
          decision: 'accepted',
          grantId: GRANT_ID,
          now: new Date(NOW),
          userId: 'person-cy',
        },
      ],
    );
    assert.deepEqual(eventData(stand), [
      {
        category: 'global.controlled',
        decision: 'accepted',
        grantId: GRANT_ID,
        resourceId: 'STUDY-A1',
        result: 'succeeded',
        role: 'viewer',
        sourceIp: '127.0.0.1',
        type: 'grant.decision',
      },
    ]);
  });

  test('answers anyone but the holder, and an unknown or malformed id, 404 grantNotFound alike, recording the refusal of authority apart', async (context) => {
    const stand = standUp(context);

    const answers = [
      await answer(stand, 'bo', ACCEPTING),
      await answer(stand, 'administrator', ACCEPTING),
      await answer(stand, 'cy', ACCEPTING, UNKNOWN_GRANT_ID),
      await answer(stand, 'cy', ACCEPTING, 'not-a-uuid'),
    ];

    answers.forEach((answered) => {
      assert.deepEqual(outcomeOf(answered), [404, 'grantNotFound']);
      assert.equal(answered.body, answers[0]?.body);
    });
    assert.deepEqual(
      eventData(stand).map(({ grantId, reason }) => [grantId, reason]),
      [
        [GRANT_ID, 'noAuthorityOnResource'],
        [GRANT_ID, 'noAuthorityOnResource'],
        [undefined, 'grantNotFound'],
        [undefined, 'grantNotFound'],
      ],
    );
    assert.equal(stand.transactions.count, 3);
    assert.equal(methodsCalled(stand).includes('appendDecision'), false);
  });

  test('answers a grant revoked, expired, or replaced once expired 409 doesNotHold, as for any expired grant', async (context) => {
    const ended = [
      { ...PENDING, revokedAt: new Date(NOW - 1000) },
      { ...PENDING, expiresAt: new Date(NOW) },
      {
        ...PENDING,
        endedAt: new Date(NOW - 1000),
        expiresAt: new Date(NOW - 2000),
      },
    ];

    const answers = await Promise.all(
      ended.map((grant) =>
        answer(standUp(context, { grant }), 'cy', ACCEPTING),
      ),
    );

    assert.deepEqual(
      answers.map(outcomeOf),
      ended.map(() => [409, 'doesNotHold']),
    );
  });

  test("refuses capabilities other than the role's current ones, as a set, 422 capabilitiesDiffer", async (context) => {
    const stand = standUp(context);

    const refused = [
      await answer(stand, 'cy', {
        capabilities: [...VIEWER.capabilities, 'record.delete'],
        decision: 'accepted',
      }),
      await answer(stand, 'cy', {
        capabilities: ['record.view'],
        decision: 'accepted',
      }),
    ];

    assert.deepEqual(refused.map(outcomeOf), [
      [422, 'capabilitiesDiffer'],
      [422, 'capabilitiesDiffer'],
    ]);
  });

  test("refuses declining a resource's last counted owner grant 409 resourceNeedsAnOwner, and answers a commit refused for it alike", async (context) => {
    const ownership: StoredGrant = {
      ...PENDING,
      category: null,
      decision: {
        capabilities: ROLES['owner']?.capabilities ?? [],
        decidedAt: new Date(NOW - 30_000),
        decision: 'accepted',
      },
      role: 'owner',
    };
    const declining = {
      capabilities: ROLES['owner']?.capabilities ?? [],
      decision: 'rejected',
    };
    const alone = standUp(context, {
      countedOwnersBesides: 0,
      grant: ownership,
    });
    const raced = standUp(context, {
      commitFailure: Object.assign(new Error('keep an owner'), {
        code: '23514',
        constraint: 'resources_keep_an_owner',
      }),
      grant: ownership,
    });

    const refused = await answer(alone, 'cy', declining);
    const lost = await answer(raced, 'cy', declining);

    assert.deepEqual(outcomeOf(refused), [409, 'resourceNeedsAnOwner']);
    assert.match(String(parsed(refused)['detail']), /add another owner/iu);
    assert.equal(methodsCalled(alone).includes('appendDecision'), false);
    assert.deepEqual(outcomeOf(lost), [409, 'resourceNeedsAnOwner']);
  });
});

suite('revoking a grant', () => {
  test('revokes a grant for a platform administrator, its resource locked first, recording the reason given, and answers with the revoked grant', async (context) => {
    const stand = standUp(context);

    const revoked = await revoke(stand, 'administrator', GRANT_ID, {
      reason: 'accessReview',
    });

    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(
      [
        parsed(revoked)['revokedAt'],
        parsed(revoked)['revokedBy'],
        parsed(revoked)['holder'],
        parsed(revoked)['resource'],
        parsed(revoked)['state'],
      ],
      [
        '2026-11-12T12:00:00.000Z',
        { subject: 'subject-administrator' },
        { hasAccount: true, subject: 'subject-cy' },
        'STUDY-A1',
        'revoked',
      ],
    );
    assert.deepEqual(methodsCalled(stand), [
      'locateGrant',
      'readStanding',
      'readGrant',
      'findOrRecordPerson',
      'revokeGrant',
    ]);
    assert.deepEqual(
      stand.calls.find(({ method }) => method === 'readStanding')?.values,
      [
        {
          externalId: 'STUDY-A1',
          lock: 'noKeyUpdate',
          now: new Date(NOW),
          subject: 'subject-administrator',
        },
      ],
    );
    assert.deepEqual(eventData(stand), [
      {
        category: 'global.controlled',
        grantId: GRANT_ID,
        granteeId: 'subject-cy',
        reason: 'accessReview',
        resourceId: 'STUDY-A1',
        result: 'succeeded',
        role: 'viewer',
        sourceIp: '127.0.0.1',
        type: 'grant.revocation',
      },
    ]);
  });

  test('revokes for a counted owner of its resource, recording unspecified for no reason given', async (context) => {
    const stand = standUp(context);

    const revoked = await revoke(stand, 'ana');

    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(
      eventData(stand).map(({ reason }) => reason),
      ['unspecified'],
    );
  });

  test('revokes a grant replaced once expired as any expired grant', async (context) => {
    const stand = standUp(context, {
      grant: {
        ...PENDING,
        endedAt: new Date(NOW - 1000),
        expiresAt: new Date(NOW - 2000),
      },
    });

    const revoked = await revoke(stand, 'administrator');

    assert.equal(revoked.statusCode, 200);
    assert.equal(parsed(revoked)['state'], 'revoked');
    assert.equal(
      parsed(revoked)['expiresAt'],
      new Date(NOW - 2000).toISOString(),
    );
    assert.equal(Object.hasOwn(parsed(revoked), 'endedAt'), false);
    assert.equal(methodsCalled(stand).includes('revokeGrant'), true);
  });

  test('answers a principal without authority on its resource, and an unknown, malformed or empty id, 404 grantNotFound alike, recording the refusal of authority apart', async (context) => {
    const stand = standUp(context);

    const answers = [
      await revoke(stand, 'bo'),
      await revoke(stand, 'cy'),
      await revoke(stand, 'administrator', UNKNOWN_GRANT_ID),
      await revoke(stand, 'administrator', '../STUDY-A1'),
      await revoke(stand, 'administrator', ''),
    ];

    answers.forEach((answered) => {
      assert.deepEqual(outcomeOf(answered), [404, 'grantNotFound']);
      assert.equal(answered.body, answers[0]?.body);
    });
    assert.deepEqual(
      eventData(stand).map(({ reason }) => reason),
      [
        'noAuthorityOnResource',
        'noAuthorityOnResource',
        'grantNotFound',
        'grantNotFound',
        'grantNotFound',
      ],
    );
    assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
  });

  test('refuses a grant revoked already 409 doesNotHold, keeping its first revocation', async (context) => {
    const stand = standUp(context, {
      grant: {
        ...PENDING,
        revokedAt: new Date(NOW - 1000),
        revokerSubject: 'subject-ana',
      },
    });

    const refused = await revoke(stand, 'administrator');

    assert.deepEqual(outcomeOf(refused), [409, 'doesNotHold']);
    assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
  });

  test("refuses revoking a resource's last counted owner grant 409 resourceNeedsAnOwner", async (context) => {
    const stand = standUp(context, {
      countedOwnersBesides: 0,
      grant: {
        ...PENDING,
        category: null,
        decision: {
          capabilities: ROLES['owner']?.capabilities ?? [],
          decidedAt: new Date(NOW - 30_000),
          decision: 'accepted',
        },
        role: 'owner',
      },
    });

    const refused = await revoke(stand, 'administrator');

    assert.deepEqual(outcomeOf(refused), [409, 'resourceNeedsAnOwner']);
    assert.equal(methodsCalled(stand).includes('revokeGrant'), false);
  });

  test('refuses a reason no caller may give 422 before reading the store', async (context) => {
    const stand = standUp(context);

    const refused = await revoke(stand, 'administrator', GRANT_ID, {
      reason: 'resourceRetired',
    });

    assert.deepEqual(outcomeOf(refused), [422, 'unknownRevocationReason']);
    assert.equal(stand.transactions.count, 0);
  });
});
