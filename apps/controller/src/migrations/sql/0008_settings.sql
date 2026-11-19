-- The settings an instance holds in its store, the identity provider's identifiers as the Controller last
-- started with them, and the triggers keeping each change recorded, the fixed settings fixed, and the
-- retention floor and the settings generation in step with the settings.

-- One row per setting, each with its default unless the seed file gave a first value. The schema
-- migration command seeds every row on its first run; the runtime role changes a value and never adds or
-- removes a row.
CREATE TABLE settings (
  name text PRIMARY KEY CHECK (name IN (
    'backChannelLogout', 'eventSource', 'firstUser', 'grantAutoAccept', 'grantRules',
    'heartbeatMilliseconds', 'issuer', 'noticePageLimit', 'noticeRereadMilliseconds',
    'retentionGraceSeconds', 'retentionMarginSeconds', 'signInTokenMaximumLifetimeSeconds',
    'streamLimitPerAudience', 'streamMaximumLifetimeSeconds', 'streamQueueLimit', 'submitterCategory',
    'tokenLifetimeSeconds'
  )),
  value jsonb NOT NULL,
  changed_at timestamptz NOT NULL,
  -- Empty where the schema migration command seeded the row.
  changed_by uuid REFERENCES users ON DELETE RESTRICT
);

-- Raised in the transaction of every change to a setting, so each instance re-reads the settings when it
-- sees a new generation.
CREATE TABLE settings_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL
);

INSERT INTO settings_generation (generation) VALUES (0);

-- The identity provider's identifiers as the Controller last started with them; an empty value is an
-- identifier not recorded yet.
CREATE TABLE identity_provider_configuration (
  name text PRIMARY KEY CHECK (name IN (
    'apiDocsClient', 'backChannelLogoutAudiences', 'identityProviderIssuer', 'managementAudience',
    'managementClients', 'serviceAccountRole'
  )),
  value jsonb,
  recorded_at timestamptz,
  CONSTRAINT identity_provider_configuration_recorded_together CHECK ((value IS NULL) = (recorded_at IS NULL))
);

INSERT INTO identity_provider_configuration (name) VALUES
  ('apiDocsClient'), ('backChannelLogoutAudiences'), ('identityProviderIssuer'), ('managementAudience'),
  ('managementClients'), ('serviceAccountRole');

-- Raises the settings generation in the changing transaction. Concurrent changes wait on its row, so each
-- commits a generation of its own.
CREATE FUNCTION raise_settings_generation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  UPDATE settings_generation SET generation = generation + 1;
  RETURN NULL;
END
$$;

CREATE TRIGGER raise_settings_generation AFTER INSERT OR UPDATE ON settings
  FOR EACH STATEMENT EXECUTE FUNCTION raise_settings_generation();

-- Sets the notice retention floor to the sum of the three durations it is made of, in the changing
-- transaction, once all three are stored. Each row's change fires it, so one statement changing several
-- rows leaves the sum of the rows as they stand at its end.
CREATE FUNCTION keep_retention_floor() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  durations_stored integer;
  floor_seconds integer;
BEGIN
  SELECT count(*), sum((value #>> '{}')::integer) INTO durations_stored, floor_seconds
    FROM settings
   WHERE name IN ('retentionGraceSeconds', 'retentionMarginSeconds', 'tokenLifetimeSeconds');
  IF durations_stored = 3 THEN
    INSERT INTO notice_retention (singleton, floor_seconds) VALUES (true, floor_seconds)
    ON CONFLICT (singleton) DO UPDATE SET floor_seconds = EXCLUDED.floor_seconds;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_retention_floor AFTER INSERT OR UPDATE OF value ON settings
  FOR EACH ROW WHEN (NEW.name IN ('retentionGraceSeconds', 'retentionMarginSeconds', 'tokenLifetimeSeconds'))
  EXECUTE FUNCTION keep_retention_floor();

-- The fixed settings are kept as first seeded, for every role the schema's owner included.
CREATE TRIGGER keep_fixed_settings BEFORE UPDATE OR DELETE ON settings
  FOR EACH ROW WHEN (OLD.name IN ('eventSource', 'firstUser', 'issuer'))
  EXECUTE FUNCTION refuse_change('settings_fixed_kept', 'eventSource, firstUser and issuer are kept as first seeded');

-- A truncate passes the row triggers, so the settings are kept against it as a statement.
CREATE TRIGGER keep_settings BEFORE TRUNCATE ON settings
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_change('settings_kept', 'a setting is changed, and never truncated');

-- A change to the grant rules writes one baseline notice, from the change itself, so a hand edit of the row
-- sends it too. Seeding inserts a row and writes none.
CREATE TRIGGER write_notices_on_update AFTER UPDATE OF value ON settings
  FOR EACH ROW WHEN (NEW.name = 'grantRules' AND OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION notify_baseline_change();

-- Every change to a setting is recorded under its actor, as the policy tables' changes are. The
-- identifiers table has no change record: the Controller records each change of an identifier as an audit
-- event.
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION record_change();

-- The seed file's own members as the first run read them, with their digest: a later run compares the file
-- it reads against this row. One row, written by the first run's seeding and never changed or removed.
CREATE TABLE settings_seed (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  content jsonb NOT NULL,
  digest bytea NOT NULL,
  seeded_at timestamptz NOT NULL
);

CREATE TRIGGER keep_seed BEFORE UPDATE OR DELETE ON settings_seed
  FOR EACH ROW EXECUTE FUNCTION refuse_change('settings_seed_kept', 'the seed file as first read is kept');

CREATE TRIGGER keep_seed_rows BEFORE TRUNCATE ON settings_seed
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_change('settings_seed_kept', 'the seed file as first read is kept');

-- Reading one setting's history by its table and key: the sign-in token maximum's changes, read in order.
CREATE INDEX change_records_table_row ON change_records (table_name, row_key, recorded_at);

GRANT SELECT ON settings, settings_generation, identity_provider_configuration TO :"runtime_role";
GRANT UPDATE (changed_at, changed_by, value) ON settings TO :"runtime_role";
GRANT UPDATE (recorded_at, value) ON identity_provider_configuration TO :"runtime_role";

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA :"schema" FROM PUBLIC;
