# Usher Roadmap

Planned work across design, implementation, integration, and infrastructure. Items are open unless
marked `[in progress]`. Completed items are removed; `.dev/sessions/` is the historical record.

---

## Design (pre-implementation)

These must be completed or sufficiently resolved before the relevant implementation phase begins.

### System context diagram

An architectural diagram showing how Usher connects to each Overture application and
infrastructure component: portal-ui, Keycloak, clinical-submission (Lyric), Arranger, and
the PEP plugins. Should capture data flows (token exchange, grant approval, revocation), trust
boundaries, and the responsibility of each component. Prerequisite for design review sessions
with portal-ui and for the Usher ↔ portal-ui API contract to be reviewed meaningfully. See
`.dev/design/architecture.md` for existing component descriptions.

### Admin model: open questions

Role taxonomy, OIDC-first identification, bootstrap, self-grant flow, service accounts, and
audit integrity are documented in `.dev/design/admin-model.md`. The following must be resolved
before the admin API is implemented:

- **Self-grant compensating controls:** step-up authentication (MFA re-prompt) and resource
  owner notification are linked: if step-up is deferred to v1+, owner notification is required
  for v1. Both cannot be deferred simultaneously. Notification requires infrastructure design.
- **Self-grant peer revocability:** self-grants are standard grants; any platform admin can
  revoke any grant, including a peer's active self-grant. Decide whether to restrict self-grant
  revocation to the creator or leave it open to all platform admins.
- **Break-glass procedure:** if all platform admins are unavailable, recovery goes through the
  IdP (Keycloak). The deployment runbook must document who is authorized to perform IdP-level
  role assignment and what audit trail is expected from the IdP layer.

Lower priority (can follow v1):
- Self-grant step-up authentication (NIST SP 800-63B recommended; see compensating controls above)
- Audit event schema formalization (minimum fields defined in admin-model.md; formal schema TBD)
- Multi-tenancy admin scope

### Complete permissions model

The structure (hybrid role + attribute, data categories, memberships, category grants) is defined.
Still needed:
- Role capability definitions: what specific actions does each role permit beyond resource access?
- Field-level restriction implementation approach (options A-D analysed; recommendation: start with
  A, extend to C; formal choice not yet committed)
- Overlapping cohort access semantics: if a record belongs to cohorts A and B and the user is a
  member of A only, do they see it? (OR vs AND; see permissions-model.md Open questions)
- User groups design: Keycloak sync or PAP-only? Composition when groups overlap? Revocation when
  a user is removed from a group? (entities are placeholders; design not yet done)
- Data stewardship scoping: `category_steward` capability data model (OCAP prerequisite; must be
  designed before management UI work begins; see permissions-model.md, OCAP section)
- Custodian notification design: when tightening changes reduce access for existing members,
  affected users must be notified. Notification mechanism not yet designed. Blocks category
  change propagation in the management UI; see permissions-model.md "Category change propagation".
- Category change propagation UI: the management UI must surface a pre-grant flow (grant affected
  users before tightening takes effect) and the set of affected users derivable from the audit
  entry; see permissions-model.md "Category change propagation".

See `.dev/design/permissions-model.md`.

### Cohort registration and Lyric integration

The MVP approach for resource creation is pre-registration: an admin creates the study or cohort
entity in Usher (owner, stewards, category config, field-value identifier) before any data is
submitted. Submission of unregistered cohorts is rejected. See `.dev/design/to-discuss.md`
(Ownership and stewardship section) for the full description.

Design work needed before Lyric integration begins:
- Service account capability set for Lyric: what it can create or query on behalf of owner-level
  submitters; see `.dev/design/permissions-model.md` (Ownership assignment section) and
  `.dev/design/admin-model.md` (service account model)
- Trust model for the Lyric service account: how Lyric authenticates with Usher, what it can
  assert about the submitting user, and what it cannot override
