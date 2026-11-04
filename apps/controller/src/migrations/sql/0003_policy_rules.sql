-- The rules a policy change keeps that reach past one row's own columns: history kept as written, an
-- owned resource kept owned, nothing live on a retired resource, a resource's own categories confined
-- to it, a role's capabilities kept in its plane, and every person holding an identity. They hold for
-- every role writing, the schema's owner included. A refusal raises an integrity error naming the
-- rule as its constraint, as a declared constraint's does. A rule judging a whole transaction is
-- checked at its commit, so its writes may come in any order.

-- Refuses the change it fires for: its first argument names the rule, reported as the constraint, and
-- its second says what the rule keeps.
CREATE FUNCTION refuse_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[1] USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_ARGV[0];
END
$$;

-- History kept as written: a grant, a revocation and an application key end by recording their end,
-- and an answer about a grant is followed by a new answer, never rewritten.

CREATE TRIGGER keep_history BEFORE DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION refuse_change('grants_kept', 'a grant is revoked or expires, and is never deleted');

CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON grant_decisions
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'grant_decisions_kept', 'an answer about a grant is kept as given; a later answer is a row of its own'
  );

CREATE TRIGGER keep_history BEFORE DELETE ON principal_revocations
  FOR EACH ROW EXECUTE FUNCTION refuse_change('principal_revocations_kept', 'a revocation is lifted, and is never deleted');

CREATE TRIGGER keep_history BEFORE DELETE ON application_keys
  FOR EACH ROW EXECUTE FUNCTION refuse_change('application_keys_kept', 'an application key is revoked, and is never deleted');

CREATE TRIGGER keep_revocation BEFORE UPDATE ON grants
  FOR EACH ROW WHEN (
    OLD.revoked_at IS NOT NULL
    AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)
  )
  EXECUTE FUNCTION refuse_change('grants_revocation_kept', 'a grant''s revocation is kept as recorded');

CREATE TRIGGER keep_revocation BEFORE UPDATE ON application_keys
  FOR EACH ROW WHEN (
    OLD.revoked_at IS NOT NULL
    AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)
  )
  EXECUTE FUNCTION refuse_change('application_keys_revocation_kept', 'an application key''s revocation is kept as recorded');

CREATE TRIGGER keep_lift BEFORE UPDATE ON principal_revocations
  FOR EACH ROW WHEN (
    OLD.lifted_at IS NOT NULL
    AND (NEW.lifted_at IS DISTINCT FROM OLD.lifted_at OR NEW.lifted_by IS DISTINCT FROM OLD.lifted_by)
  )
  EXECUTE FUNCTION refuse_change('principal_revocations_lift_kept', 'a revocation''s lift is kept as recorded');

-- A person's owner grant lasts until it is revoked, so an owned resource never loses its owner to
-- time. A group's grant never makes anyone an owner, so its expiry takes no owner away.

CREATE FUNCTION keep_owner_grant_open_ended() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND name = 'owner') THEN
    RAISE EXCEPTION 'a person''s owner grant takes no expiry'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'grants_owner_open_ended';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_owner_grant_open_ended AFTER INSERT OR UPDATE ON grants
  FOR EACH ROW WHEN (NEW.expires_at IS NOT NULL AND NEW.holder_user_id IS NOT NULL)
  EXECUTE FUNCTION keep_owner_grant_open_ended();

-- A resource that has an owner keeps one until it is retired. An owner is a person holding a grant of
-- the role named `owner` on the resource, neither revoked nor expired, whose latest answer to it
-- accepted it; a group's grant never makes anyone an owner. A change ending a counted owner grant, by
-- revoking it, recasting it or its holder declining it, is checked at commit: the resource must then
-- be retired or still hold a counted owner. A resource that never had one is left alone.

