import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { Clock } from '../configuration/index.js';
import type { LineFields } from '../eventLog/index.js';
import { createServer } from '../http/index.js';
import { ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS, ISSUER_ENDPOINTS_UNAVAILABLE } from '../identityProvider/index.js';
import { createApiDocsRoutes } from './createApiDocsRoutes.js';
import { initializerScript } from './initializerScript.js';
import { servedSpec } from './servedSpec.js';
import type { ApiDocsSettings, OpenApiDocument } from './types.js';

const ISSUER = 'https://auth.example.org/realms/usher';

interface ControlledClock extends Clock {
	advance(milliseconds: number): void;
}

// A clock that stands still between a test's moves, so a time left in the cooldown is exact.
const controlledClock = (): ControlledClock => {
	const state = { now: Date.now() };
	return {
		advance: (milliseconds) => {
			state.now += milliseconds;
		},
		now: () => state.now,
	};
};

const ON: ApiDocsSettings = {
	apiDocsClient: 'usher-ui',
	clock: controlledClock(),
	identityProviderIssuer: ISSUER,
};

const OFF: ApiDocsSettings = {
	apiDocsClient: '',
	clock: controlledClock(),
	identityProviderIssuer: ISSUER,
};

const contentSecurityPolicy = (origin: string): string =>
	`default-src 'none'; script-src 'self'; connect-src 'self' ${origin}; img-src 'self' data:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`;

const securityHeaders = (origin: string): Readonly<Record<string, string>> => ({
	'content-security-policy': contentSecurityPolicy(origin),
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
});

const NOT_STORED = 'no-store';

const CACHED_AN_HOUR = 'max-age=3600';

const HTML = 'text/html; charset=utf-8';

const JAVASCRIPT = 'text/javascript; charset=utf-8';

interface ServedRoute {
	cacheControl: string;
	contentType: string;
	path: string;
}

// Every route the page serves while on, with the content type and caching each answers with.
const SERVED: readonly ServedRoute[] = [
	{ cacheControl: NOT_STORED, contentType: HTML, path: '/api-docs' },
	{ cacheControl: NOT_STORED, contentType: HTML, path: '/api-docs/' },
	{
		cacheControl: NOT_STORED,
		contentType: 'application/json; charset=utf-8',
		path: '/api-docs/openapi.json',
	},
	{
		cacheControl: NOT_STORED,
		contentType: JAVASCRIPT,
		path: '/api-docs/initializer.js',
	},
	{
		cacheControl: NOT_STORED,
		contentType: HTML,
		path: '/api-docs/oauth2-redirect.html',
	},
	{
		cacheControl: CACHED_AN_HOUR,
		contentType: JAVASCRIPT,
		path: '/api-docs/oauth2-redirect.js',
	},
	{
		cacheControl: CACHED_AN_HOUR,
		contentType: 'text/css; charset=utf-8',
		path: '/api-docs/swagger-ui.css',
	},
	{
		cacheControl: CACHED_AN_HOUR,
		contentType: JAVASCRIPT,
		path: '/api-docs/swagger-ui-bundle.js',
	},
	{
		cacheControl: CACHED_AN_HOUR,
		contentType: 'image/png',
		path: '/api-docs/favicon-16x16.png',
	},
	{
		cacheControl: CACHED_AN_HOUR,
		contentType: 'image/png',
		path: '/api-docs/favicon-32x32.png',
	},
];

// The package's files each served path holds, as the package publishes them.
const PACKAGE_FILE_BY_PATH: Readonly<Record<string, string>> = {
	'/api-docs/favicon-16x16.png': 'favicon-16x16.png',
	'/api-docs/favicon-32x32.png': 'favicon-32x32.png',
	'/api-docs/oauth2-redirect.html': 'oauth2-redirect.html',
	'/api-docs/oauth2-redirect.js': 'oauth2-redirect.js',
	'/api-docs/swagger-ui-bundle.js': 'swagger-ui-bundle.js',
	'/api-docs/swagger-ui.css': 'swagger-ui.css',
};

