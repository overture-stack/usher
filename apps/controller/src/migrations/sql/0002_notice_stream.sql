-- The notice stream bridges read, its trimming, the policy generation the payload cache is keyed by,
-- and the digest of the rules the controller last started with; then the triggers writing a policy
-- change's notices and raising the generation in the changing transaction.

-- One table carries every kind of notice. A principal notice names an identity provider subject, a
-- category notice a resource by its identifier, and a servedResources notice the application whose
-- served set changed; baseline and global notices name nothing. Positions are one sequence across
-- kinds, drawn by the database alone.
CREATE TABLE notices (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('baseline', 'category', 'global', 'principal', 'servedResources')),
  idp_subject_id text,
  resource_external_id text,
  audience uuid REFERENCES applications ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT notices_subject_on_principal CHECK ((kind = 'principal') = (idp_subject_id IS NOT NULL)),
  CONSTRAINT notices_subject_named CHECK (idp_subject_id <> ''),
  CONSTRAINT notices_resource_on_category CHECK ((kind = 'category') = (resource_external_id IS NOT NULL)),
  CONSTRAINT notices_resource_named CHECK (resource_external_id <> ''),
  CONSTRAINT notices_audience_on_served_resources CHECK ((kind = 'servedResources') = (audience IS NOT NULL))
);

-- The stream's one row: the epoch, replaced whenever history restarts, as after a restore, and how far
-- trimming has reached, against which a cursor is judged.
CREATE TABLE notice_stream (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch uuid NOT NULL,
  trimmed_through bigint NOT NULL
);

INSERT INTO notice_stream (epoch, trimmed_through) VALUES (gen_random_uuid(), 0);

-- The retention floor each migration run stores, which the controller's role may read and never
-- write, so it can never trim a notice a bridge may still act on.
CREATE TABLE notice_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  floor_seconds integer NOT NULL CHECK (floor_seconds > 0)
);

-- Raised in the transaction of every policy change, so a payload cached under an older generation is
-- never read as current.
CREATE TABLE policy_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL
);

INSERT INTO policy_generation (generation) VALUES (0);

-- The digest of the baseline and the signed-in rule the controller last started with.
CREATE TABLE rules_digest (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  digest text NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- An identity's position is drawn as each row is formed, before the transaction commits, so two
-- writers could commit out of position order and a reader between them would pass the earlier for
-- good. Every statement writing notices first takes this lock, held to the end of its transaction,
-- before any position is drawn: positions are then drawn and committed in one order.
CREATE FUNCTION serialize_notice_writes() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(8617207002);
  RETURN NULL;
END
$$;

CREATE TRIGGER serialize_writes BEFORE INSERT ON notices
  FOR EACH STATEMENT EXECUTE FUNCTION serialize_notice_writes();

-- Deletes the notices older than the retention floor, through the highest position below every notice
-- younger than it, raises the watermark to that position in the same transaction, and returns it. The
-- floor is read from the store, so a trim cannot be handed a lower one, and the watermark never moves
-- down. It runs as the schema's owner, since the controller's role may neither delete notices nor
-- move the watermark itself.
CREATE FUNCTION trim_notices() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  watermark bigint;
  cutoff timestamptz;
  first_kept bigint;
  reach bigint;
BEGIN
  SELECT trimmed_through INTO watermark FROM notice_stream FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the notice stream holds no row, so no trim can record its reach'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT now() - make_interval(secs => floor_seconds) INTO cutoff FROM notice_retention;
  SELECT min(position) INTO first_kept FROM notices WHERE created_at >= cutoff;
  SELECT max(position) INTO reach FROM notices
   WHERE created_at < cutoff AND (first_kept IS NULL OR position < first_kept);
  reach := greatest(watermark, reach);
  DELETE FROM notices WHERE position <= reach;
  UPDATE notice_stream SET trimmed_through = reach;
  RETURN reach;
END
$$;

-- Raises the generation in the changing transaction. Concurrent changes wait on its row, so each
-- commits a generation of its own.
CREATE FUNCTION raise_policy_generation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  UPDATE policy_generation SET generation = generation + 1;
  RETURN NULL;
END
$$;

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON application_resources
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON capabilities
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON global_revocations
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON grant_decisions
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON group_users
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON principal_revocations
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON resource_categories
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON resource_field_values
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON resource_fields
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON resources
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

CREATE TRIGGER raise_policy_generation AFTER INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION raise_policy_generation();

-- Writing notices. Each writer writes nothing when given nothing, so a change reaching nobody takes no
-- part in the stream's order.

CREATE FUNCTION write_principal_notices(subjects text[]) RETURNS void
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(subjects) AS named (subject) WHERE subject IS NOT NULL) THEN
    INSERT INTO notices (kind, idp_subject_id, created_at)
    SELECT 'principal', subject, clock_timestamp()
      FROM (SELECT DISTINCT subject FROM unnest(subjects) AS named (subject) WHERE subject IS NOT NULL) named
     ORDER BY subject;
  END IF;
