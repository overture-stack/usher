-- Channel assertions presented to the notice stream, each recorded once across every Controller instance
-- sharing the store, so that one assertion opens at most one notices stream. A row is kept until its
-- assertion stops being accepted, and the retention sweep deletes it once the clock tolerance has passed.

CREATE TABLE used_channel_assertions (
  application_id uuid NOT NULL REFERENCES applications ON DELETE RESTRICT,
  -- The assertion's `jti`, unique to it and never empty.
  assertion_id text NOT NULL,
  -- The last instant the assertion is accepted at: its `exp` plus the clock tolerance.
  accepted_until timestamptz NOT NULL,
  PRIMARY KEY (application_id, assertion_id),
  CONSTRAINT used_channel_assertions_id_named CHECK (assertion_id <> '')
);

GRANT SELECT, INSERT, DELETE ON used_channel_assertions TO :"runtime_role";
