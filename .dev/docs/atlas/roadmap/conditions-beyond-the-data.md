# Conditions beyond the data

A category's two halves come apart here. Which records need a grant has so far been the records' own
field and value, and who holds the grant has been individual grants plus one baseline. Either half
can reach further: which records can be bounded in time, and who holds a grant can follow a rule
about the person asking. This is the attribute-based access control described in the onboarding
document: facts about the person, the data and the situation.

| Idea                  | Status                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- |
| the registered setting | decided, in the first release; see [decisions.md](../../../design/decisions.md)              |
| embargo               | research; not in the first release                                                            |
| rules about the person | the mechanism decided; which rules beyond signing in, research                                |

## Rules about the person beyond signing in

The mechanism is decided: a rule decides who holds a grant, the controller evaluates it at the
exchange, it reads only provider-verified claims, and its result is recorded at each exchange. See
"Who holds a grant can follow a rule" in [decisions.md](../../../design/decisions.md). What remains
research is which rules to offer beyond signing in, such as an affiliation verified by the identity
provider, and whether the staleness allowed by a token's lifetime is acceptable for each category
conferred by a rule.

## Embargo as a local category with a deadline

An embargo is one resource's state, so its category is local: `resource.embargo-S7`, one per
embargoed segment, each with its own deadline held in Usher.

On open data, one iMS study with an embargoed submission:

| Step | What happens                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | HEART_STUDY's unmarked records are open, and it carries `resource.embargo-S7`, which selects the records of submission S7       |
| 2    | S7's records belong to `resource.embargo-S7` alone, since `unmarked` covers only what no other category claims                  |
| 3    | anonymous visitors reach the unmarked records, and holders of the embargo grant, S7's submitters, reach S7's records as well   |
| 4    | at the deadline the controller removes the embargo category and announces it as a category change, and S7's records fall back to `unmarked` |

No record belongs to two categories at any step, so embargo on open data needs no both-grants check.
Embargo on controlled data does: an S7 record that is "controlled" belongs to both.

It meets the four requirements recorded under "Embargo" in
[permissions-model.md](../../../design/permissions-model.md):

| Requirement                                          | How                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| a state, not a grant                                  | the deadline belongs to the category, never to a principal's grant                                           |
| below the resource, with separate deadlines           | one local category per embargoed segment                                                                     |
| identifiable by the enforcing adapter                  | the segment is a field already on the records, and the deadline stays in Usher, so nothing prescriptive is written into the data |
| access varying by principal within the segment        | whoever holds the embargo category's grant reaches the segment early                                         |

**What it would take**, and why it is not in the first release:

1. **Every bridge serving the study enforces the narrow kind of local category first.** A first-release
   bridge drops `resource.` entries, so an adapter behind one never learns the embargo exists, renders
   `unmarked` as the whole study, and serves S7's records to everyone. That covers search and every file
   path: SONG, Score's downloads and Lyric.
2. **The mapping check is mandatory before an embargo can be set.** "Open" renders as "not
   embargoed", a negation, and a negation over a mis-mapped field matches everything, which serves the
   embargoed records. [adapter-integration.md](../../../design/adapter-integration.md) records this
   failure.
3. **The records carry their submission in every catalogue that serves the study.** Not yet verified.
4. **A missed release fails closed.** If the deadline passes without the announced change, the
   records stay embargoed.

## What this suggests for local categories generally

Two proposals for [local categories](local-categories.md), not adopted:

- **A local category that only takes records out of `unmarked` needs no both-grants check.** The current
  wording makes every local category wait on an adapter that can render a record carrying more than
  one category, which holds only for a local category overlapping another restricting one.
- **The adapter declares the field, and Usher holds the values.** For embargo the adapter declares the
  submission field once, and Usher holds which submissions each embargo covers, as it already holds
  resource identifiers. That answers where a local category's mapping lives without Usher learning
  what a field means, and an owner could set one without a configuration change.
