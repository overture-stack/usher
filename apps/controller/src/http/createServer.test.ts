import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createServer, HEALTH_PATHS } from './createServer.js';

suite("the controller's health endpoints", () => {
  test('answers liveness 200 with nothing in the body while the controller is live, whether or not it can serve', async (context) => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => false,
      trustedProxies: [],
    });
    context.after(() => server.close());

    const answer = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.liveness,
    });

    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body, '');
  });

  test('answers liveness 503 with nothing in the body once the controller is not live, even while it can serve, asking at each request', async (context) => {
    const state = { live: true };
    const server = createServer({
      isLive: () => state.live,
      isReady: async () => true,
      trustedProxies: [],
    });
    context.after(() => server.close());

    const live = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.liveness,
    });
    state.live = false;
    const notLive = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.liveness,
    });

    assert.deepEqual(
      [live, notLive].map(({ body, statusCode }) => ({ body, statusCode })),
      [
        { body: '', statusCode: 200 },
        { body: '', statusCode: 503 },
      ],
    );
  });

  test('answers readiness 200 while the controller can serve and 503 while it cannot, asking at each request, with nothing in either body', async (context) => {
    const state = { ready: true };
    const server = createServer({
      isLive: () => true,
      isReady: async () => state.ready,
      trustedProxies: [],
    });
    context.after(() => server.close());

    const ready = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.readiness,
    });
    state.ready = false;
    const unready = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.readiness,
    });

    assert.deepEqual(
      [ready, unready].map(({ body, statusCode }) => ({ body, statusCode })),
      [
        { body: '', statusCode: 200 },
        { body: '', statusCode: 503 },
      ],
    );
  });

  test('answers a path it does not serve 404 with nothing in the body, repeating nothing the request sent', async (context) => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => true,
      trustedProxies: [],
    });
    context.after(() => server.close());

    const answer = await server.inject({
      method: 'GET',
      url: '/admin/unknown?token=sent-by-the-caller',
    });

    assert.equal(answer.statusCode, 404);
    assert.equal(answer.body, '');
  });

  test('answers a path that cannot be decoded 400 in problem details naming the rule, repeating nothing of the path', async (context) => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => true,
      trustedProxies: [],
    });
    context.after(() => server.close());

    const answer = await server.inject({
      method: 'GET',
      url: '/admin/applications/sent-%E0%A4%A',
    });

    assert.equal(answer.statusCode, 400);
    assert.match(
      String(answer.headers['content-type']),
      /^application\/problem\+json(?:;|$)/u,
    );
    assert.equal(JSON.parse(answer.body).code, 'unreadablePath');
    assert.equal(answer.body.includes('sent-'), false);
  });

  test('routes a path parameter far longer than an identifier, percent-encoded, to its route whole', async (context) => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => true,
      trustedProxies: [],
    });
    context.after(() => server.close());
    server.get('/admin/resources/:externalId', async (request) => ({
      length: Reflect.get(Object(request.params), 'externalId').length,
    }));
    const externalId = 'é'.repeat(1000);

    const answer = await server.inject({
      method: 'GET',
      url: `/admin/resources/${encodeURIComponent(externalId)}`,
    });

    assert.equal(answer.statusCode, 200);
    assert.deepEqual(JSON.parse(answer.body), { length: 1000 });
  });
});

suite("the controller's requests", () => {
  const addressOf = async (
    trustedProxies: readonly string[],
    forwarded: string,
    peer = '127.0.0.1',
  ): Promise<string> => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => true,
      trustedProxies,
    });
    server.get('/address', async (request) => request.ip);
    try {
      const answer = await server.inject({
        headers: { 'x-forwarded-for': forwarded },
        method: 'GET',
        remoteAddress: peer,
        url: '/address',
      });
      return answer.body;
    } finally {
      await server.close();
    }
  };

  test("take the peer's address whatever an X-Forwarded-For names, with no trusted proxy", async () => {
    assert.equal(await addressOf([], '203.0.113.7'), '127.0.0.1');
  });

  test('take the nearest address their trusted proxies did not add', async () => {
    assert.equal(
      await addressOf(['127.0.0.1'], '198.51.100.4, 203.0.113.7'),
      '203.0.113.7',
    );
    assert.equal(
      await addressOf(
        ['127.0.0.1', '203.0.113.7'],
        '198.51.100.4, 203.0.113.7',
      ),
      '198.51.100.4',
    );
  });

  // What the configuration's refusal of such a range guards against, as the server's proxy matching
  // does it.
  test('take every IPv4 peer for a proxy under an IPv6 range holding every IPv4 address in its IPv6 form, and only those within one holding part', async () => {
    const seen = await Promise.all([
      addressOf(['::ffff:0:0/96'], '6.6.6.6', '198.51.100.9'),
      addressOf(['::ffff:0:0/96'], '6.6.6.6', '::ffff:198.51.100.9'),
      addressOf(['::ffff:10.0.0.0/104'], '6.6.6.6', '198.51.100.9'),
      addressOf(['::ffff:10.0.0.0/104'], '6.6.6.6', '10.1.2.3'),
    ]);

    assert.deepEqual(seen, ['6.6.6.6', '6.6.6.6', '198.51.100.9', '6.6.6.6']);
  });

  test('take a proxy within a trusted CIDR range as trusted, and one outside it as the client', async () => {
    assert.equal(
      await addressOf(
        ['127.0.0.0/8', '203.0.113.0/24'],
        '198.51.100.4, 203.0.113.7',
      ),
      '198.51.100.4',
    );
    assert.equal(
      await addressOf(
        ['127.0.0.0/8', '203.0.112.0/24'],
        '198.51.100.4, 203.0.113.7',
      ),
      '203.0.113.7',
    );
  });

  test('reach a route with their body as bytes, whatever its media type', async (context) => {
    const server = createServer({
      isLive: () => true,
      isReady: async () => true,
      trustedProxies: [],
    });
    server.post('/body', async (request) =>
      request.body instanceof Uint8Array ? request.body.length : 'none',
    );
    context.after(() => server.close());

    const answers = await Promise.all(
      ['application/json', 'text/plain', undefined].map((contentType) =>
        server.inject({
          headers:
            contentType === undefined ? {} : { 'content-type': contentType },
          method: 'POST',
          payload: '{"a":1}',
          url: '/body',
        }),
      ),
    );

    assert.deepEqual(
      answers.map(({ body }) => body),
      ['7', '7', '7'],
    );
  });
});
