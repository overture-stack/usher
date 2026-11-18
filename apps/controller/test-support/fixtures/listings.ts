import { randomBytes } from 'node:crypto';
import { after } from 'node:test';

import { type AdminCaller, type GrantView, instantOf } from '../admin.js';
import {
  addressKeycloakRealm,
  type KeycloakDirectory,
  type KeycloakPerson,
  type KeycloakRealm,
  type KeycloakRealmOptions,
  startKeycloak,
} from '../containers.js';
import type { ControllerConfiguration } from '../controller.js';
import { type Harness, realmAdministrator, startHarness } from '../harness.js';
import {
  type FixtureDecision,
  type FixtureGrant,
  type FixtureUser,
  mergedPolicy,
  type PolicyFixture,
  type ResourceTimes,
  seededId,
} from '../policy.js';
import { type Cleanup, eventually, suiteCleanup } from '../waiting.js';

// The listing suites' own fixture (#213): a real Keycloak holding the cast, and the policy the plan
// seeds. The listing's answers, parameters and refusals are read through admin.ts.

/**
 * The application every listing world registers and seeds, by display name, serving the main world's
 * studies.
 */
export const APPLICATION = 'arranger-test';

/** The client the realm's management tokens are issued to, the harness's first management client. */
export const MANAGEMENT_CLIENT = 'usher-ui-test';

/** The realm client whose service account the Controller's directory reads people through. */
export const DIRECTORY_CLIENT = 'usher-directory';

/** The main world's studies, by externalId. */
export const STUDIES = Object.freeze({
  a1: 'STUDY-A1',
  b2: 'STUDY-B2',
  c3: 'STUDY-C3',
} as const);

/** A study id no world registers. */
export const MISSING_STUDY = 'STUDY-ZZ';

/** The retired study of the retirement world (#320 B, #213 Q10). */
export const RETIRED_STUDY = 'STUDY-R9';

/** An address no account of the realm holds. */
export const NOBODY_ADDRESS = 'nobody@example.org';

/** The address of the main world's pending invitation, which no account holds. */
export const INVITEE_ADDRESS = 'invitee@example.org';

/** How a sharer with neither a given nor a family name is named (#213 Q9). */
export const UNNAMED_SHARER = 'a data steward';

/** The capabilities the seeded `submitter` role carries, as `entity.action` names (permissions-model.md). */
export const SUBMITTER_CAPABILITIES: readonly string[] = Object.freeze([
  'record.create',
  'record.update',
]);

/**
 * What Bo was shown when he accepted his `STUDY-A1` grant: more than the role carries now, as after
 * the role was narrowed, which applies at once, so a listing showing the role's current capabilities
 * in its place is told apart from one showing the decision's record.
 */
export const BO_SHOWN_CAPABILITIES: readonly string[] = Object.freeze([
  'record.create',
  'record.delete',
  'record.update',
]);

/** The categories a listing names, as the payload names them (#214 Q7). */
export const CATEGORIES = Object.freeze({
  controlled: 'global.controlled',
  unmarked: 'global.unmarked',
} as const);

/** A cast member's name in the listing suites. */
export type CastName =
  | 'administrator'
  | 'ana'
  | 'bo'
  | 'cy'
  | 'dee'
  | 'eve'
  | 'fay'
  | 'gil'
  | 'hal'
  | 'holdsNothing'
  | 'outsider'
  | 'quinn';

/**
 * Each cast member's username, which is also their address. The administrator, Bo and the account
 * holding nothing are the address realm's own (`admin.one@`, `sub.bo@`, `abo@`); the rest are added
 * to it. Fay's account is deleted once her subject is known, so the seed holds a grant whose holder
 * the directory no longer knows.
 */
export const CAST: Readonly<Record<CastName, string>> = Object.freeze({
  administrator: 'admin.one@example.org',
  ana: 'ana@example.org',
  bo: 'sub.bo@example.org',
  cy: 'cy@example.org',
  dee: 'dee@example.org',
  eve: 'eve@example.org',
  fay: 'fay@example.org',
  gil: 'gil@example.org',
  hal: 'hal@example.org',
  holdsNothing: 'abo@example.org',
  outsider: 'outsider@example.org',
  quinn: 'quinn@example.org',
});

