# Usher Roadmap

Planned work across design, implementation, integration, and infrastructure. Items are open unless
marked `[in progress]`. Completed items are removed; `sessions.md` is the historical record.

---

## Design (pre-implementation)

These must be completed or sufficiently resolved before the relevant implementation phase begins.

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
  IdP (Keycloak). The deployment runbook must document who is authorised to perform IdP-level
  role assignment and what audit trail is expected from the IdP layer.

Lower priority (can follow v1):
- Self-grant step-up authentication (NIST SP 800-63B recommended; see compensating controls above)
- Audit event schema formalisation (minimum fields defined in admin-model.md; formal schema TBD)
- Multi-tenancy admin scope

### Complete permissions model

The structure (hybrid role + attribute, data categories, memberships, category grants) is defined.
Still needed:
- Role capability definitions: what specific actions does each role permit beyond resource access?
- Multiple roles per user per resource: supported or not?
- Field-level restriction implementation approach (options A-D analysed; recommendation: start with
  A, extend to C; formal choice not yet committed)
- Category grant scope: always resource-specific, or can a grant span multiple resources?
- Overlapping cohort access semantics: if a record belongs to cohorts A and B and the user is a
  member of A only, do they see it? (OR vs AND; see permissions-model.md Open questions)
- Multi-category intersection: does holding individual `controlled` and `indigenous` grants
  auto-grant access to records tagged with both? (OCAP-sensitive; consult data stewards before
  deciding; see permissions-model.md Open questions)
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

### Plugin integration design

API contract, request/response shapes, and error codes for:
- Constraint token exchange endpoint
- Revocation poll endpoint (`GET /revocations?since=<timestamp>`)
- Push event subscription (SSE or WebSocket)

Also needed: JWE decryption key distribution and rotation strategy; constraint payload schema
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

---

## Implementation: Core service

### Technology stack selection

Language (TypeScript strongly preferred for Overture ecosystem consistency), HTTP framework
(Fastify is a strong candidate for performance-sensitive auth path), and database (PostgreSQL is
the likely choice; confirm before implementation).

### IdP integration

OIDC token validation: discovery endpoint consumption, public key caching and rotation, strict
claim validation (`aud`, `iss`, `exp`, scope). Must handle IdP unavailability fail-secure:
if the IdP cannot validate a bearer token, reject the constraint token exchange request.

### Constraint computation engine

Given a validated user identity, resolve current permissions from the policy database and compute
the constraint payload. Must support the `generatedAt`-based fast-path refresh (skip full
computation if no policy change since `generatedAt`).

### JWE token issuance

Encrypt and sign the constraint payload using the selected JWE algorithms. Embed `generatedAt`
and `exp`. The decryption key must not have a default value; Usher must refuse to start if
unconfigured.

### Revocation system

- Per-user `revoked_at` timestamp in the policy database
- Push channel: SSE or WebSocket endpoint for plugin subscriptions; emit on revocation
- Poll endpoint: `GET /revocations?since=<timestamp>` returning changed user IDs
- Revocation scopes: single user, all users of a resource, global (with confirmation)

### Audit logging

Structured JSON log for every authorization decision (user, resource, categories in scope,
decision, timestamp) and every revocation event (actor, scope, timestamp). Must never include
constraint token payloads, health record identifiers, or bearer tokens. Retention policy to be
defined at deployment time.

### Policy database

Schema implementation and migration tooling based on the completed schema design. Integrity
controls: transactions, foreign key constraints, and audit triggers for policy changes.

---

## Implementation: Integration

### `@overture-stack/usher-client`

Shared library consumed by all per-app plugins:
- JWE token exchange with Usher
- Local token validation and constraint extraction (decryption)
- TTL-aware caching
- Revocation channel: push subscription with reconnection logic; poll fallback
- Revocation-uncertain mode: suspend sessions after grace period; return 503
- Configurable TTL, grace period, and poll interval

### `@overture-stack/usher-arranger`

Express middleware for `arranger-graphql-router`. Translates Usher constraint payload into
Arranger server-side SQON filters. First integration target.

### Additional per-app plugins

`@overture-stack/usher-lyric` and others as needed, each translating constraints into that app's
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
