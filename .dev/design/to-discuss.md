# Design Issues: To Discuss

Items flagged during design review that require a deliberate decision or design work before the
affected area can be considered ready for implementation. Grouped by theme; severity noted inline.

This document is distinct from the open questions already captured in individual design files.
Those are design decisions not yet made. Items here are either gaps in designs presented as
settled, inconsistencies between documents, or security properties that are claimed but not fully
closed.

---

## The reconciliation check is load-bearing and unspecified

**[HIGH] Six separate failure modes name the same mitigation, and nothing describes it.** Each of
these is recorded as failing closed, and each is recorded as silent, with the startup reconciliation
check as the thing that makes it loud:

1. A category exists in Usher and the adapter has no mapping for it.
2. A record carries a category value the adapter has no mapping for, which serves it as open.
3. A capability in Usher's vocabulary that the service does not implement.
4. A field category with no column mapping, which is the cost accepted for dropping a kind property.
5. A column appearing in an index mapping with no category, which is safe only if the check runs on
   a mapping change rather than at boot alone.
6. A partitioning category configured as an overlay, which drops it from the complement `open` is
   rendered as, so every principal holding the open grant reaches the records it was meant to remove.
   Unlike the five above this is not a mismatch between two declarations: the token is correct, the
   clause is well-formed, and the mistake exists only in the adapter's own configuration, so nothing
   downstream can notice it. The opposite error, an overlay marked partitioning, empties `open` and is
   impossible to miss.

**Nothing in this corpus specifies the protocol.** Not what each side declares, not when it runs, not
what either does with a mismatch, not whether the controller retains what an adapter declared.

**Three of the four now have an answer from the enforcing side**, offered by the first integration
and recorded here as the starting point rather than as the specification:

- **What an adapter can declare**, which bounds everything else: the resource field configured per
  queryable type, the category field once that exists, and from the live index mapping every field
  with its type and whether it is aggregatable. The first two come from configuration, the last two
  from the store itself.
- **When it can run is fixed rather than chosen**: at catalogue load, after the mapping has been
  fetched and before any request is served. Earlier is impossible, since the mapping is a network
  call, and later means requests were already answered under an unreconciled configuration.
- **Mismatch behaviour should not be one rule.** A category the adapter cannot map renders no clause,
  so it cannot enforce and the catalogue fails closed. A cardinality or aggregatability divergence is
  a report, because declaration density across real deployments is unknown and a first run that stops
  working catalogues is its own outage.

**It has to run per catalogue, because the category mapping is per catalogue.** A category means the
same thing across an instance, and each catalogue's adapter decides how to recognize it in that
catalogue's data, just as it decides which field names a resource. One study can sit in two
catalogues under one `study_id`, with its clinical records `controlled` and its environmental ones
`open`: the clinical adapter maps `controlled` to a value every clinical record already carries, and
the environmental adapter declares that none of its records carry it.

**That needs three states per category and catalogue, not two.**

| State           | What the adapter declares              | What follows                                                                    |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Mapped          | a field test that recognizes it here   | clauses render, and `open` excludes what the test matches                       |
| Declared absent | no record in this catalogue carries it | `open` needs no exclusion for it, and resources carrying it stay reachable here |
| Not mapped      | nothing                                | the resources carrying it are taken out of this catalogue, which fails closed   |

**Without the middle state the example cannot work.** The environmental adapter, having nothing to
map `controlled` to, falls into the third row and takes out the whole study, open records included.
And the check cannot tell a deliberate absence from a forgotten mapping, so it either flags a
correct configuration or accepts a mistake. The declaration has to be able to say "none here"
explicitly, and the check has to ask once per catalogue rather than once per application.

**The middle state is the only one that can be wrong in the dangerous direction.** Established with
the enforcing side. A mapped test is checkable, and a missing mapping fails closed. A declared
absence is a claim about data, and an indexing run can falsify it without anything noticing: a
record carrying the category arrives, no clause tests for it, and since `open` excludes only mapped
values, the record is served as open to everyone.

**So a declared absence is the last resort.** Wherever the catalogue has a field that could carry
the category, the category is mapped, even if the test matches nothing today: that costs nothing,
and a record that later matches is withheld rather than served. Absence is declared only where no
field in the catalogue could carry the category, so that falsifying it takes a mapping change, which is failure mode 5 and needs the check to run on
a mapping change and not at boot alone. That turns a risk falsified by continuous, unattended
indexing into one falsified at a discrete and attributable event, which can be checked rather than
monitored.

**The first integration has no mapping-change signal.** Established on the enforcing side: it reads
the mapping at catalogue load, a change takes effect for queries at once because the search engine
owns the mapping, and its own derived state stays as it was read at boot. So running the check on a
mapping change needs a mechanism that does not exist there, and both failure mode 5 and a declared
absence depend on it.

**Where it is declared, it is verified.** The existence check in the rendering item answers whether
any record carries the category, and it belongs with the sample the search layer already takes at
catalogue load for cardinality. Unlike a cardinality divergence, a falsified absence is not a
report: it is a live disclosure, which [adapter-integration.md](adapter-integration.md) already rules
is an incident with an owner rather than a log line. It joins the preconditions the integration
asserts and nothing else checks, beside cardinality, per-record category marking and identifier
uniqueness across catalogues, and it is the only one a deployment adds deliberately.

**Retention is required rather than preferable, and the argument is about clause polarity.** Without
it, a grant naming a field or a capability the audience does not have is writable and surfaces at
query time. What happens then depends on the shape of the clause built from it: a positive clause on
a missing field matches nothing and denies, while a negated one matches nothing, negates to match-all,
and permits. `open` is rendered as exactly that negation. So non-retention does not defer the error,
it converts an authoring mistake into a silent widening on the one category every principal holds.
See the unimplemented-capability decision in [decisions.md](decisions.md).

**Why this is its own item.** The check was cited once as a mitigation and then
cited again each time a new silent failure was found, without anyone going back to ask whether the
thing being relied on exists. It is now the single point of unexamined trust in the enforcement
story, and every finding that lands on it makes it more load-bearing rather than more defined.

## Token and grants model

**[RESOLVED] Fast-path refresh does not account for `resource_categories` changes.**
Resolved together with the entry below, because they were one defect: the marker was per principal
while the change is per resource. There is no last-policy-change timestamp. The fast path compares a
category version held on each resource and bumped by any `resource_categories` write, so the write
that causes the change is the write that invalidates, with no set of affected principals to compute.
See the fast-path decision in [decisions.md](decisions.md). Original finding:
`security-workflow.md` describes comparing `generatedAt` against "the user's last policy change."
If that means changes to the user's `grants` rows (the most natural
reading), then tightening `resource_categories` (adding a new controlled category to a resource)
does not invalidate any active cached tokens until their TTL expires. A user who should no longer
see certain records after a category is added to their resource will continue to see them for up
to one TTL window. For a system handling PHI this is a correctness gap in the access control
guarantee. Resolution requires specifying exactly which operations update the "last policy change"
timestamp and confirming that `resource_categories` writes are included.

