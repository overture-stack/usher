import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import {
  type MigrationOptions,
  type SeededPolicySettings,
  writeSeededPolicy,
} from './controller.js';
import {
  type DatabaseTemplate,
  USHER_SCHEMA,
  USHER_TEMPLATE,
} from './database.js';
import { type Cleanup, eventually } from './waiting.js';

/**
 * Who acts in a transaction, by the kinds of actor `audit-events.md` names. A person or a service
 * account is named by the identity provider's subject, as `actorId` names it; a system or anonymous
 * actor has nobody to name.
 */
export type Actor =
  | { id: string; type: 'human' | 'serviceAccount' }
  | { type: 'anonymous' | 'system' };

/** The actor SQL seeding and migrations declare. */
export const SYSTEM_ACTOR: Actor = Object.freeze({ type: 'system' });

/**
 * The transaction-local settings a transaction declares its actor in, as the audit triggers read
 * them: the actor's type, and its subject, empty where the type says there is nobody.
 */
export const ACTOR_SETTINGS: Readonly<{ id: string; type: string }> =
  Object.freeze({ id: 'usher.actor_id', type: 'usher.actor_type' });

/**
 * The settings naming the two limits the store applies to a session, which a transaction given a
 * bound of its own must set to that bound inside the transaction alone.
 */
export const SESSION_LIMIT_SETTINGS: Readonly<{
  idleInTransactionSessionTimeout: string;
  statementTimeout: string;
}> = Object.freeze({
  idleInTransactionSessionTimeout: 'idle_in_transaction_session_timeout',
  statementTimeout: 'statement_timeout',
});

/** The savepoint a transaction naming a failure event must run its work under. */
export const WORK_SAVEPOINT = 'audited_work';

/**
 * The one query that must begin a transaction naming a failure event: `BEGIN` and its savepoint, two
 * statements in one text given without values, sent before the actor is declared.
 */
export const BEGIN_UNDER_SAVEPOINT = `BEGIN; SAVEPOINT ${WORK_SAVEPOINT}`;

/**
 * Every table the tests read or write, each with its columns: the one place the tests assume a
 * table's or a column's name. Names follow `schema.md` as the rulings adjust it; the README's table
 * of assumptions lists each one no design document fixes. Among those:
 *
 * - `notice_retention`, one row owned by the migration role and readable by the controller's role
 *   alone: the retention floor the deployment command sets, which `trim_notices` reads (R3).
 * - `policy_generation`, one row: the generation the policy triggers raise in each change's
 *   transaction, which the payload cache's key carries (R6).
 * - `rules_digest`, one row: the digest of the baseline and the signed-in rule the controller last
 *   started with, from which a start under changed rules writes one baseline notice (#210 Q2).
 * - `resources.retired_at` and `retired_by`: a retired resource keeps its row, so the unique index
 *   on its external identifier goes on reserving it (#320 B).
 * - `sid_sign_outs` and `subject_sign_outs`: the sign-outs relayed from the identity provider, by
 *   `sid`, and by subject for a token carrying no `sid`, each kept until its `expires_at`, the sign-out
 *   plus the longest sign-in token lifetime (R7).
 * - `exchanged_sids`: each `sid` a sign-in exchange carried, with its issuer, subject and the sign-in
 *   token's expiry, kept no longer than that token's life, so a logout naming only the `sid` reaches
 *   its subject (R7, option a).
 * - `global_revocations`: who revoked globally, when, and a fixed reason code; its insert writes the
 *   global notice and raises the policy generation in its transaction.
 * - `schema_migrations`: each applied migration's name, a checksum of its content, and when it was
 *   applied.
 * - `change_records`: `old_row` and `new_row` hold a row's values as a JSON object keyed by column
 *   name, `null` where the operation has none, and `row_key` the changed row's primary key columns as
 *   a JSON object the same way; `idp_subject_id` holds the declared actor's subject, `null` where the
 *   actor's type says there is nobody.
 * - `users` holds the person alone, and `user_identities` each identity a person signs in with
 *   (ruled): the first release records one per person, written with the person in one transaction,
 *   `added_by` `null` where Usher records it on first meeting a subject. Its key on issuer and
 *   subject identifier is {@link POLICY_CONSTRAINTS}' `identity`.
 * - Every column holding the identity provider's subject identifier is `idp_subject_id`, beside
 *   `idp_issuer` wherever the issuer is stored (ruled): in `user_identities`, `exchanged_sids`,
 *   `notices`, both sign-out tables and `change_records`. `notices.idp_subject_id` holds the subject
 *   alone; see {@link noticeSubject}.
 * - `audit_log.severity`: the event's severity as its line carries it (#214 Q2).
 */
export const POLICY_TABLES = {
  applicationKeys: {
    columns: {
      applicationId: 'application_id',
      confirmedAt: 'confirmed_at',
      encryptedKey: 'encrypted_key',
      id: 'id',
      issuedAt: 'issued_at',
      issuedBy: 'issued_by',
      revokedAt: 'revoked_at',
      revokedBy: 'revoked_by',
    },
    name: 'application_keys',
  },
  applicationResources: {
    columns: { applicationId: 'application_id', resourceId: 'resource_id' },
    name: 'application_resources',
  },
  applications: {
    columns: {
      description: 'description',
      displayName: 'display_name',
      id: 'id',
      registeredAt: 'registered_at',
      registeredBy: 'registered_by',
    },
    name: 'applications',
  },
  auditLog: {
    columns: {
      data: 'data',
      dataschema: 'dataschema',
      id: 'id',
      occurredAt: 'occurred_at',
      severity: 'severity',
      source: 'source',
      specversion: 'specversion',
      type: 'type',
    },
    name: 'audit_log',
  },
  capabilities: {
    columns: {
      action: 'action',
      description: 'description',
      displayName: 'display_name',
      entity: 'entity',
      id: 'id',
      plane: 'plane',
    },
    name: 'capabilities',
  },
  categories: {
    columns: {
      description: 'description',
      id: 'id',
      name: 'name',
      resourceId: 'resource_id',
      scope: 'scope',
    },
    name: 'categories',
  },
  changeRecords: {
    columns: {
      actorType: 'actor_type',
      id: 'id',
      idpSubjectId: 'idp_subject_id',
      newRow: 'new_row',
      oldRow: 'old_row',
      operation: 'operation',
      recordedAt: 'recorded_at',
      rowKey: 'row_key',
      tableName: 'table_name',
    },
    name: 'change_records',
  },
  exchangedSids: {
    columns: {
      expiresAt: 'expires_at',
      idpIssuer: 'idp_issuer',
      idpSubjectId: 'idp_subject_id',
      sid: 'sid',
    },
    name: 'exchanged_sids',
  },
  globalRevocations: {
    columns: {
      id: 'id',
      reasonCode: 'reason_code',
      revokedAt: 'revoked_at',
      revokedBy: 'revoked_by',
    },
    name: 'global_revocations',
  },
  grantDecisions: {
    columns: {
      capabilities: 'capabilities',
      decidedAt: 'decided_at',
      decision: 'decision',
      grantId: 'grant_id',
      id: 'id',
      userId: 'user_id',
    },
    name: 'grant_decisions',
  },
  grants: {
    columns: {
      expiresAt: 'expires_at',
      fieldCategoryId: 'field_category_id',
      grantedAt: 'granted_at',
      grantedBy: 'granted_by',
      holderGroupId: 'holder_group_id',
      holderUserId: 'holder_user_id',
      id: 'id',
      recordCategoryId: 'record_category_id',
      resourceId: 'resource_id',
      revokedAt: 'revoked_at',
      revokedBy: 'revoked_by',
      roleId: 'role_id',
    },
    name: 'grants',
  },
  groupUsers: {
    columns: { groupId: 'group_id', userId: 'user_id' },
    name: 'group_users',
  },
  groups: {
    columns: {
      createdAt: 'created_at',
      createdBy: 'created_by',
      description: 'description',
      id: 'id',
      name: 'name',
      resourceId: 'resource_id',
    },
    name: 'groups',
  },
  invitations: {
    columns: {
      email: 'email',
      expiresAt: 'expires_at',
      fieldCategoryId: 'field_category_id',
      id: 'id',
      invitedAt: 'invited_at',
      invitedBy: 'invited_by',
      linkTokenHash: 'link_token_hash',
      recordCategoryId: 'record_category_id',
      resourceId: 'resource_id',
      roleId: 'role_id',
    },
    name: 'invitations',
  },
  keyEncryptionKeyCheck: {
    columns: {
      checkValue: 'check_value',
      onlyRow: 'only_row',
      recordedAt: 'recorded_at',
    },
    name: 'key_encryption_key_check',
  },
  noticeRetention: {
    columns: { floorSeconds: 'floor_seconds', singleton: 'singleton' },
    name: 'notice_retention',
  },
  noticeStream: {
    columns: {
      epoch: 'epoch',
      singleton: 'singleton',
      trimmedThrough: 'trimmed_through',
    },
    name: 'notice_stream',
  },
  notices: {
    columns: {
      audience: 'audience',
      createdAt: 'created_at',
      idpSubjectId: 'idp_subject_id',
      kind: 'kind',
      position: 'position',
      resourceExternalId: 'resource_external_id',
    },
    name: 'notices',
  },
  notificationOutbox: {
    columns: {
      createdAt: 'created_at',
      deliveredAt: 'delivered_at',
      grantId: 'grant_id',
      id: 'id',
      kind: 'kind',
      recipientUserId: 'recipient_user_id',
    },
    name: 'notification_outbox',
  },
  policyGeneration: {
    columns: { generation: 'generation', singleton: 'singleton' },
    name: 'policy_generation',
  },
  principalRevocations: {
    columns: {
      id: 'id',
      liftedAt: 'lifted_at',
      liftedBy: 'lifted_by',
      reason: 'reason',
      revokedAt: 'revoked_at',
      revokedBy: 'revoked_by',
      userId: 'user_id',
    },
    name: 'principal_revocations',
  },
  resourceCategories: {
    columns: { categoryId: 'category_id', resourceId: 'resource_id' },
    name: 'resource_categories',
  },
  resourceFieldValues: {
    columns: { fieldId: 'field_id', resourceId: 'resource_id', value: 'value' },
    name: 'resource_field_values',
  },
  resourceFields: {
    columns: { description: 'description', id: 'id', name: 'name' },
    name: 'resource_fields',
  },
  resources: {
    columns: {
      baseTier: 'base_tier',
      description: 'description',
      externalId: 'external_id',
      id: 'id',
      name: 'name',
      registeredAt: 'registered_at',
      registeredBy: 'registered_by',
      retiredAt: 'retired_at',
      retiredBy: 'retired_by',
      suppressed: 'suppressed',
      updatedAt: 'updated_at',
    },
    name: 'resources',
  },
  rolePermissions: {
    columns: { capabilityId: 'capability_id', roleId: 'role_id' },
    name: 'role_permissions',
  },
  roles: {
    columns: {
      description: 'description',
      id: 'id',
      name: 'name',
      plane: 'plane',
    },
    name: 'roles',
  },
  rulesDigest: {
    columns: {
      digest: 'digest',
      recordedAt: 'recorded_at',
      singleton: 'singleton',
    },
    name: 'rules_digest',
  },
  schemaMigrations: {
    columns: { appliedAt: 'applied_at', checksum: 'checksum', name: 'name' },
    name: 'schema_migrations',
  },
  sidSignOuts: {
    columns: {
      expiresAt: 'expires_at',
      idpIssuer: 'idp_issuer',
      idpSubjectId: 'idp_subject_id',
      sid: 'sid',
      signedOutAt: 'signed_out_at',
    },
    name: 'sid_sign_outs',
  },
  subjectSignOuts: {
    columns: {
      expiresAt: 'expires_at',
      idpIssuer: 'idp_issuer',
      idpSubjectId: 'idp_subject_id',
      signedOutAt: 'signed_out_at',
    },
    name: 'subject_sign_outs',
  },
  userIdentities: {
    columns: {
      addedAt: 'added_at',
      addedBy: 'added_by',
      id: 'id',
      idpIssuer: 'idp_issuer',
      idpSubjectId: 'idp_subject_id',
      userId: 'user_id',
    },
    name: 'user_identities',
  },
  users: {
    columns: {
      createdAt: 'created_at',
      id: 'id',
    },
    name: 'users',
  },
} as const;

/**
 * The constraints and indexes a test names, as PostgreSQL reports them in a refusal: the decisions'
 * key on person, grant and time (#207 Q12); the identities' key on issuer and subject identifier, so
 * one identity belongs to one person; and the partial unique index allowing one live grant per
 * holder, resource, category and role (#212 Q17). The two keys carry PostgreSQL's default names.
 */
export const POLICY_CONSTRAINTS: Readonly<{
  decisionOrder: string;
  identity: string;
  liveGrant: string;
}> = Object.freeze({
  decisionOrder: 'grant_decisions_user_id_grant_id_decided_at_key',
  identity: 'user_identities_idp_issuer_idp_subject_id_key',
  liveGrant: 'grants_live_unique',
});

/**
 * The functions a test calls. `trimNotices`, owned by the migration role and executable by the
 * controller's role alone (R3), takes no argument: it reads the floor from `notice_retention`,
 * deletes the notices through the watermark that floor gives, raises `trimmed_through` in the same
 * transaction, and returns it. No caller can choose the floor, so none can trim a notice a bridge
 * may still need.
 */
export const POLICY_FUNCTIONS: Readonly<{ trimNotices: string }> =
  Object.freeze({ trimNotices: 'trim_notices' });

/**
 * The column of `grant_decisions` marking a decision the EGO migration recorded for a migrated
 * submitter rather than one the person gave: it holds `'migration'` on each acceptance a migration
 * records, and `null` on a person's own answer.
 * The name is assumed, and kept apart from {@link POLICY_TABLES}, whose columns are those `schema.md`
 * names, until the schema names it.
 */
export const DECISION_ORIGIN_COLUMN = 'origin';

