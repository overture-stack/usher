import type { ControllerConfiguration } from '../configuration/index.js';

/** What the database role may do with one function of the controller's schema. */
export interface HeldFunction {
  /** Whether it may call the function. */
  executes: boolean;

  /** Whether it may grant calling the function to another role. */
  grants: boolean;

  name: string;

  /** Whether it owns the function, or holds its owner's rights. */
  owns: boolean;
}

/** What the database role may do with one relation of the controller's schema: a table, a view or a sequence. */
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

  /** The columns of a table it may update, whether granted by column or for the whole table. */
  updatable: readonly string[];
}

/** What the database role may do with the controller's schema itself. */
export interface HeldSchema {
  /** Whether it may grant using or creating in the schema to another role. */
  grants: boolean;

  /** Whether it owns the schema, or holds its owner's rights. */
  owns: boolean;

  /** Whether it may use the schema, without which it reaches none of its tables. */
  uses: boolean;
}

/** Everything the database role a controller connects as holds, as the catalogue reports it. */
export interface HeldPrivileges {
  /** The schemas of the database, the controller's among them, in which it may create objects. */
  creatableSchemas: readonly string[];

  /** Whether it may create schemas in the database. */
  createsSchemas: boolean;

  /** What it may do with each function of the controller's schema. */
  functions: readonly HeldFunction[];

  /**
   * The predefined roles it is a member of, among those reaching the server's files or programs and
   * those reading or writing every table.
   */
  memberships: readonly string[];

  /** What it may do with each relation of the controller's schema. */
  relations: readonly HeldRelation[];

  /** The role attributes beyond logging in that it holds, such as SUPERUSER or BYPASSRLS. */
  roleAttributes: readonly string[];

  /** What it may do with the controller's schema; none when the database holds no such schema. */
  schema: HeldSchema | undefined;
}

/** What the start needs of the controller's configuration to check and prepare the store. */
export type StoreSettings = Pick<
  ControllerConfiguration,
  'clock' | 'databaseSchema' | 'keyEncryptionKey'
>;