**[RESOLVED] `generatedAt` is not in the entity schema.**
There is no per-user timestamp to find a home for. State lives in two places instead, each next to
what changes it: the computed payload in the shared cache, deleted by anything altering what a
principal holds, and a category version on `resources`. Absence of a cache entry means recompute,
which cannot go subtly stale the way a comparison can. See the fast-path decision in
[decisions.md](decisions.md). Original finding:
The fast-path check and the revocation comparison both depend on a per-user "last policy change"
timestamp. Its storage location is not described: not in `permissions-model.md`'s entity schema,
not in the PostgreSQL section of `architecture.md`. Is it a column on `users`? A separate
`user_policy_versions` table? A Valkey key? What writes to it? The fast path is the primary
performance mechanism; its correctness depends on this field being updated by exactly the right
set of operations.

**[RESOLVED] Multiple roles per resource, single `role` field in the token.**
The token carries no `role` field. Roles are resolved to permissions at issuance, so a union of
roles becomes a union of permissions computed before the token is written and there is nothing to
collapse. Original finding:
`permissions-model.md` explicitly supports multiple simultaneous roles per user per resource, with
effective permissions as the union of all role permissions. The token structure has a single scalar
`role` field per resource entry. No rule is specified for collapsing multiple roles into one value
at issuance time. An adapter receiving a collapsed value that does not represent the user's full
permission set will apply incorrect filters. Either the token schema needs to support an array, or
the collapsing rule needs to be defined and its safety argued.

**[RESOLVED] Anonymous token cache key is undefined.**
Answered in both halves. Every anonymous principal receives exactly the baseline's grants, so they
all receive the same token, and one shared token per application is correct rather than one of
several options. Per application rather than per instance, because a Usher token is audience-scoped
and wrapped to one application's key, so anonymous principals of the search service and of the
submission service cannot share one. Invalidating it needs no version or generation on the baseline:
a notice telling each bridge to drop the entry it holds for principals with no `sub` evicts exactly
one thing, and carries no payload, since a bridge that re-exchanges receives whatever is correct now.
A resource-keyed notice was considered first and is worse on both counts, invalidating every token
naming the resource and having to name it, which tells applications that do not serve it that it
exists. Original finding:
The bridge caches Usher tokens per user, identified by `sub`. Anonymous tokens have `"sub": null`.
Multiple anonymous users share the same bridge. What is the cache key? One shared token for all
anonymous sessions? One per request? One per session cookie? Each option has different security
and performance characteristics. Revocation of open access (a resource taken offline) also needs
a defined path for the anonymous case, since a notice naming the principal cannot name a null `sub`.

**[HIGH] A category change reaches no application until its token expires.**
Found while answering the anonymous case above, and it is not confined to it. The channel announces
withdrawn grants, naming the principal. A category write announces nothing: it bumps the resource's
version, which is compared only when a bridge comes back for a new token.

1. The `resource_categories` write lands and the resource's category version bumps.
2. Nothing is announced, because no grant was revoked.
3. No cached payload is deleted, because nothing changed what any principal holds.
4. Every bridge keeps serving from a token computed before the change.
5. At the next refresh the version comparison fails, Usher recomputes, and the correct token is issued.

**Step 4 is the exposure and it is the same length for every principal**, signed in or not. Adding a
category to narrow `open`, or taking a resource out of open access entirely, both land here.

**It contradicts a stated property.** [decisions.md](decisions.md) says losing access is immediate
and gaining it waits, and the push channel exists because one TTL was judged too long for an
emergency. Neither holds for a category change. That sentence is now qualified there rather than left
standing.

**Two ways to close it, and they are not equivalent.** Either a category write announces itself, in
which case the question is what it names for a principal who has no `sub` (answered above: drop the
anonymous entry, which needs no name), or TTL-bounded narrowing is accepted and the immediacy claim
is dropped everywhere rather than qualified in one place. The first costs a fan-out or a
resource-keyed notice; the second costs a guarantee.

**[MEDIUM] `revoked_at` is a scalar; reinstatement and multiple revocations are undefined.**
Downgraded, because most of the premise went with the per-user marker. `revoked_at` lives on the
grant, not on the user, and a grant is revoked once and never reinstated: restoring access writes a
new grant, with its own identity, its own `granted_at`, and its own decision row. So there is no
overwritten timestamp and no history to reconstruct, and a token issued between two revocations named
grants that are each separately revoked.

What stays open is narrower and belongs with the same unanswered question as everything else about
stopping a principal outright: revoking a _person_ rather than a grant has no settled storage, so
whether that is a sweep over their grants or a marker on `users` decides whether reinstatement is
many writes or one. See blocker 6 in [../docs/phase-1.md](../docs/phase-1.md).

**[RESOLVED] Self-grant TTL expiry sets user-level `revoked_at`, disrupting the roles they hold.**
The premise no longer holds: an expiring grant writes no `revoked_at` and fires nothing. The
controller drops it when computing the next payload, so the admin's other roles are untouched
and nothing per-user is invalidated. Neither remedy the item asked for is needed. See
[decisions.md](decisions.md) § A grant's expiry is resolved before the token is written, and the
corrected TTL requirement in [admin-model.md](admin-model.md).

**[RESOLVED] Grant expiry for inactive users is not covered by the revocation propagation path.**
It does not need to be. Expiry propagates nothing, so there is no event for an inactive bridge to
miss. The cached token the item worried about cannot exist: a token is issued to expire with the first
grant on it to lapse, so a token issued before the deadline is already invalid when
presented after it, and the bridge rejects it on the `exp` check it performs anyway, without having
learned anything. See [decisions.md](decisions.md) § A grant's expiry is resolved before the token
is written.

---

## Admin access paths

**[HIGH] The adapter-level admin bypass skips the gate the grant-gating decision says nothing skips.**
`admin-model.md` documents a bypass in which an adapter detects the platform-admin role in the IdP
token and applies no filter at all. It creates no grant record, is logged only by the adapter, is
disableable per instance, and the document already recommends disabling it for health-data
instances.

The grant-gating decision in `decisions.md` states that a grant passes two stages and that there is
no administrative path that skips the second, only a broader grant to enter it. The bypass is
exactly such a path: no grant, no custodian decision, no category evaluated.

Both were written deliberately and the bypass predates the custodian decision, so this is a
reconciliation rather than an error in either. The question is narrow and not an engineering one:
**where a category carries a custodian, may an instance enable a bypass that reaches that
category's data without the custodian's grant?** For community-governed data the answer looks
like no, which would make the bypass conditional on the categories a resource carries rather than a
single instance-wide switch.

Until it is answered, `decisions.md` overstates. Recorded there as an exception to be resolved
rather than silently left standing.

**A smaller question gates phase 1 and can be answered first: does the Arranger adapter implement the
bypass at all?** The switch is per instance, and `admin-model.md` recommends off for health-data
instances without making that the default, so an adapter that never implements it forecloses the
question for the first integration without settling the custodian one above. That is a scope
decision rather than a design defect, and it is the half that has a deadline.

## Token contract