/** Every cast member's name. */
export const CAST_NAMES: readonly CastName[] = Object.freeze(
  Object.keys(CAST).filter((name): name is CastName =>
    Object.hasOwn(CAST, name),
  ),
);

/** The full name a sharer with a given and a family name is shown by (#213 Q9). */
export const HAL_NAME = 'Hal Example';

/** Ana's full name, as a granter is shown to an owner (#213 Q7). */
export const ANA_NAME = 'Ana Example';

interface AddedPerson {
  firstName: string | null;
  lastName: string | null;
  name: CastName;

  /** Realm roles beside Keycloak's defaults. */
  realmRoles?: readonly string[];
}

// Quinn's username is their address and they have neither name (#213 Q9). Quinn never signs in,
// since Keycloak may refuse a person with no names a direct access grant.
const ADDED_PEOPLE: readonly AddedPerson[] = Object.freeze([
  { firstName: 'Ana', lastName: 'Example', name: 'ana' },
  { firstName: 'Cy', lastName: 'Example', name: 'cy' },
  { firstName: 'Dee', lastName: 'Example', name: 'dee' },
  { firstName: 'Eve', lastName: 'Example', name: 'eve' },
  { firstName: 'Fay', lastName: 'Example', name: 'fay' },
  { firstName: 'Gil', lastName: 'Example', name: 'gil' },
  { firstName: 'Hal', lastName: 'Example', name: 'hal' },
  { firstName: 'Olu', lastName: 'Example', name: 'outsider' },
  {
    firstName: null,
    lastName: null,
    name: 'quinn',
    realmRoles: ['usher-platform-admin'],
  },
]);

const randomPassword = (): string => randomBytes(24).toString('base64url');

/**
 * The address realm with the listing cast added: Ana, Cy, Dee, Eve, Fay, Gil, Hal and the outsider
 * with given and family names, and Quinn, an administrator with neither.
 */
export const listingRealmOptions = (): KeycloakRealmOptions => {
  const base = addressKeycloakRealm();
  const added = ADDED_PEOPLE.map(
    ({ firstName, lastName, name, realmRoles }): KeycloakPerson => ({
      email: CAST[name],
      firstName,
      lastName,
      password: randomPassword(),
      ...(realmRoles === undefined ? {} : { realmRoles }),
      username: CAST[name],
    }),
  );
  return { ...base, people: [...base.people, ...added] };
};

/** A Keycloak holding the listing cast, each member's subject learned from it. */
export interface ListingRealm {
  /** The configuration fields pointing a Controller's directory at the realm. */
  directory: KeycloakDirectory;

  keycloak: KeycloakRealm;

  /** What the realm was set up with, its administrator among its people. */
  options: KeycloakRealmOptions;

  /**
   * Every name a listing could show a cast member by once the directory has resolved them, as a
   * sharer is named (#213 Q9): given and family names together, or {@link UNNAMED_SHARER} for one
   * with neither.
   */
  resolvedNames: readonly string[];

  /** Signs a cast member in through the management client, answering their access token. */
  signIn(name: CastName): Promise<string>;

  /** A cast member's subject, as Keycloak's tokens and directory name them. */
  subject(name: CastName): string;
}

// realmImport writes `Synthetic` and `Person` where a person's options leave a name out, and none
// where they give `null`, as KeycloakPerson documents.
const shownNameOf = ({ firstName, lastName }: KeycloakPerson): string => {
  const names = [
    firstName === undefined ? 'Synthetic' : firstName,
    lastName === undefined ? 'Person' : lastName,
  ].filter((name): name is string => typeof name === 'string' && name !== '');
  return names.length > 0 ? names.join(' ') : UNNAMED_SHARER;
};

