# Permissions Model

_Status: in progress. Core structure, grant composition semantics, category-to-field mapping,
OCAP considerations, private data sharing use cases (iMS), submitter/custodian distinction,
category assignment defaults hierarchy, and category change propagation are now documented.
Open design questions: multi-category intersection access (OCAP compliance posture), user groups
detail, data stewardship and resource ownership scoping, write permissions for Lyric, embargo
scheduling, field-level restriction implementation, and role capability definitions._

The three privileged roles introduced here (platform admin, category steward, resource owner)
are fully specified in [admin-model.md](admin-model.md), which covers lifecycle, OIDC-first
identification, bootstrap, the self-grant flow, service accounts, and audit integrity.

See [security-threat-model.md](security-threat-model.md) for the full OWASP Top 10:2025 mapping.

**Primary OWASP categories relevant here:**
- **A01 — Broken Access Control:** deny by default (category access requires explicit grant);
  the permissions model is the policy layer Usher enforces. Gaps in this model are gaps in access
  control. Field-level restriction design is an open A01 gap.
- **A06 — Insecure Design:** the hybrid role + attribute model was chosen specifically to avoid
  role proliferation, which leads to misconfigured or overlooked role assignments. Each design
  choice should be examined for "what does an adversary gain if this is wrong?"

---

## Model-agnostic intent

The permissions model uses generic terms (`resource`, `membership`, `category`) rather than
domain-specific ones (`study`, `patient`, `dataset`). Domain terminology appears only in the
management UI layer (configurable per deployment) and in worked examples.

In the Overture context, a "resource" is a **cohort**: a virtual grouping of data records
defined by shared characteristics, not a siloed container. Unlike studies (where a record belongs
to exactly one study), cohorts can overlap; a record can belong to multiple cohorts simultaneously.
In another deployment it might be a dataset, project, or patient cohort under a different name.
The underlying model is the same.

The access semantics of overlapping cohorts are an open design question (see Open questions below).

---

## Hybrid role + attribute model

Usher uses a **hybrid of RBAC and ABAC**:

- **Roles** capture coarse-grained capabilities: what kind of actions a user can perform (curator,
  member, viewer). A role is a label for a class of behaviours.
- **Attributes** capture contextual scope: which specific resources those actions apply to, and
  under what data-category restrictions.

This combination avoids two failure modes:
- Pure RBAC: roles proliferate as rules become contextual ("study-A-indigenous-curator" vs
  "study-A-non-indigenous-curator" etc.)
- Pure ABAC: policy rules become difficult to manage and audit without role abstraction as a
  simplifying layer

Two users can hold the same role in the same resource and still have meaningfully different access,
depending on their data category grants. The role describes capability; the grant describes scope.

---

## Core entities

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

_Note: specific column names, types, and indexes are not yet designed. This is a logical model,
not a schema._

### roles

Coarse-grained capability labels. Expected examples: `curator`, `member`. The exact set of roles
is a deployment decision, not hardcoded in Usher. Roles are defined through the management UI.

### data_categories

Named access tiers that apply to subsets of records or fields within a resource. Examples:
`indigenous_data`, `controlled_access`, `restricted_clinical`. Categories are defined at the
platform level and assigned to resources by operators.

### resource_categories

Associates data categories with resources. A resource can have zero or more categories. If a
resource has no categories, all members see all records and fields (subject to role permissions).

### user_groups

_Design gap: not yet fully designed. The entities above are placeholders; the details need
explicit design work before implementation._

Collections of users with shared access needs. Groups exist to make administration tractable at
scale: granting access to a research team of 40 people should be one operation, not 40. Groups
are a first-class entity: a group can hold memberships in resources and hold category grants
directly, separately from any individual user's grants. A user's effective access is the union
of their personal grants and all grants held by groups they belong to.

