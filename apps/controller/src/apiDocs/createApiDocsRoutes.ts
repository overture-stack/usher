import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { FastifyReply, RouteOptions } from 'fastify';

import committedContract from '../../openapi.json' with { type: 'json' };
import { problem } from '../http/index.js';
import {
  createIssuerEndpoints,
  type IssuerEndpoints,
  type SignInEndpoints,
} from '../identityProvider/index.js';
import { initializerScript } from './initializerScript.js';
import { API_DOCS_PAGE } from './page.js';
import { API_DOCS_PATH, CONTRACT_PATH, INITIALIZER_PATH } from './paths.js';
import { servedSpec } from './servedSpec.js';
import type { ApiDocsLog, ApiDocsSettings, OpenApiDocument } from './types.js';

const COMMITTED_CONTRACT: OpenApiDocument = committedContract;

const HTML = 'text/html; charset=utf-8';

const JAVASCRIPT = 'text/javascript; charset=utf-8';

const NOT_STORED = 'no-store';

const IDENTITY_PROVIDER_UNAVAILABLE = problem(
  'identityProviderUnavailable',
  503,
  'Identity provider unavailable',
  "The identity provider's sign-in endpoints cannot be read from its discovery document. Try again once the seconds in Retry-After have passed.",
);

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
// redirect page is answered `no-store`, since its URL carries an authorization code.
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

// Scripts, styles, fonts and images from the Controller's origin alone, connections to the identity
// provider's origin as well, and nothing inline.
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

// No answer sets a cross-origin opener policy, so the redirect page served here keeps window.opener
// after its round trip through the identity provider.
const securityHeaders = (issuer: string): Readonly<Record<string, string>> => ({
  'content-security-policy': contentSecurityPolicy(issuer),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

// The whole seconds `Retry-After` names: the time left, rounded up and never 0.
const retryAfterSeconds = (milliseconds: number): number =>
  Math.max(1, Math.ceil(milliseconds / 1000));

// The contract's route: the served contract, built from the first endpoints read and reused from then
// on; while they cannot be read, the refusal, naming the time until a read may start again.
const contractRoute = (
  endpoints: IssuerEndpoints,
  security: Readonly<Record<string, string>>,
): RouteOptions => {
  const built: { body: string | undefined } = { body: undefined };
  const contractOf = (read: SignInEndpoints): string => {
    built.body ??= JSON.stringify(servedSpec(COMMITTED_CONTRACT, read));
    return built.body;
  };
  return {
    handler: async (_request, reply): Promise<FastifyReply> => {
      const reading = await endpoints.current();
      if (reading.kind === 'read') {
        return reply
          .headers({
            ...security,
            'cache-control': NOT_STORED,
            'content-type': 'application/json; charset=utf-8',
          })
          .send(contractOf(reading.endpoints));
      }
      return reply
        .code(IDENTITY_PROVIDER_UNAVAILABLE.status)
        .headers({
          ...security,
          'cache-control': NOT_STORED,
          'content-type': 'application/problem+json',
          'retry-after': String(retryAfterSeconds(reading.retryInMilliseconds)),
        })
        .send(JSON.stringify(IDENTITY_PROVIDER_UNAVAILABLE));
    },
    method: 'GET',
    url: CONTRACT_PATH,
  };
};

const servedRoutes = (
  { apiDocsClient, clock, identityProviderIssuer }: ApiDocsSettings,
  eventLog: ApiDocsLog,
): readonly RouteOptions[] => {
  const folder = packageFolder();
  const page: Served = {
    body: API_DOCS_PAGE,
    cacheControl: NOT_STORED,
    contentType: HTML,
  };
  const served: Readonly<Record<string, Served>> = {
    [API_DOCS_PATH]: page,
    [`${API_DOCS_PATH}/`]: page,
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
  return [
    contractRoute(
      createIssuerEndpoints({ clock, identityProviderIssuer }, eventLog),
      security,
    ),
    ...Object.entries(served).map(
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
    ),
  ];
};

/**
 * Creates the routes of the API documentation page, which take no credential. While its client is
 * empty it creates none, and reads nothing from the identity provider, so every path under `/api-docs`
 * is answered as an unknown path is. While its client is set, `GET` and `HEAD` are answered at
 * `/api-docs` and `/api-docs/` with the page, at `/api-docs/openapi.json` with the served contract, at
 * `/api-docs/initializer.js` with the script starting Swagger UI, and at a fixed allow-list of paths
 * with the pinned Swagger UI package's own files, the redirect page and its script among them; any
 * other path is answered as an unknown path is. Every file is read, and the initializer built, once,
 * as the routes are created, and no part of a request's path ever reaches the filesystem.
 *
 * The served contract needs the identity provider's authorization and token endpoints, read from its
 * discovery document when the contract is first asked for, never as the routes are created; a request
 * arriving while they are read waits for that read. Once read they are held, and the contract built
 * from them is reused. While they cannot be read, within the cooldown after a failed read, the
 * contract is answered `503 identityProviderUnavailable` as problem details, with `Retry-After` naming
 * the whole seconds left in the cooldown, at least 1; every other route is answered as ever. Every
 * answer carries the content security policy, allowing connections to the issuer's origin, and
 * refuses framing, sniffing and referrers; the page, the redirect page, the contract, its refusal and
 * the initializer are never stored.
 *
 * @param settings the page's client, empty for no page, the clock, and the identity provider's issuer.
 * @param eventLog where a failed read of the identity provider's endpoints is written.
 * @throws when the package's files cannot be read.
 */
export const createApiDocsRoutes = (
  settings: ApiDocsSettings,
  eventLog: ApiDocsLog,
): readonly RouteOptions[] =>
  settings.apiDocsClient === '' ? [] : servedRoutes(settings, eventLog);
