# Admin Model

_Status: in progress. OIDC-first admin identification, admin role taxonomy, self-grant flow,
service account model, admin listing visibility, and audit integrity are now documented. Open
questions: self-grant step-up authentication, self-grant notification to resource owners,
"list all users" capability scope and PHI implications, break-glass emergency access procedure,
rogue admin scenario (compromised account's impact on peers)._

See [permissions-model.md](permissions-model.md) for the grant model that platform admins manage.
See [concepts.md](concepts.md) for PAP / PDP / PEP vocabulary.
See [security-threat-model.md](security-threat-model.md) for A09 (audit) and A01 (access control)
mapping.

---

## Overview

The permissions model in [permissions-model.md](permissions-model.md) introduced three privileged
roles: platform admin, category steward, and resource owner. This document specifies them fully.
It covers:

- The role taxonomy and what each role can and cannot do
- How Usher identifies and validates platform admin status (OIDC-first; no Usher-managed admin
  table)
- The bootstrap model (delegated to the identity provider)
- The self-grant flow: how a platform admin obtains data access when legitimately needed
- What metadata platform admins can see when listing resources
- Service accounts: how automated processes authenticate and what they are permitted to do
- Audit log integrity controls
- The OIDC adapter boundary: what Keycloak (or any OIDC provider) owns versus what Usher owns

**PAP admin and platform admin are synonymous.** "Platform admin" is the user-facing term used
in the management UI and in communications with operators. "PAP admin" is the internal
architecture shorthand (PAP = Policy Administration Point). Design documents may use either;
user-facing text should prefer "platform admin".

---

## Role taxonomy

| Role | Scope | Primary capability | Holds data access |
|---|---|---|---|
| Platform admin (= PAP admin) | Platform-wide | Manages all grants, all resources | No — must self-grant explicitly |
| Category steward | One or more data categories | Manages grants for their categories across all resources | No (unless separately granted as a user) |
| Resource owner | Their own resource | Manages grants within their resource | Yes — they are the submitter |
| Service account | Explicitly enumerated capabilities | Performs system operations only | No |

A user may hold more than one role independently. A resource owner can also be a category steward
for an unrelated category; those roles are independent and neither implies the other.

Platform admins and category stewards are privileged actors whose operations touch the policy
store. Neither role grants data access automatically: that requires a separate, explicit, logged
grant through the same permissions system that governs all users.

---

## Platform admin: capabilities and constraints

### Can

- Enumerate all resources (metadata only; see the Admin listing section below)
- Create, view, modify, and revoke memberships and category grants for any user on any resource
- View full audit log
- Register and manage service accounts in Usher (which capabilities a service account holds)
- Self-grant data access to a specific resource (see the Self-grant section below)

### Cannot

- Read, download, or query record data without an explicit self-grant
- Delete or modify audit log entries
- Bypass the constraint token path to access data; the separation of admin capability from data
  access is a hard design requirement, not a policy convention
- Create or revoke other platform admins; that is an identity provider operation, outside
  Usher's scope (see the Bootstrap section)

### How Usher determines platform admin status

Usher reads admin status from the validated OIDC token on every request to the admin API. No
database lookup is required; the token claim is authoritative.

The claim check is OIDC-provider-specific and configurable via the OIDC adapter:

- **Keycloak (default adapter):** `realm_access.roles` contains the configured platform admin
  role name (default: `usher-platform-admin`).
- **Generic OIDC adapter:** a configurable top-level claim (e.g., `usher_admin: true`), or a
  path in the token namespace, evaluated against a configured expected value.

Usher never caches or persists platform admin status between requests. The token is validated
and the claim is inspected on every admin API call. This is the fail-secure default: if the
IdP revokes the platform admin role, the next token issued will not carry the claim, and that
user's access to the admin API ends at the next token expiry. Keep token TTLs short (15 minutes
or less; see the Non-obvious constraints section).

**The adversarial framing:** if a platform admin account is compromised, the attacker gains
grant management power. But every action they take is logged, they do not gain silent unlogged
access to data, and their platform admin status disappears automatically when the IdP role is
revoked.

---

## Bootstrap: how the first platform admin is established

Usher has no bootstrap logic of its own. The identity provider handles this entirely.

**For Keycloak (the default):**

1. At Keycloak deployment time, a Keycloak realm administrator is created via Keycloak's own
   bootstrap mechanism (typically the `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` environment
   variables, set before first launch).
