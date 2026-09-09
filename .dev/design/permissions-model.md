# Permissions Model

_Status: in progress. The core model, visibility rule, grant composition, field-level restriction
options, OCAP considerations, and private data sharing patterns are documented. Resolved design
decisions are in their own section. Open questions are at the end._

This document defines what Usher tracks and how it uses that data to answer "what can this user
see?" It does not cover how those decisions are administered (see [admin-model.md](admin-model.md))
or how the token system works end to end (see [security-workflow.md](security-workflow.md)). The
OWASP threat model is in [security-threat-model.md](security-threat-model.md).

---

## Design approach

### Model-agnostic language

The permissions model uses generic terms: `resource`, `membership`, `category`. Domain-specific
names (`study`, `patient`, `cohort`, `dataset`) appear only in the management UI layer,
configurable per deployment, and in worked examples in this document.

In the Overture context, a resource is a **cohort**: a virtual grouping of records defined by
shared characteristics, not a siloed container. Unlike studies (where a record belongs to exactly
one study), cohorts can overlap: a record can belong to multiple cohorts simultaneously. In another
deployment the same concept might be called a dataset, a project, or a patient cohort. The
underlying model is the same.

The access semantics of overlapping cohorts are an open design question; see Open questions.

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

**Roles** capture coarse-grained capability: what kind of actions a user can perform (`owner`,
`member`). A role is a label for a class of behaviours.

**Attributes** capture contextual scope: which specific resources those actions apply to, and under
what data-category restrictions.

This combination avoids two failure modes:

- **Pure RBAC:** roles proliferate as rules become contextual. A platform with two roles and three
  data categories across five resources could require dozens of role combinations
  (`study-A-indigenous-member`, `study-A-non-indigenous-member`, etc.) to express the full
  policy space.
- **Pure ABAC:** without role abstraction as a simplifying layer, policy rules become difficult to
  manage and audit.

Two users can hold the same role in the same resource and have meaningfully different access,
depending on their data category grants. The role describes capability; the grant describes scope.

---

## Core concepts

### Resources

A resource is a named grouping of data. Resources are defined through the management UI by
administrators. In Overture deployments, a resource is typically a cohort; in other deployments it
might be a dataset, a project, or any other logical unit defined by the deployment.

Resources have data categories assigned to them. A resource with no categories assigned is fully
visible to all its members.

### Memberships

A membership records a user's role within a specific resource. A user must have a membership in a
resource before any data in that resource is accessible to them.

A user can hold multiple roles in the same resource simultaneously. Roles are coarse capability
labels, not a strict hierarchy; overlap is expected and valid. Effective permissions at constraint
resolution time are the union of all role capabilities across every membership the user holds in
that resource.

**Multiple roles per user per resource are supported; effective access is the union of all roles
held.** The grants computation engine must consult all of a user's memberships in a resource,
not just the first or highest-priority one.

### Data categories

> **Note:** categories remain independent, overlapping axes as described here; that
> is unchanged. What changed is how a grant set is rendered into a query filter. See the
> superseded notice under "The visibility rule" below.

A data category is a named access dimension. Categories are defined at the platform level and
assigned to resources. Examples: `indigenous_data`, `controlled_access`, `restricted_clinical`.

Categories are independent axes: holding a grant for one category does not imply holding a grant
for another, even within the same resource. What a category name means in terms of actual records
or fields is deployment configuration that lives in the enforcement plugin, not in Usher.

### Category grants

A category grant is an explicit record: this user may access records tagged with this category
within this resource. Without a grant, access to categorized records is denied. Deny by default is
a fundamental invariant: membership in a resource alone is never sufficient for access to
categorized records or fields. The absence of a grant is always a denial.

Grants are additive. A user's effective access to a resource's categorized data is the union of
their personal grants and any grants held by groups they belong to.

Grants have two origins:

- **Internal:** created by an administrator through the management UI. Usher owns the full
  lifecycle.
- **External:** originated from a GA4GH Passport `ControlledAccessGrants` Visa, validated by
  Keycloak and mapped to a `category_grant` automatically. Usher inherits the Visa's `expires`
  timestamp as `expires_at`. See [concepts.md](../../docs/concepts.md) for the full GA4GH Passport
  flow.

Local administrators can revoke an externally-originated grant. Local policy can always restrict
access downward; it cannot grant access that no Visa covers. The `granted_by` column records the
origin (internal admin ID or external Visa issuer identifier) for auditability.

**Grant expiry.** The `expires_at` field supports time-limited grants. When a grant expires, the
revocation mechanism fires: the same path as a manual revocation, with the same fail-secure grace
period. The researcher must re-authenticate to resume access. This keeps revocation behaviour
consistent regardless of whether a grant was revoked manually or lapsed naturally.

### User groups

User groups are a first-class entity: a group can hold memberships in resources and hold category
grants directly, independent of any individual user's grants. A user's effective access is the
union of their personal grants and all grants held by groups they belong to.

Groups exist to make administration tractable at scale: granting access to a research team should
be one operation, not one per team member. In deployments using GA4GH Passports, a Keycloak group
membership can be mapped to a Usher group automatically, allowing institutional group affiliations
to propagate without manual management.

**Design gap.** User groups are not yet fully designed. The entities below are placeholders; the
open questions are in the Open questions section.

---

## Entity schema

