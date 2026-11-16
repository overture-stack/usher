-- The policy store: people and their identities, resources and their categories and details, the
-- applications serving them and their keys, capabilities and roles, groups, grants and the answers
-- to them, invitations, revocations, the owner notification outbox, the audit log, and the record of
-- every policy change. Names resolve in the schema the run names, and the placeholders schema and
-- runtime_role, in psql's form for a variable quoted as an identifier, stand for the schema and the
-- controller's runtime role.

-- The runtime role reaches the schema's objects through the privileges the migrations grant it, and
-- through the schema migration command's grant of reading the record of applied migrations, and
-- through nothing else.
GRANT USAGE ON SCHEMA :"schema" TO :"runtime_role";

-- Every function the migration role creates from here on starts closed to PUBLIC, so a later
-- migration's function is reachable only through a grant of its own. A default set for one schema can
-- only add to the role's defaults, never take from them, so this one is the role's own, for this
-- database.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- People, each known to Usher by one or more identity provider accounts. No email address or display
-- name is stored.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL
);

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  idp_issuer text NOT NULL CHECK (idp_issuer <> ''),
  idp_subject_id text NOT NULL CHECK (idp_subject_id <> ''),
  added_at timestamptz NOT NULL,
  -- Empty where Usher recorded the identity on first meeting its subject, the system being the actor.
  added_by uuid REFERENCES users ON DELETE RESTRICT,
  CONSTRAINT user_identities_idp_issuer_idp_subject_id_key UNIQUE (idp_issuer, idp_subject_id)
);

CREATE INDEX user_identities_user_id ON user_identities (user_id);

-- Resources, each named by the identifier its data carries.

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  name text NOT NULL,
  description text,
  base_tier text NOT NULL CHECK (base_tier IN ('open', 'registered', 'grant')),
  suppressed boolean NOT NULL DEFAULT false,
  registered_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  registered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- A retired resource keeps its row, so its identifier stays reserved.
  retired_at timestamptz,
  retired_by uuid REFERENCES users ON DELETE RESTRICT,
  -- A payload names a resource by its identifier, as a key and as a filter value, so the identifier
  -- is never empty, never `__proto__`, and holds none of the markers a search application reads as an
  -- instruction in a filter value: usher-types' SPECIAL_VALUE_MARKERS.
  CONSTRAINT resources_external_id_usable CHECK (
    external_id <> ''
    AND external_id <> '__proto__'
    AND strpos(external_id, '*') = 0
    AND strpos(external_id, '__missing__') = 0
    AND strpos(external_id, 'set_id:') = 0
  ),
  CONSTRAINT resources_retirement_recorded CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);

-- One resource per identifier whatever its letter case, retired ones included. The collation is named
-- so that letters beyond ASCII fold alike under any database default, the C locale's included.
CREATE UNIQUE INDEX resources_external_id_unique ON resources (lower(external_id COLLATE "und-x-icu"));

-- Categories: global ones any resource may offer, and a resource's own. A payload names a category as
-- its scope and its name joined by a dot, so a name holds no dot; `unmarked` is the global category of
-- the records matching no other, so no resource takes its name.

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'resource')),
  resource_id uuid REFERENCES resources ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  CONSTRAINT categories_scope_names_resource CHECK ((scope = 'resource') = (resource_id IS NOT NULL)),
  CONSTRAINT categories_name_usable CHECK (
    name <> ''
    AND strpos(name, '.') = 0
    AND name <> '__proto__'
    AND (scope = 'global' OR name <> 'unmarked')
  ),
  -- Nulls compare equal here, so two global categories cannot share a name.
  CONSTRAINT categories_name_unique UNIQUE NULLS NOT DISTINCT (scope, resource_id, name)
);

CREATE INDEX categories_resource_id ON categories (resource_id);

CREATE TABLE resource_categories (
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories ON DELETE RESTRICT,
  PRIMARY KEY (resource_id, category_id)
);

CREATE INDEX resource_categories_category_id ON resource_categories (category_id);

-- A resource's details, under the fields the instance defines.