**[MEDIUM] Three BCP 225 items are open, and the corpus now cites that BCP for a fourth.**
RFC 8725 is the JWT Best Current Practices. Explicit typing, §3.11, is closed: `typ` is `usher+jwt`,
recorded in [decisions.md](decisions.md). Three remain, all header decisions, all cheap, and leaving
them open while citing the BCP for the one that was taken is the part that needs closing.

1. **§3.1, verify `alg` and `enc` rather than reading them.** The algorithm is pinned as what the
   controller emits. Nothing says the bridge pins it on read, which is the shape this class of bug
   takes: a JOSE library handed a token honours the header it finds.
2. **§3.6, no compression before encryption.** `zip` is unstated. It must be explicitly never used,
   because compressing a payload before encrypting it leaks plaintext through ciphertext length.
3. **§3.10, do not trust `kid` blindly.** There is no `kid` yet, and it is the unnamed answer to the
   open key-rotation question, so the rule and the mechanism arrive together or neither does.

§3.2, §3.7, §3.8, §3.9 and §3.12 are covered. See the RFC 9068 comparison in
[decisions.md](decisions.md) for why §3.12 already follows from the key separation here.

**[LOW] Four token-spec details have no stated answer.** None blocks implementation; each is a number
or a rule someone will otherwise invent at the keyboard.

| Question                       | Note                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clock skew for `exp` and `iat` | skew is called "the ordinary JWT concern" and left there. Against a five minute TTL, a thirty second leeway is ten percent of the window, which is a tradeoff rather than a default to inherit |
| `aud` as a string or an array  | RFC 7519 §4.1.3 permits both. Pin the string form and reject arrays, since permitting both is how a validator gets written against one and fed the other                                       |
| `nbf`                          | expected to be no, unrecorded                                                                                                                                                                  |
| token size bound               | wanted before a principal holding grants in hundreds of resources finds it first                                                                                                               |

**[RESOLVED] If roles resolve at issuance, the token's `role` field should not exist.**
Applied. A resource maps to a plain list of category grants, `role` and any detached permission
list are gone, open content is a category, and there is no empty-list case. A baseline
defines the baseline and may grant nothing. Recorded in [decisions.md](decisions.md) and applied in
[security-workflow.md](security-workflow.md). Original analysis:
Roles in the source model do two jobs: they are a compact way to assign many permissions at once,
and they are the first stage of a two-stage check evaluated when access is attempted. This design
moves the second job to issuance time so that adapters hold no policy. That leaves roles doing only
the first job, which is an authoring convenience, and an authoring convenience has no reason to
travel in an enforcement payload.

Where roles then live, none of which is the token:

| Place                         | Job                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| The management interface      | Granting by role rather than by enumerating permissions                                      |
| The grant store               | Which role was assigned, for provenance and for recomputing when a role's definition changes |
| Usher's own API authorization | Whether a principal may perform a grant operation at all                                     |

**Ownership is absent from the token for a second and independent reason.** An owner's powers are
management operations: granting, revoking, setting visibility. Those are performed against Usher's
own API, which checks them directly. An adapter never enforces them, so the enforcement payload never
needs to say who is an owner. This is the same conclusion an earlier sketch reached the wrong way
round, by inventing a `manage` flag in the token before asking what would consume it.

**A detached `permissions` property is also wrong, and for a reason that runs deeper than shape.**
It exists only to cover a resource's unrestricted content, which presumes that unrestricted content
is a baseline sitting outside the category system. That presumption is the last trace of the
subtractive model this design replaced, and it is the reason the token has been hard to reason
about.

    Subtractive, superseded:  the resource's full category set is the baseline. The token says
                              which categories are held; the adapter subtracts the rest and excludes
                              them. An empty list leaves the unrestricted remainder visible.

    Additive, current:        nothing is a baseline. The token says which grants are held; the
                              adapter emits one positive clause per grant. An empty list is no
                              grants, so it reaches nothing.

The same field means opposite things under the two, and four sections of `permissions-model.md`
still describe the subtractive one. Anyone reading both carries the contradiction.

**Making open content its own category removes the baseline entirely.** If the unrestricted portion
is a category like any other, there is no remainder for subtraction to leave behind, and every
reachable record is reachable because of a grant that names it. That also expresses tier
differences that the current shape cannot: anonymous principals holding `open: [view]` while registered
ones hold `open: [view, update]`, which is a real distinction between the tiers with nowhere to
live today.

    "STUDY_A": { "open":       { "record": ["view", "update"] },
                 "controlled": { "record": ["view"] } }

**And it retires `categories: []`**, which was flagged in review as not sitting right and whose gloss
has been corrected twice. With open content as a category it cannot occur: any access to a
resource means holding
at least one grant on it, and holding none is the same as absence from the map. One state instead of
two that had to be told apart.

**Consequence to accept deliberately: categories stop being optional.** A resource carrying no
categories becomes ungrantable, because there is nothing to name in a grant. Every resource must
carry at least one, which for ordinary data is the open one.

**Vocabulary, and this half stands.** The conclusion recorded here was `view` rather than `read`, on
the reasoning that the portal flows distinguish viewing metadata from downloading files. `view`
names seeing a record, and `read` is the capability group of `count`, `view` and `export`.
`download` became `export`, which ships and is seeded into the reading roles, so what the flows
distinguish is `view` against `export`.

**Applied**, with the configured baseline as the mechanism once the detached
permission list is gone.

## Adapter contract

**[HIGH] The reindex-lag dissolution covers a grant changing, not the data changing, and consent
withdrawal is the case that falls through.**

**No live exposure in the first deployment, and that is where the argument has to start.** Neither of
the first instance's catalogues carries an access-level field, so the category clause has nothing to
test and per-category enforcement is inert. Record-level narrowing is post-MVP. Nothing below can
happen today. It is filed because the requirement it names has no home in the model at all, which is
a thing to settle before something is promised on it rather than after.

**Two changes can make an indexed value and an access decision disagree, and only one is answered.**

|                                | A grant changes in Usher        | The record's own data changes at the source |
| ------------------------------ | ------------------------------- | ------------------------------------------- |
| Does any indexed field change? | no                              | yes, after the indexing pipeline runs       |
| What the filter tests          | a current value                 | a **stale** value                           |
| Window                         | the revocation channel, seconds | the indexing pipeline, minutes to hours     |
| Recorded?                      | yes: dissolved, not deferred    | **nowhere**                                 |

The dissolution in [phase-1.md](../docs/phase-1.md) and the superseded freshness question in
[adapter-integration.md](adapter-integration.md) both argue that enforcement reads descriptive fields
only, so a _grant_ change alters no indexed value. Both are sound and neither reaches the second
column. A descriptive field is exactly the thing that does change when the data changes, and the
index holds the old value until it is reindexed.

**Only the narrowing direction matters**, which halves the problem before anything is designed. A
record becoming more restricted while the index still carries the wider value is matched by a clause
that should no longer reach it, and nothing announces that. A record becoming less restricted is
withheld until the index catches up, and someone complains. Silent one way, loud the other.

