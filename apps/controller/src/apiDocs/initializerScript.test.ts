import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { initializerScript } from './initializerScript.js';

const PAGE_ORIGIN = 'https://usher.example.org';

// Stands in for the bundle's preset of the API's own components.
const API_PRESET = (): void => undefined;

interface Started {
	oauth: unknown[];
	options: unknown[];
}

// Runs a script as a browser would, beside a stand-in for the bundle, recording what it is given.
const run = (script: string): Started => {
	const started: Started = { oauth: [], options: [] };
	const bundle = Object.assign(
		(options: unknown) => {
			started.options.push(options);
			return {
				initOAuth: (oauth: unknown) => {
					started.oauth.push(oauth);
				},
			};
		},
		{ presets: { apis: API_PRESET } },
	);
	const window = { location: { origin: PAGE_ORIGIN } };
	new Function('SwaggerUIBundle', 'window', script)(bundle, window);
	return started;
};

suite('the API documentation initializer', () => {
	test('starts Swagger UI once, on the page element, from the served contract, with its base layout and the API preset alone', () => {
		const { options } = run(initializerScript('usher-ui'));

		assert.equal(options.length, 1);
		assert.deepEqual(options[0], {
			dom_id: '#swagger-ui',
			layout: 'BaseLayout',
			oauth2RedirectUrl: `${PAGE_ORIGIN}/api-docs/oauth2-redirect.html`,
			persistAuthorization: false,
			presets: [API_PRESET],
			queryConfigEnabled: false,
			url: '/api-docs/openapi.json',
			validatorUrl: null,
		});
	});

	test('builds the redirect URL in the browser, from the origin the page is served at', () => {
		const script = initializerScript('usher-ui');

		const { options } = run(script);

		assert.equal(
			(options[0] as { oauth2RedirectUrl: string }).oauth2RedirectUrl,
			'https://usher.example.org/api-docs/oauth2-redirect.html',
		);
		assert.doesNotMatch(script, /usher\.example\.org/u);
	});

	test('signs in through the configured client, by the authorization code flow with PKCE, asking for the openid scope alone', () => {
		const { oauth } = run(initializerScript('usher-ui'));

		assert.deepEqual(oauth, [
			{
				clientId: 'usher-ui',
				scopes: ['openid'],
				usePkceWithAuthorizationCodeGrant: true,
			},
		]);
	});

	test('carries no secret of any kind, and never names the standalone preset or its layout', () => {
		const script = initializerScript('usher-ui');

		assert.doesNotMatch(script, /secret/iu);
		assert.doesNotMatch(script, /standalone/iu);
		assert.doesNotMatch(script, /topbar/iu);
	});

	test('carries a client identifier holding quotes, backslashes, line breaks or a closing script tag as that identifier, and as nothing else', () => {
		const clients = [
			'usher"ui',
			"usher'ui",
			'usher\\ui',
			'usher\nui\u2028',
			'usher</script><script>started()</script>',
			'${window.location}',
		];

		const started = clients.map((client) => run(initializerScript(client)));

		started.forEach(({ oauth, options }, index) => {
			assert.equal(options.length, 1);
			assert.deepEqual(
				oauth.map((given) => (given as { clientId: string }).clientId),
				[clients[index]],
			);
		});
	});
});