const learnedRealm = async (
  keycloak: KeycloakRealm,
  options: KeycloakRealmOptions,
): Promise<ListingRealm> => {
  const subjects = new Map<CastName, string>(
    await Promise.all(
      CAST_NAMES.map(
        async (name) => [name, await keycloak.subject(CAST[name])] as const,
      ),
    ),
  );
  await keycloak.deleteUser(CAST.fay);
  const personOf = (name: CastName): KeycloakPerson => {
    const person = options.people.find(
      ({ username }) => username === CAST[name],
    );
    if (person !== undefined) {
      return person;
    }
    throw new Error(`the realm's options hold no ${name}`);
  };
  return {
    directory: keycloak.directoryFor(DIRECTORY_CLIENT),
    keycloak,
    options,
    resolvedNames: [
      ...new Set(CAST_NAMES.map((name) => shownNameOf(personOf(name)))),
    ],
    signIn: async (name) =>
      (await keycloak.signIn(MANAGEMENT_CLIENT, personOf(name))).accessToken,
    subject: (name) => {
      const subject = subjects.get(name);
      if (subject !== undefined) {
        return subject;
      }
      throw new Error(`no subject was learned for ${name}`);
    },
  };
};

/**
 * Starts a Keycloak holding the listing cast, learns each member's subject from it, and deletes Fay's
 * account. A start that fails after the container started removes it.
 */
export const startListingRealm = async (): Promise<ListingRealm> => {
  const options = listingRealmOptions();
  const keycloak = await startKeycloak(options);
  try {
    return await learnedRealm(keycloak, options);
  } catch (error) {
    await keycloak.remove();
    throw error;
  }
};

/**
 * The listing realm one test file shares: started by the first test asking for it, tried again by
 * the next one when a start failed, and removed once every test in the file has ended. Call it at a
 * test file's top level.
 */
export const fileRealm = (): (() => Promise<ListingRealm>) => {
  const state: { starting: Promise<ListingRealm> | undefined } = {
    starting: undefined,
  };
  after(async () => {
    const started = await state.starting?.catch(() => undefined);
    await started?.keycloak.remove();
  });
  return () => {
    const starting =
      state.starting ??
      startListingRealm().catch((error: unknown) => {
        state.starting = undefined;
        throw error;
      });
    state.starting = starting;
    return starting;
  };
};

/** Whole seconds since the Unix epoch, in milliseconds, so every seeded time reads back exactly in any instant form. */
export const wholeSecondNow = (): number =>
  Math.floor(Date.now() / 1000) * 1000;

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

/**
 * An instant a whole number of days before a base time.
 *
 * @param base the base, in milliseconds.
 * @param days how many days before it.
 */
export const daysBefore = (base: number, days: number): Date =>
  new Date(base - days * DAY_MS);

/**
 * An instant a whole number of hours after a base time, or before it for a negative count.
 *
 * @param base the base, in milliseconds.
 * @param hours how many hours after it.
 */
export const hoursAfter = (base: number, hours: number): Date =>
  new Date(base + hours * HOUR_MS);

const answer = (
  grant: string,
  decision: FixtureDecision['decision'],
  decidedAt: Date,
): FixtureDecision => ({ decidedAt, decision, grant });

const usersOf = (
  realm: ListingRealm,
  names: readonly CastName[],
): Readonly<Record<string, FixtureUser>> =>
  Object.fromEntries(
    names.map((name) => [name, { subject: realm.subject(name) }]),
  );

const SEEDED_CAST: readonly CastName[] = Object.freeze([
  'administrator',
  'ana',
  'bo',
  'cy',
  'dee',
  'eve',
  'fay',
  'gil',
  'hal',
  'quinn',
]);

/**
 * The plan's seed, every time a whole second so it reads back exactly. `STUDY-A1` (by grant): Ana's
 * owner grant, accepted; Bo's submitter grant, granted by Quinn, rejected and then accepted with
 * {@link BO_SHOWN_CAPABILITIES}; Cy's pending; Dee's accepted and then rejected; Eve's accepted and
 * then revoked; Fay's accepted and expired, her account deleted; Gil's viewer grant on
 * `global.controlled`, granted by Ana, accepted; and the administrator's self-grant, accepted, ending
 * in eleven hours. `STUDY-B2` (registered, by Quinn, who never signs in): Hal's owner grant,
 * accepted; Bo's submitter grant, granted by Hal, pending, ending in thirty days. `STUDY-C3` (open): no
 * grant. The administrator registers the other two. Each study's registration and change times are
 * distinct whole seconds well before its grants, so one study's times shown for another's are caught
 * wherever the store keeps them as written. The outsider and the account holding nothing are never
 * seeded. Grant names are the fixture's keys, such as `a1Bo`.
 *
 * @param realm the realm whose subjects the users carry and whose issuer they name.
 * @param base the time the seed is relative to: a whole second.
 */
