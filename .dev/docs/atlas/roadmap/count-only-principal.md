# A principal who counts and does not view

Research rather than planned work. A principal holding `count` without `view` is possible in the
model, since capabilities are granted independently, and nothing yet needs one. No seeded role
holds `count` alone, and the discovery role expected to be needed first is the surveyor under Future
scope, which views a bounded number of records and counts nothing. This file records what is known, so that a later need starts from it.

## What such a principal gets

**Totals, and no facets.** A facet is a field offered as a filter, and it lists its buckets, each
named by its key, one of the field's values, and carrying the count of records holding it. The key
needs `view` and the count needs `count`, so a principal holding `count` alone sees how many records
match and no facet to narrow them by. That is the safe reading, and it is narrower than the
discovery tier was first described: counts and facets without records.

**Their page has no table.** There are no records to list, so it is a headline count, narrowed by
whatever facets they may use. Choosing a bucket narrows the count, where for a principal who views
records it narrows the table. Omitting the table is the rendering item's mechanism, and it needs the
component library's contract for absence recorded there, in
[to-discuss.md](../../../design/to-discuss.md).

**Not live in phase 1.** A grant of `count` without `view` resolves to denied everywhere until the
enforcement seam can tell which surface is asking, so no principal meets this in the first release.
Serving one needs the seam changes in [adapter-integration.md](../../../design/adapter-integration.md):
pruning by what a request selects, and the hook evaluated once per capability within one request,
since a principal viewing open records and counting controlled ones needs two sets in one response.

## What any rule has to survive

**Withholding a bucket's key protects only what the principal could not otherwise obtain**, and
three routes obtain a count without it:

| Route       | What it recovers                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtraction | a withheld bucket's count, as the total less the visible buckets' counts, when both come back under the one `count`                                                                     |
| Filtering   | a bucket's count with its key withheld: count the records whose field holds a value the principal supplies, or that fall in ranges it supplies, which one unit wide rebuild a histogram |
| Repetition  | a small group, from two counts over criteria that differ only by the people in it                                                                                                       |

**So the question is wider than facets.** It is what a principal holding `count` may learn about a
field's values by any route, and a facet is only the most visible one. Filtering is the route the
discovery tier exists to serve, since counting the records that match someone's criteria is the use
case, so a field's values being guessable decides more than whether it is offered as a facet.

**The oracle needs no aggregation.** A plain record count under a filter confirms whether a value
the principal names exists in data they reach, so every count is a route to the values of whatever
it may be filtered by. Classifying aggregations governs what one response hands over unasked; it
does not reach what a series of guesses recovers.

**Exposure is a property of the field's values, not of the query surface.** An ordered numeric field
falls to bisection, a field with few and guessable values falls to enumeration, and free text falls
to neither in practice. So whatever settles this is per field and per instance's data. A field
holding twelve study identifiers and one holding ten thousand donor identifiers take the same
capability and carry different exposure.

**The repetition route is a known result.** Refusing to answer for small query sets does not keep
individual records confidential, because a tracker, a pair of overlapping queries whose difference
isolates the small set, can almost always be found
([Denning, Denning and Schwartz, 1979](https://dl.acm.org/doi/10.1145/320064.320069)).

**The first integration applies no small-cell threshold.** Established on the enforcing side: every
count is returned as the engine computes it, including one.

**Any protection here costs the interface its exact small numbers**, and only for principals served
counts without records, since one who can view the records can count them.

## Rules recommended and not adopted

| Rule                                                                                                                                                                       | Why                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A field may be declared countable by value, by whoever governs the data. Then it is a facet for a principal holding `count`, with its buckets and ranges and filters on it | exposure is per field, so the judgement is too. Undeclared by default, and then offered nothing |
| Every count served to such a principal is rounded to a base, totals included, with a minimum below which nothing is shown                                                  | rounding each number separately resists subtraction and repetition better than suppression      |
| A count returned beside records is exact and over exactly those records                                                                                                    | only a standalone count over records reached at `count` alone is rounded                        |

**Rounding over suppression.** Statistics Canada rounds every census figure, totals included, to a
multiple of 5 and rounds totals independently of their cells
([random rounding](https://www12.statcan.gc.ca/census-recensement/2011/dp-pd/prof/help-aide/N2.cfm?Lang=E)),
so a total less its visible cells no longer recovers a hidden one. Suppression alone falls to the
repetition route, and choosing which companion cells to hide needs the counts first, which is a step
after the query. Rounding one number needs no other cell. It has to return the same value for the
same query, or repeating the query averages it away, and it narrows the attack rather than closing
it.

**Who sets the numbers.** The base and the minimum belong to whoever governs the data, per
category, and Usher carries them without choosing them. For a community's data that is the
community, which is what the custodian role exists for.

**Export is unaffected.** Export requires `view` and `export`, so the total an export paginates on is
over records the exporter views and is never rounded.

## Two ways to separate a bucket's key from a record

A facet needs a bucket's key and its count, which is why grouping `count` and `view` as `aggregate`
looks right. It fails at one step, traced with the same shape both ways:

| Step | `aggregate` as `count` and `view`                    | `count` and a declared facet                                 |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------ |
| 1    | a role is defined with `aggregate`, meaning facets   | a role is defined with `count`                               |
| 2    | it expands to `count` and `view`                     | the field `sex` is declared countable by value               |
| 3    | the `sex` facet works: the key needs `view`, held    | the `sex` facet works: the declaration permits its keys      |
| 4    | **the table opens, since records need `view`, held** | the table does not open, since records need `view`, not held |
| 5    | facets were meant and records were granted           | facets without records, as meant                             |

One `view` governs a field's values in records and in buckets alike, so no group built from it means
facets without records. What separates them is either the declaration, decided per field, or a
capability for bucket keys, say `enumerate`, decided per principal. With the second, `aggregate`
becomes a coherent group of `count` and `enumerate`. At the record level it would open every field's
keys, so it still needs a per-field limit, and it is the extension to add if some principals holding
`count` should list keys and others should not.

**Distinct-value counts in place of facets are not worth building.** For an undeclared field they say
only that it exists and how many values it has, which nobody can act on and which still says
something about the data.