2. That Keycloak admin creates a realm for Usher and defines a realm role named
   `usher-platform-admin` (the exact name is configurable in the Usher adapter config).
3. The Keycloak admin assigns that role to the user who will be the first Usher platform admin.
4. When that user authenticates, their OIDC token carries the `usher-platform-admin` claim.
   Usher reads the claim, recognises platform admin status, and the management API and UI
   become available. No Usher-side initialisation is required.

Usher has no `BOOTSTRAP_ADMIN_EMAIL` configuration, no `platform_admins` table, and no startup
warning for missing admins. Adding or removing platform admins is a Keycloak operation. Usher
application code has no role in that lifecycle.

**For alternative OIDC providers:** the concept is identical. The provider-specific mechanism
for assigning the platform admin signal to a user (a role, a group, a custom claim) is
configured in the adapter. Usher reads the result from the token.

**Security note:** the Keycloak realm administrator account is a privileged credential that lies
outside Usher's audit trail. It should be treated as infrastructure-tier credentials: stored in
a secrets manager, scoped tightly, and its use logged by the deployment platform's own audit
mechanism. Operators should understand that Usher's audit log is the record of application-layer
policy changes, not the complete record of all privilege operations on the platform (see the
Non-obvious constraints section).

---

## Self-grant flow

When a platform admin needs to access data in a specific resource (for incident investigation,
data quality audit, or operational support), they must explicitly grant themselves access through
the same permissions system that governs all users. This is intentional: the grant is logged,
it is traceable, and the admin must make a deliberate choice.

### Mechanics

1. Platform admin navigates to the resource in the management UI (or calls the admin API).
2. They initiate a self-grant, specifying the resource, the data categories they need access to,
   and a TTL.
3. Usher creates a standard `membership` plus `category_grant` record with `granted_by === user_id`
   as the marker for a self-grant.
4. The audit log entry is explicitly flagged: `"self_grant": true`.
5. The grant behaves identically to any other grant for PEP plugin purposes. There is no special
   casing in the constraint token for self-grants; the plugin sees the same token structure it
   always does.

### TTL requirement

- Every self-grant must have an explicit TTL.
- The maximum TTL is configurable per deployment (recommended default: 24 hours).
- Self-grants cannot be set to never expire.
- When the TTL expires, the standard `revoked_at` revocation mechanism fires, the same as manual
  revocation and grant expiry elsewhere in the model.

### Open questions for self-grant

**Step-up authentication (pending):** should initiating a self-grant require MFA
re-authentication? NIST SP 800-63B recommends step-up for high-impact operations. Recommended:
yes, but not a requirement for v1 if TTL and audit controls are in place.

**Resource owner notification (pending):** when a platform admin self-grants access to a
resource, should the resource owner receive an out-of-band notification? This is a strong
compensating control; requires notification infrastructure design.

---

## Admin listing: resource metadata visibility

When a platform admin lists resources, they see:

### Visible

- Resource ID and display name
- Description
- Created by (user ID, not record contents) and creation timestamp
- Last modified timestamp
- Which data categories are assigned to the resource (`resource_categories`)
- Cohort membership: which other cohorts this resource belongs to, if any

### Not visible

- Any record contents
- Record counts (even a count of records tagged with a sensitive category is a data disclosure)
- The content of any category grant beyond its existence (admins can see that a grant exists
  for a user-category pair, not what fields that category restricts to)

### On category tag visibility

Category assignments (for example, "this resource has `indigenous_data` tagged") are visible to
platform admins. Rationale: categories are platform-level configuration, not user data. An admin
managing `indigenous_data` grants cannot do their job without knowing which resources have that
category. The sensitive information is the records themselves, not the structure of the access
control system.

This is a deliberate decision. It should be revisited if a specific deployment determines that
category assignments are themselves sensitive (for example, if knowing that a resource has a
particular category implies something about the population it describes).