// Paths under /api-docs the page never serves: the package's other files, its own page and
// initializer, the standalone preset, a source map, traversal and near misses of served paths.
const UNSERVED_PATHS: readonly string[] = [
	'/api-docs/index.html',
	'/api-docs/index.css',
	'/api-docs/index.js',
	'/api-docs/package.json',
	'/api-docs/swagger-initializer.js',
	'/api-docs/swagger-ui-standalone-preset.js',
	'/api-docs/swagger-ui-bundle.js.map',
	'/api-docs/swagger-ui.js',
	'/api-docs/swagger-ui-es-bundle.js',
	'/api-docs/absolute-path.js',
	'/api-docs/LICENSE',
	'/api-docs/node_modules/swagger-ui-dist/package.json',
	'/api-docs/..%2fpackage.json',
	'/api-docs/%2e%2e%2fpackage.json',
	'/api-docs/swagger-ui.css/',
	'/api-docs/oauth2-redirect.html/',
	'/api-docs//',
	'/api-docs/openapi',
	'/api-docs/OPENAPI.JSON',
	'/API-DOCS',
	'/api-docsx',
	'/api-docs/initializer.js.map',
];

const UNKNOWN_PATH = '/an-unknown-path';

const CONTRACT_PATH = '/api-docs/openapi.json';

const DISCOVERY_PATH = '/realms/test/.well-known/openid-configuration';

interface Line {
	fields: LineFields | undefined;
	message: string;
}

interface Provider {
	/** Each path asked for, in order. */
	asked: string[];

	/** Members set over the discovery document's own. */
	departures: Readonly<Record<string, unknown>>;

	/** Settles once the provider is first asked for anything. */
	firstAsked: Promise<void>;

	issuer: string;

	/** The issuer's origin, as the content security policy names it. */
	origin: string;

	/** Whether it answers every request 503. */
	refusing: boolean;

	/** Lets every answer go, for a provider started holding them. */
	release(): void;
}

const isAddress = (address: unknown): address is AddressInfo =>
	typeof address === 'object' && address !== null && 'port' in address;

// An identity provider answering its discovery document, holding every answer until released when
// asked to.
const startProvider = async (context: TestContext, holding = false): Promise<Provider> => {
	const held = Promise.withResolvers<void>();
	const asked = Promise.withResolvers<void>();
	const provider: Provider = {
		asked: [],
		departures: {},
		firstAsked: asked.promise,
		issuer: '',
		origin: '',
		refusing: false,
		release: () => held.resolve(),
	};
	const server = createHttpServer((request, response) => {
		const path = request.url ?? '';
		provider.asked.push(path);
		asked.resolve();
		const answer = (): void => {
			if (provider.refusing) {
				response.writeHead(503);
				response.end();
			} else if (path === DISCOVERY_PATH) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						authorization_endpoint: `${provider.issuer}/protocol/openid-connect/auth`,
						issuer: provider.issuer,
						token_endpoint: `${provider.issuer}/protocol/openid-connect/token`,
						...provider.departures,
					}),
				);
			} else {
				response.writeHead(404);
				response.end();
			}
		};
		if (holding) {
			void held.promise.then(answer);
		} else {
			answer();
		}
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	context.after(
		() =>
			new Promise<void>((resolve) => {
				held.resolve();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const address = server.address();
	assert.ok(isAddress(address));
	provider.origin = `http://127.0.0.1:${address.port}`;
	provider.issuer = `${provider.origin}/realms/test`;
	return provider;
};

const endpointsOf = (provider: Provider): { authorizationEndpoint: string; tokenEndpoint: string } => ({
	authorizationEndpoint: `${provider.issuer}/protocol/openid-connect/auth`,
	tokenEndpoint: `${provider.issuer}/protocol/openid-connect/token`,
});

const serverWith = (context: TestContext, settings: ApiDocsSettings, lines: Line[] = []): FastifyInstance => {
	const server = createServer({
		isLive: () => true,
		isReady: async () => true,
		trustedProxies: [],
	});
	createApiDocsRoutes(settings, {
		error: (message, fields) => {
			lines.push({ fields, message });
		},
	}).forEach((route) => {
		server.route(route);
	});
	context.after(() => server.close());
	return server;
};

const providerSettings = (provider: Provider, clock: Clock = controlledClock()): ApiDocsSettings => ({
	apiDocsClient: 'usher-ui',
	clock,
	identityProviderIssuer: provider.issuer,
});

interface Answer {
	body: string;
	headers: Readonly<Record<string, unknown>>;
	statusCode: number;
}

// An answer as a client reads it, less the date and the connection, which the transport sets.
const answerOf = async (server: FastifyInstance, method: 'GET' | 'HEAD', url: string): Promise<Answer> => {
	const {
		body,
		headers: { connection: _connection, date: _date, ...headers },
		statusCode,
	} = await server.inject({ method, url });
	return { body, headers, statusCode };
};

const packageFolder = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));