The logical model. Specific column names, types, and indexes are not yet specified: see the
database schema design item in the roadmap.

```
users                  (id, idp_subject, email, display_name)
user_groups            (id, name, description)
user_group_members     (user_id, group_id)
resources              (id, name, description, created_by, created_at, updated_at)
roles                  (id, name)
data_categories        (id, name, description)
resource_categories    (resource_id, data_category_id)
memberships            (user_id, resource_id, role_id)
group_memberships      (group_id, resource_id, role_id)
category_grants        (user_id, data_category_id, resource_id, capabilities, granted_by,
                        granted_at, expires_at, status)
group_category_grants  (group_id, data_category_id, resource_id, capabilities, granted_by,
                        granted_at, expires_at)
pending_grants         (id, email, data_category_id, resource_id, capabilities, granted_by,
                        granted_at, expires_at)
```

**`capabilities` is the grant's second dimension, and the store is where the token's pairs come
from.** A grants token pairs each category with what the holder may do with it, so a grant records
both the category and the capabilities conferred on it. Whether that is an array column or a join
table is a physical-schema question rather than a logical one; the dimension itself is not
optional, because without it the token has nothing to render.

**Three entities are deliberately absent rather than overlooked.** Naming them here is worth more
than their omission reading as oversight:

- `revocations`. The propagation mechanism is designed in
  [security-workflow.md](security-workflow.md); what is unsettled is whether a revocation is a
  single timestamp or a history, which decides the reinstatement semantics.
- `audit_log`. Its events and common fields are catalogued in
  [audit-events.md](audit-events.md), and the open question is retention against erasure rather
  than shape.
- **A per-principal last-policy-change timestamp**, which the fast path compares a token's
  `generatedAt` against. It has no home in this model, and naming exactly which writes update it is
  a launch blocker rather than a detail. See the blocker list in
  [../docs/phase-1.md](../docs/phase-1.md).

**Every resource carries at least one category, so `resource_categories` is never empty for a
live resource.** A resource's unrestricted portion is a category like any other, which is what
removes the need for a baseline outside the category system. The consequence is that a resource
with no categories is ungrantable, since a grant would have nothing to name.

**User identifier discipline.** `users.id` is the Keycloak subject (`sub` claim from the OIDC
token). It is the only user identifier used in `memberships`, `category_grants`, audit records,
and all API surfaces. `users.email` is stored for display purposes only and is never used as a
lookup key. The one exception is `pending_grants`, which is keyed by email address for grants
sent to users who have not yet registered.

**`category_grants.status`** tracks the acceptance state: `awaiting_acceptance` or `active`. A
grant created while auto-accept is enabled is written directly as `active`. When auto-accept is
off (the default), the grant is written as `awaiting_acceptance` and does not appear in grants
tokens until the grantee explicitly accepts. See the pending grant state machine below.

**`pending_grants`** stores invitations sent to email addresses that do not yet correspond to a
registered user. The invited address is a placeholder held only until the grant can attach to a
Keycloak subject, and it is discarded once one exists.

The invitation link is what performs that attachment, and it binds the grant to **whichever account
the recipient confirms with**. Three paths reach the same place:

1. The recipient registers using the invited address. Registration triggers a lookup by that
   address.
2. The recipient registers using a different address. The link, not the address, carries the
   binding, so the grant still attaches to the account they created.
3. The recipient already has an account, under the invited address or another one. Confirmation
   happens after they log in.

Matching rows are migrated to `category_grants` with status `awaiting_acceptance` under the
account's Keycloak subject, and the `pending_grants` row is deleted after migration. Since an
account may hold more than one verified address, a lookup by address matches any of them, and only
a verified address may bind a grant: otherwise claiming an address would be enough to collect
grants intended for whoever holds it.

### What these entities render into

The tables above are the store; a grants token is what a query of them produces for one principal
and one application. Showing both is the point of putting the example here, since neither the store
nor the token alone shows how a row becomes something a plugin can enforce.

Two `category_grants` rows on `HEART_STUDY` and one on `LUNG_COHORT`, held by the same user, render
as:

```json
"grants": {
  "HEART_STUDY": [ { "open": ["view", "download"] },
                   { "controlled": ["view"] } ],

  "LUNG_COHORT": [ { "open": ["view"] } ]
}
```

Four properties of the mapping, each of which the store has to support and does:

- **One row, one entry.** A grant is a row, and the list preserves that rather than flattening
  several rows into one aggregate.
- **`capabilities` comes straight across.** This is what the column exists for; without it the
  entries could name a category and nothing else.
- **`role_id` does not appear.** A role resolves to capabilities before the token is written, so
  `memberships` feeds the entries without being represented in them.
- **A resource with no grants is absent, not empty.** There is no row to render, and absence already
  means no access, so nothing needs to say so.

