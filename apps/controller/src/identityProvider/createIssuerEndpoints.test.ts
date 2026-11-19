import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import type { Clock } from '../configuration/index.js';
import type { LineFields } from '../eventLog/index.js';
import {
  createIssuerEndpoints,
  ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS,
  ISSUER_ENDPOINTS_UNAVAILABLE,
} from './createIssuerEndpoints.js';
import type {
  IssuerEndpoints,
  IssuerEndpointsFailure,
  IssuerEndpointsReading,
} from './types.js';

const DISCOVERY_PATH = '/realms/test/.well-known/openid-configuration';

interface Provider {
  /** Each path asked for, in order. */
  asked: string[];

  /** Members set over the discovery document's own, a member set to undefined left out. */
  departures: Readonly<Record<string, unknown>>;

  /** Settles once the provider is first asked for anything. */
  firstAsked: Promise<void>;

  /** Whether it hangs up on every request, answering nothing. */
  hangingUp: boolean;

  issuer: string;

  /** Whether it answers every request 503. */
  refusing: boolean;

  /** Lets every answer go, for a provider started holding them. */
  release(): void;
}

interface Line {
  fields: LineFields | undefined;
  message: string;
}

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

const isAddress = (address: unknown): address is AddressInfo =>
  typeof address === 'object' && address !== null && 'port' in address;

const discoveryDocument = (
  issuer: string,
  departures: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  issuer,
  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  ...departures,
});

