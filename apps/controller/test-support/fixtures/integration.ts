import { SUSPENDED_HEADER } from '@overture-stack/usher-express-bridge';
import type {
  KeyRegistration,
  PermissionsPayload,
} from '@overture-stack/usher-types';
import pg from 'pg';

import {
  type AdminCaller,
  answerGrant,
  assertSucceeded,
  personCaller,
  revokeGrant,
} from '../admin.js';
import {
  AUDIT_EVENT_TYPES,
  type CloudEvent,
  cloudEventsIn,
  emittedType,
} from '../auditEvents.js';
import { KEY_REFETCH_COOLDOWN_MS } from '../clocks.js';
import {
  type DedicatedContainer,
  RELAYED_PATHS,
  type Relay,
  type RelayMode,
  startRelay,
} from '../containers.js';
import type { ControllerConfiguration } from '../controller.js';
import { exchange, PEOPLE, type Person, readUsherToken } from '../exchange.js';
import { type Harness, startHarness } from '../harness.js';
import type { IdentityProvider } from '../identityProvider.js';
import {
  type FixtureDecision,
  type FixtureGrant,
  mergedPolicy,
  OWNER_ROLE,
  POLICY_TABLES,
  type PolicyFixture,
  qualified,
  SEEDED_ROLES,
  seededId,
} from '../policy.js';
import type { EvaluatedRecord } from '../sqonEvaluator.js';
import {
  type BridgeTimingOverride,
  DEFAULT_RECORD_KEY,
  exchangedCredentialOf,
  requestsTo,
  resolvedBridgeTiming,
  type ResolvedBridgeTiming,
  SCHEDULING_SLACK_MS,
  type StartedBridge,
  startBridge,
  TIMING_PROFILES,
  type TimingProfileName,
  untilMode,
} from '../vendoredBridge.js';
import { type Cleanup, eventually } from '../waiting.js';

// #217's own fixture: the real bridge, through a relay, against the controller. Its applications, its
// resources and policy, the keys every bridge registers, the outage conditions the plan's causes table
// names, and the waits and probes its suites share.

/**
 * The two applications each integration harness registers, by label, each with a bridge of its own
 * when a test runs two.
 */
export const APPLICATIONS = Object.freeze({
  portal: 'arranger-prod',
  submission: 'lyric-example',
} as const);

/**
 * The labels of every application the integration fixture registers and seeds, each its display
 * name; `harness.application(label).id` is its id.
 */
export const APPLICATION_LABELS: readonly string[] = Object.freeze([
  APPLICATIONS.portal,
  APPLICATIONS.submission,
]);

/**
 * The fixture's resources by externalId, every one served by both applications: two open, the heart
 * study a test moves out of the open tier; two by grant, Ana and Bo holding a viewer grant on
 * `STUDY-A1`'s controlled records and nobody on `STUDY-B2`'s.
 */
export const RESOURCES = Object.freeze({
  a1: 'STUDY-A1',
  b2: 'STUDY-B2',
  c3: 'STUDY-C3',
  heart: 'HEART_STUDY',
} as const);

/** The fixture people who hold a viewer grant on `STUDY-A1`, each grant named after its holder. */
export type GrantHolder = 'ana' | 'bo';

const RESOURCE_FIELD = 'study_id';

const CATEGORY_FIELD = 'data_category';

const CONTROLLED_VALUE = 'controlled';

/** A category value no global category's condition matches, so a record holding it is unmarked. */
const UNMARKED_VALUE = 'general';

/**
 * The keys every integration bridge registers: one record key, `vendoredBridge.ts`'s default record
 * key, its resource in `study_id`, defining `global.controlled` on `data_category`, the one global
 * category the fixture registers.
 */
export const INTEGRATION_KEYS: Readonly<Record<string, KeyRegistration>> =
  Object.freeze({
    [DEFAULT_RECORD_KEY]: {
      categories: {
        global: {
          'global.controlled': {
            content: { fieldName: CATEGORY_FIELD, value: [CONTROLLED_VALUE] },
            op: 'in',
          },
        },
      },
      kind: 'record',
      resourceFieldName: RESOURCE_FIELD,
    },
  });

/**
 * A record of a resource in its controlled category, which only a grant on that category reaches.
 *
 * @param resource the resource's externalId.
 */
