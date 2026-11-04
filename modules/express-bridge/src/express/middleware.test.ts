import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test } from 'node:test';

import {
  CHALLENGE_ERRORS,
  readAccess,
  SUSPENDED_HEADER as SUSPENDED_HEADER_FROM_TYPES,
  SUSPENDED_VALUE,
  subjectToLog,
  type UsherRequestAccess,
} from '@overture-stack/usher-types';
import express from 'express';
import type { Express, Request, Response } from 'express-serve-static-core';
import express4 from 'express4';

import type { ResolveOutcome } from '../core/core.js';
import {
  ANSWERS,
  createUsherMiddleware,
  type CredentialRead,
  type LayerCore,
  RETRY_AFTER_SECONDS,
  SUSPENDED_HEADER,
} from './middleware.js';

interface Answer {
  body: string;
  headers: IncomingHttpHeaders;
  status: number | undefined;
}

/**
 * Sends one request with raw header lines, so a test can send two Authorization lines. A raw list
 * gets no default headers, so it names the host itself, which the server requires.
 */
const send = (
  port: number,
  path: string,
  headerLines: readonly string[] = [],
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: ['Host', `127.0.0.1:${port}`, ...headerLines],
        host: '127.0.0.1',
        method: 'GET',
        path,
        port,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
            status: incoming.statusCode,
          }),
        );
      },
    );
    outgoing.setTimeout(5_000, () =>
      outgoing.destroy(new Error('no answer within 5 s')),
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

/**
 * Runs the exchange against the app on a real server bound to 127.0.0.1, and always closes it, open
 * connections included, so a request left unanswered fails its test rather than holding the process.
 */
const answering = async <Result>(
  app: Express,
  exchange: (port: number) => Promise<Result>,
): Promise<Result> => {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await exchange((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
};

const accessFor = (subject: string | null): UsherRequestAccess => ({
  principal:
    subject === null
      ? { credential: 'none', openTierOnly: true, suspended: false }
      : {
          credential: 'confirmed',
          openTierOnly: false,
          subject,
          suspended: false,
        },
  results: { files: { kind: 'allow' } },
  version: 1,
});

/** A core resolving each credential to a scripted outcome, recording each credential and event. */
const scriptedCore = (
  outcomeFor: (credential: string | null) => Promise<ResolveOutcome>,
) => {
  const resolved: (string | null)[] = [];
  const reported: { data: unknown; name: string }[] = [];
  const core: LayerCore = {
    report: (name, data) => {
      reported.push({ data, name });
    },
    resolve: (credential) => {
      resolved.push(credential);
      return outcomeFor(credential);
    },
  };
  return { core, reported, resolved };
};

const granting = (credential: string | null): Promise<ResolveOutcome> =>
  Promise.resolve({ access: accessFor(credential), kind: 'access' });

/** Whether an action threw, as reassigning a non-writable member does in strict mode. */
const throws = (action: () => void): boolean => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const majors = [
  ['Express 4', () => express4()],
  ['Express 5', () => express()],
] as const;

for (const [major, createApp] of majors) {
  suite(`createUsherMiddleware on ${major}`, () => {
    const appWith = (
      core: LayerCore,
      options: Parameters<typeof createUsherMiddleware>[1] = {},
    ) => {
      const reached = { count: 0 };
      const app = createApp();
      app.use(createUsherMiddleware(core, options));
      app.get('/data', (_request, response) => {
        reached.count += 1;
        const access = readAccess(response.locals);
        response.json({
          frozen: Object.isFrozen(access) && Object.isFrozen(access.principal),
          mutated: throws(() => {
            (access.principal as { subject: string | null }).subject = 'other';
          }),
          replaced: throws(() => {
            (response.locals as Record<string, unknown>)['usher'] =
              accessFor('other');
          }),
          subject: subjectToLog(access.principal),
        });
      });
      return { app, reached };
    };

    test('attaches an anonymous request its access, frozen and not replaceable, and lets it through', async () => {
      const scripted = scriptedCore(granting);
      const { app, reached } = appWith(scripted.core);

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 200);
      assert.deepEqual(JSON.parse(answer.body), {
        frozen: true,
        mutated: true,
        replaced: true,
        subject: null,
      });
      assert.deepEqual(scripted.resolved, [null]);
      assert.equal(reached.count, 1);
    });

    test('marks every response it lets through private and no-store, varying on the credential source', async () => {
      const scripted = scriptedCore(granting);
      const { app } = appWith(scripted.core);

      const answer = await answering(app, (port) =>
        send(port, '/data', ['Authorization', 'Bearer token-ana']),
      );

      assert.equal(answer.headers['cache-control'], 'private, no-store');
      assert.match(String(answer.headers['vary']), /Authorization/u);
    });

    test('names the cookie in Vary when the host reads its credential from one', async () => {
      const scripted = scriptedCore(granting);
      const { app } = appWith(scripted.core, {
        extract: () => ({ credential: 'cookie-session', kind: 'credential' }),
        varyOn: 'Cookie',
      });

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.match(String(answer.headers['vary']), /Cookie/u);
      assert.deepEqual(scripted.resolved, ['cookie-session']);
    });

    suite('the values a client reads, from usher-types', () => {
      test('exports the suspended header usher-types defines, so a portal and the bridge name one header', () => {
        assert.equal(SUSPENDED_HEADER, SUSPENDED_HEADER_FROM_TYPES);
      });

      test("answers a suspended principal with the suspended header set to usher-types' value", async () => {
        const { app } = appWith(
          scriptedCore(() =>
            Promise.resolve({
              access: {
                ...accessFor(null),
                principal: {
                  credential: 'unconfirmed',
                  openTierOnly: true,
                  suspended: true,
                },
              },
              kind: 'access',
            }),
          ).core,
        );

        const answer = await answering(app, (port) =>
          send(port, '/data', ['Authorization', 'Bearer token-ana']),
        );

        assert.equal(
          answer.headers[SUSPENDED_HEADER_FROM_TYPES.toLowerCase()],
          SUSPENDED_VALUE,
        );
      });

      for (const [description, path, error] of [
        ['a refused credential', '/data', CHALLENGE_ERRORS.invalidToken],
        [
          'a credential sent in the address',
          '/data?access_token=token-ana',
          CHALLENGE_ERRORS.invalidRequest,
        ],
      ] as const) {
        test(`challenges ${description} with the error code usher-types names`, async () => {
          const { app } = appWith(
            scriptedCore(() => Promise.resolve({ kind: 'refused' })).core,
          );

          const answer = await answering(app, (port) =>
            send(port, path, ['Authorization', 'Bearer token-ana']),
          );

          assert.equal(
            answer.headers['www-authenticate'],
            `Bearer error="${error}"`,
          );
        });
      }
    });

    suite('marking a suspended principal', () => {
      const servedAs = (principal: UsherRequestAccess['principal']) =>
        scriptedCore(() =>
          Promise.resolve({
            access: { ...accessFor(null), principal },
            kind: 'access',
          }),
        );

      /** The header names exposed to a browser by a response, however many lines carry them. */
      const exposed = (headers: IncomingHttpHeaders): string[] =>
        String(headers['access-control-expose-headers'] ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);

      for (const [description, principal] of [
        [
          'unconfirmed',
          { credential: 'unconfirmed', openTierOnly: true, suspended: true },
        ],
        [
          'confirmed',
          {
            attributionOnlySubject: 'subject-ana',
            credential: 'confirmed',
            openTierOnly: true,
            suspended: true,
          },
        ],
      ] as const) {
        test(`sets Usher-Suspended: true, exposed to a browser, when a suspended principal's credential is ${description}`, async () => {
          const scripted = servedAs(principal);
          const { app } = appWith(scripted.core);

          const answer = await answering(app, (port) =>
            send(port, '/data', ['Authorization', 'Bearer token-ana']),
          );

          assert.equal(answer.status, 200);
          assert.equal(answer.headers['usher-suspended'], 'true');
          assert.deepEqual(exposed(answer.headers), [SUSPENDED_HEADER]);
        });
      }

      for (const [description, principal] of [
        [
          'an anonymous principal',
          { credential: 'none', openTierOnly: true, suspended: false },
        ],
        [
          'a confirmed principal',
          {
            credential: 'confirmed',
            openTierOnly: false,
            subject: 'subject-ana',
            suspended: false,
          },
        ],
      ] as const) {
        test(`sets no Usher-Suspended header for ${description}, and exposes none`, async () => {
          const { app } = appWith(servedAs(principal).core);

          const answer = await answering(app, (port) => send(port, '/data'));

          assert.equal(answer.status, 200);
          assert.equal(answer.headers['usher-suspended'], undefined);
          assert.deepEqual(exposed(answer.headers), []);
        });
      }

      test("keeps a value the host's CORS layer already exposes, beside Usher-Suspended", async () => {
        const reached = { count: 0 };
        const app = createApp();
        app.use((_request, response, next) => {
          response.set('Access-Control-Expose-Headers', 'Content-Range');
          next();
        });
        app.use(
          createUsherMiddleware(
            servedAs({
              credential: 'unconfirmed',
              openTierOnly: true,
              suspended: true,
            }).core,
          ),
        );
        app.get('/data', (_request, response) => {
          reached.count += 1;
          response.json({});
        });

        const answer = await answering(app, (port) => send(port, '/data'));

        assert.equal(reached.count, 1);
        assert.deepEqual(exposed(answer.headers), [
          'Content-Range',
          SUSPENDED_HEADER,
        ]);
      });
    });

    test('passes a bearer value of any characters to the exchange, with the scheme in any letter case', async () => {
      const scripted = scriptedCore(granting);
      const { app } = appWith(scripted.core);

      await answering(app, (port) =>
        send(port, '/data', ['Authorization', 'bEaReR not a b64token!']),
      );

      assert.deepEqual(scripted.resolved, ['not a b64token!']);
    });

    for (const [description, path, headerLines, reason] of [
      [
        'two Authorization lines',
        '/data',
        ['Authorization', 'Bearer a', 'Authorization', 'Bearer b'],
        'multiple',
      ],
      [
        'a scheme other than Bearer',
        '/data',
        ['Authorization', 'Basic YW5hOnNlY3JldA=='],
        'scheme',
      ],
      [
        'a Bearer scheme with no value',
        '/data',
        ['Authorization', 'Bearer'],
        'scheme',
      ],
      [
        'an access_token query parameter',
        '/data?access_token=token-ana',
        ['Authorization', 'Bearer token-ana'],
        'query',
      ],
      [
        'an access_token query parameter on a target that is no valid URL',
        '//[?access_token=token-ana',
        ['Authorization', 'Bearer token-ana'],
        'query',
      ],
    ] as const) {
      test(`answers 400 to ${description}, never exchanging it or serving it as anonymous`, async () => {
        const scripted = scriptedCore(granting);
        const { app, reached } = appWith(scripted.core);

        const answer = await answering(app, (port) =>
          send(port, path, headerLines),
        );

        assert.equal(answer.status, 400);
        assert.equal(
          answer.headers['www-authenticate'],
          'Bearer error="invalid_request"',
        );
        assert.equal(answer.body, ANSWERS.invalidRequest);
        assert.deepEqual(scripted.resolved, []);
        assert.equal(reached.count, 0);
        assert.deepEqual(scripted.reported, [
          { data: { reason }, name: 'credential.malformed' },
        ]);
      });
    }

    test('resolves the credential of a request whose target is refused by the URL parser, and passes it on', async () => {
      const scripted = scriptedCore(granting);
      const { app } = appWith(scripted.core);

      const answer = await answering(app, (port) =>
        send(port, '//[', ['Authorization', 'Bearer token-ana']),
      );

      assert.equal(answer.status, 404);
      assert.deepEqual(scripted.resolved, ['token-ana']);
    });

    test('answers a refused identity its one 401, with the fixed text, before anything downstream runs', async () => {
      const scripted = scriptedCore(() => Promise.resolve({ kind: 'refused' }));
      const { app, reached } = appWith(scripted.core);

      const answer = await answering(app, (port) =>
        send(port, '/data', ['Authorization', 'Bearer token-revoked']),
      );

      assert.equal(answer.status, 401);
      assert.equal(
        answer.headers['www-authenticate'],
        'Bearer error="invalid_token"',
      );
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.body, ANSWERS.refused);
      assert.equal(reached.count, 0);
    });

    test('tells a refused identity how to recover, in the words Stage uses for the open data', () => {
      const text = ANSWERS.refused;

      assert.equal(
        text,
        'Sign in again for a new token, or leave the token out to get the data available to everyone.',
      );
    });

    test("exposes WWW-Authenticate to a browser on its 401 and its 400, beside what the host's CORS layer exposes", async () => {
      const scripted = scriptedCore(() => Promise.resolve({ kind: 'refused' }));
      const app = createApp();
      app.use((_request, response, next) => {
        response.set('Access-Control-Expose-Headers', 'Content-Range');
        next();
      });
      app.use(createUsherMiddleware(scripted.core));
      const exposedBy = (headers: IncomingHttpHeaders): string[] =>
        String(headers['access-control-expose-headers'] ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);

      const refused = await answering(app, (port) =>
        send(port, '/data', ['Authorization', 'Bearer token-revoked']),
      );
      const malformed = await answering(app, (port) =>
        send(port, '/data', ['Authorization', 'Basic YW5hOnNlY3JldA==']),
      );

      assert.equal(refused.status, 401);
      assert.deepEqual(exposedBy(refused.headers), [
        'Content-Range',
        'WWW-Authenticate',
      ]);
      assert.equal(malformed.status, 400);
      assert.deepEqual(exposedBy(malformed.headers), [
        'Content-Range',
        'WWW-Authenticate',
      ]);
    });

    test('answers 503 with Retry-After when access cannot be confirmed, before anything downstream runs', async () => {
      const scripted = scriptedCore(() =>
        Promise.resolve({ kind: 'unavailable' }),
      );
      const { app, reached } = appWith(scripted.core);

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 503);
      assert.equal(answer.headers['retry-after'], String(RETRY_AFTER_SECONDS));
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.body, ANSWERS.unavailable);
      assert.equal(reached.count, 0);
    });

    test('keeps two concurrent principals apart, each request seeing only its own access', async () => {
      const scripted = scriptedCore(
        (credential) =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ access: accessFor(credential), kind: 'access' }),
              credential === 'token-ana' ? 20 : 5,
            );
          }),
      );
      const { app } = appWith(scripted.core);

      const [forAna, forBen] = await answering(app, (port) =>
        Promise.all([
          send(port, '/data', ['Authorization', 'Bearer token-ana']),
          send(port, '/data', ['Authorization', 'Bearer token-ben']),
        ]),
      );

      assert.equal(JSON.parse(forAna.body).subject, 'token-ana');
      assert.equal(JSON.parse(forBen.body).subject, 'token-ben');
    });

    test('answers 503 when the core fails, logging only the stage, never what the error said', async () => {
      const scripted = scriptedCore(() =>
        Promise.reject(new Error('payload for subject-ana could not be read')),
      );
      const { app, reached } = appWith(scripted.core);

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 503);
      assert.equal(answer.body.includes('subject-ana'), false);
      assert.deepEqual(scripted.reported, [
        { data: { stage: 'resolve' }, name: 'bridge.internalError' },
      ]);
      assert.equal(reached.count, 0);
    });

    test("answers 503 when the host's extract throws synchronously, logging the stage", async () => {
      const scripted = scriptedCore(granting);
      const { app, reached } = appWith(scripted.core, {
        extract: () => {
          throw new Error('cookie for subject-ana unreadable');
        },
      });

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 503);
      assert.deepEqual(scripted.reported, [
        { data: { stage: 'extract' }, name: 'bridge.internalError' },
      ]);
      assert.equal(reached.count, 0);
    });

    test('answers 503 when the access cannot be attached, before anything downstream runs', async () => {
      const scripted = scriptedCore(() =>
        Promise.resolve({
          access: { ...accessFor(null), version: 2 } as never,
          kind: 'access',
        }),
      );
      const { app, reached } = appWith(scripted.core);

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 503);
      assert.deepEqual(scripted.reported, [
        { data: { stage: 'attach' }, name: 'bridge.internalError' },
      ]);
      assert.equal(reached.count, 0);
    });

    test('answers 503 when letting the request through throws, logging the stage', async () => {
      const scripted = scriptedCore(granting);
      const reached = { count: 0 };
      const usher = createUsherMiddleware(scripted.core);
      const app = createApp();
      app.use((request, response) => {
        usher(request, response, () => {
          throw new Error('a defect past the layer, reading subject-ana');
        });
      });
      app.get('/data', (_request, response) => {
        reached.count += 1;
        response.json({});
      });

      const answer = await answering(app, (port) => send(port, '/data'));

      assert.equal(answer.status, 503);
      assert.equal(answer.body, ANSWERS.unavailable);
      assert.deepEqual(scripted.reported, [
        { data: { stage: 'attach' }, name: 'bridge.internalError' },
      ]);
      assert.equal(reached.count, 0);
    });
  });
}