CREATE TABLE resource_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name <> ''),
  description text
);

CREATE TABLE resource_field_values (
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  field_id uuid NOT NULL REFERENCES resource_fields ON DELETE RESTRICT,
  value text NOT NULL,
  PRIMARY KEY (resource_id, field_id)
);

CREATE INDEX resource_field_values_field_id ON resource_field_values (field_id);

-- Applications, each id the audience a token names, and the keys they sign with, stored only
-- encrypted under the key-encryption key, whose check value the controller records at its first start.

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  description text,
  registered_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  registered_at timestamptz NOT NULL
);

CREATE TABLE application_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications ON DELETE RESTRICT,
  encrypted_key bytea NOT NULL,
  issued_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  revoked_by uuid REFERENCES users ON DELETE RESTRICT,
  revoked_at timestamptz,
  CONSTRAINT application_keys_revocation_recorded CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX application_keys_application_id ON application_keys (application_id);

CREATE TABLE key_encryption_key_check (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  check_value bytea NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE TABLE application_resources (
  application_id uuid NOT NULL REFERENCES applications ON DELETE RESTRICT,
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  PRIMARY KEY (application_id, resource_id)
);

CREATE INDEX application_resources_resource_id ON application_resources (resource_id);

-- Capabilities, named `entity.action`, and roles, each in the data plane or the control plane.

CREATE TABLE capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,
  action text NOT NULL,
  plane text NOT NULL CHECK (plane IN ('data', 'control')),
  display_name text NOT NULL,
  description text,
  CONSTRAINT capabilities_name_usable CHECK (
    entity <> '' AND action <> '' AND strpos(entity, '.') = 0 AND strpos(action, '.') = 0
  ),
  UNIQUE (entity, action)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name <> ''),
  plane text NOT NULL CHECK (plane IN ('data', 'control')),
  description text
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles ON DELETE RESTRICT,
  capability_id uuid NOT NULL REFERENCES capabilities ON DELETE RESTRICT,
  PRIMARY KEY (role_id, capability_id)
);

CREATE INDEX role_permissions_capability_id ON role_permissions (capability_id);

-- Groups, each belonging to one resource, so a group's grant can name no other.

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  created_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (resource_id, name),
  UNIQUE (id, resource_id)
);

CREATE TABLE group_users (
  group_id uuid NOT NULL REFERENCES groups ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_users_user_id ON group_users (user_id);

-- Grants, held by a person or a group. A null record category is the control plane's wildcard, the
-- whole resource. Grants are revoked or expire, and are never deleted.

CREATE TABLE grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  record_category_id uuid REFERENCES categories ON DELETE RESTRICT,
  field_category_id uuid REFERENCES categories ON DELETE RESTRICT,
  holder_user_id uuid REFERENCES users ON DELETE RESTRICT,
  holder_group_id uuid,
  role_id uuid NOT NULL REFERENCES roles ON DELETE RESTRICT,
  granted_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users ON DELETE RESTRICT,
  CONSTRAINT grants_one_holder CHECK (num_nonnulls(holder_user_id, holder_group_id) = 1),
  CONSTRAINT grants_revocation_recorded CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT grants_field_beneath_record CHECK (field_category_id IS NULL OR record_category_id IS NOT NULL),
  CONSTRAINT grants_group_on_its_resource FOREIGN KEY (holder_group_id, resource_id)
    REFERENCES groups (id, resource_id) ON DELETE RESTRICT
);

-- One live grant per holder, resource, record category and role, nulls comparing equal so the
-- wildcard and an absent holder count too. Its leading column also serves reading a person's grants.
CREATE UNIQUE INDEX grants_live_unique
  ON grants (holder_user_id, holder_group_id, resource_id, record_category_id, role_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

CREATE INDEX grants_holder_group_id ON grants (holder_group_id) WHERE revoked_at IS NULL;

CREATE INDEX grants_resource_id ON grants (resource_id);

CREATE INDEX grants_role_id ON grants (role_id);

-- Each answer a person gives about a grant, with what they were shown. Pending is the absence of a
-- row, and the latest answer decides; the key orders a person's answers about one grant with no tie.

CREATE TABLE grant_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  grant_id uuid NOT NULL REFERENCES grants ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  capabilities text[] NOT NULL,
  decided_at timestamptz NOT NULL,
  CONSTRAINT grant_decisions_user_id_grant_id_decided_at_key UNIQUE (user_id, grant_id, decided_at)
);

