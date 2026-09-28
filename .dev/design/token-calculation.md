# The token calculation

_The calculation the controller performs to produce a token: the rule it implements, the five steps,
the cases that force each branch, and what remains open._

**The associative tables follow from this document rather than the other way round.** Everything
below is written so that a schema can be checked against it.

---

## What is written today, and why it cannot be built from

`security-workflow.md` § Tiers described three steps, and each carried a defect. The same mistakes are the ones an implementation would make.

**Tier 1, the baseline.** Correct in substance, wrong in name: it called instance configuration an
"anonymous role", and a role cannot be held by a request carrying no `sub`. Corrected there.

**Tier 2 asserted a role hierarchy the model rejects.** It read "every resource where the user holds
a `registered` or higher tier role". `rabac-alignment.md` says Usher "deliberately does not have
them, treating roles as a flat set whose effective permissions are a union". `registered` is also a
tier name rather than a role name. Corrected there.

**Tier 3 never consulted groups.** It resolved "explicit category grant records for the user". A
group's grants were not read, so the calculation as written gave a principal nothing through their
group, while the prose elsewhere says effective access is the union of both. That section now defers
here, which is the standing fix: one document states the calculation.

**And one rule appeared nowhere**, the rule for combining two grants on one category. A second
absence was listed beside it and is not a defect: nothing gates a resource on every category it
carries having cleared, because no such gate exists. A category selects records within a resource.

---

## Effective access is the ceiling narrowed by grants

**Effective access is the ceiling minus every pair the grants do not name.** Read a role's capability
as held over every `(resource, category)` pair that exists, and read the grant set as naming the pairs
to keep. This is RABAC's shape exactly: its `avail_session_perms` is "the maximum permission set
available in a session", and its second stage only ever removes from it.

**This describes the result, not the computation.** Nothing enumerates the universe. Grants are stored
and unioned as rows, which produces the same set. The source model states the same caution about its
own definition: "this description specifies the net result. Various optimizations can be used so long
as the net result is as indicated."

**The invariant is `effective ⊆ ceiling`, and it holds without exception.** A grant cannot confer a
capability the role does not carry. Assert it where the token is issued rather than documenting it,
so that a path which builds a permission set without intersecting the ceiling fails rather than
passes.

Four behaviours that were separate stipulations follow from this one rule, which is the reason to
state it this way:

| Behaviour                                                | Was                              | Is                                           |
| -------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| No grants means nothing reachable                        | asserted                         | the ceiling minus everything, which is empty |
| No grant on a resource means nobody reaches it          | asserted, case 10               | no pair to keep                              |
| An empty category does not satisfy its own condition     | patched after shipping as a hole | nothing kept is nothing reached              |
| A category can only ever restrict                        | asserted in reader prose         | every category is a condition that removes   |

**Where it diverges from RABAC, deliberately.** An object with no applicable filter keeps its
permissions there, because a NIST RBAC permission is an `(operation, object)` pair and the role has
already named the object. Usher's ceiling carries verbs only, so the same default would confer
everything. Fail-closed is therefore required here rather than preferred, and the reason is
structural rather than a matter of appetite for risk.

**Combination stays union, and that is consistent rather than an exception.** A union of pairs kept is
still a subtraction from the maximum. Two grants cannot contradict because neither can deny. The rule
changes the moment anything can deny: filters combine deny-override, per the source model, so a
withholding rule beats any number of grants.

## The rules settled so far

**Combination among grants is union.** `rabac-alignment.md` states roles are a flat set whose
permissions are a union. Most restrictive would let one grant reduce what another confers, which no
grant does. Most specific needs an ordering, and roles have none. This is the grant layer only: a
withholding rule subtracts, and filters combine deny-override.

Five consequences.

1. **Roles do not combine; capabilities do.** One grant naming `viewer` and another naming `curator`
   cannot be unioned as roles. Each expands to capabilities first, and those are unioned.
2. **No grant reduces what another grant confers.** There is no way to say that someone should have
   less on one category than another grant already gives them. The levers are removing the grant,
   removing them from the group, and a withholding rule, which is the only one that subtracts and is
   the one that does not exist yet.
