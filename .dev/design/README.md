# Usher: Design Index

Usher is a standalone authorization service for the Overture platform. It answers "what is this
user allowed to see?" and returns structured constraints that each Overture application enforces.
It is not an authentication service; that job belongs to the identity provider (Keycloak, Azure
Entra, etc.).

**New to the terminology?** Start with [glossary.md](glossary.md): one or two sentences per term,
grouped by theme. [concepts.md](concepts.md) covers the same vocabulary in more depth with
rationale and context.

## Reading order

These documents are interconnected. The recommended path depends on what you are trying to
understand.

**New to Usher:** [glossary.md](glossary.md) (quick term lookup), then
[concepts.md](concepts.md) (vocabulary and security primitives with rationale), then
[security-workflow.md](security-workflow.md) (how the token system works end to end), then
[permissions-model.md](permissions-model.md) (the data model and access rules).

**Reviewing the security design:** [security-threat-model.md](security-threat-model.md) (OWASP
mapping and gap analysis), then [security-workflow.md](security-workflow.md) for mechanism detail.
[concepts.md](concepts.md) is the vocabulary reference for both.

**Reviewing the permissions model:** [concepts.md](concepts.md) (especially "The permissions model
entities"), then [permissions-model.md](permissions-model.md).

**Planning a PEP plugin:** [glossary.md](glossary.md) (especially the Integration concepts and
System architecture roles sections), then [security-workflow.md](security-workflow.md) (what the
plugin must do and when), then [permissions-model.md](permissions-model.md) (what the constraint
payload contains), then [plugin-integration.md](plugin-integration.md) (the API contract, not yet
designed).

## Document coverage

| Document | Topic | Status |
|---|---|---|
| [glossary.md](glossary.md) | Quick-reference term definitions: system roles, tokens, policy entities, admin roles, integration concepts | reference |
| [concepts.md](concepts.md) | ABAC vocabulary, security primitives, permissions model entities | reference |
| [security-threat-model.md](security-threat-model.md) | OWASP Top 10:2025 mapping; addressed vs. open gaps | reference |
| [security-workflow.md](security-workflow.md) | Token issuance, constraint lifecycle, revocation, fail-secure | specced |
| [permissions-model.md](permissions-model.md) | Hybrid role + attribute model, data categories, cohort semantics, OCAP, private data sharing | in progress |
| [admin-model.md](admin-model.md) | Role taxonomy, OIDC-first admin identification, bootstrap, self-grant flow, service accounts, audit integrity | in progress |
| [plugin-integration.md](plugin-integration.md) | Per-app plugin design, shared client library | not started |
| [management-ui.md](management-ui.md) | Access management UI (PAP layer) | not started |

**Security standard:** OWASP Top 10:2025. Usher may handle personal health information; the
threat model and design are calibrated accordingly. See
[security-threat-model.md](security-threat-model.md) for the full analysis, including gaps.

## What is and is not specced

**Specced:** The security workflow is the most fully designed part of Usher. The mechanism for
issuing constraint tokens, how plugins validate them locally, how permission changes propagate
within a bounded window, how emergency revocation works, and how the system behaves when the
revocation channel is unavailable are all documented in [security-workflow.md](security-workflow.md)
with explicit rationale for each design decision.

**In progress:** The permissions model now covers the core structure (hybrid role + attribute model,
data category grants), grant composition semantics, the cohort overlap model, OCAP compliance
considerations, the iMS private data sharing use cases, and GA4GH Passport integration. Not yet
designed: role capability definitions, the field-level restriction implementation choice, user
groups detail, data stewardship scoping, and write permissions for Lyric. See
[permissions-model.md](permissions-model.md).

**Not yet started:** How app plugins are built and configured, how decryption keys are distributed
to plugins at deploy time, the API contract (specific endpoints, request/response shapes, error
codes), the SQL schema in detail, deployment architecture, multi-tenancy, rate limiting on the
Usher API itself, and the management UI design are all open. Stubs with known requirements and
open questions are in [plugin-integration.md](plugin-integration.md) and
[management-ui.md](management-ui.md).

## Decisions needed before implementation

These questions are explicitly flagged as unresolved in the design documents. They require a
deliberate answer before the relevant implementation work can begin; most have OCAP, legal, or
cross-application implications and should not be resolved by a single developer in isolation.

| Question | Documented in | Blocks |
|---|---|---|
| Overlapping cohort access semantics: if a record belongs to cohorts A and B and a user is a member of A only, do they see it? (OR vs AND) | [permissions-model.md](permissions-model.md) | Core constraint resolution |
| Multi-category intersection: does holding `controlled` and `indigenous` grants separately auto-grant access to records tagged with both? | [permissions-model.md](permissions-model.md) | OCAP compliance posture; data model |
| Data stewardship scoping: how is a `category_steward` capability stored and enforced? | [permissions-model.md](permissions-model.md) | Management UI design; OCAP deployments |
| User groups design: Keycloak sync or PAP-only? Grant composition across overlapping groups? Revocation when a user leaves a group? | [permissions-model.md](permissions-model.md) | Core data model; management UI |
| JWE algorithm selection: AES-256-GCM for content; RSA-OAEP or ECDH-ES for key wrap? | [security-threat-model.md](security-threat-model.md) | Token issuance implementation |
| Role capability definitions: what actions does each role permit beyond resource access? | [permissions-model.md](permissions-model.md) | Constraint resolution; management UI |
| Self-grant peer revocability: can any platform admin revoke a peer's self-grant, or only the creator? | [admin-model.md](admin-model.md) | Admin API grant management endpoints |
| Self-grant compensating controls: step-up auth and owner notification cannot both be deferred to v1+ | [admin-model.md](admin-model.md) | Self-grant UX; notification infrastructure |
| "List all users" capability: scoped-to-resource direction agreed; global directory requires deliberate PHI decision | [admin-model.md](admin-model.md) | Admin API design |
| Break-glass emergency access: deployment runbook procedure when all platform admins are unavailable | [admin-model.md](admin-model.md) | Deployment runbook |

## Why we are building Usher rather than adopting an existing tool

Three established tools were reviewed before deciding to build:

**Cerbos:** standalone PDP service, REST API, YAML policies. Closest match architecturally.
Gaps: no management UI, decisions are allow/deny only (no structured constraint output), would
need significant wrapping for SQON/field-masking use cases. Good reference for API design.

**OPA (Open Policy Agent):** industry standard, very powerful, policy-as-code in Rego. Gaps:
steep learning curve, no management UI, still requires building the access management layer. Better
suited to infrastructure policy than app-level data access control.

**Cerbos Hub:** commercial SaaS management UI on top of Cerbos. Not self-hosted, not open-source.

The combination of structured constraint output, a custom management UI, IdP abstraction, and
per-app plugin integration makes the scope specific enough that these tools would be adapters
rather than foundations.
