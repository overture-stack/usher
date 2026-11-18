import assert from 'node:assert/strict';

import { decodeJwt } from 'jose';
import pg from 'pg';

import {
  type AdminCaller,
  type AdminResponse,
  type GrantCreation,
  managementClaims,
  type SelfGrantCreation,
  stringsIn,
} from '../admin.js';
import { AUDIT_EVENT_TYPES, emittedType } from '../auditEvents.js';
import {
  addressKeycloakRealm,
  type KeycloakRealm,
  type KeycloakRealmOptions,
  startKeycloak,
} from '../containers.js';
import type { Clock } from '../controller.js';
import { holdTable, untilBlocked } from '../database.js';
import { PEOPLE, type Person } from '../exchange.js';
import { type Harness, startHarness } from '../harness.js';
import type { MintOptions } from '../identityProvider.js';
import {
  type FixtureApplication,
  type FixtureDecision,
  type FixtureGrant,
  inTransactionAs,
  type PolicyFixture,
  POLICY_TABLES,
  qualified,
  seedPolicy,
  SYSTEM_ACTOR,
} from '../policy.js';
import { suiteCleanup } from '../waiting.js';

// The fixture and helpers of #212's tests alone: grants and acceptance decisions. Every path, body,
// table and column they use comes from the shared support modules; what this file assumes beyond
// them is listed in its own TSDoc, for the README's table.

/**
 * The plan's people, by the part each plays, every one from the shared cast: Ana owns STUDY-A1 and
 * Dana STUDY-B2, each by an accepted owner grant; Bo is a curator on `global.controlled` of
 * STUDY-A1; Cy is the plan's Gil, the recipient of the grants a test makes; Cy2's subject differs
 * from Cy's only in letter case; Long holds nothing; Fen is never seeded; the owner is spare, for a
 * second owner grant; the administrator and Eli are administrators by the management token's realm
 * role alone, so neither is seeded.
 */
export const CAST = Object.freeze({
  administrator: PEOPLE.administrator,
  curator: PEOPLE.bo,
  lookalike: PEOPLE.cy2,
  newcomer: PEOPLE.fen,
  outsider: PEOPLE.long,
  ownerOfA1: PEOPLE.ana,
  ownerOfB2: PEOPLE.dana,
  recipient: PEOPLE.cy,
  secondAdministrator: PEOPLE.eli,
  spare: PEOPLE.owner,
});

/** A part in {@link CAST} that the fixture seeds as a user of the same name. */
export type SeededPart =
  | 'curator'
  | 'lookalike'
  | 'outsider'
  | 'ownerOfA1'
  | 'ownerOfB2'
  | 'recipient'
  | 'spare';

const SEEDED_PARTS: readonly SeededPart[] = Object.freeze([
  'curator',
  'lookalike',
  'outsider',
  'ownerOfA1',
  'ownerOfB2',
  'recipient',
  'spare',
]);

/** The study Ana owns. */
export const STUDY_A1 = 'STUDY-A1';

/** The study Dana owns, which offers a category of its own. */
export const STUDY_B2 = 'STUDY-B2';

/** A study at the `open` tier, which every signed-in caller may see, owned by nobody. */
export const OPEN_STUDY = 'STUDY-C3';

/** A study at the `registered` tier, which every signed-in caller may see, owned by nobody. */
export const REGISTERED_STUDY = 'STUDY-D4';

/** An externalId no resource holds. */
export const UNKNOWN_STUDY = 'STUDY-ZZ';

/** The global category the fixture registers, as a grant names it. */
export const CONTROLLED = 'global.controlled';

/** The global category the migrations write, and the instance's submitter category by default (#212 Q6). */
export const UNMARKED = 'global.unmarked';

/** STUDY-B2's own category, as a grant names it, written at the database (#211 Q10). */
export const B2_OWN_CATEGORY = 'resource.internal';

/** The signing-key cache's refetch cooldown (#208 Q5), in milliseconds. */
export const KEY_REFETCH_COOLDOWN_MS = 30_000;

