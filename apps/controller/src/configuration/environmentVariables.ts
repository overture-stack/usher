import type {
  FieldWithVariable,
  SchemaMigrationFieldWithVariable,
} from './types.js';

/**
 * The environment variable each configuration field is read from, by field: the one place the
 * Controller names them. A refusal names the variable at fault and never its value.
 */
export const ENVIRONMENT_VARIABLES: Readonly<
  Record<FieldWithVariable, string>
> = Object.freeze({
  apiDocsClient: 'USHER_API_DOCS_CLIENT',
  backChannelLogoutAudiences: 'USHER_BACK_CHANNEL_LOGOUT_AUDIENCES',
  cursorKey: 'USHER_CURSOR_KEY',
  databaseAllowUnverifiedConnection:
    'USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION',
  databaseControlConnections: 'USHER_DATABASE_CONTROL_CONNECTIONS',
  databaseExchangeConnections: 'USHER_DATABASE_EXCHANGE_CONNECTIONS',
  databasePassword: 'USHER_DATABASE_PASSWORD',
  databaseSchema: 'USHER_DATABASE_SCHEMA',
  databaseUrl: 'USHER_DATABASE_URL',
  host: 'USHER_HOST',
  identityProviderIssuer: 'USHER_IDENTITY_PROVIDER_ISSUER',
  instanceName: 'USHER_INSTANCE_NAME',
  keyEncryptionKey: 'USHER_KEY_ENCRYPTION_KEY',
  managementAudience: 'USHER_MANAGEMENT_AUDIENCE',
  managementClients: 'USHER_MANAGEMENT_CLIENTS',
  port: 'USHER_PORT',
  serviceAccountRole: 'USHER_SERVICE_ACCOUNT_ROLE',
  storeTimeoutMilliseconds: 'USHER_STORE_TIMEOUT_MILLISECONDS',
  trustedProxies: 'USHER_TRUSTED_PROXIES',
});

/**
 * The environment variable each of the schema migration command's own fields is read from, by
 * field: the schema migration role's connection, and the seed file the first run seeds the
 * settings from. The Controller never reads them, so its processes never hold the schema migration
 * role's password. The command reads the runtime role it grants to, the database role
 * `USHER_DATABASE_URL` names, the schema, whether an unverified database connection is allowed and
 * the seed file, the first two from the Controller's own variables, in {@link ENVIRONMENT_VARIABLES}.
 */
export const SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES: Readonly<
  Record<SchemaMigrationFieldWithVariable, string>
> = Object.freeze({
  seedFile: 'USHER_SEED_FILE',
  databasePassword: 'USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD',
  databaseUrl: 'USHER_SCHEMA_MIGRATION_DATABASE_URL',
});

/**
 * The variables both the schema migration command and the Controller refuse while set, empty or not, each
 * by the variable replacing it: the settings they held are given in the seed file, which the schema
 * migration command reads, and held in the store, which the Controller reads.
 */
export const REPLACED_VARIABLES: Readonly<Record<string, string>> =
  Object.freeze({
    USHER_ADMINISTRATOR_ROLE:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_BASELINE: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_EVENT_SOURCE: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_FIRST_USER_ROLE: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_GRANT_AUTO_ACCEPT:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_HEARTBEAT_MILLISECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_ISSUER: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_NOTICE_PAGE_LIMIT:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_NOTICE_REREAD_MILLISECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_RETENTION_GRACE_SECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_RETENTION_MARGIN_SECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_SIGNED_IN_RULE: SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_SIGN_IN_TOKEN_MAXIMUM_LIFETIME_SECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_STREAM_LIMIT_PER_AUDIENCE:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_STREAM_MAXIMUM_LIFETIME_SECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_STREAM_QUEUE_LIMIT:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_SUBMITTER_CATEGORY:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
    USHER_TOKEN_LIFETIME_SECONDS:
      SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES.seedFile,
  });
