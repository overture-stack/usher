import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createServer, HEALTH_PATHS } from './createServer.js';

suite("the controller's health endpoints", () => {
  test('answers liveness 200 with nothing in the body, whether or not the controller can serve', async (context) => {
    const server = createServer({ isReady: () => false });
    context.after(() => server.close());

    const answer = await server.inject({
      method: 'GET',
      url: HEALTH_PATHS.liveness,
    });

    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body, '');
  });

  test('answers readiness 200 while the controller can serve and 503 while it cannot, asking at each request, with nothing in either body', async (context) => {
    const state = { ready: true };
    const server = createServer({ isReady: () => state.ready });
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
    const server = createServer({ isReady: () => true });
    context.after(() => server.close());

    const answer = await server.inject({
      method: 'GET',
      url: '/admin/unknown?token=sent-by-the-caller',
    });

    assert.equal(answer.statusCode, 404);
    assert.equal(answer.body, '');
  });
});