**Consent withdrawal is the instance that makes this more than a data-correction concern**, and it
has no representation anywhere in this corpus. Searched: every "withdrawn" here refers to a grant.
The model offers it no home, and the reason is structural rather than an oversight:

- **It cannot be an enforcement field.** A withdrawal marker states that a record may no longer be
  reached, which is the definition of a prescriptive field in
  [decisions.md](decisions.md), and enforcement reads descriptive fields only.
- **It cannot be a grant.** Grants are per `(resource, category)`. One participant withdrawing is per
  record, and no grant expresses that.
- **Record-level narrowing, where it would live, is post-MVP** and further out than that in one
  place.

**So the question to settle is where consent withdrawal lives, not how to close the window.** If it
belongs to the grant layer then the second column stops applying to it and what remains is ordinary
data-correction staleness, which is a much weaker requirement. If it does not, the window is real and
one of the mitigations below has to be chosen.

**Four mitigations, if the window turns out to be real.** Recorded so the choice is visible rather
than made at implementation time:

| Approach                                                                                         | Cost                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Verify on read: the index returns candidates, the returned page is rechecked against the source  | one lookup per page rather than per corpus, and the index stops being an authority                            |
| Push affected record identifiers over the existing revocation channel as a short-lived exclusion | needs a signal that the indexer has caught up; the channel already carries push, poll and fail-secure         |
| Fail closed when the index's last sync is older than a threshold                                 | an indexing outage becomes a search outage, which matches the posture already taken on the revocation channel |
| Synchronous or priority reindex on a narrowing change                                            | couples submission latency to indexing, so a slow index blocks writes                                         |

**[HIGH] Nothing governs what a surface renders, except in the management package.**

**Almost none of this is live in phase 1, and the reason is where each layer's names come from.**
Component configuration, the extended mapping and GraphQL introspection all name _fields_, and
field-level restriction is designed but not built, so in phase 1 every principal reaching a record
reaches all of its fields and a field name discloses nothing the model restricts. Resources are
field _values_ rather than schema, and through the data paths they reach components already narrowed
by the server-side filter, so an unreachable resource never appears there as a facet bucket, a row or
a count. **But values also reach components through configuration, which no filter touches.** So
what remains in phase 1 is **any surface that names resource values from configuration rather than
from data**: a portal page listing resources from a source other than the filtered query, and
Arranger's `displayValues`, the next item. Everything else here is a prerequisite for field-level
restriction, and one part of it is large.

**The principle already exists and is scoped too narrowly.** [management-ui.md](management-ui.md)
states it: what a rendering implies "can leak while every value is correct", and "an affordance for
something unreachable" discloses, as does "an empty state that distinguishes nothing-here from
nothing-for-you". It governs the management package alone. Nothing applies it to search components,
to a portal's own pages, or to an API describing its own fields.

| Layer                     | Example                                     | Owner                | Designed |
| ------------------------- | ------------------------------------------- | -------------------- | -------- |
| Server query              | the aggregations query                      | the Arranger adapter | yes      |
| Component                 | table, facets, downloads, charts, matchbox  | Arranger Components  | no       |
| Page and fragment         | a clinical tab, an export section           | the portal           | no       |
| The API describing itself | GraphQL introspection, the extended mapping | Arranger server      | no       |

**The mechanism: the server shapes each component's configuration per principal.** It already
decides what configuration it sends, and it holds the decrypted token, so the token never leaves it.
A browser then receives a configuration, which says what to draw, rather than a capability set,
which says what is withheld.

**Omit rather than block, and this is the rule that matters.** Two modes look alike and are not:

| What the principal holds on it                 | What the server sends                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| something                                      | exactly that; counts without rows is correct for a principal holding only `count`        |
| nothing                                        | nothing: the resource is absent from the configuration, never present and marked blocked |
| nothing, requested explicitly by a direct link | a refusal indistinguishable from the resource not existing                               |

A blocked state is the affordance for the unreachable in the principle's own words: it tells the
principal the thing exists and that they lack it. So it is never sent, and the only refusal that
reaches a principal is the one they asked for directly, which must look like absence.

**Components need a mapping, not a vocabulary of their own.** A table renders from `view`, a total
from `count`, download from `export`, and a facet from both `count` and `view`, since each bucket's key is
a field value and each bucket carries a count; whether a field can be declared so that its facet needs `count`
alone is research, in [count-only principal](../docs/atlas/roadmap/count-only-principal.md). One capability vocabulary stays
one. Gating a panel behind a release flag is not access control and does not belong to Usher.

**A principal holding `count` alone gets a different page rather than a narrower one.** There are no
records to list, so there is no table: a headline count, narrowed by whatever facets they may use.
Choosing a bucket narrows the count, where for a principal who views records it narrows the table.

**So a configuration has to be able to say a component is not rendered for this principal**, and the
first integration's configuration has no way to say it, for the table or for any other component.
Omitting is the rule above, and this is where omission needs a mechanism. A design for it is wanted
within phase 1, for the case below.

**A catalogue a principal reaches nothing in renders nothing.** Where a principal holds no grant
reaching any record of a catalogue, no component renders for it, rather than every component
rendering empty for each resource in it. That is live in phase 1 wherever a catalogue's records all
carry categories a principal lacks, or where the default open grant is off, and the first
integration serves several catalogues.

**Knowing that a principal reaches nothing there has two halves, established on the enforcing
side.** One is free and one takes a query, and they split along the two axes a grant names.

**The resource half is already decided.** The adapter's configuration lists, per queryable type, the
resources configured for it, and an empty intersection with the resources the token names already
denies that type. So the association of resources with catalogues that Usher does not hold is held
by the adapter, and the same decision needs a second reader: it denies the query today and would also
omit the configuration. Configuration that lists a resource whose records are absent from the
catalogue makes the intersection non-empty and the page render empty, which is a stale-configuration
flaw and fails toward showing an empty page rather than hiding a populated one.

**Under the default it never fires.** Every resource carrying `open` is reached by everyone through
it, so the intersection is empty only where an instance removed `open` from a catalogue's resources
or turned the default off. Intersecting per resource and category pair does not help: a principal
holding `open` on a resource whose records in this catalogue are all `controlled` holds a pair and
reaches nothing. So the existence check is load-bearing rather than a fallback.

**The category half takes a query.** Whether any of a catalogue's records escape every category the
principal lacks is a fact about what was indexed, so only an existence check under the principal's
filter, never returned to them, answers it. That is the common path under the default, and it is
cheap as a search: no documents returned, stopping at the first match.

**Its cost is a data dependency configuration has never had.** Fetching configuration makes no call
to the search engine today, so the check adds a failure mode that has to be specified: render
nothing when the check cannot run, which fails closed and coincides with the outage an unreachable
index already causes, since the search itself cannot run either. It also runs once per catalogue on
every configuration fetch, and it inherits every property of the principal's filter, including the
defects recorded against it.

