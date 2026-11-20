-- Orphaned resources' requests: a platform administrator's grant of a role other than submitter and
-- owner on a resource with no counted owner is written as a grant request someone else decides, for
-- the person it names. The runtime role writes and decides a request of either kind through the
-- privileges it holds on grant requests already, so this grants it nothing.

-- A request of two kinds: `selfGrant`, a grant to the principal asking for it themself, and
-- `orphanedResource`, a grant on a resource with no counted owner to someone other than the principal
-- asking.
ALTER TABLE grant_requests DROP CONSTRAINT grant_requests_kind_known;

ALTER TABLE grant_requests
  ADD CONSTRAINT grant_requests_kind_known
    CHECK (kind IN ('orphanedResource', 'selfGrant')),
  ADD CONSTRAINT grant_requests_orphaned_resource_held_by_another
    CHECK (kind <> 'orphanedResource' OR holder_user_id <> requested_by);
