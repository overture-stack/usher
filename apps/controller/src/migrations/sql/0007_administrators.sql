-- Usher's own administrators, and the nominations naming them. The first user, whom the identity
-- provider marks with a role, nominates the first administrator, possibly themself, and the nominee
-- accepts. A nomination is kept as written, and an administrator is never deleted.

-- A person nominated to be an administrator, by a person. A later nomination replaces every earlier
-- one, so no two share an instant and the latest is the one an acceptance may name.
CREATE TABLE nominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nominee_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  nominated_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  nominated_at timestamptz NOT NULL,
  CONSTRAINT nominations_nominated_at_key UNIQUE (nominated_at),
  -- What an administrator's row names: a nomination with its nominee.
  CONSTRAINT nominations_id_nominee_id_key UNIQUE (id, nominee_id)
);

CREATE INDEX nominations_nominee_id ON nominations (nominee_id);

-- An administrator: a person who accepted a nomination naming them, each nomination accepted once.
CREATE TABLE administrators (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE RESTRICT,
  nomination_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL,
  CONSTRAINT administrators_nomination_id_key UNIQUE (nomination_id),
  CONSTRAINT administrators_nominee_accepts FOREIGN KEY (nomination_id, user_id)
    REFERENCES nominations (id, nominee_id) ON DELETE RESTRICT
);

-- Every change to either is recorded, under the actor its transaction declares, and their history
-- is kept: a nomination is never changed or deleted, and an administrator never deleted.

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON administrators
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON nominations
  FOR EACH ROW EXECUTE FUNCTION record_change();

CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON nominations
  FOR EACH ROW EXECUTE FUNCTION refuse_change(
    'nominations_kept', 'a nomination is kept as written; a later nomination is a row of its own'
  );

CREATE TRIGGER keep_history BEFORE DELETE ON administrators
  FOR EACH ROW EXECUTE FUNCTION refuse_change('administrators_kept', 'an administrator is never deleted');

-- The runtime role inserts nominations and administrators, and reads them; it changes and deletes
-- neither.
GRANT SELECT, INSERT ON nominations, administrators TO :"runtime_role";