-- An invitation promises a grant the grants table accepts. Only a hash of its link's token is stored,
-- and its address is stored lower-cased, as lookups by address lower it.

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CONSTRAINT invitations_email_lower_case CHECK (email = lower(email)),
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  record_category_id uuid REFERENCES categories ON DELETE RESTRICT,
  field_category_id uuid REFERENCES categories ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles ON DELETE RESTRICT,
  link_token_hash bytea NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  invited_at timestamptz NOT NULL,
  -- When the promised grant expires; none when empty.
  expires_at timestamptz,
  CONSTRAINT invitations_field_beneath_record CHECK (field_category_id IS NULL OR record_category_id IS NOT NULL)
);

-- Revoking a principal entirely, and globally. A principal's revocation is lifted, never deleted, so
-- its history survives; the standing one is the row with no lift.

CREATE TABLE principal_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  revoked_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL,
  reason text NOT NULL,
  lifted_by uuid REFERENCES users ON DELETE RESTRICT,
  lifted_at timestamptz,
  CONSTRAINT principal_revocations_lift_recorded CHECK ((lifted_by IS NULL) = (lifted_at IS NULL))
);

CREATE UNIQUE INDEX principal_revocations_standing ON principal_revocations (user_id) WHERE lifted_at IS NULL;

CREATE TABLE global_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revoked_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('credentialCompromise', 'keyCompromise', 'securityIncident'))
);

-- What tells a resource's owners of a grant someone gave themselves, until it is delivered.

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('selfGrant')),
  grant_id uuid NOT NULL REFERENCES grants ON DELETE RESTRICT,
  recipient_user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  delivered_at timestamptz
);

-- The audit log: one CloudEvents envelope a row, `occurred_at` holding its `time`.

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specversion text NOT NULL,
  source text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  dataschema text,
  data jsonb NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'error', 'info', 'warning'))
);

-- The record of every change to a policy table: the operation, as PostgreSQL names it to a trigger,
-- the row's key and its values before and after, each a JSON object keyed by column, and the actor
-- the changing transaction declared.

CREATE TABLE change_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_key jsonb NOT NULL,
  old_row jsonb,
  new_row jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('anonymous', 'human', 'serviceAccount', 'system')),
  -- The acting person's or service account's subject; empty for an actor who is nobody.
  idp_subject_id text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT change_records_actor_named CHECK (
    (actor_type IN ('human', 'serviceAccount')) = (idp_subject_id IS NOT NULL AND idp_subject_id <> '')
  ),
  CONSTRAINT change_records_values_match_operation CHECK (
    (old_row IS NULL) = (operation = 'INSERT') AND (new_row IS NULL) = (operation = 'DELETE')
  )
);

-- Records a change to the row a trigger fired for, in the changing transaction, under the actor that
-- transaction declared with set_config('usher.actor_type', ..., true) and set_config('usher.actor_id',
-- ..., true). A change declaring no actor is refused. The trigger's arguments name columns kept out of
-- the record, such as an application key's encrypted_key: change records are never re-encrypted, so a
-- copy there would outlive a rotation of the key-encryption key protecting it. It runs as the schema's
-- owner, since the runtime role may read change records and never write them.
CREATE FUNCTION record_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  actor_type text := nullif(current_setting('usher.actor_type', true), '');
  kept_out text[] := coalesce(TG_ARGV, '{}');
  old_values jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - kept_out END;
  new_values jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - kept_out END;