- Self-grant prevention check: must be specified before the grant approval endpoint is built;
  see `.dev/design/to-discuss.md` (Ownership and stewardship section)

Post-MVP: optional submission-time cohort creation shares the same code foundation as
pre-registration, making pre-registration "run creation before submission."

### Plugin integration design

API contract, request/response shapes, and error codes for:
- Grants token exchange endpoint
- Revocation poll endpoint (`GET /revocations?since=<timestamp>`)
- Push event subscription (SSE or WebSocket)

Also needed: JWE decryption key distribution and rotation strategy; grants payload schema
version handling. See `.dev/design/plugin-integration.md`.

### Database schema design

Logical entities are defined in the permissions model. Physical schema needed:
column types, indexes, foreign key constraints, and migration strategy.

### JWE algorithm selection

Specific algorithms for content encryption (AES-256-GCM) and key wrap (RSA-OAEP or ECDH-ES) must
be chosen, documented, and applied consistently. See OWASP A04 gap in
`.dev/design/security-threat-model.md`.

### Deployment architecture

High-availability design: how multiple Usher instances share state (the policy database is the
source of truth; instances are stateless beyond in-flight request handling). Container strategy,
health check endpoints, and expected pod/replica configuration.

### Keycloak realm configuration via Terraform operator

A Keycloak Terraform operator is currently under evaluation in overture-dev for applying realm
settings declaratively (roles, clients, realm config) without requiring manual Keycloak UI
work. If adopted, the Usher deployment can ship a Terraform module that provisions the
`usher-platform-admin` role, the Lyric service account client, and other required realm
configuration automatically.

Track evaluation outcome and update the deployment architecture doc accordingly. If adopted,
this partially addresses the break-glass runbook gap: the Terraform state becomes the audit
record for IdP configuration changes.

### Usher ↔ portal-ui API contract

The endpoints portal-ui calls, the token format it receives, and the error states it must handle.
Requested as a design deliverable before portal-ui implementation can begin against a mock.
Distinct from the general plugin integration contract above: this is the portal-facing surface
specifically, covering the user-facing flows (access request, token exchange, denied-access
states) in addition to the shared bridge protocol.

Portal-ui work is blocked on Usher's core grants and multi-owner model being built. This contract
should be drafted and frozen before that implementation completes so portal-ui can start in
parallel against a mock. Depends on the system context diagram being completed first.

### Researcher experience design

Several aspects of the researcher-facing experience require design decisions before they can be
implemented or documented. These gaps were identified during an audience-perspective review of the
consumer-facing docs.

- **Access request workflow.** When a researcher needs access to categorized data, how do they
  initiate the request? Options: a self-service form in the management UI that a Steward or Admin
  reviews and approves; an external DAC integration via REMS/GA4GH Passport; or an out-of-band
  process (institutional or email). The in-product request flow is not yet designed. This is
  prerequisite to the researcher journey documentation and related to the DACO-style approval
  workflows in Future scope (the difference: DACO is about ethics-review-gated access
  specifically; this covers the general grant request path).
- **Denied access user experience.** When a member has no category grant for a given category,
  records tagged with that category are excluded from their results. The user-facing manifestation
  of this exclusion is a plugin design decision: an empty result set, a reduced count, an
  informative message, or no indication at all. Each option has UX and privacy implications.
  Existence denial is a hard invariant (OWASP A01); revealing that records exist but are
  inaccessible violates that invariant, but revealing nothing may confuse researchers who expect
  records they know exist.
- **Category grant expiry and renewal.** Category grants carry an `expires_at`. No mechanism is
  designed for notifying researchers before their grant expires or for guiding them through
  renewal. This is distinct from the custodian notification item in the permissions model section
  (which covers tightening changes applied by an admin or owner): this covers the researcher's own
  expiry and renewal cycle.

---

## Implementation: Core service

### Technology stack selection

