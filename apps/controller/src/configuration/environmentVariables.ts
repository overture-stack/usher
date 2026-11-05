import type { FieldWithVariable } from './types.js';

/**
 * The environment variable each configuration field is read from, by field: the one place the
 * controller names them. A refusal names the variable at fault and never its value.
 */
export const ENVIRONMENT_VARIABLES: Readonly<
  Record<FieldWithVariable, string>
> = Object.freeze({
  administratorRole: 'USHER_ADMINISTRATOR_ROLE',
  allowedCharactersExtra: 'USHER_ALLOWED_CHARACTERS_EXTRA',
  autoAccept: 'USHER_AUTO_ACCEPT',
  backChannelLogoutAudiences: 'USHER_BACK_CHANNEL_LOGOUT_AUDIENCES',
  baseline: 'USHER_BASELINE',
  cachePassword: 'USHER_CACHE_PASSWORD',
  cacheUrl: 'USHER_CACHE_URL',
  cursorKey: 'USHER_CURSOR_KEY',
  databasePassword: 'USHER_DATABASE_PASSWORD',
  databaseSchema: 'USHER_DATABASE_SCHEMA',
  databaseUrl: 'USHER_DATABASE_URL',
  directoryClientId: 'USHER_DIRECTORY_CLIENT_ID',
  directoryClientSecret: 'USHER_DIRECTORY_CLIENT_SECRET',
  directoryRealm: 'USHER_DIRECTORY_REALM',
  directoryUrl: 'USHER_DIRECTORY_URL',
  egoMigrationAllStudyPolicies: 'USHER_EGO_MIGRATION_ALL_STUDY_POLICIES',
  egoMigrationBaseTier: 'USHER_EGO_MIGRATION_BASE_TIER',
  egoMigrationPrefixes: 'USHER_EGO_MIGRATION_PREFIXES',
  eventSource: 'USHER_EVENT_SOURCE',
  grantRateThreshold: 'USHER_GRANT_RATE_THRESHOLD',
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
  platformDefaultAccessLevel: 'USHER_PLATFORM_DEFAULT_ACCESS_LEVEL',
  port: 'USHER_PORT',
  retentionGraceSeconds: 'USHER_RETENTION_GRACE_SECONDS',
  retentionMarginSeconds: 'USHER_RETENTION_MARGIN_SECONDS',
  selfGrantMaximumSeconds: 'USHER_SELF_GRANT_MAXIMUM_SECONDS',
  signInTokenMaximumLifetimeSeconds:
    'USHER_SIGN_IN_TOKEN_MAXIMUM_LIFETIME_SECONDS',
  signedInRule: 'USHER_SIGNED_IN_RULE',
  storeTimeoutMilliseconds: 'USHER_STORE_TIMEOUT_MILLISECONDS',
  streamLimitPerAudience: 'USHER_STREAM_LIMIT_PER_AUDIENCE',
  streamMaximumLifetimeSeconds: 'USHER_STREAM_MAXIMUM_LIFETIME_SECONDS',
  streamQueueLimit: 'USHER_STREAM_QUEUE_LIMIT',
  submitterCategory: 'USHER_SUBMITTER_CATEGORY',
  tokenLifetimeSeconds: 'USHER_TOKEN_LIFETIME_SECONDS',
  trustedProxies: 'USHER_TRUSTED_PROXIES',
});