3. **Revocation acts on the grant, in one place.** Revoking a group's grant removes it for every
   member at once, and the members' decision rows are untouched because they record decisions rather
   than access. Removing one person while leaving the others means removing them from the group.
4. **Categories held through different groups simply accumulate.** One category held through G1 and
   another through G2 reaches the records of both, and neither group needs to know about the other.
5. **Acceptance is held per member, so a group grant does not skip it.** A grant to a group creates
   one row per affected member carrying that member's decision and the capabilities it confers.
   Ana accepting and Bo rejecting the same group grant is an ordinary outcome, and the grant itself
   is unchanged by either. A grant a rule confers is the exception and needs no acceptance: an
   anonymous request has nobody to accept, and a signed-in principal accepted the platform's terms
   when registering. It has no decision row, so step 3 would otherwise drop it.

---

## The calculation, in five steps

The steps come first and the cases that force each branch follow, in that order deliberately: a
walkthrough on its own hides every branch it does not take, which is how a calculation gets written
that looks complete and answers only one path.

    1. Which grants reach this principal? Those held by them directly, and those
       held by a group they belong to. Each names one (resource, category), the
       role its holder acts in there, and optionally one field category within
       that category.
       Add the `unmarked` grant each rule confers: the baseline's on every
       resource whose unmarked records are open, and, if the principal is
       signed in, the signed-in rule's on every resource whose unmarked records
       are registered.

    2. Expand each grant's role to capabilities. Their union is the ceiling.

    3. For each grant, take this principal's latest decision on it.
       Keep it if that decision was to accept, and if the grant itself is
       unexpired and unrevoked.

    4. What a kept grant confers is what they accepted, intersected with what its
       role confers now. Re-reading the role at issuance is what makes a later
       narrowing take effect without anyone re-running anything.

    5. Every resource holding at least one kept grant goes in the token, carrying
       the categories kept for it and, under each, the entities reached and the
       actions held. Grants naming a field category collect under that category's
       `field` key. A category not kept is simply not named, and the records
       carrying it are not reached; a field category not kept is not named either,
       and its columns are not shown.

Step 5 decides what the token says, and the adapter decides what that reaches: one clause per named
category, pairing the resource's field value with the category's, composed with `or`. So a resource
of mixed sensitivity serves each principal the records reached by their categories, rather than being
present in full or absent in full.

Where a record carries more than one category, every one of them must be held. That conjunction is
inside a single record's requirements and never across a principal's grants, and it is the part
waiting on a subset test the query layer cannot yet express. Until it lands a record carries one
category.

## The cases that force each branch

Against this configuration:

        curator  carries  create, view, update, delete
    viewer   carries  view

    G1 "cardiology" and G2 "study readers" are named sets of people and nothing
    more. A role is named on each grant, never on the group.

    HEART_STUDY     carries  controlled
    LUNG_COHORT     carries  no concrete category
    REEF_ARCHIVE    carries  controlled, community-governed

    Every resource's unmarked records are open unless a case says otherwise.
    The baseline is on and grants unmarked -> read wherever the setting is open.
    Ana is the principal, and belongs to no group unless a case says so.
    The token's audience serves all three resources.
    A grant below is at curator unless the case says otherwise.

**A category selects records within a resource.** Holding `unmarked` in HEART_STUDY reaches its
unmarked records and not its controlled ones, so a token naming one category of a resource is an ordinary
outcome rather than a partial failure. The one part deferred is a record carrying several categories
at once, which needs a subset test the query layer cannot yet express; until then a record carries
one category.

**The baseline contributes `{unmarked: [view]}` on all three resources**, since each holds records not covered by any concrete category. Rows below name only what a case adds to that or takes from it.

**The notation is shorthand.** A token entry nests category, then entity, then actions, so
`{unmarked: [view]}` below is `{"global.unmarked": {"record": ["view"]}}` in full. The scope prefix is elided
throughout, since every category in these cases is global, and the entity level is elided wherever it
is `record`, which is every row but the three field cases and case 26, and those name it
because that is the point of them.