export const listingPolicy = (
  realm: ListingRealm,
  base: number,
): PolicyFixture => {
  const submitter = (
    holder: CastName,
    resource: string,
    grantedBy: CastName,
    grantedDaysAgo: number,
  ): FixtureGrant => ({
    category: 'unmarked',
    grantedAt: daysBefore(base, grantedDaysAgo),
    grantedBy,
    holder: { user: holder },
    resource,
    role: 'submitter',
  });
  return {
    applications: {
      [APPLICATION]: {
        registeredBy: 'administrator',
        serves: [STUDIES.a1, STUDIES.b2, STUDIES.c3],
      },
    },
    categories: { controlled: { description: 'Controlled access' } },
    decisions: [
      answer('a1Owner', 'accepted', daysBefore(base, 39)),
      {
        capabilities: SUBMITTER_CAPABILITIES,
        decidedAt: daysBefore(base, 29),
        decision: 'rejected',
        grant: 'a1Bo',
      },
      {
        capabilities: BO_SHOWN_CAPABILITIES,
        decidedAt: daysBefore(base, 28),
        decision: 'accepted',
        grant: 'a1Bo',
      },
      answer('a1Dee', 'accepted', daysBefore(base, 25)),
      answer('a1Dee', 'rejected', daysBefore(base, 24)),
      answer('a1Eve', 'accepted', daysBefore(base, 22)),
      answer('a1Fay', 'accepted', daysBefore(base, 20)),
      answer('a1Gil', 'accepted', daysBefore(base, 18)),
      answer('a1Self', 'accepted', hoursAfter(base, -1)),
      answer('b2Owner', 'accepted', daysBefore(base, 34)),
    ],
    grants: {
      a1Bo: submitter('bo', STUDIES.a1, 'quinn', 30),
      a1Cy: submitter('cy', STUDIES.a1, 'administrator', 27),
      a1Dee: submitter('dee', STUDIES.a1, 'quinn', 26),
      a1Eve: {
        ...submitter('eve', STUDIES.a1, 'administrator', 23),
        revoked: { at: daysBefore(base, 2), by: 'administrator' },
      },
      a1Fay: {
        ...submitter('fay', STUDIES.a1, 'administrator', 21),
        expiresAt: daysBefore(base, 1),
      },
      a1Gil: {
        category: 'controlled',
        grantedAt: daysBefore(base, 19),
        grantedBy: 'ana',
        holder: { user: 'gil' },
        resource: STUDIES.a1,
        role: 'viewer',
      },
      a1Owner: {
        category: null,
        grantedAt: daysBefore(base, 40),
        grantedBy: 'administrator',
        holder: { user: 'ana' },
        resource: STUDIES.a1,
        role: 'owner',
      },
      a1Self: {
        category: 'controlled',
        expiresAt: hoursAfter(base, 11),
        grantedAt: hoursAfter(base, -1),
        grantedBy: 'administrator',
        holder: { user: 'administrator' },
        resource: STUDIES.a1,
        role: 'viewer',
      },
      b2Bo: {
        ...submitter('bo', STUDIES.b2, 'hal', 10),
        expiresAt: daysBefore(base, -30),
      },
      b2Owner: {
        category: null,
        grantedAt: daysBefore(base, 35),
        grantedBy: 'administrator',
        holder: { user: 'hal' },
        resource: STUDIES.b2,
        role: 'owner',
      },
    },
    issuer: realm.keycloak.issuer,
    resources: {
      [STUDIES.a1]: {
        baseTier: 'grant',
        description: 'A synthetic study whose records need a grant',
        name: 'Study A1',
        registeredAt: daysBefore(base, 90),
        registeredBy: 'administrator',
        updatedAt: daysBefore(base, 45),
      },
      [STUDIES.b2]: {
        baseTier: 'registered',
        description: 'A synthetic study for anyone signed in',
        name: 'Study B2',
        registeredAt: daysBefore(base, 80),
        registeredBy: 'quinn',
        updatedAt: daysBefore(base, 43),
      },
      [STUDIES.c3]: {
        baseTier: 'open',
        description: 'Une étude synthétique « ouverte »',
        name: 'Étude C3',
        registeredAt: daysBefore(base, 70),
        registeredBy: 'administrator',
        updatedAt: daysBefore(base, 41),
      },
    },
    users: usersOf(realm, SEEDED_CAST),
  };
};

