import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { suite, test, type TestContext } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createServer } from '../http/index.js';
import { createApiDocsRoutes } from './createApiDocsRoutes.js';
import { initializerScript } from './initializerScript.js';
import { servedSpec } from './servedSpec.js';
import type { ApiDocsSettings, OpenApiDocument } from './types.js';

const ISSUER = 'https://auth.example.org/realms/usher';

const ON: ApiDocsSettings = {
  apiDocsClient: 'usher-ui',
  identityProviderIssuer: ISSUER,
};

const OFF: ApiDocsSettings = {
  apiDocsClient: '',
  identityProviderIssuer: ISSUER,
};

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self' https://auth.example.org; img-src 'self' data:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

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

const serverWith = (
  context: TestContext,
  settings: ApiDocsSettings,
): FastifyInstance => {
  const server = createServer({
    isLive: () => true,
    isReady: async () => true,
    trustedProxies: [],
  });
  createApiDocsRoutes(settings).forEach((route) => {
    server.route(route);
  });
  context.after(() => server.close());
  return server;
};

interface Answer {
  body: string;
  headers: Readonly<Record<string, unknown>>;
  statusCode: number;
}

// An answer as a client reads it, less the date and the connection, which the transport sets.
const answerOf = async (
  server: FastifyInstance,
  method: 'GET' | 'HEAD',
  url: string,
): Promise<Answer> => {
  const {
    body,
    headers: { connection: _connection, date: _date, ...headers },
    statusCode,
  } = await server.inject({ method, url });
  return { body, headers, statusCode };
};

const packageFolder = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);

const packageFile = (name: string): Promise<Buffer> =>
  readFile(join(packageFolder, name));

const committedSpec = async (): Promise<OpenApiDocument> =>
  JSON.parse(
    await readFile(new URL('../../openapi.json', import.meta.url), 'utf8'),
  ) as OpenApiDocument;

const pageOf = async (server: FastifyInstance): Promise<string> =>
  (await server.inject({ method: 'GET', url: '/api-docs' })).body;

suite('the API documentation page, while its client is empty', () => {
  test('answers every path under /api-docs as an unknown path is answered, status, headers and body alike', async (context) => {
    const server = serverWith(context, OFF);
    const paths = [...SERVED.map(({ path }) => path), ...UNSERVED_PATHS];

    const unknown = await Promise.all(
      (['GET', 'HEAD'] as const).map((method) =>
        answerOf(server, method, UNKNOWN_PATH),
      ),
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
    answers.forEach(({ answer, expected, label }) =>
      assert.deepEqual(answer, expected, label),
    );
  });

  test('builds no route at all', () => {
    assert.deepEqual(createApiDocsRoutes(OFF), []);
  });
});

suite('the API documentation page, while its client is set', () => {
  test('answers each route with exactly the security headers, its content type and its caching, the content security policy whole, on GET and HEAD alike', async (context) => {
    const server = serverWith(context, ON);

    const answers = await Promise.all(
      SERVED.flatMap(({ cacheControl, contentType, path }) =>
        (['GET', 'HEAD'] as const).map(async (method) => {
          const { body: _body, ...answer } = await answerOf(
            server,
            method,
            path,
          );
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
          ...SECURITY_HEADERS,
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
    const scripts = [
      ...page.matchAll(
        /<script\b(?<attributes>[^>]*)>(?<content>[\s\S]*?)<\/script>/giu,
      ),
    ];

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
    const named = [...page.matchAll(/\s(?:href|src)="(?<url>[^"]*)"/gu)].map(
      ({ groups }) => groups?.['url'] ?? '',
    );

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
    answers.forEach(({ statusCode, url }) =>
      assert.equal(statusCode, 200, url),
    );
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

    compared.forEach(({ expected, path, served }) =>
      assert.ok(served.equals(expected), path),
    );
  });

  test('serves the contract as built from the committed one and the issuer', async (context) => {
    const server = serverWith(context, ON);

    const { body } = await answerOf(server, 'GET', '/api-docs/openapi.json');

    assert.deepEqual(
      JSON.parse(body),
      servedSpec(await committedSpec(), ISSUER),
    );
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

    answers.forEach(({ answer, path }) =>
      assert.deepEqual(answer, unknown, path),
    );
  });

  test('answers a method other than GET and HEAD on a served path as an unknown path is answered', async (context) => {
    const server = serverWith(context, ON);

    const unknown = await server.inject({ method: 'POST', url: UNKNOWN_PATH });
    const posted = await server.inject({ method: 'POST', url: '/api-docs' });

    assert.deepEqual(
      [posted.statusCode, posted.body],
      [unknown.statusCode, unknown.body],
    );
  });
});

suite('the Swagger UI package served', () => {
  test('is named through the workspace catalogue, which pins exactly 5.34.1, and resolves to that version', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Readonly<Record<string, string>> };
    const workspace = await readFile(
      new URL('../../../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const resolved = JSON.parse(
      (await packageFile('package.json')).toString('utf8'),
    ) as { name: string; version: string };

    assert.equal(manifest.dependencies['swagger-ui-dist'], 'catalog:');
    assert.deepEqual(
      [...workspace.matchAll(/^ {2}swagger-ui-dist: (?<pin>.*)$/gmu)].map(
        ({ groups }) => groups?.['pin'],
      ),
      ['5.34.1'],
    );
    assert.deepEqual(
      { name: resolved.name, version: resolved.version },
      { name: 'swagger-ui-dist', version: '5.34.1' },
    );
  });
});
