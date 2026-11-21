-- Nomination answers: a nominee declines a nomination, and the first user revokes one while it is
-- pending. Neither changes a nomination, which is kept as written, so each answer is a row of its
-- own, keyed by the nomination it answers. A nomination is answered once: by an administrator's
-- row, a decline, or a revocation, and the store refuses an answer to one already answered.

-- A nomination its nominee declined, and when.
CREATE TABLE nomination_declines (
  nomination_id uuid PRIMARY KEY REFERENCES nominations ON DELETE RESTRICT,
  declined_at timestamptz NOT NULL
);

-- A nomination the first user revoked, and when.
CREATE TABLE nomination_revocations (
  nomination_id uuid PRIMARY KEY REFERENCES nominations ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL
);

-- Every change to either is recorded, under the actor its transaction declares, and neither answer is
-- changed or deleted once written.

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON nomination_declines
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON nomination_declines
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'nomination_declines_kept', 'a nomination declined is kept as written'
  );

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON nomination_revocations
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON nomination_revocations
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'nomination_revocations_kept', 'a nomination revoked is kept as written'
  );

-- One answer per nomination, held by the schema as well as by the store's lock: an administrator's
-- row, a decline and a revocation each refuse an insert for a nomination that already holds a row in
-- either of the other two. A table's own duplicate is left to its primary or unique key.
CREATE FUNCTION refuse_second_answer() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  IF (TG_TABLE_NAME <> 'administrators'
        AND EXISTS (SELECT 1 FROM administrators WHERE nomination_id = NEW.nomination_id))
     OR (TG_TABLE_NAME <> 'nomination_declines'
        AND EXISTS (SELECT 1 FROM nomination_declines WHERE nomination_id = NEW.nomination_id))
     OR (TG_TABLE_NAME <> 'nomination_revocations'
        AND EXISTS (SELECT 1 FROM nomination_revocations WHERE nomination_id = NEW.nomination_id)) THEN
    RAISE EXCEPTION 'a nomination is answered once'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'nomination_answered_once';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER refuse_second_answer BEFORE INSERT ON administrators
  FOR EACH ROW EXECUTE FUNCTION refuse_second_answer();

CREATE TRIGGER refuse_second_answer BEFORE INSERT ON nomination_declines
  FOR EACH ROW EXECUTE FUNCTION refuse_second_answer();

CREATE TRIGGER refuse_second_answer BEFORE INSERT ON nomination_revocations
  FOR EACH ROW EXECUTE FUNCTION refuse_second_answer();

-- The runtime role records an answer and reads it; it changes and deletes neither.
GRANT SELECT, INSERT ON nomination_declines, nomination_revocations TO :"runtime_role";