/**
 * The plan's seed with every owner grant in a state that confers nothing, beside one that does: Ana's
 * on `STUDY-A1` pending, Hal's on `STUDY-B2` rejected, and Cy's on `STUDY-C3` revoked, with Dee's on
 * `STUDY-C3` accepted.
 *
 * @param realm the realm.
 * @param base the time the seed is relative to.
 */
export const ownerStatesPolicy = (
  realm: ListingRealm,
  base: number,
): PolicyFixture => {
  const main = listingPolicy(realm, base);
  const owner = (
    holder: CastName,
    resource: string,
    grantedDaysAgo: number,
  ): FixtureGrant => ({
    category: null,
    grantedAt: daysBefore(base, grantedDaysAgo),
    grantedBy: 'administrator',
    holder: { user: holder },
    resource,
    role: 'owner',
  });
  return {
    ...main,
    decisions: [
      ...(main.decisions ?? []).filter(
        ({ grant }) => grant !== 'a1Owner' && grant !== 'b2Owner',
      ),
      answer('b2Owner', 'rejected', daysBefore(base, 1)),
      answer('c3CyOwner', 'accepted', daysBefore(base, 14)),
      answer('c3DeeOwner', 'accepted', daysBefore(base, 11)),
    ],
    grants: {
      ...main.grants,
      b2Owner: owner('hal', STUDIES.b2, 35),
      c3CyOwner: {
        ...owner('cy', STUDIES.c3, 15),
        revoked: { at: daysBefore(base, 3), by: 'administrator' },
      },
      c3DeeOwner: owner('dee', STUDIES.c3, 12),
    },
  };
};

/**
 * The plan's seed with a pending invitation to `STUDY-A1` for {@link INVITEE_ADDRESS}, sent by Ana.
 *
 * @param realm the realm.
 * @param base the time the seed is relative to.
 */
export const invitedPolicy = (
  realm: ListingRealm,
  base: number,
): PolicyFixture =>
  mergedPolicy(listingPolicy(realm, base), {
    invitations: [
      {
        category: 'unmarked',
        email: INVITEE_ADDRESS,
        invitedAt: daysBefore(base, 1),
        invitedBy: 'ana',
        resource: STUDIES.a1,
        role: 'submitter',
      },
    ],
  });

/**
 * The plan's seed with {@link RETIRED_STUDY}, whose history holds Hal's owner grant, revoked, and
 * Gil's viewer grant, expired, so no live grant remains on it. policy.ts's `retireInStore` retires it
 * once seeded, ending no owner grant, since none is live.
 *
 * @param realm the realm.
 * @param base the time the seed is relative to.
 */
export const retiredPolicy = (
  realm: ListingRealm,
  base: number,
): PolicyFixture =>
  mergedPolicy(listingPolicy(realm, base), {
    decisions: [
      answer('r9Gil', 'accepted', daysBefore(base, 49)),
      answer('r9Owner', 'accepted', daysBefore(base, 59)),
    ],
    grants: {
      r9Gil: {
        category: 'controlled',
        expiresAt: daysBefore(base, 6),
        grantedAt: daysBefore(base, 50),
        grantedBy: 'hal',
        holder: { user: 'gil' },
        resource: RETIRED_STUDY,
        role: 'viewer',
      },
      r9Owner: {
        category: null,
        grantedAt: daysBefore(base, 60),
        grantedBy: 'administrator',
        holder: { user: 'hal' },
        resource: RETIRED_STUDY,
        revoked: { at: daysBefore(base, 5), by: 'administrator' },
        role: 'owner',
      },
    },
    resources: {
      [RETIRED_STUDY]: {
        baseTier: 'grant',
        description: 'A synthetic study since retired',
        name: 'Study R9',
        registeredBy: 'administrator',
      },
    },
  });