/** The notice kinds, spelled as on the wire. */
export const NOTICE_KINDS = Object.freeze([
  'baseline',
  'category',
  'global',
  'principal',
  'servedResources',
] as const);

/** The kind of the outbox row that tells a resource's owners of a self-grant on it (#212 Q13). */
export const SELF_GRANT_NOTIFICATION = 'selfGrant';

/**
 * The seeded role whose holders own a resource (permissions-model.md). An owner grant is a person's
 * grant of this role; a group's grant of it never makes anyone an owner. Only an accepted, unexpired,
 * unrevoked owner grant counts as an owner (#211 Q13 with #212 Q20): the no-owner invariant, held by
 * the database from a resource's first owner on, counts those alone, and a retirement ends them in its
 * own transaction (#320 B, as the developer adjusted it).
 */
export const OWNER_ROLE = 'owner';

/** A role the controller seeds, as permissions-model.md's seeded matrix names it. */
export type SeededRole =
  'admin' | 'curator' | 'editor' | 'owner' | 'submitter' | 'viewer';

const VIEWER_CAPABILITIES = ['record.count', 'record.export', 'record.view'];

const EDITOR_CAPABILITIES = [
  ...VIEWER_CAPABILITIES,
  'record.create',
  'record.update',
];

const OWNER_CAPABILITIES = [
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
];

const seededRole = (
  plane: FixtureRole['plane'],
  capabilities: readonly string[],
): Readonly<FixtureRole> =>
  Object.freeze({
    capabilities: Object.freeze(capabilities.toSorted()),
    plane,
  });

/**
 * What each seeded role carries, as `entity.action` names, sorted, and its plane: the seeded matrix of
 * permissions-model.md ("The seeded roles, as a matrix"), the authority, and the one place the tests
 * read it from, so what a person answering a grant is shown is this list for its role.
 *
 * - The data plane's staircase, `read` being count, view and export: `viewer` reads; `editor` reads,
 *   creates and updates; `curator` does all that and deletes. `submitter`, off the staircase, creates
 *   and updates and reads nothing.
 * - The control plane's checklist: `owner` holds `grant.*` (create, view, extend, reduce, revoke),
 *   `invitation.create`, `resource.view`, `update`, `suppress` and `restore`, and `ownership.transfer`;
 *   `admin` holds all of an owner's and the four platform-wide ones beside them, `resource.register`,
 *   `category.create`, `role.define` and `group.*` (create, view, update, addMember, removeMember).
 *   An administrator is one by the management token's realm role (#212 Q3); the row is the matrix's.
 */
export const SEEDED_ROLES: Readonly<Record<SeededRole, Readonly<FixtureRole>>> =
  Object.freeze({
    admin: seededRole('control', [
      ...OWNER_CAPABILITIES,
      'category.create',
      'group.addMember',
      'group.create',
      'group.removeMember',
      'group.update',
      'group.view',
      'resource.register',
      'role.define',
    ]),
    curator: seededRole('data', [...EDITOR_CAPABILITIES, 'record.delete']),
    editor: seededRole('data', EDITOR_CAPABILITIES),
    owner: seededRole('control', OWNER_CAPABILITIES),
    submitter: seededRole('data', ['record.create', 'record.update']),
    viewer: seededRole('data', VIEWER_CAPABILITIES),
  });

/** The issuer fixture users carry when neither they nor the fixture name one. */
export const DEFAULT_FIXTURE_ISSUER = 'https://auth.example.org/realms/usher';

/**
 * The fixture user who registers, creates, grants and revokes wherever an entry names no one. A
 * fixture naming no user by this name gets one, with an invented subject, when an entry needs it.
 */
export const STEWARD = 'steward';

/**
 * A table's name qualified by the schema named for Usher, quoted, for a test's own SQL.
 *
 * @param table an entry of {@link POLICY_TABLES}.
 */
export const qualified = ({ name }: { name: string }): string =>
  `${pg.escapeIdentifier(USHER_SCHEMA)}.${pg.escapeIdentifier(name)}`;

/** A resource's base tier, as `schema.md` spells it. */
export type BaseTier = 'grant' | 'open' | 'registered';

/**
 * A fixture user: a person, named by the issuer and subject of their one identity, which seeding
 * writes to `user_identities` beside the person's `users` row.
 */
export interface FixtureUser {
  /** The fixture's issuer by default. */
  issuer?: string;

  subject: string;
}

/** A role the fixture defines, beside those the controller writes at start. */
export interface FixtureRole {
  /** What the role carries, as `entity.action` names; a capability not yet held is added. */
  capabilities: readonly string[];

  plane: 'control' | 'data';
}

/** A global category the fixture registers, keyed by its name: `controlled`, never `global.controlled`. */
export interface FixtureCategory {
  description?: string;
}

/** A resource field the fixture defines, instance-wide, keyed by its name. */
export interface FixtureField {
  description?: string;
}

/** A resource the fixture registers, keyed by its externalId. */
export interface FixtureResource {
  baseTier: BaseTier;

  /**
   * Categories of the resource's own, keyed by name, written at the database: no operation of the
   * first release registers one (#211 Q10).
   */
  categories?: Readonly<Record<string, FixtureCategory>>;

  description?: string;

  /** Its values of the resource fields, by field name. */
  fieldValues?: Readonly<Record<string, string>>;

  /** The display name. */
  name: string;

  /**
   * The categories it offers: a global one by bare name (a fixture category, or one already held,
   * such as `unmarked`) or as `global.<name>`, and one of its own as `resource.<name>`.
   */
  offers?: readonly string[];

  /**
   * When it was registered: the transaction's clock by default. Set once the rest of the fixture is
   * written, then read back into {@link SeededPolicy.resourceTimes}.
   */
  registeredAt?: Date;

  /** A fixture user; the steward by default. */
  registeredBy?: string;

  /** Retired at the given time, the transaction's clock by default, by the given fixture user, the steward by default (#320 B). */
  retired?: { at?: Date; by?: string };

  /** False by default. */
  suppressed?: boolean;

  /**
   * When it last changed: the transaction's clock by default. Set with {@link registeredAt}, and read
   * back, since a trigger keeping `updated_at` may rewrite what was written.
   */
  updatedAt?: Date;
}

/** When a resource was registered and last changed. */
export interface ResourceTimes {
  registeredAt: Date;
  updatedAt: Date;
}

/**
 * An application registered by the fixture, keyed by a label, which seeding writes as its display
 * name. Its id, the audience, is a uuid: {@link fixtureApplicationId}'s for the label by default, so
 * seeding again finds the application by its id.
 */
export interface FixtureApplication {
  description?: string;

  /**
   * The id of an application registered already, such as one registered through the API with its
   * keys: seeding writes no row for an application held by that id, only what it serves.
   */
  id?: string;

  /** A fixture user; the steward by default. */
  registeredBy?: string;

  /** The resources it serves, by externalId. */
  serves: readonly string[];
}

/**
 * The id given by seeding to a fixture application when the fixture names none, the same in every
 * database, so a fixture seeded again, or a test naming the application, reaches the same row: the
 * SHA-256 of the namespaced label, laid out as RFC 9562 lays out a custom uuid, its version nibble 8
 * and its variant bits `10`. The version tells a fixture's id from one generated by the store.
 * Applications registered through the API keep the ids given by the controller.
 *
 * @param label the application's label in the fixture, its display name.
 */
export const fixtureApplicationId = (label: string): string => {
  const hex = createHash('sha256')
    .update(`usher-test-application:${label}`)
    .digest('hex');
  const version = `8${hex.slice(13, 16)}`;
  const variant = `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    variant,
    hex.slice(20, 32),
  ].join('-');
};

/** A group the fixture creates on one resource, keyed by a name the fixture's grants use. */
export interface FixtureGroup {
  /** A fixture user; the steward by default. */
  createdBy?: string;

  description?: string;

  /** Its members, as fixture users. */
  members: readonly string[];

  /** The group's own name; the fixture's key for it by default. */
  name?: string;

  /** The resource it belongs to, by externalId. */
  resource: string;
}

/** Who holds a grant: a fixture user or a fixture group. */
export type FixtureHolder = { group: string } | { user: string };

/** A grant the fixture writes, keyed by a name its decisions and the returned ids use. */
export interface FixtureGrant {
  /**
   * A global category by bare name or as `global.<name>`, or one of the resource's own as
   * `resource.<name>`; `null` for the control plane's wildcard.
   */
  category: string | null;

  expiresAt?: Date;

  /** A field category within its category, named as `category` names one; none when absent. */
  fieldCategory?: string;

  /** The transaction's clock when it is written, by default. */
  grantedAt?: Date;

  /** A fixture user; the steward by default. */
  grantedBy?: string;

  holder: FixtureHolder;

  /** By externalId. */
  resource: string;

  /** Revoked at the given time, the transaction's clock by default, by the given fixture user, the steward by default. */
  revoked?: { at?: Date; by?: string };

  /** A role by name: a fixture one or one the controller wrote at start. */
  role: string;
}

/** An answer about a fixture grant. */
export interface FixtureDecision {
  /** What the person was shown, as `entity.action` names; what the grant's role carries now by default. */
  capabilities?: readonly string[];

  /** The transaction's clock when it is written, by default, so answers written in turn are ordered. */
  decidedAt?: Date;

  decision: 'accepted' | 'rejected';

  /** The fixture grant answered. */
  grant: string;

  /** The fixture user answering; the grant's holder by default, which a group's grant requires naming. */
  person?: string;
}

/** A pending invitation, which no operation of the first release writes. */
export interface FixtureInvitation {
  /** As a grant names it; `null` for the control plane's wildcard. */
  category: string | null;

  /** The address invited, as the store holds it: lower-cased (#207 Q9). */
  email: string;

  /** The resulting grant's expiry; none when absent (#207 Q9). */
  expiresAt?: Date;

  /** The transaction's clock by default. */
  invitedAt?: Date;

  /** A fixture user; the steward by default. */
  invitedBy?: string;

  /** The hash of the link's token: a SHA-256 of fresh random bytes by default. */
  linkTokenHash?: Uint8Array;

  /** By externalId. */
  resource: string;

  role: string;
}

/** A revocation of a principal entirely. */
export interface FixtureRevocation {
  /** Lifted at the given time, the transaction's clock by default, by the given fixture user, the steward by default. */
  lifted?: { at?: Date; by?: string };

  reason: string;

  /** The transaction's clock by default. */
  revokedAt?: Date;

  /** A fixture user; the steward by default. */
  revokedBy?: string;

  /** The fixture user revoked. */
  user: string;
}

/**
 * Policy to seed, synthetic throughout. Every entry is keyed by a name the fixture's other entries
 * refer to it by: users and groups by a fixture name, resources by externalId, applications by a
 * label written as their display name, categories, fields and roles by name.
 */
export interface PolicyFixture {
  applications?: Readonly<Record<string, FixtureApplication>>;
  categories?: Readonly<Record<string, FixtureCategory>>;
  decisions?: readonly FixtureDecision[];
  fields?: Readonly<Record<string, FixtureField>>;
  grants?: Readonly<Record<string, FixtureGrant>>;
  groups?: Readonly<Record<string, FixtureGroup>>;

  invitations?: readonly FixtureInvitation[];

  /** The issuer of every user naming none: {@link DEFAULT_FIXTURE_ISSUER} by default. */
  issuer?: string;

  resources?: Readonly<Record<string, FixtureResource>>;
  revocations?: readonly FixtureRevocation[];
  roles?: Readonly<Record<string, FixtureRole>>;
  users?: Readonly<Record<string, FixtureUser>>;
}

/**
 * The internal ids seeding wrote or resolved, by the fixture's names, for the tests that look for
 * them in an answer: every global category, role and resource held after seeding, and the fixture's
 * own fields, grants, groups, invitations, resource categories and users (each a `users.id`), the
 * steward included when written. A person already holding the identity a fixture user names is
 * found again through `user_identities` rather than written twice.
 */
export interface SeededPolicy {
  /** Each fixture application's id, the audience, by its label. */
  applications: Readonly<Record<string, string>>;

  categories: Readonly<Record<string, string>>;
  fields: Readonly<Record<string, string>>;
  grants: Readonly<Record<string, string>>;
  groups: Readonly<Record<string, string>>;

  /** The invitations' ids, in the fixture's order. */
  invitations: readonly string[];

  /** Each resource's own categories, by the resource's externalId, then by the category's name. */
  resourceCategories: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;

  /** Each fixture resource's registration and change times, by externalId, as the store holds them once seeded. */
  resourceTimes: Readonly<Record<string, ResourceTimes>>;

  resources: Readonly<Record<string, string>>;

  /** The principal revocations' ids, in the fixture's order. */
  revocations: readonly string[];

  roles: Readonly<Record<string, string>>;
  users: Readonly<Record<string, string>>;
}

/** The steward's invented subject, when seeding writes the steward. */
export const STEWARD_SUBJECT = 'steward-7b3e9c1a-usher-test';

const CLOCK: unique symbol = Symbol('clock_timestamp()');

type Cell =
  | boolean
  | Date
  | null
  | number
  | readonly string[]
  | string
  | typeof CLOCK
  | Uint8Array;

type Row = Readonly<Record<string, Cell>>;

const {
  applicationResources,
  applications,
  capabilities,
  categories,
  grantDecisions,
  grants,
  groupUsers,
  groups,
  invitations,
  principalRevocations,
  resourceCategories,
  resourceFieldValues,
  resourceFields,
  resources,
  rolePermissions,
  roles,
  userIdentities,
  users,
} = POLICY_TABLES;

const parameterIndexes = (cells: readonly Cell[]): readonly string[] =>
  cells.map((cell, index) =>
    cell === CLOCK
      ? 'clock_timestamp()'
      : `$${cells.slice(0, index + 1).filter((earlier) => earlier !== CLOCK).length}`,
  );

const insertStatement = (
  table: { name: string },
  row: Row,
  returning: string,
): { parameters: unknown[]; text: string } => {
  const entries = Object.entries(row);
  const cells = entries.map(([, cell]) => cell);
  return {
    parameters: cells.filter((cell) => cell !== CLOCK),
    text: `INSERT INTO ${qualified(table)} (${entries
      .map(([column]) => pg.escapeIdentifier(column))
      .join(', ')}) VALUES (${parameterIndexes(cells).join(', ')})${returning}`,
  };
};

const insertRow = async (
  client: pg.ClientBase,
  table: { name: string },
  row: Row,
): Promise<void> => {
  const { parameters, text } = insertStatement(table, row, '');
  await client.query(text, parameters);
};

const insertWithId = async (
  client: pg.ClientBase,
  table: { columns: { id: string }; name: string },
  row: Row,
): Promise<string> => {
  const { parameters, text } = insertStatement(
    table,
    row,
    ` RETURNING ${pg.escapeIdentifier(table.columns.id)} AS id`,
  );
  const { rows } = await client.query<{ id: string }>(text, parameters);
  const [inserted] = rows;
  if (inserted !== undefined) {
    return inserted.id;
  }
  throw new Error(`the insert into ${table.name} returned no id`);
};

/**
 * Runs work over items one at a time, each starting once the one before has settled, as statements
 * on one connection must, and gives the results in order.
 *
 * @param items the items.
 * @param work what to do with each.
 */
export const inTurn = <Item, Result>(
  items: readonly Item[],
  work: (item: Item) => Promise<Result>,
): Promise<readonly Result[]> =>
  items.reduce<Promise<readonly Result[]>>(
    async (earlier, item) => [...(await earlier), await work(item)],
    Promise.resolve([]),
  );

const insertRows = async (
  client: pg.ClientBase,
  table: { name: string },
  rows: readonly Row[],
): Promise<void> => {
  await inTurn(rows, (row) => insertRow(client, table, row));
};

const idsByName = async <Entry>(
  entries: Readonly<Record<string, Entry>>,
  insert: (entry: Entry, name: string) => Promise<string>,
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await inTurn(
      Object.entries(entries),
      async ([name, entry]) => [name, await insert(entry, name)] as const,
    ),
  );

const namedIds = async (
  client: pg.ClientBase,
  table: { columns: { id: string; name: string }; name: string },
  where: string,
): Promise<Readonly<Record<string, string>>> => {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT ${pg.escapeIdentifier(table.columns.name)} AS name, ${pg.escapeIdentifier(table.columns.id)} AS id FROM ${qualified(table)}${where}`,
  );
  return Object.fromEntries(rows.map(({ id, name }) => [name, id]));
};

