# Permissions Model

_Status: in progress. The core model, visibility rule, grant composition, field-level restriction
options, OCAP considerations, and private data sharing patterns are documented. Resolved design
decisions are in their own section. Open questions are at the end._

This document defines what Usher tracks and how it uses that data to answer "what can this user
see?" It does not cover how those decisions are administered (see [admin-model.md](admin-model.md))
or how the token system works end to end (see [security-workflow.md](security-workflow.md)). The
OWASP threat model is in [security-threat-model.md](security-threat-model.md).

> **Scope is not decided here.** What the first release contains is set by the iMS UAC user flows and
> mapped persona by persona in [uac-flows-traceability.md](../docs/uac-flows-traceability.md), with
> [phase-1.md](../docs/phase-1.md) for what is deferred. This document says how the model works, not
> what ships. A mechanism that is coherent here and absent there is out of scope, and that has
> happened: the model was once rebuilt around user groups, which appear in neither the flows nor the
> requirements. Check the persona status table before adding or removing a mechanism.

---

## Design approach

### Model-agnostic language

The permissions model uses generic terms: `resource`, `role`, `category`. Domain-specific
names (`study`, `patient`, `cohort`, `dataset`) appear only in the management UI layer,
configurable per instance, and in worked examples in this document.

In the Overture context, a resource is a **cohort**: a virtual collection of records defined by
shared characteristics, not a siloed container. Unlike studies (where a record belongs to exactly
one study), cohorts can overlap: a record can belong to multiple cohorts simultaneously. In another
instance the same concept might be called a dataset, a project, or a patient cohort. The
underlying model is the same.

How access behaves across overlapping cohorts is an open design question; see Open questions.

### Hybrid role and attribute model

Usher combines role-based and attribute-based access control rather than relying on either alone.