/**
 * The externalIds of the paging world, registered in an order other than their own, each differing
 * from the others in its last letter alone so every collation orders them alike.
 */
export const PAGING_STUDIES: readonly string[] = Object.freeze([
  'PAGE-E',
  'PAGE-B',
  'PAGE-G',
  'PAGE-A',
  'PAGE-F',
  'PAGE-C',
  'PAGE-D',
]);

/**
 * Seven resources and nothing else, registered by the administrator, for the paging test.
 *
 * @param realm the realm.
 */
export const pagingPolicy = (realm: ListingRealm): PolicyFixture => ({
  applications: {
    [APPLICATION]: { registeredBy: 'administrator', serves: [] },
  },
  issuer: realm.keycloak.issuer,
  resources: Object.fromEntries(
    PAGING_STUDIES.map((externalId) => [
      externalId,
      {
        baseTier: 'registered' as const,
        name: `Paging ${externalId}`,
        registeredBy: 'administrator',
      },
    ]),
  ),
  users: usersOf(realm, ['administrator']),
});

/** The studies {@link othersPolicy} adds, none of them Ana's. */
export const OTHER_STUDIES: readonly string[] = Object.freeze([
  'STUDY-D4',
  'STUDY-E5',
  'STUDY-F6',
  'STUDY-G7',
  'STUDY-H8',
]);

/**
 * More studies, seeded into a running world, none of them Ana's, and Hal owning one of them.
 *
 * @param realm the realm.
 * @param base the time the seed is relative to.
 */
export const othersPolicy = (
  realm: ListingRealm,
  base: number,
): PolicyFixture => ({
  decisions: [answer('d4Owner', 'accepted', daysBefore(base, 1))],
  grants: {
    d4Owner: {
      category: null,
      grantedAt: daysBefore(base, 2),
      grantedBy: 'administrator',
      holder: { user: 'hal' },
      resource: 'STUDY-D4',
      role: 'owner',
    },
  },
  issuer: realm.keycloak.issuer,
  resources: Object.fromEntries(
    OTHER_STUDIES.map((externalId) => [
      externalId,
      {
        baseTier: 'grant' as const,
        name: `Other ${externalId}`,
        registeredBy: 'administrator',
      },
    ]),
  ),
  users: usersOf(realm, ['administrator', 'hal']),
});

/** One open study and nothing else, under the stand-in's issuer, for the authentication test. */
export const AUTHENTICATION_POLICY: PolicyFixture = Object.freeze({
  applications: { [APPLICATION]: { serves: [STUDIES.c3] } },
  resources: {
    [STUDIES.c3]: { baseTier: 'open' as const, name: 'Étude C3' },
  },
});

/**
 * Waits until every one of the times is at least a span in the past by the test's clock, so a
 * listing answering the time it was asked is told apart from one showing the stored times, even
 * where a trigger made them the seeding's.
 *
 * @param times the times, by externalId.
 * @param spanMs how far in the past each must be.
 * @throws when they are not within ten seconds more.
 */
export const untilInThePast = async (
  times: Readonly<Record<string, ResourceTimes>>,
  spanMs: number,
): Promise<void> => {
  const latest = Math.max(
    ...Object.values(times).flatMap(({ registeredAt, updatedAt }) => [
      registeredAt.getTime(),
      updatedAt.getTime(),
    ]),
  );
  if (
    await eventually(async () => Date.now() >= latest + spanMs, spanMs + 10_000)
  ) {
    return;
  }
  throw new Error(`the stored times are not ${spanMs} ms in the past`);
};

/** One Controller seeded with a listing policy, the realm issuing its tokens and holding its directory. */
export interface ListingWorld {
  /** A cast member as a caller of the Policy Management API, with a fresh token from the realm. */
  caller(name: CastName): Promise<AdminCaller>;