- **Language:** TypeScript (confirmed; Overture ecosystem consistency).
- **HTTP framework:** **decision required before implementation begins.** Two genuine candidates:
  - **Fastify:** performant, TypeScript-native, Pino built in, larger ecosystem, `@fastify/express`
    compatibility shim for any existing Express middleware that needs to run inside the controller.
    Battle-tested at scale; most relevant prior art for this kind of service.
  - **Hono:** newer, lightweight, edge/multi-runtime native. Strong TypeScript ergonomics and a
    clean middleware API. Smaller ecosystem and fewer production references at this service's
    security and concurrency profile. Worth evaluating seriously if the team is already investing
    in it elsewhere.
  Note: PEP plugins (`usher-arranger`, `usher-lyric`) are Express middleware for their respective
  target applications and are unaffected by this choice; they communicate with the controller over
  HTTP regardless of framework.
- **Structured logging:** Pino (strongly preferred; to confirm with HTTP framework). Integrates
  natively with Fastify; outputs structured JSON by default; one of the fastest Node.js loggers,
  which matters on the auth hot path. Audit events are dual-channel: stored in the policy database
  (queryable source of truth for governance reviews) and emitted as Pino structured log lines
  (forwarded to a log aggregator for real-time alerting and external system integration). Both
  channels are required; the database alone is insufficient for real-time security monitoring.
- **Policy store:** PostgreSQL (confirmed). Handles grants, memberships, categories, `revoked_at`
  timestamps, and the audit log; requires transactions and foreign-key integrity.
- **Shared cache and revocation pub/sub:** Valkey (confirmed; already deployed in the Overture
  environment; protocol-compatible with Redis). Needed alongside PostgreSQL, not a replacement.
  Two roles: caching computed grants payloads across Usher instances (the `generatedAt`
  fast-path), and pub/sub backbone for the push revocation channel (one instance processes a
  revocation; Valkey notifies SSE subscribers on all others). Valkey Streams provides durable
  in-process event passing for v1; see Kafka in Future scope for external consumer fan-out.

### IdP integration

OIDC token validation: discovery endpoint consumption, public key caching and rotation, strict
claim validation (`aud`, `iss`, `exp`, scope). Must handle IdP unavailability fail-secure:
if the IdP cannot validate a bearer token, reject the grants token exchange request.

### Grants computation engine

Given a validated user identity, resolve current permissions from the policy database and compute
the grants payload. Must support the `generatedAt`-based fast-path refresh (skip full
computation if no policy change since `generatedAt`).

### JWE token issuance

Encrypt and sign the grants payload using the selected JWE algorithms. Embed `generatedAt`
and `exp`. The decryption key must not have a default value; Usher must refuse to start if
unconfigured.

### Revocation system

- Per-user `revoked_at` timestamp in the policy database
- Push channel: SSE or WebSocket endpoint for bridge subscriptions; emit on revocation
- Poll endpoint: `GET /revocations?since=<timestamp>` returning changed user IDs
- Revocation scopes: single user, all users of a resource, global (with confirmation)

### Audit logging

Structured JSON log (via Pino) for every authorization decision (user, resource, categories in
scope, decision, timestamp) and every revocation event (actor, scope, timestamp). Must never
include grants token payloads, health record identifiers, or bearer tokens. Retention policy
to be defined at deployment time.

Audit events are dual-channel: stored in the policy database and emitted as structured log lines.
The database is the queryable source of truth; the log stream is the channel for real-time
alerting, intrusion detection, and SIEM integration. See Technology stack selection for the
Pino/Valkey/Kafka split across these channels.

### Policy database

Schema implementation and migration tooling based on the completed schema design. Integrity
controls: transactions, foreign key constraints, and audit triggers for policy changes.

---

## Implementation: Integration

### `@overture-stack/usher-bridge`

Shared library embedded in all client apps (via the per-app plugin):
- JWE token exchange with the controller
- Local token validation and grants payload extraction (decryption)
- TTL-aware caching
- Revocation channel: push subscription with reconnection logic; poll fallback
- Revocation-uncertain mode: suspend sessions after grace period; return 503
- Configurable TTL, grace period, and poll interval