Standard JWT claims and the anonymous form are in
[security-workflow.md](security-workflow.md#token-structure), which is authoritative for the wire
format. This section is authoritative only for how the entities above produce it.

---

## Pending grant state machine

A category grant passes through the following states before becoming active. The state applies to
grants for individual users; group grants do not have an acceptance step (groups are managed by
admins, not self-selected by individual users).

```
[admin creates grant for unregistered email]
  -> pending_grants (keyed by email)
     |
     | [user registers; IdP event triggers migration]
     v
  awaiting_acceptance (category_grants, status = awaiting_acceptance)
     |
     | [grantee confirms acceptance via portal flow]
     v
  active (category_grants, status = active)
     |
     | [admin revokes, or expires_at fires]
     v
  [removed / revocation propagates]
```

When auto-accept is enabled:

```
[admin creates grant for registered user]
  -> active (category_grants, status = active; no awaiting_acceptance step)
```

**What each state means for grants token issuance:**

- `pending` (in `pending_grants`): never appears in any grants token. The user has no grants
  token entry for this resource/category until they register.
- `awaiting_acceptance`: never appears in a grants token. The user sees no content change; they
  can view the pending invitation through the portal but have no access to the categorized data.
- `active`: included in the grants token at the next token exchange. The plugin enforces access.

**State transitions are audited.** Each transition (creation, acceptance, migration from pending,
revocation) produces an audit log entry.

**Claiming a pending grant from an existing account.** The migration above fires on registration
keyed to the invited address, which leaves a gap: an invitee who already holds an account under a
different address never triggers that event, so the pending row waits indefinitely with nothing to
resolve it.

An invitation link closes that gap, under one constraint that is the whole design: **the link binds
identity and never creates or activates a grant.** Its only function is to answer which account
belongs to an already-approved invitee, moving the row from `pending_grants` to `category_grants`
under that account's Keycloak subject. The approval that produced the grant is unchanged, and the
acceptance step that activates it still applies. An invitee may either sign in with an existing
account or register a new one; both routes end at the same identity binding.

The link is single-use and short-lived, and the binding-not-granting rule is what makes those
sufficient rather than merely advisable. If a link could activate access, the invited mailbox would
become the authorization boundary, and a forwarded message or a compromised mailbox would transfer
access to controlled data: a materially weaker gate than the Controlled tier requires everywhere
else. Binding identity leaks nothing, because an account that binds to a grant it was never
approved for still holds no approval.

Group grants have no acceptance step, so this path applies only to grants issued to an individual
address.

---

## How access is resolved

### The visibility rule

A record is visible to a user when the user holds a grant for every data category the record's
resource carries. Stated the other way round, a record is hidden when the resource carries any
category the user does not hold.

> **Scope: this section describes record-level enforcement, which is post-MVP.** It assumes
> categories map to per-record predicates and that records within one resource are individually
> tagged. MVP enforces at resource level instead, so a principal lacking any single category the
> resource carries sees nothing in that resource rather than a filtered subset of its records. The
> same applies to the worked example below, to "Composition across categories" and to
> "Category-to-field mapping". See "Resource-level enforcement for MVP" in
> [decisions.md](decisions.md), which also records the two constraints that govern this work when
> it is picked up.

The existence-denial invariant below holds under either model, since both filter before any result
is computed.

The grants token carries only what the user holds: a list of grants per resource, each naming one
category and the capabilities held on it. A category the user does not hold is simply not named,
which follows the same positive-grant convention as OAuth scopes, UMA permissions and GA4GH Visas,
and discloses nothing about what exists.

**Nothing is subtracted.** Each grant renders a positive predicate and those compose with `or`, so a
record the user cannot reach is one that no predicate selects. There is no full category set to
subtract from and no exclusion filter, because a grant list is never read as an exemption from a
default. An earlier version of this document described the opposite, computing exclusions from a
resource's configured category set, and the two readings give the same answer only sometimes.

Excluded records do not appear in counts, aggregations, or result sets; their existence is not
disclosed. This is a hard invariant: existence revelation is an information disclosure vulnerability
(OWASP A01), and a discoverable-but-inaccessible mode will not be introduced.

**What the invariant requires of a denial response.** A denial says the resource does not exist **or** the requester lacks access, without indicating which. Distinct responses turn the endpoint into a
lookup service: someone enumerating identifiers learns the deployment's holdings without reading a
record.

**This is oracle denial rather than deterrence, and the difference decides the implementation.**
Deterrence would be satisfied by the wording alone. Denying an oracle means every channel that
distinguishes the two cases has to be closed.

**Under the default shape below, most of that closes itself, and the table is a deviation
checklist rather than a to-do list.** Where denial is a filter matching nothing, body and timing
converge structurally, so the only row still requiring attention is side effects. Read the table as
what must be re-verified by hand the moment a response shape is chosen that does not converge on its
own:

| Channel | How it leaks |
| ------- | ------------ |
| Response time | A denial that performed a grant lookup is slower than one that short-circuited on a missing resource |
| Body shape | Same status, differing structure or fields |
| Side effects | One path emits an audit event or moves a rate-limit counter; the other does not |
| Downstream behaviour | Differing cache headers, retry semantics, or `Vary` |

Timing is the one that usually survives review, because a denial is not thought of as having a body
worth measuring.

**Calibrate ambiguity to what the requester already knows.** Opacity is owed to a requester who does not already know the resource exists. Where they demonstrably do, because they hold a lapsed grant, a
pending grant, or a membership without the category needed, the response can say exactly what
happened. Nothing leaks, since they were told it exists when the relationship was created, and an
attacker reaches that state only if someone granted them the relationship.

Without this calibration the invariant is paid for by legitimate users: a lapsed grant is a normal
and frequent state in a model with expiry and an acceptance flow, and hiding it behind a
does-not-exist wall generates support load and teaches people the system is broken.

**Ambiguous outward, precise inward.** The denial reason recorded in the audit trail distinguishes
the cases even though the response does not. That is what the reason field on the deny result is
for, and it is how an operator debugging a service account resolves what a status code deliberately
will not tell them.

**Consequently the response shape is a choice among indistinguishable shapes**, not an open one. A
plugin picks which shape suits its service; it does not get to pick whether the two cases are
distinguishable.

**An empty result set achieves this for free, and should be the default.** Where a
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
a requester with no relationship to the resource, where ambiguity is owed and is free. A specific
response for a requester who demonstrably knows the resource exists, where ambiguity buys nothing
and costs support load.

The practical consequence for an adopter: a seam that can only return a filter can only ever produce
the first half. Widening it is worth doing for the second half, and not for the ability to return a
particular status code. A widening motivated by the status code alone will produce two
distinguishable denials and reintroduce the oracle the empty result had closed by construction.

**A deployment can defeat all of this through its resource mapping alone, with the enforcement path
entirely correct.** The denial response protects resource existence. If resource identity is
already enumerable through an unauthenticated surface, that protection is decorative: no timing
analysis or status-code inference is needed, because a public endpoint answers the question
directly.

The general rule is about the resource key's **value space**, not about any one surface: **where a
resource's existence is confidential, the values identifying resources must not be enumerable
without authentication.** A resource key mapped one-to-one onto something a deployment publishes by
design is the clearest way to break this, and it is a legal configuration today, since one resource
per type is a permitted special case of many-per-type. Other routes exist: values appearing in
public facet listings, in a published schema, or in URLs.

**The condition matters, because this is not universal.** Many platforms publish their study
registry, and where resource existence is already public there is nothing to protect and nothing is
lost. It bites where existence is meant to be confidential, and this model has such a case built in:
an embargoed resource is precisely one whose existence should not be discoverable before release.

**Enforcing this needs two different mechanisms, because enumerability is only half statically
knowable.** A startup check covers only half of it: a check can read configuration, and
configuration does not say whether a surface applies the filter it should.

**Structurally public, so a startup check.** Where the resource key is one-to-one with something the
deployment publishes by design, the values are public whatever the enforcement path does. That is
readable from configuration before any request arrives, and it should fail startup rather than warn,
because no request-time behaviour repairs it.

**Behaviourally leaky, so a conformance case per surface.** Any surface that can return resource
values, a facet or aggregation, a suggestion or type-ahead, a published schema, is supposed to apply
the filter and might not. Whether it does is a property of the code, not of the configuration, so a
startup check cannot see it and enforcement tests on the record path do not cover it.

**The failure mode this guards is a surface exempting itself from a correct filter.** An adopter
found exactly that: an aggregation wrapper that discarded the access filter along with the search
query and returned whole-index counts, while the record path was entirely correct. It was found by
running a query and comparing counts, not by reading code, and it stood undetected for some time.

So the conformance corpus needs a case per value-returning surface, comparing what an under-
privileged principal sees against what a fully-privileged one sees, rather than only asserting that
records are correctly filtered. A deployment can pass every record-path test while publishing its
resource values through a documented feature working exactly as designed.

### Worked example

**Setup:**

Resources and their category assignments:

- `RESOURCE_X` has `data_categories: [indigenous_data]`
- `RESOURCE_Y` has `data_categories: [open_access, indigenous_data]`

Users and their grants:

- User A: membership in `RESOURCE_X`, granted its open category only
- User B: membership in `RESOURCE_X` granted both its categories; membership in `RESOURCE_Y`
  granted its open category only

Plugin config (Arranger-side; maps category names to Elasticsearch field predicates):

```
indigenous_data → { fieldName: "isIndigenous", value: true }
open_access     → { fieldName: "isRestricted", value: false }
```

**Grants token for User A:**

```json
{
	"sub": "user-a",
	"aud": "example-service",
	"iat": 1720000000,
	"exp": 1720000300,
	"generatedAt": 1720000000,
	"grants": {
		"RESOURCE_X": [ { "open_access": ["view"] } ]
	}
}
```

`RESOURCE_Y` is absent, so User A reaches nothing in it.

For `RESOURCE_X`, one grant is held and it names `open_access`, so one positive clause is emitted:
`isRestricted = false`. Records carrying `indigenous_data` match no clause and are therefore never
selected. Nothing is subtracted and no exclusion is computed: the records User A does not reach are
the ones no grant of theirs names. Their queries never reveal that indigenous records exist, since
those records are absent from results, counts and aggregations rather than filtered out of them.

**Grants token for User B:**

```json
{
	"sub": "user-b",
	"aud": "example-service",
	"iat": 1720000000,
	"exp": 1720000300,
	"generatedAt": 1720000000,
	"grants": {
		"RESOURCE_X": [ { "open_access": ["view"] }, { "indigenous_data": ["view"] } ],
		"RESOURCE_Y": [ { "open_access": ["view"] } ]
	}
}
```

For `RESOURCE_X`, two grants are held, so two positive clauses are emitted and composed with `or`:
`isRestricted = false` or `isIndigenous = true`. User B reaches both portions and their overlap,
which is what holding both grants means.

For `RESOURCE_Y`, one grant is held, so one clause is emitted: `isRestricted = false`. The
indigenous records in `RESOURCE_Y` are unreachable, for the same reason as User A's in `RESOURCE_X`
and by the same mechanism.

**The contrast worth holding on to.** Neither user's unreachable data is excluded by a clause. It is
unreachable because no clause selects it, which is what additive rendering means and is the whole of
the rule. There is no full category set to subtract from, and a grant list is never read as an
exemption from a default.

The token examples above use the canonical `grants` map structure. For the full token schema,
standard JWT claims, and anonymous token form, see
[security-workflow.md: Token structure](security-workflow.md#token-structure).

### Composition across categories

With two independent categories `controlled` and `indigenous` mapped to fields `isControlled`
and `isIndigenous`:

| User's grants   | `categories` in token          | Visible records                                           |
| --------------- | ------------------------------ | --------------------------------------------------------- |
| neither         | `[]`                           | `isControlled=false AND isIndigenous=false` only          |
| controlled only | `["controlled"]`               | `isIndigenous=false` (open and controlled non-indigenous) |
| indigenous only | `["indigenous"]`               | `isControlled=false` (open and indigenous non-controlled) |
| both            | `["controlled", "indigenous"]` | all records                                               |

The current visibility rule means holding individual grants for `controlled` and `indigenous`
separately gives automatic access to the `controlled+indigenous` intersection, because no ungranted
category remains. This is the intended MVP behaviour: per-resource scoping ensures each grant was
approved by the relevant governance body for that specific resource, so holding both is sufficient.
SQON-scoped grants (post-MVP) can narrow further within a category if compound-access governance
requires it. See the resolved question in Open questions.

---

## Category-to-field mapping

> **Scope: post-MVP, for the same reason as the visibility rule.** Mapping a category to a field
> predicate is what record-level enforcement needs. Under MVP no category field appears in a query
> at all: a category decides whether a resource is in the permitted list, and the emitted filter
> names the resource. See "Resource-level enforcement for MVP" in [decisions.md](decisions.md).

Data categories in Usher's model are named abstractions. Usher has no knowledge of what fields in
any data schema correspond to a category: it works with category names only. The mapping from
category name to field predicate is deployment configuration that lives in the enforcement plugin:

```
category: indigenous_data
  field:  isIndigenous
  value:  true
```

A record belongs to a category if the configured field condition is true for that record. The plugin
holds this mapping and uses it to derive the exclusion filter from the token's `categories` list.
Two deployments using the same Usher instance can map the same category name (`indigenous_data`) to
entirely different field names in their respective schemas, because each plugin carries its own
config.

---

## Field-level restrictions

> **Scope: out of MVP, and further out than record-level narrowing.** Controlling fields within a
> record presumes control over records first, so this follows the record-level work rather than
> running beside it. The options below are recorded for when it is picked up.

Field-level restrictions control which fields within a record a user can see, independent of
whether they can see the record itself. Which approach to take is open.

**A. Resource-level restrictions.** Restrictions are uniform across all users with access to a
resource. All members of resource X cannot see `clinical_notes`, regardless of role. Simple;
appropriate when the resource itself defines what is visible. Cannot differentiate access by role.

**B. Role-in-resource restrictions.** Restrictions vary by role within a resource. A `member` in
resource X cannot see `clinical_notes`; an `owner` can. Adds role-differentiated field access.
Requires a matrix of role-by-field rules per resource; increases management UI complexity.

**C. Category-based field restrictions (preferred for extensibility).** Fields are tagged with data
categories using the same model that governs record-level access. A user's category grants
determine which fields they can see.

```
field_categories(field_name, data_category_id)
```

A user who holds the `indigenous_data` grant sees fields tagged `indigenous_data`. Without the
grant, those fields are masked or absent. This reuses the existing category framework with no new
model concepts and unifies record-level and field-level access control under one mechanism.

**D. User-level overrides.** Per-user, per-resource field exceptions on top of the base model.
Maximum flexibility; operationally expensive and difficult to audit. Treat as a deferred extension.

**Recommendation:** start with A for initial implementation; it is simple and sufficient for most
cases. Design for C as the primary extension path: it reuses existing concepts and keeps the mental
model unified. Defer B and D until a concrete use case requires them.

---

## Use case: private data sharing

### The primary scenario

A user submits data. That data is private by default: invisible to everyone except the submitter.
The submitter, or an administrator on their behalf, can grant specific other users access. Those
other users may belong to entirely different groups; group membership is not a prerequisite for
receiving a direct grant.

In Usher's model:

- The submitted dataset is a **resource**.
- A `private` data category is associated with that resource.
- The submitter holds a `membership` (as Owner or Member) and a `category_grant` for
  `private` in that resource.
- Granting another user access means giving them a `membership` (viewer role) and a
  `category_grant` for `private` in that specific resource.
- Revoking the grant removes their `category_grant`, immediately triggering the revocation
  propagation path.

This is peer-to-peer sharing mediated by an administrator in the first version. Delegated
self-management by the submitter (without administrator involvement) is a later capability.

### Submitters and owners

Submission and ownership are distinct roles that can overlap but do not have to.

**Submitter:** the user who uploaded data via Lyric. Submission establishes data provenance. A
submitter automatically receives a `membership` on the resource, but submission does not
automatically confer management rights. A submitter who has not been designated as owner cannot
grant access to others, change visibility policy, or share records.

**Owner (resource-level):** a designated role on a specific resource that grants management
rights: granting and revoking access for other users, setting visibility policy (private,
embargoed, public), and transferring ownership. An Owner holds data access as a member of
the resource and has management rights scoped to that resource only.

Ownership is optional and per-resource. An Owner need not be the submitter: a Principal
Investigator may be designated as owner for data submitted by a lab technician on their team.
An Admin holds no standing data access and may grant it to themselves explicitly, which needs no
approval in MVP and will need it once community custodianship exists. Granting access to *others*
belongs to the data-plane roles. See the admin-plane decision in [decisions.md](decisions.md).

The three management roles, ordered by widening scope rather than by seniority, since a reader
meets the narrowest first and central control is not the model's starting point:

| Role             | Scope                             | Data access                    |
| ---------------- | --------------------------------- | ------------------------------ |
| Owner            | Their designated resource(s) only | Yes; holds member access       |
| Custodian (OCAP) | One category across all resources | No (unless separately granted) |
| Admin            | All resources; the policy plane   | None standing; self-grant only |

**Naming.** The OCAP role is a **Custodian** rather than a Steward, because the requirements
document already uses "Data Steward" for the resource owner, and before this rename the second
sense ran through the ownership cascade below as a synonym for owner. The two readings contradicted
each other on scope (one category platform-wide against one resource) and on data access (none
against member access), so a reader meeting the cascade first concluded the OCAP role was a
co-owner of a resource, which is its inverse. Cascade usages now say owner or management rights,
and `Custodian` means only what the table above defines.

**Ownership assignment at submission time (resolved).** Lyric can create a cohort and designate
the submitter as its owner at submission time, if the submitter holds owner-level
permissions. Cohorts do not need to exist in Usher before the first submission: the submission flow
creates the cohort and optionally elevates the submitter to owner in a single operation.

For submitters who are not owners, an admin designates an Owner separately after the
resource is created. The submission proceeds regardless; owner designation is an additional
step.

The Lyric service account capability set needs to include cohort creation on behalf of a
owner-level submitter as a first-class operation, distinct from the basic `CREATE_RESOURCE`
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
4. **Last-holder promotion (safety net):** if all but one of the users holding management rights on
   a resource are removed, the remaining one is automatically promoted to owner. This is a
   data-integrity backstop, not a routine path. **Superseded by the move to ownership as a non-empty
   set**, where the invariant blocks removal of the last holder and leaves no case for this to
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

**Transfer-before-removal prerequisite.** Removing the owner role from its current holder requires
transferring ownership to another entity first. This ordering is enforced by the system: ownership
transfer must complete before the removal is permitted. There is never a window where a resource
has no owner during a normal ownership change.

**Atomicity.** An operation is atomic when it either completes entirely or does not happen at all;
no intermediate state is observable or persisted. In the last-holder promotion case, removing the
departing holder and promoting the remaining one execute in a single database transaction. If
anything fails mid-operation, the whole transaction rolls back: the resource always has an owner.
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
flag. This is an unconditional capability; the flag restricts regular users and automation, not
admins. Admin ownership transfers are logged as `admin.override` audit events (see
[audit-events.md](audit-events.md)).

### No system-wide access to private data

Private data is private to its resource. There is no role, flag, or capability that grants a user
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
management, audit, troubleshooting). That listing capability does not extend to reading,
downloading, or sharing resource data.

---

## Use case: OCAP-compliant deployments

OCAP (Ownership, Control, Access, and Possession) is a framework developed by the First Nations
Information Governance Centre (FNIGC) asserting Indigenous data sovereignty: communities own their
data collectively, control how it is collected and used, can access it at any time, and must
possess it, meaning the mechanisms of custody and stewardship are under their control, not
delegated to outside institutions. See https://fnigc.ca/ocap-training/ for the canonical
definition.

Any Overture deployment handling Indigenous health data, genomic data, or community-held research
data is required to honour OCAP. The authorization model is directly load-bearing for compliance.

### How the generic model supports OCAP

**Granular data categorization.** `data_categories` can represent any access dimension, including
`indigenous_data` as a category distinct from `controlled_access`. These are independent axes;
access to one does not imply access to the other.

**Deny by default.** Records tagged `indigenous_data` are hidden from any user without an explicit
grant for that category, regardless of what other access they hold.

**Rapid revocation.** The push+poll revocation channel and the fail-secure grace period mean that
a revoked grant propagates to all enforcing plugins within a bounded window. If a community
withdraws consent for a researcher's access, the revocation is effective promptly, not deferred to
token expiry.

**Audit trail.** `granted_by` on `category_grants` records who granted access and whether the
grant was internal or externally originated. This is the baseline for a sovereignty audit: who
approved what, when, and on whose authority.

### Custodianship: the additional OCAP requirement

The generic admin model (platform-level administrators who can manage all grants) is insufficient
for OCAP. Custodians of Indigenous data, community members or designated representatives with authority
over their community's data, must be able to manage grants for their data category without holding
platform-wide admin rights.

In Usher's terms: a user can hold a `category_custodian` capability scoped to one or more data
categories. Within those categories, they can grant and revoke access as if they were an Admin,
but only for the data categories they hold custody of. They cannot see or modify grants for other
categories, and they cannot modify resource structure or role assignments.

This capability dimension is not yet in the data model. Its design (how custodianship scope is
stored; the capability check in the PAP layer) is an open question and a prerequisite for
OCAP-compliant deployments. See Open questions.

### What OCAP does not require Usher to change

OCAP does not prescribe how data is stored, indexed, or structured. It prescribes who controls
access decisions. Usher's model-agnostic approach (categories are named; field mappings are
deployment config) means that OCAP-compliant and non-OCAP deployments use identical Usher code.
Compliance is a function of how the deployment is configured and administered.

