import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { initializerScript } from './initializerScript.js';
import { END_SESSION_MEMBER, SIGN_IN_SCHEME } from './servedSpec.js';

const PAGE_ORIGIN = 'https://usher.example.org';

const END_SESSION_ENDPOINT = 'https://auth.example.org/realms/test/protocol/openid-connect/logout';

// Stands in for the bundle's preset of the API's own components.
const API_PRESET = (): void => undefined;

type Logout = (names: unknown) => unknown;

interface Plugin {
	statePlugins: { auth: { wrapActions: { logout: (original: Logout) => Logout } } };
}

interface Started {
	assigned: string[];
	oauth: unknown[];
	options: Record<string, unknown>[];
}

// Runs a script as a browser would, beside a stand-in for the bundle, recording what it is given and
// every address the page is sent to.
const run = (script: string): Started => {
	const started: Started = { assigned: [], oauth: [], options: [] };
	const bundle = Object.assign(
		(options: Record<string, unknown>) => {
			started.options.push(options);
			return {
				initOAuth: (oauth: unknown) => {
					started.oauth.push(oauth);
				},
			};
		},
		{ presets: { apis: API_PRESET } },
	);
	const window = {
		location: {
			assign: (address: string) => {
				started.assigned.push(address);
			},
			origin: PAGE_ORIGIN,
		},
	};
	new Function('SwaggerUIBundle', 'window', script)(bundle, window);
	return started;
};

// The options given, without the plugins, which are functions and are tested by what they do.
const withoutPlugins = ({ plugins: _plugins, ...options }: Record<string, unknown>): Record<string, unknown> => options;

// A stand-in for Swagger UI's system, its contract naming the sign-in scheme's end-session endpoint
// where one is given.
const systemWith = (endSession?: string) => ({
	specSelectors: {
		specJson: () => ({
			getIn: (path: readonly string[]): unknown =>
				path.join('/') === `components/securitySchemes/${SIGN_IN_SCHEME}/${END_SESSION_MEMBER}`
					? endSession
					: undefined,
		}),
	},
});

// Signs out of the schemes named, through the started page's plugin, recording the original sign-out.
const signOut = (started: Started, names: unknown, endSession?: string): { forgotten: unknown[]; result: unknown } => {
	const plugins = started.options[0]?.['plugins'];
	const plugin = (Array.isArray(plugins) ? plugins[0] : undefined) as
		((system: ReturnType<typeof systemWith>) => Plugin) | undefined;
	const forgotten: unknown[] = [];
	const logout = (plugin ?? assert.fail('no plugin'))(systemWith(endSession)).statePlugins.auth.wrapActions.logout(
		(given) => {
			forgotten.push(given);
			return 'forgotten';
		},
	);
	return { forgotten, result: logout(names) };
};

suite('the API documentation initializer', () => {
	test('starts Swagger UI once, on the page element, from the served contract, with its base layout, the API preset alone and one plugin', () => {
		const { options } = run(initializerScript('usher-ui'));

		assert.equal(options.length, 1);
		assert.deepEqual(withoutPlugins(options[0] ?? {}), {
			dom_id: '#swagger-ui',
			layout: 'BaseLayout',
			oauth2RedirectUrl: `${PAGE_ORIGIN}/api-docs/oauth2-redirect.html`,
			persistAuthorization: false,
			presets: [API_PRESET],
			queryConfigEnabled: false,
			url: '/api-docs/openapi.json',
			validatorUrl: null,
		});
		assert.equal((options[0]?.['plugins'] as readonly unknown[]).length, 1);
	});

	test('builds the redirect URL in the browser, from the origin the page is served at', () => {
		const script = initializerScript('usher-ui');

		const { options } = run(script);

		assert.equal(options[0]?.['oauth2RedirectUrl'], 'https://usher.example.org/api-docs/oauth2-redirect.html');
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
			'usher\nui ',
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

suite("the API documentation page's sign-out", () => {
	test("forgets the token first, then sends the browser to the identity provider's end-session endpoint, naming the client and the page to return to", () => {
		const started = run(initializerScript('usher-ui'));

		const { forgotten, result } = signOut(started, [SIGN_IN_SCHEME], END_SESSION_ENDPOINT);

		assert.deepEqual(forgotten, [[SIGN_IN_SCHEME]]);
		assert.equal(result, 'forgotten');
		assert.equal(started.assigned.length, 1);
		const target = new URL(started.assigned[0] ?? '');
		assert.equal(`${target.origin}${target.pathname}`, END_SESSION_ENDPOINT);
		assert.deepEqual(Object.fromEntries(target.searchParams), {
			client_id: 'usher-ui',
			post_logout_redirect_uri: `${PAGE_ORIGIN}/api-docs`,
		});
	});

	test('names no ID token, so none appears in the address the browser is sent to', () => {
		const started = run(initializerScript('usher-ui'));

		signOut(started, [SIGN_IN_SCHEME], END_SESSION_ENDPOINT);

		assert.equal(new URL(started.assigned[0] ?? '').searchParams.has('id_token_hint'), false);
	});

	test('carries a client identifier holding characters a URL escapes as that identifier', () => {
		const client = 'usher ui&x=1#"';
		const started = run(initializerScript(client));

		signOut(started, [SIGN_IN_SCHEME], END_SESSION_ENDPOINT);

		assert.equal(new URL(started.assigned[0] ?? '').searchParams.get('client_id'), client);
	});

	test('only forgets the token for a sign-out from another scheme, or where the contract names no end-session endpoint', () => {
		const cases = [
			{ endSession: END_SESSION_ENDPOINT, names: ['managementToken'] },
			{ endSession: undefined, names: [SIGN_IN_SCHEME] },
			{ endSession: END_SESSION_ENDPOINT, names: undefined },
		];

		const outcomes = cases.map(({ endSession, names }) => {
			const started = run(initializerScript('usher-ui'));
			const { forgotten } = signOut(started, names, endSession);
			return { assigned: started.assigned, forgotten };
		});

		assert.deepEqual(
			outcomes,
			cases.map(({ names }) => ({ assigned: [], forgotten: [names] })),
		);
	});
});