const packageFile = (name: string): Promise<Buffer> => readFile(join(packageFolder, name));

const committedSpec = async (): Promise<OpenApiDocument> =>
	JSON.parse(await readFile(new URL('../../openapi.json', import.meta.url), 'utf8')) as OpenApiDocument;

const pageOf = async (server: FastifyInstance): Promise<string> =>
	(await server.inject({ method: 'GET', url: '/api-docs' })).body;

suite('the API documentation page, while its client is empty', () => {
	test('answers every path under /api-docs as an unknown path is answered, status, headers and body alike', async (context) => {
		const server = serverWith(context, OFF);
		const paths = [...SERVED.map(({ path }) => path), ...UNSERVED_PATHS];

		const unknown = await Promise.all(
			(['GET', 'HEAD'] as const).map((method) => answerOf(server, method, UNKNOWN_PATH)),
		);
		const answers = await Promise.all(
			paths.flatMap((path) =>
				(['GET', 'HEAD'] as const).map(async (method, index) => ({
					answer: await answerOf(server, method, path),
					expected: unknown[index],
					label: `${method} ${path}`,
				})),
			),
		);

		assert.equal(unknown[0]?.statusCode, 404);
		answers.forEach(({ answer, expected, label }) => assert.deepEqual(answer, expected, label));
	});

	test('builds no route at all', () => {
		assert.deepEqual(createApiDocsRoutes(OFF, { error: () => undefined }), []);
	});

	test('asks the identity provider for nothing, whatever path is asked for', async (context) => {
		const provider = await startProvider(context);
		const server = serverWith(context, {
			...providerSettings(provider),
			apiDocsClient: '',
		});

		await Promise.all(
			[...SERVED.map(({ path }) => path), ...UNSERVED_PATHS].map((path) => answerOf(server, 'GET', path)),
		);

		assert.deepEqual(provider.asked, []);
	});
});

