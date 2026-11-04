import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CompactSign,
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';

import {
  type ManagementTokenConfiguration,
  mintManagementToken,
} from './admin.js';

/** An algorithm the stand-in signs access tokens with. */
export type SigningAlgorithm = 'ES256' | 'PS256' | 'RS256';

/**
 * How the stand-in answers its discovery document: the document; one naming its issuer with a
 * trailing slash; one naming another realm's issuer, `/realms/not-<realm>` on the same host and port,
 * which the stand-in never serves, given as {@link IdentityProvider.otherIssuer} (not `/realms/other`,
 * which {@link IdentityProvider.addRealm} may serve); one naming no issuer; malformed JSON; no answer;
 * or 500.
 */
export type DiscoveryAnswer =
  | 'document'
  | 'malformedJson'
  | 'namesIssuerWithTrailingSlash'
  | 'namesNoIssuer'
  | 'namesOtherIssuer'
  | 'neverAnswer'
  | 'serverError';

/** How the stand-in answers its JWKS: the key set; an empty one; malformed JSON; no answer; 404; or 500. */
export type JwksAnswer =
  | 'emptyKeySet'
  | 'keySet'
  | 'malformedJson'
  | 'neverAnswer'
  | 'notFound'
  | 'serverError';

/** What a token from another realm of the stand-in holds beyond its Keycloak-shaped defaults. */
export interface RealmMintOptions {
  /** Claims merged over the defaults; one set to `undefined` is left out. `iss` is always the realm's own. */
  claims?: Readonly<Record<string, unknown>>;

  /** Seconds from `iat` to `exp`: 300 by default. */
  lifetimeSeconds?: number;
}

/**
 * Another realm on the stand-in's host and port, with keys of its own: an issuer whose tokens are
 * signed normally, by its own key and naming itself, for the tests of tokens from another issuer.
 */
export interface IdentityProviderRealm {
  /** `http://127.0.0.1:<port>/realms/<realm>`. */
  issuer: string;

  jwksUri: string;

  /** Mints a Keycloak-shaped access token naming this realm as its issuer, signed by its own RS256 key. */
  mint(options?: RealmMintOptions): Promise<string>;

  /** The keys its JWKS publishes. */
  publishedKeys(): readonly JWK[];
}

/** One request the stand-in received. */
export interface IdentityProviderRequest {
  method: string;

  /** The request's path, without its query. */
  path: string;
}

/** What a minted access token holds beyond the stand-in's Keycloak-shaped defaults. */
export interface MintOptions {
  /** Claims merged over the defaults; a claim set to `undefined` is left out. */
  claims?: Readonly<Record<string, unknown>>;

  /** Protected header members merged over `alg`, `kid` and `typ`; one set to `undefined` is left out. */
  header?: Readonly<Record<string, unknown>>;

  /** The signing key, by `kid`, published or withdrawn; the active RS256 key by default. */
  kid?: string;

  /** Seconds from `iat` to `exp`: 300 by default, a Keycloak realm's access token lifespan. */
  lifetimeSeconds?: number;
}

/** An OpenID Connect provider standing in for a Keycloak realm, on loopback. */
export interface IdentityProvider {
  /** Listens on its port again after {@link IdentityProvider.refuseConnections}, settling once it listens. */
  acceptConnections(): Promise<void>;

  /**
   * Generates a signing key and publishes it in the JWKS. The active key stays as it is.
   *
   * @returns the new key's `kid`.
   */
  addKey(algorithm: SigningAlgorithm): Promise<string>;

  /**
   * Serves another realm on the same host and port, with a discovery document, a JWKS and an RS256
   * signing key of its own, and gives it.
   */
  addRealm(realm: string): Promise<IdentityProviderRealm>;

  /** Sets how the discovery document, the JWKS or both are answered from now on; one left out keeps its answer. */
  answerWith(answers: { discovery?: DiscoveryAnswer; jwks?: JwksAnswer }): void;

  /** The realm's issuer, `http://127.0.0.1:<port>/realms/<realm>`, as every token's `iss` carries it. */
  issuer: string;

  /** The JWKS URL the discovery document names. */
  jwksUri: string;

  /** Mints a Keycloak-shaped access token, signed by the active key unless another is named. */
  mint(options?: MintOptions): Promise<string>;

  /**
   * The issuer the `namesOtherIssuer` discovery answer names: `http://127.0.0.1:<port>/realms/not-<realm>`,
   * a realm on the same host and port that the stand-in never serves.
   */
  otherIssuer: string;