---

## Category management

### Category assignment defaults

When a cohort is created, its data category assignments are determined by a chain of defaults. Each
layer can override the one above:

1. **Platform default.** Deployment-wide baseline: for example, "all cohorts are controlled access
   unless otherwise specified." Set by an admin; applies to every new cohort that does not
   specify otherwise.
2. **Cohort-level policy.** A per-cohort override of the platform default. Set by the cohort
   owner or an admin when the cohort is created or updated.
3. **Submission-time assignment.** When Lyric creates a cohort at submission time, the submitter
   is shown the category the cohort will receive based on the platform or cohort default. Submitters
   with owner-level permissions may override the assignment at this point. Submitters without
   owner-level see the assignment but cannot change it.
4. **Post-submission owner changes.** An Owner can adjust a cohort's
   category assignment after submission. This updates `resource_categories` in Usher's policy
   tables. The underlying submitted records are unchanged; Usher enforces category policies by
   filtering at the PEP layer, not by modifying records.

### Category change propagation

When a cohort's category assignment changes (a category is added or removed), the effects on
existing users must be handled explicitly.

**Tightening (adding a category).**

Users who are members of the resource but do not hold a grant for the new category will have
records filtered from their queries at the next grants token refresh. No revocation action is
needed from the user's side: the filter takes effect automatically. However:

- Affected users must be notified. Silent tightening is unacceptable: a user who received records
  in one query and no longer receives them in the next should understand why.
- Owners who want to pre-grant affected users before the change takes effect can do
  so via the standard grant flow before updating `resource_categories`.
- The tightening event must produce a structured audit log entry: which category was added, which
  resource, by whom, and when. The set of affected users must be derivable from this entry combined
  with the current `memberships` and `category_grants` tables.

**Loosening (removing a category).**

Users previously filtered by the removed category are no longer filtered at the next token refresh.
No active revocation is needed. Records that were previously excluded become visible to all members
with appropriate memberships.

Loosening a category with OCAP or governance implications (removing `indigenous_data` restrictions,
for example) is a governance decision and carries the same audit rigour as tightening. The fact
that loosening requires no technical revocation does not reduce its administrative weight.

Every change to `resource_categories` produces a structured audit event regardless of direction,
recording: actor, resource, category added or removed, direction, and timestamp.

### Embargo

An embargoed resource is private until a specified date, after which it becomes publicly visible
without any further admin action.

In Usher's model, embargo maps to a `category_grant` on the `private` category with `expires_at`
set to the release date. When the grant expires, the revocation mechanism fires and the records
become visible at whatever access tier applies once `private` is no longer gated. The submitter
sets the release date at submission time; an Owner or admin can update it before it fires.