  harness: Harness;

  /** The policy seeded. */
  policy: PolicyFixture;

  realm: ListingRealm;
}

/** What a listing world is started with. */
export interface ListingWorldOptions {
  /** Fields over the world's configuration: the realm's issuer and directory by default. */
  configuration?: Partial<ControllerConfiguration>;

  policy: PolicyFixture;
}

/**
 * Starts a Controller trusting the realm as its identity provider and reading people through its
 * directory client, seeded with a policy, and defers its stop. The harness registers its application
 * as the realm's own administrator ({@link realmAdministrator}), a principal the Controller trusts.
 *
 * @param scope the cleanup stopping it.
 * @param realm the realm.
 * @param options the policy, and fields over the configuration.
 */
export const startListingWorld = async (
  scope: Cleanup,
  realm: ListingRealm,
  { configuration = {}, policy }: ListingWorldOptions,
): Promise<ListingWorld> => {
  const harness = await startHarness({
    administratorToken: realmAdministrator(realm),
    applications: [APPLICATION],
    configuration: {
      ...realm.directory,
      identityProviderIssuer: realm.keycloak.issuer,
      ...configuration,
    },
    fixture: policy,
  });
  scope.defer(() => harness.stop());
  return {
    caller: async (name) => ({
      token: await realm.signIn(name),
      url: harness.url,
    }),
    harness,
    policy,
    realm,
  };
};

/**
 * A listing world one suite's tests share, for tests that change nothing another reads: started by
 * the first test asking for it, tried again by the next when a start failed, and stopped once the
 * suite's tests have ended. Call it in the suite's body.
 *
 * @param realm the file's realm.
 * @param options the world's options, given the realm once it has started.
 */
export const suiteWorld = (
  realm: () => Promise<ListingRealm>,
  options: (started: ListingRealm) => ListingWorldOptions,
): (() => Promise<ListingWorld>) => {
  const scope = suiteCleanup();
  const state: { starting: Promise<ListingWorld> | undefined } = {
    starting: undefined,
  };
  const start = async (): Promise<ListingWorld> => {
    const started = await realm();
    return startListingWorld(scope, started, options(started));
  };
  return () => {
    const starting =
      state.starting ??
      start().catch((error: unknown) => {
        state.starting = undefined;
        throw error;
      });
    state.starting = starting;
    return starting;
  };
};

/**
 * Starts a Controller on the identity provider stand-in's issuer whose directory still reads the
 * realm, for the tests needing a token the stand-in signs normally with a claim no real sign-in
 * gives, such as an `exp` already past, and defers its stop.
 *
 * @param scope the cleanup stopping it.
 * @param realm the realm whose directory the Controller reads.
 * @param fixture the policy, under the stand-in's issuer.
 * @param configuration fields over the configuration, such as a log stream the test reads.
 */
export const startStandInHarness = async (
  scope: Cleanup,
  realm: ListingRealm,
  fixture: PolicyFixture,
  configuration: Partial<ControllerConfiguration> = {},
): Promise<Harness> => {
  const harness = await startHarness({
    applications: [APPLICATION],
    configuration: { ...realm.directory, ...configuration },
    fixture,
  });
  scope.defer(() => harness.stop());
  return harness;
};

/**
 * A grant the world's policy seeded, by its fixture name.
 *
 * @param world the world.
 * @param name the grant's fixture name, such as `a1Bo`.
 */
export const seededGrant = (
  world: ListingWorld,
  name: string,
): FixtureGrant => {
  const grant = world.policy.grants?.[name];
  if (grant !== undefined && Object.hasOwn(world.policy.grants ?? {}, name)) {
    return grant;
  }
  throw new Error(`the world's policy seeds no grant ${name}`);
};

/**
 * A seeded grant's opaque id, as the API names a grant.
 *
 * @param world the world.
 * @param name the grant's fixture name.
 */
export const grantIdOf = (world: ListingWorld, name: string): string =>
  seededId(world.harness.seeded.grants, name);

/**
 * A fixture user's name as the cast names them.
 *
 * @param name the fixture user's name.
 * @throws when the name is no cast member's.
 */