  /** The keys the JWKS publishes now, signing and encryption keys alike. */
  publishedKeys(): readonly JWK[];

  /** Refuses every connection, closing the listener while keeping its port for {@link IdentityProvider.acceptConnections}. */
  refuseConnections(): Promise<void>;

  /** Every request received, in order, with its path. */
  requests: readonly IdentityProviderRequest[];

  /**
   * Generates an RS256 key, publishes it, and makes it the active key. The key it replaces stays
   * published until withdrawn, as a passive key does in a Keycloak realm.
   *
   * @returns the new key's `kid`.
   */
  rotate(): Promise<string>;

  /** Settles once the stand-in has stopped, every connection closed, held ones included. */
  stop(): Promise<void>;

  /** Takes a key out of the JWKS. It can still sign, so a test can present a token under a withdrawn key. */
  withdraw(kid: string): void;
}

/** What the stand-in can be started with. */
export interface IdentityProviderOptions {
  /** The realm in the issuer's path: `usher-test` by default. */
  realm?: string;
}

type KeyAlgorithm = SigningAlgorithm | 'RSA-OAEP';

interface HeldKey {
  algorithm: KeyAlgorithm;
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  published: boolean;
  use: 'enc' | 'sig';
}

const LOOPBACK = '127.0.0.1';

const DEFAULT_LIFETIME_SECONDS = 300;

const DEFAULT_REALM_ROLES = ['offline_access', 'uma_authorization'];

const MALFORMED_JSON = '{"issuer": "http://127.0.0.1/realms/';

const keycloakClaims = (
  issuer: string,
  realm: string,
  lifetimeSeconds: number,
): Readonly<Record<string, unknown>> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    acr: '1',
    aud: ['arranger-test'],
    azp: 'portal-test',
    email: 'ana@example.org',
    email_verified: true,
    exp: issuedAt + lifetimeSeconds,
    iat: issuedAt,
    iss: issuer,
    jti: randomUUID(),
    preferred_username: 'ana@example.org',
    realm_access: {
      roles: [`default-roles-${realm}`, ...DEFAULT_REALM_ROLES],
    },
    scope: 'openid email profile',
    sid: randomUUID(),
    sub: '6f1c9e2a-4b7d-4e3a-8c5f-1a2b3c4d5e6f',
    typ: 'Bearer',
  };
};

const signed = (
  payload: Readonly<Record<string, unknown>>,
  key: HeldKey,
  header: Readonly<Record<string, unknown>> = {},
): Promise<string> =>
  new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({
      alg: key.algorithm,
      kid: key.kid,
      typ: 'JWT',
      ...header,
    })
    .sign(key.privateKey);

interface OtherRealm {
  discoveryPath: string;
  jwksPath: string;
  realm: IdentityProviderRealm;
}

const generateKey = async (algorithm: KeyAlgorithm): Promise<HeldKey> => {
  const { privateKey, publicKey } = await generateKeyPair(algorithm);
  const kid = randomBytes(24).toString('base64url');
  const use = algorithm === 'RSA-OAEP' ? 'enc' : 'sig';
  return {
    algorithm,
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), alg: algorithm, kid, use },
    published: true,
    use,
  };
};

const discoveryDocument = (
  issuer: string,
  jwksUri: string,
): Readonly<Record<string, unknown>> => ({
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  backchannel_logout_session_supported: true,
  backchannel_logout_supported: true,
  end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
  grant_types_supported: [
    'authorization_code',
    'client_credentials',
    'refresh_token',
  ],
  id_token_signing_alg_values_supported: ['ES256', 'PS256', 'RS256'],
  introspection_endpoint: `${issuer}/protocol/openid-connect/token/introspect`,
  issuer,
  jwks_uri: jwksUri,
  response_types_supported: ['code'],
  subject_types_supported: ['pairwise', 'public'],
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
});

const answerJson = (
  response: ServerResponse,
  status: number,
  body: string,
): void => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  response.end(body);
};