CREATE FUNCTION counted_owners(resource uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT count(*) FROM grants owned JOIN roles role ON role.id = owned.role_id
   WHERE owned.resource_id = resource
     AND role.name = 'owner'
     AND owned.holder_user_id IS NOT NULL
     AND owned.revoked_at IS NULL
     AND (owned.expires_at IS NULL OR owned.expires_at > now())
     AND (SELECT answer.decision FROM grant_decisions answer
           WHERE answer.grant_id = owned.id AND answer.user_id = owned.holder_user_id
           ORDER BY answer.decided_at DESC LIMIT 1) = 'accepted';
$$;

-- Locking the resource's row makes two transactions ending owner grants on one resource check in
-- turn, each seeing what the other committed.
CREATE FUNCTION keep_resource_owned_after(resource uuid) RETURNS void
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
DECLARE
  retired boolean;
BEGIN
  SELECT retired_at IS NOT NULL INTO retired FROM resources WHERE id = resource FOR NO KEY UPDATE;
  IF NOT retired AND counted_owners(resource) = 0 THEN
    RAISE EXCEPTION 'a resource with an owner keeps one until it is retired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'resources_keep_an_owner';
  END IF;
END
$$;

CREATE FUNCTION keep_resource_owned_after_grant_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE id = OLD.role_id AND name = 'owner')
     AND (OLD.expires_at IS NULL OR OLD.expires_at > now())
     AND (SELECT answer.decision FROM grant_decisions answer
           WHERE answer.grant_id = OLD.id AND answer.user_id = OLD.holder_user_id
           ORDER BY answer.decided_at DESC LIMIT 1) = 'accepted' THEN
    PERFORM keep_resource_owned_after(OLD.resource_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_resource_owned AFTER UPDATE ON grants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.holder_user_id IS NOT NULL AND OLD.revoked_at IS NULL)
  EXECUTE FUNCTION keep_resource_owned_after_grant_change();

CREATE FUNCTION keep_resource_owned_after_rejection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  resource uuid;
BEGIN
  SELECT owned.resource_id INTO resource FROM grants owned JOIN roles role ON role.id = owned.role_id
   WHERE owned.id = NEW.grant_id
     AND owned.holder_user_id = NEW.user_id
     AND role.name = 'owner'
     AND (SELECT earlier.decision FROM grant_decisions earlier
           WHERE earlier.grant_id = NEW.grant_id AND earlier.user_id = NEW.user_id AND earlier.decided_at < NEW.decided_at
           ORDER BY earlier.decided_at DESC LIMIT 1) = 'accepted';
  IF FOUND THEN
    PERFORM keep_resource_owned_after(resource);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_resource_owned AFTER INSERT ON grant_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.decision = 'rejected')
  EXECUTE FUNCTION keep_resource_owned_after_rejection();

-- A retired resource holds no live grant: one neither revoked nor expired. Retiring it and ending its
-- grants share a transaction, checked at commit. A grant's check takes a share lock on its resource,
-- so it waits for a retirement in progress and then sees it.

CREATE FUNCTION holds_live_grant_while_retired(resource uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM resources retired JOIN grants held ON held.resource_id = retired.id
     WHERE retired.id = resource
       AND retired.retired_at IS NOT NULL
       AND held.revoked_at IS NULL
       AND (held.expires_at IS NULL OR held.expires_at > now())
  );
$$;

CREATE FUNCTION keep_retired_resource_empty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF holds_live_grant_while_retired(NEW.id) THEN
    RAISE EXCEPTION 'a retired resource holds no live grant'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'resources_retired_without_live_grants';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_retired_resource_empty AFTER INSERT OR UPDATE ON resources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.retired_at IS NOT NULL)
  EXECUTE FUNCTION keep_retired_resource_empty();

CREATE FUNCTION keep_grant_off_retired_resource() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1 FROM resources WHERE id = NEW.resource_id FOR SHARE;
  IF holds_live_grant_while_retired(NEW.resource_id) THEN
    RAISE EXCEPTION 'a retired resource holds no live grant'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'resources_retired_without_live_grants';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_grant_off_retired_resource AFTER INSERT OR UPDATE ON grants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.revoked_at IS NULL)
  EXECUTE FUNCTION keep_grant_off_retired_resource();

-- A resource's own category is offered, granted and promised on that resource alone. The trigger's
-- arguments name the row's columns holding categories; each category named is share-locked, so it
-- cannot move to another resource while the row naming it is written.