| #   | Case                                                                                                             | Ana's token                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Anonymous. Baseline turned off                                                                                   | `{}`                                                                                                                                                                                              |
| 2   | Anonymous. Baseline on                                                                                           | `{unmarked: [view]}` on all three. She reaches the unmarked records of every study, and none of their controlled or community-governed ones                                                               |
| 3   | Registered, in no group                                                                                          | Same contents as case 2, with `sub` present, because no resource here has its unmarked records set to registered; see the note below the table                                                                                          |
| 4   | In G1. G1 granted HEART_STUDY/controlled. She has not answered, so she has no decision row for it                | The baseline only. HEART_STUDY appears with `unmarked` and without `controlled`, because no decision is not an acceptance                                                                             |
| 5   | Same, and she accepted                                                                                           | `HEART_STUDY: {unmarked: [view], controlled: [create, view, update, delete]}`                                                                                                                         |
| 6   | Same, and she rejected                                                                                           | The baseline only, as in case 4                                                                                                                                                                   |
| 7   | In G1 and G2. G1 granted HEART_STUDY/controlled at curator, G2 granted HEART_STUDY/unmarked at viewer. Both accepted | `HEART_STUDY: {controlled: [create, view, update, delete], unmarked: [view]}`. Two grants on one resource, each at its own role, which is the case a role held per resource cannot express            |
| 8   | In G1 and G2, both granted HEART_STUDY/controlled, both accepted                                                 | `controlled: [create, view, update, delete]`. Union of the two                                                                                                                                    |
| 9   | In G1. G1 granted REEF_ARCHIVE/controlled, accepted. Nothing for community-governed                              | `REEF_ARCHIVE: {unmarked: [view], controlled: [create, view, update, delete]}`. Its community-governed records are not reached, and the rest of the resource is                                       |
| 10  | A resource carries no concrete category, its unmarked records are by grant, and nobody is granted them                                                    | Reachable by nobody. All its records are unmarked, and no grant names `unmarked` on it                                                                                                         |
| 11  | The grant she accepted has expired                                                                               | Excluded, read from the grant rather than from her row                                                                                                                                            |
| 12  | The grant she accepted was revoked                                                                               | Excluded, read from the grant rather than from her row                                                                                                                                            |
| 13  | She rejected, then later accepted                                                                                | The later decision stands. Both rows are kept                                                                                                                                                     |
| 14  | She accepted at curator. The grant's role is then changed to viewer                                              | `controlled: [view]`. Narrowing needs no re-asking                                                                                                                                                |
| 15  | She accepted at viewer. The grant's role is then changed to curator                                              | `controlled: [view]`. The added capabilities are unaccepted until accepted                                                                                                                        |
| 16  | She leaves G1, her accepted row still present                                                                    | HEART_STUDY keeps `unmarked` from the baseline and loses `controlled`. The grant no longer reaches her, so the row confers nothing                                                                    |
| 17  | Her grant names REEF_ARCHIVE/community-governed after that category was removed from it                          | Inert, nothing to keep. **Open: whether removing a category warns about this**                                                                                                                    |
| 18  | Her grant names a resource this audience does not serve                                                          | Excluded. The token is per audience                                                                                                                                                               |
| 19  | HEART_STUDY's unmarked records are by grant, and she holds no grant on them                                                                             | Its unmarked records are not reached, and nothing else changes. Without `unmarked`, no grant could have named them at all                                                                                                                                        |
| 19b | Same, and she accepted a viewer grant on HEART_STUDY/unmarked | `HEART_STUDY: {unmarked: [view]}`. Records not covered by any category are reached through a grant like any other category's |
| 20  | `Auto-accept` is on for this instance                                                                            | An accepted decision is recorded at creation without her acting. Otherwise identical                                                                                                              |
| 21  | Accepted grant on controlled, against a record withheld until a date                                             | **No reach.** Not implementable yet                                                                                                                                                               |
| 22  | A record carries `controlled` and `community-governed`, and she holds only `controlled`                          | **No reach.** Both are needed. Not implementable yet: this is the subset test                                                                                                                     |
| 23  | A record carries a category value the adapter has no mapping for                                                 | **Served as unmarked**, so to whoever reaches the unmarked records, which is the defect the startup reconciliation check exists to prevent                                                                                                        |
| 24  | A column carries no field category, and the category is partitioned                                              | **Served as basic**, the field residual, and only to a principal granted `basic`. Safe while the reconciliation check covers field mappings and runs on an index mapping change, not only at boot |
| 24b | Her grant names `clinician` and not `basic`                                                                      | The clinician columns and no others. The residual is granted rather than assumed, exactly as `unmarked` is on the row axis                                                                            |
| 24c | The category is not partitioned by field at all                                                                  | No `field` key is emitted, and the record capabilities carry every column. Absence of a partition, not absence of a grant                                                                         |
| 25  | A grant names `record.delete` and carries a field category                                                       | **Refused at writing.** Deletion takes the whole record, so the pairing is meaningless, and `field_category_id IS NOT NULL` is what catches it                                                    |
| 26  | She holds `record.view` and `revision.view` on one category                                                      | `{unmarked: {record: [view], revision: [view]}}`. The entity level is what keeps these apart: a bare `view` could not say which, once two data-plane entities share the action                        |
| 27  | She holds `artifact.create` on HEART_STUDY's unmarked records                                                        | `{unmarked: {artifact: [create]}}`. An artifact drawn from two resources needs the capability under both, which is the provenance rule expressed in the token rather than beside it                   |