**Render nothing either way, and let the client tell the two apart.** "You reach nothing" is
permanent and "the check could not run" is retryable, and the check runs before the search, so an
index briefly unreachable for one and reachable for the other shows nothing to a principal who
reaches plenty. The first integration already publishes whether its engine is reachable, on an
unauthenticated readiness endpoint, so a configuration response can say which state it is in without
a second query and without disclosing anything: reachability is a property of the deployment rather
than of the principal.

**The rule is per catalogue and the mechanism per type.** A catalogue exposes more than one
queryable type, since saved sets are composed into every catalogue's schema beside its document
type. The document type should be what decides whether components render, since they render its records,
and that needs stating rather than assuming. A test asking whether every type in the catalogue is
denied would answer no whenever saved sets are reachable, whatever the document type says.

**What the first integration's configuration can express, established on the enforcing side.** Per
field, yes: table columns carry `show` and extended fields carry `isActive`. Per component, nothing.
The per-type `createState` switch looks like the answer and is not: it chooses between two GraphQL
types when the schema is built, once per catalogue and shared by every principal, so making it vary
per principal is the per-principal schema introspection already needs.

**And omission renders as emptiness, which is the disclosure the rule forbids.** A component whose
configuration is withheld falls back to an empty one, so a principal served no facet configuration
gets an empty facet panel and one served no table configuration gets a table with no columns. An
empty panel where one was expected says a panel was expected.

**So withholding at the server is necessary and not sufficient.** The component library needs a
contract for absence, distinct from emptiness, and a way to be told which page it is rendering. That
is a change to a published package with consumers beyond this integration rather than to a response
shape. A design that says only "omit the configuration" produces the disclosure it was written to
prevent, and it looks correct from the server side.

**Every gate a surface applies is presentation.** The server remains the enforcement boundary, and
each rendering decision needs its enforced counterpart, since a configuration can be edited by
whoever holds the browser.

**Established by Arranger from the code, and it separates what shaping can close from what it cannot.**

| Surface                                 | How it reaches a client                                                                                            | Closable by shaping per principal? |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `downloads`, `extended`                 | returned unconditionally by one configuration resolver                                                             | yes                                |
| `charts`, `facets`, `matchbox`, `table` | the same resolver, gated per type on a `createState` flag                                                          | yes                                |
| the extended mapping                    | the same resolver, as the full field list with display names and types                                             | yes                                |
| GraphQL introspection                   | **one schema per catalogue, built once at load and shared by every principal**, on unless a deployment disables it | **no**                             |

**The hook for the first three already exists.** Configuration is fetched through GraphQL on the same
endpoint and router as data, so it passes the point where the decrypted token sits. The resolver never
declares the context parameter, but GraphQL passes context to every resolver regardless: the principal
already arrives there and nothing reads it. So shaping is a signature change at the same moment the
data paths build their filter, with no new lifecycle. The cost is one small function per surface,
since each has its own shape, rather than one filter.

**Introspection is the part that is large.** Making a schema's field list depend on the principal
means building a schema per principal, and caching per principal, which is a different order of
change from shaping a response. Disabling introspection narrows discovery without closing it: a client
that already knows a field's name can query it and learn from the response shape whether it exists.
So the flag is a mitigation, and closing it is the prerequisite field-level restriction actually waits on.

**Omission has a cost to honest consumers, and the contract already answers it.** A narrowed field
list is indistinguishable from a catalogue that genuinely lacks the fields, which is the point for the
principal and a problem for any consumer that must know whether it is looking at the whole catalogue.
Arranger's published introspection response carries `meta.authFiltered`, documented as "whether a
server-side filter was active when the response was generated", currently hardcoded `false` and pinned
by a test. Made dynamic it says a narrowing happened without saying what was narrowed, which is
exactly the granularity omission needs, and nothing has to be added to the contract to say it.

**A separate disclosure surface, deliberately not folded in.** The SQON viewer renders the query a
principal holds, which ordinarily discloses only what they built. A SQON arriving from elsewhere, a
shared link, a bookmark or a saved set, can name fields the recipient holds nothing on, and no
configuration shaping reaches it, because the content is supplied rather than served.

**It also bears on a contradiction between two documents.** They give different reasons the token is
opaque:

| Document                                     | Stated reason                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| [security-workflow.md](security-workflow.md) | "even knowing the shape of the restriction may be information they should not have"  |
| [intro.md](../../docs/intro.md)              | audience isolation, and keeping grant contents out of logs, error reports and traces |

Under the first, telling a browser what its principal may do would violate the rule, and correct
rendering would be impossible by design. Under the second it is fine. Omission satisfies both, since
nothing about what is withheld is ever sent, so the rendering design does not have to wait on this.
The contradiction still stands and wants one answer: the first reason is already strained, because
the token never reaches the principal and the holder it guards against is the bridge.

**Arranger's side separates into three seam changes**, costed rather than scheduled: projection,
resolver identity, and metadata shaping. The third is independent of the other two and is what makes
them meaningful, since an unfiltered field list undermines field-level enforcement however well the
data paths prune.

**[HIGH] A catalogue that labels its resource field publishes every resource to every principal.**

**Empty by default, and the obvious configuration fills it.** `extendedFields[].displayValues` maps a
field's raw values to display labels, per catalogue. A deployment whose resource field holds
identifiers, and whose interface should show study names instead, fills it for exactly that field.

**Once filled it reaches every principal without passing a query.** It travels inside the extended
mapping the configuration resolver returns whole, and the components store it as received. Every key
in it is a resource, and a map written to label a field's values names all of them. So anyone who
loads the page receives the catalogue's resource list, including the resources they hold nothing on.

**That is the disclosure the rendering principle names.** [management-ui.md](management-ui.md) rules
that "three of seven studies" discloses that seven exist. A label map naming all seven discloses the
same without the count.

**The published REST introspection contract does not carry it.** Its field builder emits a field's
display name, whether it is an array, its type and its unit, and nothing else. The exposure is the
GraphQL configuration query and the components.

**Independent of the three seam changes, and small.** It needs neither projection, resolver identity
nor metadata shaping, so it should not wait on them. Either of two closes it:

| Remedy                 | What it takes                                                         |
| ---------------------- | --------------------------------------------------------------------- |
| A deployment rule      | no resource values in `displayValues` on a field access control reads |
| Shaping that one field | the resolver narrows the map to the resources the principal reaches   |

The rule costs nothing and holds only where every deployment knows it. Shaping is one of the small
per-surface functions the rendering item already anticipates, applied to a single field, and it is
the remedy that does not depend on a deployment reading a note.

**[RESOLVED] The bridge is said both to render predicates and to hold no schema knowledge.**
The bridge builds the predicate and the adapter supplies the field name for the catalogue being
queried, which is a parameter rather than stored schema knowledge. SQON is the wire format, so
applications whose enforcement is not SQON-shaped translate. Original finding:
`decisions.md` has the bridge rendering a resolved grant set as a union of positive predicates, and
also states that a leaf operator's field name is structurally required. `architecture.md` assigns any
knowledge of the application's data schema, field names included, to the adapter and
explicitly excludes it from the bridge. A component with no field names cannot emit a predicate that
requires one.