export const controlledRecord = (resource: string): EvaluatedRecord => ({
  [CATEGORY_FIELD]: CONTROLLED_VALUE,
  [RESOURCE_FIELD]: resource,
});

/**
 * An unmarked record of a resource, which its base tier decides: everyone's for an open resource.
 *
 * @param resource the resource's externalId.
 */
export const unmarkedRecord = (resource: string): EvaluatedRecord => ({
  [CATEGORY_FIELD]: UNMARKED_VALUE,
  [RESOURCE_FIELD]: resource,
});

/** The compressed profile's bridge timing, each letter of #217's plan resolved. */
export const COMPRESSED: ResolvedBridgeTiming =
  resolvedBridgeTiming('compressed');

/** The iMS profile's bridge timing: the bridge's defaults. */
export const IMS: ResolvedBridgeTiming = resolvedBridgeTiming('ims');

/** The bound O13's "within seconds" takes on loopback (#217 Q8). */
export const DELIVERY_BOUND_MS = 2_000;

/** How far after the grace period a lapse may be logged (#217's plan, `modes.ts`). */
export const LAPSE_TOLERANCE_MS = 100;

/**
 * How much earlier than its recorded request a check's start may be read: the bridge reads its
 * monotonic clock, then signs a channel assertion, then starts the request the fetch records.
 */
export const CHECK_START_TOLERANCE_MS = 100;

/** How soon after a reason to poll at once the bridge's poll starts. */
export const AT_ONCE_MS = 100;

/** How long a bridge may take from its start to normal while the controller answers. */
export const STARTUP_BOUND_MS = 5_000;

/** How long a restarted or restored controller and a bridge's next check may take to bring the bridge back to normal. */
export const RECOVERY_BOUND_MS = 15_000;

/** A sign-in token's lifetime long enough that it never expires in a test, within what the harness accepts. */
export const LONG_SIGN_IN_SECONDS = 3_600;

const OWNED_RESOURCES = Object.freeze([
  RESOURCES.heart,
  RESOURCES.a1,
  RESOURCES.b2,
  RESOURCES.c3,
]);

const SEEDED_PEOPLE = Object.freeze(['ana', 'bo', 'cy', 'owner'] as const);

const ownerGrantName = (externalId: string): string => `owner:${externalId}`;

const accepted = (grant: string): FixtureDecision => ({
  decision: 'accepted',
  grant,
});

const viewerGrant = (user: string, resource: string): FixtureGrant => ({
  category: 'controlled',
  holder: { user },
  resource,
  role: 'viewer',
});

/**
 * The integration fixture with a test's own policy over it. Ana, Bo, Cy and the owner are users;
 * `controlled` is the one global category; the four resources carry their base tiers and are served
 * by both applications; the owner holds an accepted owner grant on each, since only an owner gives
 * others access to data (#212 Q4); and Ana and Bo each hold an accepted viewer grant on `STUDY-A1`'s
 * controlled records, named `ana` and `bo`.
 *
 * @param policy the test's own entries, merged over the fixture's by name.
 */
export const integrationPolicy = (policy: PolicyFixture = {}): PolicyFixture =>
  mergedPolicy(
    {
      applications: Object.fromEntries(
        APPLICATION_LABELS.map((label) => [label, { serves: OWNED_RESOURCES }]),
      ),
      categories: { controlled: { description: 'Controlled access' } },
      decisions: [
        ...OWNED_RESOURCES.map((externalId) =>
          accepted(ownerGrantName(externalId)),
        ),
        accepted('ana'),
        accepted('bo'),
      ],
      grants: {
        ...Object.fromEntries(
          OWNED_RESOURCES.map((externalId): [string, FixtureGrant] => [
            ownerGrantName(externalId),
            {
              category: null,
              holder: { user: 'owner' },
              resource: externalId,
              role: OWNER_ROLE,
            },
          ]),
        ),
        ana: viewerGrant('ana', RESOURCES.a1),
        bo: viewerGrant('bo', RESOURCES.a1),
      },
      resources: {
        [RESOURCES.heart]: { baseTier: 'open', name: 'Heart study' },
        [RESOURCES.a1]: { baseTier: 'grant', name: 'Study A1' },
        [RESOURCES.b2]: { baseTier: 'grant', name: 'Study B2' },
        [RESOURCES.c3]: { baseTier: 'open', name: 'Study C3' },
      },
      users: Object.fromEntries(
        SEEDED_PEOPLE.map((name) => [name, { subject: PEOPLE[name].subject }]),
      ),
    },
    policy,
  );