Groups belong to the same operational context as users and are managed through the PAP layer.
In deployments using GA4GH Passports, a Keycloak group membership can be mapped to a Usher
group automatically, allowing institutional group affiliations to propagate into Usher without
manual management.

### memberships

Records a user's role within a specific resource. A user can have at most one role per resource
(TBD: whether multiple roles per resource per user is needed is unresolved).

### category_grants

Records an explicit grant allowing a specific user to access records and fields associated with a
data category within a specific resource. Category grants are additive: without a grant, access to
categorized records/fields is denied for members of that resource.

The `expires_at` field supports time-limited grants. **Design decision:** grant expiry triggers the
`revoked_at` revocation mechanism (the same path as a manual revocation). The fail-secure grace
period applies. The researcher must re-authenticate to resume access. This keeps the revocation
behaviour consistent regardless of whether a grant was revoked manually or lapsed naturally.

Grants have two origins:

- **Internal:** created by an administrator through the management UI (PAP layer). Usher owns the
  full lifecycle.
- **External:** originated from a GA4GH Passport `ControlledAccessGrants` Visa, validated by
  Keycloak and mapped to a `category_grant` automatically. Usher inherits the Visa's `expires`
  timestamp as `expires_at`. See [concepts.md, GA4GH Passports and federated identity](concepts.md)
  for the full flow.

Local administrators can revoke an externally-originated grant. Local policy can always restrict
access downward; it cannot grant access that no Visa covers. The `granted_by` column should record
the origin (internal admin ID vs external Visa issuer identifier) for auditability.

---

## Grant composition and visibility semantics

### The visibility rule

A record is visible to a user if, for every data category associated with the resource that the
record belongs to, the user holds a grant for that category (directly or via a group).

Equivalently: a record is excluded if the user lacks a grant for ANY category the record
is tagged with.

The constraint token expresses this as `exclude_categories`: the list of resource-associated
categories for which the user holds no grant. The PEP plugin translates each excluded category
into a filter condition using that category's configured field mapping. All exclusion conditions
are applied as a conjunction (AND): a record is hidden if it is tagged with category A that is
excluded, OR category B that is excluded (the record fails the filter if any excluded category
matches).

### Composition across multiple categories

With two independent categories `controlled` and `indigenous` mapped to fields `isControlled`
and `isIndigenous`:

| User's grants | Excluded categories | Visible records |
|---|---|---|
| neither | controlled, indigenous | `isControlled=false AND isIndigenous=false` only |
| controlled only | indigenous | `isIndigenous=false` (open and controlled non-indigenous) |
| indigenous only | controlled | `isControlled=false` (open and indigenous non-controlled) |
| both | none | all records |

**The intersection question:** the visibility rule above means that holding individual grants for
`controlled` and `indigenous` separately gives access to the `controlled+indigenous` intersection
automatically (because no unganted category remains). Whether this is the intended behaviour is an
open design question with OCAP implications; see Open questions below.

### Category-to-field mapping

Data categories in Usher's model are named abstractions; the field conditions they map to are
deployment configuration. The mapping is expressed per-category as a filter predicate:

```
category: indigenous_data
  field:  isIndigenous
  value:  true
```

A record "belongs to" a category if the configured field condition is true for that record. This
mapping is what the deployment operator configures; Usher's core model is agnostic to the
underlying field names. Two deployments can use the same category name (`indigenous_data`) while
mapping it to entirely different field structures in their ES index.

### Write permissions

The same grant model extends to write operations in submission services (e.g. Lyric). A grant's
scope applies to the operation type the consuming service enforces; for Arranger this is always
read, and for Lyric it is read and/or write. The data model does not change; the interpretation at
the PEP layer differs. Write permission design is deferred (see Open questions).

---

## Constraint resolution: worked example

### Setup

- Resource `RESOURCE_X` has `data_categories: [indigenous_data]`
- User A: `membership(RESOURCE_X, member)`, no category grants
- User B: `membership(RESOURCE_X, member)`, `category_grant(indigenous_data, RESOURCE_X)`