const listen = (
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const closed = (server: ReturnType<typeof createServer>): Promise<void> =>
  server.listening
    ? new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
    : Promise.resolve();

/**
 * Starts an OpenID Connect stand-in on loopback, over plain http as the loopback rule allows. It
 * serves a discovery document at `<issuer>/.well-known/openid-configuration` and a JWKS at the
 * discovery document's `jwks_uri`, holding an active RS256 signing key and an RSA-OAEP key published
 * with `use: enc`, as a Keycloak realm does. It mints Keycloak-shaped access tokens with jose, and
 * records every request.
 *
 * @param options the realm in the issuer's path.
 */
export const startIdentityProvider = async ({
  realm = 'usher-test',
}: IdentityProviderOptions = {}): Promise<IdentityProvider> => {
  const realmPath = `/realms/${realm}`;
  const discoveryPath = `${realmPath}/.well-known/openid-configuration`;
  const jwksPath = `${realmPath}/protocol/openid-connect/certs`;
  const [signingKey, encryptionKey] = await Promise.all([
    generateKey('RS256'),
    generateKey('RSA-OAEP'),
  ]);
  const state: {
    answers: { discovery: DiscoveryAnswer; jwks: JwksAnswer };
    keys: readonly HeldKey[];
    signingKid: string | undefined;
  } = {
    answers: { discovery: 'document', jwks: 'keySet' },
    keys: [signingKey, encryptionKey],
    signingKid: signingKey.kid,
  };
  const requests: IdentityProviderRequest[] = [];
  const publishedKeys = (): readonly JWK[] =>
    state.keys
      .filter(({ published }) => published)
      .map(({ publicJwk }) => publicJwk);

  const answerDiscovery = (response: ServerResponse): void => {
    const answers: Record<DiscoveryAnswer, () => void> = {
      document: () =>
        answerJson(
          response,
          200,
          JSON.stringify(discoveryDocument(issuer, jwksUri)),
        ),
      malformedJson: () => answerJson(response, 200, MALFORMED_JSON),
      namesIssuerWithTrailingSlash: () =>
        answerJson(
          response,
          200,
          JSON.stringify(discoveryDocument(`${issuer}/`, jwksUri)),
        ),
      namesNoIssuer: () =>
        answerJson(
          response,
          200,
          JSON.stringify({
            ...discoveryDocument(issuer, jwksUri),
            issuer: undefined,
          }),
        ),
      namesOtherIssuer: () =>
        answerJson(
          response,
          200,
          JSON.stringify(discoveryDocument(otherIssuer, jwksUri)),
        ),
      neverAnswer: () => undefined,
      serverError: () =>
        answerJson(response, 500, JSON.stringify({ error: 'unknown_error' })),
    };
    answers[state.answers.discovery]();
  };

  const answerJwks = (response: ServerResponse): void => {
    const answers: Record<JwksAnswer, () => void> = {
      emptyKeySet: () =>
        answerJson(response, 200, JSON.stringify({ keys: [] })),
      keySet: () =>
        answerJson(response, 200, JSON.stringify({ keys: publishedKeys() })),
      malformedJson: () => answerJson(response, 200, MALFORMED_JSON),
      neverAnswer: () => undefined,
      notFound: () =>
        answerJson(response, 404, JSON.stringify({ error: 'not_found' })),
      serverError: () =>
        answerJson(response, 500, JSON.stringify({ error: 'unknown_error' })),
    };
    answers[state.answers.jwks]();
  };

  const route = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', `http://${LOOPBACK}`).pathname;
    requests.push({ method: request.method ?? '', path });
    if (request.method === 'GET' && path === discoveryPath) {
      answerDiscovery(response);
      return;
    }
    if (request.method === 'GET' && path === jwksPath) {
      answerJwks(response);
      return;
    }
    const other = [...otherRealms.values()].find(
      (held) => held.discoveryPath === path || held.jwksPath === path,
    );
    if (request.method === 'GET' && other !== undefined) {
      answerJson(
        response,
        200,
        JSON.stringify(
          path === other.discoveryPath
            ? discoveryDocument(other.realm.issuer, other.realm.jwksUri)
            : { keys: other.realm.publishedKeys() },
        ),
      );
      return;
    }
    answerJson(response, 404, JSON.stringify({ error: 'not_found' }));
  };
  const otherRealms = new Map<string, OtherRealm>();

  const server = createServer(route);
  const port = await listen(server, 0);
  const issuer = `http://${LOOPBACK}:${port}${realmPath}`;
  const otherIssuer = `http://${LOOPBACK}:${port}/realms/not-${realm}`;
  const jwksUri = `http://${LOOPBACK}:${port}${jwksPath}`;

  const keyFor = (kid: string | undefined): HeldKey => {
    const key = state.keys.find((held) => held.kid === kid);
    if (key?.use === 'sig') {
      return key;
    }
    throw new Error('the identity provider holds no signing key by that kid');
  };

  return {
    acceptConnections: async () => {
      if (server.listening) {
        return;
      }
      await listen(server, port);
    },

    addKey: async (algorithm) => {
      const key = await generateKey(algorithm);
      state.keys = [...state.keys, key];
      return key.kid;
    },

    addRealm: async (otherName) => {
      const held = otherRealms.get(otherName);
      if (held !== undefined) {
        return held.realm;
      }
      const otherPath = `/realms/${otherName}`;
      const realmIssuer = `http://${LOOPBACK}:${port}${otherPath}`;
      const otherJwksPath = `${otherPath}/protocol/openid-connect/certs`;
      const otherKey = await generateKey('RS256');
      const added: OtherRealm = {
        discoveryPath: `${otherPath}/.well-known/openid-configuration`,
        jwksPath: otherJwksPath,
        realm: {
          issuer: realmIssuer,
          jwksUri: `http://${LOOPBACK}:${port}${otherJwksPath}`,
          mint: async ({
            claims = {},
            lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
          } = {}) => {
            if (Object.hasOwn(claims, 'iss')) {
              throw new Error(
                "a realm's tokens always name the realm's own issuer",
              );
            }
            return signed(
              {
                ...keycloakClaims(realmIssuer, otherName, lifetimeSeconds),
                ...claims,
              },
              otherKey,
            );
          },
          publishedKeys: () => [otherKey.publicJwk],
        },
      };
      otherRealms.set(otherName, added);
      return added.realm;
    },

    answerWith: ({ discovery, jwks }) => {
      state.answers = {
        discovery: discovery ?? state.answers.discovery,
        jwks: jwks ?? state.answers.jwks,
      };
    },

    issuer,
    jwksUri,

    mint: async ({
      claims = {},
      header = {},
      kid = state.signingKid,
      lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
    } = {}) => {
      const key = keyFor(kid);
      return signed(
        { ...keycloakClaims(issuer, realm, lifetimeSeconds), ...claims },
        key,
        header,
      );
    },

    otherIssuer,

    publishedKeys,

    refuseConnections: () => closed(server),

    requests,

    rotate: async () => {
      const key = await generateKey('RS256');
      state.keys = [...state.keys, key];
      state.signingKid = key.kid;
      return key.kid;
    },

    stop: () => closed(server),

    withdraw: (kid) => {
      state.keys = state.keys.map((held) =>
        held.kid === kid ? { ...held, published: false } : held,
      );
    },
  };
};

