import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readApiDocsContract, readApiDocsPage } from '../../testing/harness/admin.js';
import { HARNESS_MANAGEMENT_CLIENT, withHarness } from '../../testing/harness/harness.js';

/** A security scheme, as far as this test reads it. */
interface SecurityScheme {
	flows?: unknown;
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

// The token URL of each flow an OAuth 2.0 scheme names, one entry per flow.
const tokenUrlsOf = ({ flows }: SecurityScheme): readonly unknown[] =>
	Object.values(typeof flows === 'object' && flows !== null ? flows : {}).map((flow: unknown) =>
		typeof flow === 'object' && flow !== null ? Reflect.get(flow, 'tokenUrl') : undefined,
	);

suite("a started controller's API documentation page", () => {
	test("is served, its contract naming one OAuth 2.0 scheme with one flow, whose token URL is at the trusted issuer's origin, while its client is one of the management clients", async (context) => {
		await withHarness(
			{
				applications: [],
				configuration: { apiDocsClient: HARNESS_MANAGEMENT_CLIENT },
			},
			async (harness) => {
				const page = await readApiDocsPage(harness.url);
				const contract = await readApiDocsContract(harness.url);
				const origin = new URL(harness.configuration.identityProviderIssuer).origin;

				assert.equal(page.status, 200);
				assert.equal(contract.status, 200);
				const schemes = securitySchemesOf(contract.body)
					.filter(({ type }) => type === 'oauth2')
					.map(tokenUrlsOf);
				assert.equal(schemes.length, 1);
				assert.deepEqual(
					schemes[0]?.map((tokenUrl) => typeof tokenUrl === 'string' && tokenUrl.startsWith(`${origin}/`)),
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
				const answers = await Promise.all([readApiDocsPage(harness.url), readApiDocsContract(harness.url)]);

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
