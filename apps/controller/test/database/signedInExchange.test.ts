import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'node:test';

import { decodeJwt } from 'jose';
import pg from 'pg';

import {
  AUDIT_EVENT_TYPES,
  auditRows,
  emittedType,
} from '../../test-support/auditEvents.js';
import {
  exchange,
  type Person,
  type WireResponse,
} from '../../test-support/exchange.js';
import { type Harness, suiteHarness } from '../../test-support/harness.js';
import type { MintOptions } from '../../test-support/identityProvider.js';
import {
  POLICY_TABLES,
  qualified,
  revokePrincipalInStore,
  userIdOf,
  usersWithSubject,
} from '../../test-support/policy.js';
import { nowSeconds } from '../../test-support/waiting.js';

const APPLICATION = 'Signed-in exchange';

const { exchangedSids } = POLICY_TABLES;

/** The record the store keeps of a session a sign-in exchange carried: its subject and its expiry. */
interface SessionRecord {
  expiresAt: number;
  subject: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Someone the store has never met, so each test meets its own people.
const freshPerson = (): Person => ({
  email: 'signed-in@example.org',
  subject: randomUUID(),
});

// The `exp` a sign-in token carries, in seconds since the Unix epoch.
const expiryOf = (credential: string): number => {
  const { exp } = decodeJwt(credential);
  return typeof exp === 'number'
    ? exp
    : assert.fail('the sign-in token carries no exp');
};

const signIn = (
  harness: Harness,
  person: Person,
  mint: MintOptions = {},
): Promise<string> =>
  harness.tokens.signIn(person, { application: APPLICATION, mint });

const exchangeOf = (
  harness: Harness,
  credential: string,
): Promise<WireResponse> =>
  exchange(harness.url, {
    application: harness.application(APPLICATION),
    credential,
  });

// The records the store keeps of a session, under the trusted issuer, by its `sid`.
const sessionRecordsOf = async (
  harness: Harness,
  sid: string,
): Promise<readonly SessionRecord[]> => {
  const { columns } = exchangedSids;
  const { rows } = await harness.clients.migration.query<{
    expiresAt: Date;
    subject: string;
  }>(
    `SELECT ${pg.escapeIdentifier(columns.idpSubjectId)} AS subject, ${pg.escapeIdentifier(columns.expiresAt)} AS "expiresAt" FROM ${qualified(exchangedSids)} WHERE ${pg.escapeIdentifier(columns.idpIssuer)} = $1 AND ${pg.escapeIdentifier(columns.sid)} = $2`,
    [harness.configuration.identityProviderIssuer, sid],
  );
  return rows.map(({ expiresAt, subject }) => ({
    expiresAt: expiresAt.getTime() / 1000,
    subject,
  }));
};

// How many sessions the store records for a subject, under any issuer.
const sessionCountOf = async (
  harness: Harness,
  subject: string,
): Promise<number> => {
  const { columns } = exchangedSids;
  const { rows } = await harness.clients.migration.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${qualified(exchangedSids)} WHERE ${pg.escapeIdentifier(columns.idpSubjectId)} = $1`,
    [subject],
  );
  return rows[0]?.count ?? 0;
};

suite('the signed-in exchange against the store', () => {
  const shared = suiteHarness({ applications: [APPLICATION] });

  test("records the session a sign-in token carries, with its subject and the sign-in token's expiry, as it issues a token", async () => {
    const harness = await shared();
    const person = freshPerson();
    const sid = randomUUID();
    const credential = await signIn(harness, person, {
      claims: { sid },
      lifetimeSeconds: 600,
    });

    const answer = await exchangeOf(harness, credential);

    assert.equal(answer.status, 200);
    assert.deepEqual(await sessionRecordsOf(harness, sid), [
      { expiresAt: expiryOf(credential), subject: person.subject },
    ]);
  });

  test('keeps the later expiry and the subject first recorded when a session is exchanged again', async () => {
    const harness = await shared();
    const [first, second] = [freshPerson(), freshPerson()];
    const sid = randomUUID();
    const recorded = await signIn(harness, first, {
      claims: { sid },
      lifetimeSeconds: 600,
    });
    const sooner = await signIn(harness, second, {
      claims: { sid },
      lifetimeSeconds: 300,
    });
    const later = await signIn(harness, second, {
      claims: { sid },
      lifetimeSeconds: 900,
    });

    const firstAnswer = await exchangeOf(harness, recorded);
    const afterRecorded = await sessionRecordsOf(harness, sid);
    const soonerAnswer = await exchangeOf(harness, sooner);
    const afterSooner = await sessionRecordsOf(harness, sid);
    const laterAnswer = await exchangeOf(harness, later);
    const afterLater = await sessionRecordsOf(harness, sid);

    assert.deepEqual(
      [firstAnswer, soonerAnswer, laterAnswer].map(({ status }) => status),
      [200, 200, 200],
    );
    assert.deepEqual(afterRecorded, [
      { expiresAt: expiryOf(recorded), subject: first.subject },
    ]);
    assert.deepEqual(afterSooner, afterRecorded);
    assert.deepEqual(afterLater, [
      { expiresAt: expiryOf(later), subject: first.subject },
    ]);
  });

  test('records no session for an exchange refused, nor for a sign-in token carrying no sid', async () => {
    const harness = await shared();
    const person = freshPerson();
    const sid = randomUUID();
    const now = nowSeconds();
    const expired = await signIn(harness, person, {
      claims: { exp: now - 3600, iat: now - 3900, sid },
    });
    const sessionless = await signIn(harness, person, {
      claims: { sid: undefined },
    });

    const refused = await exchangeOf(harness, expired);
    const issued = await exchangeOf(harness, sessionless);

    assert.equal(refused.status, 403);
    assert.equal(issued.status, 200);
    assert.deepEqual(await sessionRecordsOf(harness, sid), []);
    assert.equal(await sessionCountOf(harness, person.subject), 0);
  });

  test('records one person for two first exchanges of one subject made at once', async () => {
    const harness = await shared();
    const person = freshPerson();
    const credentials = await Promise.all([
      signIn(harness, person),
      signIn(harness, person),
    ]);

    const answers = await Promise.all(
      credentials.map((credential) => exchangeOf(harness, credential)),
    );

    assert.deepEqual(
      answers.map(({ status }) => status),
      [200, 200],
    );
    assert.equal(
      await usersWithSubject(harness.clients.migration, person.subject),
      1,
    );
  });

  test('refuses an exchange once a revocation of its principal has committed, recording it denied as revokedPrincipal naming the subject, its actor anonymous, and recording no session', async () => {
    const harness = await shared();
    const { migration } = harness.clients;
    const [revoked, revoker] = [freshPerson(), freshPerson()];
    const met = await Promise.all(
      [revoked, revoker].map(async (person) =>
        exchangeOf(harness, await signIn(harness, person)),
      ),
    );
    await revokePrincipalInStore(migration, {
      revokedBy: await userIdOf(migration, revoker.subject),
      userId: await userIdOf(migration, revoked.subject),
    });
    const sid = randomUUID();

    const refused = await exchangeOf(
      harness,
      await signIn(harness, revoked, { claims: { sid } }),
    );
    const denials = (await auditRows(migration)).flatMap(({ data, type }) =>
      type === emittedType(AUDIT_EVENT_TYPES.tokenExchange) &&
      isRecord(data) &&
      data['refusedSubject'] === revoked.subject
        ? [data]
        : [],
    );

    assert.deepEqual(
      met.map(({ status }) => status),
      [200, 200],
    );
    assert.equal(refused.status, 403);
    assert.deepEqual(
      denials.map((data) => ({
        actorId: data['actorId'],
        actorType: data['actorType'],
        reason: data['reason'],
        result: data['result'],
        userId: data['userId'],
      })),
      [
        {
          actorId: null,
          actorType: 'anonymous',
          reason: 'revokedPrincipal',
          result: 'denied',
          userId: null,
        },
      ],
    );
    assert.deepEqual(await sessionRecordsOf(harness, sid), []);
  });
});
