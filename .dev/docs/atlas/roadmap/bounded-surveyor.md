# A surveyor who views a bounded number of records

Post-MVP. A principal holding `view` without `count` or `export`, whose view of a category is held
between a minimum and a maximum number of records per query. They see what the data looks like and
not how much of it there is, which is what gives someone a reason to request access. `surveyor` is
the name intended for this role, and it is the discovery role more likely to be needed than one
holding `count` alone.

## What it looks like

A researcher holds this on HEART_STUDY's controlled records, with a maximum of 10 and a minimum of 10:

| Step | What happens                                                                         |
| ---- | ------------------------------------------------------------------------------------ |
| 1    | they filter on diagnosis = Arrhythmia                                                |
| 2    | ten matching records come back, with no total and no second page                     |
| 3    | the diagnosis facet lists its bucket keys without their counts                       |
| 4    | a filter matching fewer than ten records returns none                                |
| 5    | they know what the data looks like, not how much there is, and they apply for access |

## What serving it takes

| Rule                                                            | Why                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| at most the maximum per query                                   | the point of the role                                                                |
| the minimum or none, never between                              | seeing three records of a rare condition can identify the people in them             |
| no paging past the maximum                                      | otherwise the maximum limits nothing                                                 |
| no ordering chosen by the principal                             | "the ten oldest patients" is the extremes leak, returned as records                  |
| the same records for the same query                             | otherwise repeating a query harvests new ones                                        |
| no totals and no bucket counts                                  | the role holds no `count`                                                            |
| a bucket key only where at least the minimum of records hold it | otherwise a rare value's existence shows; a search engine applies this at query time |
| no `export`                                                     | otherwise the whole set leaves in one file                                           |

**The limits are not a confidentiality control.** Enough narrowed queries, each returning different
records, approach the whole set, and "none" says fewer than the minimum match, which is a count
thresholded at that minimum. What the role gives is friction and an audit trail, the same claim
`export` makes against `view`.

**Its page is a third variant**, beside the page for a principal who views records and the one for a
principal who only counts: records without totals, bucket keys without counts, and no pagination. So
it needs the component library's contract for being told which page it renders, recorded in the
rendering item in [to-discuss.md](../../../design/to-discuss.md).

## Why it is post-MVP

**The first integration cannot limit one category within a response.** Every principal holds the
open grant, so a limit on controlled records always shares a response with unlimited open ones.
Arranger resolves one filter per request, which gives one set and one size, and limiting part of a
response is the per-capability evaluation recorded as the third widening in
[adapter-integration.md](../../../design/adapter-integration.md).

**Every read path has to honour the limits**: hits and paging, download, which pages through
everything it matches, and saved-set creation, which collects every matching identifier. A path that
misses them serves the whole category.

**Granting it before enforcement exists yields a full viewer.** The role narrows paths the service
already serves, so a service that does not implement the limits applies none of them: the principal
sees every record, the totals, and can download, since the export path is unenforced as well. That
is the severe direction of the unimplemented-capability rule in
[decisions.md](../../../design/decisions.md), and it means the role must be refused at writing
until its audience declares the limits, which is the reconciliation check in
[to-discuss.md](../../../design/to-discuss.md) doing the work it is recorded as owing.

## Open when it is picked up

**Where the limits live.** A grant names one resource and one category, so limits set on the grant
are per category and per person at once: a grant on open carries none, and one on controlled carries
the numbers. Different people can then hold different limits on the same category, which is the
reason to put them on the grant rather than on the category.

**Two grants reaching one category with different limits.** Holding more never reaches less, so the
wider limit would win, and a grant carrying none would lift them. That follows from the additive
model and is not yet decided.

**How the limits reach the adapter.** On the token's category entry, which changes the payload type,
or through configuration the adapter reads. The payload type is cheapest to change before anything
implements it.

**Per catalogue or across them.** A resource's records can sit in several catalogues, since the
resource field is a homologue across them, and each query runs against one catalogue. So the limits
would apply per catalogue unless decided otherwise, and a principal could see the maximum from each
catalogue holding that resource.

**One number or two.** A maximum and a minimum can differ; the example sets both to 10.

**A column on `grants`**, which adds to the schema work that blocker 6 waits on.
