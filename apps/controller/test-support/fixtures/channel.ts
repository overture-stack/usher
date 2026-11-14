import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';

import type {
  Notice,
  PermissionsPayload,
  RecordAction,
} from '@overture-stack/usher-types';
import { createParser } from 'eventsource-parser';
import { CompactSign } from 'jose';
import pg from 'pg';

import {
  type AdminCaller,
  type LogoutTokenOptions,
  mintLogoutToken,
} from '../admin.js';
import {
  CHANNEL_ASSERTION_AUDIENCE,
  CHANNEL_ASSERTION_LIFETIME_S,
  CHANNEL_ASSERTION_TYPE,
  createChannelReader,
  importApplicationKey,
  SUBKEY_LABELS,
  subjectTag,
  subkeyBytes,
} from '../bridgeWire.js';
import {
  type ChannelRequest,
  type NoticeStream,
  openRawStream,
  openStream,
  poll,
  pollAll,
  type PollResponse,
  type RawStream,
  type RawStreamRequest,
  type StreamRead,
  type StreamRequest,
} from '../channel.js';
import {
  type DedicatedContainer,
  type KeycloakRealm,
  type KeycloakRealmOptions,
  type Relay,
  startDedicatedPostgresql,
  startDedicatedValkey,
  startKeycloak,
  startRelay,
} from '../containers.js';
import {
  type ControllerApplication,
  type ControllerConfiguration,
  startController,
} from '../controller.js';
import {
  exchange,
  freshAssertion,
  PEOPLE,
  type Person,
  readUsherToken,
} from '../exchange.js';
import {
  type Harness,
  type HarnessOptions,
  retentionFloorSeconds,
  startHarness,
  withTrailingSlash,
} from '../harness.js';
import type { MintOptions } from '../identityProvider.js';
import {
  type FixtureDecision,
  type FixtureGrant,
  noticesAfter as storedNoticesAfter,
  type PolicyFixture,
  POLICY_FUNCTIONS,
  POLICY_TABLES,
  qualified,
} from '../policy.js';
import { type Cleanup, eventually, nowSeconds } from '../waiting.js';

// The revocation channel's own fixture (#210): its audiences, resources and policy, ways to read what
// the controller writes on both channels, and small wrappers deferring each shared helper's cleanup.

/**
 * The three audiences served in every channel test, by role in the fixture, each by its label,
 * registered by the harness as its display name; `harness.application(...).id` is its id
 * ({@link audienceIdsOf}).
 */
export const AUDIENCES = Object.freeze({
  portal: 'portal-test',
  search: 'search-test',
  submission: 'submission-test',
} as const);

/**
 * Every audience served by the channel fixture, by label, each registered by the harness with a fresh
 * key under its label as display name: the labels keying its records of notices, cursors and tags,
 * not the audiences' ids.
 */
export const AUDIENCE_LABELS: readonly string[] = Object.freeze([
  AUDIENCES.portal,
  AUDIENCES.search,
  AUDIENCES.submission,
]);

/** The fixture's resources by externalId: one open, one registered, one by grant, one served by no audience. */
export const RESOURCES = Object.freeze({
  a1: 'STUDY-A1',
  b2: 'STUDY-B2',
  c3: 'study.c_3',
  d4: 'UNSERVED-D4',
} as const);

/** The global category consumer grants name, as the payload and the API name it. */
export const CONTROLLED = 'global.controlled';

/** The category the baseline and the signed-in rule confer on, as the payload names it. */
export const UNMARKED = 'global.unmarked';

/** What `read` expands to: the baseline's, the signed-in rule's and `viewer`'s record actions. */
export const READ_ACTIONS: readonly RecordAction[] = Object.freeze([
  'count',
  'view',
  'export',
]);

/** The capabilities `viewer` carries, as `entity.action` names (permissions-model.md). */
export const VIEWER_CAPABILITIES: readonly string[] = Object.freeze([
  'record.count',
  'record.export',
  'record.view',
]);

/**
 * The longest externalId #211 allows (Q3, as recommended: 128 characters), made of the default
 * set's characters, the first a letter.
 */
export const LONGEST_EXTERNAL_ID = 'S'.padEnd(128, 'a1.b2_c3-');

/** The page limit (#210 Q13). */
export const PAGE_LIMIT = 500;

/** The bridge's poll deadline, the iMS default (O14). */
export const POLL_DEADLINE_MS = 10_000;

/** How often each instance re-reads the stream with no wake-up (#210 Q14). */
export const REREAD_INTERVAL_MS = 2_000;

/** The heartbeat interval, fixed (#210 Q15). */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** The bridge's response cap on a poll page (`configuration.ts` `responseCapBytes`). */
export const RESPONSE_CAP_BYTES = 1_048_576;

/** A day, in milliseconds. */
export const DAY_MS = 86_400_000;

/**
 * Retention settings short enough for a test to wait out the floor they give, 7 s, so every notice
 * the fixture's seeding wrote can age past it and the trimming function can reach them: 5 s Usher
 * tokens, 1 s of grace and 1 s of margin.
 */
export const SHORT_RETENTION: Pick<
  ControllerConfiguration,
  'retentionGraceSeconds' | 'retentionMarginSeconds' | 'tokenLifetimeSeconds'
> = Object.freeze({
  retentionGraceSeconds: 1,
  retentionMarginSeconds: 1,
  tokenLifetimeSeconds: 5,
});

