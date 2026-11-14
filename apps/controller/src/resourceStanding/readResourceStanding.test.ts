import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import { readResourceStanding } from './readResourceStanding.js';
import type { ResourceStanding, StandingLock } from './types.js';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const ISSUER = 'https://auth.example.org/realms/usher';

interface Sent {
  text: string;
  values: readonly unknown[];
}

const STORED: ResourceStanding = {
  accessLevel: 'grant',
  countedOwner: true,
  externalId: 'STUDY-A1',
  holder: true,
  id: '00000000-0000-4000-8000-000000000001',
  retired: false,
  suppressed: false,
};

// A client that never connects, each statement answered with the rows given and kept as sent.
const answering = (
  rows: readonly ResourceStanding[],
): { connection: pg.ClientBase; sent: Sent[] } => {
  const sent: Sent[] = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    sent.push({ text, values });
    return { rows };
  };
  return { connection: Object.assign(new pg.Client(), { query }), sent };
};

const read = (
  connection: pg.ClientBase,
  lock: StandingLock,
): Promise<ResourceStanding | undefined> =>
  readResourceStanding(connection, 'usher', {
    externalId: 'STUDY-A1',
    issuer: ISSUER,
    lock,
    now: new Date(NOW),
    subject: 'subject-ana',
  });

suite("reading a principal's standing on a resource", () => {
  test('binds the externalId, the trusted issuer, the subject and the configured instant, writing none of them into the statement', async () => {
    const { connection, sent } = answering([STORED]);

    const standing = await read(connection, 'none');

    assert.deepEqual(standing, STORED);
    assert.equal(sent.length, 1);
    const [{ text = '', values = [] } = {}] = sent;
    assert.deepEqual(
      [...values].toSorted(),
      [ISSUER, 'STUDY-A1', new Date(NOW), 'subject-ana'].toSorted(),
    );
    ['STUDY-A1', 'subject-ana', ISSUER].forEach((value) => {
      assert.equal(text.includes(value), false, value);
    });
  });

  test('answers no standing for an externalId no resource holds', async () => {
    const { connection } = answering([]);

    assert.equal(await read(connection, 'none'), undefined);
  });

  test("locks the resource's row as asked in a statement of its own before the read, so the read sees what committed before the lock was taken, and takes no lock otherwise", async () => {
    const reads = await Promise.all(
      (['none', 'share', 'noKeyUpdate'] as const).map(async (lock) => {
        const { connection, sent } = answering([STORED]);
        await read(connection, lock);
        return sent.map(({ text, values }) => ({
          lock: /FOR (?:SHARE|NO KEY UPDATE)/u.exec(text)?.[0],
          values,
        }));
      }),
    );

    assert.deepEqual(
      reads.map((statements) => statements.map(({ lock }) => lock)),
      [[undefined], ['FOR SHARE', undefined], ['FOR NO KEY UPDATE', undefined]],
    );
    assert.deepEqual(
      reads.map((statements) => statements[0]?.values.includes('STUDY-A1')),
      [true, true, true],
    );
  });
});