/**
 * A policy adding a pending viewer grant to a fixture user on a resource's controlled records: written,
 * never answered.
 *
 * @param name the grant's name in the fixture.
 * @param user the holder's fixture name.
 * @param resource the resource's externalId.
 */
export const pendingViewerGrant = (
  name: string,
  user: string,
  resource: string,
): PolicyFixture => ({ grants: { [name]: viewerGrant(user, resource) } });

/** What an integration harness is started with beyond the fixture. */
export interface IntegrationOptions {
  /** Fields over the profile's controller half, last, so a test can set any of them. */
  configuration?: Partial<ControllerConfiguration>;

  /** The test's own policy, merged over {@link integrationPolicy}'s. */
  policy?: PolicyFixture;

  /** A PostgreSQL of the test's own, for a test pausing or stopping the database. */
  postgresql?: DedicatedContainer;

  /** The timing profile whose controller half the harness takes: `compressed` by default. */
  profile?: TimingProfileName;
}

/** A harness serving the integration fixture, and the relay every bridge reaches it through. */
export interface Integration {
  harness: Harness;
  relay: Relay;
}

/**
 * A loopback HTTP relay to a controller, aware of the bridge's paths, stopped once the test ends.
 *
 * @param scope the test's cleanup.
 * @param url the controller's URL.
 */
export const relayTo = async (scope: Cleanup, url: URL): Promise<Relay> => {
  const relay = await startRelay(url.href, { protocol: 'http' });
  scope.defer(() => relay.stop());
  return relay;
};

// The store connections the integration harness's instance holds for the token exchange: enough for
// the largest burst of exchanges an integration test sends at once, 50, beyond the controller's
// default of 10.
const INTEGRATION_EXCHANGE_CONNECTIONS = 60;

/**
 * Starts a harness serving both applications, seeded with the integration fixture, on a profile's
 * controller timing from the typed configuration (#217 Q2) and an exchange pool of 60 connections
 * unless the test's configuration sets another, and a relay in front of it; defers their stops.
 *
 * @param scope the test's cleanup.
 * @param options the configuration, the policy, a PostgreSQL of the test's own and the profile.
 */
export const startIntegration = async (
  scope: Cleanup,
  {
    configuration = {},
    policy = {},
    postgresql,
    profile = 'compressed',
  }: IntegrationOptions = {},
): Promise<Integration> => {
  const harness = await startHarness({
    applications: APPLICATION_LABELS,
    configuration: {
      databaseExchangeConnections: INTEGRATION_EXCHANGE_CONNECTIONS,
      ...TIMING_PROFILES[profile].controller,
      ...configuration,
    },
    fixture: integrationPolicy(policy),
    ...(postgresql === undefined ? {} : { postgresql }),
  });
  scope.defer(() => harness.stop());
  const relay = await relayTo(scope, harness.url);
  return { harness, relay };
};

/** What a relayed bridge is started with beyond the harness and the relay. */
export interface RelayedBridgeOptions {
  /** The application it serves: `arranger-prod` by default. */
  application?: string;

  /** Its timing profile: `compressed` by default. */
  profile?: TimingProfileName;

  /** Settings over the profile's, such as a longer exchange timeout: none by default. */
  timing?: BridgeTimingOverride;

  /** Its wall clock, such as one running ahead of the controller's: the system's by default. */
  wallClock?: { now(): number };
}

/**
 * Starts the bridge through support's starter, with the recording fetch and logger,
 * reaching the controller through the relay, registering {@link INTEGRATION_KEYS}; defers its stop.
 *
 * @param scope the test's cleanup.
 * @param harness the harness whose application, key and issuer it takes.
 * @param relay the relay it reaches the controller through.
 * @param options the application, the profile, a timing override and the wall clock.
 */
