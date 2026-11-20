-- Grant requests: a principal asks for a grant someone else decides. A request names the grant's
-- terms as a grant does and the end asked for, keeps what the principal asking was shown, and
-- records its decision once. Granting it writes the grant, which names the principal who asked
-- beside its granter, and the resource's owners are told of each request through the owner
-- notification outbox.

-- A request of one kind: `selfGrant`, a grant to the principal asking for it. While undecided it
-- has no decision, decider or instant, and it lapses at `expires_at`, judged when it is read; a
-- decision records all three, and a granted request names the grant written for it. Nobody decides
-- their own request, nor one whose grant they would hold.
CREATE TABLE grant_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CONSTRAINT grant_requests_kind_known CHECK (kind IN ('selfGrant')),
  requested_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  holder_user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  resource_id uuid NOT NULL REFERENCES resources ON DELETE RESTRICT,
  record_category_id uuid REFERENCES categories ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles ON DELETE RESTRICT,
  -- When the grant would end, and when the request lapses while undecided.
  expires_at timestamptz NOT NULL,
  -- What the principal asking was shown of the role's capabilities, as `entity.action` names.
  capabilities text[] NOT NULL,
  requested_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users ON DELETE RESTRICT,
  decided_at timestamptz,
  decision text
    CONSTRAINT grant_requests_decision_known CHECK (decision IN ('granted', 'refused')),
  grant_id uuid REFERENCES grants ON DELETE RESTRICT,
  CONSTRAINT grant_requests_self_grant_requested_by_holder
    CHECK (kind <> 'selfGrant' OR holder_user_id = requested_by),
  CONSTRAINT grant_requests_decision_recorded
    CHECK (num_nonnulls(decided_by, decided_at, decision) IN (0, 3)),
  CONSTRAINT grant_requests_grant_when_granted
    CHECK ((grant_id IS NOT NULL) = (decision IS NOT DISTINCT FROM 'granted')),
  CONSTRAINT grant_requests_decided_by_another
    CHECK (decided_by <> requested_by AND decided_by <> holder_user_id)
);

CREATE INDEX grant_requests_resource_id ON grant_requests (resource_id);

CREATE INDEX grant_requests_requested_by ON grant_requests (requested_by);

-- A decision is kept as recorded, and a request is decided or lapses, never deleted.
CREATE TRIGGER keep_decision BEFORE UPDATE ON grant_requests
  FOR EACH ROW WHEN (
    OLD.decision IS NOT NULL
    AND (
      NEW.decision IS DISTINCT FROM OLD.decision
      OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    )
  )
  EXECUTE FUNCTION refuse_change(
    'grant_requests_decision_kept', 'a grant request''s decision is kept as recorded'
  );

CREATE TRIGGER keep_history BEFORE DELETE ON grant_requests
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'grant_requests_kept', 'a grant request is decided or lapses, and is never deleted'
  );

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON grant_requests
  FOR EACH ROW EXECUTE FUNCTION record_change();

-- The principal who asked for a grant written by granting a request, while `granted_by` names who
-- granted it; empty for any other grant.
ALTER TABLE grants ADD COLUMN requested_by uuid REFERENCES users ON DELETE RESTRICT;

ALTER TABLE grants ADD CONSTRAINT grants_requested_by_another CHECK (requested_by <> granted_by);

-- The outbox tells owners of a grant request too: each row names the one grant or request its kind
-- tells of.
ALTER TABLE notification_outbox
  ADD COLUMN request_id uuid REFERENCES grant_requests ON DELETE RESTRICT;

ALTER TABLE notification_outbox ALTER COLUMN grant_id DROP NOT NULL;

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_kind_check CHECK (kind IN ('grantRequest', 'selfGrant')),
  ADD CONSTRAINT notification_outbox_reference_matches_kind CHECK (
    (kind = 'selfGrant' AND grant_id IS NOT NULL AND request_id IS NULL)
    OR (kind = 'grantRequest' AND request_id IS NOT NULL AND grant_id IS NULL)
  );

-- The runtime role records a request and its decision, and changes nothing else of it.
GRANT SELECT, INSERT ON grant_requests TO :"runtime_role";
GRANT UPDATE (decided_at, decided_by, decision, grant_id) ON grant_requests TO :"runtime_role";

-- The settings gain the longest a self-grant lives. A store holding settings, which its first run has
-- seeded, takes the default now. A store holding none is seeded with every setting by its first run,
-- after the migrations, so it takes no row here. The row is a change made by the system, with no actor.
ALTER TABLE settings DROP CONSTRAINT settings_name_check;

ALTER TABLE settings ADD CONSTRAINT settings_name_check CHECK (name IN (
  'backChannelLogout', 'eventSource', 'firstUser', 'grantAutoAccept', 'grantRules',
  'heartbeatMilliseconds', 'issuer', 'noticePageLimit', 'noticeRereadMilliseconds',
  'retentionGraceSeconds', 'retentionMarginSeconds', 'selfGrantMaximumLifetimeSeconds',
  'signInTokenMaximumLifetimeSeconds', 'streamLimitPerAudience', 'streamMaximumLifetimeSeconds',
  'streamQueueLimit', 'submitterCategory', 'tokenLifetimeSeconds'
));

SELECT set_config('usher.actor_type', 'system', true), set_config('usher.actor_id', '', true);

INSERT INTO settings (name, value, changed_at)
SELECT 'selfGrantMaximumLifetimeSeconds', '86400'::jsonb, now()
  WHERE EXISTS (SELECT 1 FROM settings);