/** A clock a test moves forward, configured as the Controller's own (#209 Q2). */
export interface AdjustableClock {
  /** Moves the clock forward. */
  advance(milliseconds: number): void;

  clock: Clock;
}

/** A clock reading the system's time plus however far the test has moved it forward. */
export const adjustableClock = (): AdjustableClock => {
  const state = { offset: 0 };
  return {
    advance: (milliseconds) => {
      state.offset += milliseconds;
    },
    clock: { now: () => Date.now() + state.offset },
  };
};

/** An hour, in milliseconds. */
export const HOUR_MS = 3_600_000;

/** A minute, in milliseconds. */
export const MINUTE_MS = 60_000;

/**
 * What a person is shown when answering a grant at each seeded role, as `entity.action` names, sorted:
 * the seeded matrix of `permissions-model.md` § The seeded roles, as a matrix.
 */
export const SHOWN = Object.freeze({
  curator: Object.freeze([
    'record.count',
    'record.create',
    'record.delete',
    'record.export',
    'record.update',
    'record.view',
  ]),
  editor: Object.freeze([
    'record.count',
    'record.create',
    'record.export',
    'record.update',
    'record.view',
  ]),
  owner: Object.freeze([
    'grant.create',
    'grant.extend',
    'grant.reduce',
    'grant.revoke',
    'grant.view',
    'invitation.create',
    'ownership.transfer',
    'resource.restore',
    'resource.suppress',
    'resource.update',
    'resource.view',
  ]),
  submitter: Object.freeze(['record.create', 'record.update']),
  viewer: Object.freeze(['record.count', 'record.export', 'record.view']),
});

/**
 * The reasons the audit log records for a grant's revocations, read from its succeeded
 * `grant.revocation` events' `grantId` and `reason`, as `audit-events.md` names them. A refused
 * revocation is recorded as the operation's event too, `denied`, its reason the refusal's, so it is
 * left out.
 *
 * @param harness the harness.
 * @param grantId the grant's id.
 */
export const revocationReasonsRecorded = async (
  harness: Harness,
  grantId: string,
): Promise<readonly unknown[]> => {
  const { auditLog } = POLICY_TABLES;
  const data = pg.escapeIdentifier(auditLog.columns.data);
  const { rows } = await harness.clients.migration.query<{ reason: unknown }>(
    `SELECT ${data} -> 'reason' AS reason
       FROM ${qualified(auditLog)}
      WHERE ${pg.escapeIdentifier(auditLog.columns.type)} = $1
        AND ${data} ->> 'grantId' = $2
        AND ${data} ->> 'result' = 'succeeded'`,
    [emittedType(AUDIT_EVENT_TYPES.grantRevocation), grantId],
  );
  return rows.map(({ reason }) => reason);
};

/**
 * Whether an answer's body carries a value as one of its strings.
 *
 * @param response the answer.
 * @param value the value, such as a subject or an externalId.
 */
export const answerNames = (response: AdminResponse, value: string): boolean =>
  stringsIn(response.body).includes(value);

const INSTANT_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

/**
 * Whether an answer's body carries an instant, as an RFC 3339 string in UTC ending in `Z`, to the
 * millisecond given by the store.
 *
 * @param response the answer.
 * @param instant the instant.
 */
export const answerNamesInstant = (
  response: AdminResponse,
  instant: Date,
): boolean =>
  stringsIn(response.body).some(
    (value) =>
      INSTANT_FORM.test(value) &&
      Math.abs(Date.parse(value) - instant.getTime()) <= 1,
  );

/** A UUID in its canonical text form. */
export const UUID_FORM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * An instant a duration from now, whole seconds, as the API takes one: UTC with `Z`.
 *
 * @param milliseconds the duration; negative for the past.
 */
export const instantFromNow = (milliseconds: number): string =>
  new Date(Math.floor((Date.now() + milliseconds) / 1000) * 1000).toISOString();

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/**
 * An instant written at another offset, as a caller west of UTC would write it: `-05:00` for
 * `offsetMinutes` of -300.
 *
 * @param instant the instant, whole seconds.
 * @param offsetMinutes the offset, east positive.
 */