export const startRelayedBridge = async (
  scope: Cleanup,
  harness: Harness,
  relay: Relay,
  {
    application = APPLICATIONS.portal,
    profile = 'compressed',
    timing = {},
    wallClock,
  }: RelayedBridgeOptions = {},
): Promise<StartedBridge> => {
  const bridge = await startBridge({
    application: harness.application(application),
    controllerUrl: new URL(relay.url),
    issuer: harness.configuration.issuer,
    profile,
    registrations: INTEGRATION_KEYS,
    timing,
    ...(wallClock === undefined ? {} : { wallClock }),
  });
  scope.defer(() => bridge.stop());
  return bridge;
};

/**
 * Starts an integration harness and one bridge for `arranger-prod` through its relay, and waits for
 * the bridge to turn normal.
 *
 * @param scope the test's cleanup.
 * @param options the harness's options, and the bridge's.
 */
export const startNormalBridge = async (
  scope: Cleanup,
  options: IntegrationOptions & { bridge?: RelayedBridgeOptions } = {},
): Promise<Integration & { bridge: StartedBridge }> => {
  const integration = await startIntegration(scope, options);
  const bridge = await startRelayedBridge(
    scope,
    integration.harness,
    integration.relay,
    options.bridge,
  );
  await untilMode(bridge, 'normal', STARTUP_BOUND_MS);
  return { ...integration, bridge };
};

/**
 * A person's sign-in token for an application, from the harness's stand-in.
 *
 * @param harness the harness.
 * @param person who signs in.
 * @param options the application, `arranger-prod` by default, and the lifetime, an hour by default.
 */
export const signInFor = (
  harness: Harness,
  person: Person,
  {
    application = APPLICATIONS.portal,
    lifetimeSeconds = LONG_SIGN_IN_SECONDS,
  }: { application?: string; lifetimeSeconds?: number } = {},
): Promise<string> =>
  harness.tokens.signIn(person, { application, mint: { lifetimeSeconds } });

/**
 * The owner of every fixture resource, as a caller of the controller itself, never the relay. A test
 * timing a change builds its caller first, so minting the token falls outside the time measured.
 *
 * @param harness the harness.
 * @param url the instance called: the harness's controller by default.
 */
export const ownerOf = (harness: Harness, url?: URL): Promise<AdminCaller> =>
  personCaller(harness, PEOPLE.owner, url === undefined ? {} : { url });

/**
 * Revokes a fixture holder's viewer grant on `STUDY-A1` as the caller given, at the controller itself,
 * and fails unless the revocation succeeded.
 *
 * @param caller the resource's owner, from {@link ownerOf}.
 * @param harness the harness.
 * @param holder whose grant.
 */
export const revokeHeldGrant = async (
  caller: AdminCaller,
  harness: Harness,
  holder: GrantHolder,
): Promise<void> => {
  assertSucceeded(
    await revokeGrant(caller, seededId(harness.seeded.grants, holder)),
    `the revocation of ${holder}'s grant`,
  );
};

/**
 * Accepts a fixture grant as its holder, shown what the seeded `viewer` carries, at the controller
 * itself, and fails unless the decision succeeded.
 *
 * @param caller the holder.
 * @param harness the harness.
 * @param grant the grant's name in the fixture.
 */
export const acceptAsHolder = async (
  caller: AdminCaller,
  harness: Harness,
  grant: string,
): Promise<void> => {
  assertSucceeded(
    await answerGrant(caller, seededId(harness.seeded.grants, grant), {
      capabilities: SEEDED_ROLES.viewer.capabilities,
      decision: 'accepted',
    }),
    `the acceptance of ${grant}`,
  );
};

/**
 * The anonymous payload the controller issues an application now, exchanged with it directly: a
 * probe of what a bridge would have fetched, never a bridge's own request.
 *
 * @param harness the harness.
 * @param application the application's label.
 */
export const anonymousPayloadNow = async (
  harness: Harness,
  application: string,
): Promise<PermissionsPayload> => {
  const configured = harness.application(application);
  const answer = await exchange(harness.url, { application: configured });
  const reading = await readUsherToken(answer.body, {
    application: configured,
    issuer: harness.configuration.issuer,
  });
  if (answer.status === 200 && reading.kind === 'payload') {
    return reading.payload;
  }
  throw new Error(
    `the anonymous exchange for ${application} was answered ${answer.status}`,
  );
};

/** How the bridge's Express layer answered one request, its body read to the end. */
export interface LayerAnswer {
  status: number;