The per-catalogue resource field name sharpens this from a wording problem into a contract question. One
bridge serves an application, an application serves several catalogues, and the resource field name
differs between them, so it cannot be resolved once at bridge startup. Either the bridge
emits resource names and the adapter turns them into predicates, or the adapter supplies the field
name per query and the bridge composes with it. The second preserves both statements, since being
told a field name for one query is not holding schema knowledge, but it is a real interface decision
and neither document makes it.

**Recommendation: the adapter supplies the field name, the bridge builds the predicate.**

The deciding reason is where fail-open defects concentrate. Every enforcement defect this design has
recorded is a predicate-construction defect: denial expressed as a negation instead of
`matchNothing`, an empty `in` read as no constraint, a containment expression double-negating into
a test for any element rather than every element on a flat field, and a filter composing disjunctively on the aggregation path.
Not one of them is a compilation defect. If the bridge emits resource names and each adapter builds
its own predicate, that entire class of defect is reimplemented once per adapter, and drift between
applications is the problem the shared bridge exists to prevent.

Four supporting reasons:

- **It does not breach the constraint it appears to.** Being told a field name for one query is not
  holding schema knowledge. The bridge is never provisioned with an instance's schema and never has
  to be kept in sync with one, which is what that exclusion protects.
- **It trusts the adapter with strictly less.** The adapter is the enforcement point and must be
  trusted either way, but supplying one field name is a smaller surface than constructing the whole
  predicate. A wrong field name is also checkable at startup, alongside the mapping-shape check
  already required.
- **The conformance corpus tests one implementation instead of one per adapter.** What a predicate means
  are exactly what a corpus is for, and they stay in a single place to test.
- **Per-catalogue output is already required.** Catalogue-level denial means the answer differs by
  catalogue regardless, so the bridge must produce per-catalogue results either way. Given that, it
  costs nothing for those results to be predicates: the interface takes a map of catalogue to field
  name and returns a map of catalogue to enforcement.

The cost is one additional input on the bridge interface, and an adapter obligation to supply it
correctly.

**Scope: this governs the narrowing arm only.** The enforcement result is already a union of deny,
narrow and allow, and only narrow carries a predicate. Named future adapters do not all narrow:

| Application | Operation                                          | Predicate?                                           |
| ----------- | -------------------------------------------------- | ---------------------------------------------------- |
| Arranger    | Filter a search                                    | Yes, in the query language natively                  |
| SONG        | Filter a metadata listing                          | In principle, if the predicate stays backend-neutral |
| Score       | Authorize one object fetch by identifier           | No. Deny or allow only                               |
| Lectern     | Schema and dictionary service, no record filtering | No                                                   |

A service whose operation is fetching one object by identifier never narrows, so no predicate is
built under either option and the question does not arise. What such an adapter needs instead is a
query in Usher's own vocabulary, "does this principal hold a grant on category C of resource R", with
the adapter resolving its identifier to that pair first. That is a third interface shape and the adapter contract
should carry it deliberately rather than treating every application as a filtering one.

**What would change this, restated.** Not a backend that cannot narrow, but a backend that narrows in
a way the shared query language cannot express _neutrally_. The MVP predicate is a single positive
containment on a field, which is neutral: it compiles as readily to a relational filter as to a
search-engine one. So the recommendation holds today for every application that narrows.

**The post-MVP predicate is not neutral.** Record-level
narrowing is expressed as `not` of `not-in`, whose correctness depends on the field being mapped
`nested`, and on a flat field it silently degrades to an existential match in the permissive
direction. That is a search-engine mapping concept, not a property of the query language. The same
expression carried to an adapter over a different store would mean something different, and it would
differ permissively.

Two consequences. Record-level narrowing as currently specified is **specific to the search application
rather than a platform permission**, which no document says. And this is an argument _for_ central
construction rather than against it: where the meaning of a predicate depends on backend properties,
that reasoning belongs in one component that can vary or refuse on a declared permission, not
replicated across adapters whose authors each decide independently what the expression means.

Must be settled before the adapter contract is written, which has not started.

## Security model

**[RESOLVED] Symmetric key framing is incompatible with the stated algorithm candidates.**
Resolved twice, and the second answer reverses the first. Keys are per application, which is the part
that was always load-bearing, and they are **symmetric** after all: `dir` with A256GCM, held in the
secrets store and injected into both the controller and the application. The finding below was
correct that the candidates listed at the time were both asymmetric and that the framing did not
match them; it was wrong to conclude the framing had to change rather than the candidates. What
settled it was the deployment: secrets already reach both sides through the same operator, so
asymmetry solves a provisioning problem that does not exist here. See the JWE decision in
[decisions.md](decisions.md). Original finding:
`security-workflow.md` calls the JWE decryption key "a shared secret provisioned to each bridge
instance at deploy time." `security-threat-model.md` lists RSA-OAEP or ECDH-ES as algorithm
candidates for key wrap. Both are asymmetric: there is no shared secret. With RSA-OAEP, the
bridge generates a key pair; the controller encrypts the CEK with the bridge's public key; only
the bridge's private key can unwrap it. Provisioning is reversed: the bridge generates and the
controller receives, not the other way around. The algorithm selection (listed as unresolved in
the threat model) will determine the key management architecture. The current framing assumes a
symmetric answer and is misleading for either asymmetric candidate.

**[RESOLVED] Audience isolation may be a naming convention, not a cryptographic guarantee.**
Per-application keys make `aud` a cryptographic boundary rather than a claim-level assertion.
Original finding:
If all bridges share a single decryption key, any bridge can decrypt tokens intended for
any other bridge. The `aud` claim check would then be a claim-level assertion rather than a
cryptographic boundary: a compromised bridge can read another service's Usher tokens. True
cryptographic audience isolation requires distinct keys per audience (per bridge/app pairing),
with the controller encrypting to the intended recipient's specific key. Whether the design
intends one global key or per-audience keys should be stated explicitly, since the answer changes
the operational complexity and the blast radius of a compromised bridge.

**[HIGH] Adversarial delay within the grace period is distinct from adversarial blocking.**
The fail-secure design responds to blocking of the revocation channel: if events stop arriving,
the bridge enters revocation-uncertain mode after 60 seconds. A more targeted attack delays
(rather than drops) revocation events for a specific user, keeping the bridge's
last-successful-check timestamp just within the grace period indefinitely. The bridge never enters
revocation-uncertain mode; the revoked session is sustained. This is an adversarial delay pattern
and the current design does not address it. Possible mitigations include per-user revocation
confirmation rather than channel-wide liveness checks, or a narrower per-user TTL after a
revocation event is known to be in flight.

**[HIGH] GDPR right to erasure conflicts with the append-only audit log.**
The audit log is INSERT-only by design (application role has no UPDATE or DELETE) and contains
user-identifying fields (`actorId`, `target_user_id`). GDPR and similar regulations give
individuals the right to erasure of personal data. Mandatory minimum retention periods for audit
logs in health data contexts (PHIPA, HIPAA, GDPR) can conflict with this right. Neither the
conflict nor any resolution is acknowledged. Common approaches: pseudonymization at write time
(store a non-reversible principal identifier rather than the raw user ID, with a separate lookup
table that can be nulled on erasure); or a legal basis argument that audit logs for PHI access
constitute a lawful retention purpose that overrides erasure requests. This should be decided
before the audit schema is finalized.