const resolver =
  (
    ids: Readonly<Record<string, string>>,
    kind: string,
  ): ((name: string) => string) =>
  (name: string): string => {
    const id = Object.hasOwn(ids, name) ? ids[name] : undefined;
    if (id !== undefined) {
      return id;
    }
    throw new Error(`the fixture names no ${kind} ${name}`);
  };

const at = (time: Date | undefined): Date | typeof CLOCK => time ?? CLOCK;

const needsSteward = ({
  applications: fixtureApplications = {},
  grants: fixtureGrants = {},
  groups: fixtureGroups = {},
  invitations = [],
  resources: fixtureResources = {},
  revocations = [],
}: PolicyFixture): boolean =>
  [
    ...Object.values(fixtureResources).flatMap(({ registeredBy, retired }) => [
      registeredBy,
      ...(retired === undefined ? [] : [retired.by]),
    ]),
    ...invitations.map(({ invitedBy }) => invitedBy),
    ...Object.values(fixtureApplications).map(
      ({ registeredBy }) => registeredBy,
    ),
    ...Object.values(fixtureGroups).map(({ createdBy }) => createdBy),
    ...Object.values(fixtureGrants).flatMap(({ grantedBy, revoked }) => [
      grantedBy,
      ...(revoked === undefined ? [] : [revoked.by]),
    ]),
    ...revocations.flatMap(({ lifted, revokedBy }) => [
      revokedBy,
      ...(lifted === undefined ? [] : [lifted.by]),
    ]),
  ].some((actor) => actor === undefined);

const fixtureUsers = (
  fixture: PolicyFixture,
): Readonly<Record<string, FixtureUser>> => {
  const named = fixture.users ?? {};
  return Object.hasOwn(named, STEWARD) || !needsSteward(fixture)
    ? named
    : { ...named, [STEWARD]: { subject: STEWARD_SUBJECT } };
};

const capabilityParts = (
  capability: string,
): { action: string; entity: string } => {
  const [entity, action, ...rest] = capability.split('.');
  if (entity !== undefined && action !== undefined && rest.length === 0) {
    return { action, entity };
  }
  throw new Error(
    `the fixture names a capability ${capability} that is not entity.action`,
  );
};

const seedRoles = async (
  client: pg.ClientBase,
  fixtureRoles: Readonly<Record<string, FixtureRole>>,
): Promise<Readonly<Record<string, string>>> => {
  await inTurn(
    Object.values(fixtureRoles).flatMap(({ capabilities: held, plane }) =>
      held.map((capability) => ({
        capability,
        plane,
        ...capabilityParts(capability),
      })),
    ),
    ({ action, capability, entity, plane }) =>
      client.query(
        `INSERT INTO ${qualified(capabilities)} (${capabilities.columns.action}, ${capabilities.columns.displayName}, ${capabilities.columns.entity}, ${capabilities.columns.plane}) VALUES ($1, $2, $3, $4) ON CONFLICT (${capabilities.columns.entity}, ${capabilities.columns.action}) DO NOTHING`,
        [action, capability, entity, plane],
      ),
  );
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT ${capabilities.columns.entity} || '.' || ${capabilities.columns.action} AS name, ${capabilities.columns.id} AS id FROM ${qualified(capabilities)}`,
  );
  const capabilityId = resolver(
    Object.fromEntries(rows.map(({ id, name }) => [name, id])),
    'capability',
  );
  const written = await idsByName(fixtureRoles, ({ plane }, name) =>
    insertWithId(client, roles, {
      [roles.columns.name]: name,
      [roles.columns.plane]: plane,
    }),
  );
  await insertRows(
    client,
    rolePermissions,
    Object.entries(fixtureRoles).flatMap(([name, { capabilities: held }]) =>
      held.map((capability) => ({
        [rolePermissions.columns.capabilityId]: capabilityId(capability),
        [rolePermissions.columns.roleId]: resolver(written, 'role')(name),
      })),
    ),
  );
  return namedIds(client, roles, '');
};

const roleCapabilities = async (
  client: pg.ClientBase,
  roleId: string,
): Promise<readonly string[]> => {
  const { rows } = await client.query<{ capabilities: string[] }>(
    `SELECT coalesce(array_agg(capability.${capabilities.columns.entity} || '.' || capability.${capabilities.columns.action} ORDER BY capability.${capabilities.columns.entity}, capability.${capabilities.columns.action}), '{}') AS capabilities FROM ${qualified(rolePermissions)} permission JOIN ${qualified(capabilities)} capability ON capability.${capabilities.columns.id} = permission.${rolePermissions.columns.capabilityId} WHERE permission.${rolePermissions.columns.roleId} = $1`,
    [roleId],
  );
  return rows[0]?.capabilities ?? [];
};

const GLOBAL_SCOPE = 'global.';

const RESOURCE_SCOPE = 'resource.';

// A person already holding the identity is found again through it rather than written twice, so
// seeding can run more than once on one database. A new person is written with their one identity
// in the caller's transaction, `added_by` null as on a first meeting.
const heldOrWrittenPerson = async (
  client: pg.ClientBase,
  { issuer, subject }: { issuer: string; subject: string },
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ${pg.escapeIdentifier(userIdentities.columns.userId)}::text AS id FROM ${qualified(userIdentities)} WHERE ${pg.escapeIdentifier(userIdentities.columns.idpIssuer)} = $1 AND ${pg.escapeIdentifier(userIdentities.columns.idpSubjectId)} = $2`,
    [issuer, subject],
  );
  const [held] = rows;
  if (held !== undefined) {
    return held.id;
  }
  const userId = await insertWithId(client, users, {
    [users.columns.createdAt]: CLOCK,
  });
  await insertRow(client, userIdentities, {
    [userIdentities.columns.addedAt]: CLOCK,
    [userIdentities.columns.addedBy]: null,
    [userIdentities.columns.idpIssuer]: issuer,
    [userIdentities.columns.idpSubjectId]: subject,
    [userIdentities.columns.userId]: userId,
  });
  return userId;
};

const externalIds = async (
  client: pg.ClientBase,
): Promise<Readonly<Record<string, string>>> => {
  const { rows } = await client.query<{ external_id: string; id: string }>(
    `SELECT ${pg.escapeIdentifier(resources.columns.externalId)} AS external_id, ${pg.escapeIdentifier(resources.columns.id)} AS id FROM ${qualified(resources)}`,
  );
  return Object.fromEntries(
    rows.map(({ external_id, id }) => [external_id, id]),
  );
};

