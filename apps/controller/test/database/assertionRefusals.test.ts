import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';

import type pg from 'pg';

import {
  AUDIT_EVENT_TYPES,
  auditRows,
  dataOf,
  emittedType,
} from '../../test-support/auditEvents.js';
import { startDedicatedPostgresql } from '../../test-support/containers.js';
import { captureLog } from '../../test-support/controller.js';
import type { WireResponse } from '../../test-support/exchange.js';
import { anonymousExchange } from '../../test-support/fixtures/applications.js';
import { assertionFor } from '../../test-support/fixtures/issuance.js';
import { withHarness } from '../../test-support/harness.js';
import { cleanupFor } from '../../test-support/waiting.js';

const { channelAssertionRejection, channelAssertionRejectionTally } =
  AUDIT_EVENT_TYPES;

/**
 * The connections the controller's exchange pool holds: `USHER_DATABASE_EXCHANGE_CONNECTIONS` at its
 * default. A constant of its own here, as the test reaches the controller through the seam.
 */
const POOL_CONNECTIONS = 10;

/**
 * The most rejection recordings the exchange route holds waiting on the store, by the controller's
 * rule: half its pool's connections, rounded down, and at least one. The one application registered
 * has the whole pool as its share, so its share never bounds these recordings below that.
 */
const PENDING_LIMIT = Math.max(1, Math.floor(POOL_CONNECTIONS / 2));

/** How many refused assertions the test presents while the store is paused: past the limit. */
const PRESENTED = PENDING_LIMIT + 5;

/** Long enough for an answer given from memory, and far shorter than any wait on the store. */
const ANSWER_WITHIN_MS = 1000;

/** An audience other than the controller's, so each assertion verifies and is refused as `otherAudience`. */
const ANOTHER_AUDIENCE = 'usher:elsewhere';

const APPLICATION = 'Refused assertions';

interface Timed {
  answer: WireResponse;
  elapsedMs: number;
}

// The data of each row of one event type naming the application, in the order the store holds them.
const rowsNaming = async (
  client: pg.ClientBase,
  type: string,
  applicationId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
  (await auditRows(client))
    .filter((row) => row.type === emittedType(type))
    .map(dataOf)
    .filter((data) => data['applicationId'] === applicationId);

suite(
  "an instance's recording of refused channel assertions on a paused store",
  () => {
    test('answers every refused assertion 401 at once while the store is paused, recording at most the pending limit of them and counting the rest', async (context) => {
      const scope = cleanupFor(context);
      const postgresql = await startDedicatedPostgresql();
      scope.defer(() => postgresql.remove());
      const log = captureLog();

      await withHarness(
        {
          applications: [APPLICATION],
          configuration: { logStream: log.stream },
          postgresql,
        },
        async (harness) => {
          const { migration } = harness.clients;
          const application = harness.application(APPLICATION);
          // Each signed under the application's own key, so each verifies, and each its own assertion.
          const assertions = await Promise.all(
            Array.from({ length: PRESENTED }, () =>
              assertionFor(application, { audience: ANOTHER_AUDIENCE }),
            ),
          );

          await postgresql.pause();
          const answers = await (async () => {
            try {
              return await assertions.reduce<Promise<readonly Timed[]>>(
                async (earlier, assertion) => {
                  const answered = await earlier;
                  const from = performance.now();
                  const answer = await anonymousExchange(
                    harness.url,
                    application,
                    { assertion },
                  );
                  return [
                    ...answered,
                    { answer, elapsedMs: performance.now() - from },
                  ];
                },
                Promise.resolve([]),
              );
            } finally {
              await postgresql.unpause();
            }
          })();
          // The stop waits for every recording still waiting on the store, then records the tally.
          await harness.stopController();
          const recorded = await rowsNaming(
            migration,
            channelAssertionRejection,
            application.id,
          );
          const tallied = (
            await rowsNaming(
              migration,
              channelAssertionRejectionTally,
              application.id,
            )
          )
            .filter(({ reason }) => reason === 'otherAudience')
            .reduce(
              (sum, { count }) => sum + (typeof count === 'number' ? count : 0),
              0,
            );

          answers.forEach(({ answer, elapsedMs }, index) => {
            assert.equal(answer.status, 401, `refusal ${index + 1}`);
            assert.ok(
              elapsedMs < ANSWER_WITHIN_MS,
              `refusal ${index + 1} answered in ${Math.round(elapsedMs)} ms`,
            );
          });
          assert.ok(
            recorded.length <= PENDING_LIMIT,
            `${recorded.length} rejections recorded`,
          );
          assert.ok(
            recorded.every(({ reason }) => reason === 'otherAudience'),
            'a rejection recorded another reason',
          );
          assert.equal(recorded.length + tallied, PRESENTED);
          assert.ok(
            tallied >= PRESENTED - PENDING_LIMIT,
            `${tallied} refusals counted`,
          );
        },
        context,
      );
    });
  },
);