**[MEDIUM] Controller instance failure produces a thundering-herd reconnection.**
Each controller instance maintains persistent SSE/WebSocket connections to its bridge subscribers.
If an instance goes down, all its connected bridges simultaneously lose their push connections
and attempt to reconnect to surviving instances within the 60-second grace period. Surviving
instances may not be able to absorb the connection spike in time. This is both a denial-of-service
vector (kill one instance, cause 503 on all its bridges) and a capacity planning question (how
many concurrent bridge connections must surviving instances handle in a worst-case failover?).
High-availability design for the controller is listed as not yet designed; this failure mode
should be a named requirement for that design.

**[MEDIUM] Migration tooling DDL access undermines the INSERT-only audit constraint.**
Schema migrations require elevated database privileges (ALTER TABLE, DROP COLUMN). If migration
tooling runs with credentials that include the audit table, the INSERT-only constraint is
vacuously satisfied at the application layer while being bypassed at the migration layer. The
security boundary between migration-time database access and runtime application access should
be described: separate database roles, separate credential paths, and a policy for what migration
scripts are permitted to do with the audit table.

---

## Permissions and roles

**[INFO] Overlapping cohort access is moot where records cannot overlap, and open otherwise.**
An instance whose data model gives each record exactly one resource makes overlap structurally
impossible, so neither the any rule nor the all rule produces a different result there. That holds for the
first integration; the per-instance confirmation is recorded on that side. The question stays
open for instances where a record can satisfy the resource predicates of more than one resource
at once. Do not close this item until such an instance requires a concrete decision.

**[MEDIUM] Custodian scope: one category vs. one or more, inconsistent across documents.**
`permissions-model.md` role table says "Custodian: one category across all resources."
`admin-model.md` role table and `concepts.md` both say "one or more categories."
The cardinality of custodianship scope affects the data model (is custodianship.hold a single
foreign key or a join table?), the management UI, and how OCAP delegation is expressed. This is
not phrasing variation; it is an unresolved design choice presented as resolved in different ways
in different documents.

**The storage half of this is largely answered by the grant table, which nobody has connected.**
`custodianship.hold` is written throughout as a permission needing a home, and the open question asks
whether it is one column, one join table, or two. Under the settled model it is none of those: a
custodian is someone holding a grant whose role is `custodian`, on one category, with the wildcard in
the resource position. Cardinality then needs no decision, because one grant per category is the
ordinary shape and a custodian of three categories holds three grants. Naming it as a separate
permission is the same collapse this model keeps finding, a second place asserting what a grant
already says.

What genuinely remains is narrower than the question as posed: how a grant stores the wildcard in
`resource_id`, and whether an instance may bound a custodian to named resources, which is the
scope axis below rather than a storage one.

**A second axis, surfaced by the rename pass: resource scope.** The same role is described both as
spanning every resource and as bounded to a subset. `permissions-model.md` and `admin-model.md` say
"across all resources"; `security-threat-model.md` says a custodian "can only act on grants for
their assigned category within their authorized resources"; `audit-events.md` records the role as
assigned "for a category within a resource". The two readings differ in blast radius: authority that
follows a category wherever it appears, against that category granted on named resources. This
question and the cardinality one above together decide whether custodianship.hold is one column,
one join table, or two.

**[RESOLVED, half of it] `admin-model.md` header claimed to fully specify Custodian; the body does
not.** The claim is corrected: the overview now says the document specifies Admin and Owner and names
Custodian as a gap. The gap itself stands, and is the substantive half: Custodian has one row in the
role taxonomy and no permission list, while being the role with the most governance weight and the
one OCAP delegation rests on. It cannot be closed independently of custodian scoping above, since
what a custodian may do and what it reaches are the same question asked twice.

---

## Ownership and custodianship

**[HIGH] Self-grant prevention is not specified in the permissions model.**
**Still open, and the grant-gating decision makes it sharper rather than answering it.** An
administrator may self-grant, with the custodians of the data's categories as the final gate. An
administrator who may appoint custodians can appoint themselves and then satisfy that gate, so the
rule below and the gating decision have to be reconciled: either appointment is constrained, or
grant must reject an approver who is also the grantee, or both. The audit event on appointment is
the minimum and is not by itself a control.

The threat model (A01, insider threat note) states that a custodian cannot issue a grant to
themselves. This rule is not specified in `permissions-model.md` or `admin-model.md`. Without an
explicit check at the PAP layer, a custodian could approve their own category access, bypassing the
intended governance separation. The check must be specified before the granting endpoint is
implemented: the approving custodian's identity must be compared against the grantee identity, and
self-grant must be rejected. The audit log alone (detecting after the fact) is not a sufficient
control.

**[MEDIUM] Resource visibility suppression and embargo share implementation concerns.**
The ownership invariant breach state (resource hidden due to no owner) and the embargo mechanism
(resource hidden until a scheduled date) both suppress resource visibility without changing user
grants. They are distinct governance reasons for the same technical effect. The implementation
must not conflate them: a resource in the orphan-hidden state should not be treated as embargoed,
and lifting the embargo should not restore a resource that is still ownerless. Whether these share
a single `visibility` state field with typed reasons, or are separate flags, needs a deliberate
decision before the data model is finalized.

**[MEDIUM] Guardian-to-principal ownership transfer on age of majority is not designed.**
When data is submitted for a minor principal, the legal guardian holds ownership over that
resource. When the principal reaches the age of majority, their right to govern their own data
supersedes the guardian's authority. No flow exists for transferring ownership in this case.

Several design questions are open:

- **Trigger:** Is the transfer initiated by the guardian, by the now-adult principal, or by a
  platform admin acting on a legal notification? A time-based automatic trigger requires Usher
  to know the principal's date of birth, which it probably should not store.
- **Principal identity:** At submission time the principal has no Usher presence. When they reach
  adulthood and want to claim their data, they must establish an IdP identity and link it to the
  correct resource. The linkage mechanism is not designed.
- **Guardian refusal:** If the guardian does not initiate a transfer and the principal is now of
  age, what recourse does the principal have? This is a legal question, but the platform must have
  an admin-mediated path to honour a valid legal claim.
- **Jurisdiction:** Age of majority varies by jurisdiction. The platform must either take a
  conservative stance (lowest applicable age) or make this an instance configuration.
- **OCAP intersection:** If the principal is a First Nations member, community data sovereignty
  interests (held by the nation, not the individual) may coexist with the individual's newly
  acquired personal data rights. These do not automatically resolve in the same direction.

This flow shares the same ownership transfer mechanism as ordinary ownership handoffs but has
unique trigger and identity-establishment steps. It should be designed before Usher handles
any paediatric data.