suite('the API documentation page, while its client is set', () => {
	test('answers each route with exactly the security headers, its content type and its caching, the content security policy whole, on GET and HEAD alike', async (context) => {
		const provider = await startProvider(context);
		const server = serverWith(context, providerSettings(provider));

		const answers = await Promise.all(
			SERVED.flatMap(({ cacheControl, contentType, path }) =>
				(['GET', 'HEAD'] as const).map(async (method) => {
					const { body: _body, ...answer } = await answerOf(server, method, path);
					return {
						answer,
						cacheControl,
						contentType,
						label: `${method} ${path}`,
					};
				}),
			),
		);

		answers.forEach(({ answer, cacheControl, contentType, label }) => {
			const { 'content-length': length, ...headers } = answer.headers;
			assert.equal(answer.statusCode, 200, label);
			assert.match(String(length), /^[1-9]\d*$/u, label);
			assert.deepEqual(
				headers,
				{
					...securityHeaders(provider.origin),
					'cache-control': cacheControl,
					'content-type': contentType,
				},
				label,
			);
		});
	});

	test("names the identity provider's origin alone in connect-src, never its path, and answers no cross-origin opener policy", async (context) => {
		const server = serverWith(context, {
			apiDocsClient: 'usher-ui',
			clock: controlledClock(),
			identityProviderIssuer: 'http://127.0.0.1:8080/realms/overture',
		});

		const { headers } = await answerOf(server, 'GET', '/api-docs');

		assert.equal(
			headers['content-security-policy'],
			"default-src 'none'; script-src 'self'; connect-src 'self' http://127.0.0.1:8080; img-src 'self' data:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
		);
		assert.equal(
			Object.keys(headers).some((name) => name.startsWith('cross-origin-')),
			false,
		);
	});

	test('serves the same page at /api-docs and at /api-docs/', async (context) => {
		const server = serverWith(context, ON);

		const [bare, slashed] = await Promise.all(
			['/api-docs', '/api-docs/'].map((url) => answerOf(server, 'GET', url)),
		);

		assert.equal(bare?.body, slashed?.body);
		assert.match(bare?.body ?? '', /<div id="swagger-ui"><\/div>/u);
	});

	test('holds no inline script, no style element, no style attribute and no event handler attribute in its page', async (context) => {
		const page = await pageOf(serverWith(context, ON));
		const scripts = [...page.matchAll(/<script\b(?<attributes>[^>]*)>(?<content>[\s\S]*?)<\/script>/giu)];

		assert.ok(scripts.length > 0);
		scripts.forEach(({ groups }) => {
			assert.match(groups?.['attributes'] ?? '', /\ssrc="\/api-docs\/[^"]+"/u);
			assert.equal(groups?.['content'], '');
		});
		assert.equal(
			[...page.matchAll(/<script\b/giu)].length,
			scripts.length,
			'every script element is closed and counted',
		);
		assert.doesNotMatch(page, /<style\b/iu);
		assert.doesNotMatch(page, /\sstyle\s*=/iu);
		assert.doesNotMatch(page, /\son[a-z]+\s*=/iu);
		assert.doesNotMatch(page, /javascript:/iu);
	});

	test('names every script, stylesheet and icon by an absolute path under /api-docs/, each of them served', async (context) => {
		const server = serverWith(context, ON);
		const page = await pageOf(server);
		const named = [...page.matchAll(/\s(?:href|src)="(?<url>[^"]*)"/gu)].map(({ groups }) => groups?.['url'] ?? '');

		const answers = await Promise.all(
			named.map(async (url) => ({
				statusCode: (await answerOf(server, 'GET', url)).statusCode,
				url,
			})),
		);

		assert.deepEqual(named.toSorted(), [
			'/api-docs/favicon-16x16.png',
			'/api-docs/favicon-32x32.png',
			'/api-docs/initializer.js',
			'/api-docs/swagger-ui-bundle.js',
			'/api-docs/swagger-ui.css',
		]);
		answers.forEach(({ statusCode, url }) => assert.equal(statusCode, 200, url));
	});

	test("serves each of the package's files as the package holds it, the redirect page and its script among them", async (context) => {
		const server = serverWith(context, ON);

		const compared = await Promise.all(
			Object.entries(PACKAGE_FILE_BY_PATH).map(async ([path, name]) => ({
				expected: await packageFile(name),
				path,
				served: (await server.inject({ method: 'GET', url: path })).rawPayload,
			})),
		);

		compared.forEach(({ expected, path, served }) => assert.ok(served.equals(expected), path));
	});

	test("serves the contract built from the committed one and the endpoints the issuer's discovery document names, reading them once for every request", async (context) => {
		const provider = await startProvider(context);
		const server = serverWith(context, providerSettings(provider));

		const first = await answerOf(server, 'GET', CONTRACT_PATH);
		const second = await answerOf(server, 'GET', CONTRACT_PATH);

		assert.equal(first.statusCode, 200);
		assert.deepEqual(JSON.parse(first.body), servedSpec(await committedSpec(), endpointsOf(provider)));
		assert.equal(second.body, first.body);
		assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
	});

	test('holds a request for the contract while the endpoints are being read, answering it once the read ends, one read for every request held', async (context) => {
		const provider = await startProvider(context, true);
		const server = serverWith(context, providerSettings(provider));
		const settled: string[] = [];

		const requests = [1, 2].map(async (order) => {
			const answer = await answerOf(server, 'GET', CONTRACT_PATH);
			settled.push(`request ${order}`);
			return answer;
		});
		await provider.firstAsked;
		await new Promise((resolve) => setTimeout(resolve, 50));
		const settledWhileReading = [...settled];
		provider.release();
		const answers = await Promise.all(requests);

		assert.deepEqual(settledWhileReading, []);
		assert.deepEqual(
			answers.map(({ statusCode }) => statusCode),
			[200, 200],
		);
		assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
	});

	test('serves the initializer generated for the configured client', async (context) => {
		const server = serverWith(context, ON);

		const { body } = await answerOf(server, 'GET', '/api-docs/initializer.js');

		assert.equal(body, initializerScript('usher-ui'));
	});

	test('answers every path outside its allow-list as an unknown path is answered, a file of the package among them', async (context) => {
		const server = serverWith(context, ON);

		const unknown = await answerOf(server, 'GET', UNKNOWN_PATH);
		const answers = await Promise.all(
			UNSERVED_PATHS.map(async (path) => ({
				answer: await answerOf(server, 'GET', path),
				path,
			})),
		);

		answers.forEach(({ answer, path }) => assert.deepEqual(answer, unknown, path));
	});

	test('answers a method other than GET and HEAD on a served path as an unknown path is answered', async (context) => {
		const server = serverWith(context, ON);

		const unknown = await server.inject({ method: 'POST', url: UNKNOWN_PATH });
		const posted = await server.inject({ method: 'POST', url: '/api-docs' });

		assert.deepEqual([posted.statusCode, posted.body], [unknown.statusCode, unknown.body]);
	});
});