/** The people the channel fixture seeds: everyone in `PEOPLE` but Fen, whom no fixture seeds. */
const SEEDED_PEOPLE = Object.entries(PEOPLE).filter(([name]) => name !== 'fen');

const OWNED_RESOURCES = Object.freeze([
  RESOURCES.a1,
  RESOURCES.b2,
  RESOURCES.c3,
  RESOURCES.d4,
]);

const ownerGrantName = (externalId: string): string => `owner:${externalId}`;

/**
 * A consumer grant at a role on the controlled category, for a fixture user.
 *
 * @param user the holder's name in `PEOPLE`, or a bulk person's.
 * @param resource the resource's externalId.
 * @param role the role: `viewer` by default.
 * @param options the grant's end.
 */
export const consumerGrant = (
  user: string,
  resource: string,
  role = 'viewer',
  { expiresAt }: { expiresAt?: Date } = {},
): FixtureGrant => ({
  category: 'controlled',
  holder: { user },
  resource,
  role,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

/**
 * An accepting decision on a fixture grant.
 *
 * @param grant the fixture grant's name.
 * @param decidedAt when it was answered: the transaction's clock by default.
 */
export const accepted = (grant: string, decidedAt?: Date): FixtureDecision => ({
  decision: 'accepted',
  grant,
  ...(decidedAt === undefined ? {} : { decidedAt }),
});

/**
 * Policies combined into one: records merged by name, the later winning, and lists joined in order.
 *
 * @param policies the policies.
 */
export const combinedPolicy = (
  ...policies: readonly PolicyFixture[]
): PolicyFixture =>
  policies.reduce<PolicyFixture>(
    (combined, policy) => ({
      applications: { ...combined.applications, ...policy.applications },
      categories: { ...combined.categories, ...policy.categories },
      decisions: [...(combined.decisions ?? []), ...(policy.decisions ?? [])],
      fields: { ...combined.fields, ...policy.fields },
      grants: { ...combined.grants, ...policy.grants },
      groups: { ...combined.groups, ...policy.groups },
      invitations: [
        ...(combined.invitations ?? []),
        ...(policy.invitations ?? []),
      ],
      resources: { ...combined.resources, ...policy.resources },
      revocations: [
        ...(combined.revocations ?? []),
        ...(policy.revocations ?? []),
      ],
      roles: { ...combined.roles, ...policy.roles },
      users: { ...combined.users, ...policy.users },
    }),
    {},
  );

/**
 * A policy giving each named fixture user an accepted grant at a role on one resource, each grant
 * named after its holder.
 *
 * @param names the holders' names in `PEOPLE`.
 * @param resource the resource's externalId.
 * @param role the role: `viewer` by default.
 */
export const heldGrants = (
  names: readonly string[],
  resource: string,
  role = 'viewer',
): PolicyFixture => ({
  decisions: names.map((name) => accepted(name)),
  grants: Object.fromEntries(
    names.map((name) => [name, consumerGrant(name, resource, role)]),
  ),
});

/**
 * The channel's fixture with a test's own policy over it. Every person in `PEOPLE` but Fen is a
 * user; `controlled` is a global category; the four resources carry the plan's display names and
 * base tiers; `search-test` serves `STUDY-A1` and `STUDY-B2`, `submission-test` serves `STUDY-B2` and
 * `study.c_3`, `portal-test` serves none; and `owner` holds an accepted owner grant on each resource,
 * since a consumer grant through the API is made by the resource's owner (#212 Q4).
 *
 * @param policy the test's own entries, merged over the fixture's by name.
 */
export const channelPolicy = (policy: PolicyFixture = {}): PolicyFixture =>
  combinedPolicy(
    {
      applications: {
        [AUDIENCES.portal]: { serves: [] },
        [AUDIENCES.search]: { serves: [RESOURCES.a1, RESOURCES.b2] },
        [AUDIENCES.submission]: { serves: [RESOURCES.b2, RESOURCES.c3] },
      },
      categories: { controlled: { description: 'Controlled access' } },
      decisions: OWNED_RESOURCES.map((externalId) =>
        accepted(ownerGrantName(externalId)),
      ),
      grants: Object.fromEntries(
        OWNED_RESOURCES.map((externalId) => [
          ownerGrantName(externalId),
          {
            category: null,
            holder: { user: 'owner' },
            resource: externalId,
            role: 'owner',
          },
        ]),
      ),
      resources: {
        [RESOURCES.a1]: { baseTier: 'open', name: 'Étude cardiaque A1' },
        [RESOURCES.b2]: { baseTier: 'registered', name: 'Cohort B2' },
        [RESOURCES.c3]: { baseTier: 'grant', name: 'Study C3' },
        [RESOURCES.d4]: { baseTier: 'registered', name: 'Unserved D4' },
      },
      users: Object.fromEntries(
        SEEDED_PEOPLE.map(([name, { subject }]) => [name, { subject }]),
      ),
    },
    policy,
  );

/**
 * People made up for the volume tests, `bulk-0001@example.org` and on, each with a subject of
 * their own.
 *
 * @param count how many.
 * @param prefix what their names and subjects start with.
 */
export const bulkPeople = (
  count: number,
  prefix = 'bulk',
): readonly (Person & { name: string })[] =>
  Array.from({ length: count }, (_, index) => {
    const name = `${prefix}-${String(index + 1).padStart(5, '0')}`;
    return { email: `${name}@example.org`, name, subject: `${name}-subject` };
  });

/**
 * A policy giving each bulk person an accepted viewer grant on one resource, named after them.
 *
 * @param people the bulk people.
 * @param resource the resource's externalId.
 */
export const bulkGrants = (
  people: readonly (Person & { name: string })[],
  resource: string,
): PolicyFixture => ({
  ...heldGrants(
    people.map(({ name }) => name),
    resource,
  ),
  users: Object.fromEntries(
    people.map(({ name, subject }) => [name, { subject }]),
  ),
});

/** What a channel test's harness is started with beyond the channel's fixture. */
export interface ChannelHarnessOptions {
  /** Fields over the harness's configuration. */
  configuration?: Partial<ControllerConfiguration>;

  /** The test's own policy, merged over {@link channelPolicy}'s. */
  policy?: PolicyFixture;

  /** A PostgreSQL of the test's own, for an outage test or a server setting. */
  postgresql?: DedicatedContainer;

  /**
   * Whether the harness starts a controller: true by default; false for a test running its own
   * instances, which has the harness issue its applications their first keys ({@link issueFirstKeys})
   * before starting them.
   */
  startsController?: boolean;
}

/**
 * The ids registered by the harness for audiences, by their labels, in the order given: the ids by
 * which a resource's registration, the serving endpoints and a stored notice name an audience.
 *
 * @param harness the harness.
 * @param labels the audiences' labels.
 */
export const audienceIdsOf = (
  harness: Harness,
  labels: readonly string[],
): readonly string[] => labels.map((label) => harness.application(label).id);

/**
 * Has the harness's own controller listen once, then stops it, for a test running instances alone: a
 * harness started with `startsController: false` holds its applications without keys until its own
 * controller first listens, when it issues each its first key, and an instance registers none.
 *
 * @param harness a harness started with `startsController: false`.
 */
export const issueFirstKeys = async (harness: Harness): Promise<void> => {
  await harness.startController();
  await harness.stopController();
};

// The store connections the channel harness's instance holds for the token exchange: enough for the
// bursts of exchanges a channel test sends at once, beyond the controller's default of 10.
const CHANNEL_EXCHANGE_CONNECTIONS = 20;

/**
 * The harness options of a channel test: the three audiences, the channel's fixture, and an
 * exchange pool of 20 connections unless the test's configuration sets another.
 *
 * @param options configuration, policy, PostgreSQL and whether a controller starts.
 */
export const channelHarnessOptions = ({
  configuration = {},
  policy = {},
  postgresql,
  startsController,
}: ChannelHarnessOptions = {}): HarnessOptions => ({
  applications: AUDIENCE_LABELS,
  configuration: {
    databaseExchangeConnections: CHANNEL_EXCHANGE_CONNECTIONS,
    ...configuration,
  },
  fixture: channelPolicy(policy),
  ...(postgresql === undefined ? {} : { postgresql }),
  ...(startsController === undefined ? {} : { startsController }),
});

/**
 * Starts a harness serving the three audiences, seeded with the channel's fixture, and defers its
 * stop.
 *
 * @param scope the test's cleanup.
 * @param options configuration, policy, PostgreSQL and whether a controller starts.
 */
export const startChannelHarness = async (
  scope: Cleanup,
  options: ChannelHarnessOptions = {},
): Promise<Harness> => {
  const harness = await startHarness(channelHarnessOptions(options));
  scope.defer(() => harness.stop());
  return harness;
};

/**
 * A PostgreSQL of the test's own, removed once the test ends, after everything deferred later.
 *
 * @param scope the test's cleanup.
 * @param settings the server settings it starts with, such as `{ track_commit_timestamp: 'on' }`.
 */
export const dedicatedPostgresql = async (
  scope: Cleanup,
  settings: Readonly<Record<string, string>> = {},
): Promise<DedicatedContainer> => {
  const postgresql = await startDedicatedPostgresql(undefined, { settings });
  scope.defer(() => postgresql.remove());
  return postgresql;
};

/**
 * A Valkey of the test's own, removed once the test ends, after everything deferred later.
 *
 * @param scope the test's cleanup.
 */
export const dedicatedValkey = async (
  scope: Cleanup,
): Promise<DedicatedContainer> => {
  const valkey = await startDedicatedValkey();
  scope.defer(() => valkey.remove());
  return valkey;
};

/**
 * A relay to a server, stopped once the test ends.
 *
 * @param scope the test's cleanup.
 * @param target the server's URL.
 */
export const relayTo = async (
  scope: Cleanup,
  target: string,
): Promise<Relay> => {
  const relay = await startRelay(target);
  scope.defer(() => relay.stop());
  return relay;
};

/**
 * A current Keycloak in a container, removed once the test ends.
 *
 * @param scope the test's cleanup.
 * @param options the realm, its clients and its people.
 */
export const keycloakFor = async (
  scope: Cleanup,
  options: KeycloakRealmOptions,
): Promise<KeycloakRealm> => {
  const realm = await startKeycloak(options);
  scope.defer(() => realm.remove());
  return realm;
};

/**
 * The notice stream read at the socket, closed once the test ends.
 *
 * @param scope the test's cleanup.
 * @param url the instance.
 * @param request the application, the cursor and any departure from the bridge's request.
 */
export const rawStreamFrom = async (
  scope: Cleanup,
  url: URL,
  request: RawStreamRequest,
): Promise<RawStream> => {
  const stream = await openRawStream(url, request);
  scope.defer(() => stream.close());
  return stream;
};

/**
 * An instant a duration from now, as the API takes one.
 *
 * @param milliseconds the duration; negative for the past.
 */
export const instantIn = (milliseconds: number): string =>
  new Date(Date.now() + milliseconds).toISOString();

/**
 * The administrator's caller of the Policy Management API, with a fresh token.
 *
 * @param harness the harness.
 * @param url the instance called: the harness's controller by default.
 */
export const administratorCaller = async (
  harness: Harness,
  url?: URL,
): Promise<AdminCaller> => ({
  token: await harness.tokens.administrator(PEOPLE.administrator),
  url: url ?? harness.url,
});

/**
 * The owner of every fixture resource, as a caller with a fresh token.
 *
 * @param harness the harness.
 * @param url the instance called: the harness's controller by default.
 */
export const ownerCaller = async (
  harness: Harness,
  url?: URL,
): Promise<AdminCaller> => ({
  token: await harness.tokens.management(PEOPLE.owner),
  url: url ?? harness.url,
});

/**
 * A person as a caller of the Policy Management API, holding no administrator role.
 *
 * @param harness the harness.
 * @param person who calls.
 * @param url the instance called: the harness's controller by default.
 */
export const personCaller = async (
  harness: Harness,
  person: Person,
  url?: URL,
): Promise<AdminCaller> => ({
  token: await harness.tokens.management(person),
  url: url ?? harness.url,
});

/** A controller instance a test started beside the harness's, on the same database, cache and keys. */
export interface ControllerInstance {
  /** Stops it, settling once its work has ended; stopping again does nothing. */
  stop(): Promise<void>;

  /** Its URL, ending in `/`. */
  url: URL;
}

/**
 * Starts a controller instance through the seam, on the harness's configuration with any fields over
 * it, and defers its stop.
 *
 * @param scope the test's cleanup.
 * @param harness the harness whose database, cache and keys it shares.
 * @param overrides fields over the harness's configuration.
 */
export const startInstance = async (
  scope: Cleanup,
  harness: Harness,
  overrides: Partial<ControllerConfiguration> = {},
): Promise<ControllerInstance> => {
  const running = await startController({
    ...harness.configuration,
    ...overrides,
  });
  const state = { stopped: false };
  const stop = async (): Promise<void> => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    await running.stop();
  };
  scope.defer(stop);
  return { stop, url: withTrailingSlash(running.url) };
};

/** A log stream a test reads, for the configuration's `logStream`. */
export interface CollectedLog {
  /** Everything written to it so far, as UTF-8. */
  output(): string;

  stream: Writable;
}

/** A log stream keeping everything written to it, for a controller whose log output a test reads. */
export const collectedLog = (): CollectedLog => {
  const chunks: Buffer[] = [];
  return {
    output: () => Buffer.concat(chunks).toString('utf8'),
    stream: new Writable({
      write: (chunk: Buffer | string, encoding, callback) => {
        chunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk,
        );
        callback();
      },
    }),
  };
};

