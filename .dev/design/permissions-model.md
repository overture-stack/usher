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
resources              (id, name, description)
roles                  (id, name)
data_categories        (id, name, description)
resource_categories    (resource_id, data_category_id)
memberships            (user_id, resource_id, role_id)
group_memberships      (group_id, resource_id, role_id)
category_grants        (user_id, data_category_id, resource_id, granted_by, granted_at, expires_at)
group_category_grants  (group_id, data_category_id, resource_id, granted_by, granted_at, expires_at)
```

---

## How access is resolved

### The visibility rule

A record is visible to a user if, for every data category associated with the resource that the
record belongs to, the user holds a grant for that category (directly or via a group).

Stated the other way: a record is excluded if the user lacks a grant for any category the record
is tagged with.

The grants token expresses this as `categories`: the include-list of data categories the user
holds grants for within a resource. Denied category names are absent from the token entirely rather
than named explicitly; this is consistent with how OAuth scopes, UMA RPT permissions, and GA4GH
Passport Visas express positive grants, and with the principle of least information. The enforcement
plugin computes what to exclude by subtracting the token's `categories` from the full category set
configured for that resource. Each absent category produces an exclusion filter using that
category's field mapping. Exclusion conditions are applied as a conjunction: a record is hidden if
it is tagged with any category not present in the user's token.

Excluded records do not appear in counts, aggregations, or result sets; their existence is not
disclosed. This is a hard invariant: existence revelation is an information disclosure vulnerability
(OWASP A01), and a discoverable-but-inaccessible mode will not be introduced.

### Worked example

**Setup:**

Resources and their category assignments:
- `RESOURCE_X` has `data_categories: [indigenous_data]`
- `RESOURCE_Y` has `data_categories: [open_access, indigenous_data]`

Users and their grants:
- User A: `membership(RESOURCE_X, member)`, no category grants
- User B: `membership(RESOURCE_X, member)`, `category_grant(indigenous_data, RESOURCE_X)`;
  `membership(RESOURCE_Y, member)`, `category_grant(open_access, RESOURCE_Y)`

Plugin config (Arranger-side; maps category names to Elasticsearch field predicates):
```
indigenous_data → { field: "isIndigenous", value: true }
open_access     → { field: "isRestricted", value: false }
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
    "RESOURCE_X": {
      "role": "member",
      "categories": []
    }
  }
}
```

`RESOURCE_Y` is absent: User A has no membership there. The plugin denies all queries for that
resource.

For `RESOURCE_X`: the plugin config lists `[indigenous_data]` as the full category set. The token
has `categories: []`. Exclusion set: `[indigenous_data]`. The plugin applies
`isIndigenous=true → exclude` as a filter on every query. User A sees only records where
`isIndigenous=false`. Their queries never reveal that indigenous records exist: absent from results,
counts, and aggregations.

**Grants token for User B:**

```json
{
  "sub": "user-b",
  "aud": "example-service",
  "iat": 1720000000,
  "exp": 1720000300,
  "generatedAt": 1720000000,
  "grants": {
    "RESOURCE_X": {
      "role": "member",
      "categories": ["indigenous_data"]
    },
    "RESOURCE_Y": {
      "role": "member",
      "categories": ["open_access"]
    }
  }
}
```

For `RESOURCE_X`: full set `[indigenous_data]` minus token `["indigenous_data"]` = no exclusions.
User B sees all records.

For `RESOURCE_Y`: full set `[open_access, indigenous_data]` minus token `["open_access"]` =
exclusion set `[indigenous_data]`. User B sees only non-indigenous records in `RESOURCE_Y`.

The token examples above use the canonical `grants` map structure. For the full token schema,
standard JWT claims, and anonymous token form, see
[security-workflow.md — Token structure](security-workflow.md#token-structure).

### Composition across categories

With two independent categories `controlled` and `indigenous` mapped to fields `isControlled`
and `isIndigenous`:

| User's grants | `categories` in token | Visible records |
|---|---|---|
| neither | `[]` | `isControlled=false AND isIndigenous=false` only |
| controlled only | `["controlled"]` | `isIndigenous=false` (open and controlled non-indigenous) |
| indigenous only | `["indigenous"]` | `isControlled=false` (open and indigenous non-controlled) |
| both | `["controlled", "indigenous"]` | all records |

The current visibility rule means holding individual grants for `controlled` and `indigenous`
separately gives automatic access to the `controlled+indigenous` intersection, because no ungranted
category remains. Whether this is the intended behaviour is an open question with OCAP implications;
see Open questions.

---

## Category-to-field mapping

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

Field-level restrictions control which fields within a record a user can see, independent of
whether they can see the record itself. The implementation approach is not yet chosen.

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
the resource and has stewardship rights scoped to that resource only.

Ownership is optional and per-resource. An Owner need not be the submitter: a Principal
Investigator may be designated as owner for data submitted by a lab technician on their team.
An Admin can always act as owner on behalf of the resource through the standard
grant management flow.

The three management roles:

| Role | Scope | Data access |
|---|---|---|
| Admin | All resources; all grants | No; must self-grant explicitly |
| Steward (OCAP) | One category across all resources | No (unless separately granted) |
| Owner | Their designated resource(s) only | Yes; holds member access |

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

### Data stewardship: the additional OCAP requirement

The generic admin model (platform-level administrators who can manage all grants) is insufficient
for OCAP. Indigenous data stewards, community members or designated representatives with authority
over their community's data, must be able to manage grants for their data category without holding
platform-wide admin rights.

In Usher's terms: a user can hold a `category_steward` capability scoped to one or more data
categories. Within those categories, they can grant and revoke access as if they were an Admin,
but only for the data categories they steward. They cannot see or modify grants for other
categories, and they cannot modify resource structure or role assignments.

This capability dimension is not yet in the data model. Its design (how stewardship scope is
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
4. **Post-submission steward changes.** An Owner or steward can adjust a cohort's
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
- Owners or stewards who want to pre-grant affected users before the change takes effect can do
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

**Default visibility.** The iMS requirement is: data is public by default unless the submitter
sets an embargo. This inverts Usher's deny-by-default principle for uncategorized data (an
uncategorized resource is visible to all members). The resolution: "public" and "private" are both
explicit category choices at submission time, not Usher's global default. The submission service
(Lyric) assigns the appropriate category at ingest; Usher enforces it.

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

For iMS private data sharing (where `private` is the primary access gate), OR semantics may be
acceptable if categories are the real enforcement mechanism. The question needs a deliberate answer
before implementation.

### Multi-category intersection access

The current visibility rule means holding individual grants for `controlled` and `indigenous`
separately gives automatic access to the `controlled+indigenous` intersection. An earlier design
iteration (the AuthZ Framework document, 2025) required an explicit grant for the intersection
separately from the component grants.

The stricter interpretation is more OCAP-safe: being approved for "controlled data" and separately
approved for "indigenous data" does not auto-approve "controlled indigenous data", which may be the
most sensitive combination and warrant its own governance decision. It also makes the grant model
more complex.

**Recommend discussing with data stewards and OCAP practitioners before deciding.** The choice
affects the data model, the management UI, and OCAP compliance posture.

### Role capabilities

What specific actions does each role permit beyond "can access resources they are a member of"?
Can an `owner` invite other users to a resource? Can a `member` export data? These capability
rules need to be specified before implementation.

### Category grant scope

Can a category grant span multiple resources (access to `indigenous_data` across all resources the
user is a member of), or is it always resource-specific? Resource-specific is simpler and more
auditable; a broader scope grant would need careful design to avoid unintended access.

### Attribute naming

The top-level map name (`grants`) and the per-resource fields (`role`, `categories`) are settled;
see [security-workflow.md — Token structure](security-workflow.md#token-structure) for the
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

### Data stewardship scoping

A user with `category_steward` capability can manage grants for specific data categories without
platform-wide admin rights. The data model for stewardship scope (which categories a steward
governs) and the capability check in the PAP layer are not yet designed. This is a prerequisite
for OCAP-compliant deployments and should be designed before the management UI work begins.
