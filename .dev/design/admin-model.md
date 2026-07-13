# Admin Model

_Status: in progress. OIDC-first admin identification, role taxonomy, bootstrap, self-grant
flow, admin listing visibility, service accounts, and audit integrity are documented. Open
design questions: self-grant step-up authentication, self-grant owner notification, "list all
users" scope and PHI implications, break-glass emergency access, rogue admin peer-grant impact,
and structured audit event schema._

See [permissions-model.md](permissions-model.md) for the grant model that admins manage.
See [concepts.md](../../docs/concepts.md) for PAP / PDP / PEP vocabulary.
See [security-threat-model.md](security-threat-model.md) for A09 (audit) and A01 (access control)
mapping.

---

## Overview

The permissions model introduced three privileged roles: Admin, Steward, and Owner. This document specifies them fully. It covers:

- Role taxonomy and what each role can and cannot do
- How Usher identifies and validates admin status (OIDC-first; no Usher-managed admin
  table)
- The bootstrap model (delegated to the identity provider)
- The self-grant flow: how an admin obtains data access when legitimately needed
- What metadata admins can see when listing resources
- Service accounts: how automated processes authenticate and what they are permitted to do
- Audit log integrity controls
- The OIDC adapter boundary: what Keycloak (or any OIDC provider) owns versus what Usher owns

**Admin** is the term used throughout for the platform-wide authorization administrator role. The architecture shorthand **PAP admin** (Policy Administration Point) refers to the same role and may appear in technical contexts.

---

## Role taxonomy

| Role | Scope | Primary capability | Holds data access |
|---|---|---|---|
| Admin | Platform-wide | Manages all grants, all resources | No; must self-grant explicitly |
| Steward | One or more data categories | Manages grants for their categories across all resources | No (unless separately granted as a user) |
| Owner | Their designated resource(s) | Manages grants within their resource; sets visibility policy | Yes; holds member access |
| Submitter | Their submitted resource | Data provenance; member access to own data | Yes; member access only |
| Service account | Explicitly enumerated capabilities | Performs system operations only | No |

**Submitter vs. owner:** submission establishes data provenance and gives the submitter
member access to their own resource. It does not automatically confer management rights.
Ownership is an optional, per-resource designation: some submitters are also owners;
others are not. An Owner need not be the submitter. See permissions-model.md "Submitters and
owners" for the full model and the open question on assignment timing.

A user may hold more than one role independently. An Owner can also be a steward
for an unrelated category; those roles are independent and neither implies the other.

Admins and stewards are privileged actors whose operations touch the policy
store. Neither role grants data access automatically: that requires a separate, explicit, logged
grant through the same permissions system that governs all users.

---

## Admin: capabilities and constraints

### Can

- Enumerate all resources (metadata only; see the Admin listing section)
- Create, view, modify, and revoke memberships and category grants for any user on any resource
- View full audit log
- Register and manage service accounts in Usher (which capabilities a service account holds)
- Self-grant data access to a specific resource (see the Self-grant section)

### Cannot

- Read, download, or query record data without an explicit self-grant
- Delete or modify audit log entries
- Bypass the grants token path to access data; the separation of admin capability from data
  access is a hard design requirement, not a policy convention
- Create or revoke other admins; that is an identity provider operation, outside
  Usher's scope (see the Bootstrap section)

### How Usher determines admin status

Usher reads admin status from the validated OIDC token on every request to the admin API. No
database lookup is required; the token claim is authoritative.

The claim check is OIDC-provider-specific and configurable via the OIDC adapter:

- **Keycloak (default adapter):** `realm_access.roles` contains the configured admin
  role name (default: `usher-platform-admin`).
- **Generic OIDC adapter:** a configurable top-level claim (e.g. `usher_admin: true`), or a
  path in the token namespace, evaluated against a configured expected value.

Usher never caches or persists admin status between requests. The token is validated
and the claim is inspected on every admin API call. This is the fail-secure default: if the IdP
revokes the admin role, the next token issued will not carry the claim, and that user's
access to the admin API ends at the next token expiry. Keep token TTLs short (15 minutes or
less; see the Non-obvious constraints section).