**[RESOLVED BY SCOPE] Clinical submission service to Usher relationship is not designed.**
Nothing creates a resource at submission time in the first release, so the trust and privilege
question for the Lyric service account cannot arise yet. Pre-registration is what ships, and the
detail below is the design for when submission-time creation is picked up. See blocker 5 in
[../docs/phase-1.md](../docs/phase-1.md). Original finding:
The category management section of `permissions-model.md` describes cohort-level category
assignment defaults applied at submission time, but does not specify how the submission service
(Lyric) communicates cohort existence and category assignments to Usher. Two approaches: (1)
pre-registration, where an admin creates the resource in Usher before any data is submitted and
submission is rejected for unregistered cohorts; (2) submission-time creation, where Lyric creates
the Usher resource as part of the ingest flow. Both have different trust and privilege implications
for the Lyric service account. The preferred approach for MVP is pre-registration; submission-time
creation is an optional post-MVP path sharing the same code foundation. Neither is designed in
detail. This must be resolved before the Lyric integration work begins.

## Integration and operations

**[MEDIUM] Audit log noise from vulnerability scanners and automated probes needs a tagging mechanism.**
Automated vulnerability scanners and pentesting tools will hammer Usher's auth endpoints with
probing requests, flooding the audit log with failed-auth events that are not genuine incidents.
Without a mitigation, real anomalies are buried in scanner noise, defeating the monitoring
purpose of the log.

The correct approach is tag-and-route, not suppression. Suppressing scanner traffic entirely
undermines OWASP A09 and creates an exploitable blind spot: an attacker added to the ignorelist
hides all their activity. The design should:

- Maintain a configurable source list (IP ranges, API key prefixes, user agent patterns) marking
  known scanner or pentesting traffic.
- Tag matching requests in the log record (e.g. `source_type: "scanner"`) rather than dropping
  them.
- Route tagged events to a separate log stream or lower severity tier so they do not trigger
  real-time alerts.
- Treat the source list itself as a policy change: additions and removals must be logged as
  auditable events and require admin authorization.

This was identified from a real incident: a WordPress application's firewall began generating
high-volume automated probes that spammed its security monitoring with false positives. Building
log-noise management in from the start avoids retrofitting it later.

Must be decided before the audit logging implementation begins: the tagging field and routing
logic affect the event schema and the log aggregation pipeline configuration.

**[POST-V1] GA4GH Passport revocation before Visa expiry has no mechanism.**
GA4GH Passport integration is not required for iMS v1, which the business requirements state
directly, so this is not a launch dependency. Kept because it is a real gap in that design and the
severity was misleading in a blocker sweep. Original finding:
When a DAC withdraws grant, the corresponding `ControlledAccessGrants` Visa stops being
issued on re-authentication. The existing category grant record in Usher's policy database
persists until `expires_at`. There is no described mechanism for Usher to detect externally-revoked
Visas proactively. For controlled health data where an access withdrawal must take effect
promptly, a Visa expiry window (potentially days) may not satisfy governance requirements.
Options to consider: periodic re-validation of Visa-sourced grants on token exchange; a webhook
from the Visa Issuer on revocation; or an explicit operator-triggered revocation via the
management API when informed of a DAC withdrawal.

**[MEDIUM] No "revoke user everywhere" API despite it being the primary emergency operation.**
`security-workflow.md` describes "single user" as the standard revocation scope. `admin-model.md`
describes a global `GET /admin/users` endpoint as explicitly not implemented; lookup is scoped
to resources. An admin performing emergency revocation for a user who holds grants in many
resources (or whose roles are unknown) must iterate across all resources to find
and revoke each one. The most critical emergency operation has no direct API path. A
`POST /admin/users/{id}/revoke` endpoint that sets `revoked_at` regardless of which resources they hold grants in
should be considered as a v1 requirement.

**A mechanism is now proposed, and it is not an endpoint that iterates.** A status on the principal
that grant validation reads, so that freezing someone is one write rather than a sweep across every
grant they hold:

| Status      | What grant validation does                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `active`    | grants resolve normally                                                                                         |
| `suspended` | grants resolve to nothing, and the grants themselves are untouched                                              |
| `blocked`   | as suspended, and any attempt to grant this principal access warns the author and notifies someone for approval |

**Why a status rather than a bulk revoke.** Setting `revoked_at` across every grant destroys what
was held, so restoring access means reconstructing it from an audit trail. A status leaves the grants
intact and gates them, which makes the operation reversible and makes "what did they hold while
frozen" answerable. It also gives the emergency operation one row to write, which is what makes it
fast enough to be an emergency operation.

**What it still needs.** Who may set it, whether `blocked` differs from `suspended` by more than the
warning, who receives the approval notice, and how it interacts with the cached payload, which must
be deleted on any status change for the freeze to take effect inside one TTL rather than at the end
of one.

**[POST-V1] Trusted-issuers governance for GA4GH Passports is not described.**
Same scope as the Visa revocation item above. Original finding:
Adding a new Visa Issuer (a new collaborating DAC) requires updating Keycloak's
trusted-issuers list. A malicious or compromised issuer could grant controlled access to all
data on the platform. The governance workflow for this operation (who approves it, what audit
record it creates, whether it requires two-admin sign-off) is not described anywhere. For a
platform managing PHI, this is a high-impact administrative action and should be treated with the
same care as a global admin grant.

**[MEDIUM] Cross-system audit correlation for admin self-grant data access is not addressed.**
`admin-model.md` logs self-grant creation and revocation as discrete audit events. A PHI breach
investigation requires answering: during admin X's self-grant window, what records did they
query? Grant events are in the controller's audit log. Data access events (if logged at all) are
in the PEP adapter's log (Arranger, Lyric). Correlating these across systems requires a shared
identifier (a self-grant ID, or a correlation token) that links the grant audit record to
downstream data access records. Neither the identifier nor the correlation mechanism is described.

**[RESOLVED] Bridge audience identifier provisioning is not described.**
Per-application keys settle both halves. Provisioning is one symmetric key per
controller-and-application pair, written to the secrets store and delivered to both pods. And two
independently deployed instances cannot share an audience identifier, because sharing one would mean
sharing a key and audience separation is cryptographic rather than a string comparison. What follows
is a naming requirement rather than an open question: an audience identifier is per deployed
instance. Original finding:
Every bridge must know which `aud` value to request from the controller and to verify in
the returned token. Where does a bridge learn its own audience identifier: deploy-time config?
A registration handshake with the controller? If two independently deployed Arranger instances
both use `aud: "arranger"`, they share tokens and revocation events. If audience identifiers are
instance-specific, the naming convention and provisioning model should be documented as part of
the bridge requirements.

**[LOW] Valkey failure mode is not described.**
`architecture.md` documents Valkey's two roles (shared cache and revocation pub/sub backbone)
but does not describe failure behaviour. If Valkey is unavailable: controller instances cannot
coordinate push revocation events; the fast-path cache is inaccessible (falls back to full
policy recompute). Is the system in a degraded-but-safe mode (poll-only revocation, slower
propagation, higher controller load)? Or does Valkey unavailability trigger fail-secure across
all bridges? The failure mode should be a named design choice, not an implicit consequence of
implementation.