const applicationIds = async (
  client: pg.ClientBase,
): Promise<ReadonlySet<string>> => {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ${pg.escapeIdentifier(applications.columns.id)} AS id FROM ${qualified(applications)}`,
  );
  return new Set(rows.map(({ id }) => id));
};

const seedWithin = async (
  client: pg.ClientBase,
  fixture: PolicyFixture,
): Promise<SeededPolicy> => {
  const issuer = fixture.issuer ?? DEFAULT_FIXTURE_ISSUER;
  const userIds = await idsByName(fixtureUsers(fixture), (user) =>
    heldOrWrittenPerson(client, {
      issuer: user.issuer ?? issuer,
      subject: user.subject,
    }),
  );
  const user = resolver(userIds, 'user');
  const actor = (name: string | undefined): string => user(name ?? STEWARD);

  const roleIds = await seedRoles(client, fixture.roles ?? {});
  const role = resolver(roleIds, 'role');

  await insertRows(
    client,
    categories,
    Object.entries(fixture.categories ?? {}).map(([name, { description }]) => ({
      [categories.columns.description]: description ?? null,
      [categories.columns.name]: name,
      [categories.columns.scope]: 'global',
    })),
  );
  const categoryIds = await namedIds(
    client,
    categories,
    ` WHERE ${categories.columns.scope} = 'global'`,
  );
  const globalCategory = resolver(categoryIds, 'global category');

  const resourceIds = await idsByName(
    fixture.resources ?? {},
    (resource, externalId) =>
      insertWithId(client, resources, {
        [resources.columns.baseTier]: resource.baseTier,
        [resources.columns.description]: resource.description ?? null,
        [resources.columns.externalId]: externalId,
        [resources.columns.name]: resource.name,
        [resources.columns.registeredAt]: CLOCK,
        [resources.columns.registeredBy]: actor(resource.registeredBy),
        ...(resource.retired === undefined
          ? {}
          : {
              [resources.columns.retiredAt]: at(resource.retired.at),
              [resources.columns.retiredBy]: actor(resource.retired.by),
            }),
        [resources.columns.suppressed]: resource.suppressed ?? false,
        [resources.columns.updatedAt]: CLOCK,
      }),
  );
  const heldResources = {
    ...(await externalIds(client)),
    ...resourceIds,
  };
  const resource = resolver(heldResources, 'resource');

  const resourceCategoryIds: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = Object.fromEntries(
    await inTurn(
      Object.entries(fixture.resources ?? {}),
      async ([externalId, { categories: own = {} }]) =>
        [
          externalId,
          await idsByName(own, ({ description }, name) =>
            insertWithId(client, categories, {
              [categories.columns.description]: description ?? null,
              [categories.columns.name]: name,
              [categories.columns.resourceId]: resource(externalId),
              [categories.columns.scope]: 'resource',
            }),
          ),
        ] as const,
    ),
  );
  // A category is named by scope as a payload names it, or bare for a global one.
  const category = (name: string, externalId: string): string => {
    if (name.startsWith(RESOURCE_SCOPE)) {
      const own = resourceCategoryIds[externalId] ?? {};
      return resolver(
        own,
        `category of ${externalId}`,
      )(name.slice(RESOURCE_SCOPE.length));
    }
    return globalCategory(
      name.startsWith(GLOBAL_SCOPE) ? name.slice(GLOBAL_SCOPE.length) : name,
    );
  };

  await insertRows(
    client,
    resourceCategories,
    Object.entries(fixture.resources ?? {}).flatMap(
      ([externalId, { offers = [] }]) =>
        offers.map((name) => ({
          [resourceCategories.columns.categoryId]: category(name, externalId),
          [resourceCategories.columns.resourceId]: resource(externalId),
        })),
    ),
  );

  const fieldIds = await idsByName(
    fixture.fields ?? {},
    ({ description }, name) =>
      insertWithId(client, resourceFields, {
        [resourceFields.columns.description]: description ?? null,
        [resourceFields.columns.name]: name,
      }),
  );
  const field = resolver(fieldIds, 'resource field');
  await insertRows(
    client,
    resourceFieldValues,
    Object.entries(fixture.resources ?? {}).flatMap(
      ([externalId, { fieldValues = {} }]) =>
        Object.entries(fieldValues).map(([name, value]) => ({
          [resourceFieldValues.columns.fieldId]: field(name),
          [resourceFieldValues.columns.resourceId]: resource(externalId),
          [resourceFieldValues.columns.value]: value,
        })),
    ),
  );

  const applicationIdsByLabel = Object.fromEntries(
    Object.entries(fixture.applications ?? {}).map(([label, { id }]) => [
      label,
      id ?? fixtureApplicationId(label),
    ]),
  );
  const application = resolver(applicationIdsByLabel, 'application');
  const heldApplications = await applicationIds(client);
  await insertRows(
    client,
    applications,
    Object.entries(fixture.applications ?? {}).flatMap(
      ([label, { description, registeredBy }]) =>
        heldApplications.has(application(label))
          ? []
          : [
              {
                [applications.columns.description]: description ?? null,
                [applications.columns.displayName]: label,
                [applications.columns.id]: application(label),
                [applications.columns.registeredAt]: CLOCK,
                [applications.columns.registeredBy]: actor(registeredBy),
              },
            ],
    ),
  );
  await insertRows(
    client,
    applicationResources,
    Object.entries(fixture.applications ?? {}).flatMap(([label, { serves }]) =>
      serves.map((externalId) => ({
        [applicationResources.columns.applicationId]: application(label),
        [applicationResources.columns.resourceId]: resource(externalId),
      })),
    ),
  );

  const groupIds = await idsByName(fixture.groups ?? {}, (group, key) =>
    insertWithId(client, groups, {
      [groups.columns.createdAt]: CLOCK,
      [groups.columns.createdBy]: actor(group.createdBy),
      [groups.columns.description]: group.description ?? null,
      [groups.columns.name]: group.name ?? key,
      [groups.columns.resourceId]: resource(group.resource),
    }),
  );
  const group = resolver(groupIds, 'group');
  await insertRows(
    client,
    groupUsers,
    Object.entries(fixture.groups ?? {}).flatMap(([key, { members }]) =>
      members.map((member) => ({
        [groupUsers.columns.groupId]: group(key),
        [groupUsers.columns.userId]: user(member),
      })),
    ),
  );

  const grantIds = await idsByName(fixture.grants ?? {}, (grant) =>
    insertWithId(client, grants, {
      [grants.columns.expiresAt]: grant.expiresAt ?? null,
      [grants.columns.fieldCategoryId]:
        grant.fieldCategory === undefined
          ? null
          : category(grant.fieldCategory, grant.resource),
      [grants.columns.grantedAt]: at(grant.grantedAt),
      [grants.columns.grantedBy]: actor(grant.grantedBy),
      [grants.columns.holderGroupId]:
        'group' in grant.holder ? group(grant.holder.group) : null,
      [grants.columns.holderUserId]:
        'user' in grant.holder ? user(grant.holder.user) : null,
      [grants.columns.recordCategoryId]:
        grant.category === null
          ? null
          : category(grant.category, grant.resource),
      [grants.columns.resourceId]: resource(grant.resource),
      [grants.columns.revokedAt]:
        grant.revoked === undefined ? null : at(grant.revoked.at),
      [grants.columns.revokedBy]:
        grant.revoked === undefined ? null : actor(grant.revoked.by),
      [grants.columns.roleId]: role(grant.role),
    }),
  );
  const fixtureGrant = (name: string): FixtureGrant => {
    const grant = fixture.grants?.[name];
    if (grant !== undefined && Object.hasOwn(fixture.grants ?? {}, name)) {
      return grant;
    }
    throw new Error(`the fixture names no grant ${name}`);
  };
  const decider = ({ grant, person }: FixtureDecision): string => {
    const { holder } = fixtureGrant(grant);
    const answering = person ?? ('user' in holder ? holder.user : undefined);
    if (answering !== undefined) {
      return user(answering);
    }
    throw new Error(
      `the fixture's decision on ${grant}, a group's grant, names no person`,
    );
  };
  await inTurn(fixture.decisions ?? [], async (decision) =>
    insertRow(client, grantDecisions, {
      [grantDecisions.columns.capabilities]:
        decision.capabilities ??
        (await roleCapabilities(
          client,
          role(fixtureGrant(decision.grant).role),
        )),
      [grantDecisions.columns.decidedAt]: at(decision.decidedAt),
      [grantDecisions.columns.decision]: decision.decision,
      [grantDecisions.columns.grantId]: resolver(
        grantIds,
        'grant',
      )(decision.grant),
      [grantDecisions.columns.userId]: decider(decision),
    }),
  );

  const revocationIds = await inTurn(fixture.revocations ?? [], (revocation) =>
    insertWithId(client, principalRevocations, {
      [principalRevocations.columns.liftedAt]:
        revocation.lifted === undefined ? null : at(revocation.lifted.at),
      [principalRevocations.columns.liftedBy]:
        revocation.lifted === undefined ? null : actor(revocation.lifted.by),
      [principalRevocations.columns.reason]: revocation.reason,
      [principalRevocations.columns.revokedAt]: at(revocation.revokedAt),
      [principalRevocations.columns.revokedBy]: actor(revocation.revokedBy),
      [principalRevocations.columns.userId]: user(revocation.user),
    }),
  );

  const invitationIds = await inTurn(fixture.invitations ?? [], (invitation) =>
    insertWithId(client, invitations, {
      [invitations.columns.email]: invitation.email,
      [invitations.columns.expiresAt]: invitation.expiresAt ?? null,
      [invitations.columns.invitedAt]: at(invitation.invitedAt),
      [invitations.columns.invitedBy]: actor(invitation.invitedBy),
      [invitations.columns.linkTokenHash]:
        invitation.linkTokenHash ??
        createHash('sha256').update(randomBytes(32)).digest(),
      [invitations.columns.recordCategoryId]:
        invitation.category === null
          ? null
          : category(invitation.category, invitation.resource),
      [invitations.columns.resourceId]: resource(invitation.resource),
      [invitations.columns.roleId]: role(invitation.role),
    }),
  );

  // Set last, so no write seeding makes afterwards can move them.
  await inTurn(
    Object.entries(fixture.resources ?? {}).filter(
      ([, { registeredAt, updatedAt }]) =>
        registeredAt !== undefined || updatedAt !== undefined,
    ),
    ([externalId, { registeredAt, updatedAt }]) =>
      client.query(
        `UPDATE ${qualified(resources)} SET ${pg.escapeIdentifier(resources.columns.registeredAt)} = coalesce($1::timestamptz, ${pg.escapeIdentifier(resources.columns.registeredAt)}), ${pg.escapeIdentifier(resources.columns.updatedAt)} = coalesce($2::timestamptz, ${pg.escapeIdentifier(resources.columns.updatedAt)}) WHERE ${pg.escapeIdentifier(resources.columns.id)} = $3`,
        [registeredAt ?? null, updatedAt ?? null, resource(externalId)],
      ),
  );
  const resourceTimes = await storedResourceTimes(
    client,
    Object.keys(fixture.resources ?? {}),
  );

  return {
    applications: applicationIdsByLabel,
    categories: categoryIds,
    fields: fieldIds,
    grants: grantIds,
    groups: groupIds,
    invitations: invitationIds,
    resourceCategories: resourceCategoryIds,
    resourceTimes,
    resources: heldResources,
    revocations: revocationIds,
    roles: roleIds,
    users: userIds,
  };
};

/**
 * Declares who acts in the transaction in progress, as the audit triggers read it: each setting in
 * {@link ACTOR_SETTINGS} set with `set_config(..., true)`, so it lasts until the transaction ends and
 * reaches no other. Outside a transaction it lasts one statement, which is why
 * {@link inTransactionAs} is the usual way in.
 *
 * @param client a connection with a transaction open.
 * @param actor who acts.
 */
export const declareActor = async (
  client: pg.ClientBase,
  actor: Actor,
): Promise<void> => {
  await client.query(
    'SELECT set_config($1, $2, true), set_config($3, $4, true)',
    [
      ACTOR_SETTINGS.type,
      actor.type,
      ACTOR_SETTINGS.id,
      'id' in actor ? actor.id : '',
    ],
  );
};

/**
 * Runs work in one transaction that declares its actor first, committing when the work settles and
 * rolling back when it throws.
 *
 * @param client the connection to run on, holding no transaction.
 * @param actor who acts.
 * @param work the statements to run, on the same connection.
 */
export const inTransactionAs = async <Result>(
  client: pg.ClientBase,
  actor: Actor,
  work: () => Promise<Result>,
): Promise<Result> => {
  await client.query('BEGIN');
  try {
    await declareActor(client, actor);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

/**
 * Seeds a fixture in one transaction under the system actor (R9), as the policy tables name it:
 * people, each with their one identity (`added_by` `null`, as on a first meeting), the fixture's
 * roles and their capabilities, global categories, resources, their own categories and what each
 * offers, a retirement, resource fields and their values, applications and what they serve, groups
 * and their members, grants, decisions, principal revocations and invitations; then the resources'
 * registration and change times, read back as the store holds them. Run it as the migration role.
 * It can run more than once on one database: a person already holding the identity a fixture user
 * names, found through `user_identities`, and an application already held, by its id
 * ({@link FixtureApplication}), are found again rather than written twice, and a resource already
 * held can be named by externalId. A name the fixture refers to and does not hold throws, naming it,
 * and nothing is written.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param fixture the policy to write.
 * @returns the internal ids written, by the fixture's names.
 */
export const seedPolicy = (
  client: pg.ClientBase,
  fixture: PolicyFixture,
): Promise<SeededPolicy> =>
  inTransactionAs(client, SYSTEM_ACTOR, () => seedWithin(client, fixture));

/**
 * What the template seeds the policy under: the rules a harness's controller starts under unless a test
 * sets its own, count, view and export for each, so a controller started on a store cloned from the
 * template under the harness's configuration finds them recorded; and the harness's event source and
 * instance, which the template's `baseline.change` event names. The clock is the system's.
 */
export const STARTED_STORE_SETTINGS: Readonly<
  Omit<SeededPolicySettings, 'databaseSchema'>
> = Object.freeze({
  baseline: Object.freeze(['count', 'view', 'export'] as const),
  clock: Object.freeze({ now: () => Date.now() }),
  eventSource: 'https://usher.example.org/controller',
  instanceName: 'usher-test-1',
  signedInRule: Object.freeze(['count', 'view', 'export'] as const),
});

/**
 * The controller's template with the policy a start seeds written by the controller's own code
 * (#207 Q11), under {@link STARTED_STORE_SETTINGS}: the capability vocabulary, {@link SEEDED_ROLES}
 * with their capabilities, and the digest of the rules with the first start's `baseline.change` row.
 * It is a store as a started controller leaves it, but for the key-encryption key's check value, which
 * the first start under a key records: for a test seeding a fixture that names the seeded roles while
 * starting no controller. Run again on a clone, it sets the retention floor alone, as the migrations
 * do, since the controller's writes leave a store holding them untouched.
 */
export const STARTED_STORE_TEMPLATE: DatabaseTemplate = Object.freeze({
  migrate: async (options: MigrationOptions) => {
    await USHER_TEMPLATE.migrate(options);
    const client = new pg.Client({ connectionString: options.databaseUrl });
    await client.connect();
    try {
      await writeSeededPolicy(client, {
        ...STARTED_STORE_SETTINGS,
        databaseSchema: options.schema,
      });
    } finally {
      await client.end();
    }
  },
  name: 'usher_template_started',
  schema: USHER_SCHEMA,
});

/**
 * Fixtures combined into one: each record merged by name, a later fixture's entry winning; each list
 * joined in order; and the issuer the last fixture naming one gives, so a fixture's issuer is never
 * dropped by merging it with one naming none.
 *
 * @param policies the fixtures, in order.
 */
export const mergedPolicy = (
  ...policies: readonly PolicyFixture[]
): PolicyFixture =>
  policies.reduce<PolicyFixture>((merged, policy) => {
    const issuer = policy.issuer ?? merged.issuer;
    return {
      applications: { ...merged.applications, ...policy.applications },
      categories: { ...merged.categories, ...policy.categories },
      decisions: [...(merged.decisions ?? []), ...(policy.decisions ?? [])],
      fields: { ...merged.fields, ...policy.fields },
      grants: { ...merged.grants, ...policy.grants },
      groups: { ...merged.groups, ...policy.groups },
      invitations: [
        ...(merged.invitations ?? []),
        ...(policy.invitations ?? []),
      ],
      ...(issuer === undefined ? {} : { issuer }),
      resources: { ...merged.resources, ...policy.resources },
      revocations: [
        ...(merged.revocations ?? []),
        ...(policy.revocations ?? []),
      ],
      roles: { ...merged.roles, ...policy.roles },
      users: { ...merged.users, ...policy.users },
    };
  }, {});

/** A trim in a transaction still open, so a test can look between the trim and its commit. */
export interface OpenTrim {
  /** Commits the trim's transaction. */
  commit(): Promise<void>;

  /** Rolls the trim's transaction back. */
  rollback(): Promise<void>;

  /** The watermark the function returned. */
  trimmedThrough: bigint;
}

/**
 * Runs the trimming function, `trim_notices()` (R3), as the connection's role, in a transaction it
 * leaves open.
 *
 * @param runtime a connection under the controller's runtime role, holding no transaction.
 * @throws what the function threw, the transaction rolled back.
 */
export const trimNoticesOpen = async (
  runtime: pg.ClientBase,
): Promise<OpenTrim> => {
  await runtime.query('BEGIN');
  try {
    const { rows } = await runtime.query<{ trimmed_through: string }>(
      `SELECT ${qualified({ name: POLICY_FUNCTIONS.trimNotices })}()::text AS trimmed_through`,
    );
    return {
      commit: async () => {
        await runtime.query('COMMIT');
      },
      rollback: async () => {
        await runtime.query('ROLLBACK');
      },
      trimmedThrough: BigInt(rows[0]?.trimmed_through ?? '0'),
    };
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }
};

/**
 * Runs the trimming function as the connection's role and commits.
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
 * What `notices.idp_subject_id` holds for a person: the identity provider's subject alone. Should
 * Usher ever accept more than one issuer, it becomes the issuer and subject pair, which changes this
 * alone.
 *
 * @param person the person, by the provider's subject.
 */
export const noticeSubject = ({ subject }: { subject: string }): string =>
  subject;

/**
 * How many people the store holds an identity for by a subject, under any issuer, read through
 * `user_identities`: how a test sees whether an exchange wrote, or did not write, a person.
 *
 * @param client a connection under the migration role.
 * @param subject the identity provider's subject.
 */
export const usersWithSubject = async (
  client: pg.ClientBase,
  subject: string,
): Promise<number> => {
  const { rows } = await client.query<{ count: number }>(
    `SELECT count(DISTINCT ${pg.escapeIdentifier(userIdentities.columns.userId)})::int AS count FROM ${qualified(userIdentities)} WHERE ${pg.escapeIdentifier(userIdentities.columns.idpSubjectId)} = $1`,
    [subject],
  );
  return rows[0]?.count ?? 0;
};

/**
 * An id seeding wrote, by the fixture's name for it.
 *
 * @param ids one record of the ids a seeding gave, such as its grants.
 * @param name the fixture's name.
 * @throws naming the name, when seeding wrote nothing by it.
 */
export const seededId = (
  ids: Readonly<Record<string, string>>,
  name: string,
): string => {
  const id = Object.hasOwn(ids, name) ? ids[name] : undefined;
  if (id !== undefined) {
    return id;
  }
  throw new Error(`seeding wrote nothing named ${name}`);
};

/** A grant as a test looks it up after writing it, through the API or by SQL. */
export interface GrantLookup {
  /** As a grant names it: a global category bare or scoped, `resource.<name>`, or `null` for the wildcard; any when absent. */
  category?: string | null;

  /** The holder, by the identity provider's subject. */
  holder: string;

  /** By externalId. */
  resource: string;

  /** By name; any when absent. */
  role?: string;
}

const quotedColumn = (name: string): string => pg.escapeIdentifier(name);

// A person's identity read by their `users.id` as a scalar subquery, which PostgreSQL refuses as a
// cardinality violation when the person holds more than one: the first release records one per
// person, so a reader assuming one fails, through `readingOneIdentity`, rather than picking one.
const identityColumnOf = (userId: string, column: string): string =>
  `(SELECT identity_row.${quotedColumn(column)} FROM ${qualified(userIdentities)} identity_row WHERE identity_row.${quotedColumn(userIdentities.columns.userId)} = ${userId})`;

const holdsIdentityBy = (userId: string, subject: string): string =>
  `EXISTS (SELECT 1 FROM ${qualified(userIdentities)} identity_row WHERE identity_row.${quotedColumn(userIdentities.columns.userId)} = ${userId} AND identity_row.${quotedColumn(userIdentities.columns.idpSubjectId)} = ${subject})`;

const CARDINALITY_VIOLATION = '21000';

const readingOneIdentity = async <Result>(
  read: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof Error &&
      Reflect.get(error, 'code') === CARDINALITY_VIOLATION
    ) {
      throw new Error(
        'a person holds more than one identity in the store, and this reader reads one: the first release records one identity per person',
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * The id of the one unrevoked grant a person holds on a resource, narrowed by category and role when
 * given, read from the store, the person found through `user_identities` by subject under any
 * issuer.
 *
 * @param client a connection under the migration role.
 * @param lookup the holder, the resource, and the category and role.
 * @throws when the store holds no such grant, or more than one.
 */
export const liveGrantId = async (
  client: pg.ClientBase,
  { category, holder, resource, role }: GrantLookup,
): Promise<string> => {
  const scoped =
    category === undefined || category === null
      ? category
      : category.includes('.')
        ? category
        : `${GLOBAL_SCOPE}${category}`;
  const { rows } = await client.query<{ id: string }>(
    `SELECT held.${quotedColumn(grants.columns.id)}::text AS id
       FROM ${qualified(grants)} held
       JOIN ${qualified(resources)} resource ON resource.${quotedColumn(resources.columns.id)} = held.${quotedColumn(grants.columns.resourceId)}
       JOIN ${qualified(roles)} role ON role.${quotedColumn(roles.columns.id)} = held.${quotedColumn(grants.columns.roleId)}
       LEFT JOIN ${qualified(categories)} category ON category.${quotedColumn(categories.columns.id)} = held.${quotedColumn(grants.columns.recordCategoryId)}
      WHERE ${holdsIdentityBy(`held.${quotedColumn(grants.columns.holderUserId)}`, '$1')}
        AND resource.${quotedColumn(resources.columns.externalId)} = $2
        AND held.${quotedColumn(grants.columns.revokedAt)} IS NULL
        AND ($3::boolean OR (category.${quotedColumn(categories.columns.scope)} || '.' || category.${quotedColumn(categories.columns.name)}) IS NOT DISTINCT FROM $4::text)
        AND ($5::text IS NULL OR role.${quotedColumn(roles.columns.name)} = $5)`,
    [holder, resource, scoped === undefined, scoped ?? null, role ?? null],
  );
  const [found] = rows;
  if (found !== undefined && rows.length === 1) {
    return found.id;
  }
  throw new Error(
    `the store holds ${rows.length} live grants matching that lookup on ${resource}`,
  );
};

/**
 * Whether a grant is revoked in the store.
 *
 * @param client a connection under the migration role.
 * @param grantId the grant's id.
 * @throws when no grant has that id.
 */
export const isRevoked = async (
  client: pg.ClientBase,
  grantId: string,
): Promise<boolean> => {
  const { rows } = await client.query<{ revoked: boolean }>(
    `SELECT ${quotedColumn(grants.columns.revokedAt)} IS NOT NULL AS revoked FROM ${qualified(grants)} WHERE ${quotedColumn(grants.columns.id)} = $1`,
    [grantId],
  );
  const [row] = rows;
  if (row !== undefined) {
    return row.revoked;
  }
  throw new Error('no grant has that id');
};

/**
 * Revokes a grant by SQL, under the system actor, in a transaction of its own: a policy change that
 * passes through no write path of the controller's.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param revocation the grant's id, and the `users.id` of who revokes it.
 */
export const revokeGrantInStore = async (
  client: pg.ClientBase,
  { grantId, revokedBy }: { grantId: string; revokedBy: string },
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `UPDATE ${qualified(grants)} SET ${quotedColumn(grants.columns.revokedAt)} = clock_timestamp(), ${quotedColumn(grants.columns.revokedBy)} = $2 WHERE ${quotedColumn(grants.columns.id)} = $1`,
      [grantId, revokedBy],
    ),
  );
};

/**
 * Writes an owner grant on a resource together with its holder's acceptance, by SQL, under the system
 * actor, in one transaction: a person's grant of {@link OWNER_ROLE} naming no category and never
 * expiring, granted at the transaction's clock, then accepted showing what the role carries now, so
 * the holder counts as an owner from the commit on.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param owner the resource's `resources.id`, the holder's `users.id`, and the `users.id` of who
 *   grants it.
 * @returns the new grant's id.
 */
export const addAcceptedOwner = (
  client: pg.ClientBase,
  {
    grantedBy,
    holderUserId,
    resourceId,
  }: { grantedBy: string; holderUserId: string; resourceId: string },
): Promise<string> =>
  inTransactionAs(client, SYSTEM_ACTOR, async () => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT ${quotedColumn(roles.columns.id)}::text AS id FROM ${qualified(roles)} WHERE ${quotedColumn(roles.columns.name)} = $1`,
      [OWNER_ROLE],
    );
    const [ownerRole] = rows;
    if (ownerRole === undefined) {
      throw new Error(`the store holds no ${OWNER_ROLE} role`);
    }
    const grantId = await insertWithId(client, grants, {
      [grants.columns.expiresAt]: null,
      [grants.columns.grantedAt]: CLOCK,
      [grants.columns.grantedBy]: grantedBy,
      [grants.columns.holderUserId]: holderUserId,
      [grants.columns.recordCategoryId]: null,
      [grants.columns.resourceId]: resourceId,
      [grants.columns.roleId]: ownerRole.id,
    });
    await insertRow(client, grantDecisions, {
      [grantDecisions.columns.capabilities]: await roleCapabilities(
        client,
        ownerRole.id,
      ),
      [grantDecisions.columns.decidedAt]: CLOCK,
      [grantDecisions.columns.decision]: 'accepted',
      [grantDecisions.columns.grantId]: grantId,
      [grantDecisions.columns.userId]: holderUserId,
    });
    return grantId;
  });