### Constraint output for User A

```json
{
  "allowed": true,
  "role": "member",
  "resources": ["RESOURCE_X"],
  "record_filters": {
    "exclude_categories": ["indigenous_data"]
  },
  "field_restrictions": {}
}
```

The Arranger PEP plugin translates `exclude_categories: ["indigenous_data"]` into a SQON filter
that removes records tagged with that category from every query result, server-side. User A never
receives those records, and their queries never reveal that such records exist.

### Constraint output for User B

```json
{
  "allowed": true,
  "role": "member",
  "resources": ["RESOURCE_X"],
  "record_filters": {},
  "field_restrictions": {}
}
```

No exclusion filter. User B sees all records in RESOURCE_X.

---

## Field-level restrictions

Field-level restrictions control which fields within a record a user can see, independent of
whether they can see the record itself.

_This section needs more design work. The options are defined; the implementation approach is not
yet chosen._

### Options

**A. Resource-level restrictions**
Restrictions are uniform across all users with access to a resource.
All users of resource X cannot see field `clinical_notes`, regardless of role.

Simple; appropriate when the resource itself defines what is visible. Cannot differentiate access
by role.

**B. Role-in-resource restrictions**
Restrictions vary by role within a resource.
"member" in resource X cannot see `clinical_notes`; "curator" can.

Adds role-differentiated field access. Requires the data model to track a matrix of role-by-field
rules per resource. Management UI complexity increases accordingly.

**C. Category-based field restrictions (preferred for extensibility)**
Fields are tagged with data categories using the same category model that governs record-level
access. A user's category grants determine which fields they can see, using the same
`category_grants` entity with no new model concepts.

`field_categories(field_name, data_category_id)`: this field belongs to this category.

If a user has the `indigenous_data` grant, they see fields tagged `indigenous_data`. If not,
those fields are masked or absent. This reuses the existing category framework and unifies
record-level and field-level access control under a single mechanism.

**D. User-level overrides**
Per-user, per-resource field exceptions on top of the base model.

Maximum flexibility. Operationally expensive; difficult to audit. Should be treated as a deferred
extension, not a foundation.

### Recommendation

Start with **A (resource-level)** for initial implementation; it is simple and sufficient for most
cases. Design the model to accommodate **C (category-based)** as the primary extension path, since
it reuses existing model concepts and keeps the mental model unified. Defer B and D until a
concrete use case requires them.

---

## OCAP compliance considerations

OCAP (Ownership, Control, Access, and Possession) is a framework developed by the First Nations
Information Governance Centre (FNIGC) asserting Indigenous data sovereignty: communities own their
data collectively, control how it is collected and used, can access it at any time, and must
possess it, meaning the mechanisms of custody and stewardship are under their control, not
delegated to outside institutions.

See https://fnigc.ca/ocap-training/ for the canonical definition.

This is not a niche edge case. Any Overture deployment handling Indigenous health data, genomic
data, or community-held research data is required to honour OCAP, and the authorization model is
directly load-bearing for compliance.

### How the generic model supports OCAP

Usher's model is not OCAP-specific, but it is OCAP-compatible by design. The points of alignment:

**Granular data categorization.** `data_categories` can represent any access dimension, including
`indigenous_data` as a named category distinct from `controlled_access`. These are independent
axes; access to one does not imply access to the other, and the intersection requires explicit
grants for both (subject to the intersection open question below).

**Deny by default.** Records tagged `indigenous_data` are hidden from any user without an explicit
grant for that category, regardless of what other access they hold. There is no "fallback visible"
state.

**Rapid revocation.** The push+poll revocation channel and the 60-second fail-secure grace period
mean that a revoked grant propagates to all enforcing plugins within a bounded window. This
supports community control: if a community withdraws consent for a researcher's access, the
revocation is effective promptly, not deferred to token expiry.