Two open questions embargo surfaces:

**Scheduled release without an active session.** The revocation mechanism is driven by user
sessions: plugins check revocation state when a token is refreshed. A release with no active user
session will not propagate until the next session touches the resource. Whether this latency is
acceptable depends on the deployment's precision requirements. A background job polling for expired
embargo grants and explicitly firing the revocation channel is the clean fix; it is not yet
designed.

**Default visibility.** The framing "data is public by default unless the submitter sets an
embargo" describes the current iMS production dataset for existing submissions only; it is not
the intended permanent model. The intended model: access level (who can read, under what conditions)
is defined per submission, at submission time or afterwards by an authorized administrator or owner.
Future submissions will carry explicit access restrictions, not just an embargo toggle on
otherwise-public data.

In Usher's model this is consistent with deny-by-default: a newly created resource has no grants
until the submission service (Lyric) creates the appropriate membership and category grants at
ingest. "Open access," "embargoed," and "restricted" are all explicit access-level choices set
at submission time, not a global default. Usher enforces whatever the submission service assigns.

Enforcement must exist at both the submission layer (Lyric) and the retrieval layer (Arranger);
gating only one leaks through the other. See [plugin-integration.md](plugin-integration.md).

---

## Open questions

These questions require deliberate answers before the relevant implementation work can begin. Most
have OCAP, legal, or cross-application implications and should not be resolved by a single
developer in isolation.