**Adversarial framing:** if an admin account is compromised, the attacker gains grant
management power. But every action they take is logged, they do not gain silent unlogged data
access, and their admin status disappears automatically when the IdP role is revoked.

---

## Bootstrap: how the first admin is established

Usher has no bootstrap logic of its own. The identity provider handles this entirely.

**For Keycloak (the default):**

1. At Keycloak deployment time, a Keycloak realm administrator is created via Keycloak's own
   bootstrap mechanism (typically the `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` environment
   variables, set before first launch). In Overture's deployment, a Terraform Keycloak operator
   currently under evaluation automates realm configuration at deploy time, reducing the need
   for manual Keycloak UI work.
2. That Keycloak admin creates a realm for Usher and defines a realm role named
   `usher-platform-admin` (the exact name is configurable in the Usher adapter config).
3. The Keycloak admin assigns that role to the user who will be the first Usher admin.
4. When that user authenticates, their OIDC token carries the `usher-platform-admin` claim.
   Usher reads the claim, recognises admin status, and the management API and UI become
   available. No Usher-side initialisation is required.

Usher has no `BOOTSTRAP_ADMIN_EMAIL` configuration, no `platform_admins` table, and no startup
warning for missing admins. Adding or removing admins is a Keycloak (or IdP) operation.
Usher application code has no role in that lifecycle.

**For alternative OIDC providers:** the concept is identical. The provider-specific mechanism
for assigning the admin signal to a user (a role, a group, a custom claim) is
configured in the adapter. Usher reads the result from the token.

**Security note:** the Keycloak realm administrator credential is infrastructure-tier: store it
in a secrets manager, scope it tightly, and log its use at the deployment platform level.
Usher's audit log records application-layer policy changes; Keycloak's own audit logs record
IdP-level admin operations. Both are needed for a complete audit trail (see the Non-obvious
constraints section).

---

## Self-grant flow

When an admin needs data access (incident investigation, data quality audit, operational
support), they must explicitly grant themselves access through the same permissions system that
governs all users. The grant is logged, traceable, and requires a deliberate action.

### Mechanics

1. Admin navigates to the resource in the management UI (or calls the admin API self-
   grant endpoint).
2. They specify the resource, the data categories needed, and a TTL.
3. Usher creates a standard `membership` plus `category_grant` record. The `granted_by` field
   is set to the admin's own `user_id`, flagging this as a self-grant. The audit log entry
   carries `"self_grant": true`.
4. The self-grant endpoint enforces the TTL requirement and the audit flag. The standard grant
   endpoint rejects self-targeting by admins with an error directing them to the
   self-grant endpoint. This is technical enforcement, not convention.
5. The resulting grant behaves identically to any other grant for PEP plugin purposes. The
   grants token carries no admin flag; the plugin sees the same token structure
   regardless of whether the grantee is an admin.

### TTL requirement

- Every self-grant must have an explicit TTL.
- Maximum TTL is configurable per deployment (recommended default: 24 hours).
- Self-grants cannot be set to never expire.
- When the TTL expires, the standard `revoked_at` revocation mechanism fires.

### Self-grant revocability

Self-grants are standard grants in the policy database. Any admin can revoke any grant,
including another admin's self-grant. This means a compromised admin account could
revoke a legitimate admin's active self-grant (e.g. an ongoing incident investigation). The
audit trail records the revocation and identifies the actor.

A policy option that restricts self-grant revocation to the creator only is possible but not
decided. See the open questions section; this must be resolved before the admin API is
implemented.

### Compensating controls and their dependency

Two controls mitigate the risk of unchecked self-grant: step-up authentication (MFA re-prompt
at point of self-grant) and resource owner notification (out-of-band alert to the owner when an
admin self-grants access to their resource).

These are not independent. If step-up authentication is deferred to a later version, owner
notification is required for v1 as the primary compensating control. Both cannot be deferred
simultaneously. This dependency must be resolved as a v1 design decision.