/**
 * Retires a resource by SQL, under the system actor, in one transaction that also ends its owner
 * grants: every person's grant of {@link OWNER_ROLE} on it neither revoked nor expired, revoked at the
 * retirement's instant by who retires it. The no-owner invariant lives in the database and permits
 * ending a resource's last owner grant only in the transaction retiring it, so the two are never
 * written apart. The resource's row is kept (#320 B). It writes no notice and no event; whatever a
 * trigger of the migrations writes, it writes.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param retirement the resource, by externalId; who retires it, as a `users.id`; and when, the
 *   transaction's clock by default.
 * @returns the ids of the owner grants it ended, sorted.
 * @throws when the store holds no resource by that externalId, nothing written.
 */
export const retireInStore = (
  client: pg.ClientBase,
  { at, by, externalId }: { at?: Date; by: string; externalId: string },
): Promise<readonly string[]> =>
  inTransactionAs(client, SYSTEM_ACTOR, async () => {
    const { rows: retired } = await client.query<{
      id: string;
      retiredAt: string;
    }>(
      `UPDATE ${qualified(resources)} SET ${quotedColumn(resources.columns.retiredAt)} = coalesce($1::timestamptz, clock_timestamp()), ${quotedColumn(resources.columns.retiredBy)} = $2 WHERE ${quotedColumn(resources.columns.externalId)} = $3 RETURNING ${quotedColumn(resources.columns.id)} AS id, ${quotedColumn(resources.columns.retiredAt)}::text AS "retiredAt"`,
      [at ?? null, by, externalId],
    );
    const [resource] = retired;
    if (resource === undefined) {
      throw new Error(`the store holds no resource ${externalId}`);
    }
    const { rows: ended } = await client.query<{ id: string }>(
      `UPDATE ${qualified(grants)} held SET ${quotedColumn(grants.columns.revokedAt)} = $1::timestamptz, ${quotedColumn(grants.columns.revokedBy)} = $2
         FROM ${qualified(roles)} role
        WHERE role.${quotedColumn(roles.columns.id)} = held.${quotedColumn(grants.columns.roleId)}
          AND role.${quotedColumn(roles.columns.name)} = $4
          AND held.${quotedColumn(grants.columns.resourceId)} = $3
          AND held.${quotedColumn(grants.columns.holderUserId)} IS NOT NULL
          AND held.${quotedColumn(grants.columns.revokedAt)} IS NULL
          AND (held.${quotedColumn(grants.columns.expiresAt)} IS NULL OR held.${quotedColumn(grants.columns.expiresAt)} > $1::timestamptz)
        RETURNING held.${quotedColumn(grants.columns.id)}::text AS id`,
      [resource.retiredAt, by, resource.id, OWNER_ROLE],
    );
    return ended.map(({ id }) => id).toSorted();
  });

/**
 * Revokes a principal entirely by SQL, under the system actor, in a transaction of its own.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param revocation the `users.id` revoked, who revokes, and why.
 */
export const revokePrincipalInStore = async (
  client: pg.ClientBase,
  {
    reason = 'synthetic revocation for a test',
    revokedBy,
    userId,
  }: { reason?: string; revokedBy: string; userId: string },
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    insertRow(client, principalRevocations, {
      [principalRevocations.columns.reason]: reason,
      [principalRevocations.columns.revokedAt]: CLOCK,
      [principalRevocations.columns.revokedBy]: revokedBy,
      [principalRevocations.columns.userId]: userId,
    }),
  );
};

/**
 * Adds a user to a group by SQL, under the system actor: groups have no write path in the first
 * release.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param membership the group's and the user's ids.
 */
export const addGroupMember = async (
  client: pg.ClientBase,
  { groupId, userId }: { groupId: string; userId: string },
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    insertRow(client, groupUsers, {
      [groupUsers.columns.groupId]: groupId,
      [groupUsers.columns.userId]: userId,
    }),
  );
};

/**
 * Removes a user from a group by SQL, under the system actor.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param membership the group's and the user's ids.
 */
export const removeGroupMember = async (
  client: pg.ClientBase,
  { groupId, userId }: { groupId: string; userId: string },
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `DELETE FROM ${qualified(groupUsers)} WHERE ${quotedColumn(groupUsers.columns.groupId)} = $1 AND ${quotedColumn(groupUsers.columns.userId)} = $2`,
      [groupId, userId],
    ),
  );
};

/** One notice written straight into the table, for a backlog no endpoint makes. */
export interface NoticeInsert {
  /** The id of the application a servedResources notice is for: its audience. */
  audience?: string;

  /** The transaction's clock by default. */
  createdAt?: Date;

  kind: (typeof NOTICE_KINDS)[number];

  /** The externalId a category notice names. */
  resourceExternalId?: string;

  /** What a principal notice names, as {@link noticeSubject} gives it, written to `idp_subject_id`. */
  subject?: string;
}

/** A notice as the table holds it, with its row's `xmin`. */
export interface StoredNotice {
  audience: string | null;

  /** When it was written, as seconds since the Unix epoch, in text. */
  createdAt: string;

  kind: string;
  position: bigint;
  resourceExternalId: string | null;

  /** What `idp_subject_id` holds: a principal notice's subject, as {@link noticeSubject} gives it. */
  subject: string | null;

  /**
   * The id `xmin` holds for the row: that of whichever transaction or subtransaction wrote it. It
   * cannot show that two rows were written in one top-level transaction, since a trigger writing
   * inside an `EXCEPTION` block, or any savepoint, gets an id of its own. To show that, hold the
   * writing transaction open, see that another session reads none of its rows, then see that it reads
   * every one after the commit. Compare it only between rows the test wrote itself, outside any
   * subtransaction.
   */
  transaction: string;
}

const { noticeStream, notices } = POLICY_TABLES;

/** The lowest position a `bigint` holds, below every notice's. */
export const LOWEST_POSITION = -9_223_372_036_854_775_808n;

/**
 * Writes notices straight into the table, in the order given, in one transaction declaring the
 * system actor.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param rows the notices.
 */
export const insertNotices = async (
  client: pg.ClientBase,
  rows: readonly NoticeInsert[],
): Promise<void> => {
  const { columns } = notices;
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `INSERT INTO ${qualified(notices)} (${quotedColumn(columns.kind)}, ${quotedColumn(columns.idpSubjectId)}, ${quotedColumn(columns.resourceExternalId)}, ${quotedColumn(columns.audience)}, ${quotedColumn(columns.createdAt)})
         SELECT kind, subject, resource, audience, coalesce(created_at, clock_timestamp())
           FROM unnest($1::text[], $2::text[], $3::text[], $4::uuid[], $5::timestamptz[])
                WITH ORDINALITY AS row (kind, subject, resource, audience, created_at, ordinal)
          ORDER BY ordinal`,
      [
        rows.map(({ kind }) => kind),
        rows.map(({ subject }) => subject ?? null),
        rows.map(({ resourceExternalId }) => resourceExternalId ?? null),
        rows.map(({ audience }) => audience ?? null),
        rows.map(({ createdAt }) => createdAt ?? null),
      ],
    ),
  );
};