/**
 * The client a logout token is addressed to: the harness's first back-channel logout audience.
 *
 * @param harness the harness.
 */
export const logoutAudience = (harness: Harness): string => {
  const [audience] = harness.configuration.backChannelLogoutAudiences;
  if (audience !== undefined) {
    return audience;
  }
  throw new Error('the harness configures no back-channel logout audience');
};

/**
 * A logout token from the stand-in signing a person out of a fresh session, addressed to the
 * harness's back-channel logout audience, with any departures over it.
 *
 * @param harness the harness.
 * @param person who is signed out.
 * @param options the session, and claims and header members over the logout token's.
 */
export const logoutTokenFor = (
  harness: Harness,
  person: Person,
  options: Omit<LogoutTokenOptions, 'audience' | 'subject'> = {},
): Promise<string> =>
  mintLogoutToken(harness.identityProvider, {
    audience: logoutAudience(harness),
    sessionId: randomUUID(),
    subject: person.subject,
    ...options,
  });

/**
 * A person's sign-in token for an audience, from the stand-in.
 *
 * @param harness the harness.
 * @param person who signs in.
 * @param audience the application's label.
 * @param mint claims and header members over the sign-in token's, and its lifetime.
 */
export const signInToken = (
  harness: Harness,
  person: Person,
  audience: string,
  mint?: MintOptions,
): Promise<string> =>
  harness.tokens.signIn(person, {
    application: audience,
    ...(mint === undefined ? {} : { mint }),
  });