  /** The `Usher-Suspended` header's value, or `null` when absent. */
  suspended: string | null;
}

/**
 * Sends one request to a bridge's loopback app, as a client of the host would, and reads its answer
 * to the end.
 *
 * @param bridge the bridge.
 * @param credential the bearer credential, or `null` for an anonymous request.
 */
export const requestThrough = async (
  bridge: StartedBridge,
  credential: string | null,
): Promise<LayerAnswer> => {
  const answered = await fetch(bridge.url, {
    headers:
      credential === null ? {} : { authorization: `Bearer ${credential}` },
  });
  await answered.text();
  return {
    status: answered.status,
    suspended: answered.headers.get(SUSPENDED_HEADER),
  };
};

/**
 * Waits until a bridge has started a number of requests to one of its paths since an instant.
 *
 * @param bridge the bridge.
 * @param path one of `RELAYED_PATHS`.
 * @param since the earliest start, by `performance.now()`.
 * @param count how many.
 * @param timeoutMs how long to wait.
 * @throws naming the path and the count, when fewer started in time.
 */
export const untilRequests = async (
  bridge: StartedBridge,
  path: string,
  since: number,
  count: number,
  timeoutMs: number,
): Promise<void> => {
  const reached = await eventually(
    () => Promise.resolve(requestsTo(bridge, path, since).length >= count),
    timeoutMs,
    5,
  );
  if (!reached) {
    throw new Error(
      `the bridge started ${requestsTo(bridge, path, since).length} of ${count} requests to ${path} within ${timeoutMs} ms`,
    );
  }
};

/**
 * How many exchanges a bridge started since an instant carried one of the credentials given, read
 * from each exchange's recorded body.
 *
 * @param bridge the bridge.
 * @param credentials the credentials looked for.
 * @param since the earliest start, by `performance.now()`.
 */
export const exchangesCarrying = (
  bridge: StartedBridge,
  credentials: readonly string[],
  since: number,
): number =>
  requestsTo(bridge, RELAYED_PATHS.exchange, since).filter((request) =>
    credentials.includes(exchangedCredentialOf(request) ?? ''),
  ).length;

/**
 * Starts grouped into runs: a start within a gap of the one before it joins its run, as a failed poll
 * and its immediate retry do.
 *
 * @param starts the starts, in order.
 * @param gapMs the widest gap within one run.
 */
export const runsOf = (
  starts: readonly number[],
  gapMs: number,
): readonly (readonly number[])[] =>
  starts.reduce<readonly (readonly number[])[]>((runs, start) => {
    const last = runs.at(-1);
    const previous = last?.at(-1);
    return last !== undefined &&
      previous !== undefined &&
      start - previous <= gapMs
      ? [...runs.slice(0, -1), [...last, start]]
      : [...runs, [start]];
  }, []);

/**
 * The gaps between consecutive starts.
 *
 * @param starts the starts, in order.
 */
export const gapsOf = (starts: readonly number[]): readonly number[] =>
  starts.slice(1).map((start, index) => start - (starts[index] ?? start));

/** One way the controller becomes unreachable, slow or degraded, from #217's causes table. */
export interface OutageCondition {
  /** Causes it. */
  cause(): Promise<void>;

  /** Ends it; nothing happens when it is not in force. */
  end(): Promise<void>;
}

/** The conditions of #217's causes table a test can cause, by name. */
export type OutageConditionName =
  | 'channelHeldBack'
  | 'crashed'
  | 'databasePaused'
  | 'databaseStopped'
  | 'delayedBeyondDeadline'
  | 'delayedWithinDeadline'
  | 'frozen'
  | 'identityProviderDown'
  | 'pacedStream'
  | 'refused'
  | 'reset'
  | 'stopped'
  | 'valkeyDown';

/** What the conditions act on. */
export interface ConditionTargets {
  harness: Harness;

  /** The test's own PostgreSQL, which `databasePaused` and `databaseStopped` need. */
  postgresql?: DedicatedContainer;

  relay: Relay;

  /** The test's own Valkey, the harness's cache, which `valkeyDown` needs. */
  valkey?: DedicatedContainer;
}

const PASS: RelayMode = Object.freeze({ kind: 'pass' });

