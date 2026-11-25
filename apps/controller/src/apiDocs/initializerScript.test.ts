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

// The options given, without the plugins and the request interceptor, which are functions and are
// tested by what they do.
const withoutPlugins = ({
	plugins: _plugins,
	requestInterceptor: _requestInterceptor,
	...options
}: Record<string, unknown>): Record<string, unknown> => options;

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
	test('starts Swagger UI once, on the page element, from the served contract, with its base layout, the API preset alone, one plugin and a request interceptor', () => {
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
		assert.equal(typeof options[0]?.['requestInterceptor'], 'function');
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

const TOKEN_ENDPOINT = 'https://auth.example.org/realms/test/protocol/openid-connect/token';

// What one sign-in through the scheme leaves in Swagger UI's state, as the identity provider answers
// the authorization code flow.
const signedIn = (token: Record<string, unknown>): Record<string, unknown> => ({
	clientId: 'usher-ui',
	name: SIGN_IN_SCHEME,
	schema: { flow: 'authorizationCode', tokenUrl: TOKEN_ENDPOINT, type: 'oauth2' },
	token,
});

const FIRST_TOKEN = { access_token: 'first-access', expires_in: 300, refresh_token: 'first-refresh' };

const RENEWED_TOKEN = { access_token: 'renewed-access', expires_in: 300, refresh_token: 'renewed-refresh' };

interface Timer {
	callback: () => void;
	delay: number;
	id: number;
}

interface TokenRequest {
	body: string;
	headers: Record<string, string>;
	method: string;
	url: string;
}

type TokenAnswer = { body: unknown; status: number } | 'unreachable';

type Authorize = (payload: { auth: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

interface SessionPlugin {
	statePlugins: {
		auth: {
			wrapActions: { authorizeOauth2: (original: Authorize) => Authorize; logout: (original: Logout) => Logout };
		};
	};
}

interface InterceptedRequest {
	headers: Record<string, string>;
	url: string;
}

// A page as a browser runs it, with its clock, timers and connections in the test's hands, and
// Swagger UI's state for the sign-in scheme held as the bundle holds it.
const page = (answers: TokenAnswer[] = []) => {
	const clock = { now: 1_000_000 };
	const timers: Timer[] = [];
	const cleared: number[] = [];
	const assigned: string[] = [];
	const requests: TokenRequest[] = [];
	const state: { authorized: Record<string, Record<string, unknown>> } = { authorized: {} };
	const pending = [...answers];
	const window = {
		clearTimeout: (id: number) => {
			cleared.push(id);
		},
		fetch: async (
			url: string,
			init: { body: URLSearchParams; headers: Record<string, string>; method: string },
		) => {
			requests.push({ body: init.body.toString(), headers: init.headers, method: init.method, url });
			const answer = pending.shift() ?? 'unreachable';
			if (answer === 'unreachable') {
				throw new TypeError('Failed to fetch');
			}
			return {
				json: async () => answer.body,
				ok: answer.status >= 200 && answer.status < 300,
				status: answer.status,
			};
		},
		location: {
			assign: (address: string) => {
				assigned.push(address);
			},
			origin: PAGE_ORIGIN,
		},
		setTimeout: (callback: () => void, delay: number) => {
			const id = timers.length + 1;
			timers.push({ callback, delay, id });
			return id;
		},
	};
	const options: Record<string, unknown>[] = [];
	const bundle = Object.assign(
		(given: Record<string, unknown>) => {
			options.push(given);
			return { initOAuth: () => undefined };
		},
		{ presets: { apis: API_PRESET } },
	);
	new Function('SwaggerUIBundle', 'window', 'Date', initializerScript('usher-ui'))(bundle, window, {
		now: () => clock.now,
	});
	const plugins = options[0]?.['plugins'];
	const plugin = (Array.isArray(plugins) ? plugins[0] : undefined) as
		((system: unknown) => SessionPlugin) | undefined;
	const actions: { authorizeOauth2: Authorize; logout: Logout } = {
		authorizeOauth2: () => undefined,
		logout: () => undefined,
	};
	const system = {
		authActions: {
			authorizeOauth2: (payload: Parameters<Authorize>[0]) => actions.authorizeOauth2(payload),
			logout: (names: unknown) => actions.logout(names),
		},
		authSelectors: { authorized: () => ({ toJS: () => structuredClone(state.authorized) }) },
		specSelectors: systemWith(END_SESSION_ENDPOINT).specSelectors,
	};
	const wraps = (plugin ?? assert.fail('no plugin'))(system).statePlugins.auth.wrapActions;
	actions.authorizeOauth2 = wraps.authorizeOauth2(({ auth, token }) => {
		state.authorized = { ...state.authorized, [String(auth['name'])]: { ...auth, token: { ...token } } };
	});
	actions.logout = wraps.logout((names) => {
		state.authorized = Object.fromEntries(
			Object.entries(state.authorized).filter(([name]) => !(Array.isArray(names) && names.includes(name))),
		);
	});
	const interceptor = options[0]?.['requestInterceptor'] as
		((request: InterceptedRequest) => InterceptedRequest | Promise<InterceptedRequest>) | undefined;
	return {
		assigned,
		cleared,
		clock,
		intercept: async (request: InterceptedRequest) => (interceptor ?? assert.fail('no interceptor'))(request),
		requests,
		authorize: (auth: Record<string, unknown>, token: Record<string, unknown>) =>
			system.authActions.authorizeOauth2({ auth, token }),
		signIn: (token: Record<string, unknown>) => system.authActions.authorizeOauth2({ auth: signedIn({}), token }),
		signOut: (names: unknown) => system.authActions.logout(names),
		state,
		// Fires the newest timer and waits for whatever it started to settle.
		async fire(): Promise<void> {
			(timers.at(-1) ?? assert.fail('no timer')).callback();
			await new Promise((resolve) => setImmediate(resolve));
		},
		timers,
	};
};

const heldToken = (state: { authorized: Record<string, Record<string, unknown>> }): unknown =>
	state.authorized[SIGN_IN_SCHEME]?.['token'];

suite("the API documentation page's renewal of a sign-in", () => {
	test('sets a renewal for 30 seconds before the token lapses once someone signs in', () => {
		const signed = page();

		signed.signIn(FIRST_TOKEN);

		assert.deepEqual(
			signed.timers.map(({ delay }) => delay),
			[270_000],
		);
	});

	test('sets the renewal halfway through the life of a token living under a minute', () => {
		const signed = page();

		signed.signIn({ ...FIRST_TOKEN, expires_in: 40 });

		assert.deepEqual(
			signed.timers.map(({ delay }) => delay),
			[20_000],
		);
	});

	test("asks the identity provider's token endpoint for a new token with the refresh token held, naming the client, by POST, with nothing in the address", async () => {
		const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
		signed.signIn(FIRST_TOKEN);

		await signed.fire();

		assert.equal(signed.requests.length, 1);
		const [request] = signed.requests;
		assert.equal(request?.url, TOKEN_ENDPOINT);
		assert.equal(request?.method, 'POST');
		assert.equal(request?.headers['Content-Type'], 'application/x-www-form-urlencoded');
		assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.body)), {
			client_id: 'usher-ui',
			grant_type: 'refresh_token',
			refresh_token: 'first-refresh',
		});
	});

	test('holds the renewed token in place of the first, and sets the next renewal from its life', async () => {
		const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
		signed.signIn(FIRST_TOKEN);

		await signed.fire();

		assert.deepEqual(heldToken(signed.state), RENEWED_TOKEN);
		assert.deepEqual(
			signed.timers.map(({ delay }) => delay),
			[270_000, 270_000],
		);
		assert.deepEqual(signed.assigned, []);
	});

	test('keeps the refresh token held when the renewed token comes without one', async () => {
		const signed = page([{ body: { access_token: 'renewed-access', expires_in: 300 }, status: 200 }]);
		signed.signIn(FIRST_TOKEN);

		await signed.fire();

		assert.deepEqual(heldToken(signed.state), {
			access_token: 'renewed-access',
			expires_in: 300,
			refresh_token: 'first-refresh',
		});
	});

	test('shows the person signed out, staying on the page, when the identity provider refuses the renewal, cannot be reached, or answers without a token', async () => {
		const answers: TokenAnswer[] = [
			{ body: { error: 'invalid_grant' }, status: 400 },
			'unreachable',
			{ body: { expires_in: 300 }, status: 200 },
			{ body: 'not a token', status: 200 },
		];

		const outcomes = await Promise.all(
			answers.map(async (answer) => {
				const signed = page([answer]);
				signed.signIn(FIRST_TOKEN);
				await signed.fire();
				return { assigned: signed.assigned, held: heldToken(signed.state) };
			}),
		);

		assert.deepEqual(
			outcomes,
			answers.map(() => ({ assigned: [], held: undefined })),
		);
	});

	test('shows the person signed out when the token lapses holding no refresh token, asking nothing of the identity provider', async () => {
		const signed = page();
		signed.signIn({ access_token: 'first-access', expires_in: 300 });

		await signed.fire();

		assert.deepEqual(signed.requests, []);
		assert.equal(heldToken(signed.state), undefined);
		assert.deepEqual(signed.assigned, []);
	});

	test('sets no renewal, and changes no request, for a token naming no positive life', async () => {
		const lives = [undefined, 0, -5, '300'];

		const outcomes = await Promise.all(
			lives.map(async (life) => {
				const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
				signed.signIn({ access_token: 'first-access', expires_in: life, refresh_token: 'first-refresh' });
				signed.clock.now += 3_600_000;
				const sent = await signed.intercept({
					headers: { Authorization: 'Bearer first-access' },
					url: `${PAGE_ORIGIN}/admin/me/grants`,
				});
				return { requests: signed.requests.length, sent: sent.headers, timers: signed.timers.length };
			}),
		);

		assert.deepEqual(
			outcomes,
			lives.map(() => ({ requests: 0, sent: { Authorization: 'Bearer first-access' }, timers: 0 })),
		);
	});

	test('sets no renewal for a sign-in through another scheme', () => {
		const signed = page();

		signed.authorize({ ...signedIn({}), name: 'managementToken' }, FIRST_TOKEN);

		assert.deepEqual(signed.timers, []);
	});

	test("cancels the renewal set when the person signs out, and still ends the identity provider's session", () => {
		const signed = page();
		signed.signIn(FIRST_TOKEN);

		signed.signOut([SIGN_IN_SCHEME]);

		assert.deepEqual(signed.cleared, [1]);
		assert.equal(signed.assigned.length, 1);
	});

	test('cancels the renewal set before when the person signs in again', () => {
		const signed = page();
		signed.signIn(FIRST_TOKEN);

		signed.signIn(RENEWED_TOKEN);

		assert.deepEqual(signed.cleared, [1]);
		assert.equal(signed.timers.length, 2);
	});

	test('renews first, then sends a request carrying the held token once its renewal is due, as after a sleeping tab', async () => {
		const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
		signed.signIn(FIRST_TOKEN);
		signed.clock.now += 290_000;

		const sent = await signed.intercept({
			headers: { Authorization: 'Bearer first-access' },
			url: `${PAGE_ORIGIN}/admin/me/grants`,
		});

		assert.equal(signed.requests.length, 1);
		assert.equal(sent.headers['Authorization'], 'Bearer renewed-access');
	});

	test('sends a request unchanged while the held token is not yet due for renewal, or when it carries no held token', async () => {
		const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
		signed.signIn(FIRST_TOKEN);
		const early = await signed.intercept({
			headers: { Authorization: 'Bearer first-access' },
			url: `${PAGE_ORIGIN}/admin/me/grants`,
		});
		signed.clock.now += 290_000;

		const others = await Promise.all([
			signed.intercept({ headers: {}, url: TOKEN_ENDPOINT }),
			signed.intercept({
				headers: { Authorization: 'Bearer typed-by-hand' },
				url: `${PAGE_ORIGIN}/admin/me/grants`,
			}),
		]);

		assert.deepEqual(early.headers, { Authorization: 'Bearer first-access' });
		assert.deepEqual(
			others.map(({ headers }) => headers),
			[{}, { Authorization: 'Bearer typed-by-hand' }],
		);
		assert.deepEqual(signed.requests, []);
	});

	test('sends a due request with no token once its renewal fails, showing the person signed out', async () => {
		const signed = page([{ body: { error: 'invalid_grant' }, status: 400 }]);
		signed.signIn(FIRST_TOKEN);
		signed.clock.now += 290_000;

		const sent = await signed.intercept({
			headers: { Authorization: 'Bearer first-access' },
			url: `${PAGE_ORIGIN}/admin/me/grants`,
		});

		assert.deepEqual(sent.headers, {});
		assert.equal(heldToken(signed.state), undefined);
	});

	test('asks for one renewal when the renewal set and a request fall due together', async () => {
		const signed = page([{ body: RENEWED_TOKEN, status: 200 }]);
		signed.signIn(FIRST_TOKEN);
		signed.clock.now += 290_000;

		const [, sent] = await Promise.all([
			signed.fire(),
			signed.intercept({
				headers: { Authorization: 'Bearer first-access' },
				url: `${PAGE_ORIGIN}/admin/me/grants`,
			}),
		]);

		assert.equal(signed.requests.length, 1);
		assert.equal(sent.headers['Authorization'], 'Bearer renewed-access');
	});
});