**Audit trail.** `granted_by` on `category_grants` records who granted access and whether the
grant was internal or externally originated (GA4GH Passport). This is the baseline for any
sovereignty audit: who approved what, when, and on whose authority.

### The additional capability OCAP requires: data stewardship

The generic admin model (platform-level administrators who can manage all grants) is insufficient
for OCAP. Indigenous data stewards (community members or designated representatives with authority
over their community's data) must be able to manage grants for their data category without holding
platform-wide admin rights. This is not OCAP-specific; it is a general capability of delegated
category administration. OCAP is the concrete use case that makes this a requirement rather than a
nice-to-have.

In Usher's terms: a user can hold a `category_steward` capability scoped to one or more data
categories. Within those categories, they can grant and revoke access as if they were a PAP admin,
but only for the data categories they steward. They cannot see or modify grants for other
categories, and they cannot modify resource structure or role assignments.

This is a new role/capability dimension not yet in the permissions model. It affects both the
data model (how stewardship scope is stored) and the management UI (stewards need their own
scoped view of the PAP). Design is deferred but the requirement is captured here.

### What OCAP does not require Usher to change

OCAP does not prescribe how data is stored, indexed, or structured. It prescribes who controls
access decisions. Usher's model-agnostic approach (categories are named, field mappings are
deployment config) means that OCAP-compliant and non-OCAP deployments use identical Usher code;
compliance is a function of how the deployment is configured and administered, not of Usher's
internals.

---

## Private data sharing, resource ownership, and embargo

These use cases come from the iMS Data Portal UAC Requirements document and represent the
primary motivation for the first version of Usher. They must be satisfiable by the generic model
without any iMS-specific code in Usher's core.

### The primary use case: private data sharing between users

A user submits data. That data is private by default: invisible to everyone except the submitter.
The submitter (or an admin on their behalf) can grant specific other users access to that data.
Those other users may belong to entirely different groups; group membership is not a prerequisite
for receiving a direct grant. Nobody else can see the data.

In Usher's model:
- The submitted dataset is a **resource**.
- A `private` data category is associated with that resource.
- The submitter holds a `membership` (as curator or owner role) and a `category_grant` for
  `private` in that resource.
- Granting another user access means giving them a `membership` (viewer role) and a
  `category_grant` for `private` in that specific resource.
- The grantee does not need to be in any of the same groups as the submitter. Group membership
  and direct grants are independent paths to access.
- Revoking the grant removes their `category_grant`, immediately triggering the revocation
  propagation path.

This is peer-to-peer sharing mediated by an admin in the first version. The longer-term
capability (the submitter managing their own grants without admin involvement) is resource
ownership delegation (see below).

### No system-wide access to private data

Private data is private to its resource, not just to the data category. There is no role, flag,
or capability that grants a user visibility across all private resources platform-wide.

This applies to PAP administrators as well. A PAP admin can manage grants (create, revoke,
view audit records) but does not hold implicit data access. Being the administrator of the
authorization system is explicitly separated from being a reader of the data that system
protects. A PAP admin who needs to access a specific resource must be granted access to that
resource the same way any other user would be, and that grant is auditable.

This is a separation-of-duties requirement, not an incidental property. It means:
- Support staff managing permissions cannot read the private data they are granting access to.
- No "superuser" bypass exists at the Usher layer for reading private records.
- Any user who can read private data in a resource holds an explicit, traceable grant for it.

The adversarial framing: if a PAP admin account is compromised, the attacker gains the ability
to grant themselves access, but that grant is logged. They do not have silent, unlogged access
to all private data by virtue of the admin role alone.

**Admin listing vs. data access are distinct.** PAP admins can enumerate all resources
platform-wide for operational and support purposes (e.g. permission management, audit,
troubleshooting). This listing capability does not extend to reading, downloading, or sharing
resource data. To do any of those, an admin must explicitly grant themselves access through the
permissions system, which produces a logged event. The audit trail is the control: admin power
is bounded and visible, never silent.

