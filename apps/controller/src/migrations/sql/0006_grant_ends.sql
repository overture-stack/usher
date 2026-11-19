-- A grant's end: when a new grant on its terms replaced it once it had expired. Ended is final, and
-- an ended grant no longer holds its terms, so the same holder may be granted the same role on the
-- same resource and category again.

ALTER TABLE grants ADD COLUMN ended_at timestamptz;

-- A grant ends only once it has expired: never one that does not expire, and never before its
-- expiry.
ALTER TABLE grants ADD CONSTRAINT grants_ended_after_expiry
  CHECK (ended_at IS NULL OR (expires_at IS NOT NULL AND ended_at >= expires_at));

-- Once ended, a grant keeps its end, its expiry and its role as written. Its revocation may still
-- be recorded.
CREATE TRIGGER keep_end BEFORE UPDATE ON grants
  FOR EACH ROW WHEN (
    OLD.ended_at IS NOT NULL
    AND (
      NEW.ended_at IS DISTINCT FROM OLD.ended_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.role_id IS DISTINCT FROM OLD.role_id
    )
  )
  EXECUTE FUNCTION refuse_change(
    'grants_end_kept', 'a grant''s end is kept as recorded, with its expiry and its role'
  );

-- One grant per holder, resource, record category and role that is neither revoked nor ended, nulls
-- comparing equal so the wildcard and an absent holder count too. Its leading column also serves
-- reading a person's grants.
DROP INDEX grants_live_unique;

CREATE UNIQUE INDEX grants_live_unique
  ON grants (holder_user_id, holder_group_id, resource_id, record_category_id, role_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL AND ended_at IS NULL;

GRANT UPDATE (ended_at) ON grants TO :"runtime_role";