**This pattern has a name in the literature: RABAC, role-centric attribute-based access control**
([Jin, Sandhu and Krishnan, MMM-ACNS 2012](https://www.profsandhu.com/confrnc/misconf/mmm-acns12-rabac-paper.pdf)).
RABAC extends RBAC with a permission filtering policy and evaluates access in two stages: first the
role check, deciding whether the user holds a role carrying the permission at all, then the
attribute check, deciding whether user, object and session attributes permit exercising it on this
particular object. Access requires both to pass. Usher's category machinery is the second stage and
is well developed; the first stage, the assignment of permissions to roles, is not yet defined. See
[RABAC alignment](../docs/atlas/roadmap/rabac-alignment.md) for the gap and the planned correction.

**Roles** capture coarse-grained permission: what kind of actions a user can perform (`owner`,
`viewer`). A role is a label for a class of behaviours.

**Attributes** capture contextual scope: which specific resources those actions apply to, and under
what category restrictions.

This combination avoids two failure modes:

- **Pure RBAC:** roles proliferate as rules become contextual. A platform with two roles and three
  categories across five resources could require dozens of role combinations
  (`study-A-indigenous-member`, `study-A-non-indigenous-member`, etc.) to express the full
  policy space.
- **Pure ABAC:** without role abstraction as a simplifying layer, policy rules become difficult to
  manage and audit.

Two users can hold the same role in the same resource and have meaningfully different access,
depending on their category grants. The role describes permission; the grant describes scope.

---

## Core concepts

### Resources

A resource is a collection of records, defined by an identifier they share. Resources are defined
through the management UI by
administrators. In Overture instances, a resource is typically a cohort; in other instances it
might be a dataset, a project, or any other logical unit defined by the instance.

Resources have categories assigned to them, and every live resource carries at least one: see
the category invariant under the entity schema below. A resource whose only category is its
unrestricted portion is fully reachable by everyone holding the open grant.

### How a role reaches a person

A `grants` row records that a holder acts in a role, on one category of one resource. The role is
what acts are possible; the category is which records they reach. Neither half means anything alone:
a role names capabilities with nothing to apply them to, and a category names records with no acts
permitted on them.

**Being trusted as a curator is a decision about a resource and a category, not a property of a
person.** Nothing states separately what someone is trusted with, so the same person can be a curator
on one category and a viewer on another within one resource, and hold nothing at all in the next.

A person can hold several grants on one resource. Roles are coarse permission labels, not a strict
hierarchy; overlap is expected and valid. What they can do on a given category is the union of the
permissions of every role granted to them there.

**The permissions computation engine must consult every role**, not the first or the highest-priority
one, and roles do not combine as roles. Each expands to capabilities first, and the capabilities are
unioned.

### Categories

> **Note:** categories are independent, overlapping axes, and a grant set renders as one clause per
> held category rather than as a single clause naming the resource. See "The visibility rule" below
> for what that reaches and for the one part of it still deferred.

A category is a collection of data, defined by properties it carries. On the record axis it selects
records, and on the field axis it selects parts of a record; which axis a category is scoping is
said by the grant rather than by the category. Records can be categorized and grouped as resources:
the two are the same construct, separated by what makes a record belong. Examples:
`indigenous_data`, `controlled_access`, `restricted_clinical`.

Usher names the categories for its own instance and holds nothing else about them. Which properties
define one, and so which records fall inside it, is settled per schema, because a property only means
something inside one schema.

**A category either partitions the data or overlays it, and only the first decides what the residual
covers.** A partitioning category carves up the record set, and `open` is what the partitioning ones
leave; an overlay selects within that set, so a record can carry an overlay and still be open. The
same holds one level down, where `basic` is what the partitioning field categories leave. Which one a
category is lives in the adapter's mapping rather than here, for the reason nothing else about a
category's meaning lives here: Usher can neither know nor verify what it selects. See the
partitioning-against-overlay decision in [decisions.md](decisions.md), which also records why getting
it wrong fails silently in one direction and loudly in the other.

Categories are independent axes: holding a grant for one category does not imply holding a grant
for another, even within the same resource. What a category name means in terms of actual records
or fields is instance configuration that lives in the enforcement adapter, not in Usher.

### Category grants

A category grant is an explicit record: this person may reach the data carrying this category within
this resource, meaning its records, or its fields where the grant names a field category. A role sets the ceiling, meaning the acts it permits on that resource's records; a
grant names which categories they apply to. A ceiling with no grant under it reaches nothing, which is
what deny by default means here: the absence of a grant is a denial.

**A grant is made by one person and answered by another**, which is why the decision is recorded
separately from the grant. An owner shares a dataset and the recipient accepts or declines it, so a
person's effective access is the union of the grants they hold and have accepted, each narrowed to
what its own role confers at the moment the token is issued.

Grants have two origins:

- **Internal:** created by an administrator through the management UI. Usher owns the full
  lifecycle.
- **External:** originated from a GA4GH Passport `ControlledAccessGrants` Visa, validated by
  Keycloak and mapped to a category grant automatically. Usher inherits the Visa's `expires`
  timestamp as `expires_at`. See [concepts.md](../../docs/concepts.md) for the full GA4GH Passport
  flow.

Local administrators can revoke an externally-originated grant. Local policy can always restrict
access downward; it cannot grant access that no Visa covers. The `granted_by` column records the
origin (internal admin ID or external Visa issuer identifier) for auditability.

**Grant expiry.** The `expires_at` field supports time-limited grants. The controller resolves
expiry when it computes a permissions payload, so a lapsed grant is absent from the next token rather
than revoked, and the token is issued to expire with the first grant on it to lapse, so it stops
being honoured at the moment that grant does. No revocation event is emitted and nothing
watches for expiring grants: the deadline is known when the token is issued, so the token is issued
already knowing when to die. See [decisions.md](decisions.md) § A grant's expiry is resolved before
the token is written.

### A grant's period, its revocation, and the answer to it

A grant carries an **activity period** and a **revocation**. What its recipient answered is not on
it: that is a row in `grant_decisions`. The period says _when_; the other two say _what someone did_.
None is derivable from the others, and that is the point.

|                        |                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `granted_at`           | when the grant was made. Always set                                                                       |
| `expires_at`           | when it lapses. Absent unless an expiry was set. Expiry is read from it rather than stored as a state     |
| `revoked_at`           | when someone revoked it. Absent otherwise                                                                 |
| the recipient's answer | a row in `grant_decisions`, appended. The current answer is the latest row for that person and that grant |

**Why none of this is a calculation over the dates.** A grant nobody has answered and one that was
accepted carry identical dates, and only the decision separates them. A refusal is implied by no
timestamp at all, and nothing else in the model records one. And a revoked grant and an expired one
have both ended, with the dates unable to say which.

**Acts are stored; time is read.** A person accepts or declines, an administrator revokes, and each
is someone acting, which is what makes it worth storing. Expiry is what time did, and time writes
nothing: it is read from `expires_at`, which is also why nothing has to watch the clock. See
[decisions.md](decisions.md) § A grant's expiry is resolved before the token is written.

**Why the answer is not a column here.** It would put a lifecycle the granter controls and a history
the recipient writes in one row, and it would fail in the wrong direction: a single nullable state
column, read by a path that forgets to check it, treats an unanswered grant as live.

**A grant begins when it is made, and a deferred start is not expressible.** `granted_at` records
both facts because they coincide: there is no start column, so a grant assigned today cannot be set
to begin next month. That is a real limitation rather than an oversight, and adding it later is one
nullable column with null correct for every existing row. Anything wanting it today is reaching for
the withholding layer, which is embargo and is designed separately.

**Who granted it stays on the grant** rather than moving to the audit log, because it decides who may
revoke it: a grant originating in an external Visa is not an administrator's to withdraw.

### A grant has two faces, and who may read the second is itself an access decision

> **Status: settled in discussion, with no mechanism designed.**

    what it permits      principal, resource, category, permissions,
                         and whether it is live right now
                         read on every request, by the enforcement path

    how it came to be    who granted it, when, on whose authority, which
                         approval it records, which invitation it came from
                         read when someone governs, not when someone queries

The Usher token already respects this split without anyone having decided it: it carries resource,
category and permissions, and nothing about who granted them. Enforcement has never needed the
second half.

**The second half is a different kind of sensitive.** It is a map of the governance structure: who
custodies which category, which representative authorized which researcher, which addresses were
invited. An owner scoped to one resource needs none of it. So **who may read how a grant came to be
is an access decision the model does not currently make**, and there is nothing to enforce it with
until custodian scoping exists.

### User groups

Groups exist to make administration tractable at scale: granting access to a research team should
be one operation, not one per team member. In instances using GA4GH Passports, a Keycloak group
membership can be mapped to an Usher group automatically, allowing institutional group affiliations
to propagate without manual management.

**Not in the first release, and that is a scope decision rather than a design gap.** Every role
assignment and every share in the user flows names an individual by email, a steward's dashboard
lists the people who hold access to a dataset, and the phase 1 assessment puts user groups alongside
field-level restrictions and multi-tenancy as things that can be stubs in the schema. Nothing in the
requirements or the flows asks for a group.

**The design runs ahead of the scope deliberately, and what follows is settled rather than sketched.**

**A group is a named set of people and confers nothing by belonging to it.** It holds no role of its
own. What it does is let one grant name a set instead of one person, so `grants` takes a group holder
exactly where it takes a user holder, and the same set can be granted curator on one category and
viewer on another. A group carrying its own role could not express that, which is why it does not
carry one.

**Enabling groups costs no schema change.** The holder column already accepts them and the first
release simply writes no group-held rows. That is the whole of the deferral: a policy that grants
name individuals, not a structure that cannot hold anything else.

**A group grant does not bypass acceptance.** It produces one decision row per person the grant
reaches, and they answer independently: one accepting and another declining the same grant is an
ordinary outcome, and the grant is unchanged by either. This is what makes acceptance belong to the
person rather than to the grant, and it is why `grant_decisions` needs no change to serve both
holders. A group cannot take on an obligation; what a member accepts is what it confers on them.

**One thing is genuinely open and it is governance rather than structure**: who may create a group
and who may add or remove a member. Membership would confer access, so an unowned membership
operation is an unowned granting operation. That question does not need answering to keep the shape
above, and it does need answering before groups ship.

---

## The capability vocabulary

A capability is one entity paired with one action, written `entity.action` and displayed as the
action alone. The pair is composed rather than stored, so a name that does not parse cannot exist.

**The entity decides the plane, not the action.** `record.create` is data plane because a record is
data; `resource.create` is control plane because a resource is a row in Usher's own store. Both are
"create". This is the same shape as a curator and an owner both carrying four acts on different
objects, one level down, and it is why `plane` sits on `entities` rather than on each capability:
storing it per capability would let two capabilities of one entity disagree.

**Every entity sits wholly in one plane.** The case that tests this hardest is the artifact, below.

### Data plane

Four entities, and nothing Usher holds is among them: all belong to the ushered application.

**The first release builds `record` and `artifact`.** `field` and `revision` arrive by migration, and the
reasoning for what ships now against what waits is in [phase-1.md](../docs/phase-1.md): a column
added later is a migration, while a wire format changed later is a negotiated payload version and a
coordinated deploy, so the token nests by entity from the start and the schema does not carry
columns nothing uses yet.

| Entity     | Actions                                                 | What it is                                                                                                                                                        |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record`   | `count`, `view`, `export`, `create`, `update`, `delete` | one row of data in a resource, in its current state. Listed in order of increasing reach, which is the order the seeded roles add them in                         |
| `field`    | `count`, `view`, `export`, `update`                     | one part of a record. No `create` or `delete`: a field exists per schema rather than per grant. The three members of `read` are separate for a reason given below |
| `revision` | `view`, `export`                                        | a prior state of a record, where the service keeps them. A submission service does; a search index does not                                                       |
| `artifact` | `create`, `view`, `update`, `delete`, `export`          | a collection of records someone assembled and kept, carrying provenance naming the resources it drew on. A saved set in Arranger is one                           |

**`read` is a capability group rather than a capability.** It names an entity's read-shaped
capabilities together: `count`, `view` and `export` on a record or a field, `view` and `export` on a
revision or an artifact, and `view` alone on a control-plane entity. Someone writing a role may name
`read` and get all of them, or name them one by one.

**It separates the two meanings one word had.** `read` was both the R in create, read, update and
delete and the act of seeing a record, which is why four acts in the prose met six capabilities in
the matrix. As a group it is only the first, and `view` is only the second.

**A group is expanded when a role is written, and nothing stores it.** Naming `read` writes its
members into `role_permissions`, so no capability is named `read`, no token carries it and no adapter
tests for it, the same as a role name. Expanded at issuance instead, a group that gained a member
would widen every role naming it, on every grant at once, with no act anyone performed. Expanded at
writing, a new member reaches a role only when someone adds it under `role.define`.

**A capability group is not a group of principals.** A `group` in this model is a set of people a
grant can name; a capability group is a set of capabilities a role can name. The two never meet,
since a grant names a role and a role names capabilities.

**Prior art.** Cedar has the same device as action groups: an action is classified as a member of a
collection, and a policy naming the collection covers its members ([Cedar
terminology](https://docs.cedarpolicy.com/overview/terminology.html)). AWS IAM keeps List apart from
Read in its access levels ([IAM access
levels](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_understand-policy-summary-access-level-summaries.html)),
which is the distinction between `count` and `view`, and a group keeps it: the members stay
separately grantable.

**`export` rather than `download`, and it is not a copy control.** Bulk egress is a different act
from reading one record on a screen, with a different risk profile, and it warrants its own event
and its own approval. It does not prevent anyone copying what they can already read, and this design
says so elsewhere in as many words. `download` is the word a portal's button may use, which is what
`display_name` is for.

**`count` is contributing to a count without being individually viewable, and it counts only.** It
is the discovery-versus-access split. It carries a re-identification risk on small cells, which
needs a minimum cell size at the adapter rather than here. Serving it needs the enforcement seam to
tell the aggregation path from the record path, which the first integration's does not yet, so until
it does a grant of `count` without `view` is denied everywhere.

**Aggregation is the operation rather than a capability, and what an aggregation returns decides the
capability it needs.** So nothing named `aggregate` is ever granted, and a role meant for counts is
refused the extremes of a sensitive numeric field rather than handed them.

| What comes back                                             | Needs         |
| ----------------------------------------------------------- | ------------- |
| a number of records, or of distinct values                  | `count`       |
| a number of records per boundary the principal supplied     | `count`       |
| a value, such as a bucket's key                             | `view`        |
| buckets placed where the data lies, as a histogram's are    | `view`        |
| a statistic derived from values: `min`, `max`, `avg`, `sum` | `view`        |
| records, as `top_hits` returns                              | `record.view` |

**The line runs through the result, not between aggregations.** One aggregation can return both
kinds: a bucket carries its key, a field value, beside its count, and one statistics object carries a count beside a
minimum. So enforcement checks what a request selects, not which aggregation it names, which is
recorded against the seam in [adapter-integration.md](adapter-integration.md).

**The rule behind the table: a count is safe when the principal already knew the boundaries.**
Ranges the principal supplied disclose only how many records fell in each. Buckets the engine chose disclose
where the data lies, since the choice is the data. `avg` and `sum` sit with the values because over
one record they are the value.

**That holds for one response and not for a series.** Ranges one unit wide rebuild a histogram, so
counting by a field's values, through ranges or through a filter, is a route to the values
themselves. Whether a principal holding `count` may do it on a given field is the question below.

**One consequence: a principal holding `count` alone sees totals and no facets**, since a
facet lists its buckets and each bucket's key is a value. Whether an instance may declare a field so that a
principal holding `count` may use it as a facet and count by its values is research, in
[count-only principal](../docs/atlas/roadmap/count-only-principal.md).

**`artifact.update` is designed against a mutability the first integration does not have, and that is
deliberate.** The search application's saved sets are immutable: creation is the only write path, so
the provenance check that fires at save time fires on every version of a set there is. Verified on
that side rather than assumed here, after this design had recorded the opposite.

**The reasoning still holds, and it is a precondition rather than a defect.** Provenance is stored at
creation and the check runs at the only moment both the set's sources and the configured list are in
hand. The moment a set can be added to, that moment happens more than once, and a set created clean
and later extended from an unconfigured resource never meets the check again. So **the provenance
check belongs on every write to an artifact**, and the full sets feature on the roadmap is exactly the
work that would introduce the second write path.

**Recorded as a constraint on that work rather than as a live gap**, because a live gap gets checked,
found absent, and dropped, and the constraint disappears with it. `artifact.update` exists in the
vocabulary so that the obligation has somewhere to attach when the capability becomes reachable.

**`artifact.export` is the artifact leaving, not its records.** Taking a set object away as JSON, or
a collection of them, hands over record identifiers and the provenance naming the resources they came
from, without reading a single record. The per-read check still decides which artifacts a person can
reach at all, so nothing leaks that could not be reached, but volume does the same work here as it
does for records: browsing one set and exporting every set a person holds differ in kind.

**Why `read` splits by volume and `create` does not, which is provisional rather than principled.**
`export` exists because one enforcement point, a search service, serves both browsing and bulk
download and has to tell them apart. No such point exists for creation, because nothing creates
records in the first release. It is not that writing matters less or falls outside what this design
governs: Usher decides who may create and delete records in a submission service, so any claim that
it controls only disclosure is false. When a submission surface offers both a bulk path and a
single-record path and an instance wants to permit one, the same test admits a bulk-create
capability. It waits on that surface existing rather than on a principle.

**No `record.exists`.** A Beacon-style boolean is a count thresholded at zero, so `count` covers
it. What separates a boolean from a count is how much each leaks, and that is a minimum cell size at
the adapter rather than a second capability the adapter would enforce identically.

**Three actions that look separate and are not.** Archiving, publishing and suppressing all set a
value on a record that continues to exist, so each is `update`. Filing archive under `delete` would
tell an auditor that someone can delete when they can only file, which overstates in the dangerous
direction. Searching is `view`, and searching without seeing is `count`.

**Uploading and form entry are not separate capabilities.** They land at different services, so the
audience already separates them: the token issued to one is not the token issued to the other. A
split would say the same thing a second way, and the second way is the one that drifts. If a single
service ever offers both and an instance wants only one, that service declares its own capability,
which costs a row.

**There is deliberately no `artifact.share`, and that is load-bearing.** Handing someone an artifact
confers nothing, because every read of one is checked against that reader's own grants: an artifact
survives exactly when it requires none of what the reader lacks. Had widening been a capability, a
data-plane entity would confer reach and "granting is the control plane" would be false. The
authorization moved to the read, which is what let the capability disappear.

**`field` is an entity, and the argument that kept it out was wrong three times.** Each of `artifact`,
`revision` and `field` was first rejected here on the grounds that holding its capability without
`record.view` means nothing. That test is invalid: capabilities are independent of one another, and
roles are what prevent nonsense pairings. The valid test is whether the thing is separately
addressable and carries actions the other entities do not, and a field passes both: you read its
value and you never delete one, because deletion takes the record.

**A restricted column's facet closes through `view`, since each bucket's key is a value.** A column
excluded from a result is still countable: excluding it from `_source` removes it from hits and
leaves a terms aggregation over it untouched, and a search service builds facets from aggregations.
Under the rule above, a column withheld at `field.view` has its bucket keys withheld too, with no
second capability to remember. What `field.count` separate from `field.view` expresses is the two
partial pairings: a column a principal sees and gets no bucket counts for, holding `view` without `count`, and
one they may count records by without seeing its values, holding `count` without `view`.

**Why a field's `read` is three capabilities and not one, and the reason is legibility rather than
risk.** Folding `export` and `count` into `field.view` would make partial implementation
unsayable. A service that prunes columns from records and not from exports, or not from facets, would
hold grants that read as restrictions the export path never applies, and nothing in the vocabulary
could state that. Separate, the same situation is a fact a deployment can declare and a reconciliation
check can compare. **A capability whose absence restricts needs partial implementation to be legible,
and the vocabulary is the only place that legibility can live.** That is a corollary of the
unimplemented-capability rule rather than a second argument, and it is stronger than the
bulk-against-single framing that first suggested the split. The group keeps a role to one name
without losing it: a role naming `read` gets all three, and a deployment still declares each.

**The honest limit, so that a reviewer does not read more into it.** Granting `field.view` and
withholding `field.export` is not a confidentiality control. Anyone who can read a column through
ordinary results can page through them and assemble the same extract by hand. What the split gives is
rate and auditability: the slow route is visible, leaves a trail per request, and is bounded by the
result window. That is worth having and it is a different claim from withholding the value, which is
the same overreach `export` already carries a warning about on the record axis. Withholding
`field.count` from someone holding `field.view` has the same limit, since what they can see they can
tally.

**Time is the third axis a record has, and it is an entity rather than a third `kind`.** A record's
data is addressed by which records, which fields, and which versions, and the third is independent
of the other two: permission to see prior states applies to whatever rows and columns a person
already reaches. **The reason it is not a kind is concrete rather than aesthetic.** As a kind, a
category with `{version}` would mean that seeing the history of a _controlled_ record needs both the
`controlled` grant and the version grant, and the adapter would have to conjoin two categories over
one piece of data. That is the subset test this design defers and the query layer cannot express. As
an entity, `revision.view` is a capability, capabilities already attach per category, and
`{controlled: [record.view, revision.view]}` says the same thing with no conjunction at all.

**A revision carries no categories of its own**, inheriting whatever its record carries, so the
version axis needs nothing in `categories` and nothing in `kind`.

**`create`, `update` and `delete` are absent from it deliberately.** A revision is produced by
updating a record rather than authored, and prior states are immutable. Deleting one is a real act
and it is erasure, which this design has open and unresolved against an append-only audit trail, so
the capability waits on that rather than being added here.

**Whether the service has the axis at all is not Usher's problem.** A submission service keeps
revisions and a search index does not, so a search token never carries `revision.*` and its adapter
never tests for one. That is the ordinary unsupported-capability path: nothing opens, and the
startup reconciliation reports the mismatch.

**No fourth data-plane entity, with one caveat that is dated rather than permanent.** A submission in
a submission service has its own identity and lifecycle and would qualify on that test alone. It
stays out because Usher governs who may `record.create` in a resource while the submission's own
state machine belongs to that service. **That holds for the first release and is not a property of
Usher.** If a data access committee layer is ever built on top of this, a request and a decision
about it become entities in Usher's own model, control plane, and the vocabulary extends to them
without restructuring, which is the test of whether this shape is right. Files in an object store
stay out for a different and more durable reason: the audience separates the metadata service from
the object store, and the sensitivity gap between metadata and payload is what categories are for.

### The token shape, and what the nesting gives

A resource maps to its categories; a category maps to the entities reached under it; an entity maps
to the actions held. `field` is the exception at the third level, mapping to its own categories
first, because a field is the one entity a record category further partitions.

    "HEART_STUDY": {
      "open":       { "record":   ["view"],
                      "revision": ["view"],
                      "field":    { "basic": ["view"], "clinician": ["view", "count"] } },
      "controlled": { "record":   ["view", "delete"],
                      "field":    { "basic": ["view"] } }
    }

That says something no flatter shape could: clinician fields are readable in open records and not in
controlled ones. The field categories sit inside the record category that bounds them, so the two
scopes compose instead of applying independently.

**The outer value is a map, not a list.** It was a list whose every element carried exactly one key,
which is the shape a map exists for. Nothing is lost: entries were already independent, and two
grants on one category already union into one entry.

**Bare action names stopped working the moment a second data-plane entity existed.** `["view"]` no
longer says whether it is `record.view` or `field.view`. The entity level resolves it by structure
rather than by parsing a prefix, so an adapter that has never heard of `revision` skips one key instead
of failing to recognize a string.

**`field` appears only where a category is partitioned, and `basic` behaves exactly as `open` does.**
The two levels answer different questions, which is why their absences differ.

**A missing `field` key means the category is not partitioned by field at all**, so the record
capabilities carry every column. That is not the payload's usual absence-means-nothing rule getting
an exception: it is the absence of a partition rather than the absence of a grant. Most instances
configure no field categories, and nothing is being withheld when there is nothing to withhold by.

**A present `field` key means only the field categories named inside it are reached**, and that is
the same rule as the row axis one level down. `field: {"clinician": ["view"]}` reaches the clinician
columns and not the basic ones, precisely as a grant naming `controlled` and not `open` reaches the
controlled records and not the open ones. `basic` is the residual, it is granted rather than assumed,
and leaving it out hides it. Showing the clinical values of a record while withholding its
identifying columns is that case, and it is a real one.

**The two states are worth keeping apart.** `field` absent says no field partition exists here;
`field: {"basic": [...]}` says one exists and this principal holds the residual of it. Collapsing
them would lose the signal an adapter uses to decide whether to run the column-pruning path at all.

**What changes when an instance configures field categories for the first time.** Existing grants
name no field category, so the `field` key appears and every grant that does not name one reaches no
columns. That is a narrowing on a configuration change, which fails closed and is loud, since people
notice immediately. The reverse, removing the last field category, widens silently, and it is covered
by the same owed audit event as any other change to what a resource's categories are.

**One level is polymorphic, deliberately.** `record` and `revision` map to action arrays while
`field` maps to a map. It reflects a real asymmetry rather than an inconsistency, since `field` is
the only entity a record category subdivides, and the alternative is a reserved key like
`"record": {"*": ["view"]}` that makes every other entity pay for it.

### How a grant becomes an entry

A grant names one resource, one record category, optionally one field category within it, and the
role whose capabilities it confers. Two grants on one record category merge into one entry:

    grant(HEART_STUDY, record=open, field=null,      viewer)       -> open.record = ["view"]
    grant(HEART_STUDY, record=open, field=clinician, field-viewer) -> open.field.clinician = ["count", "view"]

**The role stays free of scope, which is what keeps this from collapsing.** A field role is one whose
capabilities happen to be `field.count` and `field.view`; it does not name `clinician`. Both
scopes come from the grant. Had the role carried the field category, scope would be back on the role,
which is the collapse every other part of this model exists to avoid. `role_permissions` needs no
change.

**Where artifact capabilities live.** Under the categories they draw from:
`{"open": {"artifact": ["create"]}}` means artifacts may be assembled from open records, and one
spanning two resources needs the capability under both. That is the provenance rule already recorded,
which asks for authority over every resource an artifact draws on rather than any of them.

### The seeded roles, as a matrix

A list of role names says nothing about who can do what. The matrix does, and it is the canonical
view: a role is a row, a capability is a column, and the columns run in order of increasing reach.

| Role        | `count` | `view` | `export` | `create` | `update` | `delete` |
| ----------- | ------- | ------ | -------- | -------- | -------- | -------- |
| `viewer`    | ●       | ●      | ●        |          |          |          |
| `editor`    | ●       | ●      | ●        | ●        | ●        |          |
| `curator`   | ●       | ●      | ●        | ●        | ●        | ●        |
| `submitter` |         |        |          | ●        | ●        |          |

The first three columns are `read`, and every seeded role holding any of them holds all three.

**The containment is a staircase and it is not a hierarchy.** `viewer`, `editor` and `curator`
each add to the one before, which is what makes the table readable at a glance, and the
overlap is an artifact of how the sets were chosen rather than a structure anything walks. Nothing
inherits: the model resolves by unioning capabilities, so holding `curator` confers curator's set,
which happens to contain viewer's. Changing one role's set changes nothing about another's.

**`submitter` is deliberately off the staircase.** It creates and corrects and does not read, because
whether submission confers read is a scope question that was closed rather than answered, and a
submitter who reads gets there by holding a second grant at `viewer` rather than by the first one
widening. `update` is there because a submitter who cannot correct what they submitted is not a
useful role; `delete` is not, because removing a record is a governance act rather than a correction.

**No seeded role holds `count` without `view`.** The combination is possible, since capabilities are
granted independently, and serving it is research, in [count-only
principal](../docs/atlas/roadmap/count-only-principal.md). For every seeded role that views records
the absence of `export` would mean nothing, since viewing is enough to assemble an extract by hand.

**`surveyor` names a later role and is not seeded now.** It is the one that views a bounded number
of records and counts nothing, post-MVP, in [bounded
surveyor](../docs/atlas/roadmap/bounded-surveyor.md). Seeding the name now under another meaning and
redefining it later would widen every grant already naming it, since a grant confers whatever its
role carries at issuance.

**The control plane seeds two roles, and its matrix is sparse for a reason.** A control-plane
capability is held or not, with no progression to run along, so the table is a checklist rather than
a staircase.

| Role    | `grant.*` | `invitation.create` | `resource.view` | `resource.update` | `resource.setVisibility` | `ownership.transfer` | `resource.register` | `category.create` | `role.define` | `group.*` |
| ------- | --------- | ------------------- | --------------- | ----------------- | ------------------------ | -------------------- | ------------------- | ----------------- | ------------- | --------- |
| `owner` | ●         | ●                   | ●               | ●                 | ●                        | ●                    |                     |                   |               |           |
| `admin` | ●         | ●                   | ●               | ●                 | ●                        | ●                    | ●                   | ●                 | ●             | ●         |

**An owner is an admin bounded to one resource**, which the two rows make visible: the difference is
entirely the four platform-wide capabilities on the right, and nothing an owner holds is withheld
from an admin. `grant.*` means all five of `create`, `view`, `extend`, `reduce` and `revoke`, which
is the set that makes someone able to administer access rather than merely see it.

**Neither carries a data-plane capability**, which is the whole of the plane split expressed as
seeding. An owner or an admin who needs to read records holds a second grant naming a data-plane
role, and that grant is visible like any other.

**`custodian` is not seeded and is not defined.** The role is post-MVP, nothing appoints one in the
first release, and `custodianship.assign` and `custodianship.remove` are therefore in no seeded role
either. That is a decision rather than an omission: seeding the appointment
capability into `admin` is the act that would open the recorded self-appointment hole: an
administrator who may appoint custodians can appoint themselves and then satisfy the gate their own
grant needs. Leaving it unseeded closes that for now without pretending the hole is solved.

**Read the matrix rather than the role name when reviewing a grant**, and render it rather than the
name in an interface. That is what `display_name` and `description` on `capabilities` are for, and it
is the reason those columns sit in Usher rather than in each portal.

### Control plane

| Entity          | Actions                                                 |
| --------------- | ------------------------------------------------------- |
| `resource`      | `register`, `view`, `update`, `setVisibility`           |
| `category`      | `create`                                                |
| `grant`         | `create`, `view`, `extend`, `reduce`, `revoke`          |
| `group`         | `create`, `view`, `update`, `addMember`, `removeMember` |
| `role`          | `define`                                                |
| `ownership`     | `transfer`                                              |
| `invitation`    | `create`                                                |
| `custodianship` | `assign`, `remove`                                      |

**There is no separate `createSelf`, and self-targeting is a rule on the endpoint rather than a
capability.** Writing a grant that names yourself is writing a grant, and the decision that granting
is one function already says the gate applies identically whoever started the request. A second
capability would have implied a second authority, when what actually differs is two things that are
not capabilities: the self-grant endpoint requires a TTL, and it sets the flag that produces
`grant.selfCreation` in the audit trail. Both survive the fold.

**The consequence for an owner is intended rather than incidental.** An owner holds `grant.create`
unqualified, so they may write themselves a grant on their own resource. That is recorded, visible
and revocable like any other, and where a category carries a custodian the custodian is still the
last gate. It softens "owning a resource says who may reach it, not that the owner may" into "an
owner reaches it by an act anyone can see", which is the same trade already accepted for an
administrator.

**Most of these are already implied by the audit events**, since an event type and the permission
whose exercise produces it differ only verb to noun. Where an event has no capability the reason is
that nobody performed the act: `grant.denied` and `grant.rateExceeded` are detections,
`resource.orphaned` is a state, `invitation.lapse` is time passing, and `grant.unguarded` has no
actor at all.

**`grant.view` and `resource.view` have no matching event and are real anyway.** Seeing who else can
reach a resource is a disclosure in its own right and is separable from being able to change it.
Seeing that a resource exists and which categories it lists is what lets an owner manage a resource
they hold no data grant on.

**`group.addMember` closes a recorded gap rather than adding a feature.** Nothing today names who
controls group membership, so one membership change confers every resource that group's grants
touch, with no acceptance and no resource owner involved. Naming the capability gives that gap
somewhere to be fixed.

**Answering a grant needs no capability**, and the empty cell is deliberate rather than an
oversight: the authority to accept or decline is inherent in being the person it was offered to.

### Which relations earn an entity of their own

A relation gets an entity segment when it has its own identity and lifecycle. `grants` does: a
surrogate id, an expiry, a revocation, and a thing for those to act on. A plain link does not, and
acting on one becomes an action on whichever entity it joins.

| Relation              | Segment                                 | Why                                                       |
| --------------------- | --------------------------------------- | --------------------------------------------------------- |
| `grants`              | `grant.*`                               | own identity and lifecycle                                |
| `group_users`         | `group.addMember`, `group.removeMember` | a link; the authority is the group's                      |
| `role_permissions`    | `role.define`                           | a link; the authority is the platform's                   |
| `grant_decisions`     | none                                    | a link; the authority is inherent                         |
| `resource_categories` | **open**                                | a link, and which side holds the authority is not settled |

**The open one is a governance question wearing a naming question's clothes.** `category.associate`
says whoever governs the category decides which resources carry it. `resource.associateCategory`
says the resource's owner decides. Those are different answers, and choosing a name quietly chooses
one, so it waits on custodian scoping. What does not wait: the act emits no audit event today, and
it is the write that changes what every principal reaches and bumps the resource's category version.
An event is owed whichever side wins.

## Entity schema

The logical model. Specific column names, types, and indexes are not yet specified: see the
database schema design item in the roadmap.

        primary entities, describing state

    users                  (id, idp_subject, email, display_name)
    groups                 (id, name, description)
    resources              (id, name, description, created_by, created_at, updated_at)
    categories             (id, name, description)
    entities               (id, name, plane, display_name, description)
    capabilities           (id, entity_id, action, display_name, description)
    roles                  (id, name, plane)

        relations

    group_users            (group_id, user_id)
    role_permissions       (role_id, capability_id)
    resource_categories    (resource_id, category_id)

        the grant, and the decisions about it

    grants                 (id, resource_id, record_category_id, field_category_id,
                            holder_type, holder_id, role_id, granted_by, granted_at,
                            expires_at, revoked_at)
    grant_decisions        (id, user_id, grant_id, decision, capabilities, decided_at)

        secondary entities, recording process rather than state

    invitations            (id, email, resource_id, record_category_id,
                            field_category_id, role_id, invited_by, invited_at,
                            expires_at)

**One grant table, and the role sits on it.** A grant says: in this resource, on this category, this
holder acts in this role. Nothing states separately what someone is trusted with, because being
trusted as a curator is a decision made about a resource and a category rather than a standing
property of a person. There is no `resource_users` and no `group_roles`: those were two names for one
relation, split by holder and named as though they were different things, and both are absorbed here.

**The two stages are unchanged.** `role_permissions` expands the role to capabilities, which is the
first stage; the category selects which records those capabilities reach, which is the second. The
grant names which role and which category rather than the role being asserted somewhere else, so no
role is invented per object and the role-explosion argument is untouched.

**A control-plane role takes the wildcard category.** An owner manages a resource rather than a
category within it, so the row reads `(HEART_STUDY, *, user, Ana, owner)`. This is the shape the
token already uses, where a wildcard is valid in either position and means all of them.

**`holder_type` plus `holder_id` is safe here, and it is worth saying why**, because a nullable
discriminator was rejected earlier in this same schema. The difference is which way the mistake runs.
A read that fails to expand a group holder to its members returns _less_ access; a read that treats a
user row as a group matches nobody. Both fail closed. The rejected case was acceptance state, where
forgetting to check it treats an unanswered grant as live, which fails open. Same shape, opposite
consequence.

**Group holders are designed and not in the first release, and cost no migration when they arrive.**
Every share in the user flows names an individual, so the first release populates `grants` with user
holders only. `groups` and `group_users` carry no rows and the holder column already accepts them,
so enabling groups is a policy change rather than a schema change. A group is a plain named set of
people: it confers nothing by itself, and the same set can be granted curator in one place and viewer
in another, which a group carrying its own role could not express.

**The group half is designed rather than sketched, and it is written here so the shape is settled
before anyone builds against it.** It is the same table with a different value in one column, which
is what makes it additive: effective access becomes the union over grants naming the principal and
grants naming a group they belong to, and nothing about the person-held path changes.

**`grants` carries no holder qualifier, and will not need one.** A qualifier marks a holder only
where two shapes have to be told apart, and there is one shape: the holder is a column rather than a
table. Enabling groups adds rows, not a parallel table to name.

**`grant_decisions` already works for both**, which is the part worth having settled early. A grant to
a group produces one decision row per affected member, so a group grant never bypasses acceptance,
and the table needs no change beyond the grant it points at.

**Two deferred items have requirements this schema does not yet carry, recorded so a change to it
can be checked against them rather than breaking them silently.**

**Embargo needs a deadline below the resource.** Its recorded requirements put it on segments rather
than on a whole resource, with separate deadlines per segment, and the segment has to be computable
by the enforcing adapter because no record says it is embargoed. Nothing here holds a date below
`resources`, and `resource_categories` is the only thing that names a segment within one. Whatever
the mechanism turns out to be, a resource-level flag is not it, and neither is a date on a grant,
which is what the withdrawn design used and why it was withdrawn: a grant's expiry subtracts access
and an embargo has to release it.

**Record-level narrowing needs a predicate that is not a category.** A category is a fixed field
value, and narrowing on a further field is a second predicate kind against the same records.
Principal-relative selection is a third, since `own` is parameterized by the asker rather than by a
value. The constraint those place on the present model is already recorded and is load-bearing: only
fixed categories decide what `open` covers, because a principal-relative one selects every record for
somebody and would leave `open` empty.

**Each table answers one step of the token calculation**, which is the order to read them in and the
reason each exists. The calculation is in [token-calculation.md](token-calculation.md).

| Step | Question                                                                         | Tables                                         |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Which grants reach this principal, directly or through a group they belong to?   | `grants`, `group_users`                        |
| 2    | What does each grant's role carry, expanded to capabilities?                     | `role_permissions`, `capabilities`, `entities` |
| 3    | What did this principal last answer about each, and is the grant still live?     | `grant_decisions`, `grants`                    |
| 4    | What a kept grant confers now, and whether the resource still lists its category | `role_permissions`, `resource_categories`      |
| 5    | Assemble the token                                                               | nothing. It is computed and stored nowhere     |

The step numbers are the calculation's own, so the two documents can be read against each other
rather than each being taken on its own.

**Eleven tables in the first release, of four kinds**, plus two stubs and one secondary entity. The glossary lists the entities;
this lists what joins them, so that a reader can check the schema against the model rather than infer
one from the other.

| Kind               | Table                 | Read as a sentence                                                                                                                                                               |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entity             | `users`               | a person or a client that can ask                                                                                                                                                |
| entity             | `groups`              | a named set of people, conferring nothing by itself                                                                                                                              |
| entity             | `resources`           | a collection of records sharing an identifier                                                                                                                                    |
| entity             | `categories`          | a collection of data sharing properties, selecting records or fields depending on the grant                                                                                      |
| entity             | `entities`            | what a capability acts on, and which plane it sits in                                                                                                                            |
| entity             | `capabilities`        | what an API offers, as one entity paired with one action. A vocabulary, not policy                                                                                               |
| entity             | `roles`               | a named bundle of permissions                                                                                                                                                    |
| relation           | `group_users`         | this user is in this group                                                                                                                                                       |
| relation           | `role_permissions`    | this role carries permission to use this capability                                                                                                                              |
| relation           | `resource_categories` | this resource offers this category                                                                                                                                               |
| associative entity | `grants`              | this holder acts in this role, on this record category of this resource and optionally one field category within it, granted by someone, at a time, until a time, unless revoked |
| event              | `grant_decisions`     | this user answered this grant, this way, with these capabilities in view, at this instant                                                                                        |
| secondary entity   | `invitations`         | access offered to an address with no account yet, recording a promise rather than a state                                                                                        |

**The four kinds are not stylistic.** A relation has no identity and no attributes: delete the row and
nothing is lost but the association. An associative entity cannot exist without the things it joins
and still has a life of its own, which is why a grant can be extended and revoked while
`group_users` can only exist or not. An event is neither: it is a fact about a moment, written once
and never edited, so its table only grows.

**A permission is a row in `role_permissions`.** The table pairs a role with a capability, and that
pairing is the permission; the grant supplies its scope. So the column is `capability_id` rather than
`permission_id`, because the row does not point at a permission, it is one.

**The grant carries the resource, so authority never spans resources by accident.** A person can be an
owner in one study and hold nothing in the next, which is what the flows describe when a steward's
authority is scoped to a study. The two stages are still two: `role_permissions` says what acts the
role allows, and the category says which records they reach.

**`grants` has a surrogate id, and needs one.** Three audit events carry a `grantId`, which a
composite key cannot supply. A grant is also the thing revocation and expiry act on, so it has a
lifecycle and therefore an identity.

**A grant and the decision about it stay separate even though both name the same person.** The grant
records the granter's act and carries expiry and revocation; the decision records the recipient's
answer and is append-only. Collapsing them would put a lifecycle the granter controls and a history
the recipient writes in one row, and the flows need both: a steward revokes, and a dashboard shows
when the recipient accepted.

**`grant_decisions` is append-only.** A later answer about the same grant is another row, and the
current answer is the latest row for that user and grant. Two columns carry weight: `capabilities` is
a snapshot of what the member was shown when they answered, not a cache of what the role confers now,
which is what makes a later divergence visible; and `decided_at` is a UTC instant rather than a date,
because selecting the latest row needs a total ordering and two answers can land in the same minute.

**Expiry and revocation are on the grant, never on a decision.** Both are the granter's act or the
grant's own lifecycle. The decision table records what one person answered and nothing else, so it
carries no `expired` and no `revoked`.

**One grant, one row per member who must answer it.** These are not the same relation written twice:
the grant records the granter's decision, and a decision row records a grantee's. Ana accepting and
Bo rejecting the same grant is an ordinary outcome, and neither touches the grant. Revocation
therefore acts in one place rather than requiring every path to be found and closed separately.

**`capabilities` is a vocabulary rather than policy, and it lives in controller configuration.** Usher
needs it only so that a permission can name a capability and a management interface can offer the
right choices. Configuration rather than registration, because a service's capability set changes
when the service is released rather than at runtime, and a release is already a reviewed change.

**Usher ships defaults, and a default is not a promise that every service offers it.** `download`
means nothing to a service that serves no files, and `edit` means nothing to one that is read-only.
So the vocabulary has two parts: the set Usher ships, and which of them each service actually offers,
with instances free to add names Usher never shipped. A management interface offering `download` for
a service that cannot do it is offering a permission that will never be exercised.

**There is no `kind` on a category, and the reason it was rejected is the reason it looked
necessary.** What `clinician` selects, rows or columns, is decided entirely by the adapter's mapping.
Two adapters could map the same name differently, and Usher can neither know nor verify either. A
column here would be Usher asserting a fact it does not own, and an assertion that cannot be checked
is worse than no assertion.

**What says it instead is which column of the grant a category sits in.** `grants` carries
`record_category_id` and `field_category_id`, each naming an axis rather than a type, so the same
category may sit in either and Usher claims nothing about what it means. Both columns are named for
their axis deliberately: `category_id` beside `field_category_id` would read as "the category, plus
the special field kind of one", which is the property that was just removed. The capability
constraint stays checkable, since a field grant is `field_category_id IS NOT NULL`.

**Exactly two columns, and the count is derivable.** Categories partition the two data-plane entities
that carry them: a revision inherits its record's, and an artifact's reach comes from provenance. A
third column would mean a third partitioned entity, which is a deliberate act rather than a quiet
reinterpretation of an existing column.

| Capability                                  | Scoping records | Scoping fields                                                                              |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `record.view`, `record.export`              | yes             | not on this axis: viewing fields is `field.view`                                            |
| `field.count`, `field.view`, `field.export` | not applicable  | yes, and a bucket's key is a field value, so withholding a column withholds its bucket keys |
| `field.update`                              | not applicable  | field-level write, coherent and unbuilt                                                     |
| `record.delete`                             | yes             | never: deletion takes the whole record                                                      |
| any `artifact` capability                   | yes             | never                                                                                       |

**What is given up by not having it**, stated so the trade is visible: a grant naming a category with
no column mapping at all now fails closed silently, where a kind would have refused it at writing.
Catching that needs Usher to retain what each adapter declared at its last reconciliation, which is
the same missing machinery several other findings land on.

**It stays a table, and what settled it was the display name.** A capability carries text a person
reads, so a bare string in a permission row has nowhere to put it. The typo argument was the weaker
half of this: an unknown capability name already fails closed in both directions, so referential
integrity was never what protected access. What a table adds is somewhere for `display_name` and
`description` to live.

**`display_name` sits in Usher for one reason, and the column otherwise looks misplaced.** How a capability is worded to a person reads like the consuming application's
concern. It is Usher's because the management interface ships from Usher as a package that portals
mount, so the wording has to come from somewhere Usher owns, or every portal supplies its own and
the same capability is called two things in two places. It is also where the per-instance vocabulary
lands: `resource` displays as "Study" in an iMS instance, and `record.export` displays as "Download"
where that is the word the portal's button uses.

**`description` is the one optional column here.** It is also the one with a consequence: a
recipient answering a grant is shown what they are accepting, and `grant_decisions.capabilities`
records that snapshot. Editing a description later changes what a reader believes was agreed to, so
it is closer to a published term than to an internal note.

**`permissions` is the grant's second dimension, and the store is where the token's pairs come
from.** An Usher token pairs each category with what the principal may do with it, so a grant records
both the category and the permissions it carries. Whether that is an array column or a join
table is a physical-schema question rather than a logical one; the dimension itself is not
optional, because without it the token has nothing to render.

**The two groups answer different questions, which is why they are listed apart.** A primary entity
says what exists and who may reach it; take one away and the model can no longer answer that. A
secondary one records a promise or a transition: an invitation that has not become grants yet, an
audit entry for something that happened. Both are stored, and neither is part of what the model is
made of. `revocations` straddles the line, which is why its shape is still open: a single timestamp
is state, a history is a record of process.

**Three entities are deliberately absent rather than overlooked.** Naming them here is worth more
than their omission reading as oversight:

- `revocations`. The propagation mechanism is designed in
  [security-workflow.md](security-workflow.md); what is unsettled is whether a revocation is a
  single timestamp or a history, which decides what happens when access is restored.
- `audit_log`. Its events and common fields are listed in
  [audit-events.md](audit-events.md), and the open question is retention against erasure rather
  than shape.
- **A category version on `resources`**, bumped by any `resource_categories` write and recorded in
  the token, which the fast path compares on refresh. It replaces a per-principal
  last-policy-change timestamp, rejected because a principal-scoped marker cannot see a resource
  gaining a category. See the fast-path decision in [decisions.md](decisions.md).

**Every resource carries at least one category, so `resource_categories` is never empty for a
live resource.** A resource's unrestricted portion is a category like any other, which is what
removes the need for a baseline outside the category system. The consequence is that a resource
with no categories is ungrantable, since a grant would have nothing to name.

**User identifier discipline.** `users.id` is the Keycloak subject (`sub` claim from the OIDC
token). It is the only user identifier used in `grants`, `grant_decisions`, audit records,
and all APIs. `users.email` is stored for display purposes only and is never used as a
lookup key. The one exception is `invitations`, which is keyed by email address for grants
sent to users who have not yet registered.

**`grant_decisions.decision`** is `accepted` or `rejected`, and there is no third value. Pending
is the absence of a row rather than a state on one, and expired and revoked are read from the grant
rather than stored here. Where auto-accept is enabled an accepted decision is written at creation
without the member acting; where it is off, which is the default, no row exists until they answer and
the grant appears in no token until then.

**`invitations`** holds promises of grants to email addresses that do not yet correspond to a
registered user. An invitation is not a grant: it carries the address, the grants it will create and
its own expiry, so it duplicates none of a grant's fields, and a grant never exists before a
principal does.

That is also what frees `pending` to name one thing. It is a grant state, meaning a registered
grantee has not yet accepted, and it never means an address with no account behind it. The invited address is a placeholder held only until the grant can attach to a
Keycloak subject, and it is discarded once one exists.

The invitation link is what performs that attachment, and it binds the grant to **whichever account
the recipient confirms with**. Three paths reach the same place:

1. The recipient registers using the invited address. Registration triggers a lookup by that
   address.
2. The recipient registers using a different address. The link, not the address, carries the
   binding, so the grant still attaches to the account they created.
3. The recipient already has an account, under the invited address or another one. Confirmation
   happens after they log in.

Matching rows are migrated to `grants`, with no decision row until the recipient answers, under the
account's Keycloak subject, and the `invitations` row is deleted after migration. Since an
account may hold more than one verified address, a lookup by address matches any of them, and only
a verified address may bind a grant: otherwise claiming an address would be enough to collect
grants intended for whoever holds it.

### What these entities render into

The tables above are the store; an Usher token is what a query of them produces for one principal
and one application. Showing both is the point of putting the example here, since neither the store
nor the token alone shows how a row becomes something an adapter can enforce.

Two `grants` rows on `HEART_STUDY` and one on `LUNG_COHORT`, held by the same user, render
as:

```json
"permissions": {
  "HEART_STUDY": { "open":       { "record": ["view", "update"] },
                   "controlled": { "record": ["view"] } },

  "LUNG_COHORT": { "open":       { "record": ["view"] } }
}
```

Four properties of the mapping, each of which the store has to support and does:

- **One row, one entry.** A grant is a row, and the list preserves that rather than flattening
  several rows into one aggregate.
- **`permissions` comes straight across.** This is what the column exists for; without it the
  entries could name a category and nothing else.
- **`role_id` does not appear.** A role resolves to permissions before the token is written, so
  `grants` feeds the entries without being represented in them.
- **A resource with no grants is absent, not empty.** There is no row to render, and absence already
  means no access, so nothing needs to say so.

Standard JWT claims and the anonymous form are in
[security-workflow.md](security-workflow.md#token-structure), which is authoritative for the wire
format. This section is authoritative only for how the entities above produce it.

---

## Invitation and acceptance flow

**An invitation is not a grant, and a grant never exists before a principal does.** So these are two
flows rather than one, and an invitation has no state in the grant's sense: it is claimed or it
lapses.

    an address with no account                a registered principal

    invitation created                        grant created
      |                                         |
      | person registers, or an existing        | no decision row yet
      | account confirms the link               |
      v                                         v
    grants created against their subject ---> awaiting the grantee's answer
      |                                         |
      | the invitation row is deleted           | grantee accepts
      v                                         v
    (no invitation remains)                   an accepting decision row
                                                |
                                                | revoked, declined, or the end passes
                                                v
                                              absent from the next token

**A group grant does not skip acceptance.** A grant naming a group produces one decision row per
member, and they answer independently: one member accepting and another refusing is an ordinary
outcome, and the grant itself is unchanged by either. A group has nobody to accept on its members'
behalf, which is the reason the answer was never a property of the grant.

Where auto-accept is enabled, an accepting decision row is written at creation without the recipient
acting.

**What each condition means for Usher token issuance:**

- **An invitation**: never appears in any Usher token. No grant exists yet for this resource and
  category, and none does until the invitee's identity is bound.
- **A grant with no decision row**: never appears. The person can see the offer through the portal
  and reaches none of the data, because no answer is not an acceptance.
- **A grant whose latest decision refused it**: never appears while that is the latest answer. A
  later acceptance is another row and takes effect from then.
- **A revoked grant**: never appears. Distinct from an expired one, which is read from `expires_at`
  rather than stored, because the dates cannot say which of the two ended it.
- **A live, accepted grant**: included at the next token exchange, narrowed to what its role confers
  now. The adapter enforces that.

**Each of these acts is audited.** Creation, the recipient's answer, the binding of an invited
identity, and revocation each produce an audit entry.

**Claiming an access invitation from an existing account.** The migration above fires on registration
keyed to the invited address, which leaves a gap: an invitee who already holds an account under a
different address never triggers that event, so the pending row waits indefinitely with nothing to
resolve it.

An invitation link closes that gap, under one constraint that is the whole design: **the link binds
identity and never creates or activates a grant.** Its only function is to answer which account
belongs to an already-approved invitee, moving the row from `invitations` to `grants`
under that account's Keycloak subject. The grant that produced the grant is unchanged, and the
acceptance step that activates it still applies. An invitee may either sign in with an existing
account or register a new one; both routes end at the same identity binding.

The link is single-use and short-lived, and the binding-not-granting rule is what makes those
sufficient rather than merely advisable. If a link could activate access, the invited mailbox would
become the authorization boundary, and a forwarded message or a compromised mailbox would transfer
access to controlled data: a materially weaker gate than the Controlled tier requires everywhere
else. Binding identity leaks nothing, because an account that binds to a grant it was never
granted still holds no grant.

Group grants have no acceptance step, so this path applies only to grants issued to an individual
address.

---

## How access is resolved

### The visibility rule

A record is visible to a user when the user holds a grant for every category **that record** carries,
in the resource the record belongs to. Stated the other way round, a record is hidden when it carries
any category the user does not hold.

> **Scope: one clause of this is deferred, and it is not the one that filters.** A category maps to a
> per-record predicate, and the enforcement clause pairs the resource's field value with the
> category's, so a resource of mixed sensitivity serves each principal the records their categories
> reach. What is deferred is a record carrying **more than one** category at once, which needs a
> subset test the query layer cannot yet express on a flat field. Until it lands a record carries one
> category, and the conjunction described below states what that test will enforce rather than
> something running today. See "A category selects records within a resource" in
> [decisions.md](decisions.md), which also records the two constraints that govern the deferred work.

The existence-denial invariant below holds under either model, since both filter before any result
is computed.

The Usher token carries only what the user holds: a map per resource, keyed by category, each naming
the entities reached under it and the actions held on each. A category the user does not hold is simply not named,
which follows the same positive-grant convention as OAuth scopes, UMA permissions and GA4GH Visas,
and discloses nothing about what exists.

**Nothing is subtracted.** Each grant renders a positive predicate and those compose with `or`, so a
record the user cannot reach is one that no predicate selects. There is no full category set to
subtract from and no exclusion filter, because a permission list is never read as an exemption from a
default. **Rejected: computing exclusions from a resource's configured category set**, which gives
the same answer as this one only sometimes.

Excluded records do not appear in counts, aggregations, or result sets; their existence is not
disclosed. This is a hard invariant: existence revelation is an information disclosure vulnerability
(OWASP A01), and a discoverable-but-inaccessible mode is never the default.

**Serving it needs the enforcement seam to know which surface is asking, which it does not today.**
One filter answers records, aggregations and set materialization alike, so a grant of
count-without-view cannot be honoured selectively and resolves to denied everywhere. That is the
safe direction and it is the second of two independent widenings the seam needs, the other being
projection for field restriction. Neither implies the other and they are worth costing apart.

**`record.count` is the one way that mode can exist, and it is a grant rather than a default.**
Read strictly, the invariant above and a capability that counts without reading contradict each
other, so the boundary is exact. **Excluded** means no grant of yours reaches it: such
a record contributes to nothing, not a count, not a bucket, not a row, and that is the part that never
bends. A record a grant of yours reaches at `count` and not at `view` is not excluded; it is
discoverable to you because an instance deliberately conferred that, which is the discovery tier
every federated platform in this domain has. The default remains no grant and therefore nothing, and
the reason this is a separate capability rather than a side effect of `view` is that a count over
small cells re-identifies, so conferring it has to be a decision someone makes and an auditor can
see.

**What the invariant requires of a denial response.** A denial says the resource does not exist **or** the principal lacks access, without indicating which. Distinct responses turn the endpoint into a
lookup service: someone enumerating identifiers learns the instance's holdings without reading a
record.

**This is oracle denial rather than deterrence, and the difference decides the implementation.**
Deterrence would be satisfied by the wording alone. Denying an oracle means every channel that
distinguishes the two cases has to be closed.

**Under the default shape below, most of that closes itself, and the table is a deviation
checklist rather than a to-do list.** Where denial is a filter matching nothing, body and timing
converge structurally, so the only row still requiring attention is side effects. Read the table as
what must be re-verified by hand the moment a response shape is chosen that does not converge on its
own:

| Channel              | How it leaks                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Response time        | A denial that performed a grant lookup is slower than one that short-circuited on a missing resource |
| Body shape           | Same status, differing structure or fields                                                           |
| Side effects         | One path emits an audit event or moves a rate-limit counter; the other does not                      |
| Downstream behaviour | Differing cache headers, retry behaviour, or `Vary`                                                  |

Timing is the one that usually survives review, because a denial is not thought of as having a body
worth measuring.

**The refusal says the same thing to everyone, with no exception.** An earlier calibration relaxed
it for someone who demonstrably knew the resource existed, such as the holder of a lapsed grant, on
the reasoning that nothing is revealed to a person who was told it existed when the relationship was
created. That reasoning is sound and is not why the exception was dropped. It was dropped because no
application can identify such a person: a grant that is not live puts nothing in the token, so a
lapsed grant and a stranger arrive looking identical.

The cost is real and is carried rather than solved here. A lapsed grant is a normal and frequent
state in a model with expiry and an acceptance flow, and a refusal that explains nothing generates
support load and teaches people the system is broken. The answer is that Usher tells the person
directly, on the channel already carrying the grant lifecycle. See "A refusal carries no exception,
and expiry is announced rather than inferred" in [decisions.md](decisions.md).

**Ambiguous outward, precise inward.** The audit trail records why the request was refused while the
response does not. The pair it cannot separate is the one above, since a lapsed grant and a stranger
are identical in the audit trail too. That is what the reason field on the deny result is
for, and it is how an operator debugging a service account resolves what a status code deliberately
will not tell them.

**Consequently the response shape is a choice among indistinguishable shapes**, not an open one. An
adapter picks which shape suits its service; it does not get to pick whether the two cases are
distinguishable.

**An empty result set achieves this at no cost, and should be the default.** Where a
denial is expressed as a filter matching nothing, a denied resource and a nonexistent one traverse
the same code doing the same work, so the body is identical without effort and the timing converges
without design. A distinct status code achieves the same only if both cases are deliberately routed
to the identical response, which is a property that has to be built and then kept.

**It also has a cost, and the cost is what a richer response is for.** An empty result cannot
distinguish "you may see this and it holds nothing" from "you may not see this". A researcher whose
study is legitimately empty cannot tell that their access is working. That collapse is the same
invariant-paid-for-by-legitimate-users problem described above, arriving through the response shape
rather than the wording.

**So the two are not alternatives; they are the two halves of the calibration.** An empty result for
a principal with no relationship to the resource, where ambiguity is owed and is free. A specific
response for a principal who demonstrably knows the resource exists, where ambiguity gains nothing
and costs support load.

The practical consequence for an application: a seam that can only return a filter can only ever produce
the first half. Widening it is worth doing for the second half, and not for the ability to return a
particular status code. A widening motivated by the status code alone will produce two
distinguishable denials and reintroduce the oracle the empty result had closed by its shape.

**An instance can defeat all of this through its resource mapping alone, with the enforcement path
entirely correct.** The denial response protects resource existence. If resource identity is
already enumerable through an unauthenticated endpoint, that protection is decorative: no timing
analysis or status-code inference is needed, because a public endpoint answers the question
directly.

The general rule is about the resource field's **value space**, not about any one endpoint: **where a
resource's existence is confidential, the values identifying resources must not be enumerable
without authentication.** A resource field mapped one-to-one onto something an instance publishes by
design is the clearest way to break this, and it is a legal configuration today, since one resource
per type is a permitted special case of many-per-type. Other routes exist: values appearing in
buckets in a public facet, in a published schema, or in URLs.

**The condition matters, because this is not universal.** Many platforms publish their study
registry, and where resource existence is already public there is nothing to protect and nothing is
lost. It bites where existence is meant to be confidential, and this model has such a case built in:
an embargoed resource is precisely one whose existence should not be discoverable before release.

**Enforcing this needs two different mechanisms, because enumerability is only half statically
knowable.** A startup check covers only half of it: a check can read configuration, and
configuration does not say whether an endpoint applies the filter it should.

**Structurally public, so a startup check.** Where the resource field is one-to-one with something the
instance publishes by design, the values are public whatever the enforcement path does. That is
readable from configuration before any request arrives, and it should fail startup rather than warn,
because no request-time behaviour repairs it.

**Behaviourally leaky, so a conformance case per endpoint.** Any endpoint that can return resource
values, a facet or aggregation, a suggestion or type-ahead, a published schema, is supposed to apply
the filter and might not. Whether it does is a property of the code, not of the configuration, so a
startup check cannot see it and enforcement tests on the record path do not cover it.

**The failure mode this guards is an endpoint exempting itself from a correct filter.** An application
found exactly that: an aggregation wrapper that discarded the access filter along with the search
query and returned whole-index counts, while the record path was entirely correct. It was found by
running a query and comparing counts, not by reading code, and it stood undetected for some time.

So the conformance corpus needs a case per endpoint that returns data, comparing what an under-
privileged principal sees against what a fully-privileged one sees, rather than only asserting that
records are correctly filtered. An instance can pass every record-path test while publishing its
resource values through a documented feature working exactly as designed.

### Worked example

**Setup:**

Resources and their category assignments:

- `RESOURCE_X` has `categories: [open, indigenous_data]`
- `RESOURCE_Y` has `categories: [open, indigenous_data]`

Users and their grants:

- User A: one grant, on `RESOURCE_X`'s `open` category
- User B: grants on both of `RESOURCE_X`'s categories, and one on `RESOURCE_Y`'s `open` category

Adapter config (Arranger-side; maps concrete category names to Elasticsearch field predicates):

    indigenous_data → { fieldName: "isIndigenous", value: true }

**Only concrete categories are mapped.** `open` has no field value of its own: it stands for whatever
the concrete categories on that resource do not cover, so the adapter renders it as the negation of
them rather than reading a predicate from configuration. Here that is `NOT(isIndigenous = true)`.
Giving `open` its own predicate would make it concrete, and records matching neither it nor any other
category would then be reachable by nobody, which is not what a residual means.

**Usher token for User A:**

```json
{
	"payloadVersion": 1,
	"sub": "user-a",
	"aud": "example-service",
	"iat": 1720000000,
	"exp": 1720000300,
	"generatedAt": 1720000000,
	"permissions": {
		"RESOURCE_X": { "open": { "record": ["view"] } }
	}
}
```

`RESOURCE_Y` is absent, so User A reaches nothing in it.

For `RESOURCE_X`, one grant is held and it names `open`, so one positive clause is emitted, the
complement of that resource's concrete categories: `NOT(isIndigenous = true)`. Records carrying `indigenous_data` match no clause and are therefore never
selected. Nothing is subtracted and no exclusion is computed: the records User A does not reach are
the ones no grant of theirs names. Their queries never reveal that indigenous records exist, since
those records are absent from results, counts and aggregations rather than filtered out of them.

**Usher token for User B:**

```json
{
	"payloadVersion": 1,
	"sub": "user-b",
	"aud": "example-service",
	"iat": 1720000000,
	"exp": 1720000300,
	"generatedAt": 1720000000,
	"permissions": {
		"RESOURCE_X": { "open": { "record": ["view"] },
		                "indigenous_data": { "record": ["view"] } },
		"RESOURCE_Y": { "open": { "record": ["view"] } }
	}
}
```

For `RESOURCE_X`, two grants are held, so two positive clauses are emitted and composed with `or`:
`NOT(isIndigenous = true)` or `isIndigenous = true`. User B reaches both portions and their overlap,
which is what holding both grants means.

For `RESOURCE_Y`, one grant is held, so one clause is emitted: `NOT(isIndigenous = true)`. The
indigenous records in `RESOURCE_Y` are unreachable, for the same reason as User A's in `RESOURCE_X`
and by the same mechanism.

**The contrast worth holding on to.** Neither user's unreachable data is excluded by a clause. It is
unreachable because no clause selects it, which is what additive rendering means and is the whole of
the rule. There is no full category set to subtract from, and a permission list is never read as an
exemption from a default.

The token examples above use the canonical `permissions` map structure. For the full token schema,
standard JWT claims, and anonymous token form, see
[security-workflow.md: Token structure](security-workflow.md#token-structure).

### Composition across categories

With two independent categories `controlled` and `indigenous` mapped to fields `isControlled`
and `isIndigenous`:

Every principal holds the baseline `open` grant, so it is present in every row below and the token is
never empty.

| User's grants    | Categories in the token            | Records reached                                           |
| ---------------- | ---------------------------------- | --------------------------------------------------------- |
| open only        | `open`                             | the residual: `isControlled=false AND isIndigenous=false` |
| open, controlled | `open`, `controlled`               | the residual, plus records carrying `controlled`          |
| open, indigenous | `open`, `indigenous`               | the residual, plus records carrying `indigenous`          |
| open, both       | `open`, `controlled`, `indigenous` | every record                                              |

**The last two rows depend on a rule that is deferred.** A record carrying `controlled` _and_
`indigenous` needs a grant for both, which is the subset test the query layer cannot yet express.
Until it lands a record carries one category, so the case does not arise and each row is the
union of what its clauses select. When it lands, holding `controlled` alone stops reaching the
records that also carry `indigenous`, and holding both reaches them again, because no ungranted
category remains on them. This is the intended MVP behaviour: per-resource scoping ensures each grant was
approved by the relevant governance body for that specific resource, so holding both is sufficient.
SQON-scoped grants (post-MVP) can narrow further within a category if compound-access governance
requires it. See the resolved question in Open questions.

---

## Category-to-field mapping

> **Scope: this is in the first release.** The enforcement clause pairs the resource's field value
> with the category's, so an adapter that cannot map a category name to a field predicate cannot render
> a clause. `open` is the complement of the mapped concrete values, which is why an unmapped category
> exposes records rather than hiding them, and why the reconciliation check in
> [adapter-integration.md](adapter-integration.md) fails startup rather than warning. See "A category
> selects records within a resource" in [decisions.md](decisions.md).

Categories in Usher's model are named abstractions. Usher has no knowledge of what fields in
any data schema correspond to a category: it works with category names only. The mapping from
category name to field predicate is instance configuration that lives in the enforcement adapter:

    category: indigenous_data
      field:  isIndigenous
      value:  true

A record belongs to a category if the configured field condition is true for that record. The adapter
holds this mapping and renders each category the token grants as a predicate paired with the
resource's, composed with `or`. Nothing is subtracted, with `open` the single exception: being the
residual it has no value to match, so its predicate excludes the configured concrete values instead.
Two instances using the same Usher instance can map the same category name (`indigenous_data`) to
entirely different field names in their respective schemas, because each adapter carries its own
config.

---

## Field-level restrictions

> **Scope: out of MVP, and further out than record-level narrowing.** Controlling fields within a
> record presumes control over records first, so this follows the record-level work rather than
> running beside it. The options below are recorded for when it is picked up.

Field-level restrictions control which fields within a record a user can see, independent of
whether they can see the record itself. Which approach to take is open.

**A. Resource-level restrictions.** Restrictions are uniform across all users with access to a
resource. Nobody granted resource X reaches `clinical_notes`, whatever role their grant names. Simple;
appropriate when the resource itself defines what is visible. Cannot differentiate access by role.

**B. Role-differentiated restrictions.** Restrictions vary by the role a grant names. A grant at
`viewer` does not reach `clinical_notes` while one at `curator` does. Adds role-differentiated field
access, and requires a matrix of role-by-field rules per resource, which increases management UI
complexity. Note that both roles here are data-plane ones: an owner is a control-plane role and
reads nothing by holding it.

**C. Category-based field restrictions (preferred for extensibility).** Fields are tagged with data
categories using the same model that governs record-level access. A user's category grants
determine which fields they can see. A user who holds the `indigenous_data` grant sees fields tagged
`indigenous_data`; without it, those fields are absent.

**The tagging lives in adapter configuration, not in Usher.** An earlier sketch put it in a
`field_categories(field_name, category_id)` table here, which would have contradicted the principle
outright: Usher never learns a field name, and the resource field mapping already lives in adapter
config for exactly that reason. Column tagging belongs beside it. That deletes a table rather than
adding one.

**D. User-level overrides.** Per-user, per-resource field exceptions on top of the base model.
Maximum flexibility; operationally expensive and difficult to audit. Treat as a deferred extension.

**Recommendation:** start with A for initial implementation; it is simple and sufficient for most
cases. Design for C as the primary extension path: it reuses existing concepts and keeps the mental
model unified. Defer B and D until a concrete use case requires them.

### What option C still has to answer

**The token carries it and the enforcement seam does not, and that is the whole of it.**
The payload needs no change: categories nest under a resource, a `field` key nests under a category,
and the schema needs one nullable column. What does not carry it is the seam. An enforcement hook
returns a predicate, and a predicate selects records; which fields of a returned record are visible
is a projection, and the two are different things. **So field restriction is a contract change at
the adapter boundary rather than a configuration change behind it**, and it is the first thing this
design has asked for that the seam cannot express. Established against the first integration's own
interface rather than inferred.

**That relocates the work and raises its cost.** It is not a mapping added beside the resource field
mapping; it is a second return channel from the bridge to the adapter, or a widened one, carrying what
to project alongside what to select. Anything that assumed field restriction was configuration should
be read again with that in mind.

**A store that duplicates values defeats it from underneath, and that is a data-modelling
precondition.** Where an index copies a field's value into another field at write time, restricting
the original leaves the value readable in the copy, and no projection at the query layer can undo
that. This joins the preconditions already recorded against enforcement, cardinality, per-record
category marking, and identifier uniqueness across catalogues, rather than being an enforcement
defect.

**B is what a reader usually asks for, and it is the one to steer away from.** "This role sees every
column, that role sees three" puts data scope on the role, which is the collapse the two-stage split
exists to prevent, and it explodes the moment a second resource wants a different three columns for
the same role. C expresses the same need with the grant's category as the discriminator and no new
roles.

**The residual works in both directions, and what makes it safe is the reconciliation check rather
than the default.** The rule is the same on each axis: whatever the concrete categories do not cover
is the residual, so an untagged record is open and an untagged column is basic. A resource with no
column categories configured shows every column, which is no restriction configured meaning no
restriction, exactly as a resource with no row categories is open in full.

**The obvious objection is that a new column is more dangerous than a new record, and it is the
other way round.** Add `hiv_status` to the index and the residual rule exposes it until somebody
tags it, which looks worse than a new record inheriting its neighbours' treatment. But a record
carrying a category value nothing maps is already served as open at runtime, between one boot and
the next, and nothing announces it. A column cannot appear without an index mapping change, which is
a discrete, deployed event. So the column case is the more detectable of the two, provided the
reconciliation check covers field mappings and runs when the index mapping changes rather than only
at boot. **That condition is what this rests on**, and without it the residual on the column axis is
the more dangerous of the two rather than the less.

**The column residual needs a name, because an instance has to be able to withhold it.** `open` is a
real grantable category on the row axis precisely so that an instance can turn it off and have
nothing be open unless deliberately added. A dataset whose plain columns are themselves sensitive
needs the same lever, so the column residual is `basic` rather than nameless.

**`open` and `basic` stay two names rather than one name on two axes.** `categories.name` is unique
across the instance, so reusing `open` for the field residual would need the axis in the key, and a
word whose meaning depends on which column of a grant it lands in is the ambiguity every other part
of this vocabulary work removes. Two words, one unique name each, and the grant's column says which
axis a category is scoping without the category itself having to carry an opinion.

**Aggregations are a second enforcement point, and missing one leaks the whole column.** Excluding a
field from `_source` removes it from hits and does nothing to a terms aggregation over it. A search
service builds facets from aggregations, so a restricted column stays facetable and its values stay
enumerable, which for something like `hiv_status` is complete disclosure by another route. One
capability, `field.view`, and two places to enforce it, and the second is the one that gets forgotten:
a bucket's key is a field value, so the aggregation path enforces the same capability the record path does
rather than a second one.

**Whether one category may tag both rows and columns is unstated.** If `clinical` tags records and
columns alike, one grant does both jobs, and someone without it reaches non-clinical records and
sees non-clinical columns within them. That coupling is probably right, since anyone who may read a
clinical record may read its clinical columns. It needs saying either way, because the alternative,
typing categories into row-categories and column-categories, is a schema change rather than a
configuration one. **A management interface needs the distinction even if enforcement does not**: an
owner granting a column-scoped category should be told that is what they are granting, and Usher
cannot say so if only the adapter knows. That is the same argument that put `display_name` here.

**Name a column category for the data, never for the audience.** A category called `clinician` names
who may see it, and one category per audience is role explosion wearing a category's clothes.
`identifying` or `clinical_detail` names a property of the data, which is what every other category
does, and leaves who may see it to the grants.

**Masked or absent is left open above, and the design answers it elsewhere.** A masked column
discloses that something is there; an absent one discloses nothing. A refusal does not confirm the
data exists, applied one level down, says absent.

---

## Use case: private data sharing

### The primary scenario

A user submits data. That data is private by default: invisible to everyone except the submitter.
The submitter, or an administrator on their behalf, can grant specific other users access. Those
other users may belong to entirely different groups; belonging to a group is not a prerequisite for
receiving a direct grant.

In Usher's model:

- The submitted dataset is a **resource**.
- A `private` category is associated with that resource.
- The submitter holds a grant on `private` in that resource, at whichever role the instance gives a
  submitter.
- Granting another user access means writing them a grant on `private` in that specific resource, at
  the role that access calls for.
- The user loses their category grant when it is revoked, immediately triggering the revocation
  propagation path.

This is peer-to-peer sharing mediated by an administrator in the first version. Delegated
self-management by the submitter (without administrator involvement) is a later permission.

### Submitters and owners

Submission and ownership are distinct roles that can overlap but do not have to.

**Submitter:** a role carrying permission to write to a resource, named on a grant like any other.
Uploading also records who uploaded, immutably and separately, which is provenance rather than a
role: it never changes and it outlives the role being revoked.

Holding the role does not carry management rights. A submitter who has not been designated as owner
cannot grant access to others, change visibility policy, or share records.

**Owner (resource-level):** a designated role on a specific resource that carries management
rights: granting and revoking access for other users, setting visibility policy, and transferring
ownership, all scoped to that resource only.

Visibility policy is private or public at the resource. **Embargo is not a third value here**, even
though it reads like one: the recorded requirements put it below the resource, with several segments
carrying separate deadlines, so a resource-level flag cannot express it. See the embargo item in
[roadmap.md](../roadmap.md).

**Owning a resource carries no access to its data.** Owner is a control-plane role, so it says who
may reach the records and never that the owner may. An owner who reads them holds a data-plane role
and a category grant for each category, the same as anyone else, and in practice usually does,
because an owner is usually also the submitter. That is two roles held by one person rather than one
role implying the other.

Keeping it that way is what makes governing without holding a principle rather than an exception: it
is the property a custodian needs in order to govern a community's data without reading it, and a
model where one role skips the category check and another does not has no principle, only a list. An
instance that wants owners to read what they own applies that when the owner role is assigned,
creating the data-plane role and grants alongside it, where the access is visible in the grant record
and revocable on its own.

Ownership is optional and per-resource. An Owner need not be the submitter: a Principal
Investigator may be designated as owner for data submitted by a lab technician on their team.
An Admin holds no standing data access and may grant it to themselves explicitly, which needs no
approval in MVP and will need one once community custodianship exists. Granting access to _others_
is a control-plane act and belongs to these management roles, never to a data-plane role like
`viewer` or `curator`. See the admin-authority decision in [decisions.md](decisions.md).

The three management roles, ordered by widening scope rather than by seniority, since a reader
meets the narrowest first and central control is not the model's starting point:

| Role             | Scope                             | Data access                    |
| ---------------- | --------------------------------- | ------------------------------ |
| Owner            | Their designated resource(s) only | None from ownership            |
| Custodian (OCAP) | One category across all resources | No (unless separately granted) |
| Admin            | All resources; the policy store   | None standing; self-grant only |

**Naming.** The OCAP role is a **Custodian** rather than a Steward, because the requirements
document already uses "Data Steward" for the resource owner, and before this rename the second
sense ran through the ownership cascade below as a synonym for owner. The two readings contradicted
each other on scope (one category platform-wide against one resource) and on data access (none
against automatic viewer access), so a reader meeting the cascade first concluded the OCAP role was a
co-owner of a resource, which is its inverse. Cascade usages now say owner or management rights,
and `Custodian` means only what the table above defines.

**Ownership assignment at submission time (resolved).** Lyric can create a cohort and designate
the submitter as its owner at submission time, if the submitter holds owner-level
permissions. Cohorts do not need to exist in Usher before the first submission: the submission flow
creates the cohort and optionally elevates the submitter to owner in a single operation.

For submitters who are not owners, an admin designates an Owner separately after the
resource is created. The submission proceeds regardless; owner designation is an additional
step.

The Lyric service account permission set needs to include cohort creation on behalf of a
owner-level submitter as a first-class operation, distinct from the basic `resource.create`
path. See [admin-model.md](admin-model.md) for the service account model.

### Ownership cascade and invariants

Every resource must have exactly one owner at all times. Ownership is determined by the following
cascade, applied in order:

1. **Default:** the submitter becomes the owner.
2. **Manual assignment:** the submitter can designate a different owner at submission time, or
   transfer ownership afterward.
3. **Cohort-level config:** a cohort can specify a fixed owner entity (e.g. an institutional
   account). Whether submitters in that cohort automatically receive ownership is a separate
   per-cohort flag.
4. **Last-owner promotion (safety net):** if all but one of the users holding management rights on
   a resource are removed, the remaining one is automatically promoted to owner. This is a
   data-integrity backstop, not a routine path. **Superseded by the move to ownership as a non-empty
   set**, where the invariant blocks removal of the last owner and leaves no case for this to
   repair; see the ownership item in [../roadmap.md](../roadmap.md).

`submitter` is immutable audit data on the resource record. It records who uploaded the data and
never changes regardless of ownership transfers. `owner` is a role that can move.

**No-owner invariant.** Operations that would leave a resource without an owner are blocked. If a
resource becomes ownerless through an abnormal path (data migration, database inconsistency), the
system must notify the system administrator. The admin may optionally make the resource temporarily
invisible to consumers without resetting existing grants: consumers who already held access retain
their grants, but the resource does not appear in results until the invariant is restored. This
suppression is distinct from embargo or category restrictions; it is a system-level state flag, not
a change to any user's grants.

**Transfer-before-removal prerequisite.** Removing the owner role from its current owner requires
transferring ownership to another entity first. This ordering is enforced by the system: ownership
transfer must complete before the removal is permitted. There is never a window where a resource
has no owner during a normal ownership change.

**Atomicity.** An operation is atomic when it either completes entirely or does not happen at all;
no intermediate state is observable or persisted. In the last-owner promotion case, removing the
departing owner and promoting the remaining one execute in a single database transaction. If
anything fails mid-operation, the whole transaction rolls back: the resource always has an owner.
_Disambiguation:_ [atomic](glossary.md#atomic)

The transfer-before-removal ordering makes strict atomicity a safety net; in the normal flow,
ownership is always settled before ownership changes.

**Config flag.** Whether ownership can be transferred without the current owner's consent
("ownership stealing") is configurable. The default is that only the current owner can initiate a
transfer. The config hierarchy:

- Usher-wide default: ownership transfer requires owner consent
- Per-cohort override: can tighten or loosen relative to the Usher-wide default

When transfer-without-consent is disabled, removing the owner role becomes impossible
for non-admins because the prerequisite (ownership transfer) cannot be triggered. The ownership
config is cohort-level with Usher-wide defaults.

**Admin override.** System administrators can perform ownership transfers regardless of the config
flag. This is an unconditional permission; the flag restricts regular users and automation, not
admins. Admin ownership transfers are logged as `admin.override` audit events (see
[audit-events.md](audit-events.md)).

### No system-wide access to private data

Private data is private to its resource. There is no role, flag, or permission that grants a user
visibility across all private resources platform-wide.

This applies to admins. An Admin can manage grants but does not hold implicit
data access. Being the administrator of the authorization system is explicitly separated from being
a reader of the data that system protects. An administrator who needs to access a specific resource
must be granted access through the standard grant flow, and that grant is auditable.

This separation means:

- Support staff managing permissions cannot read the private data they are granting access to.
- No "superuser" bypass exists at the Usher layer for reading private records.
- Any user who can read private data in a resource holds an explicit, traceable grant for it.

The adversarial framing: if an Admin account is compromised, the attacker gains the ability to
grant themselves access, but that grant is logged. They do not have silent, unlogged access to all
private data by virtue of the admin role alone.

admins can enumerate all resources platform-wide for operational purposes (permission
management, audit, troubleshooting). That listing permission does not extend to reading,
downloading, or sharing resource data.

---

## The shape instance governance takes

Who may do what is an instance's decision rather than Usher's, and the arrangements differ per
project. The machinery they are built from does not, and the common shape is two groups holding
different roles in the same resource, split along the plane boundary.

| Group                                       | Role carries                            | Plane   |
| ------------------------------------------- | --------------------------------------- | ------- |
| the people who put data in                  | read and write permissions over records | data    |
| the people who decide who else may reach it | permissions to assign and revoke        | control |

**The split is what makes the arrangement safe rather than merely tidy.** Someone uploading data
gains no say over who else reads it, which is the property a community governance requirement needs.
The two groups overlap freely: a person can be in both, holding a role at each plane,
which is two roles rather than one role that implies the other.

**The default owner is the person who created the resource**, per the ownership cascade above, and
in practice that is usually whoever submitted first. Adding others to the writing group lets them
contribute without acquiring any of the deciding group's authority.

Nothing here is new machinery. It is `groups`, `grants` and the plane split, arranged.
What each instance decides is how many groups, what to call them, and which permissions each role
carries.

## Use case: OCAP-compliant instances

OCAP (Ownership, Control, Access, and Possession) is a framework developed by the First Nations
Information Governance Centre (FNIGC) asserting Indigenous data sovereignty: communities own their
data collectively, control how it is collected and used, can access it at any time, and must
possess it, meaning the mechanisms of custody and stewardship are under their control, not
delegated to outside institutions. See https://fnigc.ca/ocap-training/ for the canonical
definition.

Any Overture instance handling Indigenous health data, genomic data, or community-held research
data is required to honour OCAP. The authorization model is directly load-bearing for compliance.

### How the generic model supports OCAP

**Granular categorization.** `categories` can represent any access dimension, including
`indigenous_data` as a category distinct from `controlled_access`. These are independent axes;
access to one does not imply access to the other.

**Deny by default.** Records tagged `indigenous_data` are hidden from any user without an explicit
grant for that category, regardless of what other access they hold.

**Rapid revocation.** The push+poll revocation channel and the fail-secure grace period mean that
a revoked grant propagates to all enforcing adapters within a bounded window. If a community
withdraws consent for a researcher's access, the revocation is effective promptly, not deferred to
token expiry.

**Audit trail.** `granted_by` on `grants` records who granted access and whether the
grant was internal or externally originated. This is the baseline for a sovereignty audit: who
approved what, when, and on whose authority.

### Custodianship: the additional OCAP requirement

The generic admin model (platform-level administrators who can manage all grants) is insufficient
for OCAP. Custodians of Indigenous data, community members or designated representatives with authority
over their community's data, must be able to manage grants for their category without holding
platform-wide admin rights.

In Usher's terms: a user can hold a custodianship.hold permission scoped to one or more data
categories. Within those categories, they can grant and revoke access as if they were an Admin,
but only for the categories they hold custody of. They cannot see or modify grants for other
categories, and they cannot modify resource structure or role assignments.

This permission dimension is not yet in the data model. Its design (how custodianship scope is
stored; the permission check in the PAP layer) is an open question and a prerequisite for
OCAP-compliant instances. See Open questions.

### What OCAP does not require Usher to change

OCAP does not prescribe how data is stored, indexed, or structured. It prescribes who controls
access decisions. Usher's model-agnostic approach (categories are named; field mappings are
instance config) means that OCAP-compliant and non-OCAP instances use identical Usher code.
Compliance is a function of how the instance is configured and administered.

---

## Category management

### Choosing a resource's categories

**Saying which kinds of data a resource contains is part of creating it**, the way naming it is.
Whoever creates the resource makes that choice, and it holds until an owner changes it.

**`open` is an ordinary choice, and often the right one.** A resource whose only category is `open`
is one anybody can reach, and that is a complete and normal answer rather than a resource that
somebody forgot to restrict. Categories describe what the data is; they are not a scale of severity
with `open` at the bottom of it.

**An instance can suggest, and the suggestion is shown rather than applied.** An administrator may
configure a starting set for new resources, for example that new ones usually contain controlled
data. Whoever creates a resource sees that suggestion and confirms or changes it. It never lands on
its own, because a category nobody chose is indistinguishable afterwards from one somebody meant.

**An owner can change the set later.** This updates `resource_categories` in Usher's own store. The
submitted records are untouched: Usher enforces by filtering at the point of a query, never by
modifying data. Every change is audited in both directions, and what it does to people already
holding grants is covered below.

**Note: a resource with no categories cannot be created.** The choice is required rather than
defaulted, so skipping it is not an available path. Should one exist anyway, through migration or an
inconsistency, it is invalid: it is not queryable, and it is flagged as needing categorization rather
than treated as open. That last part is the whole reason the choice is required, since a resource
carrying no categories would otherwise be reachable by everyone by omission.

**Consequence for the submission path.** A submission service cannot create a resource as a side
effect of ingest, because it would have to choose categories on somebody's behalf or skip the choice.
Data is submitted into a resource that already exists and is already categorized. See the submission
items in [../roadmap.md](../roadmap.md).

### Category change propagation

When a cohort's category assignment changes (a category is added or removed), the effects on
existing users must be handled explicitly.

**Tightening (adding a category).**

Users who are members of the resource but do not hold a grant for the new category will have
records filtered from their queries at the next Usher token refresh. No revocation action is
needed from the user's side: the filter takes effect automatically. However:

- Affected users must be notified. Silent tightening is unacceptable: a user who received records
  in one query and no longer receives them in the next should understand why.
- Owners who want to pre-grant affected users before the change takes effect can do
  so via the standard grant flow before updating `resource_categories`.
- The tightening event must produce a structured audit log entry: which category was added, which
  resource, by whom, and when. The set of affected users must be derivable from this entry combined
  with the current `grants` table.

**Loosening (removing a category).**

Users previously filtered by the removed category are no longer filtered at the next token refresh.
No active revocation is needed. Records that were previously excluded become visible to all members
who hold grants in the appropriate resources.

Loosening a category with OCAP or governance implications (removing `indigenous_data` restrictions,
for example) is a governance decision and carries the same audit rigour as tightening. The fact
that loosening requires no technical revocation does not reduce its administrative weight.

Every change to `resource_categories` produces a structured audit event regardless of direction,
recording: actor, resource, category added or removed, direction, and timestamp.

### Embargo

> **Status: open, and scoped rather than designed.** What follows is what a working design has to
> satisfy, and the approach already ruled out.

An embargoed resource is private until a specified date, after which it becomes visible at whatever
access tier applies to it.

**Rejected: a grant on a `private` category carrying `expires_at`, with the grant's expiry
releasing the data.** Whoever held the grant loses access when it ends, so the submitter loses
their view and nobody gains one: the resource still carries `private` and no one holds a grant
naming it. The deadline also sat on the wrong object, belonging to the embargo state rather than
to any principal's grant. See [decisions.md](decisions.md) § A grant's expiry is resolved before
the token is written, which records expiry as a scheduled subtraction and nothing else.

**What a working design has to satisfy.** Four requirements, none of them met today:

1. **Embargo is a state, not a grant.** It says a group of records is not released yet. Grants on it
   are ordinary grants, and the deadline belongs to the state.
2. **It has to reach below the resource.** A resource can hold several embargoed segments at once,
   each with its own deadline, so a single release date on a resource does not express it.
3. **The segment has to be identifiable by the enforcing adapter.** Nothing in a record says it is
   embargoed, so the collection is a governance definition that the adapter must be configured to
   compute, the way it is configured to compute any other category.
4. **Access within an embargoed segment varies by principal.** A submitter, an owner and a
   collaborator can hold different access to the same embargoed records, so the state cannot be a
   simple visible-or-not flag.

**What is settled and can be relied on meanwhile.** Category grants expire, and an instance needing
time-bounded access has that mechanism today. What it does not have is a release: expiry ends one
principal's access and never opens data to another.

**Default visibility.** The framing "data is public by default unless the submitter sets an
embargo" describes the current iMS production data for existing submissions only; it is not
the intended permanent model. The intended model: access level (who can read, under what conditions)
is defined per submission, at submission time or afterwards by an authorized administrator or owner.
Future submissions will carry explicit access restrictions, not just an embargo toggle on
otherwise-public data.

In Usher's model this is consistent with deny-by-default: a newly created resource has no grants
until the submission service (Lyric) adds the user to the resource and creates the category grants at
ingest. "Open access," "embargoed," and "restricted" are all explicit access-level choices set
at submission time, not a global default. Usher enforces whatever the submission service assigns.

Enforcement must exist at both the submission layer (Lyric) and the retrieval layer (Arranger);
gating only one leaks through the other. See [adapter-integration.md](adapter-integration.md).

---

## Open questions

These questions require deliberate answers before the relevant implementation work can begin. Most
have OCAP, legal, or cross-application implications and should not be resolved by a single
developer in isolation.

### Overlapping cohort access: any or all

A data record can belong to multiple cohorts simultaneously. When a user holds a grant in cohort A
but not cohort B, and a record belongs to both:

- **Any:** the user sees the record (a grant in any one cohort the record belongs to is
  sufficient). More permissive; risks exposing records the user was not explicitly granted
  across the overlapping cohort.
- **All:** the user does not see the record (a grant in every cohort the record belongs to is
  required). Aligns with deny-by-default; more conservative.

**Where records cannot overlap, the question is moot but not closed.** An instance whose data
model gives each record exactly one resource makes overlap structurally impossible, and neither
rule then produces a different result. That is the case for the first integration, recorded on
that side. It does not answer the general question, which stays open for instances where a record
can satisfy the resource predicate of more than one resource at once.

Where private data sharing is the primary access gate, the any rule may be acceptable if categories
are the real enforcement mechanism. The question needs a deliberate answer before the first
instance where overlap is structurally possible, and confirming that a given instance's records
cannot overlap is part of onboarding it rather than something to assume.

### Multi-category intersection access

**Resolved for MVP, re-checked against the resource-level decision.** Per-resource
scoping dissolves the primary concern: a `controlled` grant for COHORT_A and an `indigenous` grant
for COHORT_A are distinct entity records, each approved by the relevant governance body for that
specific resource. Holding both within the same resource means both bodies have approved access to
their respective category within that resource. No special intersection grant is needed.

Categories attach to resources rather than to individual records, so a resource carrying both
categories requires both grants and the question does not reach record level at all.

The OCAP concern (was each governance body's grant intended to cover the intersection?) is
addressed by the per-resource scoping: each grant is scoped to the resource, not to a category
in isolation. A record in that resource tagged with multiple categories requires all corresponding
grants.

**Post-MVP extension: SQON-scoped grants.** If a governance body needs to approve access to a
specific subset of their category (e.g. "indigenous records from community X only"), a grant can
optionally carry a SQON filter expression that further narrows the records it covers within the
category. This is a data model extension (an optional `sqon` field on `grants`); it
requires SQON evaluation permission in the bridge and is deferred to post-MVP.

### Role permissions

**Resolved.** A role carries a named set of permissions, and `role_permissions` records which.
The permissions themselves divide by plane, which decides who enforces them: the controller checks
a control-plane permission on an admin call, and an adapter checks a data-plane one before a query
runs. The vocabulary and the roles at each plane are in
[../docs/atlas/roadmap/rabac-alignment.md](../docs/atlas/roadmap/rabac-alignment.md).

What stays open is which permissions each shipped role carries by default, which is a seeding
question rather than a modelling one.

### Category grant scope

**Resolved.** Category grants are always resource-specific. A grant for `indigenous_data` in
COHORT_A is a distinct entity from a grant for `indigenous_data` in COHORT_B. This is simpler and
more auditable; a broader scope grant would require careful design to avoid unintended access and
complicates OCAP governance (a custodian's authority spans resources, but each grant they issue
names one).

### Attribute naming

The top-level map name (`permissions`) and the per-resource fields (`role`, `categories`) are settled;
see [security-workflow.md: Token structure](security-workflow.md#token-structure) for the
canonical schema and worked examples. The remaining open question is field-level restriction
representation: attribute names for field restrictions (if included in the token at all) are not
yet decided. See [adapter-integration.md](adapter-integration.md).

### User groups design

`groups` and `group_users` are in the entity schema and carry no rows in the first release. Open
questions: how is a group's user list managed (PAP-only, or synced from Keycloak groups)? When a
user belongs to multiple groups with overlapping grants, how are those composed (union is the
natural answer, but must be stated explicitly)? Does removing a user from a group immediately
trigger revocation of that group's grants for that user?

**One of these is now answered.** Whether a group may hold a role of its own is settled as no: the
role is named on the grant, so a group supplies who a grant reaches and never what they may do. See
the grant-carries-the-role decision in [decisions.md](decisions.md).

### Write permissions (Lyric)

The grant model extends to write operations: a grant governing write access would allow the PEP
adapter in Lyric to enforce which records or fields a user is permitted to submit or modify. The
data model shape is clear; the Lyric adapter design is not. Deferred until Lyric integration is in
scope.

### Write vs read access

Does write access give read access? In the submission flow, write access is currently gated by
organizational affiliation: the submitter's `context.scope` entries determine which organizations
they may submit on behalf of. When a resource is created at submission time, the open question is
whether that submission event automatically creates read grants for the submitter, creates
restricted read access (a role only, no category grants), or creates no read access at all.

Three options with meaningfully different implications, particularly for consent-constrained data:

1. **Submitter reads own submissions.** Submission adds the submitter to the resource and creates full category grants
   for the submitter on the resource. Write access automatically grants read access. Simple for
   the common case; problematic when data is submitted on behalf of a community or patient where
   the submitter may not hold data access consent: a community liaison submitting on behalf of
   an Indigenous community does not automatically have consent to read individual members' records.

2. **Belonging to an organization grants read access.** All submitters in an organization can read
   records submitted by anyone in that organization. The organizational boundary is the read
   access unit. Wider automatic read surface area; may be appropriate for institutional cohorts
   but not for mixed or individual-consent data.

3. **No automatic read access.** Write access and read access are independently governed.
   Submission creates a resource registration and a provenance record, but does not create any
   Usher grants. Read access requires an explicit grant through the standard category grant flow.
   Most restrictive; most aligned with OCAP and consent-constrained scenarios; adds friction for
   the common case where submitters need to verify their submitted data.

**The requirement is now stated, and it has two independent axes.** A submitter should reach the
data they submitted, plus whatever they hold grants for, and should not reach what other submitters
contributed by default.

| Axis       | Requirement                                                                          | Mechanism                                                        |
| ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Provenance | A submitter reaches what they submitted, not what others submitted                   | **Not expressible: identity of the submitter is not a category** |
| Consent    | A submitter may not be entitled to read the sensitive content of what they submitted | Category grants, which MVP has                                   |

These do not substitute for each other, and conflating them is the trap. Provenance scoping does
not address the consent case at all: the community liaison submitted those records, so scoping
access to what they submitted hands them precisely the records in question. Only a withheld
category grant withholds those. Equally, withholding categories does not deliver provenance
scoping, since every submitter then sees the same uncategorized slice of the whole resource.

**Provenance scoping requires structure the model does not have.** Resources are a flat list with
no parent relationship, so there is no way to express that a submission belongs to a
study. Delivering it needs either a two-level resource relationship or record-level enforcement.

Three MVP paths, none yet chosen:

1. **Each submission becomes its own resource.** Delivers both axes without record-level
   enforcement: the submitter holds a grant on their submission-resource, and categories still
   gate the sensitive content within it. Costs the two-level structure, makes study-wide reader
   inheritance a real derivation rather than a free consequence of resource-level visibility, and
   grows the resource count with every submission.
2. **A study-wide grant on the open category alone.** Cheapest, and safe on the consent axis, but
   it delivers the opposite of the stated intent on the provenance axis: every submitter sees every
   other submitter's uncategorized data.
3. **No automatic read in MVP.** Read comes only from explicit grants. Violates nothing, delivers
   no convenience, and forecloses nothing. Provenance scoping then arrives with record-level
   enforcement.

**Where inheritance is expressed matters more than which path is chosen.** Any rule of the form
"existing readers of a study reach new submissions in it" must be evaluated when the request is
made, never written as grants copied onto the new submission at submission time. Copied grants
outlive the access that produced them, so revoking someone's study access leaves them reading every
submission made while they held it, silently. Copied grants are also already written when finer
granularity arrives later, making a narrowing into a data migration. A derivation can simply be
narrowed.

This decision affects: the Lyric service account model (what Usher operations does the service
account perform at submission time?); the entity schema (does submission create `grants` rows, or only a resource registration?); and whether the submitter's Keycloak
`sub` is available at submission time to bind those grants to a specific user.

**Note on identifier availability.** Current submission tokens carry `context.user.email` but not
`context.user.sub`. If option 1 or 2 requires creating grants bound to a specific user at
submission time, the Keycloak `sub` must be present in the token the submission service forwards.
This is a token schema change that must be coordinated with the IdP migration.

**Current state (iMS submission service).** Read authorization is not implemented: GET requests
bypass auth middleware entirely, `allowedReadOrganizations` is hardcoded empty, and read
controllers have no per-organization check. This is a confirmed implementation gap, not a
deliberate design choice. References:
[submission-service tech-debt](https://github.com/imicroseq/submission-service/blob/a7b6439aa420801939ab6190c75ff6de1ad6d8f9/.dev/tech-debt.md#L27-L29);
[ego-integration-current-state.md](https://github.com/imicroseq/submission-service/blob/main/.dev/docs/auth/ego-integration-current-state.md).

### Custodianship scoping

A user with custodianship.hold permission can manage grants for specific categories without
platform-wide admin rights. The data model for custodianship scope (which categories a custodian
governs) and the permission check in the PAP layer are not yet designed. This is a prerequisite
for OCAP-compliant instances and should be designed before the management UI work begins.
