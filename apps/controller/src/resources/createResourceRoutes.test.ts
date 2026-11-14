import assert from 'node:assert/strict';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { AuditEvent } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { createResourceRoutes } from './createResourceRoutes.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const SECONDS = Math.floor(NOW / 1000);

const ISSUER = 'https://auth.example.org/realms/usher';

const APPLICATION_ID = '0b8f7f43-2b4c-4b55-9a39-6c1b7f6f0a11';

interface Stand {
  /** Each statement the resource operations sent the store outside a transaction. */
  reads: string[];

  recorded: AuditEvent[];
  server: FastifyInstance;

  /** How many transactions the resource operations began, as they began. */
  transactions: { count: number };
}

// The resource routes over a store and a trail that answer nothing, each counting what reaches it, and
// a verifier admitting one platform administrator's token.
const standUp = (context: TestContext): Stand => {
  const stand = {
    reads: [] as string[],
    recorded: [] as AuditEvent[],
    transactions: { count: 0 },
  };
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  createResourceRoutes(
    {
      settings: {
        autoAccept: false,
        clock: { now: () => NOW },
        databaseSchema: 'usher',
        identityProviderIssuer: ISSUER,
      },
      store: {
        query: async (text) => {
          stand.reads.push(text);
          throw new Error('the store answers nothing here');
        },
      },
      trail: {
        inTransaction: async () => {
          stand.transactions.count += 1;
          throw new Error('the store answers nothing here');
        },
      },
    },
    {
      eventLog: { error: () => undefined },
      refusalTally: { count: () => undefined },
      runAfterCommit: async () => undefined,
      settings: {
        administratorRole: 'usher-platform-admin',
        clock: { now: () => NOW },
        identityProviderIssuer: ISSUER,
        managementAudience: 'usher-management',
        managementClients: ['usher-ui'],
        serviceAccountRole: 'usher-service-account',
        signInTokenMaximumLifetimeSeconds: 3600,
      },
      storedRefusal: async () => undefined,
      tokenVerifier: {
        verify: async () => ({
          claims: {
            aud: ['usher-management'],
            azp: 'usher-ui',
            exp: SECONDS + 300,
            iat: SECONDS - 10,
            iss: ISSUER,
            realm_access: { roles: ['usher-platform-admin'] },
            sub: 'subject-administrator',
            typ: 'Bearer',
          },
          header: { alg: 'RS256', typ: 'JWT' },
          kind: 'verified',
        }),
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

const codeOf = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null
    ? Reflect.get(parsed, 'code')
    : undefined;
};

suite(
  'the resource routes, for a path parameter holding text that cannot be stored',
  () => {
    test('refuses each path parameter holding a NUL 400 unrepresentableText, reading nothing from the store and beginning no transaction', async (context) => {
      const stand = standUp(context);
      const requests = [
        { method: 'GET', url: '/admin/resources/STUDY%00A1' },
        {
          method: 'PUT',
          url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
        },
        { method: 'PUT', url: '/admin/resources/STUDY-A1/applications/a%00b' },
        {
          method: 'DELETE',
          url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
        },
        {
          method: 'DELETE',
          url: '/admin/resources/STUDY-A1/applications/a%00b',
        },
      ] as const;

      const answers = await Promise.all(
        requests.map(({ method, url }) =>
          stand.server.inject({
            headers: { authorization: 'Bearer administrator' },
            method,
            url,
          }),
        ),
      );

      assert.deepEqual(
        answers.map(({ body, statusCode }) => [statusCode, codeOf(body)]),
        requests.map(() => [400, 'unrepresentableText']),
      );
      assert.deepEqual(stand.reads, []);
      assert.equal(stand.transactions.count, 0);
    });

    test('records each refused change to a served set denied, naming nothing, and records nothing failed nor anything for a read', async (context) => {
      const stand = standUp(context);

      await stand.server.inject({
        headers: { authorization: 'Bearer administrator' },
        method: 'GET',
        url: '/admin/resources/STUDY%00A1',
      });
      await stand.server.inject({
        headers: { authorization: 'Bearer administrator' },
        method: 'PUT',
        url: `/admin/resources/STUDY%00A1/applications/${APPLICATION_ID}`,
      });
      await stand.server.inject({
        headers: { authorization: 'Bearer administrator' },
        method: 'DELETE',
        url: '/admin/resources/STUDY-A1/applications/a%00b',
      });

      assert.deepEqual(
        stand.recorded.map(({ data, severity, type }) => ({
          data,
          severity,
          type,
        })),
        [
          {
            data: {
              reason: 'unrepresentableText',
              result: 'denied',
              sourceIp: '127.0.0.1',
            },
            severity: 'warning',
            type: 'application.servedResourcesChange',
          },
          {
            data: {
              reason: 'unrepresentableText',
              result: 'denied',
              sourceIp: '127.0.0.1',
            },
            severity: 'warning',
            type: 'application.servedResourcesChange',
          },
        ],
      );
      assert.deepEqual(stand.reads, []);
    });
  },
);

suite('the resource routes, for a registration naming its owners', () => {
  test('answers a registration naming an owner by address 503 directoryUnavailable, beginning no transaction, and records it denied', async (context) => {
    const stand = standUp(context);

    const answer = await stand.server.inject({
      headers: {
        authorization: 'Bearer administrator',
        'content-type': 'application/json',
      },
      method: 'POST',
      payload: JSON.stringify({
        accessLevel: 'grant',
        displayName: 'Owned study',
        externalId: 'STUDY-N1',
        owners: [{ subject: 'subject-ana' }, { email: 'owner.bo@example.org' }],
      }),
      url: '/admin/resources',
    });

    assert.deepEqual(
      [answer.statusCode, codeOf(answer.body)],
      [503, 'directoryUnavailable'],
    );
    assert.equal(stand.transactions.count, 0);
    assert.deepEqual(
      stand.recorded.map(({ data, type }) => ({ data, type })),
      [
        {
          data: {
            reason: 'directoryUnavailable',
            result: 'denied',
            sourceIp: '127.0.0.1',
          },
          type: 'resource.registration',
        },
      ],
    );
  });

  test('refuses a registration naming its caller an owner 403 administratorSelfOwnership, beginning no transaction, and records it denied for that reason', async (context) => {
    const stand = standUp(context);

    const answer = await stand.server.inject({
      headers: {
        authorization: 'Bearer administrator',
        'content-type': 'application/json',
      },
      method: 'POST',
      payload: JSON.stringify({
        accessLevel: 'grant',
        displayName: 'Self-owned study',
        externalId: 'STUDY-P1',
        owners: [{ subject: 'subject-administrator' }],
      }),
      url: '/admin/resources',
    });

    assert.deepEqual(
      [answer.statusCode, codeOf(answer.body)],
      [403, 'administratorSelfOwnership'],
    );
    assert.equal(stand.transactions.count, 0);
    assert.deepEqual(
      stand.recorded.map(({ data }) => data['reason']),
      ['administratorSelfOwnership'],
    );
  });
});
