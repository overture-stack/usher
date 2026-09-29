# Categories that select without restricting

**The core of this is decided, as the overlay category.** "A category either partitions or overlays"
in [decisions.md](../../../design/decisions.md) has a partitioning category carve up the record set,
with `unmarked` as what is left, and an overlay select within it without changing what `unmarked`
covers. What stays research is using overlays to define synthetic resources, and the three rules
below for doing that safely.

## The idea

The design already makes this distinction once. A resource selects records and a category restricts
them ([adapter-integration.md](../../../design/adapter-integration.md)). A category that does not
restrict extends selecting beyond the single resource field: a record carrying one is reached by
whoever could reach it anyway, and the category only picks it out. Categories restrict by default,
so one created without a decision fails closed.

## What it looks like

Four HEART_STUDY records, with "controlled" restricting and "paediatric" only selecting, read from
the records' existing age-group field:

| Record | Belongs to                               | Reached with the open grant | Reached with HEART_STUDY "controlled" |
| ------ | ---------------------------------------- | --------------------------- | ------------------------------------- |
| r1     | "controlled", selected by "paediatric"   | no                          | yes                                   |
| r2     | selected by "paediatric" only            | yes                         | yes                                   |
| r3     | "controlled" only                        | no                          | yes                                   |
| r4     | nothing                                  | yes                         | yes                                   |

"paediatric" changes who reaches nothing. It picks out r1 and r2, and that selection is the synthetic
resource.

## What it solves

**It narrows the multi-category problem to the part that is hard.** A record needing every one of
its categories' grants only arises with two restricting categories on one record. One restricting
category and any number of selecting ones needs no both-grants check, so selecting categories do not
wait on the subset check, still inexpressible in the query layer (see "A category selects records
within a resource" in [decisions.md](../../../design/decisions.md)).

**It is the safe half of local categories.** A selecting category cannot release anything, so an
owner could create one without the bypass hazard recorded in [local categories](local-categories.md).
Only a local restricting category waits on the conjunction.

## The rules it needs

1. **Marking a partitioning category as an overlay releases its records.** The decision keeps the
   marking in the adapter's mapping and adds it to the reconciliation check, since the clause stays
   well-formed and nothing downstream notices. What that does not yet cover is who may change it: for
   a category with a custodian it is the custodian's decision alone, or it is the admin's self-grant
   bypass by another route. Community-governed data is always a partitioning category.
2. **A synthetic resource is a view, never an authority.** A grant on one reaches only what its
   holder already reaches through each record's home resource, narrowed to the selection. Otherwise
   its owner releases records governed by another resource's owner, which is the leak produced by
   the any rule under "Overlapping cohort access: any or all" in
   [permissions-model.md](../../../design/permissions-model.md). A view of this kind is the
   predicate-scoped grant described in [uac-flows-traceability.md](../../uac-flows-traceability.md)
   for sharing a virtual cohort, so the two designs meet here.
3. **A selecting category reads a field already on the records.** Nothing is written onto records
   to create one; enforcement reads descriptive fields only (decisions.md, "Usher is data-agnostic").

A selecting category would carry the same scope prefix as any other, `global.` or `resource.`.

## Its name is overlay

The decision already names it and settles the naming question. The other candidates were taken
anyway: `tag` is retired in [terminology usage rules](terminology-usage.md) because "record-level
category tagging" named the mechanism as writing labels onto records, and `set` is reserved for
Arranger's saved sets. What a grant naming an overlay would reach is rule 2 above.