/**
 * Exchanges a credential for an audience and reads the payload as the bridge reads it, throwing
 * with the status or the bridge's reason when no payload is issued.
 *
 * @param harness the harness.
 * @param url the instance exchanged with.
 * @param audience the application's label.
 * @param credential the person's credential, or `null` for the anonymous exchange.
 */
export const issuedPayload = async (
  harness: Harness,
  url: URL,
  audience: string,
  credential: string | null,
): Promise<PermissionsPayload> => {
  const application = harness.application(audience);
  const answer = await exchange(url, { application, credential });
  if (answer.status !== 200) {
    throw new Error(
      `the exchange for ${audience} was answered ${answer.status}`,
    );
  }
  const reading = await readUsherToken(answer.body, {
    application,
    issuer: harness.configuration.issuer,
  });
  if (reading.kind === 'payload') {
    return reading.payload;
  }
  throw new Error(`the Usher token for ${audience} was ${reading.reason}`);
};

/**
 * A person's payload for an audience, exchanged with a fresh sign-in token.
 *
 * @param harness the harness.
 * @param url the instance exchanged with.
 * @param audience the application's label.
 * @param person who signs in, or `null` for an anonymous visitor.
 */
export const payloadFor = async (
  harness: Harness,
  url: URL,
  audience: string,
  person: Person | null,
): Promise<PermissionsPayload> =>
  issuedPayload(
    harness,
    url,
    audience,
    person === null ? null : await signInToken(harness, person, audience),
  );

