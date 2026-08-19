# Design Decisions

Key architectural choices and the reasoning behind them, including tools reviewed and not adopted.
Where a reviewed tool influenced the design, that contribution is noted.

---

## Tools reviewed before building

### Cerbos

Cerbos is a standalone PDP (Policy Decision Point) service: applications send a request containing
user context and a resource, and Cerbos responds with an allow/deny decision based on policies
defined in YAML files.

**What we borrowed.** The standalone PDP service pattern (rather than an embedded library) is the
right architecture for a shared authorization service across multiple applications. Cerbos confirmed
this and its REST API design is a reference for Usher's decision API: a clear request schema
(principal, resource, action) and a structured, auditable response.

**Why not adopted.** Two gaps: decisions are binary (allow/deny), and there is no management UI.
Usher's use case requires a structured grants output rather than a pass/fail answer: the
application needs to know not just "can this user see data?" but "which categories of data can they
see, in which resources?" That structured answer cannot come from Cerbos without significant
wrapping. The absence of a management UI is a separate gap (addressed by Cerbos Hub, see below).

---

### OPA as the decision engine

OPA (Open Policy Agent) is a CNCF-graduated general-purpose policy engine. Policies are written in
Rego and evaluated against input data. OPA is widely adopted for Kubernetes admission control and
API gateway authorization.

**Why we looked at it.** OPA is mature, well-maintained, and well-recognized. Teams familiar with
OPA from Kubernetes work know how to operate it, write policies, and integrate it into CI/CD. Using
OPA as Usher's evaluation engine would have offered ecosystem familiarity as an adoption benefit.

**What we borrowed.** OPA's concept of partial evaluation directly influenced the grants token
design. In partial evaluation, OPA accepts some known facts and some unknown ones, and produces a
residual: an unevaluated expression that represents the remaining grants. Usher's grants
token is the same idea in a different form: rather than returning a binary answer, Usher returns the
full set of category grants for the requesting application. The plugin applies that set as a query
filter, which is structurally a residual evaluation applied at the data layer.

OPA also reinforced the value of externalizing authorization state as explicit, queryable data
rather than encoding it implicitly in application logic. That principle is central to Usher's grant
model.

**Why not adopted.** Usher's decision logic is a grant data lookup, not policy evaluation.
The question "what can this user see?" is answered by querying which grant records exist for that
user. There is no Rego logic to evaluate: the policy IS the grant record. Using OPA would mean
feeding the grants database into OPA's data store and writing Rego that simply reads it back. That
adds operational complexity (data sync between the grants store and OPA, Rego maintenance) without
adding capability. The migration benefit OPA offers (ecosystem familiarity) also depends on
exposing Rego policies as a customization surface; if the Rego is internal, that benefit does not
transfer. If it is exposed, it adds significant complexity to what is currently a clean, well-defined
data model.

