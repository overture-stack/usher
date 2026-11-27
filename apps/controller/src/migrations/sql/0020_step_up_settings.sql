-- The settings gain the step-up's level and its window: a self-grant issued at once, and an owner
-- extending or widening a grant they hold, need a sign-in at that level within that window. A store
-- holding settings, which its first run has seeded, takes the defaults now, as 0010 gave it the grant
-- rate's threshold. A store holding none is seeded with every setting by its first run, after the
-- migrations, so it takes no row here. The rows are changes made by the system, with no actor.
ALTER TABLE settings DROP CONSTRAINT settings_name_check;

ALTER TABLE settings ADD CONSTRAINT settings_name_check CHECK (name IN (
  'backChannelLogout', 'eventSource', 'firstUser', 'grantAutoAccept', 'grantRateThreshold',
  'grantRules', 'heartbeatMilliseconds', 'issuer', 'noticePageLimit', 'noticeRereadMilliseconds',
  'retentionGraceSeconds', 'retentionMarginSeconds', 'selfGrantMaximumLifetimeSeconds',
  'signInTokenMaximumLifetimeSeconds', 'stepUpLevel', 'stepUpWindowSeconds', 'streamLimitPerAudience',
  'streamMaximumLifetimeSeconds', 'streamQueueLimit', 'submitterCategory', 'tokenLifetimeSeconds'
));

SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true);

INSERT INTO settings (name, value, changed_at)
SELECT name, value, now()
  FROM (VALUES
    ('stepUpLevel', '"confirmation"'::jsonb),
    ('stepUpWindowSeconds', '300'::jsonb)
  ) AS defaults (name, value)
  WHERE EXISTS (SELECT 1 FROM settings);