/**
 * The record actions a payload holds on one category of one resource, empty when it holds none.
 *
 * @param payload the payload.
 * @param resource the resource's externalId.
 * @param category the scoped category.
 */
export const recordActions = (
  payload: PermissionsPayload,
  resource: string,
  category: string,
): readonly RecordAction[] => {
  const held = Object.hasOwn(payload.permissions, resource)
    ? payload.permissions[resource]
    : undefined;
  const entry =
    held !== undefined && Object.hasOwn(held, category)
      ? Object.entries(held).find(([name]) => name === category)?.[1]
      : undefined;
  return entry?.record ?? [];
};

/**
 * The tag of a subject under an application's subject-tag subkey, as `keys.ts` `subjectTag` makes it.
 *
 * @param application the application.
 * @param subject the subject.
 */
export const tagOfSubject = async (
  application: ControllerApplication,
  subject: string,
): Promise<string> =>
  subjectTag(await importApplicationKey(application.key), subject);

/**
 * The tag each audience's bridge computes for a person: the subject tag of the `sub` in the Usher
 * token the controller issues that person for that audience.
 *
 * @param harness the harness.
 * @param person who signs in.
 * @param url the instance exchanged with: the harness's controller by default.
 */
export const tagsOf = async (
  harness: Harness,
  person: Person,
  url?: URL,
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(
      AUDIENCE_LABELS.map(async (audience) => {
        const { sub } = await payloadFor(
          harness,
          url ?? harness.url,
          audience,
          person,
        );
        if (sub === null) {
          throw new Error(`the Usher token for ${audience} names no subject`);
        }
        return [
          audience,
          await tagOfSubject(harness.application(audience), sub),
        ] as const;
      }),
    ),
  );

/**
 * The tag each audience computes for a subject named directly, as for a subject no Usher token has
 * named yet, or a notice written straight into the table.
 *
 * @param harness the harness.
 * @param subject the subject, as a notice names it.
 */
export const tagsOfSubject = async (
  harness: Harness,
  subject: string,
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(
      AUDIENCE_LABELS.map(
        async (audience) =>
          [
            audience,
            await tagOfSubject(harness.application(audience), subject),
          ] as const,
      ),
    ),
  );

/**
 * The cursor each audience reads with a head poll, the plan's c0.
 *
 * @param harness the harness.
 * @param url the instance polled: the harness's controller by default.
 */
export const headCursors = async (
  harness: Harness,
  url?: URL,
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(
      AUDIENCE_LABELS.map(
        async (audience) =>
          [
            audience,
            (
              await pollAll(url ?? harness.url, {
                application: harness.application(audience),
              })
            ).next,
          ] as const,
      ),
    ),
  );

/**
 * Every notice each audience's poll pages from its cursor until `more` is false.
 *
 * @param harness the harness.
 * @param cursors each audience's cursor, as {@link headCursors} reads them.
 * @param url the instance polled: the harness's controller by default.
 */
export const polledAfter = async (
  harness: Harness,
  cursors: Readonly<Record<string, string>>,
  url?: URL,
): Promise<Readonly<Record<string, readonly Notice[]>>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(cursors).map(
        async ([audience, after]) =>
          [
            audience,
            (
              await pollAll(url ?? harness.url, {
                after,
                application: harness.application(audience),
              })
            ).notices,
          ] as const,
      ),
    ),
  );

/**
 * The subject tags principal notices carry, in order.
 *
 * @param notices the notices.
 */
export const principalTags = (notices: readonly Notice[]): readonly string[] =>
  notices.flatMap((notice) =>
    notice.kind === 'principal' ? [notice.subjectTag] : [],
  );

/**
 * Each value once, in the order of its first appearance: the people a run of principal notices
 * names, however many notices one change wrote for a person.
 *
 * @param values the values.
 */
export const uniqueInOrder = (values: readonly string[]): readonly string[] =>
  values.filter((value, index) => values.indexOf(value) === index);

/**
 * The resources category notices name, in order.
 *
 * @param notices the notices.
 */
export const categoryResources = (
  notices: readonly Notice[],
): readonly string[] =>
  notices.flatMap((notice) =>
    notice.kind === 'category' ? [notice.resource] : [],
  );

/**
 * How many notices of a kind are among the notices.
 *
 * @param notices the notices.
 * @param kind the kind.
 */
export const countOfKind = (
  notices: readonly Notice[],
  kind: Notice['kind'],
): number => notices.filter((notice) => notice.kind === kind).length;

/**
 * The audiences whose notices carry a principal notice with the tag each audience computes for one
 * person, in {@link AUDIENCE_LABELS}' order.
 *
 * @param noticesByAudience each audience's notices.
 * @param tags the person's tag for each audience, as {@link tagsOf} gives them.
 */
export const audiencesNaming = (
  noticesByAudience: Readonly<Record<string, readonly Notice[]>>,
  tags: Readonly<Record<string, string>>,
): readonly string[] =>
  AUDIENCE_LABELS.filter((audience) =>
    principalTags(noticesByAudience[audience] ?? []).includes(
      tags[audience] ?? '',
    ),
  );

/**
 * Each audience's count of notices of one kind, in {@link AUDIENCE_LABELS}' order.
 *
 * @param noticesByAudience each audience's notices.
 * @param kind the kind.
 */