export const atOffset = (instant: Date, offsetMinutes: number): string => {
  const local = new Date(instant.getTime() + offsetMinutes * MINUTE_MS);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const magnitude = Math.abs(offsetMinutes);
  return `${local.toISOString().slice(0, 19)}${sign}${twoDigits(Math.floor(magnitude / 60))}:${twoDigits(magnitude % 60)}`;
};

/**
 * The harness's default applications, by label, serving nothing, since serving is not #212's: the
 * harness registers them through the API once its Controller listens.
 */
export const APPLICATIONS: Readonly<Record<string, FixtureApplication>> =
  Object.freeze({
    'arranger-test': { serves: [] },
    'lyric-test': { serves: [] },
  });

/**
 * A fixture grant.
 *
 * @param user the holder's fixture name.
 * @param role the role's name.
 * @param details the category (`controlled` by default; `null` for the control plane's wildcard), the
 *   resource (STUDY-A1 by default), and anything over them.
 */
export const fixtureGrant = (
  user: string,
  role: string,
  {
    category = 'controlled',
    resource = STUDY_A1,
    ...details
  }: Partial<FixtureGrant> = {},
): FixtureGrant => ({
  ...details,
  category,
  holder: { user },
  resource,
  role,
});

/**
 * An answer to a fixture grant by its holder, showing what its role carries when written.
 *
 * @param grant the fixture grant's name.
 * @param decision `accepted` by default.
 * @param decidedAt when: the transaction's clock by default.
 */
export const answeredInFixture = (
  grant: string,
  decision: FixtureDecision['decision'] = 'accepted',
  decidedAt?: Date,
): FixtureDecision => ({
  decision,
  grant,
  ...(decidedAt === undefined ? {} : { decidedAt }),
});

/** The fixture's own grants, each accepted: Ana's and Dana's ownerships and Bo's curator grant. */
const BASE_GRANTS: Readonly<Record<string, FixtureGrant>> = Object.freeze({
  curatesA1: fixtureGrant('curator', 'curator'),
  ownsA1: fixtureGrant('ownerOfA1', 'owner', { category: null }),
  ownsB2: fixtureGrant('ownerOfB2', 'owner', {
    category: null,
    resource: STUDY_B2,
  }),
});

/**
 * The plan's fixture, synthetic throughout, with a test's entries over it: the global category
 * `controlled` beside the seeded `unmarked`; STUDY-A1 and STUDY-B2 at the `grant` tier, so only
 * holders of a live grant on one, its owners and administrators may see it (#211 Q6), STUDY-B2
 * offering a category of its own; STUDY-C3 open and STUDY-D4 registered, owned by nobody; every
 * seeded part of {@link CAST} as a user; Ana's and Dana's accepted owner grants and Bo's accepted
 * curator grant.
 *
 * @param extra entries over the fixture's, by the same names; decisions follow the fixture's own.
 */
export const grantsFixture = ({
  decisions = [],
  grants = {},
  resources = {},
  users = {},
}: Pick<
  PolicyFixture,
  'decisions' | 'grants' | 'resources' | 'users'
> = {}): PolicyFixture => ({
  applications: APPLICATIONS,
  categories: { controlled: { description: 'Controlled access' } },
  decisions: [
    ...Object.keys(BASE_GRANTS).map((grant) => answeredInFixture(grant)),
    ...decisions,
  ],
  grants: { ...BASE_GRANTS, ...grants },
  resources: {
    [STUDY_A1]: { baseTier: 'grant', name: 'Cardiac Outcomes' },
    [STUDY_B2]: {
      baseTier: 'grant',
      categories: { internal: { description: 'Internal records' } },
      name: 'Étude pulmonaire',
      offers: [B2_OWN_CATEGORY],
    },
    [OPEN_STUDY]: { baseTier: 'open', name: 'Reef Survey' },
    [REGISTERED_STUDY]: { baseTier: 'registered', name: 'Members Archive' },
    ...resources,
  },
  users: {
    ...Object.fromEntries(
      SEEDED_PARTS.map((part) => [part, { subject: CAST[part].subject }]),
    ),
    ...users,
  },
});