### Submitters and custodians: separating provenance from management rights

Submission and custodianship are distinct roles that can overlap but do not have to.

**Submitter:** the user who uploaded data via Lyric. Submission establishes data provenance. A
submitter automatically receives a `membership` on the resource (they can access what they
submitted), but submission does not automatically confer management rights. A submitter who has
not been designated as custodian cannot grant access to others, change visibility policy, or
share records.

**Custodian (resource-level):** a designated role on a specific resource that grants management
rights: granting and revoking access for other users, setting visibility policy (private,
embargoed, public), and transferring custodianship. A custodian holds data access as a member
of the resource and has steward rights scoped to that resource only.

Custodianship is optional and per-resource: some submitters are designated as custodians;
others are not. A custodian need not be the submitter (for example, a Principal Investigator
may be designated as custodian for data submitted by a lab technician on their team). A
platform admin can always act as custodian on behalf of the resource through the standard grant
management flow.

This is the resource-level variant of the data stewardship capability introduced in the OCAP
section. The three management roles are now:

| Role | Scope | Data access |
|---|---|---|
| Platform admin | All resources; all grants | No; must self-grant explicitly |
| Category steward (OCAP) | One category across all resources | No (unless separately granted) |
| Custodian | Their designated resource(s) only | Yes; holds member access |

**Custodianship assignment: resolved approach.**
Lyric (and Song, if applicable) can create a cohort and designate the submitter as its
custodian at submission time, if the submitter holds custodian-level permissions. This resolves
the pre-configuration requirement: cohorts do not need to exist in Usher before the first
submission. The submission flow itself creates the cohort and optionally elevates the submitter
to custodian in a single operation.

For submitters who are not custodians, a platform admin designates a custodian separately after
the resource is created. The submission proceeds regardless; custodian designation is an
additional step.

The Lyric service account capability set needs to include cohort/study creation on behalf of
a custodian-level submitter as a first-class operation, distinct from the basic `CREATE_RESOURCE`
path. See [admin-model.md](admin-model.md) for the service account model.

This must be reflected in the management UI and service account capability design.

In the first version, custodianship actions are performed by a platform admin on the
custodian's behalf. Delegated self-management by custodians is a later capability.

### Category assignment defaults and override hierarchy

When a cohort is created, which data categories it receives is determined by a chain of
defaults. Each layer can override the one above:

1. **Platform default.** Deployment-wide baseline: examples are "all cohorts are controlled
   access unless otherwise specified" or "all cohorts are open by default." Set by a platform
   admin and applies to every new cohort that does not specify otherwise.

2. **Cohort-level policy.** A per-cohort setting that overrides the platform default. Set by the
   cohort custodian or a platform admin when the cohort is created or updated subsequently.

3. **Submission-time assignment.** When Lyric creates a cohort at submission time (or when a
   submitter is adding records to an existing cohort), the submitter is shown the category the
   cohort will receive based on the cohort or platform default. Submitters who hold custodian-level
   may override the assignment at this point. Submitters who do not hold custodian-level see the
   warning but cannot change it; the default applies.

4. **Post-submission steward changes.** A custodian or category steward can adjust a cohort's
   category assignment after submission. This updates `resource_categories` in Usher's policy
   tables. The underlying submitted records are unchanged; see "Access control does not modify
   data" in [concepts.md](concepts.md).

The data immutability principle applies throughout: Usher enforces category policies by filtering
at the PEP layer, not by modifying submitted records. A field like `isIndigenous` or `isControlled`
in the ES index is set by the submitter at ingest and is owned by the data; Usher reads it to
identify which records fall under a given category. Changing which categories a cohort has in
`resource_categories` changes which filter conditions are applied; it does not rewrite records.

### Category change propagation

