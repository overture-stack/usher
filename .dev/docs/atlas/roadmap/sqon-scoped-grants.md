# SQON-scoped grants

An optional `sqon` field on `grants` that narrows a grant to some of its category's records.

## What it enables

Enables sharing a filtered subset of records (a SQON-defined cohort) rather than a whole study, with the filter state captured in the grant at share time. This is the iMS flows' "share by virtual cohort", a post-MVP ticket. Requires SQON evaluation permission in the bridge: the bridge ANDs the grant's SQON filter into the query alongside the category-level filter.

Approving a subset of one category, such as one community's records, no longer needs this: since categories became conditions, that subset is a category of its own, defined by its condition in the category mapping.

## References

- `.dev/design/permissions-model.md` (Multi-category intersection, resolved section)
- `.dev/design/decisions.md` (study-level sharing section)
