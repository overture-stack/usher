import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { suite, test } from 'node:test';

import { servedSpec } from './servedSpec.js';
import type { OpenApiDocument } from './types.js';

const ENDPOINTS = {
  authorizationEndpoint:
    'https://auth.example.org/realms/usher/protocol/openid-connect/auth',
  tokenEndpoint:
    'https://auth.example.org/realms/usher/protocol/openid-connect/token',
};

const SIGN_IN_ALTERNATIVE = { identityProviderSignIn: [] };

const OPERATION_METHODS: readonly string[] = [
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
];

interface Operation {
  readonly [member: string]: unknown;
  readonly security?: readonly Readonly<Record<string, unknown>>[];
}

const committedSpec = async (): Promise<OpenApiDocument> =>
  JSON.parse(
    await readFile(new URL('../../openapi.json', import.meta.url), 'utf8'),
  ) as OpenApiDocument;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const memberOf = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;

const deepFrozen = <Value>(value: Value): Value => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFrozen);
    return Object.freeze(value);
  }
  return value;
};

// Every operation of a document, by its method and path.
const operationsOf = (
  document: OpenApiDocument,
): readonly { label: string; operation: Operation }[] =>
  Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => OPERATION_METHODS.includes(method))
      .map(([method, operation]) => ({
        label: `${method} ${path}`,
        operation: operation as Operation,
      })),
  );

const namesManagementToken = (
  requirement: Readonly<Record<string, unknown>>,
): boolean => Object.hasOwn(requirement, 'managementToken');

// A served document with every member the served contract adds taken out again.
const withoutSignIn = (served: OpenApiDocument): OpenApiDocument => {
  const {
    components: {
      securitySchemes: { identityProviderSignIn: _scheme, ...schemes },
      ...components
    },
  } = served;
  return {
    ...served,
    components: { ...components, securitySchemes: schemes },
    paths: Object.fromEntries(
      Object.entries(served.paths).map(([path, item]) => [
        path,
        Object.fromEntries(
          Object.entries(item).map(([member, value]) => [
            member,
            OPERATION_METHODS.includes(member) &&
            isRecord(value) &&
            Array.isArray(value['security'])
              ? {
                  ...value,
                  security: value['security'].filter(
                    (requirement: unknown) =>
                      !(
                        isRecord(requirement) &&
                        Object.keys(requirement).length === 1 &&
                        Array.isArray(requirement['identityProviderSignIn']) &&
                        requirement['identityProviderSignIn'].length === 0
                      ),
                  ),
                }
              : value,
          ]),
        ),
      ]),
    ),
  };
};

suite('the contract the API documentation page serves', () => {
  test('adds an OAuth 2.0 scheme beside managementToken, its authorization code flow at the endpoints given, asking for the openid scope described in one line', async () => {
    const committed = await committedSpec();

    const served = servedSpec(committed, ENDPOINTS);
    const description = [
      'identityProviderSignIn',
      'flows',
      'authorizationCode',
      'scopes',
      'openid',
    ].reduce<unknown>(memberOf, served.components.securitySchemes);

    assert.ok(typeof description === 'string');
    assert.match(description, /^\S[^\n]*\S$/u);
    assert.deepEqual(served.components.securitySchemes, {
      ...committed.components.securitySchemes,
      identityProviderSignIn: {
        flows: {
          authorizationCode: {
            authorizationUrl: ENDPOINTS.authorizationEndpoint,
            scopes: { openid: description },
            tokenUrl: ENDPOINTS.tokenEndpoint,
          },
        },
        type: 'oauth2',
      },
    });
  });

  test('names exactly one flow in its sign-in scheme, authorizationCode', async () => {
    const served = servedSpec(await committedSpec(), ENDPOINTS);
    const scheme = served.components.securitySchemes['identityProviderSignIn'];

    assert.ok(isRecord(scheme));
    assert.ok(isRecord(scheme['flows']));
    assert.deepEqual(Object.keys(scheme['flows']), ['authorizationCode']);
  });

  test('offers signing in as a sibling alternative right after every requirement naming managementToken, and changes no other requirement', async () => {
    const committed = await committedSpec();
    const before = operationsOf(committed);

    const after = operationsOf(servedSpec(committed, ENDPOINTS));

    assert.deepEqual(
      after.map(({ label }) => label),
      before.map(({ label }) => label),
    );
    const managed = before.filter(({ operation }) =>
      (operation.security ?? []).some(namesManagementToken),
    );
    assert.equal(managed.length, 42);
    after.forEach(({ label, operation }, index) => {
      const committedSecurity = before[index]?.operation.security;
      assert.deepEqual(
        operation.security,
        committedSecurity?.flatMap((requirement) =>
          namesManagementToken(requirement)
            ? [requirement, SIGN_IN_ALTERNATIVE]
            : [requirement],
        ),
        label,
      );
    });
  });

  test('is the committed contract plus the scheme and the alternatives and nothing else, naming no servers', async () => {
    const committed = await committedSpec();

    const served = servedSpec(committed, ENDPOINTS);

    assert.deepEqual(withoutSignIn(served), committed);
    assert.deepEqual(Object.keys(served), Object.keys(committed));
    assert.equal(Object.hasOwn(served, 'servers'), false);
    assert.equal(
      JSON.stringify(served).split('"identityProviderSignIn"').length - 1,
      43,
    );
  });

  test('leaves the committed contract it is built from as it was', async () => {
    const committed = deepFrozen(await committedSpec());
    const copy = structuredClone(committed);

    const served = servedSpec(committed, ENDPOINTS);

    assert.deepEqual(committed, copy);
    assert.notDeepEqual(served, committed);
  });
});