CREATE FUNCTION confine_categories() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  named uuid[] := ARRAY(SELECT (to_jsonb(NEW) ->> column_name)::uuid FROM unnest(TG_ARGV) AS column_name);
BEGIN
  PERFORM 1 FROM categories WHERE id = ANY (named) FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM categories WHERE id = ANY (named) AND resource_id IS NOT NULL AND resource_id <> NEW.resource_id
  ) THEN
    RAISE EXCEPTION 'a resource''s own category is named on that resource alone'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_confined_to_their_resource';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER confine_categories AFTER INSERT OR UPDATE OF field_category_id, record_category_id, resource_id ON grants
  FOR EACH ROW EXECUTE FUNCTION confine_categories('field_category_id', 'record_category_id');

CREATE TRIGGER confine_categories AFTER INSERT OR UPDATE OF field_category_id, record_category_id, resource_id ON invitations
  FOR EACH ROW EXECUTE FUNCTION confine_categories('field_category_id', 'record_category_id');

CREATE TRIGGER confine_categories AFTER INSERT OR UPDATE ON resource_categories
  FOR EACH ROW EXECUTE FUNCTION confine_categories('category_id');

CREATE FUNCTION confine_category_to_its_references() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM grants
        WHERE NEW.id IN (record_category_id, field_category_id) AND resource_id <> NEW.resource_id
     )
     OR EXISTS (
       SELECT 1 FROM invitations
        WHERE NEW.id IN (record_category_id, field_category_id) AND resource_id <> NEW.resource_id
     )
     OR EXISTS (
       SELECT 1 FROM resource_categories WHERE category_id = NEW.id AND resource_id <> NEW.resource_id
     ) THEN
    RAISE EXCEPTION 'a resource''s own category is named on that resource alone'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_confined_to_their_resource';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER confine_categories AFTER UPDATE OF resource_id, scope ON categories
  FOR EACH ROW WHEN (NEW.resource_id IS NOT NULL AND NEW.resource_id IS DISTINCT FROM OLD.resource_id)
  EXECUTE FUNCTION confine_category_to_its_references();

-- A role carries only capabilities of its own plane. A permission's check share-locks its role and
-- its capability, so neither changes plane while it is written.

CREATE FUNCTION keep_permission_in_plane() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM 1 FROM roles WHERE id = NEW.role_id FOR SHARE;
  PERFORM 1 FROM capabilities WHERE id = NEW.capability_id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM roles role, capabilities capability
     WHERE role.id = NEW.role_id AND capability.id = NEW.capability_id AND role.plane <> capability.plane
  ) THEN
    RAISE EXCEPTION 'a role carries only capabilities of its own plane'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permissions_within_plane';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_planes AFTER INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION keep_permission_in_plane();

CREATE FUNCTION keep_role_plane() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM role_permissions permission JOIN capabilities capability ON capability.id = permission.capability_id
     WHERE permission.role_id = NEW.id AND capability.plane <> NEW.plane
  ) THEN
    RAISE EXCEPTION 'a role carries only capabilities of its own plane'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permissions_within_plane';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_planes AFTER UPDATE OF plane ON roles
  FOR EACH ROW WHEN (OLD.plane IS DISTINCT FROM NEW.plane) EXECUTE FUNCTION keep_role_plane();

CREATE FUNCTION keep_capability_plane() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM role_permissions permission JOIN roles role ON role.id = permission.role_id
     WHERE permission.capability_id = NEW.id AND role.plane <> NEW.plane
  ) THEN
    RAISE EXCEPTION 'a role carries only capabilities of its own plane'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permissions_within_plane';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_planes AFTER UPDATE OF plane ON capabilities
  FOR EACH ROW WHEN (OLD.plane IS DISTINCT FROM NEW.plane) EXECUTE FUNCTION keep_capability_plane();

-- Every person holds at least one identity, checked at commit, since a person and their first
-- identity are written in one transaction.

CREATE FUNCTION holds_no_identity(person uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = person)
     AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = person);
$$;

CREATE FUNCTION keep_new_person_identified() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF holds_no_identity(NEW.id) THEN
    RAISE EXCEPTION 'a person holds at least one identity'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_hold_an_identity';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_person_identified AFTER INSERT ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION keep_new_person_identified();

CREATE FUNCTION keep_former_holder_identified() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  IF holds_no_identity(OLD.user_id) THEN
    RAISE EXCEPTION 'a person holds at least one identity'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_hold_an_identity';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER keep_person_identified AFTER DELETE OR UPDATE OF user_id ON user_identities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION keep_former_holder_identified();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA :"schema" FROM PUBLIC;
