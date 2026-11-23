-- Declined answers: a holder who says no to a grant is stored as `declined`, where `rejected` was stored,
-- and a decider who declines a grant request is stored as `declined`, where `refused` was stored. The
-- words sent are `decline` for both, and `accept` or `grant` for the other outcome; the stored words are
-- the ones changed here. Granted requests and accepted answers keep their words.
--
-- Each rewritten row is recorded in change_records, as every policy change is: the rewrite runs as the
-- system actor, declared for this migration's transaction, so each row's old and new values are kept.
-- The two guards that refuse an update to a kept row are taken off for the rewrite alone, and put back
-- before the migration commits. Nothing else changes, and the record_change triggers stay on.

SELECT set_config('usher.actor_type', 'system', true);

ALTER TABLE grant_decisions DISABLE TRIGGER keep_history;
ALTER TABLE grant_requests DISABLE TRIGGER keep_decision;

ALTER TABLE grant_decisions DROP CONSTRAINT grant_decisions_decision_check;
UPDATE grant_decisions SET decision = 'declined' WHERE decision = 'rejected';
ALTER TABLE grant_decisions
  ADD CONSTRAINT grant_decisions_decision_known CHECK (decision IN ('accepted', 'declined'));

ALTER TABLE grant_requests DROP CONSTRAINT grant_requests_decision_known;
UPDATE grant_requests SET decision = 'declined' WHERE decision = 'refused';
ALTER TABLE grant_requests
  ADD CONSTRAINT grant_requests_decision_known CHECK (decision IN ('granted', 'declined'));

ALTER TABLE grant_decisions ENABLE TRIGGER keep_history;
ALTER TABLE grant_requests ENABLE TRIGGER keep_decision;

-- The function checking a decline by a counted owner keeps its resource owned, renamed from its
-- rejection's name; its trigger now fires for a decline.
ALTER FUNCTION keep_resource_owned_after_rejection() RENAME TO keep_resource_owned_after_decline;

-- A decline by a counted owner is checked at commit, as before, now for a decline.
DROP TRIGGER keep_resource_owned ON grant_decisions;

CREATE CONSTRAINT TRIGGER keep_resource_owned AFTER INSERT ON grant_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.decision = 'declined')
  EXECUTE FUNCTION keep_resource_owned_after_decline();
