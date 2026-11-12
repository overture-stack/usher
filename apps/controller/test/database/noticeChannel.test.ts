import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import {
  assertSucceeded,
  revokeApplicationKey,
} from '../../test-support/admin.js';
import { auditRows } from '../../test-support/auditEvents.js';
import { poll, pollAll } from '../../test-support/channel.js';
import { freshAssertion } from '../../test-support/exchange.js';
import {
  administratorCaller,
  AUDIENCES,
  collectStream,
  describeNotice,
  headCursors,
  pastTheFloor,
  rawStreamFrom,
  RESOURCES,
  SHORT_RETENTION,
  signedAssertion,
  startChannelHarness,
  tagOfSubject,
  trimNotices,
  untilNoticesOlderThan,
} from '../../test-support/fixtures/channel.js';
import {
  type Harness,
  retentionFloorSeconds,
} from '../../test-support/harness.js';
import {
  insertNotices,
  noticePositions,
  simulateRestore,
} from '../../test-support/policy.js';
import {
  cleanupFor,
  eventually,
  nowSeconds,
} from '../../test-support/waiting.js';

const { portal, search, submission } = AUDIENCES;

const WAIT_MS = 10_000;

/** How often the controller reads the stream with no wake-up, in the harness's configuration. */
const REREAD_MS = 2_000;

const SCHEDULING_SLACK_MS = 1_500;

/** The connections the controller's store pool holds at most: the driver's default. */
const POOL_CONNECTIONS = 10;

const SUBJECT = 'subject-of-a-notice-written-directly';

/**
 * Writes baseline notices straight into the stream and gives the cursors the search audience reads
 * for them, with their positions, in order.
 */
const writtenBaselines = async (
  harness: Harness,
  count: number,
  createdAt?: Date,
): Promise<{ cursors: readonly string[]; positions: readonly bigint[] }> => {
  const application = harness.application(search);
  const before = (await headCursors(harness))[search] ?? '';
  await insertNotices(
    harness.clients.migration,
    Array.from({ length: count }, () => ({
      kind: 'baseline' as const,
      ...(createdAt === undefined ? {} : { createdAt }),
    })),
  );
  const { notices } = await pollAll(harness.url, {
    after: before,
    application,
  });
  return {
    cursors: notices.map(({ cursor }) => cursor),
    positions: (await noticePositions(harness.clients.migration)).slice(-count),
  };
};

const reasonOf = (data: unknown): string =>
  typeof data === 'object' && data !== null && 'reason' in data
    ? String(data.reason)
    : '';

const statusesFrom = async (
  harness: Harness,
  cursor: string,
  scope: ReturnType<typeof cleanupFor>,
): Promise<{ poll: number; push: number }> => {
  const application = harness.application(search);
  const polled = await poll(harness.url, { after: cursor, application });
  const pushed = await rawStreamFrom(scope, harness.url, {
    application,
    lastEventId: cursor,
  });
  return { poll: polled.status, push: pushed.status };
};