BEGIN
  IF actor_type IS NULL THEN
    RAISE EXCEPTION 'a policy change declares no actor'
      USING ERRCODE = 'integrity_constraint_violation',
        DETAIL = format('the change is to %s', TG_TABLE_NAME),
        HINT = 'declare the actor with set_config(''usher.actor_type'', ..., true) in the changing transaction';
  END IF;
  INSERT INTO change_records (table_name, operation, row_key, old_row, new_row, actor_type, idp_subject_id)
  SELECT TG_TABLE_NAME, TG_OP, jsonb_object_agg(key_column.attname::text, coalesce(new_values, old_values) -> key_column.attname::text),
         old_values, new_values, actor_type, nullif(current_setting('usher.actor_id', true), '')
    FROM pg_index key_index
    JOIN pg_attribute key_column ON key_column.attrelid = key_index.indrelid AND key_column.attnum = ANY (key_index.indkey)
   WHERE key_index.indrelid = TG_RELID AND key_index.indisprimary;
  RETURN NULL;
END
$$;

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON application_keys
  FOR EACH ROW EXECUTE FUNCTION record_change('encrypted_key');

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON application_resources
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON capabilities
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON global_revocations
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON grant_decisions
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON group_users
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON invitations
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON principal_revocations
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON resource_categories
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON resource_field_values
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON resource_fields
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON resources
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION record_change();

-- The global category every resource's unmarked records fall under, written by the system.
SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true);

INSERT INTO categories (scope, name) VALUES ('global', 'unmarked');

-- The runtime role's privileges: what the controller's queries need, and no more. The append-only
-- tables take inserts and reads alone, a revocation's or a key's history takes updates of the
-- columns ending it alone, and no table takes a truncation.

GRANT SELECT, INSERT ON users, user_identities TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON resources TO :"runtime_role";
GRANT UPDATE (base_tier, description, name, retired_at, retired_by, suppressed, updated_at)
  ON resources TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON categories TO :"runtime_role";
GRANT UPDATE (description) ON categories TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON resource_categories TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON resource_fields TO :"runtime_role";
GRANT UPDATE (description) ON resource_fields TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON resource_field_values TO :"runtime_role";
GRANT UPDATE (value) ON resource_field_values TO :"runtime_role";

GRANT SELECT, INSERT ON applications TO :"runtime_role";
GRANT UPDATE (description, display_name) ON applications TO :"runtime_role";

GRANT SELECT, INSERT ON application_keys TO :"runtime_role";
GRANT UPDATE (confirmed_at, revoked_at, revoked_by) ON application_keys TO :"runtime_role";

GRANT SELECT, INSERT ON key_encryption_key_check TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON application_resources TO :"runtime_role";

GRANT SELECT, INSERT ON capabilities TO :"runtime_role";
GRANT UPDATE (description, display_name) ON capabilities TO :"runtime_role";

GRANT SELECT, INSERT ON roles TO :"runtime_role";
GRANT UPDATE (description) ON roles TO :"runtime_role";

GRANT SELECT, INSERT, DELETE ON role_permissions TO :"runtime_role";

GRANT SELECT ON groups, group_users TO :"runtime_role";

GRANT SELECT, INSERT ON grants TO :"runtime_role";
GRANT UPDATE (expires_at, revoked_at, revoked_by, role_id) ON grants TO :"runtime_role";

GRANT SELECT, INSERT ON grant_decisions TO :"runtime_role";

GRANT SELECT ON invitations TO :"runtime_role";

GRANT SELECT, INSERT ON principal_revocations TO :"runtime_role";
GRANT UPDATE (lifted_at, lifted_by) ON principal_revocations TO :"runtime_role";

GRANT SELECT, INSERT ON global_revocations TO :"runtime_role";

GRANT SELECT, INSERT ON notification_outbox TO :"runtime_role";
GRANT UPDATE (delivered_at) ON notification_outbox TO :"runtime_role";

GRANT SELECT, INSERT ON audit_log TO :"runtime_role";

GRANT SELECT ON change_records TO :"runtime_role";

-- No role calls a function of the schema unless a migration grants it the call. A trigger's function
-- fires for whoever changes its table all the same.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA :"schema" FROM PUBLIC;