---

## Admin listing: resource metadata visibility

When an admin lists resources, they see:

### Visible

- Resource ID and display name
- Description
- Created-by user ID (not record contents) and creation timestamp
- Last modified timestamp
- Which data categories are assigned to the resource (`resource_categories`)
- Cohort membership: which cohorts this resource belongs to, if any

### Not visible

- Any record contents
- Record counts (a count of records tagged with a sensitive category is a data disclosure)
- The content of any category grant beyond its existence (admins can see that a grant exists
  for a user-category pair; not what fields that category restricts to)

### On category tag visibility

Category assignments (for example, "this resource has `indigenous_data` tagged") are visible to
admins. Rationale: categories are platform-level configuration, not user data. An admin
managing `indigenous_data` grants cannot do their job without knowing which resources carry that
category. The sensitive information is the records themselves, not the access control structure.

This is a deliberate decision. It should be revisited if a specific deployment determines that
category assignments are themselves sensitive (for example, if knowing that a resource has a
particular category implies something about the population it describes).

**Operator guidance:** resource names and descriptions are visible to admins and are
set by deployment operators. Names that embed sensitive information could constitute an
information disclosure even without record access. Operators must follow naming conventions that
use identifiers or non-sensitive labels. Usher cannot enforce this; it is a deployment policy
decision.

---

## Admin API

The admin API is not served through the PEP plugin path. It is a separate surface, authenticated
by Usher directly: the bearer token is validated and the OIDC admin claim is checked on
every request.

```
GET    /admin/resources              list all resources (metadata only)
GET    /admin/resources/{id}         single resource metadata and grant summary
GET    /admin/resources/{id}/members users who hold grants on this resource
GET    /admin/audit                  audit log query interface
POST   /admin/grants                 create membership or category grant
DELETE /admin/grants/{id}            revoke grant
POST   /admin/grants/self            self-grant endpoint (enforces TTL; sets self_grant flag)
POST   /admin/service-accounts       register a service account
PUT    /admin/service-accounts/{id}  update service account capabilities
```

**Grants token for admins:** identical in structure to any other grants token.
It carries no admin flag. If an admin has not self-granted access to a
resource, their grants token reflects that: they see no records in data applications, just
like any other non-member user.

This cleanly separates two concerns: admin operations go through the admin API; data queries go
through the PEP plugin path. The two paths have different authentication checks and different
response shapes.

**User enumeration:** a global `GET /admin/users` endpoint is not implemented. In a health data
context, knowing that a specific email address is registered may itself be sensitive. User
lookup is scoped to resources: `GET /admin/resources/{id}/members` returns users who hold grants
on a specific resource. A global directory is explicitly deferred and requires a deliberate
decision on PHI implications before design begins.

---

## Service accounts

Automated processes (Lyric at ingest, migration tooling, monitoring scripts) need to interact
with Usher without being admins. A service account is a narrowly-scoped, non-human
identity with an explicitly enumerated capability set.

### Authentication

Keycloak client credentials flow (OAuth 2.0 `client_credentials` grant, machine-to-machine, no
user login involved). The Keycloak client for the service has a realm role identifying it as a
Usher service account (for example, `usher-service-account`). Usher reads this from the token
to distinguish service account requests from human user requests.

### Capability model

Keycloak provides authentication and the coarse-grained signal that the token belongs to a
service account. Usher maintains its own `service_accounts` table keyed on the `client_id` from
the token, recording which specific capabilities that service account holds. Admins
manage this table through the Usher management UI.

Fine-grained capabilities (`CREATE_RESOURCE`, `ASSOCIATE_CATEGORY`, `CREATE_MEMBERSHIP`, and
others) live in Usher's policy database, not in Keycloak's role or attribute system. This is
consistent with the principle applied to user grants throughout the model: the OIDC provider
handles identity, Usher handles fine-grained authorization.

### Properties

