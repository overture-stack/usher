# SQON-scoped grants

An optional `sqon` field on `category_grants` that narrows which records within a category a grant covers.

## What it enables

Enables governance bodies to approve access to a specific subset of their category (e.g. "indigenous records from community X only") rather than the full category within a resource. Requires SQON evaluation capability in the bridge: the bridge ANDs the grant's SQON filter into the query alongside the category-level filter.

Also enables sharing a filtered subset of records (a SQON-defined cohort) rather than a whole study, with the filter state captured in the grant at share time.

## References

- `.dev/design/permissions-model.md` (Multi-category intersection, resolved section)
- `.dev/design/decisions.md` (study-level sharing section)