suite('the revocation channel, against the store', () => {
  test('answers each audience with the notices it receives after a cursor, in position order, on the poll and the push alike', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const cursors = await headCursors(harness);
    const stream = await collectStream(scope, harness.url, {
      application: harness.application(search),
      lastEventId: cursors[search] ?? null,
    });

    await insertNotices(harness.clients.migration, [
      { kind: 'category', resourceExternalId: RESOURCES.a1 },
      { kind: 'category', resourceExternalId: RESOURCES.c3 },
      { kind: 'category', resourceExternalId: RESOURCES.d4 },
      { audience: harness.application(search).id, kind: 'servedResources' },
      { kind: 'principal', subject: SUBJECT },
      { kind: 'baseline' },
      { kind: 'global' },
    ]);
    const polled = Object.fromEntries(
      await Promise.all(
        [portal, search, submission].map(async (audience) => {
          const { notices } = await pollAll(harness.url, {
            after: cursors[audience] ?? '',
            application: harness.application(audience),
          });
          return [audience, notices.map(describeNotice)] as const;
        }),
      ),
    );
    const pushed = await stream.waitFor(
      (notices) => notices.length >= 5,
      WAIT_MS,
    );

    const tag = async (audience: string): Promise<string> =>
      `principal ${await tagOfSubject(harness.application(audience), SUBJECT)}`;
    assert.deepEqual(polled, {
      [portal]: [await tag(portal), 'baseline', 'global'],
      [search]: [
        `category ${RESOURCES.a1}`,
        'servedResources',
        await tag(search),
        'baseline',
        'global',
      ],
      [submission]: [
        `category ${RESOURCES.c3}`,
        await tag(submission),
        'baseline',
        'global',
      ],
    });
    assert.deepEqual(pushed.map(describeNotice), polled[search]);
  });

  test('pushes a notice another writer committed to an open stream within the reread interval', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const cursors = await headCursors(harness);
    const stream = await collectStream(scope, harness.url, {
      application: harness.application(portal),
      lastEventId: cursors[portal] ?? null,
    });
    await stream.drain();

    await insertNotices(harness.clients.migration, [{ kind: 'global' }]);
    const committedAt = performance.now();
    await stream.waitFor((notices) => notices.length >= 1, WAIT_MS);

    const [arrival] = stream.notices();
    assert.equal(arrival?.notice.kind, 'global');
    assert.ok(
      (arrival?.arrivedAt ?? Infinity) - committedAt <=
        REREAD_MS + SCHEDULING_SLACK_MS,
      'the notice arrived later than the reread interval allows',
    );
  });

  test("answers polls while more streams are open than the store's pool holds connections", async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const application = harness.application(search);
    const cursors = await headCursors(harness);

    const streams = await Promise.all(
      Array.from({ length: POOL_CONNECTIONS + 2 }, () =>
        rawStreamFrom(scope, harness.url, {
          application,
          lastEventId: cursors[search] ?? '',
        }),
      ),
    );
    await eventually(
      async () => streams.every((stream) => stream.chunks().length > 0),
      WAIT_MS,
      20,
    );
    const startedAt = performance.now();
    const answers = await Promise.all([
      poll(harness.url, { application }),
      poll(harness.url, { after: cursors[search] ?? '', application }),
    ]);

    streams.forEach((stream) => {
      assert.equal(stream.status, 200);
    });
    answers.forEach(({ answer, status }) => {
      assert.equal(status, 200);
      assert.equal(answer?.kind, 'answer');
    });
    assert.ok(performance.now() - startedAt < 1_000);
  });

  test('ends every stream it holds when the controller stops', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const cursors = await headCursors(harness);
    const streams = await Promise.all(
      [portal, search].map((audience) =>
        rawStreamFrom(scope, harness.url, {
          application: harness.application(audience),
          lastEventId: cursors[audience] ?? '',
        }),
      ),
    );

    const stoppedAt = performance.now();
    await harness.stopController();
    const endedAt = await Promise.all(streams.map(({ ended }) => ended));

    streams.forEach((stream) => {
      assert.equal(stream.status, 200);
    });
    endedAt.forEach((at) => {
      assert.ok(at - stoppedAt < WAIT_MS);
    });
  });

  test('answers 410 on both channels to a cursor below the trim watermark, and serves one at it', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope, {
      configuration: SHORT_RETENTION,
    });
    assert.ok(
      await untilNoticesOlderThan(
        harness.clients.migration,
        retentionFloorSeconds(harness.configuration),
      ),
    );
    const { cursors, positions } = await writtenBaselines(
      harness,
      3,
      pastTheFloor(harness),
    );

    const watermark = await trimNotices(harness.clients.runtime);

    assert.equal(watermark, positions[2]);
    assert.deepEqual(await statusesFrom(harness, cursors[0] ?? '', scope), {
      poll: 410,
      push: 410,
    });
    assert.deepEqual(await statusesFrom(harness, cursors[2] ?? '', scope), {
      poll: 200,
      push: 200,
    });
  });

  test('answers 410 on both channels to a cursor whose position a restore gave to a later notice, the epoch kept', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const { cursors, positions } = await writtenBaselines(harness, 3);

    await simulateRestore(harness.clients.migration, {
      epoch: 'kept',
      keptThrough: positions[0] ?? 0n,
    });
    await insertNotices(harness.clients.migration, [{ kind: 'global' }]);
    const kept = await pollAll(harness.url, {
      after: cursors[0] ?? '',
      application: harness.application(search),
    });

    assert.deepEqual(await statusesFrom(harness, cursors[1] ?? '', scope), {
      poll: 410,
      push: 410,
    });
    assert.deepEqual(kept.notices.map(describeNotice), ['global']);
  });

  test("records a refused channel assertion as channelAssertion.rejection by the system, denied, naming its reason, its application and the request's address", async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const application = harness.application(search);
    const now = nowSeconds();

    const refused = await poll(harness.url, {
      application,
      assertion: await signedAssertion(application, {
        claims: { exp: now - 40, iat: now - 100 },
      }),
    });

    // The refusal is recorded beside the answer, so its row is waited for rather than read at once.
    const rejectionRows = async () =>
      (await auditRows(harness.clients.migration)).filter(
        ({ type }) => type === 'bio.overture.channelAssertion.rejection',
      );
    await eventually(async () => (await rejectionRows()).length > 0, WAIT_MS);
    const rejections = await rejectionRows();

    assert.equal(refused.status, 401);
    assert.deepEqual(
      rejections.map(({ data, severity }) => ({ data, severity })),
      [
        {
          data: {
            actorId: null,
            actorType: 'system',
            applicationId: application.id,
            instance: harness.configuration.instanceName,
            reason: 'expiredAssertion',
            result: 'denied',
            sourceIp: '127.0.0.1',
          },
          severity: 'warning',
        },
      ],
    );
  });

  test('counts each refusal it could not verify by reason and registered application, recording one channelAssertion.rejectionTally for each, and records a reused assertion on its own', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const portalApplication = harness.application(portal);
    const searchApplication = harness.application(search);
    const cursors = await headCursors(harness);
    const reused = await freshAssertion(searchApplication);

    const refusals = [
      await poll(harness.url, {
        application: searchApplication,
        assertion: null,
      }),
      await poll(harness.url, {
        application: searchApplication,
        assertion: null,
      }),
      await poll(harness.url, {
        application: searchApplication,
        assertion: await signedAssertion(searchApplication, {
          header: { typ: 'JWT' },
        }),
      }),
      await poll(harness.url, {
        application: searchApplication,
        assertion: await signedAssertion(searchApplication, {
          claims: { iss: 'unknown-test' },
        }),
      }),
    ];
    const opened = await rawStreamFrom(scope, harness.url, {
      application: searchApplication,
      assertion: reused,
      lastEventId: cursors[search] ?? '',
    });
    const reopened = await rawStreamFrom(scope, harness.url, {
      application: searchApplication,
      assertion: reused,
      lastEventId: cursors[search] ?? '',
    });
    assertSucceeded(
      await revokeApplicationKey(
        await administratorCaller(harness),
        portalApplication.id,
        portalApplication.keyId,
        { reason: 'retired' },
      ),
      "the revocation of the portal's key",
    );
    const holdingNone = await poll(harness.url, {
      application: portalApplication,
    });
    await harness.stopController();

    [...refusals, holdingNone].forEach(({ status }) => {
      assert.equal(status, 401);
    });
    assert.deepEqual([opened.status, reopened.status], [200, 401]);
    const rows = await auditRows(harness.clients.migration);
    // Each interval's counts are recorded together, so their rows are read in the order of their reasons.
    const dataOfType = (type: string): readonly unknown[] =>
      rows
        .filter((row) => row.type === type)
        .map(({ data }) => data)
        .toSorted((first, second) =>
          reasonOf(first).localeCompare(reasonOf(second)),
        );
    const system = {
      actorId: null,
      actorType: 'system',
      instance: harness.configuration.instanceName,
    };
    assert.deepEqual(
      dataOfType('bio.overture.channelAssertion.rejectionTally'),
      [
        { ...system, count: 2, reason: 'missingAssertion' },
        {
          ...system,
          applicationId: portalApplication.id,
          count: 1,
          reason: 'noLiveKey',
        },
        { ...system, count: 1, reason: 'unknownApplication' },
        { ...system, count: 1, reason: 'unreadableAssertion' },
      ],
    );
    assert.deepEqual(dataOfType('bio.overture.channelAssertion.rejection'), [
      {
        ...system,
        applicationId: searchApplication.id,
        reason: 'reusedAssertion',
        result: 'denied',
        sourceIp: '127.0.0.1',
      },
    ]);
  });

  test('ends a stream opened under a key once that key is revoked', async (context) => {
    const scope = cleanupFor(context);
    const harness = await startChannelHarness(scope);
    const application = harness.application(portal);
    const cursors = await headCursors(harness);
    const stream = await rawStreamFrom(scope, harness.url, {
      application,
      lastEventId: cursors[portal] ?? '',
    });

    const revokedAt = performance.now();
    assertSucceeded(
      await revokeApplicationKey(
        await administratorCaller(harness),
        application.id,
        application.keyId,
        { reason: 'compromised' },
      ),
      "the revocation of the portal's key",
    );
    const endedAt = await Promise.race([
      stream.ended,
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, WAIT_MS);
      }),
    ]);

    assert.equal(stream.status, 200);
    assert.ok(endedAt !== undefined, 'the stream outlived its key');
    assert.ok(endedAt - revokedAt < WAIT_MS);
  });
});
