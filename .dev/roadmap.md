# Usher Roadmap

Planned work across design, implementation, integration, and infrastructure. Items are open unless
marked `[in progress]`. Completed items are removed; `.dev/sessions/` is the historical record.

---

## Design (pre-implementation)

These must be completed or sufficiently resolved before the relevant implementation phase begins.

### System context diagram

Architectural diagram showing Usher's connections to Overture services and infrastructure (portal-ui, Keycloak, Lyric, Arranger, PEP plugins). Prerequisite for the portal-ui API contract and design review sessions. See `.dev/design/architecture.md`.

### Admin model: open questions

Four items gate the admin API: self-grant compensating controls, self-grant peer revocability, the break-glass procedure, and where a plugin learns that a principal is an administrator (Usher's own role, plugin-side config, or the platform access model, and whether an administrator of an adopting application is the same principal as an administrator of Usher). The last one also gates the bypass audit requirement, since a bypass cannot be logged as such until its source is defined. Lower-priority follow-ups (step-up auth, audit schema, multi-tenancy) can trail v1. See [admin model open questions](docs/atlas/roadmap/admin-model-open-questions.md).

**Self-grant is confirmed as a real path, and its approval requirement is scheduled to change.** It
needs no approval in MVP and will need one once community custodianship is implemented. Build it as
an authority check carrying an exception rather than as a bare write, so the later change removes a
branch instead of introducing an approval workflow. Whose approval is not settled: it was stated as
the owner's, while the trigger is custodianship, which points at the custodian. Treating a self-grant
as an ordinary grant subject to the resource's and the category's authorities admits both without
choosing now. See the admin-plane decision in [design/decisions.md](design/decisions.md).

### Complete permissions model

Seven open items before the core service can be implemented: role capability definitions, field-level restriction approach, overlapping cohort semantics, user groups design, custodian scoping, custodian notification, and category change propagation UI. See [permissions model gaps](docs/atlas/roadmap/permissions-model-gaps.md) and `.dev/design/permissions-model.md`.

Role capability definitions is now reshaped rather than open-ended: see the RABAC alignment item below, which turns it into defining a permission vocabulary and a role-to-permission assignment. Note also that this list and `permissions-model.md` § Open questions disagree, and that neither is complete; write versus read access appears only in the design document despite gating the database schema. Reconciling the two is itself outstanding.

### Align the permissions model with RABAC

The role and attribute hybrid is a named pattern, RABAC, which evaluates access in two stages: a role check for whether a permission is held at all, then attribute filtering for which objects it reaches. Usher built the second stage as category grants and never defined the first, so the token carries a role label with no permission set behind it and no verbs anywhere in the model. The correction is to resolve roles to permissions at issuance and carry the permission set in the token. This closes the create/read/update/delete gap, the single-`role`-against-union-semantics contradiction, and the `public` synthetic-role exception in one change. See [RABAC alignment](docs/atlas/roadmap/rabac-alignment.md).

**Gated by the build-versus-adopt re-evaluation below.** This work reimplements a permission model that at least two existing engines already provide, so it should not start until that question is answered.

### Re-evaluate build versus adopt

The recorded case for building rests partly on a false premise: Cerbos was rejected for producing binary allow/deny decisions, but its query planner performs partial evaluation and returns a three-way discriminated result carrying a condition AST, which is the mechanism this design independently arrived at. Keycloak Authorization Services was never evaluated at all and is already deployed, covering the hybrid pattern, a management UI, and structured grants in a token. "Return what this subject can access" is now a standard capability across several open-source engines rather than a differentiator.

What survives as genuinely ours, pending assessment: delegated governance (a custodian with platform-wide authority over one category and no other admin rights), IdP independence, push revocation with fail-secure suspension, and a non-ORM enforcement path against Elasticsearch through SQON. Corrected evaluation and the wider landscape are in `.dev/design/decisions.md` § Tools reviewed before building.

Three steps, in order: evaluate Keycloak Authorization Services, since it is free and already running; spike the Cerbos query plan plus a thin grants and custodian layer against one real Arranger query; then restate the build rationale in terms of what is left over. Blocks the RABAC alignment work and the database schema, both of which would be rewritten by an adopt decision.

### Restructure the docs against the onboarding artifact's order

Reviewing the onboarding artifact with a non-technical reader produced nine defect classes sorting under two axes, resolvability and fidelity, none of which the existing mechanical checks can express: density, affirmative framing and the dash rules had all been run over that same text and caught none of them. Two outputs: a convention proposal for agentics, and a restructuring pass here. See [documentation review patterns](docs/atlas/roadmap/doc-review-patterns.md), which is appended to as review continues.

The order the artifact establishes, arrived at by a reader rather than an author: what the system is and the question it answers, the problem, the two questions and which software answers each, the access tiers as the organizing idea, the mechanism and the shape of the decision it carries, the decisions with their reasoning, what it is not, status, then vocabulary last as reference rather than prerequisite.

`docs/concepts.md` deviates most: it opens with theory and reaches the access tiers sixth, asking a reader to hold abstractions before anything attaches to them. `docs/intro.md` is problem-first but never presents the tiers as the organizing idea. Both restructures wait until review of the artifact settles, since the order is still being tested.

### GA4GH Passport integration: three gaps

**Not required for iMS v1**, which the business requirements state directly, so this is post-v1 work rather than a launch dependency.

The Clearinghouse design is sound and the `ControlledAccessGrants` mapping is clean, with a Visa's dataset scope matching the resource granularity MVP enforces and its `expires` feeding the existing revocation path. Three gaps remain.

**Only one of four Visa types is mapped, and the other three have obvious homes.** `AcceptedTermsAndPolicies` is what the Registered tier already requires. `ResearcherStatus` is the usual gate for registered-access datasets in GA4GH deployments. `AffiliationAndRole` maps onto membership and bears on the write-versus-read decision, since submission access is gated on organizational affiliation.

**The signature-validation component is unconfirmed.** `docs/concepts.md` places Visa validation at the identity provider. A search found no maintained Keycloak extension providing it, and the reference work in this space (CINECA) pairs Keycloak with Rego policy code to interpret Passports instead. Confirm the component exists before scheduling Passport work: if it does not, the Clearinghouse design has a hole where its validation belongs. Not exhaustively established, so treat as unconfirmed rather than absent.

**Passport interpretation satisfies the OPA revisit condition, and the two records do not reference each other.** `decisions.md` § OPA as the decision engine says OPA becomes a better fit given "conditional policy logic that cannot be expressed as grant records". Evaluating signed claims from multiple issuers against a trusted-issuer list is exactly that, and is unlike the grant-record lookup that argument rejected OPA for. This is the one layer where a policy engine has a clear case.

Revocation before Visa expiry and trusted-issuer governance are already tracked in `.dev/design/to-discuss.md` at HIGH and MEDIUM.

### Move ownership from a single holder to a set

The business requirements call for several holders of resource authority at once, with equal rights to restrict, share and revoke, naming the real case: a principal investigator holds legal authority while submitters do the work, so all of them need it. `permissions-model.md` instead requires exactly one owner per resource and builds the ownership cascade, last-holder promotion and transfer-before-removal on that singularity.

**Decided in the requirements' favour.** The change is from exactly-one to a non-empty set, which the requirements already state from the other side as at least one holder per dataset.

What changes: the cascade seeds a set rather than resolving to one holder; the no-owner invariant becomes non-empty-set, blocking removal of the last holder rather than any; last-holder promotion loses its purpose, since the invariant now prevents the case it repaired. The transfer-with-consent flag survives, with one sub-decision left open, whether adding a holder counts as a transfer for consent purposes, since removal plausibly does and addition plausibly does not. See `.dev/docs/brd-traceability.md`.

### Decisions from the UAC user flows: what remains

All four are answered; see
[docs/uac-flows-traceability.md](docs/uac-flows-traceability.md). Virtual-cohort sharing is out of
MVP, the flows' "Data Admin" is a system administrator on the policy plane, and the submitter-to-owner
correlation is deployment policy rather than an Usher rule. The resource is the study, and "dataset"
is a looser label used at several levels beneath it.

**Still open: may a system administrator grant data access as an override?** Role assignment,
deciding who owns or has custody of what, is clearly the system administrator's. Granting a consumer
access to a dataset is clearly the data-plane roles'. Whether the second is ever reachable as an
override is unanswered, and the flows say no while this design currently allows it.

**Decouple the ownership cascade from Usher.** The cascade in `design/permissions-model.md` reads as
Usher behaviour and should read as a deployment-supplied policy with a default. The mechanism does
not change; who decides does.

### Notification mechanism

Recorded previously as absent from the design with nothing addressing it. The flows put email on the
critical path in four places: sharing with an existing user, sharing with an unregistered address,
declining an invitation, and the registration invitation. Revocation and owner-removal notices are
nice-to-have in both documents. A design omitting notification does not deliver these flows, so this
moves from unaddressed to specified-but-undesigned.

### Authorization for long-running operations

Submission is the only enforcement surface that runs long enough for a credential to expire
underneath it, and the system being replaced solved that by lengthening a platform-wide token to
three hours. That trade is closed by decision; what replaces it needs designing.

Open, and none of it is settled: where re-authorization happens on the upload path, whether per part
or per session; whether an upload session is a first-class object that can be revoked while in
flight; how that composes with whatever short-lived delegation the transfer service issues for the
bytes themselves; and which plugin owns it, since submission spans both halves of the environmental
service. Related to the download enforcement surface item above, which shares the file API and not
the duration problem.

### Download enforcement surface

The flows put constraint-token validation on every file request and block direct URL access at the
API layer, independently of the search path. Two enforcement surfaces rather than one. Ownership of
this was previously open; it now needs designing rather than deciding.

### Conformance case per value-returning surface

**Replaces the aggregation-path requirement violation, which is settled.** The defect required an
authorization field at nesting depth two or greater; the settled filter is a single positive
containment clause on a flat, depth-one field, so the triggering condition is absent by
construction. With one clause there is also no sibling composition, which makes the `should` versus
`must` question moot rather than answered. Two conditions keep it that way, and both are already
required elsewhere: the plugin establishes the field's mapping shape at startup and refuses to
enforce where it cannot, and record-level narrowing stays post-MVP, since a per-record category
field is exactly what would put an authorization field deep enough to trigger it.

**What is not settled by that, and needs building.** A value-returning surface can discard the
filter entirely, which no mapping depth affects and no configuration reveals. An adopter found
exactly that: an aggregation wrapper returning whole-index counts while the record path was
correct, caught by comparing counts rather than by reading code. So the corpus needs a case per
value-returning surface comparing what an under-privileged principal sees against a
fully-privileged one, not only assertions that records are filtered. Specified in
`design/permissions-model.md`; this is the entry it previously lacked.

### Reconcile design docs after the resource-level decision

A full consistency pass over every design and published document found one contract incompatibility, a cluster of contradictions that would mislead an implementer, the superseded JWE rationale surviving in five places including the two documents a newcomer reads first, record-level tagging still presented as current in published docs, and several structural problems that will outlive Phase 1. Prioritized findings with locations: [doc reconciliation](docs/atlas/roadmap/doc-reconciliation.md).

Highest item, and the only one that is not a documentation fix: the `deny` arm of the bridge's `Enforcement` result cannot be expressed at the first adopter's integration point, whose hook is a synchronous total function returning a query node. Needs a decision, not an edit.

### Enforcement gaps from the first plugin integration

Eleven items surfaced by preparing the first plugin integration, none of them waiting on plugin work. Two are fail-open defects and rank above the rest: an unconfigured resource value fails closed on records but **open** on derived artifacts, because it is absent from the complement the ceiling clause is built from; and an unauthenticated request currently renders to no filter at all, which is the allow-everything case rather than a restrictive default. Also covers widening the enforcement seam to distinguish no-relationship from lapsed-grant, and the mapping-format and administrator-source decisions. See [Arranger integration blockers](docs/atlas/roadmap/arranger-integration-blockers.md).

### Saved-set identity and its grants vocabulary

Usher must publish the vocabulary expressing own-sets-by-default, an administrator listing across users, and no reliance on an unguessable set identifier. Recorded as a cycle deliberately: the integration lists this as a prerequisite for Usher while its central fix depends on Usher, and Usher publishing the vocabulary first is what breaks it. Bounded by the derived-artifact constraint, so per-principal set scoping cannot be an end-to-end property on its own. See [Arranger integration blockers](docs/atlas/roadmap/arranger-integration-blockers.md).

### Federation posture

Whether a deployment holding grants should federate at all, given that a remote cannot be compelled to enforce and a remote that ignores a forwarded filter is indistinguishable from one that applied it and matched everything. Needs a decision rather than more description.

### Rework permissions model for resource-level MVP

Four sections of `.dev/design/permissions-model.md` describe record-level enforcement, which is now post-MVP: the visibility rule, its worked example, composition across categories, and category-to-field mapping. All four are marked in place. MVP enforces at resource level, one positive clause on the resource key, so the rework is to separate the MVP mechanism from the deferred one rather than to replace anything. Decisions recorded in `.dev/design/decisions.md`.

### Record-level narrowing on a field a deployment already supplies (post-MVP)

Renamed from "record-level category tagging". "Tagging" named the mechanism as an act of writing
labels onto records, which this design does not do: enforcement filters on fields the data already
carries, and only on descriptive ones. See the descriptive-versus-prescriptive rule under "Usher is
data-agnostic" in [decisions.md](design/decisions.md). The old name survives in several documents
and should go with the next terminology pass.

**This item is narrowing by category specifically, not record granularity in general.** The
distinction was blurred and is worth holding: this item needs each record to carry category labels,
compared against the labels a principal holds. That needs a per-record category field mapped
`nested`, and neither iMS catalogue has one. The clinical index's `file_access` is prescriptive,
holds one value across every record and is unexercised; the environmental catalogue has no
equivalent. Since data is not modified to suit enforcement, this form stays unavailable there.

**Narrowing within a resource by predicate is available now and is not this item.** A filter over
descriptive fields the records already carry narrows at record granularity with positive clauses on
flat keywords, on both catalogues, with no mapping change. Granularity finer than a study can come
from a narrower resource key or from a predicate-scoped grant, neither of which waits on this.

Narrowing within a resource, the same capability as SQON-scoped grants. Two constraints already established: subset containment is expressible in one clause as `not` of `not-in`, verified by executing the compiler rather than reading it, and it requires the field to be mapped `nested`, degrading silently to an existential match on a flat field. Usher cannot require a mapping shape, so this is available only where a deployment supplies conforming data, verified at plugin startup. See [SQON-scoped grants](docs/atlas/roadmap/sqon-scoped-grants.md).

One design item to settle when this is picked up: the shape of the membership predicate. Additive rendering has no implicit baseline for records carrying no category, so membership must render to a positive predicate of its own rather than being the default that exclusions carve into. Not needed for MVP, where the resource-key clause covers it.

The same startup-verification rule extends to mapping depth, not just mapping type: where an authorization field sits at depth two or deeper, a plugin's filtered-aggregation path does not apply and filtering falls back to a disjunctive one, which for an authorization predicate is OR where AND was intended. A plugin must establish the field's mapping shape at startup and refuse to enforce where it cannot, so a non-conforming deployment is one where this narrowing is unavailable rather than one where it silently degrades.

### Define resource derivation for migration

`architecture.md`'s migration table maps each EGO study group to a Usher resource one to one. That holds only where a resource corresponds to an entity with its own creation operation. Where a deployment's resources instead correspond to a registered vocabulary or to an attribute of some other entity, there is no creation operation to map and the step needs its own definition.

Two rules for that step. Derive resources from the registered vocabulary, never by enumerating distinct values found in data: where a deployment has both, the accumulated set drifts from the curated one, including near-duplicate spellings of the same identifier, and enumerating splits one resource in two so that a grant on either silently misses the other's records. And reconcile before creating, since the failure is fail-closed and therefore presents as missing data rather than as an error.

Per-deployment specifics belong in that integration's own repository, not here.

### Cohort registration and Lyric integration

MVP uses pre-registration: cohorts exist in Usher before data is submitted. Three design items gate Lyric integration. See [cohort registration and Lyric integration](docs/atlas/roadmap/cohort-registration-lyric.md).

### Plugin integration design

API contract, request/response shapes, and error codes for token exchange, revocation poll, and push subscription. Also: JWE key distribution and payload schema versioning. See `.dev/design/plugin-integration.md`.

### Database schema design

Physical schema for the permissions model entities: column types, indexes, foreign key constraints, and migration strategy. The engine is decided (PostgreSQL); the logical entity list is drafted in `.dev/design/permissions-model.md`, with four of its twelve tables marked placeholders and no entity at all for custodian scoping.

Correctly blocked rather than behind: the write-versus-read decision determines whether submission writes membership and grant rows or only registers a resource, the RABAC alignment turns permissions into entities, and an adopt decision would replace most of these tables outright.

**The data access layer is a separate decision that currently exists nowhere.** No ORM or query builder is chosen, and the only mention in the corpus is the threat model requiring parameterized statements or an ORM that binds parameters, which constrains the choice without making it. Decide it on its own merits, and note that authorization-filtering Usher's own admin queries (a custodian seeing only the grants they govern) is the same residual-filter problem the enforcement layer solves, so the PAP may want the same machinery as the PEP.

### JWE algorithm selection

Choose between RSA-OAEP and ECDH-ES for key wrap; confirm AES-256-GCM for content encryption. See OWASP A04 gap in `.dev/design/security-threat-model.md`.

### Deployment architecture

High-availability design for stateless Usher instances sharing a policy database as source of truth. Container strategy, health check endpoints, replica configuration.

### Keycloak realm configuration via Terraform operator

Keycloak Terraform operator under evaluation in overture-dev. If adopted, Usher can ship a module provisioning the `usher-platform-admin` role, the Lyric service account, and realm config. Track outcome; update the deployment architecture doc.

### Usher ↔ portal-ui API contract

Portal-facing surface covering user-visible flows (access request, token exchange, denied-access states) in addition to the shared bridge protocol. Depends on the system context diagram; draft before portal-ui begins implementation against a mock.

### Researcher experience design

Three UX decisions gate researcher-facing documentation: access request workflow, denied access presentation, and category grant expiry/renewal. See [researcher experience design](docs/atlas/roadmap/researcher-experience.md).

---

## Implementation: Core service

### Technology stack

TypeScript confirmed; HTTP framework decided (Fastify, with an explicit framework-agnostic application layer constraint). See [technology stack decisions](docs/atlas/roadmap/technology-stack.md).

### IdP integration

OIDC token validation: discovery endpoint consumption, public key caching and rotation, strict `aud`/`iss`/`exp`/scope claim validation. Fail-secure on IdP unavailability.

### Grants computation engine

Resolve current permissions from the policy database and compute the grants payload. Supports the `generatedAt`-based fast-path refresh.

### JWE token issuance

Encrypt the grants payload with the selected algorithms; embed `generatedAt` and `exp`. Usher must refuse to start if the decryption key is unconfigured.

### Revocation system

Per-user `revoked_at` timestamp; push channel (SSE or WebSocket); poll endpoint (`GET /revocations?since=<timestamp>`); scopes: single user, resource-wide, global.

### Audit logging

Structured JSON (Pino) for every authorization decision and revocation event. Dual-channel: policy database (queryable source of truth) and log stream (real-time alerting, SIEM). No token payloads, health record identifiers, or bearer tokens in output.

Two parts of this are design prerequisites rather than implementation, and their cost grows by waiting: the event shape must exist before any enforcement path emits, with the subject field present and null where there is no authenticated principal, or populating it later becomes a schema migration; and the subject identifier is a cross-system correlation key rather than a local choice, so it must match whatever a plugin emits. Denial and administrator-bypass events both need a defined destination. See `.dev/design/audit-events.md`, which carries the catalogue but neither of these.

### Policy database

Schema implementation and migration tooling. Integrity controls: transactions, foreign key constraints, audit triggers for policy changes.

---

## Implementation: Integration

### `@overture-stack/usher-bridge`

Shared library embedded in all client apps: token exchange, local validation, TTL caching, revocation channel (push + poll fallback), revocation-uncertain mode (503 after grace period).

### `@overture-stack/usher-arranger`

Express middleware for `arranger-graphql-router`. Translates grants payload into server-side SQON filters. First integration target. Arranger-specific design in `arranger/.dev/docs/usher-plugin.md`.

### Additional per-app plugins

`@overture-stack/usher-lyric` and others, each translating the grants payload into the app's native query format.

---

## Implementation: Management UI

Design not yet started; see `.dev/design/management-ui.md`. High-level scope: resource, role, and category management; membership and grant assignment; emergency revocation; audit log viewer.

---

## Testing

### Load and latency testing

Usher sits on the hot path of every authenticated request. Response latency on the token
exchange endpoint, the revocation poll endpoint, and the SSE connection handshake must be
validated under load as part of the standard test suite, not as a one-off exercise.

Include a load/performance test suite alongside the unit and integration tests. `autocannon`
is the natural choice for a Fastify service (Fastify itself uses it for benchmarks); `k6` is
the alternative if the team wants a more expressive scripting model or cross-service scenarios.

The test must cover at minimum: token exchange throughput under concurrent load, SSE connection
count at the expected bridge-per-instance ceiling, and latency distribution (p50/p95/p99) on
the critical path. Define acceptable thresholds before implementation so regressions are caught
rather than discovered in integration testing.

---

## Documentation

### Docs-tier gaps (blocked on prior design)

- Researcher journey guide: blocked on access request workflow design
- Denied access UX documentation: blocked on denied access UX decision
- Category grant expiry and renewal guide: blocked on expiry notification design
- Grants token payload schema: blocked on schema finalization in `plugin-integration.md`

### Integration guide

Consumer-facing companion to `plugin-integration.md` for plugin developers. Blocked on `plugin-integration.md` being completed.

### Administration guide

Consumer-facing companion to `admin-model.md` and `management-ui.md`; must cover data tier classification. Blocked on admin model open questions and management UI design.

---

## Future scope

### DACO-style access approval workflows

Ethics-review-gated access with time-limited validity and renewal. The `expires_at` field on category grants anticipates this; the approval workflow is not yet designed.

### Multi-tenancy

Single deployment serving multiple independent organizations with full policy isolation. Not in initial scope; architecture must not preclude it.

### Additional IdP connectors

Beyond Keycloak and Azure Entra: other OIDC providers, SAML-based IdPs.

### Globus integration

Globus Auth as an OIDC identity source; Globus Groups as potential membership source. Integration scope TBD: IdP connector only, or deeper Globus data access and transfer integration.

### SQON-scoped grants

Optional `sqon` field on `category_grants` narrowing which records within a category a grant covers, enabling community-specific access and filtered-subset sharing. See [SQON-scoped grants](docs/atlas/roadmap/sqon-scoped-grants.md).

### Security event streaming (Kafka)

Upgrade path from Valkey Streams for durable, replayable event fan-out to external consumers (SIEM, compliance, alerting). Not needed for v1; no architectural changes required to add it later.