const startProvider = async (
  context: TestContext,
  holding = false,
): Promise<Provider> => {
  const held = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<void>();
  const provider: Provider = {
    asked: [],
    departures: {},
    firstAsked: asked.promise,
    hangingUp: false,
    issuer: '',
    refusing: false,
    release: () => held.resolve(),
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    provider.asked.push(path);
    asked.resolve();
    const answer = (): void => {
      if (provider.hangingUp) {
        request.socket.destroy();
      } else if (provider.refusing) {
        response.writeHead(503);
        response.end();
      } else if (path === DISCOVERY_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            discoveryDocument(provider.issuer, provider.departures),
          ),
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
  provider.issuer = `http://127.0.0.1:${address.port}/realms/test`;
  return provider;
};

const endpointsFor = (
  provider: Provider,
  clock: Clock = controlledClock(),
  lines: Line[] = [],
): IssuerEndpoints =>
  createIssuerEndpoints(
    { clock, identityProviderIssuer: provider.issuer },
    {
      error: (message, fields) => {
        lines.push({ fields, message });
      },
    },
  );

const readOf = (provider: Provider): IssuerEndpointsReading => ({
  endpoints: {
    authorizationEndpoint: `${provider.issuer}/protocol/openid-connect/auth`,
    tokenEndpoint: `${provider.issuer}/protocol/openid-connect/token`,
  },
  kind: 'read',
});

const unavailableLine = (cause: IssuerEndpointsFailure): Line => ({
  fields: { cause },
  message: ISSUER_ENDPOINTS_UNAVAILABLE,
});

suite("the trusted issuer's sign-in endpoints", () => {
  test('asks the provider for nothing until they are first asked for', async (context) => {
    const provider = await startProvider(context);

    const endpoints = endpointsFor(provider);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const askedBefore = [...provider.asked];
    await endpoints.current();

    assert.deepEqual(askedBefore, []);
    assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
  });

  test('reads the authorization and token endpoints from the discovery document on the first ask', async (context) => {
    const provider = await startProvider(context);

    const reading = await endpointsFor(provider).current();

    assert.deepEqual(reading, readOf(provider));
    assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
  });

  test('shares one read among the asks made while it is in flight', async (context) => {
    const provider = await startProvider(context, true);
    const endpoints = endpointsFor(provider);

    const first = endpoints.current();
    await provider.firstAsked;
    const joining = [endpoints.current(), endpoints.current()];
    provider.release();
    const readings = await Promise.all([first, ...joining]);

    assert.deepEqual(readings, [
      readOf(provider),
      readOf(provider),
      readOf(provider),
    ]);
    assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
  });

  test('holds the endpoints once read, reading them never again however much time passes', async (context) => {
    const provider = await startProvider(context);
    const clock = controlledClock();
    const endpoints = endpointsFor(provider, clock);

    await endpoints.current();
    provider.refusing = true;
    clock.advance(365 * 24 * 60 * 60 * 1000);
    const later = await endpoints.current();

    assert.deepEqual(later, readOf(provider));
    assert.deepEqual(provider.asked, [DISCOVERY_PATH]);
  });

  test('answers unavailable at once within the cooldown after a failed read, with the milliseconds left on its clock, and reads again once the cooldown has passed', async (context) => {
    const provider = await startProvider(context);
    provider.refusing = true;
    const clock = controlledClock();
    const endpoints = endpointsFor(provider, clock);

    const failedRead = await endpoints.current();
    clock.advance(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS - 1);
    const withinCooldown = await endpoints.current();
    const askedWithinCooldown = provider.asked.length;
    provider.refusing = false;
    clock.advance(1);
    const onceAnswering = await endpoints.current();

    assert.equal(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS, 30_000);
    assert.deepEqual(failedRead, {
      kind: 'unavailable',
      retryInMilliseconds: ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS,
    });
    assert.deepEqual(withinCooldown, {
      kind: 'unavailable',
      retryInMilliseconds: 1,
    });
    assert.equal(askedWithinCooldown, 1);
    assert.deepEqual(onceAnswering, readOf(provider));
    assert.equal(provider.asked.length, 2);
  });
});

suite('writing a failed read of the sign-in endpoints', () => {
  test('writes one line at error for a failed read, naming its cause alone and never a URL or what the provider answered', async (context) => {
    const elsewhere = 'https://elsewhere.example.org/realms/test';
    const cases: readonly {
      cause: IssuerEndpointsFailure;
      departure: Partial<Provider>;
    }[] = [
      { cause: 'unreachable', departure: { hangingUp: true } },
      { cause: 'status', departure: { refusing: true } },
      {
        cause: 'discoveryIssuer',
        departure: { departures: { issuer: elsewhere } },
      },
      {
        cause: 'endpointLocation',
        departure: { departures: { authorization_endpoint: undefined } },
      },
      {
        cause: 'endpointLocation',
        departure: { departures: { token_endpoint: 42 } },
      },
      {
        cause: 'endpointLocation',
        departure: { departures: { token_endpoint: 'not a url' } },
      },
      {
        cause: 'endpointLocation',
        departure: {
          departures: {
            authorization_endpoint: 'http://auth.example.org/realms/test/auth',
          },
        },
      },
      {
        cause: 'endpointOrigin',
        departure: {
          departures: { authorization_endpoint: `${elsewhere}/auth` },
        },
      },
      {
        cause: 'endpointOrigin',
        departure: { departures: { token_endpoint: `${elsewhere}/token` } },
      },
    ];

    const written = await Promise.all(
      cases.map(async ({ departure }) => {
        const provider = Object.assign(await startProvider(context), departure);
        const lines: Line[] = [];
        const reading = await endpointsFor(
          provider,
          controlledClock(),
          lines,
        ).current();
        return { lines, reading };
      }),
    );

    assert.deepEqual(
      written.map(({ lines }) => lines),
      cases.map(({ cause }) => [unavailableLine(cause)]),
    );
    written.forEach(({ reading }) =>
      assert.deepEqual(reading, {
        kind: 'unavailable',
        retryInMilliseconds: ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS,
      }),
    );
  });

  test('writes one line for each read attempted, one for asks made at once, none within the cooldown and none for a read that succeeds', async (context) => {
    const provider = await startProvider(context);
    provider.refusing = true;
    const clock = controlledClock();
    const lines: Line[] = [];
    const endpoints = endpointsFor(provider, clock, lines);

    await Promise.all([1, 2, 3].map(() => endpoints.current()));
    await endpoints.current();
    const withinCooldown = [...lines];
    clock.advance(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS);
    await endpoints.current();
    provider.refusing = false;
    clock.advance(ENDPOINTS_RETRY_COOLDOWN_MILLISECONDS);
    const onceAnswering = await endpoints.current();

    assert.deepEqual(withinCooldown, [unavailableLine('status')]);
    assert.deepEqual(lines, [
      unavailableLine('status'),
      unavailableLine('status'),
    ]);
    assert.equal(onceAnswering.kind, 'read');
    assert.equal(provider.asked.length, 3);
  });
});