Case 3 is worth keeping: a registered principal in no group and an anonymous visitor produce the same
contents here only because no resource in this configuration has its unmarked records set to
registered. Where one does,
the signed-in rule gives the registered principal its grant and the anonymous visitor nothing, which
is the one difference a present `sub` makes on its own: see cases 28 to 34, against a configuration
with such a resource, and "Who holds a grant can follow a rule" in
[decisions.md](decisions.md).

Cases 14, 15 and 16 are the ones a role change or a membership change reaches, and all three are safe
without anyone remembering to re-run anything, because step 4 intersects what was accepted with what
the grant's role confers at issuance rather than trusting the stored row alone.

Case 13 is what makes the decision table append-only, and it is why the decision time has to be a UTC
instant rather than a date: selecting the latest decision needs a total ordering, and two decisions
about one grant can land in the same minute.

**Case 21 is the only case that distinguishes the two readings of this model**, and it is
unimplementable until something can withhold. Every other case produces the same expected output
whether the calculation is described as adding grants or as narrowing a ceiling, which means no test
can currently catch an implementation that gets the direction wrong, and none can confirm one that
gets it right. Writing it now pins the invariant ahead of the feature. It carries the same weight as
the rest: a conformance case marked not yet implemented, not a note.

### The signed-in rule, against its own configuration

These cases run against a second configuration, so every case above keeps its answer:

        viewer   carries  view

    OPEN_ATLAS       carries  no concrete category; unmarked records open
    MEMBERS_ARCHIVE  carries  no concrete category; unmarked records registered
    SEALED_ARCHIVE   carries  no concrete category; unmarked records by grant
    HEART_STUDY      carries  controlled; unmarked records open

    The baseline is on unless a case turns it off, and grants unmarked -> read
    wherever the setting is open. The signed-in rule grants unmarked -> read to
    every signed-in principal wherever the setting is registered.
    Ana is the principal, and the token's audience serves all four resources.

Every grant a rule confers here is on `unmarked`, shortened as above. See "Who holds a grant can
follow a rule" and "Records not covered by any category are `unmarked`" in [decisions.md](decisions.md).