/**
 * The highest position the table holds, or {@link LOWEST_POSITION} while it holds none.
 *
 * @param client the connection.
 */
export const highestPosition = async (
  client: pg.ClientBase,
): Promise<bigint> => {
  const { rows } = await client.query<{ position: string | null }>(
    `SELECT max(${quotedColumn(notices.columns.position)})::text AS position FROM ${qualified(notices)}`,
  );
  const position = rows[0]?.position;
  return position === null || position === undefined
    ? LOWEST_POSITION
    : BigInt(position);
};

/**
 * The notices after a position, in position order, each with its row's `xmin`.
 *
 * @param client the connection.
 * @param position the position to read after: {@link LOWEST_POSITION} for every notice.
 */
export const noticesAfter = async (
  client: pg.ClientBase,
  position: bigint = LOWEST_POSITION,
): Promise<readonly StoredNotice[]> => {
  const { columns } = notices;
  const { rows } = await client.query<
    Omit<StoredNotice, 'position'> & { position: string }
  >(
    `SELECT ${quotedColumn(columns.audience)}::text AS audience, extract(epoch FROM ${quotedColumn(columns.createdAt)})::text AS "createdAt", ${quotedColumn(columns.kind)} AS kind, ${quotedColumn(columns.position)}::text AS position, ${quotedColumn(columns.resourceExternalId)} AS "resourceExternalId", ${quotedColumn(columns.idpSubjectId)} AS subject, xmin::text AS transaction FROM ${qualified(notices)} WHERE ${quotedColumn(columns.position)} > $1::bigint ORDER BY ${qualified(notices)}.${quotedColumn(columns.position)}`,
    [position.toString()],
  );
  return rows.map((row) => ({ ...row, position: BigInt(row.position) }));
};

/**
 * Every notice's position, in order.
 *
 * @param client the connection.
 */
export const noticePositions = async (
  client: pg.ClientBase,
): Promise<readonly bigint[]> =>
  (await noticesAfter(client)).map(({ position }) => position);

/**
 * The stream's row: its epoch and the trim watermark.
 *
 * @param client the connection.
 * @throws when the table holds no row.
 */
export const readNoticeStream = async (
  client: pg.ClientBase,
): Promise<{ epoch: string; trimmedThrough: bigint }> => {
  const { rows } = await client.query<{
    epoch: string;
    trimmedThrough: string;
  }>(
    `SELECT ${quotedColumn(noticeStream.columns.epoch)}::text AS epoch, ${quotedColumn(noticeStream.columns.trimmedThrough)}::text AS "trimmedThrough" FROM ${qualified(noticeStream)}`,
  );
  const [row] = rows;
  if (row !== undefined) {
    return { epoch: row.epoch, trimmedThrough: BigInt(row.trimmedThrough) };
  }
  throw new Error('notice_stream holds no row');
};

/**
 * Stands in for a trim by direct writes under the migration role: deletes every notice through a
 * position and raises the watermark to it, in one transaction.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param throughPosition the position trimmed through.
 */
export const simulateTrim = async (
  client: pg.ClientBase,
  throughPosition: bigint,
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, async () => {
    await client.query(
      `DELETE FROM ${qualified(notices)} WHERE ${quotedColumn(notices.columns.position)} <= $1::bigint`,
      [throughPosition.toString()],
    );
    await client.query(
      `UPDATE ${qualified(noticeStream)} SET ${quotedColumn(noticeStream.columns.trimmedThrough)} = $1::bigint`,
      [throughPosition.toString()],
    );
  });
};

/**
 * Sets the stream's epoch, as a restore's runbook does.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param epoch the epoch: a fresh one by default.
 */
export const setEpoch = async (
  client: pg.ClientBase,
  epoch?: string,
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `UPDATE ${qualified(noticeStream)} SET ${quotedColumn(noticeStream.columns.epoch)} = coalesce($1::uuid, gen_random_uuid())`,
      [epoch ?? null],
    ),
  );
};

/**
 * Stands in for restoring a dump taken when the newest notice was at a position: every later notice
 * goes, new notices take its positions again, and the epoch is kept or replaced as the runbook says.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param restore the newest position the dump held, and what became of the epoch.
 */
export const simulateRestore = async (
  client: pg.ClientBase,
  { epoch, keptThrough }: { epoch: 'kept' | 'replaced'; keptThrough: bigint },
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, async () => {
    await client.query(
      `DELETE FROM ${qualified(notices)} WHERE ${quotedColumn(notices.columns.position)} > $1::bigint`,
      [keptThrough.toString()],
    );
    await client.query(
      `ALTER TABLE ${qualified(notices)} ALTER COLUMN ${quotedColumn(notices.columns.position)} RESTART WITH ${(keptThrough + 1n).toString()}`,
    );
  });
  if (epoch === 'replaced') {
    await setEpoch(client);
  }
};

/** A sequence's state as a snapshot holds it, for `setval` to put back. */
interface SequenceState {
  isCalled: boolean;
  lastValue: string;
  name: string;
}

/**
 * Every row of every table in one schema, and every sequence's state, as one consistent read saw them:
 * what a backup holds. Each table's rows are JSON text, so no value passes through a JavaScript number.
 */
export interface StoreSnapshot {
  schema: string;
  sequences: readonly SequenceState[];
  tables: readonly { name: string; rows: string }[];
}

const quotedIn = (schema: string, name: string): string =>
  `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;

const namesOfKind = async (
  client: pg.ClientBase,
  schema: string,
  kind: 'S' | 'r',
): Promise<readonly string[]> =>
  (
    await client.query<{ name: string }>(
      'SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = $2 ORDER BY c.relname',
      [schema, kind],
    )
  ).rows.map(({ name }) => name);

/**
 * Takes a snapshot of a database's store as a backup would, while the controller runs: in one
 * repeatable-read, read-only transaction, every row of every ordinary table in the schema, found in
 * the catalogue rather than named, and every sequence's state. Nothing is written.
 *
 * @param client a connection under the migration role, which owns every table, holding no transaction.
 * @param schema the schema: the one named for Usher by default.
 */
export const takeStoreSnapshot = async (
  client: pg.ClientBase,
  schema: string = USHER_SCHEMA,
): Promise<StoreSnapshot> => {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const tables = await inTurn(
      await namesOfKind(client, schema, 'r'),
      async (name) => {
        const { rows } = await client.query<{ rows: string }>(
          `SELECT coalesce(jsonb_agg(to_jsonb(held)), '[]'::jsonb)::text AS rows FROM ${quotedIn(schema, name)} AS held`,
        );
        return { name, rows: rows[0]?.rows ?? '[]' };
      },
    );
    const sequences = await inTurn(
      await namesOfKind(client, schema, 'S'),
      async (name) => {
        const { rows } = await client.query<{
          isCalled: boolean;
          lastValue: string;
        }>(
          `SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM ${quotedIn(schema, name)}`,
        );
        const [state] = rows;
        if (state !== undefined) {
          return { ...state, name };
        }
        throw new Error(`the sequence ${name} gave no state`);
      },
    );
    await client.query('COMMIT');
    return { schema, sequences, tables };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

// Each table after every table it references, so the foreign keys PostgreSQL checks at each statement
// hold as the rows go back. A table referencing itself is written in one statement, which they hold
// at its end.
const referenceOrder = async (
  client: pg.ClientBase,
  schema: string,
  names: readonly string[],
): Promise<readonly string[]> => {
  const { rows } = await client.query<{
    referenced: string;
    referencing: string;
  }>(
    `SELECT referencing.relname AS referencing, referenced.relname AS referenced
       FROM pg_constraint constraint_row
       JOIN pg_class referencing ON referencing.oid = constraint_row.conrelid
       JOIN pg_class referenced ON referenced.oid = constraint_row.confrelid
       JOIN pg_namespace namespace ON namespace.oid = referencing.relnamespace
      WHERE constraint_row.contype = 'f' AND namespace.nspname = $1 AND referencing.oid <> referenced.oid`,
    [schema],
  );
  const placed = (
    order: readonly string[],
    remaining: readonly string[],
  ): readonly string[] => {
    const ready = remaining.filter((name) =>
      rows
        .filter(({ referencing }) => referencing === name)
        .every(
          ({ referenced }) =>
            order.includes(referenced) || !remaining.includes(referenced),
        ),
    );
    if (remaining.length === 0) {
      return order;
    }
    if (ready.length > 0) {
      return placed(
        [...order, ...ready],
        remaining.filter((name) => !ready.includes(name)),
      );
    }
    throw new Error(
      `the tables ${remaining.join(', ')} reference each other in a cycle, which a restore by statements cannot order`,
    );
  };
  return placed([], names);
};

const insertableColumns = async (
  client: pg.ClientBase,
  schema: string,
  name: string,
): Promise<readonly string[]> =>
  (
    await client.query<{ column: string }>(
      `SELECT attname AS column FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
      [quotedIn(schema, name)],
    )
  ).rows.map(({ column }) => column);

const TRIGGER_ENABLING: Readonly<Record<string, string>> = Object.freeze({
  A: 'ENABLE ALWAYS',
  O: 'ENABLE',
  R: 'ENABLE REPLICA',
});

/**
 * Restores a snapshot over the store, as a restore from a backup does, in one transaction under the
 * system actor: the user triggers of the schema are disabled, so no restored row is taken for a
 * change of policy and no guard judges history being put back, every table is emptied, every row
 * goes back in an order its foreign keys allow, generated columns left to compute themselves, every
 * sequence takes its state again, and each trigger is enabled as it was. The epoch is the snapshot's;
 * a restore's runbook replaces it after, through {@link setEpoch}. Every controller using the store
 * must be stopped first.
 *
 * @param client a connection under the migration role, which owns every table, holding no transaction.
 * @param snapshot what {@link takeStoreSnapshot} took.
 */
export const restoreStoreSnapshot = async (
  client: pg.ClientBase,
  { schema, sequences, tables }: StoreSnapshot,
): Promise<void> => {
  const names = tables.map(({ name }) => name);
  const rowsOf = new Map(tables.map(({ name, rows }) => [name, rows]));
  await inTransactionAs(client, SYSTEM_ACTOR, async () => {
    const { rows: triggers } = await client.query<{
      enabled: string;
      table: string;
      trigger: string;
    }>(
      `SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'D' ORDER BY 1, 2`,
      [schema],
    );
    await inTurn(triggers, ({ table, trigger }) =>
      client.query(
        `ALTER TABLE ${quotedIn(schema, table)} DISABLE TRIGGER ${pg.escapeIdentifier(trigger)}`,
      ),
    );
    if (names.length > 0) {
      await client.query(
        `TRUNCATE ${names.map((name) => quotedIn(schema, name)).join(', ')}`,
      );
    }
    await inTurn(await referenceOrder(client, schema, names), async (name) => {
      const columns = (await insertableColumns(client, schema, name))
        .map((column) => pg.escapeIdentifier(column))
        .join(', ');
      await client.query(
        `INSERT INTO ${quotedIn(schema, name)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::${quotedIn(schema, name)}, $1::jsonb)`,
        [rowsOf.get(name) ?? '[]'],
      );
    });
    await inTurn(sequences, ({ isCalled, lastValue, name }) =>
      client.query('SELECT setval($1::regclass, $2::bigint, $3)', [
        quotedIn(schema, name),
        lastValue,
        isCalled,
      ]),
    );
    await inTurn(triggers, ({ enabled, table, trigger }) =>
      client.query(
        `ALTER TABLE ${quotedIn(schema, table)} ${TRIGGER_ENABLING[enabled] ?? 'ENABLE'} TRIGGER ${pg.escapeIdentifier(trigger)}`,
      ),
    );
  });
};

/**
 * A snapshot's tables, each table's rows as the snapshot read them, less the tables named: what two
 * snapshots are compared by when the sequences' state may move without a row being written, as a
 * rolled-back insert moves it.
 *
 * @param snapshot what {@link takeStoreSnapshot} took.
 * @param except the tables left out, as entries of {@link POLICY_TABLES}: none by default.
 */
export const tablesOf = (
  snapshot: StoreSnapshot,
  except: readonly { name: string }[] = [],
): readonly { name: string; rows: string }[] =>
  snapshot.tables.filter(({ name }) =>
    except.every((table) => table.name !== name),
  );

/**
 * The rows one table held in a snapshot, parsed; none for a table the snapshot did not read.
 *
 * @param snapshot what {@link takeStoreSnapshot} took.
 * @param table an entry of {@link POLICY_TABLES}.
 */
export const rowsIn = (
  snapshot: StoreSnapshot,
  table: { name: string },
): readonly unknown[] => {
  const held = snapshot.tables.find(({ name }) => name === table.name);
  const parsed: unknown = JSON.parse(held?.rows ?? '[]');
  return Array.isArray(parsed) ? parsed : [];
};

/** A hold on the writers of notices naming chosen subjects, installed for one test. */
export interface NoticeHold {
  /** Lets every held writer go on. */
  release(): Promise<void>;

  /** Releases any hold and removes the instrumentation. */
  remove(): Promise<void>;

  /** Settles once as many writers as given wait on the hold, or throws after 10 s. */
  waitUntilHeld(count?: number): Promise<void>;
}

// A test-reserved pair of advisory lock keys, apart from every key the support code takes.
const HOLD_LOCK = Object.freeze({ classid: 210, objid: 1 });

const testObject = (name: string): string =>
  `${pg.escapeIdentifier(USHER_SCHEMA)}.${pg.escapeIdentifier(name)}`;