END
$$;

CREATE FUNCTION write_category_notices(external_ids text[]) RETURNS void
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(external_ids) AS named (external_id) WHERE external_id IS NOT NULL) THEN
    INSERT INTO notices (kind, resource_external_id, created_at)
    SELECT 'category', external_id, clock_timestamp()
      FROM (SELECT DISTINCT external_id FROM unnest(external_ids) AS named (external_id) WHERE external_id IS NOT NULL) named
     ORDER BY external_id;
  END IF;
END
$$;

CREATE FUNCTION write_served_resources_notices(audiences uuid[]) RETURNS void
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(audiences) AS named (audience) WHERE audience IS NOT NULL) THEN
    INSERT INTO notices (kind, audience, created_at)
    SELECT 'servedResources', audience, clock_timestamp()
      FROM (SELECT DISTINCT audience FROM unnest(audiences) AS named (audience) WHERE audience IS NOT NULL) named
     ORDER BY audience;
  END IF;
END
$$;

CREATE FUNCTION write_notice(notice_kind text) RETURNS void
  LANGUAGE sql SET search_path FROM CURRENT
AS $$
  INSERT INTO notices (kind, created_at) VALUES (notice_kind, clock_timestamp());
$$;

-- The subjects a principal notice names for people: each identity's, since a bridge knows a person
-- by the subject they sign in with.
CREATE FUNCTION subjects_of(people uuid[]) RETURNS text[]
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT coalesce(array_agg(idp_subject_id), '{}') FROM user_identities WHERE user_id = ANY (people);
$$;

CREATE FUNCTION grant_holders(person uuid, group_held uuid) RETURNS uuid[]
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT CASE
    WHEN person IS NOT NULL THEN ARRAY[person]
    ELSE ARRAY(SELECT user_id FROM group_users WHERE group_id = group_held)
  END;
$$;

-- Everyone a role reaches through a grant not revoked, held directly or through a group.
CREATE FUNCTION role_holders(role_ids uuid[]) RETURNS uuid[]
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT coalesce(array_agg(DISTINCT person), '{}') FROM (
    SELECT held.holder_user_id FROM grants held
     WHERE held.role_id = ANY (role_ids) AND held.revoked_at IS NULL AND held.holder_user_id IS NOT NULL
    UNION
    SELECT member.user_id FROM grants held JOIN group_users member ON member.group_id = held.holder_group_id
     WHERE held.role_id = ANY (role_ids) AND held.revoked_at IS NULL
  ) AS holder (person);
$$;

CREATE FUNCTION resource_external_ids(resource_ids uuid[]) RETURNS text[]
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT coalesce(array_agg(external_id), '{}') FROM resources WHERE id = ANY (resource_ids);
$$;

-- The notice each change writes. They run as the schema's owner, since a change may reach notices for
-- people and resources its writer cannot read.

CREATE FUNCTION notify_grant_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_principal_notices(subjects_of(
    grant_holders(OLD.holder_user_id, OLD.holder_group_id) || grant_holders(NEW.holder_user_id, NEW.holder_group_id)
  ));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION notify_grant_change();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON grants
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_grant_change();

CREATE FUNCTION notify_people_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_principal_notices(subjects_of(ARRAY[OLD.user_id, NEW.user_id]));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT ON grant_decisions
  FOR EACH ROW EXECUTE FUNCTION notify_people_changed();

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON group_users
  FOR EACH ROW EXECUTE FUNCTION notify_people_changed();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON group_users
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_people_changed();

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON principal_revocations
  FOR EACH ROW EXECUTE FUNCTION notify_people_changed();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON principal_revocations
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_people_changed();

-- An identity moved to another person, or removed, no longer reaches what it reached. One added
-- reaches more than before, which a cached token's narrower answer never exceeds.
CREATE FUNCTION notify_identity_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_principal_notices(ARRAY[OLD.idp_subject_id, NEW.idp_subject_id]);
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER DELETE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION notify_identity_change();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON user_identities
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_identity_change();