| #   | Case                                                                      | Ana's token                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28  | Anonymous. Baseline on                                                    | `{unmarked: [view]}` on OPEN_ATLAS and HEART_STUDY. MEMBERS_ARCHIVE and SEALED_ARCHIVE are absent: one needs a sign-in and the other a grant                                                         |
| 29  | Anonymous. Baseline off                                                   | `{}`. Neither rule reaches her                                                                                                                                                                           |
| 30  | Signed in, no grants. Baseline on                                         | Case 28, plus `MEMBERS_ARCHIVE: {unmarked: [view]}`. This is the one difference a present `sub` makes on its own                                                                                      |
| 31  | Signed in, no grants. Baseline off                                        | `MEMBERS_ARCHIVE: {unmarked: [view]}` alone. An empty baseline reaches nobody on an open resource, signed in or not, because registration gating is the registered setting rather than an empty baseline |
| 32  | Signed in. Accepted a viewer grant on HEART_STUDY/controlled. Baseline on | Case 30, with `HEART_STUDY: {unmarked: [view], controlled: [view]}`. The rule's grants and her own accumulate, and neither replaces the other                                                         |
| 33  | Signed in, and her identity has been revoked                              | Refused. A revoked principal fails at the bridge before any query runs, so no rule reaches her: a grant a rule confers cannot outlive the identity it was conferred on                                  |
| 34  | Carries an expired identity token                                         | **Open: refused at the exchange, or served as case 28.** Case 28 reaches less, never more, but it records a signed-in person as anonymous and hides the failed sign-in                                  |
| 35  | Signed in. Accepted a viewer grant on SEALED_ARCHIVE/unmarked. Baseline on | Case 30, plus `SEALED_ARCHIVE: {unmarked: [view]}`. Records not covered by any category, on a resource that is not open, are reachable once someone is granted them                                             |

A resource set to registered may carry a restricting category as well: the setting reaches its
unmarked records, and its controlled records need their own grant, as case 32 shows for an open one.

---

## What the source model settles

**The ceiling is a real gate, not advice.** RABAC's second stage removes from `avail_session_perms`
and can never add, so a grant cannot confer a capability the role does not carry. `ceiling` is the
right word for it: the paper's own term is "the maximum permission set available in a session".

**The ceiling is global to the principal, not held per resource.** `avail_session_perms` is a function
of the session alone and never consults an object. Per-resource narrowing is stage two's entire job,
so a per-resource ceiling collapses the two stages back into one and reintroduces the role explosion
they exist to prevent. Usher has no sessions, so the ceiling is per principal per audience.

**Assignment runs through two mechanisms and no third.** User-role assignment, unchanged from NIST
RBAC, confers the ceiling; user attributes compared against object attributes inside a filter decide
reach. There is no per-object grant table anywhere in the model. Usher's grant rows are a set-valued
user attribute in those terms, the `(resource, category)` pairs a principal holds, compared against
the category a record carries.

**Roles confer a ceiling, so a group may confer a role and must not confer reach.** Groups are absent
from RABAC entirely. Groups conferring roles is NIST's first option, dynamic roles, which the paper
names and does not take. Combining the two is legitimate and is what Usher does, but it means a group
feeds stage one only.

**Three things the model does not have, so none can be checked against it**: groups, acceptance, and
an administrative model. The paper faults earlier proposals for the third and its own story is that
filter policies live in a separate file for ease of administration. Usher's whole control plane is
therefore ours, and belongs on the list of what survives as genuinely ours.

---

## Still open, and each blocks part of the calculation

- **Can a group's grants span resources?** They can today, and nobody is named as controlling group
  membership, so one membership change grants every resource that group touches, with no acceptance
  and without any of those resources' owners involved. Confining a group's grants to one resource
  removes it and matches the arrangement `permissions-model.md` already describes. Groups are an
  admitted design gap, and this is its shape. **The reading that settles the direction**: a group
  landing permissions across resources is the shape of a system administrator failing open, since it
  produces platform-wide reach from a membership change that no resource's owner sees and nobody is
  named as controlling. Stated as a threat rather than a preference, the answer is no, and what
  remains open is only how the constraint is expressed in the schema.
- **Whether removing a category from a resource warns about the grants it makes inert.** A grant
  naming a pair that no longer exists keeps nothing, so nothing is unsafe. The question is only
  whether anyone is told.
- **Where the withholding layer lives.** Embargo is a filter function rather than a category or a
  grant, and Usher has nowhere to put one. It combines deny-override against any number of grants.
  Case 21 pins the behaviour; the mechanism is unbuilt, and it is the only part of the model where a
  missing rule fails silent rather than loud, so it has to withhold whenever it cannot determine that
  an embargo has lifted.