/**
 * Installs #210's holding trigger under the migration role: after a notice naming one of the
 * subjects is inserted, its writer's transaction takes a test-reserved advisory lock the test holds,
 * so it stays open after its notice insert until released. The instrumentation goes once the
 * cleanup runs.
 *
 * @param scope the cleanup removing it.
 * @param client a connection under the migration role, which holds the lock.
 * @param subjects what the held notices name, as {@link noticeSubject} gives it.
 */
export const holdNoticesNaming = async (
  scope: Cleanup,
  client: pg.ClientBase,
  subjects: readonly string[],
): Promise<NoticeHold> => {
  const heldTable = testObject('test_held_notice_subjects');
  const holdFunction = testObject('test_hold_notice');
  await client.query(
    `CREATE TABLE ${heldTable} (idp_subject_id text PRIMARY KEY)`,
  );
  await client.query(
    `INSERT INTO ${heldTable} (idp_subject_id) SELECT unnest($1::text[])`,
    [subjects],
  );
  await client.query(
    `CREATE FUNCTION ${holdFunction}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $hold$ BEGIN IF EXISTS (SELECT 1 FROM ${heldTable} WHERE idp_subject_id = NEW.${quotedColumn(notices.columns.idpSubjectId)}) THEN PERFORM pg_advisory_xact_lock(${HOLD_LOCK.classid}, ${HOLD_LOCK.objid}); END IF; RETURN NULL; END $hold$`,
  );
  await client.query(
    `CREATE TRIGGER test_hold_notice AFTER INSERT ON ${qualified(notices)} FOR EACH ROW EXECUTE FUNCTION ${holdFunction}()`,
  );
  await client.query('SELECT pg_advisory_lock($1, $2)', [
    HOLD_LOCK.classid,
    HOLD_LOCK.objid,
  ]);
  const state = { held: true, removed: false };
  const release = async (): Promise<void> => {
    if (state.held) {
      state.held = false;
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        HOLD_LOCK.classid,
        HOLD_LOCK.objid,
      ]);
    }
  };
  const remove = async (): Promise<void> => {
    await release();
    if (state.removed) {
      return;
    }
    state.removed = true;
    await client.query(
      `DROP TRIGGER test_hold_notice ON ${qualified(notices)}`,
    );
    await client.query(`DROP FUNCTION ${holdFunction}()`);
    await client.query(`DROP TABLE ${heldTable}`);
  };
  scope.defer(remove);
  const waiting = async (): Promise<number> => {
    const { rows } = await client.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND NOT granted",
      [HOLD_LOCK.classid, HOLD_LOCK.objid],
    );
    return rows[0]?.waiting ?? 0;
  };
  return {
    release,
    remove,
    waitUntilHeld: async (count = 1) => {
      if (
        await eventually(async () => (await waiting()) >= count, 10_000, 20)
      ) {
        return;
      }
      throw new Error(
        `no ${count} writer of a held notice waited on the hold within 10 s`,
      );
    },
  };
};

/** A trigger refusing every notice write, installed for one test. */
export interface NoticeRefusal {
  remove(): Promise<void>;
}

/**
 * Installs #210's raising trigger under the migration role: every notice insert raises, so the
 * transaction writing it rolls back. It goes once the cleanup runs, or earlier through `remove`.
 *
 * @param scope the cleanup removing it.
 * @param client a connection under the migration role.
 */
export const refuseNoticeWrites = async (
  scope: Cleanup,
  client: pg.ClientBase,
): Promise<NoticeRefusal> => {
  const refusal = testObject('test_refuse_notice');
  await client.query(
    `CREATE FUNCTION ${refusal}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $refuse$ BEGIN RAISE EXCEPTION 'a test refuses this notice write'; END $refuse$`,
  );
  await client.query(
    `CREATE TRIGGER test_refuse_notice AFTER INSERT ON ${qualified(notices)} FOR EACH ROW EXECUTE FUNCTION ${refusal}()`,
  );
  const state = { removed: false };
  const remove = async (): Promise<void> => {
    if (state.removed) {
      return;
    }
    state.removed = true;
    await client.query(
      `DROP TRIGGER test_refuse_notice ON ${qualified(notices)}`,
    );
    await client.query(`DROP FUNCTION ${refusal}()`);
  };
  scope.defer(remove);
  return { remove };
};

/** A fault a test injected at the store, until removed. */
export interface InjectedFault {
  /** How many inserts into the table the fault has seen, the failed one included, rolled back or not. */
  attempts(): Promise<number>;

  /** Drops the fault's trigger, its function and its counter; removing again does nothing. */
  remove(): Promise<void>;
}

/** The schema a fault's counter and function live in, apart from the schema named for Usher, so no read of the store's tables or sequences finds them. */
export const FAULT_SCHEMA = 'usher_test_faults';

/**
 * Fails the Nth insert into a table of the test's own database, counting from 1: a test-only trigger,
 * created by the migration role, raises before that row is written, whoever writes it, so the
 * transaction writing it fails part way through its writes, as a fault reaching the store mid-run
 * does. It counts every insert, those of transactions rolled back included, through a sequence, which
 * no rollback moves back. Its trigger, function and counter go once the cleanup runs, or earlier
 * through `remove`; the counter and the function live in {@link FAULT_SCHEMA}.
 *
 * @param scope the cleanup removing it.
 * @param client a connection to the test's own database under the migration role, which owns the table.
 * @param table an entry of {@link POLICY_TABLES}.
 * @param insert which insert fails: 5 for the fifth.
 */
export const failNthInsert = async (
  scope: Cleanup,
  client: pg.ClientBase,
  table: { name: string },
  insert: number,
): Promise<InjectedFault> => {
  const name = `fault_${randomBytes(6).toString('hex')}`;
  const inFaultSchema = (object: string): string =>
    `${pg.escapeIdentifier(FAULT_SCHEMA)}.${pg.escapeIdentifier(object)}`;
  const counter = inFaultSchema(`${name}_inserts`);
  const raising = inFaultSchema(name);
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(FAULT_SCHEMA)}`,
  );
  await client.query(`CREATE SEQUENCE ${counter}`);
  await client.query(
    `CREATE FUNCTION ${raising}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fault$ BEGIN IF nextval(${pg.escapeLiteral(counter)}::regclass) = ${String(Math.trunc(insert))} THEN RAISE EXCEPTION 'a test injected a fault at this insert'; END IF; RETURN NEW; END $fault$`,
  );
  await client.query(
    `CREATE TRIGGER ${pg.escapeIdentifier(name)} BEFORE INSERT ON ${qualified(table)} FOR EACH ROW EXECUTE FUNCTION ${raising}()`,
  );
  const state = { removed: false };
  const remove = async (): Promise<void> => {
    if (state.removed) {
      return;
    }
    state.removed = true;
    await client.query(
      `DROP TRIGGER ${pg.escapeIdentifier(name)} ON ${qualified(table)}`,
    );
    await client.query(`DROP FUNCTION ${raising}()`);
    await client.query(`DROP SEQUENCE ${counter}`);
  };
  scope.defer(remove);
  return {
    attempts: async () => {
      const { rows } = await client.query<{ attempts: string }>(
        `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS attempts FROM ${counter}`,
      );
      return Number(rows[0]?.attempts ?? 0);
    },
    remove,
  };
};

const rowsOf = async (
  client: pg.ClientBase,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<readonly Readonly<Record<string, unknown>>[]> =>
  (await client.query<Record<string, unknown>>(text, [...parameters])).rows;

const { applicationKeys, changeRecords, keyEncryptionKeyCheck } = POLICY_TABLES;

/**
 * Alters one stored application key by SQL, as someone tampering with the store would: the last bit
 * of its `encrypted_key` flipped, in a transaction under the system actor. The key then fails to
 * decrypt under a key-encryption key that passes its check.
 *
 * @param client a connection under the migration role.
 * @param keyId the key's id.
 * @throws when no stored key has that id.
 */
export const alterEncryptedKey = async (
  client: pg.ClientBase,
  keyId: string,
): Promise<void> => {
  const encrypted = quotedColumn(applicationKeys.columns.encryptedKey);
  const lastByte = `length(${encrypted}) - 1`;
  const { rowCount } = await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `UPDATE ${qualified(applicationKeys)} SET ${encrypted} = set_byte(${encrypted}, ${lastByte}, get_byte(${encrypted}, ${lastByte}) # 1) WHERE ${quotedColumn(applicationKeys.columns.id)}::text = $1`,
      [keyId],
    ),
  );
  if (rowCount === 1) {
    return;
  }
  throw new Error(`no stored application key has the id ${keyId}`);
};

/**
 * Copies one stored application key's `encrypted_key` onto another key's row by SQL, as someone
 * moving a key between applications in the store would, in a transaction under the system actor. The
 * encryption binds each key to its own application's id and its own id, so the copy fails to decrypt
 * on the row it was copied onto.
 *
 * @param client a connection under the migration role.
 * @param fromKeyId the id of the key copied.
 * @param toKeyId the id of the key overwritten by the copy.
 * @throws when either id names no stored key.
 */
export const copyEncryptedKey = async (
  client: pg.ClientBase,
  fromKeyId: string,
  toKeyId: string,
): Promise<void> => {
  const encrypted = quotedColumn(applicationKeys.columns.encryptedKey);
  const id = quotedColumn(applicationKeys.columns.id);
  const { rowCount } = await inTransactionAs(client, SYSTEM_ACTOR, () =>
    client.query(
      `UPDATE ${qualified(applicationKeys)} AS target SET ${encrypted} = source.${encrypted} FROM ${qualified(applicationKeys)} AS source WHERE source.${id}::text = $1 AND target.${id}::text = $2`,
      [fromKeyId, toKeyId],
    ),
  );
  if (rowCount === 1) {
    return;
  }
  throw new Error(
    `no stored application keys have the ids ${fromKeyId} and ${toKeyId}`,
  );
};

/**
 * Every check value of the key-encryption key held by the store, as hex: one once a controller has
 * started, none before.
 *
 * @param client a connection under the migration role.
 */
export const keyEncryptionKeyChecks = async (
  client: pg.ClientBase,
): Promise<readonly string[]> =>
  (
    await rowsOf(
      client,
      `SELECT encode(${quotedColumn(keyEncryptionKeyCheck.columns.checkValue)}, 'hex') AS value FROM ${qualified(keyEncryptionKeyCheck)}`,
    )
  ).map((row) => String(row['value']));

/** What the policy tables the resource operations write hold, for a test showing that a refusal wrote nothing. */
export interface PolicySnapshot {
  applicationResources: readonly unknown[];
  categories: readonly unknown[];
  fieldValues: readonly unknown[];
  fields: readonly unknown[];
  grants: readonly unknown[];
  resources: readonly unknown[];
}

/**
 * Reads every row the resource operations write, ordered, so two snapshots are equal exactly when
 * nothing was written between them: each resource with its details, tier, suppression, retirement
 * and update time, the served sets, the categories, the fields and their values, and the grants.
 *
 * @param client a connection under the migration role.
 */
export const policySnapshot = async (
  client: pg.ClientBase,
): Promise<PolicySnapshot> => {
  const [
    servedRows,
    categoryRows,
    fieldValueRows,
    fieldRows,
    grantRows,
    resourceRows,
  ] = await Promise.all([
    rowsOf(
      client,
      `SELECT ${quotedColumn(applicationResources.columns.applicationId)}::text AS application, ${quotedColumn(applicationResources.columns.resourceId)}::text AS resource FROM ${qualified(applicationResources)} ORDER BY 1, 2`,
    ),
    rowsOf(
      client,
      `SELECT ${quotedColumn(categories.columns.scope)}::text AS scope, ${quotedColumn(categories.columns.name)} AS name, ${quotedColumn(categories.columns.description)} AS description, ${quotedColumn(categories.columns.resourceId)}::text AS resource FROM ${qualified(categories)} ORDER BY 1, 2, 4`,
    ),
    rowsOf(
      client,
      `SELECT ${quotedColumn(resourceFieldValues.columns.resourceId)}::text AS resource, ${quotedColumn(resourceFieldValues.columns.fieldId)}::text AS field, ${quotedColumn(resourceFieldValues.columns.value)} AS value FROM ${qualified(resourceFieldValues)} ORDER BY 1, 2`,
    ),
    rowsOf(
      client,
      `SELECT ${quotedColumn(resourceFields.columns.name)} AS name, ${quotedColumn(resourceFields.columns.description)} AS description FROM ${qualified(resourceFields)} ORDER BY 1`,
    ),
    rowsOf(
      client,
      `SELECT ${quotedColumn(grants.columns.id)}::text AS id, ${quotedColumn(grants.columns.revokedAt)}::text AS revoked FROM ${qualified(grants)} ORDER BY 1`,
    ),
    rowsOf(
      client,
      `SELECT ${quotedColumn(resources.columns.externalId)} AS external_id, ${quotedColumn(resources.columns.name)} AS name, ${quotedColumn(resources.columns.description)} AS description, ${quotedColumn(resources.columns.baseTier)}::text AS tier, ${quotedColumn(resources.columns.suppressed)} AS suppressed, ${quotedColumn(resources.columns.retiredAt)}::text AS retired, ${quotedColumn(resources.columns.updatedAt)}::text AS updated FROM ${qualified(resources)} ORDER BY 1`,
    ),
  ]);
  return {
    applicationResources: servedRows,
    categories: categoryRows,
    fieldValues: fieldValueRows,
    fields: fieldRows,
    grants: grantRows,
    resources: resourceRows,
  };
};

/**
 * The externalIds the store holds, sorted by code point: how a test sees which registrations wrote a
 * row.
 *
 * @param client a connection under the migration role.
 */
export const storedExternalIds = async (
  client: pg.ClientBase,
): Promise<readonly string[]> =>
  (
    await rowsOf(
      client,
      `SELECT ${quotedColumn(resources.columns.externalId)} AS external_id FROM ${qualified(resources)}`,
    )
  )
    .map((row) => String(row['external_id']))
    .toSorted();

/**
 * A resource's internal id, `resources.id`, which never leaves Usher, read from the store.
 *
 * @param client a connection under the migration role.
 * @param externalId the resource.
 * @throws when the store holds no resource by that externalId.
 */