const needed = (
  container: DedicatedContainer | undefined,
  what: string,
): DedicatedContainer => {
  if (container !== undefined) {
    return container;
  }
  throw new Error(`the condition needs a ${what} of the test's own`);
};

const inForceOnce = (
  scope: Cleanup,
  cause: () => Promise<void>,
  end: () => Promise<void>,
): OutageCondition => {
  const state = { inForce: false };
  const ending = async (): Promise<void> => {
    if (state.inForce) {
      state.inForce = false;
      await end();
    }
  };
  scope.defer(ending);
  return {
    cause: async () => {
      state.inForce = true;
      await cause();
    },
    end: ending,
  };
};

/**
 * Every condition of #217's causes table but a restore and trimmed history, each caused through
 * support's relay, the harness's controller, the stand-in or a container of the test's own, and each
 * ended, if still in force, once the test ends, before anything deferred earlier stops:
 * - `stopped`: the controller stopped through the harness;
 * - `crashed`: the relay resetting every connection, then the controller stopped;
 * - `frozen`: the relay freezing every path (hung, or a network cut);
 * - `databasePaused`: the controller running with its PostgreSQL paused (hung);
 * - `databaseStopped`: the controller running with its PostgreSQL stopped, refusing connections;
 * - `refused`: the relay closing what is open and refusing every connection (a network cut);
 * - `reset`: the relay resetting every connection (a network cut);
 * - `delayedWithinDeadline` and `delayedBeyondDeadline`: every answer's start held 0.6 D, or 2 D (slow);
 * - `pacedStream`: the stream's chunks spaced by twice the push's idle timeout (slow);
 * - `channelHeldBack`: the relay freezing the poll and the push, passing the exchange;
 * - `identityProviderDown`: the stand-in refusing connections;
 * - `valkeyDown`: the test's own Valkey stopped.
 * Each mode for every path replaces each path's own, as the relay's latest mode wins.
 *
 * @param scope the test's cleanup.
 * @param targets the harness, the relay, and the containers of the test's own.
 * @param timing the bridge's timing, which the slow conditions are measured against.
 */
export const outageConditions = (
  scope: Cleanup,
  { harness, postgresql, relay, valkey }: ConditionTargets,
  timing: ResolvedBridgeTiming = COMPRESSED,
): Readonly<Record<OutageConditionName, OutageCondition>> => {
  const everyPath = (mode: RelayMode) => (): Promise<void> =>
    relay.setMode(mode);
  const channelPaths = (mode: RelayMode) => async (): Promise<void> => {
    await relay.setMode(mode, RELAYED_PATHS.notices);
    await relay.setMode(mode, RELAYED_PATHS.stream);
  };
  const everyPathPasses = everyPath(PASS);
  return {
    channelHeldBack: inForceOnce(
      scope,
      channelPaths({ kind: 'freeze' }),
      channelPaths(PASS),
    ),
    crashed: inForceOnce(
      scope,
      async () => {
        await relay.setMode({ kind: 'reset' });
        await harness.stopController();
      },
      async () => {
        await harness.startController();
        await everyPathPasses();
      },
    ),
    databasePaused: inForceOnce(
      scope,
      () => needed(postgresql, 'PostgreSQL').pause(),
      () => needed(postgresql, 'PostgreSQL').unpause(),
    ),
    databaseStopped: inForceOnce(
      scope,
      () => needed(postgresql, 'PostgreSQL').stop(),
      () => needed(postgresql, 'PostgreSQL').restart(),
    ),
    delayedBeyondDeadline: inForceOnce(
      scope,
      everyPath({ kind: 'delay', ms: 2 * timing.pollDeadlineMs }),
      everyPathPasses,
    ),
    delayedWithinDeadline: inForceOnce(
      scope,
      everyPath({ kind: 'delay', ms: 0.6 * timing.pollDeadlineMs }),
      everyPathPasses,
    ),
    frozen: inForceOnce(scope, everyPath({ kind: 'freeze' }), everyPathPasses),
    identityProviderDown: inForceOnce(
      scope,
      () => harness.identityProvider.refuseConnections(),
      () => harness.identityProvider.acceptConnections(),
    ),
    pacedStream: inForceOnce(
      scope,
      () =>
        relay.setMode(
          { kind: 'pace', ms: 2 * timing.pushIdleMs },
          RELAYED_PATHS.stream,
        ),
      () => relay.setMode(PASS, RELAYED_PATHS.stream),
    ),
    refused: inForceOnce(scope, everyPath({ kind: 'close' }), everyPathPasses),
    reset: inForceOnce(scope, everyPath({ kind: 'reset' }), everyPathPasses),
    stopped: inForceOnce(
      scope,
      () => harness.stopController(),
      () => harness.startController(),
    ),
    valkeyDown: inForceOnce(
      scope,
      () => needed(valkey, 'Valkey').stop(),
      () => needed(valkey, 'Valkey').restart(),
    ),
  };
};