/**
 * The service account the stand-in mints client-credentials tokens for: its client, as Keycloak's
 * `lyric-svc` is in the default realm, and the invented subject Keycloak would give the client's
 * service-account user.
 */
export const SERVICE_ACCOUNT = Object.freeze({
  clientId: 'lyric-svc',
  subject: '3e8f1a52-7c4d-4b9e-a6f0-2d5c8b1e9a73',
});

/** Which service account a token is for, and anything over its claims. */
export interface ServiceAccountTokenOptions {
  /** The client: {@link SERVICE_ACCOUNT}'s by default. */
  clientId?: string;

  /** Claims and options over the token's. */
  mint?: MintOptions;

  /** The service-account user's subject: {@link SERVICE_ACCOUNT}'s by default. */
  subject?: string;
}

/**
 * Mints a service account's client-credentials token, signed by the stand-in's rightful key as every
 * token it mints is, shaped as Keycloak shapes one: `aud` the management API, `azp` and `client_id`
 * the client, `preferred_username` `service-account-` and the client, the realm's default roles, and
 * no address (#212 Q5). A configuration listing the client among its management clients reads it as
 * a credential rather than refusing it, and every Policy Management API operation then answers 403
 * `serviceAccountNotPermitted` before any lookup (ruled).
 *
 * @param provider the stand-in.
 * @param configuration the management audience and clients, and the administrator role.
 * @param options the client, the subject, and anything over the claims.
 */
export const mintServiceAccountToken = (
  provider: IdentityProvider,
  configuration: ManagementTokenConfiguration,
  {
    clientId = SERVICE_ACCOUNT.clientId,
    mint = {},
    subject = SERVICE_ACCOUNT.subject,
  }: ServiceAccountTokenOptions = {},
): Promise<string> =>
  mintManagementToken(
    provider,
    { ...configuration, managementClients: [clientId] },
    { email: '', subject },
    {
      mint: {
        ...mint,
        claims: {
          client_id: clientId,
          email: undefined,
          email_verified: undefined,
          preferred_username: `service-account-${clientId}`,
          ...mint.claims,
        },
      },
    },
  );