- Service accounts are distinct from admins and cannot self-grant data access.
- They cannot create, modify, or revoke category grants for users directly.
  **Note:** `CREATE_MEMBERSHIP` with an `owner` role is an indirect path to category grant
  management: an Owner can grant and revoke category access for other users within their resource.
  A compromised service account holding `CREATE_MEMBERSHIP` could assign a malicious actor as
  Owner of any newly created resource. Scope this capability carefully; consider whether
  service accounts should be restricted to creating `member`-level memberships only.
- They cannot read or modify audit log entries.
- All service account actions are logged with the `client_id` as the actor, distinguishable
  from human admin actions in the audit trail.
- Admins can revoke all capabilities for a service account by removing or disabling
  its entry in the `service_accounts` table. The next service account request will fail the
  capability check.

### Lyric use case

Lyric needs to create a resource record in Usher when a new submission is ingested. Minimum
capability set:

- `CREATE_RESOURCE`: create a new resource record
- `ASSOCIATE_CATEGORY`: tag a resource with one or more data categories at creation time
- `CREATE_MEMBERSHIP` (optional): assign the submitter as Owner or Member

The Lyric service account holds exactly these capabilities and nothing else. It cannot read
grants, modify memberships for arbitrary users, or access any data.

**Resource ID protocol:** when Lyric creates a resource via the service account API, Usher
returns the resource ID. Lyric stores that ID and uses it for all subsequent Usher interactions
for that submission.

### Credential management

Service account credentials (the Keycloak client secret) are managed at the Keycloak client
layer. Rotation interval and secret length are a deployment concern. Short-lived client
credential tokens are preferred over long-lived API keys.

---

## Audit log integrity

If admins can modify or delete audit records, every other control in this document
collapses. The tamper chain to guard against:

1. Rogue admin grants themselves access.
2. Accesses data.
3. Revokes their own grant.
4. Attempts to delete the audit records for steps 1-3.

The controls below address each step.

### Required database controls

- The application database role has `INSERT` on the audit table and nothing else: no `UPDATE`,
  no `DELETE`.
- The audit table has no triggers that can modify or delete rows.
- The schema migration tooling must enforce this; the deployment health check should verify it
  on startup.

### Required out-of-band log

- All audit events are emitted as structured JSON to stdout, in addition to the database write.
- The container orchestration platform captures stdout and ships it to a log aggregation system
  that Usher application code cannot access or modify.
- Step 4 of the tamper chain fails at the application layer (no `DELETE` access). The out-of-
  band log recorded steps 1-3 independently. Both records are needed: the database for query
  and correlation; the out-of-band log as the tamper-evident source of truth.

### Recommended (not required for v1)

- Write audit events to an append-only external store (object storage with object-lock, a WORM
  system, or a dedicated audit log service).
- Use cryptographic chaining (each entry hashes the previous) to enable after-the-fact tamper
  detection.

### Structured audit event schema

Every audit event emitted to stdout must include at minimum:

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO 8601 | UTC |
| `event_type` | string | e.g. `GRANT_CREATED`, `GRANT_REVOKED`, `SELF_GRANT_CREATED`, `RESOURCE_LISTED` |
| `actor_id` | string | `user_id` for humans; `client_id` for service accounts |
| `actor_type` | `human` or `service_account` | |
| `resource_id` | string or null | null for platform-wide events |
| `target_user_id` | string or null | the user affected, if applicable |
| `action` | string | verb + object, e.g. `create_category_grant` |
| `outcome` | `success` or `failure` | |
| `self_grant` | boolean | true only for self-grant events |
| `categories` | string[] or null | data categories affected, if applicable |

Events must never include grants token payloads, health record identifiers, bearer tokens,
or any field value that is itself controlled-access data.

---

## OIDC adapter design

Usher reads all admin state from the validated OIDC token. The adapter interface must expose:

- **Token validation:** verify signature against the provider's JWKS, check expiry and issuer.
- **Claim extraction:** pull `sub` (user subject), `email`, and the admin indicator.
- **Admin claim configuration:** the claim path and value to check are configurable. Default for
  Keycloak: `realm_access.roles` contains `usher-platform-admin`. For a generic OIDC provider:
  a configurable top-level claim path and expected value.