### Overlapping cohort access semantics

A data record can belong to multiple cohorts simultaneously. When a user is a member of cohort A
but not cohort B, and a record belongs to both:

- **OR semantics:** the user sees the record (membership in any cohort it belongs to is
  sufficient). More permissive; risks exposing records the user was not explicitly approved for
  across the overlapping cohort.
- **AND semantics:** the user does not see the record (membership in all cohorts it belongs to is
  required). Aligns with deny-by-default; more conservative.

**Where records cannot overlap, the question is moot but not closed.** A deployment whose data
model gives each record exactly one resource makes overlap structurally impossible, and neither
semantic then produces a different result. That is the case for the first integration, recorded on
that side. It does not answer the general question, which stays open for deployments where a record
can satisfy the membership predicate of more than one resource at once.

Where private data sharing is the primary access gate, OR semantics may be acceptable if categories
are the real enforcement mechanism. The question needs a deliberate answer before the first
deployment where overlap is structurally possible, and confirming that a given deployment's records
cannot overlap is part of onboarding it rather than something to assume.

### Multi-category intersection access

**Resolved for MVP, re-checked against the resource-level decision.** Per-resource
scoping dissolves the primary concern: a `controlled` grant for COHORT_A and an `indigenous` grant
for COHORT_A are distinct entity records, each approved by the relevant governance body for that
specific resource. Holding both within the same resource means both bodies have approved access to
their respective category within that resource. No special intersection grant is needed.