export const castNameOf = (name: string): CastName => {
  const found = CAST_NAMES.find((castName) => castName === name);
  if (found !== undefined) {
    return found;
  }
  throw new Error(`${name} is no member of the listing cast`);
};

/**
 * A fixture category as a listing names it: a global one scoped, `unmarked` as `global.unmarked`, and
 * the wildcard as `null`.
 *
 * @param category the fixture grant's category.
 */
export const scopedCategory = (category: string | null): string | null => {
  if (category === null || category.includes('.')) {
    return category;
  }
  return `global.${category}`;
};

/**
 * A listed grant's expiry, in milliseconds: `undefined` for `null`, a grant that never expires, and
 * otherwise a UTC instant ending in `Z`, the test failing on anything else.
 *
 * @param value the grant's `expiresAt`.
 */
export const expiryOf = (value: unknown): number | undefined =>
  value === null ? undefined : instantOf(value, 'expiresAt');

/** What the plan checks of every listed grant: its holder, category, role, expiry, state and id. */
export interface GrantFacts {
  category: unknown;

  /** In milliseconds; `undefined` for a grant that never expires. */
  expiresAt: number | undefined;

  holder: unknown;
  id: unknown;
  role: unknown;
  state: unknown;
}

/**
 * A listed grant's facts.
 *
 * @param grant the listed grant.
 */
export const grantFacts = (grant: GrantView): GrantFacts => ({
  category: grant.category,
  expiresAt: expiryOf(grant.expiresAt),
  holder: grant.holder?.subject,
  id: grant.id,
  role: grant.role,
  state: grant.state,
});

/**
 * The facts a seeded grant should be listed with, in the state the test expects of it.
 *
 * @param world the world.
 * @param name the grant's fixture name.
 * @param state the state expected.
 */
export const seededGrantFacts = (
  world: ListingWorld,
  name: string,
  state: string,
): GrantFacts => {
  const grant = seededGrant(world, name);
  if ('user' in grant.holder) {
    return {
      category: scopedCategory(grant.category),
      expiresAt: grant.expiresAt?.getTime(),
      holder: world.realm.subject(castNameOf(grant.holder.user)),
      id: grantIdOf(world, name),
      role: grant.role,
      state,
    };
  }
  throw new Error(`the grant ${name} is held by a group`);
};

/**
 * Grant facts in one order, by id, so two lists of them compare whatever order they were listed in.
 *
 * @param facts the facts.
 */
export const byId = (facts: readonly GrantFacts[]): readonly GrantFacts[] =>
  facts.toSorted((first, second) =>
    String(first.id).localeCompare(String(second.id)),
  );

/**
 * The latest decision the world's policy seeded on a grant.
 *
 * @param world the world.
 * @param name the grant's fixture name.
 * @throws when the policy seeds no decision on it.
 */
export const latestDecisionOf = (
  world: ListingWorld,
  name: string,
): FixtureDecision => {
  const latest = (world.policy.decisions ?? [])
    .filter(({ grant }) => grant === name)
    .at(-1);
  if (latest !== undefined) {
    return latest;
  }
  throw new Error(`the world's policy seeds no decision on ${name}`);
};

/**
 * The subject of the fixture user a seeded grant names as its granter.
 *
 * @param world the world.
 * @param name the grant's fixture name.
 */
export const granterSubjectOf = (world: ListingWorld, name: string): string =>
  world.realm.subject(castNameOf(seededGrant(world, name).grantedBy ?? ''));

/**
 * One listed grant, by the seeded grant's id.
 *
 * @param grants the listed grants.
 * @param world the world.
 * @param name the grant's fixture name.
 * @throws when the listing holds no such grant.
 */
export const listedGrant = (
  grants: readonly GrantView[],
  world: ListingWorld,
  name: string,
): GrantView => {
  const id = grantIdOf(world, name);
  const found = grants.find((grant) => grant.id === id);
  if (found !== undefined) {
    return found;
  }
  throw new Error(`the listing holds no grant ${name}`);
};

/**
 * Whether a value is a string holding something other than whitespace.
 *
 * @param value the value.
 */
export const isNamed = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;