When a cohort's category assignment changes (a data category is added or removed from a resource),
the effects on existing users must be handled explicitly.

**Tightening (adding a category to a resource):**

A resource that was previously uncategorized or had fewer categories gains a new category. Users
who are members of the resource but do not hold a grant for the new category will have records
filtered from their queries at the next constraint token refresh. No special revocation action
is required from the user's side — the filter takes effect automatically. However:

- Affected users (those who had broader access before the change) must be notified. Silent
  tightening is unacceptable: users who received records in one query and no longer receive them
  in the next should understand why.
- Custodians or stewards who want to pre-grant affected users access before the change takes
  effect can do so via the standard grant flow before updating `resource_categories`.
- The tightening event must produce a structured audit log entry: which category was added,
  which resource, by whom, and at what timestamp. The set of affected users (those who had access
  before but not after) must be derivable from this entry combined with the current `memberships`
  and `category_grants` tables.

**Loosening (removing a category from a resource):**

A resource loses a category. Users who were previously filtered by it are no longer filtered at
the next token refresh. No active revocation is needed: the PEP plugin simply has fewer exclusion
conditions. Records that were previously excluded become visible to all members of the resource
who hold appropriate memberships.

Loosening a category with OCAP or governance implications (for example, removing `indigenous_data`
restrictions) is a governance decision and must carry the same audit rigour as tightening. The
fact that loosening requires no technical revocation does not reduce the administrative weight of
the decision.

**Audit requirements for both directions:** every change to `resource_categories` produces a
structured audit event, regardless of direction. The event records: actor, resource, category added
or removed, timestamp, and the direction of change. Reversals are also logged.

### Embargo

An embargoed resource is private until a specified date, after which it becomes publicly
visible without any further admin action.

In Usher's model, embargo maps to a `category_grant` on the `private` category with
`expires_at` set to the release date. When the grant expires, the revocation mechanism fires
and the records become visible at whatever access tier applies once `private` is no longer
gated. The submitter sets the release date at submission time; it can be updated by the owner
or an admin before it fires.

Two design questions embargo surfaces:

**Scheduled release without an active session.** The `revoked_at` revocation mechanism is
driven by user sessions; plugins check revocation state when a token is refreshed or validated.
A release with no active user session will not propagate until the next session touches the
resource. Whether this latency is acceptable for embargo (releasing "tomorrow at midnight" vs.
"some time after midnight when the next user happens to query") depends on the deployment's
precision requirements. A background job polling for expired embargo grants and explicitly firing
the revocation channel is the clean fix, but is not yet designed.

**Default visibility.** The iMS requirement is: data is public by default unless the submitter
sets an embargo. This inverts Usher's deny-by-default principle for uncategorized data; an
uncategorized resource is visible to all members. The resolution is that "public" and "private"
are both explicit category choices at submission time, not Usher's global default. The
submission service (Lyric) assigns the appropriate category at ingest; Usher enforces it.

### Visibility of private records (existence disclosure)

A separate question from access: should a user who cannot read a private record be able to
tell that it exists?

**Decided: no.** Existence is denied along with access. Excluded records do not appear in
counts, aggregations, or result sets. A user who cannot read a resource does not know it
exists: not in listings, not in search, not in any other surface.

This is a hard invariant, not a configuration option. In clinical and genomic research contexts,
knowing that a sensitive dataset exists is itself sensitive information; existence revelation is
an information disclosure vulnerability (OWASP A01). A "discoverable-but-inaccessible" mode
will not be introduced at any version.

---

## Open questions

### Overlapping cohort access semantics

In the Overture model, a resource is a cohort, and cohorts can overlap: a data record can belong
to multiple cohorts simultaneously. When a user is a member of cohort A but not cohort B, and a
record belongs to both:

- **OR semantics:** the user sees the record (membership in any cohort it belongs to is sufficient).
  More permissive; operationally simpler; risks exposing records the user was not explicitly
  approved for across the overlapping cohort.
