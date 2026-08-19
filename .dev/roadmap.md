# Usher Roadmap

Planned work across design, implementation, integration, and infrastructure. Items are open unless
marked `[in progress]`. Completed items are removed; `.dev/sessions/` is the historical record.

---

## Design (pre-implementation)

These must be completed or sufficiently resolved before the relevant implementation phase begins.

### System context diagram

Architectural diagram showing Usher's connections to Overture services and infrastructure (portal-ui, Keycloak, Lyric, Arranger, PEP plugins). Prerequisite for the portal-ui API contract and design review sessions. See `.dev/design/architecture.md`.

### Admin model: open questions

Three items gate the admin API: self-grant compensating controls, self-grant peer revocability, and the break-glass procedure. Lower-priority follow-ups (step-up auth, audit schema, multi-tenancy) can trail v1. See [admin model open questions](docs/atlas/roadmap/admin-model-open-questions.md).

### Complete permissions model

Seven open items before the core service can be implemented: role capability definitions, field-level restriction approach, overlapping cohort semantics, user groups design, steward scoping, custodian notification, and category change propagation UI. See [permissions model gaps](docs/atlas/roadmap/permissions-model-gaps.md) and `.dev/design/permissions-model.md`.

### Cohort registration and Lyric integration

MVP uses pre-registration: cohorts exist in Usher before data is submitted. Three design items gate Lyric integration. See [cohort registration and Lyric integration](docs/atlas/roadmap/cohort-registration-lyric.md).

### Plugin integration design

API contract, request/response shapes, and error codes for token exchange, revocation poll, and push subscription. Also: JWE key distribution and payload schema versioning. See `.dev/design/plugin-integration.md`.

### Database schema design

Physical schema for the permissions model entities: column types, indexes, foreign key constraints, and migration strategy.

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

TypeScript confirmed; HTTP framework choice still open. See [technology stack decisions](docs/atlas/roadmap/technology-stack.md).

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