### `@overture-stack/usher-arranger`

Express middleware for `arranger-graphql-router`. Translates Usher grants payload into
Arranger server-side SQON filters. First integration target.

### Additional per-app plugins

`@overture-stack/usher-lyric` and others as needed, each translating the grants payload into that app's
native query format.

---

## Implementation: Management UI

Design not yet started; see `.dev/design/management-ui.md` for known scope and open questions.

High-level scope:
- Resource, role, and data category management
- Membership assignment and revocation
- Category grant management (with expiry support)
- Emergency revocation controls (single user / resource / global)
- Audit log viewer

---

## Documentation

### Docs-tier gaps: blocked on prior design

- **Researcher journey guide.** A page describing the researcher experience: requesting access,
  receiving approval, understanding what is visible and what is not, and renewing before expiry.
  Blocked on the access request workflow design (see Researcher experience design above).
- **Denied access user experience documentation.** What a researcher sees when records are
  excluded from their results. Blocked on the denied access UX design decision.
- **Category grant expiry and renewal guide.** The researcher experience of time-limited access:
  expiry notification, renewal path, and what happens when a grant lapses. Blocked on expiry
  notification design.
- **Grants token payload schema.** The token structure is described conceptually in
  concepts.md but the actual payload schema (field names, types, the `categories` include-list
  structure, `generatedAt`) is not documented in docs/. Blocked on schema finalization in
  plugin-integration.md.

### `/docs/` integration guide

Consumer-facing companion to `plugin-integration.md`: a lighter guide for developers building
enforcement plugins, framed for the integration use case rather than the full design rationale.
Blocked on `plugin-integration.md` design being completed.

### `/docs/` administration guide

Consumer-facing companion to `admin-model.md` and `management-ui.md`: how to configure and
administer a running Usher deployment (resources, categories, grants, roles, revocation).
Must cover data tier classification: who decides what tier applies to a given dataset and how
that is configured in a deployment. This is a real operator question not answered anywhere in
current docs or design.
Blocked on admin model open questions being resolved and management UI design being completed.

---

## Future scope

### DACO-style access approval workflows

Ethics-review-gated access (access granted only after an ethics approval process, with time-limited
validity and a renewal pathway). The data model's `expires_at` on category grants anticipates this;
the approval workflow itself is not yet designed.

### Multi-tenancy

Single Usher deployment serving multiple independent organizations with full policy isolation. Not
in initial scope; the architecture should not preclude it.

### Additional IdP connectors

Beyond Keycloak and Azure Entra: other OIDC providers, SAML-based IdPs.

### SQON-scoped grants

An optional `sqon` field on `category_grants` that narrows which records within a category a
grant covers. Enables governance bodies to approve access to a specific subset of their category
(e.g. "indigenous records from community X only") rather than the full category within a resource.
Requires SQON evaluation capability in the bridge: the bridge ANDs the grant's SQON filter into
the query alongside the category-level filter.

Also enables the post-MVP version of FR-08: sharing a filtered subset of records (a SQON-defined
cohort) rather than a whole study, with the filter state captured in the grant at share time.

See `.dev/design/permissions-model.md` (Multi-category intersection, resolved section) and
`.dev/design/decisions.md` (FR-08 section) for design rationale.

### Security event streaming (Kafka)

For durable, replayable security event streams destined for external consumers (SIEM platforms,
compliance audit pipelines, alerting systems), Kafka is the natural upgrade from Valkey Streams.
Not needed for v1, where Pino log forwarding and Valkey pub/sub cover real-time notification
needs. Kafka becomes relevant when fan-out to multiple independent external consumers is required,
or when events must survive a Usher restart and be replayable. Adding it later requires no
architectural changes to the core service: the same audit events already being logged and stored
become the source.
