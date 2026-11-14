import type {
  FieldWithVariable,
  SchemaMigrationFieldWithVariable,
} from './types.js';

/**
 * The environment variable each configuration field is read from, by field: the one place the
 * controller names them. A refusal names the variable at fault and never its value.
 */
export const ENVIRONMENT_VARIABLES: Readonly<
  Record<FieldWithVariable, string>
> = Object.freeze({
  administratorRole: 'USHER_ADMINISTRATOR_ROLE',
  apiDocsClient: 'USHER_API_DOCS_CLIENT',
  backChannelLogoutAudiences: 'USHER_BACK_CHANNEL_LOGOUT_AUDIENCES',
  baseline: 'USHER_BASELINE',
  cursorKey: 'USHER_CURSOR_KEY',
  databaseControlConnections: 'USHER_DATABASE_CONTROL_CONNECTIONS',
  databaseExchangeConnections: 'USHER_DATABASE_EXCHANGE_CONNECTIONS',
  databasePassword: 'USHER_DATABASE_PASSWORD',
  databaseSchema: 'USHER_DATABASE_SCHEMA',
  databaseUrl: 'USHER_DATABASE_URL',
  eventSource: 'USHER_EVENT_SOURCE',
  heartbeatMilliseconds: 'USHER_HEARTBEAT_MILLISECONDS',
  host: 'USHER_HOST',
  identityProviderIssuer: 'USHER_IDENTITY_PROVIDER_ISSUER',
  instanceName: 'USHER_INSTANCE_NAME',
  issuer: 'USHER_ISSUER',
  keyEncryptionKey: 'USHER_KEY_ENCRYPTION_KEY',
  managementAudience: 'USHER_MANAGEMENT_AUDIENCE',
  managementClients: 'USHER_MANAGEMENT_CLIENTS',
  noticePageLimit: 'USHER_NOTICE_PAGE_LIMIT',
  noticeRereadMilliseconds: 'USHER_NOTICE_REREAD_MILLISECONDS',
  port: 'USHER_PORT',
  retentionGraceSeconds: 'USHER_RETENTION_GRACE_SECONDS',
  retentionMarginSeconds: 'USHER_RETENTION_MARGIN_SECONDS',
  serviceAccountRole: 'USHER_SERVICE_ACCOUNT_ROLE',
  signInTokenMaximumLifetimeSeconds:
    'USHER_SIGN_IN_TOKEN_MAXIMUM_LIFETIME_SECONDS',
  signedInRule: 'USHER_SIGNED_IN_RULE',
  storeTimeoutMilliseconds: 'USHER_STORE_TIMEOUT_MILLISECONDS',
  streamLimitPerAudience: 'USHER_STREAM_LIMIT_PER_AUDIENCE',
  streamMaximumLifetimeSeconds: 'USHER_STREAM_MAXIMUM_LIFETIME_SECONDS',
  streamQueueLimit: 'USHER_STREAM_QUEUE_LIMIT',
  tokenLifetimeSeconds: 'USHER_TOKEN_LIFETIME_SECONDS',
  trustedProxies: 'USHER_TRUSTED_PROXIES',
});

/**
 * The environment variable each of the schema migration command's own fields is read from, by
 * field: the schema migration role's connection. The controller never reads them, so its processes
 * never hold the schema migration role's password. The command reads the runtime role it grants to,
 * the database role `USHER_DATABASE_URL` names, and the schema and the retention floor's durations
 * from the controller's own variables, in {@link ENVIRONMENT_VARIABLES}.
 */
export const SCHEMA_MIGRATION_ENVIRONMENT_VARIABLES: Readonly<
  Record<SchemaMigrationFieldWithVariable, string>
> = Object.freeze({
  databasePassword: 'USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD',
  databaseUrl: 'USHER_SCHEMA_MIGRATION_DATABASE_URL',
});
