import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type pg from 'pg';

import { administratorCaller } from '../../test-support/admin.js';
import {
  AUDIT_EVENT_TYPES,
  auditRows,
  dataOf,
  eventsIn,
  ofType,
} from '../../test-support/auditEvents.js';
import { captureLog } from '../../test-support/controller.js';
import {
  anonymousExchange,
  APPLICATION_SUITE,
  heldBy,
  registered,
} from '../../test-support/fixtures/applications.js';
import { withHarness } from '../../test-support/harness.js';
import {
  inTransactionAs,
  POLICY_TABLES,
  qualified,
  SYSTEM_ACTOR,
} from '../../test-support/policy.js';

const { applicationKeys } = POLICY_TABLES;

const { columns } = applicationKeys;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A key's confirmed_at as the store holds it, read under the migration role.
const confirmedAtOf = async (
  client: pg.ClientBase,
  keyId: string,
): Promise<Date | null | undefined> => {
  const { rows } = await client.query<{ confirmedAt: Date | null }>(
    `SELECT ${columns.confirmedAt} AS "confirmedAt" FROM ${qualified(applicationKeys)} WHERE ${columns.id} = $1`,
    [keyId],
  );
  return rows[0]?.confirmedAt;
};

// Revokes a key in the store alone, as the system, so a running instance's key ring, which reads the
// keys again only at its reload interval, still holds it.
const revokedInTheStore = (
  client: pg.ClientBase,
  keyId: string,
): Promise<unknown> =>
  inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `UPDATE ${qualified(applicationKeys)} SET ${columns.revokedAt} = now(), ${columns.revokedBy} = ${columns.issuedBy} WHERE ${columns.id} = $1`,
      [keyId],
    ),
  );

suite("an application key's confirmation, as the store holds it", () => {
  test('confirms no key revoked in the store, though an instance still holding the key answers an exchange whose assertion verifies under it', async (context) => {
    const log = captureLog();
    await withHarness(
      { ...APPLICATION_SUITE, configuration: { logStream: log.stream } },
      async (harness) => {
        const { migration } = harness.clients;
        const administrator = await administratorCaller(harness);
        const revoked = await registered(administrator, {
          displayName: 'Revoked in the store alone',
        });
        const kept = await registered(administrator, {
          displayName: 'Kept live, confirmed as a control',
        });
        await revokedInTheStore(migration, revoked.key.id);
        const since = log.lines().length;

        const underTheRevoked = await anonymousExchange(
          harness.url,
          heldBy(revoked),
        );
        const underTheKept = await anonymousExchange(harness.url, heldBy(kept));
        const confirmedKeysLogged = ofType(
          eventsIn(log, since),
          AUDIT_EVENT_TYPES.applicationKeyConfirmation,
        ).map((event) => dataOf(event)['keyId']);
        const confirmedKeysRecorded = (await auditRows(migration))
          .filter(
            ({ type }) =>
              type ===
              `bio.overture.${AUDIT_EVENT_TYPES.applicationKeyConfirmation}`,
          )
          .map(({ data }) => (isRecord(data) ? data['keyId'] : undefined));

        assert.notEqual(
          underTheRevoked.status,
          401,
          'the instance verified the assertion under the key it still holds',
        );
        assert.equal(underTheKept.status, 200);
        assert.equal(await confirmedAtOf(migration, revoked.key.id), null);
        assert.ok(
          (await confirmedAtOf(migration, kept.key.id)) instanceof Date,
          'the live key was confirmed',
        );
        assert.deepEqual(confirmedKeysLogged, [kept.key.id]);
        assert.deepEqual(confirmedKeysRecorded, [kept.key.id]);
      },
      context,
    );
  });
});
