-- Removing an administrator. An administrator is removed by a row of its own, never by deleting the
-- administrator's row, so the nomination that accepted them stays as written. A person removed may be
-- nominated and accepted again, so an administrator is keyed by the nomination accepted, and each person
-- holds one live row at a time.

-- An administrator is keyed by the nomination accepted, not by the person: a person removed may hold a
-- row again from a later acceptance. The person's own lookups run on an index of their own.
ALTER TABLE administrators DROP CONSTRAINT administrators_pkey;
ALTER TABLE administrators DROP CONSTRAINT administrators_nomination_id_key;
ALTER TABLE administrators ADD PRIMARY KEY (nomination_id);
CREATE INDEX administrators_user_id ON administrators (user_id);

-- A removal of an administrator, by the nomination that accepted them, and when and by whom. A removal
-- is made once, and neither the removal nor the administrator it names is changed or deleted.
CREATE TABLE administrator_removals (
  nomination_id uuid PRIMARY KEY REFERENCES administrators (nomination_id) ON DELETE RESTRICT,
  removed_at timestamptz NOT NULL,
  removed_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT
);

-- Every change to a removal is recorded, under the actor its transaction declares, and no removal is
-- changed or deleted once written.

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON administrator_removals
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON administrator_removals
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'administrator_removals_kept', 'a removal is kept as written; a removed administrator is never deleted'
  );

-- A person holds one administrator at a time: an acceptance is refused while a row for the same person
-- has no removal. The trigger's name sorts after refuse_second_answer, so a second answer to a nomination
-- is named by that rule first, whichever table it lands in.
CREATE FUNCTION refuse_second_held_administrator() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM administrators held
              WHERE held.user_id = NEW.user_id
                AND NOT EXISTS (SELECT 1 FROM administrator_removals removal
                                 WHERE removal.nomination_id = held.nomination_id)) THEN
    RAISE EXCEPTION 'a person holds one administrator at a time'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'administrator_held_once';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER refuse_second_held_administrator BEFORE INSERT ON administrators
  FOR EACH ROW EXECUTE FUNCTION refuse_second_held_administrator();

-- The runtime role records a removal and reads it; it changes and deletes neither.
GRANT SELECT, INSERT ON administrator_removals TO :"runtime_role";