/**
 * Lets the exchange and the poll through a relay whose every path refuses, keeping the push refused:
 * how a test ends a network cut for everything but the push, so only the poll can carry what the cut
 * held back.
 *
 * @param relay the relay.
 */
export const passAllButThePush = async (relay: Relay): Promise<void> => {
  await relay.setMode(PASS, RELAYED_PATHS.exchange);
  await relay.setMode(PASS, RELAYED_PATHS.notices);
};

/** The stand-in's signing key rotated, and the stand-in refusing connections, until restored. */
export interface IdentityProviderOutage {
  /** Accepts connections again, then moves the controller's clock past the signing-key cache's refetch cooldown once more. */
  restore(): Promise<void>;
}

/**
 * Takes the identity provider away from the controller with a key it lacks: the stand-in rotates to a
 * new signing key, published as Keycloak publishes one, which the controller has not fetched, then
 * refuses every connection, and the controller's clock moves past the refetch cooldown (#208 Q5), so a
 * sign-in token signed with the new key sends the controller to the provider it can't reach. Restoring
 * accepts connections again and moves the clock past the cooldown once more, so the next exchange
 * fetches the key. The controller's clock then runs about 61 s ahead: inside a channel assertion's
 * 60 s life and the controller's 30 s tolerance on it (#215 Q9), so the bridge's assertions are still
 * accepted. Connections are accepted again once the test ends, if still refused.
 *
 * @param scope the test's cleanup.
 * @param provider the harness's stand-in.
 * @param advance moves the controller's configured clock forward.
 */
export const identityProviderOutage = async (
  scope: Cleanup,
  provider: IdentityProvider,
  advance: (milliseconds: number) => void,
): Promise<IdentityProviderOutage> => {
  await provider.rotate();
  const state = { refusing: true };
  const accept = async (): Promise<void> => {
    if (state.refusing) {
      state.refusing = false;
      await provider.acceptConnections();
    }
  };
  scope.defer(accept);
  await provider.refuseConnections();
  advance(KEY_REFETCH_COOLDOWN_MS + SCHEDULING_SLACK_MS);
  return {
    restore: async () => {
      await accept();
      advance(KEY_REFETCH_COOLDOWN_MS + SCHEDULING_SLACK_MS);
    },
  };
};

/**
 * The accepted or refused `token.exchange` events among the controller's log lines that name a
 * subject as their actor: every exchange of a signed-in credential the controller answered.
 *
 * @param lines the controller's log lines.
 * @param subjects the subjects looked for.
 */
export const exchangesNaming = (
  lines: readonly string[],
  subjects: readonly string[],
): readonly CloudEvent[] =>
  cloudEventsIn(lines).filter(
    ({ data, type }) =>
      type === emittedType(AUDIT_EVENT_TYPES.tokenExchange) &&
      typeof data === 'object' &&
      data !== null &&
      subjects.includes(String(Reflect.get(data, 'actorId'))),
  );

/**
 * The policy generation the store holds now (R6), read under the migration role, for a test that
 * needs a later change to reuse a generation number an abandoned timeline used.
 *
 * @param harness the harness.
 */
export const storedGeneration = async (harness: Harness): Promise<string> => {
  const { columns } = POLICY_TABLES.policyGeneration;
  const { rows } = await harness.clients.migration.query<{
    generation: string;
  }>(
    `SELECT ${pg.escapeIdentifier(columns.generation)}::text AS generation FROM ${qualified(POLICY_TABLES.policyGeneration)}`,
  );
  const [row] = rows;
  if (row !== undefined) {
    return row.generation;
  }
  throw new Error('policy_generation holds no row');
};
