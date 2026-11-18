import type { ControllerConfiguration } from '../configuration/index.js';

/** The environment variables a connection to the store is read from, which a failure to connect names. */
export interface ConnectionVariables {
  /** The variable the role's password is read from. */
  passwordVariable: string;

  /** The variable the connection URL is read from. */
  urlVariable: string;
}

/** What the database role may do with one function of the Controller's schema. */
export interface HeldFunction {
  /** Whether it may call the function. */
  executes: boolean;

  /** Whether it may grant calling the function to another role. */
  grants: boolean;

  name: string;

  /** Whether it owns the function, or holds its owner's rights. */
  owns: boolean;
}

/** What the database role may do with one relation of the Controller's schema: a table, a view or a sequence. */
export interface HeldRelation {
  /** Every column the relation has. */
  columns: readonly string[];

  /** Whether it may grant any privilege on the relation to another role. */
  grants: boolean;

  kind: 'sequence' | 'table';
  name: string;

  /** Whether it owns the relation, or holds its owner's rights. */
  owns: boolean;

  /**
   * Each privilege beyond reading it holds on the relation as a whole: on a table, any of INSERT,
   * DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, INSERT and REFERENCES counted when held on any
   * column; on a sequence, USAGE or UPDATE.
   */
  privileges: readonly string[];

  /** Whether it may read the relation whole: SELECT on the table or the sequence. */
  reads: boolean;

  /** The columns of a table it may update, whether granted by column or for the whole table. */
  updatable: readonly string[];
}

/** What the database role may do with the Controller's schema itself. */
export interface HeldSchema {
  /** Whether it may grant using or creating in the schema to another role. */
  grants: boolean;

  /** Whether it owns the schema, or holds its owner's rights. */
  owns: boolean;

  /** Whether it may use the schema, without which it reaches none of its tables. */
  uses: boolean;
}

/** Everything the database role a Controller connects as holds, as the catalogue reports it. */
export interface HeldPrivileges {
  /** The schemas of the database, the Controller's among them, in which it may create objects. */
  creatableSchemas: readonly string[];

  /** Whether it may create schemas in the database. */
  createsSchemas: boolean;

  /** What it may do with each function of the Controller's schema. */
  functions: readonly HeldFunction[];

  /**
   * The predefined roles it is a member of, among those reaching the server's files or programs and
   * those reading or writing every table.
   */
  memberships: readonly string[];

  /** What it may do with each relation of the Controller's schema. */
  relations: readonly HeldRelation[];

  /** The role attributes beyond logging in that it holds, such as SUPERUSER or BYPASSRLS. */
  roleAttributes: readonly string[];

  /** What it may do with the Controller's schema; none when the database holds no such schema. */
  schema: HeldSchema | undefined;
}

/** The rules conferring record actions on whole classes of principals: the baseline and the signed-in rule. */
export type RecordRules = Pick<
  ControllerConfiguration,
  'baseline' | 'signedInRule'
>;

/**
 * What writing the policy a start seeds needs of the Controller's configuration: the rules whose
 * digest it records, the schema, and the clock the recording time is read from.
 */
export type SeededPolicySettings = Pick<
  ControllerConfiguration,
  'baseline' | 'clock' | 'databaseSchema' | 'signedInRule'
>;

/** What connecting to the store needs of the Controller's configuration. */
export type StoreConnectionSettings = Pick<
  ControllerConfiguration,
  'databasePassword' | 'databaseUrl' | 'storeTimeoutMilliseconds'
>;

/** What the start needs of the Controller's configuration to check and prepare the store. */
export type StoreSettings = SeededPolicySettings &
  Pick<
    ControllerConfiguration,
    'keyEncryptionKey' | 'storeTimeoutMilliseconds'
  >;

/** What the start learned of the store it prepared. */
export interface PreparedStore {
  /** Whether the database role may write to some table, so the instance serves writes. */
  writes: boolean;
}

/** An operational line's fields, as the store writes them: each a name and its text. */
export type StoreLineFields = Readonly<Record<string, string>>;

/** What the store writes its operational lines through, each named by its message. */
export interface StoreLog {
  /** Writes a line at error: a failure the store met outside any request. */
  error(message: string, fields: StoreLineFields): void;

  /** Writes a line at warning: something the store tolerates that is worth reviewing. */
  warning(message: string, fields: StoreLineFields): void;
}