/**
 * A management token's realm roles with others added: Keycloak's defaults, as the harness's tokens
 * carry them, then the roles given, as claims over a token's.
 *
 * @param harness the harness, whose stand-in names the default roles.
 * @param person who the token is for.
 * @param added the roles added.
 */
export const withRealmRoles = (
  harness: Harness,
  person: Person,
  added: readonly string[],
): MintOptions => {
  const access = managementClaims(
    harness.identityProvider,
    harness.configuration,
    person,
    false,
  )['realm_access'];
  const held: unknown =
    typeof access === 'object' && access !== null
      ? Reflect.get(access, 'roles')
      : undefined;
  const defaults = Array.isArray(held)
    ? held.filter((role): role is string => typeof role === 'string')
    : [];
  return { claims: { realm_access: { roles: [...defaults, ...added] } } };
};

/** What a grant names beyond its holder, each with a default. */
export interface GrantTerms {
  /** `global.controlled` by default. */
  category?: string;

  /** An instant with an offset; none by default. */
  expiresAt?: string;

  /** STUDY-A1 by default. */
  resource?: string;

  /** `viewer` by default. */
  role?: string;
}

/**
 * A grant's creation naming a person by subject: a consumer grant at `viewer` on `global.controlled`
 * of STUDY-A1 by default.
 *
 * @param holder the holder.
 * @param terms the category, expiry, resource and role.
 */
export const grantFor = (
  holder: Pick<Person, 'subject'>,
  {
    category = CONTROLLED,
    expiresAt,
    resource = STUDY_A1,
    role = 'viewer',
  }: GrantTerms = {},
): GrantCreation => ({
  category,
  ...(expiresAt === undefined ? {} : { expiresAt }),
  holder: { subject: holder.subject },
  resource,
  role,
});

/**
 * A grant's creation at a role naming no category: a submitter's, which takes the instance's, or an
 * owner's, the whole resource.
 *
 * @param holder the holder.
 * @param role `submitter` or `owner`.
 * @param resource STUDY-A1 by default.
 */
export const uncategorizedGrantFor = (
  holder: Pick<Person, 'subject'>,
  role: 'owner' | 'submitter',
  resource: string = STUDY_A1,
): GrantCreation => ({ holder: { subject: holder.subject }, resource, role });

/**
 * A self-grant's creation: `viewer` on `global.controlled` of STUDY-A1 by default.
 *
 * @param expiresAt an instant with an offset.
 * @param terms the category, resource and role.
 */
export const selfGrantUntil = (
  expiresAt: string,
  {
    category = CONTROLLED,
    resource = STUDY_A1,
    role = 'viewer',
  }: Omit<GrantTerms, 'expiresAt'> = {},
): SelfGrantCreation => ({ category, expiresAt, resource, role });

/**
 * Fails unless a grant's creation succeeded and named the new grant's id, and gives the id.
 *
 * @param response the creation's answer.
 * @param what what the test asked for, for the failure's message.
 */
