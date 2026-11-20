-- The grant rate's count: one row for each grant operation counted, naming the identity acting, so
-- the operations one actor performed within a window are counted alike by every instance sharing
-- the store. A row is kept until its expiry, the instant it was counted plus the window in force
-- then, and the retention sweep deletes it once that and the clock tolerance have passed.
CREATE TABLE grant_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_issuer text NOT NULL,
  idp_subject_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Counting one actor's operations within a window reads their latest rows alone.
CREATE INDEX grant_operations_actor ON grant_operations (idp_issuer, idp_subject_id, occurred_at);

-- The runtime role counts operations and sweeps those expired, and changes no row it counted.
GRANT SELECT, INSERT, DELETE ON grant_operations TO :"runtime_role";

-- The settings gain the grant rate's threshold. A store holding settings, which its first run has
-- seeded, takes the default now, as 0009 gave it the self-grant maximum. A store holding none is seeded
-- with every setting by its first run, after the migrations, so it takes no row here. The row is a
-- change made by the system, with no actor.
ALTER TABLE settings DROP CONSTRAINT settings_name_check;

ALTER TABLE settings ADD CONSTRAINT settings_name_check CHECK (name IN (
  'backChannelLogout', 'eventSource', 'firstUser', 'grantAutoAccept', 'grantRateThreshold', 'grantRules',
  'heartbeatMilliseconds', 'issuer', 'noticePageLimit', 'noticeRereadMilliseconds',
  'retentionGraceSeconds', 'retentionMarginSeconds', 'selfGrantMaximumLifetimeSeconds',
  'signInTokenMaximumLifetimeSeconds', 'streamLimitPerAudience', 'streamMaximumLifetimeSeconds',
  'streamQueueLimit', 'submitterCategory', 'tokenLifetimeSeconds'
));

SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true);

INSERT INTO settings (name, value, changed_at)
SELECT 'grantRateThreshold', '{"operationCount": 10, "windowSeconds": 60}'::jsonb, now()
  WHERE EXISTS (SELECT 1 FROM settings);