**Conditions for revisiting.** If a future requirement introduces conditional policy logic that
cannot be expressed as grant records (e.g., "grant access only if the user has completed training
Y, as asserted by institution X"), OPA becomes a much better fit as the evaluation engine for that
layer. At that point, the grant model would feed data into OPA and Rego would express the
conditions. This is worth reconsidering before implementing any conditional evaluation feature.

---

### OPA at the enforcement layer

Separate from its role as a decision engine, OPA was considered as a component within enforcement
plugins: the per-application code that receives the grants token and translates it into
data-layer query filters.

**Why we looked at it.** The mapping from a category grant set to a concrete query filter (e.g.,
"category `registered` in resource `cohort-A`" maps to a specific Elasticsearch DSL fragment or SQL
predicate) is deployment-variable and schema-specific. This is precisely the kind of externalizable,
auditable policy logic OPA is designed for. Organizations already running OPA sidecars could
potentially integrate Usher's enforcement by adding a policy bundle rather than embedding a new
library.

**What we borrowed.** The sidecar deployment model: the plugin does not need to be embedded in
application code. It can run as a separate process that the application calls. This pattern,
well-established in OPA deployments, is a valid option for Usher plugins and the plugin interface
is designed to accommodate it.

**Why not mandated.** OPA's primary model for keeping data current is bundle pulls: periodic
fetches from a bundle server. Usher's revocation channel is a push model: the plugin must subscribe
to real-time grant change notifications and invalidate its cached token promptly. These two models
do not align. OPA bundle pulls introduce a staleness window that conflicts with Usher's revocation
guarantees. The time-critical parts of enforcement (revocation subscription, fail-secure on channel
disruption) still require custom plugin code regardless of whether OPA is involved. OPA would
cover only the filter translation slice of a plugin that still needs custom revocation handling.

**Decision.** OPA is not required at the enforcement layer. The plugin SDK handles the generic
parts: JWE decryption, revocation channel subscription, TTL management, and fail-secure response.
Teams with existing OPA investments can use OPA for query filter translation within their plugin
implementation. The plugin interface is designed to accommodate this without requiring it.

---

### Cerbos Hub

Cerbos Hub is a commercial SaaS product that adds a management UI on top of the open-source Cerbos
PDP. It is not self-hosted and not open-source.

**Why not adopted.** Vendor dependency and SaaS hosting make it unsuitable for on-premises
biomedical deployments. Not evaluated technically.

**What it told us.** The existence of Cerbos Hub is informative: the Cerbos team built it because
Cerbos without a UI has significant adoption friction. Authorization services need a management
interface for non-technical administrators to manage grants, review access, and respond to
governance inquiries. This is not a nice-to-have. Usher's design includes the management UI
(PAP layer) in scope from the start rather than treating it as a later addition.

---

## Architectural decisions

### Grants token over binary allow/deny

A binary response from the PDP (allowed/denied) requires every application to call back to the
decision service on every data access, or to cache a broad allow/deny that cannot express partial
access. Neither fits a platform where a user may be permitted to see some records and not others.

Usher returns a structured grants token: the full set of category grants the user holds, scoped
to the resources the requesting application manages. The application plugin applies this as a
query-time filter. A single token fetch covers the session; the plugin uses it for every query
without a round-trip per request.

**Tradeoffs accepted.** The plugin must implement query filter logic, not just a gate check. This
is more work per integration. It is unavoidable: the filtering logic requires application-specific
query language and schema knowledge that Usher cannot have.

---

### JWE (encrypted) over JWS (signed) for the grants token

A signed token (JWS) is readable by anyone with the public key, including the user. A user who can
read their own grants token can enumerate which categories they do not hold grants for and
potentially craft queries to probe or bypass enforcement.

The grants token is encrypted (JWE) and decrypted only by the application plugin. The user
receives and forwards an opaque token they cannot inspect.

**Tradeoffs accepted.** Each bridge instance needs a decryption key provisioned at deploy time.
Key distribution and rotation are operational concerns that would not exist with a signed token. For
the full mechanism and rationale, see
[security-workflow.md — Grants token format](security-workflow.md#grants-token-format-jwe).

---

### Plugin enforcement over gateway/proxy enforcement

A gateway (API proxy, sidecar) can allow or block requests. It cannot reshape queries. Usher's
enforcement model requires query shaping: the plugin must inject grant-based predicates into every
data query before it reaches the data layer. A gateway operating at the HTTP level cannot do this
for GraphQL, SQON, or other structured query formats without deep protocol awareness.

Plugin enforcement runs inside the application and has access to the query structure before it is
serialized and sent. The plugin shapes the query; the data layer receives a pre-filtered request.

**Tradeoffs accepted.** Every application that serves protected data must implement a plugin.
Enforcement is distributed rather than centralized. An application that skips the plugin has no
enforcement: there is no backstop at the network layer.

---

### Push revocation over pure TTL

A short token TTL limits the staleness window but requires frequent token refreshes and adds
round-trip latency. A long TTL reduces round-trips but widens the window where a revoked grant is
still honoured.

Usher uses a push revocation channel (SSE or WebSocket with poll fallback): plugins subscribe and
receive notification when grants change. Cached tokens are invalidated on notification rather than
on expiry. The TTL is a backstop, not the primary revocation mechanism.

**Tradeoffs accepted.** Plugins must maintain a persistent connection to the revocation channel.
If the channel is disrupted, the plugin cannot know whether its cached grants are still valid.
For the mechanism (push + poll, multi-instance propagation), see
[security-workflow.md — Emergency access revocation](security-workflow.md#emergency-access-revocation).

---

### Fail-secure when the revocation channel is unavailable

If a revoked grant notification is never delivered, the plugin would continue honouring access that
has been withdrawn. An adversary who can silence the revocation channel would preserve stale access
indefinitely with pure TTL fallback.

When the revocation channel is unavailable beyond the configured grace period, the plugin returns
503 (service unavailable) and suspends data access until connectivity is restored. An adversary who
silences the channel gains no access; they only cause a service disruption.

**Tradeoffs accepted.** A revocation channel outage becomes a data access outage. This is the
correct behaviour for a system handling sensitive or health-adjacent data, and is a deliberate
design choice rather than an oversight. For the failure behaviour and grace period design, see
[security-workflow.md — Revocation channel integrity](security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour).

---

### Usher is data-agnostic

Usher does not know the schema of the data it protects. It does not query the data store, run
migrations, or write to any data table. It holds grants (user, resource, category) and issues
grants tokens. What those categories mean in terms of actual records or fields is
application-specific configuration that lives in the plugin.

This allows Usher to be adopted without modifying the data being protected, and removed without
leaving data artefacts. It also keeps Usher generic across data formats (relational, document,
search index) without needing format-specific logic.

**Tradeoffs accepted.** Usher cannot validate that a category or resource name corresponds to
anything real in the data layer. Misconfigured grants (referencing a nonexistent category) are
silent. Validation is the responsibility of the management UI and the plugin configuration.

---

### FR-08: sharing at study level satisfies snapshot sharing without snapshot machinery

FR-08 from the iMS Data Portal UAC BRD requires that a sharing action captures the dataset
definition at the time of sharing. In a system where the unit of sharing is a study (all records
in it, including future ones), the "dataset definition" is simply the study identifier. A
`category_grant` scoped to that resource is the snapshot: it captures which resource was shared
and when.

No point-in-time record snapshot is needed for MVP. The grant IS the dataset definition. Future
records added to the study are automatically covered by the existing grant, which is the intended
behaviour for study-level access.

**What is deferred.** If a future requirement calls for sharing a filtered subset of records at a
point in time (a SQON-defined cohort rather than a whole study), the grant would need to carry a
SQON filter expression capturing the filter state at share time. This is the post-MVP SQON-scoped
grants extension and is explicitly out of scope for the initial implementation.

---

### Accept/decline invitation flow is the default; auto-accept is configurable

When a category grant is created for a registered user, the default behaviour is that the grant
enters an *awaiting-acceptance* state: the grantee must explicitly confirm they accept
data-sharing responsibility before the grant becomes active and appears in their grants token.
This is distinct from older designs where grant creation immediately activated access.

The reasoning: researchers may not want to hold responsibility over data they did not request, and
accepting access to health data carries legal and ethical obligations in many jurisdictions. Silent
activation removes the grantee's ability to make an informed decision.

A configurable `auto-accept` flag (name TBD) bypasses the acceptance step for deployments where
it is not operationally appropriate (machine-to-machine sharing, internal pipelines, or any case
where all parties are institutional accounts rather than individual researchers). The flag is off
by default across all deployments.

Grants sent to an unregistered email address enter the *pending* state (not awaiting-acceptance)
and remain pending until the user registers. On registration, pending grants are migrated to
awaiting-acceptance under the user's Keycloak user ID, then follow the standard acceptance flow.

**Tradeoffs accepted.** The acceptance step adds friction to the sharing workflow. This is
intentional: the friction is the point. Deployments that cannot tolerate it have the auto-accept
option; deployments handling PHI should leave auto-accept off.

---

### EGO is replaced, not integrated

Usher is the full replacement for EGO (Overture's previous authorization service). The
integration strategy considered (running Usher alongside EGO and having both manage grants)
is not adopted. EGO uses a different data model (groups and policies) that does not align cleanly with
Usher's resource/membership/category-grant model; maintaining both simultaneously doubles the
failure surface and creates policy synchronization risk with no long-term benefit.

The replacement strategy: enumerate EGO's `STUDY-*` groups, map each to a Usher resource, and
map EGO group memberships to Usher memberships. The studies management service (which orchestrated
EGO) is retired; its operations become Usher admin API calls. Backend services in iMS that
currently call EGO's authorization endpoints are updated to use Usher's bridge and token exchange.

**Tradeoffs accepted.** A full replacement requires a migration event and a coordinated cutover
for iMS backend services. This is harder than an incremental integration but avoids indefinite
operational complexity from running two authorization systems.

---

### User IDs (Keycloak subject) as primary identifier; email for pending grants only

Usher uses the Keycloak user ID (the `sub` claim from the OIDC token) as the primary identifier
for memberships, category grants, audit records, and all API interactions involving registered
users. Email addresses are not used as identifiers in any active grant or membership record.

The reasoning: user IDs are opaque identifiers with no intrinsic meaning. An email address
leaked in a token or log exposure reveals PII; a Keycloak UUID reveals nothing without access to
the IdP. Email addresses can also change; subject IDs are stable for the lifetime of the account.

Email is used in exactly one place: the `pending_grants` entity, where a grant has been sent to
an address that belongs to a user who has not yet registered. Once the user registers, the pending
grant is migrated to their Keycloak user ID and the email reference is discarded.

Any portal or consumer-facing feature that needs to display a user's name or email (for example,
a "shared with me" listing) resolves that information via the Keycloak admin API at the portal
layer, not by storing email in Usher's policy tables.

**Tradeoffs accepted.** The portal layer bears responsibility for email-to-ID resolution and
display. This is a deliberate separation: Usher is an authorization service, not a directory.

---

### Usher is the resource lifecycle management layer

Usher's scope extends beyond authorization decisions to owning the full lifecycle of the resources
it protects: creation, metadata management, membership assignment, category association, visibility
policy (embargo, orphan state), and retirement.

Previously, a separate "studies management service" handled this orchestration on top of EGO.
Absorbing those responsibilities into Usher eliminates the orchestration layer and makes Usher the
single source of truth for resource metadata. Downstream services (Arranger, Lyric) reference
Usher resource IDs; they do not maintain their own resource registries.

This scope is intentionally generic: Usher manages "resources," not "studies." What a resource
represents (a study, a dataset, a project, a programme) is a deployment concern expressed through
the management UI's labelling and the plugin's field mapping config. The core model is the same
regardless.

**Tradeoffs accepted.** Usher must provide a resource management API surface in addition to its
authorization API. This expands the implementation scope but removes an entire service from the
deployment topology.

---

### SONG is file metadata only; Usher owns resource metadata

SONG's role in Usher-adopting deployments is narrowed to file-level manifest data: file
checksums, donor/sample links, and file object identifiers. SONG is not a source of truth for
resource metadata (cohort names, category assignments, ownership, or membership).

Previously, the studies management service used SONG as the authoritative record of which studies
existed. This created a dependency on SONG for authorization decisions, and excluded deployments
that do not run SONG. Usher owns resource metadata instead: when a resource is created (either by
an admin or by the Lyric service account at submission time), Usher is the record of that
resource's existence, name, and category assignments.

Deployments that include SONG use it for its original purpose (file manifests and genomic
metadata) and Usher for access control. Deployments without SONG are fully supported; Usher has
no SONG dependency.

---

### "Study" and other domain terms are deployment vocabulary

Usher's model uses generic terms: resource, membership, category grant. Domain-specific vocabulary
(study, cohort, dataset, project, program) appears only in deployment configuration and management
UI labelling.

In iMS, what a user calls a "study" maps to a Usher resource where the plugin config identifies
records using `fieldName: "study_id"`. The string "study" appears in the iMS portal UI and in
the Arranger plugin configuration; it does not appear in Usher's entity schema or API responses.

This is a deliberate inversion of the EGO/studies-management-service model, where "study" was a
first-class concept embedded in group names (`STUDY-<id>`) and service logic. Making the model
generic means Usher can serve deployments with different domain vocabulary without code changes.

---

### Additive grant pipeline with anonymous grants token for open data

A common alternative for open data is to handle unauthenticated requests outside the
authorization system: the plugin applies an exclusion filter for all sensitive categories, no
token exchange occurs, and open access is unlogged. This creates two code paths (authenticated
vs. anonymous) and leaves open access invisible to the audit trail.

Usher issues a grants token for every request, including unauthenticated ones. For anonymous
users the controller computes only the open-data tier (no IdP token validation, no membership
lookup): the result is a grants token containing only open-resource grants. The bridge and
plugin handle this token identically to an authenticated one.

Grant computation is additive across three tiers, always in order:

1. **Open** — computed for all users, including anonymous; no IdP token required
2. **Registered** — computed for authenticated users with a membership in the resource
3. **Controlled** — computed for authenticated users with an explicit category grant record

Standards consulted: GA4GH Data Access Framework (open/registered/controlled tier model),
NIST SP 800-162 (ABAC), NIST SP 800-207 (Zero Trust).

**Tradeoffs accepted.** Every unauthenticated request triggers a token exchange call to the
controller. For high-traffic open-access deployments this is additional load compared to a
static exclusion filter. The cost is mitigated by the `generatedAt` fast-path cache and by
Valkey-backed shared cache across controller instances; it is accepted in exchange for audit
completeness and a single code path across all access tiers.