**Operator guidance:** resource names and descriptions are visible to platform admins and are
set by deployment operators. Names that embed sensitive information (for example, "HIV Status
cohort" or "Indigenous Genetic Data") could constitute an information disclosure even without
record access. Operators should follow naming conventions that use identifiers or non-sensitive
labels. Usher cannot enforce this; it is a deployment policy decision.

---

## Admin API: no PEP plugin involvement

The admin API is not served through the PEP plugin path. It is a separate API surface:

```
GET  /admin/resources            — list all resources (metadata only)
GET  /admin/resources/{id}       — single resource metadata and grant summary
GET  /admin/users                — [pending: see PHI open question below]
GET  /admin/audit                — audit log query interface
POST /admin/grants               — create membership or category grant
DELETE /admin/grants/{id}        — revoke grant
```

This endpoint set is authenticated by Usher directly: the bearer token is validated, and the
OIDC platform admin claim is checked (see the Platform admin section above). PEP plugins never
need to know about platform admin status; they see a constraint token and apply it.

The constraint token issued to a platform admin is identical in structure to any other constraint
token. It does not contain a platform admin flag. If a platform admin has not self-granted access
to a resource, their constraint token reflects that: they see no records in Arranger, just like
any other non-member user.

This cleanly separates two concerns: admin operations go through the admin API; data queries go
through the PEP plugin path. The two paths have different authentication checks and different
response shapes.

**Open question: "list all users" capability (pending):** can platform admins enumerate all
registered users across the platform? In a health data context, knowing that a specific email
address is registered may itself be sensitive information. At minimum, user search should be
scoped to resources the admin is operating on (find users who hold grants on resource X) rather
than a global user directory dump. A deliberate decision is needed before this endpoint is
designed.

---

## Service accounts

Automated processes (Lyric at ingest, migration tooling, monitoring scripts) need to interact
with Usher without being platform admins. A service account is a narrowly-scoped, non-human
identity with an explicitly enumerated capability set.

### Authentication

Keycloak client credentials flow (OAuth 2.0 `client_credentials` grant, machine-to-machine, no
user login involved). The Keycloak client for the service has a realm role that identifies it as
a Usher service account (for example, `usher-service-account`). Usher reads this from the token
to distinguish service account requests from human user requests.

### Capability model

Keycloak provides authentication and the coarse-grained signal that the token belongs to a
service account. Usher maintains its own `service_accounts` table keyed on the `client_id` from
the token, recording which specific capabilities that service account holds. Platform admins
manage this table through the Usher management UI.

Fine-grained capabilities (`CREATE_RESOURCE`, `ASSOCIATE_CATEGORY`, `CREATE_MEMBERSHIP`, and
others) live in Usher's policy database, not in Keycloak's role or attribute system. This is
consistent with the principle applied to user grants throughout the model: the OIDC provider
handles identity, Usher handles fine-grained authorization.

### Properties

- Service accounts are distinct from platform admins and cannot self-grant data access.
- They cannot create, modify, or revoke category grants for users.
- They cannot read or modify audit log entries.
- All service account actions are logged with the `client_id` as the actor, distinguishable
  from human admin actions in the audit trail.

### Lyric use case

Lyric needs to create a resource record in Usher when a new submission is ingested. The minimum
capability set required:

- `CREATE_RESOURCE`: create a new resource record
- `ASSOCIATE_CATEGORY`: tag a resource with one or more data categories at creation time
- `CREATE_MEMBERSHIP` (optional): assign the submitter as the resource owner or curator

The Lyric service account holds exactly these capabilities and nothing else. It cannot read
grants, modify memberships for arbitrary users, or access any data.

**Resource ID protocol:** when Lyric creates a resource via the service account API, Usher
returns the resource ID. Lyric stores that ID and uses it for all subsequent Usher interactions
for that submission.

### Credential management

Service account credentials (the Keycloak client secret) are managed at the Keycloak client
layer. Rotation interval and secret length are a deployment concern, not a Usher design
decision. Short-lived client credentials tokens are preferred over long-lived API keys.

---

## Audit log integrity

If platform admins can modify or delete audit records, every other control in this document
collapses. The tamper scenario to guard against:

1. Rogue admin grants themselves access.
2. Accesses data.
3. Revokes their own grant.
4. Attempts to delete the audit records for steps 1 through 3.

The controls below address each step of the tamper chain.

### Database controls (required)

- The application database role has `INSERT` on the audit table and nothing else: no `UPDATE`,
  no `DELETE`.
- The audit table has no triggers that can modify or delete rows.
- The schema migration tooling must enforce this; the deployment health check should verify it
  on startup.

### Out-of-band log (required)

- All audit events are also emitted as structured JSON to stdout, in addition to the database
  write.
- The container orchestration platform (Kubernetes or equivalent) captures stdout and ships it
  to a log aggregation system that Usher application code cannot access or modify.
- This means even if the database audit table is tampered with, the out-of-band log is an
  independent record. Step 4 of the tamper chain fails at the application layer (no `DELETE`
  access), and the out-of-band log recorded steps 1 through 3 independently.

### High-assurance option (recommended, not required for v1)

- Write audit events to an append-only external store (object storage with object-lock, a WORM
  system, or a dedicated audit log service).
- Use cryptographic chaining (each entry hashes the previous) to enable after-the-fact tamper
  detection.

---

## OIDC adapter design

Usher reads all admin state from the validated OIDC token. The adapter interface must expose:

- **Token validation:** verify signature against the provider's JWKS, check expiry and issuer.
- **Claim extraction:** pull `sub` (user subject), `email`, and the platform admin indicator.
- **Admin claim configuration:** the claim path and value to check are configurable. Default for
  Keycloak: `realm_access.roles` contains `usher-platform-admin`. For a generic OIDC provider:
  a configurable top-level claim path and expected value.
- **Service account detection:** distinguish client credentials tokens from user tokens. For
  Keycloak: the presence of `azp` (authorized party) and the absence of a human-user `sub`
  subject indicate a service account token.

The adapter is the only component that knows it is talking to a specific provider. The rest of
Usher's code works with a validated, normalised claim set. The monorepo will contain a
`packages/oidc-keycloak` adapter and a `packages/oidc-generic` fallback.

**OPA note:** Open Policy Agent was considered as a policy evaluation engine. It is not a v1
dependency. Usher's ABAC model is structured (defined schema: memberships, category_grants,
resource_categories), and the constraint computation is a mechanical derivation from that data
rather than open-ended policy composition. OPA adds operational complexity without clear benefit
at this scale. Revisit if the policy model grows to require arbitrary composition or distributed
policy bundle updates to many enforcement points simultaneously.