export const kindCounts = (
  noticesByAudience: Readonly<Record<string, readonly Notice[]>>,
  kind: Notice['kind'],
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    AUDIENCE_LABELS.map((audience) => [
      audience,
      countOfKind(noticesByAudience[audience] ?? [], kind),
    ]),
  );

/**
 * One value for every audience, to compare a record such as {@link kindCounts} gives with.
 *
 * @param value the value.
 */
export const everyAudience = <Value>(
  value: Value,
): Readonly<Record<string, Value>> =>
  Object.fromEntries(AUDIENCE_LABELS.map((audience) => [audience, value]));

/**
 * A notice as the bridge acts on it: its kind, and the tag or resource it names.
 *
 * @param notice the notice.
 */
export const describeNotice = (notice: Notice): string => {
  if (notice.kind === 'principal') {
    return `principal ${notice.subjectTag}`;
  }
  if (notice.kind === 'category') {
    return `category ${notice.resource}`;
  }
  return notice.kind;
};

/** A notice stream a test reads as it waits, every read kept with its arrival time. */
export interface CollectedStream {
  close(): Promise<void>;

  /** Reads whatever has already arrived, waiting for nothing more, and gives every notice read. */
  drain(): Promise<readonly Notice[]>;

  /** Reads until the stream ends or the time given passes, giving when the end was read, or `undefined`. */
  endedWithin(timeoutMs: number): Promise<number | undefined>;

  headers: Headers;

  /** Every notice read so far, in arrival order, each with its arrival time (`performance.now()`). */
  notices(): readonly { arrivedAt: number; notice: Notice }[];

  /** Every event read so far, malformed notices and heartbeats included. */
  reads(): readonly StreamRead[];

  status: number;

  /**
   * Reads until the notices read satisfy a condition, the stream ends, or the timeout passes, and
   * gives the notices read by then.
   */
  waitFor(
    condition: (notices: readonly Notice[]) => boolean,
    timeoutMs: number,
  ): Promise<readonly Notice[]>;
}

/**
 * Opens the notice stream as the bridge's push opens it and reads it through `nextWithin` whenever
 * the test waits, each read keeping the arrival time the stream gave it; the stream is closed once
 * the test ends.
 *
 * @param scope the test's cleanup.
 * @param url the instance.
 * @param request the application, the cursor and any departure from the bridge's request.
 */
export const collectStream = async (
  scope: Cleanup,
  url: URL,
  request: StreamRequest,
): Promise<CollectedStream> => {
  const stream: NoticeStream = await openStream(url, request);
  scope.defer(() => stream.close());
  const reads: StreamRead[] = [];
  const state: { end: StreamRead | undefined } = { end: undefined };
  const notices = (): readonly { arrivedAt: number; notice: Notice }[] =>
    reads.flatMap((read) =>
      read.kind === 'event' && read.notice?.kind === 'notice'
        ? [{ arrivedAt: read.arrivedAt, notice: read.notice.notice }]
        : [],
    );
  const noticesOnly = (): readonly Notice[] =>
    notices().map(({ notice }) => notice);
  const readUntil = async (
    deadline: number,
    done: () => boolean,
  ): Promise<void> => {
    if (done() || state.end !== undefined) {
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return;
    }
    const read = await stream.nextWithin(remaining);
    if (read === undefined) {
      return;
    }
    if (read.kind === 'event') {
      reads.push(read);
    } else {
      state.end = read;
    }
    await readUntil(deadline, done);
  };
  const waitFor = async (
    condition: (read: readonly Notice[]) => boolean,
    timeoutMs: number,
  ): Promise<readonly Notice[]> => {
    await readUntil(performance.now() + timeoutMs, () =>
      condition(noticesOnly()),
    );
    return noticesOnly();
  };
  return {
    close: () => stream.close(),
    drain: () => waitFor(() => false, 1),
    endedWithin: async (timeoutMs) => {
      await readUntil(performance.now() + timeoutMs, () => false);
      return state.end?.arrivedAt;
    },
    headers: stream.headers,
    notices,
    reads: () => [...reads],
    status: stream.status,
    waitFor,
  };
};

/** One page of a poll, with when it was sent and when its answer had been read. */
export interface TimedPage {
  /** When the answer had been read: `performance.now()`. */
  endedAt: number;

  page: PollResponse;

  /** When the page was asked for: `performance.now()`. */
  startedAt: number;
}

/**
 * Polls page by page from a cursor, or from head, while each page answers 200 and asks for more,
 * keeping every page and its timing. Stops at the first page that is not a readable 200, and throws
 * past the most pages given, so a controller that never stops asking for more ends the test.
 *
 * @param url the instance.
 * @param application the application polling.
 * @param after the cursor to start after; a head poll when absent.
 * @param options the most pages to take: 1,000 by default.
 */