export const resourceIdOf = async (
  client: pg.ClientBase,
  externalId: string,
): Promise<string> => {
  const [row] = await rowsOf(
    client,
    `SELECT ${quotedColumn(resources.columns.id)}::text AS id FROM ${qualified(resources)} WHERE ${quotedColumn(resources.columns.externalId)} = $1`,
    [externalId],
  );
  if (row !== undefined) {
    return String(row['id']);
  }
  throw new Error(`the store holds no resource ${externalId}`);
};

/**
 * A person's internal id, `users.id`, which never leaves Usher, read from the store through
 * `user_identities` by subject under any issuer.
 *
 * @param client a connection under the migration role.
 * @param subject the identity provider's subject.
 * @throws unless the store holds exactly one person with an identity by that subject.
 */
export const userIdOf = async (
  client: pg.ClientBase,
  subject: string,
): Promise<string> => {
  const rows = await rowsOf(
    client,
    `SELECT DISTINCT ${quotedColumn(userIdentities.columns.userId)}::text AS id FROM ${qualified(userIdentities)} WHERE ${quotedColumn(userIdentities.columns.idpSubjectId)} = $1`,
    [subject],
  );
  const [row] = rows;
  if (row !== undefined && rows.length === 1) {
    return String(row['id']);
  }
  throw new Error(`the store holds ${rows.length} principals by that subject`);
};

/**
 * Every internal identifier an answer or an event must never carry, lower-cased: each `users.id`,
 * `user_identities.id`, `resources.id`, `roles.id` and `categories.id` the store holds. A grant's id
 * is left out, since the API names a grant by it.
 *
 * @param client a connection under the migration role.
 */
export const internalIdsInStore = async (
  client: pg.ClientBase,
): Promise<readonly string[]> =>
  (
    await rowsOf(
      client,
      [users, userIdentities, resources, roles, categories]
        .map(
          (table) =>
            `SELECT lower(${quotedColumn(table.columns.id)}::text) AS id FROM ${qualified(table)}`,
        )
        .join(' UNION ALL '),
    )
  ).map((row) => String(row['id']));

/**
 * How many grants the store holds on a resource, revoked ones included.
 *
 * @param client a connection under the migration role.
 * @param externalId the resource.
 */
export const grantCountOn = async (
  client: pg.ClientBase,
  externalId: string,
): Promise<number> => {
  const [row] = await rowsOf(
    client,
    `SELECT count(*)::int AS count FROM ${qualified(grants)} held JOIN ${qualified(resources)} resource ON resource.${quotedColumn(resources.columns.id)} = held.${quotedColumn(grants.columns.resourceId)} WHERE resource.${quotedColumn(resources.columns.externalId)} = $1`,
    [externalId],
  );
  return Number(row?.['count'] ?? 0);
};

/**
 * Whether the store marks a resource retired (#320 B).
 *
 * @param client a connection under the migration role.
 * @param externalId the resource.
 * @throws when the store holds no resource by that externalId.
 */
export const isRetiredInStore = async (
  client: pg.ClientBase,
  externalId: string,
): Promise<boolean> => {
  const [row] = await rowsOf(
    client,
    `SELECT ${quotedColumn(resources.columns.retiredAt)} IS NOT NULL AS retired FROM ${qualified(resources)} WHERE ${quotedColumn(resources.columns.externalId)} = $1`,
    [externalId],
  );
  if (row !== undefined) {
    return row['retired'] === true;
  }
  throw new Error(`the store holds no resource ${externalId}`);
};

/**
 * The applications the store says serve a resource, by id, sorted.
 *
 * @param client a connection under the migration role.
 * @param externalId the resource.
 */
export const servedByInStore = async (
  client: pg.ClientBase,
  externalId: string,
): Promise<readonly string[]> =>
  (
    await rowsOf(
      client,
      `SELECT served.${quotedColumn(applicationResources.columns.applicationId)}::text AS application FROM ${qualified(applicationResources)} served JOIN ${qualified(resources)} resource ON resource.${quotedColumn(resources.columns.id)} = served.${quotedColumn(applicationResources.columns.resourceId)} WHERE resource.${quotedColumn(resources.columns.externalId)} = $1`,
      [externalId],
    )
  )
    .map((row) => String(row['application']))
    .toSorted();

/**
 * How many change records the store holds for one table (C1): one per row a change wrote there.
 *
 * @param client a connection under the migration role.
 * @param table an entry of {@link POLICY_TABLES}.
 */
export const changeRecordCount = async (
  client: pg.ClientBase,
  table: { name: string },
): Promise<number> => {
  const [row] = await rowsOf(
    client,
    `SELECT count(*)::int AS count FROM ${qualified(changeRecords)} WHERE ${quotedColumn(changeRecords.columns.tableName)} = $1`,
    [table.name],
  );
  return Number(row?.['count'] ?? 0);
};

/** A capability as the store holds it, named as `entity.action`. */
export interface StoredCapability {
  /** `null` where the store holds none: the one optional column (permissions-model.md). */
  description: string | null;

  displayName: string;
  name: string;
}

/**
 * The capabilities the store holds by `entity.action` name, ordered by name.
 *
 * @param client a connection to the database.
 * @param names the capabilities.
 */
export const storedCapabilities = async (
  client: pg.ClientBase,
  names: readonly string[],
): Promise<readonly StoredCapability[]> => {
  const column = (name: string): string =>
    `${pg.escapeIdentifier(capabilities.name)}.${quotedColumn(name)}`;
  const { rows } = await client.query<StoredCapability>(
    `SELECT ${column(capabilities.columns.description)} AS description, ${column(capabilities.columns.displayName)} AS "displayName", ${column(capabilities.columns.entity)} || '.' || ${column(capabilities.columns.action)} AS name FROM ${qualified(capabilities)} AS ${pg.escapeIdentifier(capabilities.name)} WHERE ${column(capabilities.columns.entity)} || '.' || ${column(capabilities.columns.action)} = ANY($1::text[]) ORDER BY name`,
    [names],
  );
  return rows;
};

/**
 * Reads resources' registration and change times back from the store, as an answer must show them:
 * those written, or whatever a trigger keeping the change time made of them.
 *
 * @param client a connection to the database.
 * @param externalIds the resources.
 * @returns the times, by externalId, for each resource the store holds.
 */
export const storedResourceTimes = async (
  client: pg.ClientBase,
  externalIds: readonly string[],
): Promise<Readonly<Record<string, ResourceTimes>>> => {
  const { rows } = await client.query<{
    externalId: string;
    registeredAt: Date;
    updatedAt: Date;
  }>(
    `SELECT ${quotedColumn(resources.columns.externalId)} AS "externalId", ${quotedColumn(resources.columns.registeredAt)} AS "registeredAt", ${quotedColumn(resources.columns.updatedAt)} AS "updatedAt" FROM ${qualified(resources)} WHERE ${quotedColumn(resources.columns.externalId)} = ANY($1::text[])`,
    [externalIds],
  );
  return Object.fromEntries(
    rows.map(({ externalId, registeredAt, updatedAt }) => [
      externalId,
      { registeredAt, updatedAt },
    ]),
  );
};

/**
 * Sets resources' registration and change times by SQL under the system actor, in one transaction,
 * for resources already seeded; a fixture's own resources take theirs through
 * {@link FixtureResource.registeredAt} and {@link FixtureResource.updatedAt}. Read them back with
 * {@link storedResourceTimes}, since a trigger may rewrite `updated_at`.
 *
 * @param client a connection under the migration role, holding no transaction.
 * @param times the times, by externalId.
 */
export const setResourceTimesInStore = async (
  client: pg.ClientBase,
  times: Readonly<Record<string, ResourceTimes>>,
): Promise<void> => {
  await inTransactionAs(client, SYSTEM_ACTOR, () =>
    inTurn(Object.entries(times), ([externalId, { registeredAt, updatedAt }]) =>
      client.query(
        `UPDATE ${qualified(resources)} SET ${quotedColumn(resources.columns.registeredAt)} = $1, ${quotedColumn(resources.columns.updatedAt)} = $2 WHERE ${quotedColumn(resources.columns.externalId)} = $3`,
        [registeredAt, updatedAt, externalId],
      ),
    ),
  );
};

/**
 * A grant as the store holds it: people by their identity's subject (and the holder's issuer), read
 * through `user_identities`; the resource by externalId and each category scoped.
 */
export interface StoredGrant {
  /** The record category, scoped as `global.controlled`; `null` for the control plane's wildcard. */
  category: string | null;

  expiresAt: Date | null;

  /** The field category, scoped; `null` for none, as every grant of the first release has. */
  fieldCategory: string | null;

  grantedAt: Date;
  granterSubject: string;

  /** The holder's issuer; `null` for a group's grant. */
  holderIssuer: string | null;

  /** The holder's subject; `null` for a group's grant. */
  holderSubject: string | null;

  id: string;

  /** By externalId. */
  resource: string;

  revokedAt: Date | null;

  /** Who revoked it, by subject; `null` while it is not revoked. */
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

const grantColumn = (alias: string, column: string): string =>
  `${pg.escapeIdentifier(alias)}.${pg.escapeIdentifier(column)}`;

/**
 * The grants the store holds, revoked ones included, narrowed by the filter: ordered by when each was
 * granted, then by resource, holder and id, so grants written in one transaction, which share its
 * instant, come in one order every time. Each person is read through `user_identities`.
 *
 * @param client a connection under the migration role.
 * @param filter the holder, the id, the resource and the role: none by default.
 * @throws naming the cause, when a person the grants name holds more than one identity.
 */
export const storedGrants = async (
  client: pg.ClientBase,
  { holder, id, resource, role }: GrantFilter = {},
): Promise<readonly StoredGrant[]> => {
  const held = (column: string): string => grantColumn('held', column);
  const { rows } = await readingOneIdentity(() =>
    client.query<StoredGrant>(
      `SELECT ${grantColumn('record_category', categories.columns.scope)} || '.' || ${grantColumn('record_category', categories.columns.name)} AS category,
              ${held(grants.columns.expiresAt)} AS "expiresAt",
              ${grantColumn('field_category', categories.columns.scope)} || '.' || ${grantColumn('field_category', categories.columns.name)} AS "fieldCategory",
              ${held(grants.columns.grantedAt)} AS "grantedAt",
              ${identityColumnOf(held(grants.columns.grantedBy), userIdentities.columns.idpSubjectId)} AS "granterSubject",
              ${identityColumnOf(held(grants.columns.holderUserId), userIdentities.columns.idpIssuer)} AS "holderIssuer",
              ${identityColumnOf(held(grants.columns.holderUserId), userIdentities.columns.idpSubjectId)} AS "holderSubject",
              ${held(grants.columns.id)}::text AS id,
              ${grantColumn('resource_row', resources.columns.externalId)} AS resource,
              ${held(grants.columns.revokedAt)} AS "revokedAt",
              ${identityColumnOf(held(grants.columns.revokedBy), userIdentities.columns.idpSubjectId)} AS "revokerSubject",
              ${grantColumn('role_row', roles.columns.name)} AS role
         FROM ${qualified(grants)} held
         JOIN ${qualified(resources)} resource_row ON ${grantColumn('resource_row', resources.columns.id)} = ${held(grants.columns.resourceId)}
         JOIN ${qualified(roles)} role_row ON ${grantColumn('role_row', roles.columns.id)} = ${held(grants.columns.roleId)}
         LEFT JOIN ${qualified(categories)} record_category ON ${grantColumn('record_category', categories.columns.id)} = ${held(grants.columns.recordCategoryId)}
         LEFT JOIN ${qualified(categories)} field_category ON ${grantColumn('field_category', categories.columns.id)} = ${held(grants.columns.fieldCategoryId)}
        WHERE ($1::text IS NULL OR ${held(grants.columns.id)}::text = $1)
          AND ($2::text IS NULL OR ${holdsIdentityBy(held(grants.columns.holderUserId), '$2')})
          AND ($3::text IS NULL OR ${grantColumn('resource_row', resources.columns.externalId)} = $3)
          AND ($4::text IS NULL OR ${grantColumn('role_row', roles.columns.name)} = $4)
        ORDER BY "grantedAt", resource, "holderSubject", id`,
      [id ?? null, holder ?? null, resource ?? null, role ?? null],
    ),
  );
  return rows;
};

/**
 * How many rows a table holds.
 *
 * @param client a connection under the migration role.
 * @param table an entry of {@link POLICY_TABLES}.
 */
export const rowCountOf = async (
  client: pg.ClientBase,
  table: { name: string },
): Promise<number> => {
  const [row] = await rowsOf(
    client,
    `SELECT count(*)::int AS count FROM ${qualified(table)}`,
  );
  return Number(row?.['count'] ?? 0);
};

/** The tables a grant operation writes, by their names in {@link POLICY_TABLES}, for {@link rowCounts}. */
export const GRANT_WRITTEN_TABLES = Object.freeze({
  categories,
  grantDecisions,
  grants,
  invitations,
  notificationOutbox: POLICY_TABLES.notificationOutbox,
  resources,
  userIdentities,
  users,
});

/**
 * How many rows each of several tables holds, read in one statement, by the names given: for a test
 * showing that a refused write wrote nothing.
 *
 * @param client a connection under the migration role.
 * @param tables the tables by a name for each, such as {@link GRANT_WRITTEN_TABLES}.
 */
export const rowCounts = async <Name extends string>(
  client: pg.ClientBase,
  tables: Readonly<Record<Name, { name: string }>>,
): Promise<Readonly<Record<Name, number>>> => {
  const named = Object.entries<{ name: string }>(tables);
  const [row] = await rowsOf(
    client,
    `SELECT ${named
      .map(
        ([key, table]) =>
          `(SELECT count(*)::int FROM ${qualified(table)}) AS ${pg.escapeIdentifier(key)}`,
      )
      .join(', ')}`,
  );
  return Object.fromEntries(
    named.map(([key]) => [key, Number(row?.[key] ?? 0)]),
  ) as Readonly<Record<Name, number>>;
};