suite('createUsherMiddleware, when answering throws', () => {
  test('tries the 503 once settling throws, and handles every throw while answering', async () => {
    const rejections: unknown[] = [];
    const recordRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    const statuses: number[] = [];
    /** A response whose every answer throws, as one already torn down by the host might. */
    const response = {
      headersSent: false,
      status: (status: number) => {
        statuses.push(status);
        throw new Error('a defect in the response');
      },
    } as unknown as Response;
    const scripted = scriptedCore(() => Promise.resolve({ kind: 'refused' }));
    const usher = createUsherMiddleware(scripted.core, {
      extract: () => ({ kind: 'anonymous' }),
    });

    process.on('unhandledRejection', recordRejection);
    try {
      usher({} as Request, response, () => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', recordRejection);
    }

    assert.deepEqual(statuses, [401, 503]);
    assert.deepEqual(rejections, []);
    assert.deepEqual(scripted.reported, [
      { data: { stage: 'attach' }, name: 'bridge.internalError' },
    ]);
  });

  for (const [description, extract, triedStatuses, reported] of [
    [
      "the host's extract throws",
      (): CredentialRead => {
        throw new Error('cookie for subject-ana unreadable');
      },
      [503],
      [{ data: { stage: 'extract' }, name: 'bridge.internalError' }],
    ],
    [
      'answering a malformed credential throws',
      (): CredentialRead => ({ kind: 'malformed', reason: 'scheme' }),
      [400, 503],
      [
        { data: { reason: 'scheme' }, name: 'credential.malformed' },
        { data: { stage: 'extract' }, name: 'bridge.internalError' },
      ],
    ],
  ] as const) {
    test(`tries the 503 once ${description}, and keeps every throw while answering within the layer`, () => {
      const statuses: number[] = [];
      /** A response whose every answer throws, as one already torn down by the host might. */
      const response = {
        headersSent: false,
        status: (status: number) => {
          statuses.push(status);
          throw new Error('a defect in the response');
        },
      } as unknown as Response;
      const passedToNext: unknown[] = [];
      const scripted = scriptedCore(granting);
      const usher = createUsherMiddleware(scripted.core, { extract });

      const escaped = throws(() =>
        usher({} as Request, response, (error?: unknown) => {
          passedToNext.push(error);
        }),
      );

      assert.equal(escaped, false);
      assert.deepEqual(statuses, triedStatuses);
      assert.deepEqual(passedToNext, []);
      assert.deepEqual(scripted.reported, reported);
      assert.deepEqual(scripted.resolved, []);
    });
  }
});

/**
 * Compiled, never run: holds `res.locals.usher` to `unknown` and read-only under the type checker,
 * so the access is read only through `readAccess`. Each directive fails the type check if the line
 * beneath it compiles.
 */
export const typedLocals = (response: Response): unknown => {
  // @ts-expect-error a direct read of the access is unknown, not the access value
  const subject: string = response.locals.usher.principal.subject;
  // @ts-expect-error the access member is read-only
  response.locals.usher = { version: 1 };
  return subject;
};