- **AND semantics:** the user does not see the record (membership in all cohorts it belongs to is
  required). Aligns with deny-by-default; more conservative; may exclude legitimate access.

This is the resource-scope analogue of the multi-category intersection question. The right answer
depends on the privacy model of the deployment. For iMS private data sharing in particular (where
the `private` category is the primary access gate), OR semantics may be acceptable if categories
are the real enforcement mechanism. But the question needs a deliberate answer before implementation.

### Role capabilities

What specific capabilities does each role confer, beyond "can access resources they are a member
of"? For example: can a "curator" invite other users to a resource? Can a "member" export data?
These capability rules need to be specified before implementation.

### Multiple roles per user per resource

Is it valid for a user to hold more than one role in the same resource simultaneously (e.g. both
"member" and "curator" of the same study)? If so, how are the role-level permissions composed
at constraint resolution time?

### Category grant scope

Can a category grant span multiple resources (e.g. access to `indigenous_data` across all
resources the user is a member of), or is it always resource-specific? Resource-specific is simpler
and more auditable; a broader scope grant would need careful design to avoid unintended access.

### Attribute naming

The specific attribute names for the constraint token payload (`resources`, `record_filters`,
`exclude_categories`, etc.) are illustrative. The final names should be decided when the API
contract is designed. See [plugin-integration.md](plugin-integration.md).

### Expiry and renewal

`category_grants.expires_at` supports time-limited access. **Decided:** grant expiry triggers the
`revoked_at` mechanism (same path as manual revocation). Consistent behaviour, no special case.
The renewal flow (whether the management UI surfaces an expiring-grant notification or a renewal
request workflow) is not yet designed and does not block implementation of the core model.

### Multi-category intersection access

The current visibility rule (a record is visible if the user holds grants for all of its tagged
categories) means that holding individual `controlled` and `indigenous` grants separately gives
automatic access to the `controlled+indigenous` intersection. An earlier design iteration (the
AuthZ Framework document, 2025) treated intersections as requiring their own explicit grant
separate from the component grants; having `controlled` access and `indigenous` access did not
imply having `controlled+indigenous` access.

The stricter (AuthZ doc) interpretation is more OCAP-safe: being approved for "controlled data"
and separately approved for "indigenous data" does not auto-approve "controlled indigenous data",
which may be the most sensitive combination and warrant its own governance decision. However, it
makes the grant model more complex: users needing access to the intersection must be granted it
explicitly in addition to the components.

**This needs a deliberate decision before implementation.** The choice affects the data model
(whether combinations are represented as named categories or handled by grant composition rules),
the management UI (whether admins see and grant combinations explicitly), and OCAP compliance
posture. Recommend discussing with data stewards and OCAP practitioners before deciding.

### User groups design

`user_groups` and `group_category_grants` are in the entity list but not yet designed. Open
questions: how are group memberships managed (only internally via PAP, or synced from Keycloak
groups)? When a user belongs to multiple groups with overlapping grants, how are those composed
(union is the natural answer but needs to be stated explicitly)? Can a group hold a membership
role in a resource, or only category grants? Does removing a user from a group immediately trigger
revocation of that group's grants for that user?

### Write permissions (Lyric)

The grant model extends naturally to write operations: a grant with `operation: write` (or a
separate `write_grants` table) would allow the PEP plugin in Lyric to enforce which records or
fields a user is permitted to submit or modify. The data model shape is clear; the Lyric plugin
design is not. Deferred until Lyric integration is in scope.

### Data stewardship scoping

The OCAP section introduces the concept of a `category_steward` capability: a user who can
manage grants for specific data categories without holding platform-wide admin rights. The data
model for stewardship scope (which categories a steward governs) and the capability check in the
PAP layer are not yet designed. This is a prerequisite for OCAP-compliant deployments and should
be designed before the management UI work begins.