CREATE FUNCTION notify_role_holders() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_principal_notices(subjects_of(role_holders(ARRAY[OLD.role_id, NEW.role_id])));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION notify_role_holders();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON role_permissions
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_role_holders();

-- A capability renamed changes the names every holder of a role carrying it is given.
CREATE FUNCTION notify_capability_holders() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_principal_notices(subjects_of(role_holders(
    ARRAY(SELECT role_id FROM role_permissions WHERE capability_id = NEW.id)
  )));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON capabilities
  FOR EACH ROW WHEN (OLD.entity IS DISTINCT FROM NEW.entity OR OLD.action IS DISTINCT FROM NEW.action)
  EXECUTE FUNCTION notify_capability_holders();

CREATE FUNCTION notify_resource_categories_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_category_notices(resource_external_ids(ARRAY[OLD.resource_id, NEW.resource_id]));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON resource_categories
  FOR EACH ROW EXECUTE FUNCTION notify_resource_categories_change();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON resource_categories
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_resource_categories_change();

-- A global category added, renamed or removed changes every payload's list of them; a resource's own
-- category changes that resource's.
CREATE FUNCTION notify_category_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF OLD.scope = 'global' OR NEW.scope = 'global' THEN
    PERFORM write_notice('baseline');
  END IF;
  PERFORM write_category_notices(resource_external_ids(ARRAY[OLD.resource_id, NEW.resource_id]));
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION notify_category_change();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON categories
  FOR EACH ROW WHEN (
    OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.name IS DISTINCT FROM NEW.name
    OR OLD.resource_id IS DISTINCT FROM NEW.resource_id
  )
  EXECUTE FUNCTION notify_category_change();

-- Suppressing a resource withdraws it, which its category notice carries; restoring it, or changing
-- its base tier, changes what the baseline reaches. Retiring it withdraws it from each application
-- serving it. Its identifier is what payloads name it by.
CREATE FUNCTION notify_resource_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.suppressed AND NOT OLD.suppressed THEN
    PERFORM write_category_notices(ARRAY[NEW.external_id]);
  END IF;
  IF OLD.suppressed AND NOT NEW.suppressed THEN
    PERFORM write_notice('baseline');
  END IF;
  IF OLD.base_tier IS DISTINCT FROM NEW.base_tier THEN
    PERFORM write_notice('baseline');
  END IF;
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    PERFORM write_category_notices(ARRAY[NEW.external_id]);
    PERFORM write_served_resources_notices(
      ARRAY(SELECT application_id FROM application_resources WHERE resource_id = NEW.id)
    );
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN
    PERFORM write_notice('baseline');
  END IF;
  IF OLD.external_id IS DISTINCT FROM NEW.external_id THEN
    PERFORM write_category_notices(ARRAY[OLD.external_id, NEW.external_id]);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION notify_resource_change();

CREATE FUNCTION notify_served_resources_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_served_resources_notices(ARRAY[OLD.application_id, NEW.application_id]);
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT OR DELETE ON application_resources
  FOR EACH ROW EXECUTE FUNCTION notify_served_resources_change();

CREATE TRIGGER write_notices_on_update AFTER UPDATE ON application_resources
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION notify_served_resources_change();

CREATE FUNCTION notify_baseline_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_notice('baseline');
  RETURN NULL;
END
$$;

-- A start under changed rules writes one baseline notice; a start under the same rules, none.
CREATE TRIGGER write_notices_on_update AFTER UPDATE ON rules_digest
  FOR EACH ROW WHEN (OLD.digest IS DISTINCT FROM NEW.digest) EXECUTE FUNCTION notify_baseline_change();

CREATE FUNCTION notify_global_revocation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_notice('global');
  RETURN NULL;
END
$$;

CREATE TRIGGER write_notices AFTER INSERT ON global_revocations
  FOR EACH ROW EXECUTE FUNCTION notify_global_revocation();

GRANT SELECT, INSERT ON notices TO :"runtime_role";

GRANT SELECT ON notice_stream, notice_retention, policy_generation TO :"runtime_role";

GRANT SELECT, INSERT ON rules_digest TO :"runtime_role";
GRANT UPDATE (digest, recorded_at) ON rules_digest TO :"runtime_role";

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA :"schema" FROM PUBLIC;

GRANT EXECUTE ON FUNCTION trim_notices() TO :"runtime_role";