Categories attach to resources rather than to individual records, so a resource carrying both
categories requires both grants and the question does not reach record level at all.

The OCAP concern (was each governance body's approval intended to cover the intersection?) is
addressed by the per-resource scoping: each approval is scoped to the resource, not to a category
in isolation. A record in that resource tagged with multiple categories requires all corresponding
approvals.

**Post-MVP extension: SQON-scoped grants.** If a governance body needs to approve access to a
specific subset of their category (e.g. "indigenous records from community X only"), a grant can
optionally carry a SQON filter expression that further narrows the records it covers within the
category. This is a data model extension (an optional `sqon` field on `category_grants`); it
requires SQON evaluation capability in the bridge and is deferred to post-MVP.

### Role capabilities

What specific actions does each role permit beyond "can access resources they are a member of"?
Can an `owner` invite other users to a resource? Can a `member` export data? These capability
rules need to be specified before implementation.

### Category grant scope

**Resolved.** Category grants are always resource-specific. A grant for `indigenous_data` in
COHORT_A is a distinct entity from a grant for `indigenous_data` in COHORT_B. This is simpler and
more auditable; a broader scope grant would require careful design to avoid unintended access and
complicates OCAP governance (a custodian's authority spans resources, but each grant they issue
names one).

### Attribute naming

The top-level map name (`grants`) and the per-resource fields (`role`, `categories`) are settled;
see [security-workflow.md: Token structure](security-workflow.md#token-structure) for the
canonical schema and worked examples. The remaining open question is field-level restriction
representation: attribute names for field restrictions (if included in the token at all) are not
yet decided. See [plugin-integration.md](plugin-integration.md).

### User groups design

`user_groups` and `group_category_grants` are in the entity schema but not yet designed. Open
questions: how are group memberships managed (PAP-only, or synced from Keycloak groups)? When a
user belongs to multiple groups with overlapping grants, how are those composed (union is the
natural answer, but must be stated explicitly)? Can a group hold a membership role in a resource,
or only category grants? Does removing a user from a group immediately trigger revocation of that
group's grants for that user?

### Write permissions (Lyric)

The grant model extends to write operations: a grant governing write access would allow the PEP
plugin in Lyric to enforce which records or fields a user is permitted to submit or modify. The
data model shape is clear; the Lyric plugin design is not. Deferred until Lyric integration is in
scope.

### Write vs read access

Does write access confer read access? In the submission flow, write access is currently gated by
organizational affiliation: the submitter's `context.scope` entries determine which organizations
they may submit on behalf of. When a resource is created at submission time, the open question is
whether that submission event automatically creates read grants for the submitter, creates
restricted read access (membership only, no category grants), or creates no read access at all.

Three options with meaningfully different implications, particularly for consent-constrained data:

1. **Submitter reads own submissions.** Submission creates a membership and full category grants
   for the submitter on the resource. Write access automatically grants read access. Simple for
   the common case; problematic when data is submitted on behalf of a community or patient where
   the submitter may not hold data access consent: a community liaison submitting on behalf of
   an Indigenous community does not automatically have consent to read individual members' records.

2. **Organizational membership grants read access.** All submitters in an organization can read
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

| Axis | Requirement | Mechanism |
| ---- | ----------- | --------- |
| Provenance | A submitter reaches what they submitted, not what others submitted | **Not expressible under resource-level enforcement** |
| Consent | A submitter may not be entitled to read the sensitive content of what they submitted | Category grants, which MVP has |

These do not substitute for each other, and conflating them is the trap. Provenance scoping does
not address the consent case at all: the community liaison submitted those records, so scoping
access to what they submitted hands them precisely the records in question. Only a withheld
category grant withholds those. Equally, withholding categories does not deliver provenance
scoping, since every submitter then sees the same uncategorized slice of the whole resource.

**Provenance scoping requires structure the model does not have.** Resources are a flat list with
no parent relationship, so there is no way to express membership of a submission that belongs to a
study. Delivering it needs either a two-level resource relationship or record-level enforcement.

Three MVP paths, none yet chosen:

1. **Each submission becomes its own resource.** Delivers both axes without record-level
   enforcement: the submitter holds membership on their submission-resource, and categories still
   gate the sensitive content within it. Costs the two-level structure, makes study-wide reader
   inheritance a real derivation rather than a free consequence of resource-level visibility, and
   grows the resource count with every submission.
2. **Membership on the study with no category grants.** Cheapest, and safe on the consent axis, but
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
account perform at submission time?); the entity schema (does submission create `membership` and
`category_grants` rows, or only a resource registration?); and whether the submitter's Keycloak
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

A user with `category_custodian` capability can manage grants for specific data categories without
platform-wide admin rights. The data model for custodianship scope (which categories a custodian
governs) and the capability check in the PAP layer are not yet designed. This is a prerequisite
for OCAP-compliant deployments and should be designed before the management UI work begins.
