import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { RouteOptions } from 'fastify';

import committedContract from '../../openapi.json' with { type: 'json' };
import { initializerScript } from './initializerScript.js';
import { API_DOCS_PAGE } from './page.js';
import { API_DOCS_PATH, CONTRACT_PATH, INITIALIZER_PATH } from './paths.js';
import { servedSpec } from './servedSpec.js';
import type { ApiDocsSettings, OpenApiDocument } from './types.js';

const COMMITTED_CONTRACT: OpenApiDocument = committedContract;

const HTML = 'text/html; charset=utf-8';

const JAVASCRIPT = 'text/javascript; charset=utf-8';

const NOT_STORED = 'no-store';

// The pinned package's files change only with its version, which their paths do not carry, so they are
// cached for an hour rather than for good.
const PACKAGE_FILE_CACHING = 'max-age=3600';

interface Served {
  body: Buffer | string;
  cacheControl: string;
  contentType: string;
}

interface PackageFile {
  cacheControl: string;
  contentType: string;

  /** The file's name in the package, which is also its name under the page's path. */
  name: string;
}

// The allow-list: the only files of the package ever read, each once, by these fixed names. The
// redirect page is not stored, since its URL carries the authorization code.
const PACKAGE_FILES: readonly PackageFile[] = [
  {
    cacheControl: PACKAGE_FILE_CACHING,
    contentType: 'image/png',
    name: 'favicon-16x16.png',
  },
  {
    cacheControl: PACKAGE_FILE_CACHING,
    contentType: 'image/png',
    name: 'favicon-32x32.png',
  },
  {
    cacheControl: NOT_STORED,
    contentType: HTML,
    name: 'oauth2-redirect.html',
  },
  {
    cacheControl: PACKAGE_FILE_CACHING,
    contentType: JAVASCRIPT,
    name: 'oauth2-redirect.js',
  },
  {
    cacheControl: PACKAGE_FILE_CACHING,
    contentType: JAVASCRIPT,
    name: 'swagger-ui-bundle.js',
  },
  {
    cacheControl: PACKAGE_FILE_CACHING,
    contentType: 'text/css; charset=utf-8',
    name: 'swagger-ui.css',
  },
];

// Found through the package's own resolution, so the same code finds it in the source tree and in an
// image's node_modules.
const packageFolder = (): string =>
  dirname(
    createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
  );

// Scripts, styles, fonts and images from the controller's origin alone, the identity provider's origin
// reachable for its discovery document and token endpoint, and nothing inline.
const contentSecurityPolicy = (issuer: string): string =>
  [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src 'self' ${new URL(issuer).origin}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

// No answer sets a cross-origin opener policy, since the redirect page needs window.opener after its
// round trip through the identity provider.
const securityHeaders = (issuer: string): Readonly<Record<string, string>> => ({
  'content-security-policy': contentSecurityPolicy(issuer),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

const servedRoutes = ({
  apiDocsClient,
  identityProviderIssuer,
}: ApiDocsSettings): readonly RouteOptions[] => {
  const folder = packageFolder();
  const page: Served = {
    body: API_DOCS_PAGE,
    cacheControl: NOT_STORED,
    contentType: HTML,
  };
  const served: Readonly<Record<string, Served>> = {
    [API_DOCS_PATH]: page,
    [`${API_DOCS_PATH}/`]: page,
    [CONTRACT_PATH]: {
      body: JSON.stringify(
        servedSpec(COMMITTED_CONTRACT, identityProviderIssuer),
      ),
      cacheControl: NOT_STORED,
      contentType: 'application/json; charset=utf-8',
    },
    [INITIALIZER_PATH]: {
      body: initializerScript(apiDocsClient),
      cacheControl: NOT_STORED,
      contentType: JAVASCRIPT,
    },
    ...Object.fromEntries(
      PACKAGE_FILES.map(({ cacheControl, contentType, name }) => [
        `${API_DOCS_PATH}/${name}`,
        { body: readFileSync(join(folder, name)), cacheControl, contentType },
      ]),
    ),
  };
  const security = securityHeaders(identityProviderIssuer);
  return Object.entries(served).map(
    ([url, { body, cacheControl, contentType }]): RouteOptions => {
      const headers = {
        ...security,
        'cache-control': cacheControl,
        'content-type': contentType,
      };
      return {
        handler: async (_request, reply) => reply.headers(headers).send(body),
        method: 'GET',
        url,
      };
    },
  );
};

/**
 * Creates the routes of the API documentation page, which take no credential. While its client is
 * empty it creates none, so every path under `/api-docs` is answered as an unknown path is. While its
 * client is set, `GET` and `HEAD` are answered at `/api-docs` and `/api-docs/` with the page, at
 * `/api-docs/openapi.json` with the served contract, at `/api-docs/initializer.js` with the script
 * starting Swagger UI, and at a fixed allow-list of paths with the pinned Swagger UI package's own
 * files, the redirect page and its script among them; any other path is answered as an unknown path
 * is. Every file is read, and the contract and the initializer built, once, as the routes are created,
 * and no part of a request's path ever reaches the filesystem. Every answer carries the content
 * security policy, allowing connections to the issuer's origin, and refuses framing, sniffing and
 * referrers; the page, the redirect page, the contract and the initializer are never stored.
 *
 * @param settings the page's client, empty for no page, and the identity provider's issuer.
 * @throws when the package's files cannot be read.
 */
export const createApiDocsRoutes = (
  settings: ApiDocsSettings,
): readonly RouteOptions[] =>
  settings.apiDocsClient === '' ? [] : servedRoutes(settings);