suite("the API documentation page's contract, while the identity provider's endpoints cannot be read", () => {
	const PROBLEM_HEADERS = {
		'cache-control': NOT_STORED,
		'content-type': 'application/problem+json; charset=utf-8',
	};

	test('answers 503 identityProviderUnavailable as problem details, never stored, with the security headers and Retry-After the whole seconds left in the cooldown, at least 1, asking the provider nothing more within it', async (context) => {
		const provider = await startProvider(context);
		provider.refusing = true;
		const clock = controlledClock();
		const lines: Line[] = [];
		const server = serverWith(context, providerSettings(provider, clock), lines);

		const failedRead = await answerOf(server, 'GET', CONTRACT_PATH);
		clock.advance(10_500);
		const later = await answerOf(server, 'HEAD', CONTRACT_PATH);
		clock.advance(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS - 10_501);
		const last = await answerOf(server, 'GET', CONTRACT_PATH);

		const { 'content-length': _length, ...headers } = failedRead.headers;
		assert.equal(failedRead.statusCode, 503);
		assert.deepEqual(headers, {
			...securityHeaders(provider.origin),
			...PROBLEM_HEADERS,
			'retry-after': '30',
		});
		assert.deepEqual(JSON.parse(failedRead.body), {
			code: 'identityProviderUnavailable',
			detail: "The identity provider's sign-in endpoints cannot be read from its discovery document. Try again once the seconds in Retry-After have passed.",
			status: 503,
			title: 'Identity provider unavailable',
		});
		assert.deepEqual([later.statusCode, later.headers['retry-after']], [503, '20']);
		assert.deepEqual([last.statusCode, last.headers['retry-after'], last.body], [503, '1', failedRead.body]);
		assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
		assert.deepEqual(lines, [{ fields: { cause: 'status' }, message: ISSUER_ENDPOINTS_UNAVAILABLE }]);
	});

	test('reads the endpoints again once the cooldown has passed, serving the contract once they are read', async (context) => {
		const provider = await startProvider(context);
		provider.refusing = true;
		const clock = controlledClock();
		const server = serverWith(context, providerSettings(provider, clock));

		const refused = await answerOf(server, 'GET', CONTRACT_PATH);
		provider.refusing = false;
		clock.advance(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS);
		const served = await answerOf(server, 'GET', CONTRACT_PATH);

		assert.equal(refused.statusCode, 503);
		assert.equal(served.statusCode, 200);
		assert.deepEqual(JSON.parse(served.body), servedSpec(await committedSpec(), endpointsOf(provider)));
		assert.deepEqual(provider.asked, [DISCOVERY_PATH, DISCOVERY_PATH]);
	});

	test("answers 503 when the discovery document names its authorization or its token endpoint at another origin, the content security policy naming the issuer's origin alone in every answer", async (context) => {
		const departures = [
			{
				authorization_endpoint: 'https://elsewhere.example.org/realms/test/protocol/openid-connect/auth',
			},
			{
				token_endpoint: 'https://elsewhere.example.org/realms/test/protocol/openid-connect/token',
			},
			{},
		];

		const answers = await Promise.all(
			departures.map(async (departure) => {
				const provider = await startProvider(context);
				provider.departures = departure;
				const server = serverWith(context, providerSettings(provider));
				return {
					contract: await answerOf(server, 'GET', CONTRACT_PATH),
					page: await answerOf(server, 'GET', '/api-docs'),
					policy: contentSecurityPolicy(provider.origin),
				};
			}),
		);

		assert.deepEqual(
			answers.map(({ contract }) => contract.statusCode),
			[503, 503, 200],
		);
		answers.forEach(({ contract, page, policy }) => {
			assert.equal(contract.headers['content-security-policy'], policy);
			assert.equal(page.headers['content-security-policy'], policy);
		});
	});

	test('serves the page, the initializer, the redirect page and the package files as ever while the contract answers 503', async (context) => {
		const provider = await startProvider(context);
		provider.refusing = true;
		const server = serverWith(context, providerSettings(provider));

		const contract = await answerOf(server, 'GET', CONTRACT_PATH);
		const others = await Promise.all(
			SERVED.filter(({ path }) => path !== CONTRACT_PATH).map(async ({ cacheControl, contentType, path }) => ({
				answer: await answerOf(server, 'GET', path),
				cacheControl,
				contentType,
				path,
			})),
		);

		assert.equal(contract.statusCode, 503);
		others.forEach(({ answer, cacheControl, contentType, path }) => {
			assert.equal(answer.statusCode, 200, path);
			assert.equal(answer.headers['cache-control'], cacheControl, path);
			assert.equal(answer.headers['content-type'], contentType, path);
		});
		assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
	});
});

suite('the Swagger UI package served', () => {
	test('is named through the workspace catalogue, which pins exactly 5.34.1, and resolves to that version', async () => {
		const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
			dependencies: Readonly<Record<string, string>>;
		};
		const workspace = await readFile(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8');
		const resolved = JSON.parse((await packageFile('package.json')).toString('utf8')) as {
			name: string;
			version: string;
		};

		assert.equal(manifest.dependencies['swagger-ui-dist'], 'catalog:');
		assert.deepEqual(
			[...workspace.matchAll(/^ {2}swagger-ui-dist: (?<pin>.*)$/gmu)].map(({ groups }) => groups?.['pin']),
			['5.34.1'],
		);
		assert.deepEqual(
			{ name: resolved.name, version: resolved.version },
			{ name: 'swagger-ui-dist', version: '5.34.1' },
		);
	});
});