- **Service account detection:** distinguish client credentials tokens from user tokens. For
  Keycloak: the presence of `azp` (authorized party) and the absence of a human-user `sub`
  indicate a service account token.

The adapter is the only component that knows it is talking to a specific provider. The rest of
Usher's code works with a validated, normalized claim set. The monorepo will contain a
`packages/oidc-keycloak` adapter and a `packages/oidc-generic` fallback.

**OPA note:** Open Policy Agent was considered as a policy evaluation engine. It is not a v1
dependency. Usher's ABAC model is structured (defined schema: memberships, category_grants,
resource_categories), and grants computation is a mechanical derivation from that data
rather than open-ended policy composition. OPA adds operational complexity without clear benefit
at this scale. Revisit if the policy model grows to require arbitrary composition or distributed
policy bundle updates across many enforcement points simultaneously.

---

## Open questions

The following require deliberate decisions before the relevant implementation work begins.

**Self-grant step-up authentication:** should initiating a self-grant require MFA
re-authentication? NIST SP 800-63B recommends step-up for high-impact operations. Recommended:
yes. Defer to v1+ only if owner notification (below) is implemented in v1 as the compensating
control.

**Self-grant owner notification:** when an admin self-grants access to a resource,
should the resource owner receive an out-of-band notification? This is the primary compensating
control when step-up auth is deferred. Requires notification infrastructure design. If step-up
is deferred to v1+, this is required for v1. Both cannot be deferred simultaneously.

**Self-grant peer revocability (decision needed before admin API ships):** self-grants are
standard grants; any admin can revoke any grant, including a peer's self-grant. A
compromised account could revoke a legitimate admin's active self-grant. Policy options: (a)
any admin can revoke any grant including self-grants (simplest; current default); (b)
self-grants are revocable only by their creator or by a super-admin tier (requires additional
model complexity). A decision is needed before the admin API grant management endpoints are
implemented.

**"List all users" capability:** a global user directory endpoint is not implemented (see Admin
API section). If a specific use case arises that requires listing users beyond resource-scoped
member lookup, it must be evaluated for PHI implications before design begins.

**Break-glass emergency access:** if all admins are unavailable (accounts locked, staff
unavailable), recovery requires assigning the admin role in the identity provider.
This is an IdP administration operation. The deployment runbook must document who is authorized
to perform this operation and what audit trail is expected at the IdP layer.

**Multi-tenancy admin scope (out of v1):** in a multi-tenant deployment, it is unclear whether
an admin is scoped to a tenant or is truly platform-wide. Not designed; do not
implement.

---

## Non-obvious constraints

**Infrastructure access bypasses Usher:** a person with shell access to the deployment host or
Kubernetes cluster can access the database directly and bypass all of Usher's access controls.
Usher's admin model governs application-layer access only. Network isolation, cluster RBAC, and
database access controls are a separate layer. Document this boundary in the deployment
architecture document.

**Keycloak admin operations are outside Usher's audit scope:** actions taken by Keycloak realm
administrators (assigning or revoking the admin role, disabling user accounts) are
logged by Keycloak's own audit system, not by Usher's audit log. The boundary must be explicitly
documented so that security auditors understand that Usher's audit log is not a complete record
of all privilege changes on the platform. Both logs are required for a complete audit trail.

**Token TTL bounds the deprovisioning lag:** when an admin's role is revoked in the
identity provider, any token they already hold remains valid until expiry. Deployments must
configure short token TTLs (15 minutes or less) to bound this exposure window. Usher's fail-
secure default means it always reads the claim from the current token; it never trusts a cached
admin status.

**Category naming is an operator responsibility:** category assignments are visible to platform
admins (deliberate decision; see Admin listing section). Category names that embed sensitive
information could constitute an information disclosure even without record access. Operators must
follow naming conventions. Usher cannot enforce this.