---

## Open questions

**Self-grant step-up authentication (pending):** should initiating a self-grant require MFA
re-authentication? NIST SP 800-63B recommends step-up for high-impact operations. Recommended:
yes; defer to v1+ if TTL and audit controls are accepted as sufficient for initial deployments.

**Self-grant notification (pending):** when a platform admin self-grants access to a resource,
should the resource owner receive an out-of-band notification? Strong compensating control;
requires notification infrastructure to be designed first.

**"List all users" capability (pending):** can platform admins enumerate all registered users
across the platform? Knowing that a specific email address is registered may itself be sensitive
in a health data context. User search should at minimum be scoped to resources the admin is
operating on. A deliberate decision is needed before this endpoint is designed.

**Break-glass emergency access (pending):** if all platform admins are unavailable (accounts
locked, staff unavailable), the recovery path requires assigning the platform admin role in the
identity provider. This is an IdP administration operation, not a Usher operation. The
deployment runbook should document who is authorised to perform this operation and what audit
trail is expected. Usher's design document should note the dependency explicitly.

**Rogue admin scenario (pending):** if a platform admin account is compromised, the attacker
can manage grants but cannot revoke another user's platform admin status (that is an IdP
operation). Can the compromised account revoke the personal resource access grants of a peer
platform admin? This needs a deliberate policy decision for the management API design.

**Multi-tenancy admin scope (out of v1):** in a multi-tenant deployment, it is unclear whether
a platform admin is scoped to a tenant or is truly platform-wide. Not designed; do not
implement.

---

## Non-obvious constraints (deployment considerations)

**Infrastructure access bypasses Usher:** a person with shell access to the deployment host or
Kubernetes cluster can access the database directly and bypass all of Usher's access controls.
Usher's admin model governs application-layer access only. Network isolation, cluster RBAC, and
database access controls are a separate layer. Document this boundary in the deployment
architecture document.

**Keycloak admin operations are outside Usher's audit scope:** actions taken by Keycloak realm
administrators (assigning or revoking the platform admin role, disabling user accounts) are
logged by Keycloak's own audit system, not by Usher's audit log. The boundary must be
explicitly documented so that security auditors understand that Usher's audit log is not a
complete record of all privilege changes on the platform.

**Token TTL bounds the deprovisioning lag:** when a platform admin's role is revoked in the
identity provider, any token they already hold remains valid until expiry. Deployments should
configure short token TTLs (15 minutes or less) to bound the exposure window. This is a
deployment configuration concern, not a Usher code concern. Usher's fail-secure default means
it always reads the claim from the current token; it never trusts a cached admin status.

**Category naming is an operator responsibility:** category assignments are visible to platform
admins (deliberate decision). Category names that embed sensitive information (naming a category
after a specific community or condition) could constitute an information disclosure even without
record access. Operators must follow naming conventions. Usher cannot enforce this.
