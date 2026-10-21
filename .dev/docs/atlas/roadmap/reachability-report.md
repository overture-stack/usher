# A reachability report

A report for the people who govern records, answering one question about one person and one
resource: how many of the resource's records that person reaches, and which categories keep them
from the rest. Its use is working out why someone cannot see data they expect to, and which grant
would change that.

## What each viewer sees

| Viewer                                         | What the report shows                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The resource's owners                          | Records the person reaches against the resource's total, and the categories gating the rest                    |
| A category's custodian                         | The same, within that category only                                                                            |
| Any administrator                              | The categories gating the rest, without counts                                                                 |
| The person the report is about                 | Nothing about records they cannot reach                                                                        |
| Owners and custodians, within what they govern | Records counted as in a category only because a field its condition reads is missing, as a bucket of their own |

## The rules it keeps

**Counts are shown only within what the viewer governs.** The admin model withholds record counts
from administrators, because a count of records in a sensitive category is itself a disclosure. An
owner or a custodian already governs the records being counted, so showing them a count discloses
nothing they lack. An administrator sees which categories gate a person's remainder, which the admin
model already shows them as category assignments.

**The person never learns what exists beyond their reach.** The Usher token already omits categories
a principal lacks, so a report shown to them would undo that.

**Small counts are suppressed in sensitive categories.** A count of three records from one community
tells a reader that community took part. Below a threshold, the report says the count is small
rather than giving it.

**Usher never reads a record.** The counts come from the ushered application that holds the data,
such as Arranger, which already applies each person's narrowing to its own queries. Usher supplies
the person's permissions; the application counts.

**The missing-field bucket is for fixing data.** A record missing a field that a category's
condition reads counts as in that category, which keeps it restricted. Shown separately, those
records tell an owner where the data has gaps, rather than reading as deliberate restrictions.

## Open

- The threshold below which a count is suppressed, and which categories are sensitive enough to
  apply it.
- How a viewer's request is bounded. Evaluating access as another person is a powerful act, so it
  is limited to those who govern the records, and each request is an audit event naming viewer,
  person and resource.
- The request's shape: the management screens ask the application to count under the person's
  permissions, bounded by what the viewer governs, through an interface the adapter does not have
  yet.
