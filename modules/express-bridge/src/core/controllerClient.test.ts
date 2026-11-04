import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test } from 'node:test';

import { createFetchControllerClient } from './controllerClient.js';
import type { ExchangeAnswer } from './core.js';

interface Received {
  body: string;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  url: string | undefined;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** Runs the exchange against a scripted controller on 127.0.0.1, recording what it received. */
const exchangingWith = async (
  handler: Handler,
  run: (controllerUrl: URL, received: Received[]) => Promise<ExchangeAnswer>,
): Promise<{ answer: ExchangeAnswer; received: Received[] }> => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
        method: request.method,
        url: request.url,
      });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const answer = await run(
      new URL(`http://127.0.0.1:${port}/api/`),
      received,
    );
    return { answer, received };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
};

const clientFor = (controllerUrl: URL, responseCapBytes = 1_048_576) =>
  createFetchControllerClient({
    assertion: () => Promise.resolve('assertion-token'),
    controllerUrl,
    payloadVersions: [1],
    responseCapBytes,
  });

const answering =
  (status: number, body = '', headers: Record<string, string> = {}): Handler =>
  (_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  };

const exchange = (
  handler: Handler,
  credential: string | null = 'sign-in-token',
  responseCapBytes?: number,
) =>
  exchangingWith(handler, (controllerUrl) =>
    clientFor(controllerUrl, responseCapBytes).exchange({
      credential,
      signal: AbortSignal.timeout(5_000),
    }),
  );

suite('createFetchControllerClient', () => {
  test('posts the credential and the payload versions to exchange under the base path, with the assertion as Bearer', async () => {
    const { received } = await exchange(
      answering(200, 'eyJ.token', { 'Content-Type': 'application/jwt' }),
    );

    assert.deepEqual(
      received.map(({ body, headers, method, url }) => ({
        accept: headers['accept'],
        authorization: headers['authorization'],
        body: JSON.parse(body),
        contentType: headers['content-type'],
        method,
        url,
      })),
      [
        {
          accept: 'application/jwt',
          authorization: 'Bearer assertion-token',
          body: { credential: 'sign-in-token', payloadVersions: [1] },
          contentType: 'application/json',
          method: 'POST',
          url: '/api/exchange',
        },
      ],
    );
  });

  test('sends no credential member for the anonymous exchange', async () => {
    const { received } = await exchange(answering(200, 'eyJ.token'), null);

    assert.deepEqual(JSON.parse(received[0]?.body ?? '{}'), {
      payloadVersions: [1],
    });
  });

  test('returns the token a 200 carries', async () => {
    const { answer } = await exchange(
      answering(200, 'eyJ.a.b.c.d\n', { 'Content-Type': 'application/jwt' }),
    );

    assert.deepEqual(answer, { kind: 'token', token: 'eyJ.a.b.c.d' });
  });

  for (const [status, expected] of [
    [403, { kind: 'refused' }],
    [401, { cause: 'assertionRefused', kind: 'unavailable' }],
    [408, { cause: 'status', kind: 'failed' }],
    [500, { cause: 'status', kind: 'failed' }],
    [503, { cause: 'status', kind: 'failed' }],
    [429, { cause: 'status', kind: 'unavailable' }],
    [404, { cause: 'status', kind: 'unavailable' }],
    [204, { cause: 'status', kind: 'unavailable' }],
  ] as const) {
    test(`reads a ${status} as ${JSON.stringify(expected)}`, async () => {
      const { answer } = await exchange(answering(status));

      assert.deepEqual(answer, expected);
    });
  }

  test('reads a refusal by its status even when discarding its body fails', async () => {
    const client = createFetchControllerClient({
      assertion: () => Promise.resolve('assertion-token'),
      controllerUrl: new URL('http://controller.invalid/'),
      fetch: () =>
        Promise.resolve({
          body: new ReadableStream<Uint8Array>({
            cancel: () => {
              throw new Error('a body that fails to cancel');
            },
          }),
          headers: { get: () => null },
          status: 403,
        }),
      payloadVersions: [1],
      responseCapBytes: 1_048_576,
    });

    const answer = await client.exchange({
      credential: 'sign-in-token',
      signal: AbortSignal.timeout(5_000),
    });

    assert.deepEqual(answer, { kind: 'refused' });
  });

  test('reads no further than the cap, whether the length is declared or streamed', async () => {
    const declared = await exchange(
      answering(200, 'x'.repeat(2_000)),
      'token',
      1_000,
    );
    const streamed = await exchange(
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/jwt' });
        response.write('x'.repeat(600));
        response.end('x'.repeat(600));
      },
      'token',
      1_000,
    );

    assert.deepEqual(
      [declared.answer, streamed.answer],
      [
        { kind: 'unreadable', reason: 'tokenTooLarge' },
        { kind: 'unreadable', reason: 'tokenTooLarge' },
      ],
    );
  });

  test('reads an answer exactly at the cap', async () => {
    const { answer } = await exchange(
      answering(200, 'x'.repeat(1_000)),
      'token',
      1_000,
    );

    assert.deepEqual(answer, { kind: 'token', token: 'x'.repeat(1_000) });
  });

  test('reads an exchange aborted by its signal as a timeout', async () => {
    const { answer } = await exchangingWith(
      () => undefined,
      (controllerUrl) =>
        clientFor(controllerUrl).exchange({
          credential: 'token',
          signal: AbortSignal.timeout(50),
        }),
    );

    assert.deepEqual(answer, { cause: 'timeout', kind: 'failed' });
  });

  test('reads a refused connection as a network failure', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      closed.close(() => resolve());
    });

    const answer = await clientFor(
      new URL(`http://127.0.0.1:${port}/`),
    ).exchange({
      credential: 'token',
      signal: AbortSignal.timeout(5_000),
    });

    assert.deepEqual(answer, { cause: 'network', kind: 'failed' });
  });

  test('follows no redirect, reading one as a network failure', async () => {
    const { answer, received } = await exchange(
      answering(307, '', { Location: '/api/elsewhere' }),
    );

    assert.deepEqual(answer, { cause: 'network', kind: 'failed' });
    assert.equal(received.length, 1);
  });
});