export const createdId = (response: AdminResponse, what: string): string => {
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${what} was answered ${response.status}${response.problem === undefined ? '' : ` ${response.problem.code}`}`,
  );
  const id: unknown =
    typeof response.body === 'object' && response.body !== null
      ? Reflect.get(response.body, 'id')
      : undefined;
  if (typeof id === 'string') {
    return id;
  }
  return assert.fail(`${what} answered no grant id`);
};

const {
  capabilities,
  categories,
  grantDecisions,
  grants,
  invitations,
  notificationOutbox,
  resources,
  rolePermissions,
  roles,
  userIdentities,
  users,
} = POLICY_TABLES;

const at = (alias: string, column: string): string =>
  `${alias}.${pg.escapeIdentifier(column)}`;

/** A grant as the store holds it, people by subject, the resource by externalId and the category scoped. */
export interface StoredGrant {
  /** `global.controlled` or `resource.internal`; `null` for the control plane's wildcard. */
  category: string | null;

  expiresAt: Date | null;
  fieldCategory: string | null;
  grantedAt: Date;
  granterSubject: string;
  holderIssuer: string | null;
  holderSubject: string | null;
  id: string;

  /** By externalId. */
  resource: string;

  revokedAt: Date | null;
  revokerSubject: string | null;
  role: string;
}

/** Which grants to read: each member narrows, and none reads them all. */
export interface GrantFilter {
  /** The holder, by the identity provider's subject. */
  holder?: string;

  id?: string;

  /** By externalId. */
  resource?: string;

  role?: string;
}

/**
 * The grants the store holds, revoked ones included, in the order they were granted.
 *
 * @param harness the harness, read under the migration role.
 * @param filter the holder, id, resource and role.
 */
export const storedGrants = async (
  harness: Harness,
  { holder, id, resource, role }: GrantFilter = {},
): Promise<readonly StoredGrant[]> => {
  const { rows } = await harness.clients.migration.query<StoredGrant>(
    `SELECT ${at('held', grants.columns.id)}::text AS id,
            ${at('record_category', categories.columns.scope)} || '.' || ${at('record_category', categories.columns.name)} AS category,
            ${at('held', grants.columns.expiresAt)} AS "expiresAt",
            ${at('field_category', categories.columns.scope)} || '.' || ${at('field_category', categories.columns.name)} AS "fieldCategory",
            ${at('held', grants.columns.grantedAt)} AS "grantedAt",
            ${at('granter', userIdentities.columns.idpSubjectId)} AS "granterSubject",
            ${at('holder', userIdentities.columns.idpIssuer)} AS "holderIssuer",
            ${at('holder', userIdentities.columns.idpSubjectId)} AS "holderSubject",
            ${at('resource_row', resources.columns.externalId)} AS resource,
            ${at('held', grants.columns.revokedAt)} AS "revokedAt",
            ${at('revoker', userIdentities.columns.idpSubjectId)} AS "revokerSubject",
            ${at('role_row', roles.columns.name)} AS role
       FROM ${qualified(grants)} held
       JOIN ${qualified(userIdentities)} granter ON ${at('granter', userIdentities.columns.userId)} = ${at('held', grants.columns.grantedBy)}
       JOIN ${qualified(resources)} resource_row ON ${at('resource_row', resources.columns.id)} = ${at('held', grants.columns.resourceId)}
       JOIN ${qualified(roles)} role_row ON ${at('role_row', roles.columns.id)} = ${at('held', grants.columns.roleId)}
       LEFT JOIN ${qualified(userIdentities)} holder ON ${at('holder', userIdentities.columns.userId)} = ${at('held', grants.columns.holderUserId)}
       LEFT JOIN ${qualified(categories)} record_category ON ${at('record_category', categories.columns.id)} = ${at('held', grants.columns.recordCategoryId)}
       LEFT JOIN ${qualified(categories)} field_category ON ${at('field_category', categories.columns.id)} = ${at('held', grants.columns.fieldCategoryId)}
       LEFT JOIN ${qualified(userIdentities)} revoker ON ${at('revoker', userIdentities.columns.userId)} = ${at('held', grants.columns.revokedBy)}
      WHERE ($1::text IS NULL OR ${at('held', grants.columns.id)}::text = $1)
        AND ($2::text IS NULL OR ${at('holder', userIdentities.columns.idpSubjectId)} = $2)
        AND ($3::text IS NULL OR ${at('resource_row', resources.columns.externalId)} = $3)
        AND ($4::text IS NULL OR ${at('role_row', roles.columns.name)} = $4)
      ORDER BY ${at('held', grants.columns.grantedAt)}, 1`,
    [id ?? null, holder ?? null, resource ?? null, role ?? null],
  );
  return rows;
};

/**
 * One grant as the store holds it.
 *
 * @param harness the harness.
 * @param id the grant's id.
 * @throws when the store holds no grant by that id.
 */
export const storedGrant = async (
  harness: Harness,
  id: string,
): Promise<StoredGrant> => {
  const [found] = await storedGrants(harness, { id });
  if (found !== undefined) {
    return found;
  }
  throw new Error('the store holds no grant by that id');
};

/** A decision as the store holds it, its person by subject. */
export interface StoredDecision {
  /** What the person was shown, as `entity.action` names, sorted. */
  capabilities: readonly string[];

  decidedAt: Date;
  deciderSubject: string;
  decision: string;
}

/**
 * Every decision on a grant, oldest first.
 *
 * @param harness the harness.
 * @param grantId the grant's id.
 */
export const storedDecisions = async (
  harness: Harness,
  grantId: string,
): Promise<readonly StoredDecision[]> => {
  const { rows } = await harness.clients.migration.query<StoredDecision>(
    `SELECT ARRAY(SELECT unnest(${at('decision_row', grantDecisions.columns.capabilities)}) ORDER BY 1) AS capabilities,
            ${at('decision_row', grantDecisions.columns.decidedAt)} AS "decidedAt",
            ${at('decision_row', grantDecisions.columns.decision)} AS decision,
            ${at('decider', userIdentities.columns.idpSubjectId)} AS "deciderSubject"
       FROM ${qualified(grantDecisions)} decision_row
       JOIN ${qualified(userIdentities)} decider ON ${at('decider', userIdentities.columns.userId)} = ${at('decision_row', grantDecisions.columns.userId)}
      WHERE ${at('decision_row', grantDecisions.columns.grantId)}::text = $1
      ORDER BY ${at('decision_row', grantDecisions.columns.decidedAt)}`,
    [grantId],
  );
  return rows;
};

/** An owner notification as the outbox holds it (#212 Q13), its recipient by subject. */
export interface StoredNotification {
  deliveredAt: Date | null;
  kind: string;
  recipientSubject: string;
}

/**
 * The outbox rows naming a grant.
 *
 * @param harness the harness.
 * @param grantId the grant's id.
 */
export const notificationsOf = async (
  harness: Harness,
  grantId: string,
): Promise<readonly StoredNotification[]> => {
  const { rows } = await harness.clients.migration.query<StoredNotification>(
    `SELECT ${at('outbox', notificationOutbox.columns.deliveredAt)} AS "deliveredAt",
            ${at('outbox', notificationOutbox.columns.kind)} AS kind,
            ${at('recipient', userIdentities.columns.idpSubjectId)} AS "recipientSubject"
       FROM ${qualified(notificationOutbox)} outbox
       JOIN ${qualified(userIdentities)} recipient ON ${at('recipient', userIdentities.columns.userId)} = ${at('outbox', notificationOutbox.columns.recipientUserId)}
      WHERE ${at('outbox', notificationOutbox.columns.grantId)}::text = $1
      ORDER BY 3`,
    [grantId],
  );
  return rows;
};

/** How many rows each table a refused write must leave untouched holds. */
export interface RowCounts {
  categories: number;
  decisions: number;
  grants: number;

  /** A person's identities: a grant written to someone never seen writes one beside their person. */
  identities: number;

  invitations: number;
  notifications: number;
  resources: number;
  users: number;
}

const counted = (table: { name: string }): string =>
  `(SELECT count(*)::int FROM ${qualified(table)})`;

/**
 * How many rows the tables a grant operation writes hold now, for a test showing a refusal wrote
 * nothing: categories, decisions, grants, identities, invitations, the outbox, resources and users.
 *
 * @param harness the harness.
 */
export const rowCounts = async (harness: Harness): Promise<RowCounts> => {
  const { rows } = await harness.clients.migration.query<RowCounts>(
    `SELECT ${counted(categories)} AS categories,
            ${counted(grantDecisions)} AS decisions,
            ${counted(grants)} AS grants,
            ${counted(userIdentities)} AS identities,
            ${counted(invitations)} AS invitations,
            ${counted(notificationOutbox)} AS notifications,
            ${counted(resources)} AS resources,
            ${counted(users)} AS users`,
  );
  const [found] = rows;
  if (found !== undefined) {
    return found;
  }
  throw new Error('the store answered no counts');
};

/**
 * Sends the same request several times at once with the grants table held, waits until every one of
 * them waits on it, then lets them go together: a race forced at the store, never hoped for. Assumes
 * the Controller's pool admits that many requests at once.
 *
 * @param harness the harness.
 * @param count how many requests.
 * @param send one request.
 * @returns the answers, in the order sent.
 */
export const racedAtTheGrantsTable = async <Answer>(
  harness: Harness,
  count: number,
  send: () => Promise<Answer>,
): Promise<readonly Answer[]> => {
  const held = await holdTable(harness.database, grants);
  const sending = Promise.all(Array.from({ length: count }, () => send()));
  const waiting = await untilBlocked(harness.clients.migration, sending, {
    count,
  }).then(
    (blocked) => ({ blocked, failure: undefined }),
    (failure: unknown) => ({ blocked: false, failure }),
  );
  await held.release();
  const answers = await sending;
  if (waiting.failure !== undefined) {
    throw waiting.failure;
  }
  assert.ok(
    waiting.blocked,
    `all ${count} requests waited on the grants table together`,
  );
  return answers;
};

/**
 * Takes a capability from a role by SQL under the system actor, in a transaction of its own: what the
 * role confers changes with no write path of the Controller's.
 *
 * @param harness the harness.
 * @param role the role's name.
 * @param capability the capability, as `entity.action`.
 */
export const withdrawCapabilityInStore = async (
  harness: Harness,
  role: string,
  capability: string,
): Promise<void> => {
  const [entity, action] = capability.split('.');
  const client = harness.clients.migration;
  const { rowCount } = await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `DELETE FROM ${qualified(rolePermissions)} permission
        USING ${qualified(roles)} role_row, ${qualified(capabilities)} capability
        WHERE ${at('permission', rolePermissions.columns.roleId)} = ${at('role_row', roles.columns.id)}
          AND ${at('permission', rolePermissions.columns.capabilityId)} = ${at('capability', capabilities.columns.id)}
          AND ${at('role_row', roles.columns.name)} = $1
          AND ${at('capability', capabilities.columns.entity)} = $2
          AND ${at('capability', capabilities.columns.action)} = $3`,
      [role, entity ?? '', action ?? ''],
    ),
  );
  if (rowCount !== 1) {
    throw new Error(`the role ${role} carried no ${capability}`);
  }
};

/**
 * The people `addressKeycloakRealm` holds, by address and the part each plays here: among them an
 * owner of STUDY-A1, an outsider, and two accounts a test disables or deletes while it runs, each its
 * own so the realm a suite shares stays as imported for every other test.
 */
export const ADDRESSES = Object.freeze({
  administrator: 'admin.one@example.org',
  disabledLater: 'paused@example.org',
  duplicated: 'dup@example.org',
  nearMissPrefixed: 'abo@example.org',
  nearMissSurname: 'bo.smith@example.org',
  nonAscii: 'zoë@example.org',
  outsider: 'outsider.cy@example.org',
  owner: 'owner.ana@example.org',
  plusAddressed: 'bo+ims@example.org',
  removedLater: 'leaving@example.org',
  submitter: 'sub.bo@example.org',
  unverified: 'una@example.org',
});

/** A real Keycloak holding the address realm, and the options it was imported from. */
export interface AddressRealm {
  keycloak: KeycloakRealm;
  options: KeycloakRealmOptions;
}

const startAddressRealm = async (): Promise<AddressRealm> => {
  const options = addressKeycloakRealm();
  return { keycloak: await startKeycloak(options), options };
};

/** The address realm one suite's tests share, started by the first test asking for it. */
export type SharedAddressRealm = () => Promise<AddressRealm>;

/**
 * A Keycloak holding the address realm, which one suite's tests share: started by the first test
 * asking, so a test failing before it asks starts none; removed once the suite's tests have ended.
 * Call it in the suite's body.
 */
export const sharedAddressRealm = (): SharedAddressRealm => {
  const scope = suiteCleanup();
  const state: { starting: Promise<AddressRealm> | undefined } = {
    starting: undefined,
  };
  scope.defer(async () => {
    const started = await state.starting?.catch(() => undefined);
    await started?.keycloak.remove();
  });
  return () => {
    const starting =
      state.starting ??
      startAddressRealm().catch((error: unknown) => {
        state.starting = undefined;
        throw error;
      });
    state.starting = starting;
    return starting;
  };
};

/** A realm person signed in through the management client. */
export interface SignedIn {
  /** The person's subject, as the access token carries it. */
  subject: string;

  /** The access token, a management token from the real Keycloak. */
  token: string;
}

/** What a test in the address suite works with. */
export interface AddressSession {
  /** A caller holding a token, at the Controller as it runs now. */
  caller(signedIn: SignedIn): AdminCaller;

  harness: Harness;
  keycloak: KeycloakRealm;
  options: KeycloakRealmOptions;

  /** Ana, signed in, the accepted owner of STUDY-A1. */
  owner: SignedIn;

  /** Signs a realm person in by username, through the harness's management client. */
  signIn(username: string): Promise<SignedIn>;
}

/**
 * The client whose service account the Controller's directory reads users through.
 *
 * @param options the realm.
 */
export const directoryClientOf = (options: KeycloakRealmOptions): string => {
  const found = options.clients.find(
    ({ directoryRoles = [] }) => directoryRoles.length > 0,
  );
  if (found !== undefined) {
    return found.clientId;
  }
  throw new Error('the realm holds no directory client');
};

const signedInThrough = async (
  { keycloak, options }: AddressRealm,
  clientId: string,
  username: string,
): Promise<SignedIn> => {
  const person = options.people.find((held) => held.username === username);
  if (person === undefined) {
    throw new Error(`the realm holds no ${username}`);
  }
  const { accessToken } = await keycloak.signIn(clientId, person);
  const { sub } = decodeJwt(accessToken);
  if (typeof sub === 'string') {
    return { subject: sub, token: accessToken };
  }
  throw new Error("Keycloak's access token names no subject");
};

/**
 * Runs a test of the address suite: a harness whose database is cloned first, so a test fails with
 * the seam's message before any Keycloak starts; then the shared realm; the Controller started
 * trusting the realm's issuer and reading its directory; and the fixture seeded under the realm's
 * issuer: STUDY-A1 and STUDY-B2 at the `grant` tier, STUDY-C3 open, and Ana's accepted owner grant on
 * STUDY-A1 under the subject her own tokens carry. The harness holds no application: the suite
 * exchanges through none, and the harness registers applications under a token minted by the
 * stand-in, which a Controller trusting the realm refuses. Stops the harness whether or not the work
 * succeeded.
 *
 * @param realm the shared realm.
 * @param work the test's steps.
 */
export const withAddressHarness = async (
  realm: SharedAddressRealm,
  work: (session: AddressSession) => Promise<void>,
): Promise<void> => {
  const harness = await startHarness({
    applications: [],
    startsController: false,
  });
  try {
    const shared = await realm();
    const [managementClient] = harness.configuration.managementClients;
    if (managementClient === undefined) {
      throw new Error('the harness configures no management client');
    }
    const signIn = (username: string): Promise<SignedIn> =>
      signedInThrough(shared, managementClient, username);
    const owner = await signIn(ADDRESSES.owner);
    await harness.restart({
      ...shared.keycloak.directoryFor(directoryClientOf(shared.options)),
      identityProviderIssuer: shared.keycloak.issuer,
    });
    await seedPolicy(harness.clients.migration, {
      categories: { controlled: { description: 'Controlled access' } },
      decisions: [answeredInFixture('ownsA1')],
      grants: { ownsA1: fixtureGrant('owner', 'owner', { category: null }) },
      issuer: shared.keycloak.issuer,
      resources: {
        [STUDY_A1]: { baseTier: 'grant', name: 'Cardiac Outcomes' },
        [STUDY_B2]: { baseTier: 'grant', name: 'Étude pulmonaire' },
        [OPEN_STUDY]: { baseTier: 'open', name: 'Reef Survey' },
      },
      users: { owner: { subject: owner.subject } },
    });
    await work({
      caller: ({ token }) => harness.caller(token),
      harness,
      keycloak: shared.keycloak,
      options: shared.options,
      owner,
      signIn,
    });
  } finally {
    await harness.stop();
  }
};