export const pollPages = (
  url: URL,
  application: ControllerApplication,
  after?: string,
  { maximumPages = 1_000 }: { maximumPages?: number } = {},
): Promise<readonly TimedPage[]> => {
  const step = async (
    cursor: string | undefined,
    taken: readonly TimedPage[],
  ): Promise<readonly TimedPage[]> => {
    if (taken.length >= maximumPages) {
      throw new Error(
        `the poll still asked for more after ${maximumPages} pages`,
      );
    }
    const startedAt = performance.now();
    const page = await poll(url, {
      application,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    const all = [...taken, { endedAt: performance.now(), page, startedAt }];
    return page.answer?.kind === 'answer' && page.answer.answer.more
      ? step(page.answer.answer.next, all)
      : all;
  };
  return step(after, []);
};

/**
 * The notices of every page, in order.
 *
 * @param pages the pages.
 */
export const noticesOfPages = (
  pages: readonly TimedPage[],
): readonly Notice[] =>
  pages.flatMap(({ page }) =>
    page.answer?.kind === 'answer' ? page.answer.answer.notices : [],
  );

/** One field of an SSE event block: its name and its value. */
export type SseField = readonly [name: string, value: string];

/**
 * The fields of one SSE event block, as the text/event-stream format splits them: each non-empty
 * line that is not a comment, its name before the first colon and its value after it, one leading
 * space removed.
 *
 * @param block the block's text.
 */
export const sseFields = (block: string): readonly SseField[] =>
  block
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.length > 0 && !line.startsWith(':'))
    .map((line): SseField => {
      const separator = line.indexOf(':');
      if (separator === -1) {
        return [line, ''];
      }
      const value = line.slice(separator + 1);
      return [
        line.slice(0, separator),
        value.startsWith(' ') ? value.slice(1) : value,
      ];
    });

/**
 * Every notice in a raw stream's text, read as the bridge reads a pushed notice; a notice event that
 * does not read throws.
 *
 * @param text the stream's body so far.
 * @param application the application whose subkeys open it.
 */
export const rawNotices = async (
  text: string,
  application: ControllerApplication,
): Promise<readonly Notice[]> => {
  const reader = createChannelReader(
    await importApplicationKey(application.key),
  );
  const data: string[] = [];
  createParser({
    onEvent: (event) => {
      if (event.event === 'notice') {
        data.push(event.data);
      }
    },
  }).feed(text);
  const readings = await Promise.all(data.map((jwe) => reader.readNotice(jwe)));
  return readings.map((reading) => {
    if (reading.kind === 'notice') {
      return reading.notice;
    }
    throw new Error(`a pushed notice was ${reading.reason}`);
  });
};

/**
 * How many notice events a raw stream's text holds.
 *
 * @param text the stream's body so far.
 */
export const noticeEventCount = (text: string): number =>
  text.match(/^event: ?notice$/gmu)?.length ?? 0;

/**
 * Headers in a form two answers can be compared by: every header but `date`, by lower-case name,
 * sorted.
 *
 * @param headers the headers.
 */
export const comparableHeaders = (
  headers: Headers,
): readonly (readonly [string, string])[] =>
  [...headers.entries()]
    .filter(([name]) => name !== 'date')
    .sort(([first], [second]) => first.localeCompare(second));

/**
 * The media type of a `content-type` value, lower-cased, without its parameters.
 *
 * @param contentType the header's value, or `null` when absent.
 */
export const mediaType = (contentType: string | null | undefined): string =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/** The departures from the bridge's channel assertion a refusal test needs, signed under the rightful key. */
export interface AssertionDepartures {
  /** Claims over the bridge's; one set to `undefined` is left out. */
  claims?: Readonly<Record<string, unknown>>;

  /** Protected header members over `typ`; one set to `undefined` is left out. `alg` stays HS256. */
  header?: Readonly<Record<string, unknown>>;
}

const defined = (
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );

/**
 * A channel assertion the application signs itself, HS256 under its own assertion subkey, with the
 * bridge's claims (`iss` the application, `aud` `usher:controller`, `iat`, an `exp` 60 s on, a fresh
 * `jti`) and `typ` `usher-channel+jwt`, and a test's departures in its claims or `typ`.
 *
 * @param application the application.
 * @param departures the claims and header members a refusal test changes.
 */
export const signedAssertion = (
  application: ControllerApplication,
  { claims = {}, header = {} }: AssertionDepartures = {},
): Promise<string> => {
  const issuedAt = nowSeconds();
  return new CompactSign(
    new TextEncoder().encode(
      JSON.stringify(
        defined({
          aud: CHANNEL_ASSERTION_AUDIENCE,
          exp: issuedAt + CHANNEL_ASSERTION_LIFETIME_S,
          iat: issuedAt,
          iss: application.id,
          jti: randomUUID(),
          ...claims,
        }),
      ),
    ),
  )
    .setProtectedHeader({
      ...defined({ typ: CHANNEL_ASSERTION_TYPE, ...header }),
      alg: 'HS256',
    })
    .sign(subkeyBytes(application.key, SUBKEY_LABELS.channelAssertion));
};

/** A channel request's credential departing from the bridge's, named for the message of a failing check. */
export interface RefusedCredential {
  /** A channel assertion in place of a fresh one, or `null` for no `authorization` header. */
  assertion?: string | null;

  /** Headers over the request's, for an `authorization` of another scheme. */
  headers?: Readonly<Record<string, string>>;

  name: string;
}

/**
 * The channel credentials the controller must refuse that need no forged signature: none; another
 * scheme; and assertions the application signed itself with `typ` absent, `JWT`, `usher+jwt` or
 * `USHER-CHANNEL+JWT`, `aud` absent or another, an unknown `iss`, `exp` past or `iat` ahead by more
 * than the clock tolerance of at most 30 s, or an `exp` more than 60 s after `iat` (#210 Q12).
 *
 * @param application the application the request comes from.
 */
export const refusedCredentials = async (
  application: ControllerApplication,
): Promise<readonly RefusedCredential[]> => {
  const now = nowSeconds();
  const fresh = await freshAssertion(application);
  const signedWith = async (
    name: string,
    departures: AssertionDepartures,
  ): Promise<RefusedCredential> => ({
    assertion: await signedAssertion(application, departures),
    name,
  });
  return Promise.all([
    { assertion: null, name: 'no authorization' },
    { headers: { authorization: `Basic ${fresh}` }, name: 'the Basic scheme' },
    { headers: { authorization: `DPoP ${fresh}` }, name: 'the DPoP scheme' },
    signedWith('typ absent', { header: { typ: undefined } }),
    ...['JWT', 'usher+jwt', 'USHER-CHANNEL+JWT'].map((typ) =>
      signedWith(`typ ${typ}`, { header: { typ } }),
    ),
    signedWith('aud absent', { claims: { aud: undefined } }),
    signedWith('another aud', { claims: { aud: 'usher:bridge' } }),
    signedWith('an unknown iss', { claims: { iss: 'unknown-test' } }),
    signedWith('exp past by more than the tolerance', {
      claims: { exp: now - 40, iat: now - 100 },
    }),
    signedWith('iat ahead by more than the tolerance', {
      claims: { exp: now + 100, iat: now + 40 },
    }),
    signedWith('exp more than 60 s after iat', {
      claims: { exp: now + 61, iat: now },
    }),
  ]);
};

/**
 * A refused credential as the members of a poll's or a stream's request.
 *
 * @param credential the credential.
 */
export const credentialOf = ({
  assertion,
  headers,
}: RefusedCredential): Pick<ChannelRequest, 'assertion' | 'headers'> => ({
  ...(assertion === undefined ? {} : { assertion }),
  ...(headers === undefined ? {} : { headers }),
});

/**
 * Waits until every notice the store holds is older than a number of seconds, so a trim with that
 * floor reaches all of them.
 *
 * @param client a connection under the migration role.
 * @param seconds the age every notice must pass.
 * @returns whether they all aged past it within twice that time.
 */
export const untilNoticesOlderThan = (
  client: pg.ClientBase,
  seconds: number,
): Promise<boolean> =>
  eventually(
    async () => {
      const newest = Math.max(
        0,
        ...(await storedNoticesAfter(client)).map(({ createdAt }) =>
          Number(createdAt),
        ),
      );
      return Date.now() / 1000 - newest > seconds;
    },
    2 * seconds * 1000 + 2_000,
    200,
  );

/**
 * A time older than a harness's retention floor, for a notice the trimming function should reach.
 *
 * @param harness the harness, whose configuration gives the floor.
 */
export const pastTheFloor = (harness: Harness): Date =>
  new Date(
    Date.now() - 2 * retentionFloorSeconds(harness.configuration) * 1000,
  );

/**
 * Runs the trimming function as the controller's role, the one role it is granted to (R3), in a
 * transaction left open until `commit` is called, so a test can look from another connection before
 * the transaction ends.
 *
 * @param runtime a connection under the controller's runtime role, holding no transaction.
 * @returns the watermark the function returned, and the commit.
 */
export const trimNoticesOpen = async (
  runtime: pg.ClientBase,
): Promise<{ commit(): Promise<void>; trimmedThrough: bigint }> => {
  await runtime.query('BEGIN');
  try {
    const { rows } = await runtime.query<{ trimmed_through: string }>(
      `SELECT ${qualified({ name: POLICY_FUNCTIONS.trimNotices })}()::text AS trimmed_through`,
    );
    return {
      commit: async () => {
        await runtime.query('COMMIT');
      },
      trimmedThrough: BigInt(rows[0]?.trimmed_through ?? '0'),
    };
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }
};

/**
 * Runs the trimming function as the controller's role and commits.
 *
 * @param runtime a connection under the controller's runtime role, holding no transaction.
 * @returns the watermark the function returned.
 */
export const trimNotices = async (runtime: pg.ClientBase): Promise<bigint> => {
  const trim = await trimNoticesOpen(runtime);
  await trim.commit();
  return trim.trimmedThrough;
};

/**
 * Each notice's position with the commit time of the transaction that wrote it, in position order,
 * on a PostgreSQL tracking commit timestamps.
 *
 * @param client a connection under the migration role.
 */
export const commitTimesByPosition = async (
  client: pg.ClientBase,
): Promise<readonly { committedAt: Date; position: bigint }[]> => {
  const { notices } = POLICY_TABLES;
  const { rows } = await client.query<{
    committed_at: Date;
    position: string;
  }>(
    `SELECT ${pg.escapeIdentifier(notices.columns.position)}, pg_xact_commit_timestamp(xmin) AS committed_at FROM ${qualified(notices)} ORDER BY ${pg.escapeIdentifier(notices.columns.position)}`,
  );
  return rows.map(({ committed_at, position }) => ({
    committedAt: committed_at,
    position: BigInt(position),
  }));
};

/**
 * The records of a `sid` the controller keeps from the sign-in exchanges whose tokens carried it.
 *
 * @param client a connection under the migration role.
 * @param sid the session id.
 */
export const exchangedSidRecords = async (
  client: pg.ClientBase,
  sid: string,
): Promise<number> => {
  const { exchangedSids } = POLICY_TABLES;
  const { rows } = await client.query<{ records: number }>(
    `SELECT count(*)::int AS records FROM ${qualified(exchangedSids)} WHERE ${pg.escapeIdentifier(exchangedSids.columns.sid)} = $1`,
    [sid],
  );
  return rows[0]?.records ?? 0;
};
