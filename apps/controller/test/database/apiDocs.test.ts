import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  readApiDocsContract,
  readApiDocsPage,
} from '../../test-support/admin.js';
import {
  HARNESS_MANAGEMENT_CLIENT,
  withHarness,
} from '../../test-support/harness.js';

/** A security scheme, as far as this test reads it. */
interface SecurityScheme {
  openIdConnectUrl?: unknown;
  type?: unknown;
}

const securitySchemesOf = (body: unknown): readonly SecurityScheme[] =>
  Object.values(
    (
      body as {
        components: { securitySchemes: Record<string, SecurityScheme> };
      }
    ).components.securitySchemes,
  );

suite("a started controller's API documentation page", () => {
  test('is served, its contract naming one OpenID Connect scheme at the trusted issuer, while its client is one of the management clients', async (context) => {
    await withHarness(
      {
        applications: [],
        configuration: { apiDocsClient: HARNESS_MANAGEMENT_CLIENT },
      },
      async (harness) => {
        const page = await readApiDocsPage(harness.url);
        const contract = await readApiDocsContract(harness.url);

        assert.equal(page.status, 200);
        assert.equal(contract.status, 200);
        assert.deepEqual(
          securitySchemesOf(contract.body)
            .filter(({ type }) => type === 'openIdConnect')
            .map(
              ({ openIdConnectUrl }) =>
                typeof openIdConnectUrl === 'string' &&
                openIdConnectUrl.startsWith(
                  `${harness.configuration.identityProviderIssuer}/`,
                ),
            ),
          [true],
        );
      },
      context,
    );
  });

  test('is answered 404 with nothing in the body, as an unknown path is, while its client is empty', async (context) => {
    await withHarness(
      { applications: [], configuration: { apiDocsClient: '' } },
      async (harness) => {
        const answers = await Promise.all([
          readApiDocsPage(harness.url),
          readApiDocsContract(harness.url),
        ]);

        assert.deepEqual(
          answers.map(({ headers, status, text }) => ({
            securityPolicy: headers.get('content-security-policy'),
            status,
            text,
          })),
          [
            { securityPolicy: null, status: 404, text: '' },
            { securityPolicy: null, status: 404, text: '' },
          ],
        );
      },
      context,
    );
  });
});
