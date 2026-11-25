-- A category's name is unique within its scope and its resource in any letter case, as a resource's
-- external id is: once `Controlled` is registered, `controlled` names it and no second category. The
-- name keeps the letter case it was written in. Nulls compare equal, so two global categories cannot
-- share a name.

ALTER TABLE categories DROP CONSTRAINT categories_name_unique;

CREATE UNIQUE INDEX categories_name_unique ON categories (scope, resource_id, lower(name COLLATE "und-x-icu"))
  NULLS NOT DISTINCT;
