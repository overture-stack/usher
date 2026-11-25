-- Grants and grant requests written by one call share a creation id, so the grants a call made can be
-- answered together later, and its owners told once. Two calls in the same instant, by the same
-- granter, on the same terms, are still two calls, which nothing else on a row tells apart. Rows
-- written before this migration, and grants written by deciding a request, hold none.

ALTER TABLE grants ADD COLUMN creation_id uuid;

ALTER TABLE grant_requests ADD COLUMN creation_id uuid;
