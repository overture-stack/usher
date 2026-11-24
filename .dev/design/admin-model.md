# Admin Model

_Status: in progress. OIDC-first admin identification, role taxonomy, bootstrap, self-grant
flow, admin listing visibility, service accounts, and audit integrity are documented. Open
design questions: self-grant step-up authentication, self-grant owner notification, "list all
users" scope and PHI implications, break-glass emergency access, rogue admin peer-grant impact,
and the Custodian permission list. The audit event schema is no longer among them: it is specced
in [audit-events.md](audit-events.md)._

See [permissions-model.md](permissions-model.md) for the grant model managed by admins.
See [concepts.md](../../docs/concepts.md) for PAP / PDP / PEP vocabulary.
See [security-threat-model.md](security-threat-model.md) for A09 (audit) and A01 (access control)
mapping.

---

## Overview

The permissions model introduced three privileged roles: Owner, Custodian and Admin. This document
specifies Admin and Owner; **Custodian is the least specified of the three and is a named gap**,
carrying one row in the taxonomy below and no permission list, though it has the most governance
weight and delegated community governance rests on it. The document covers:

- Role taxonomy and what each role can and cannot do
- How Usher identifies and validates admin status (OIDC-first; no Usher-managed admin
  table)
- The bootstrap model (delegated to the identity provider)
- The self-grant flow: how an admin obtains data access when legitimately needed
- What metadata admins can see when listing resources
- Service accounts: how automated processes authenticate and what they are permitted to do
- Audit log integrity controls
- The OIDC connector boundary: what Keycloak (or any OIDC provider) owns versus what Usher owns

**Admin** is the term used throughout for the platform-wide authorization administrator role. The architecture shorthand **PAP admin** (Policy Administration Point) refers to the same role and may appear in technical contexts.

---

## Role taxonomy

Ordered by widening scope rather than by seniority, matching
[permissions-model.md](permissions-model.md): a reader meets the narrowest first, and central control
is not where this model starts.

| Role            | Scope                             | Primary permission                                                                   | Holds data access                        |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| Submitter       | Their submitted resource          | Data provenance                                                                      | Open scope decision; see below           |
| Owner           | Their designated resource(s)      | Manages grants within their resource; sets its base tier; suppresses and restores it | None from ownership                      |
| Custodian       | One or more categories            | Manages grants for their categories across all resources                             | No (unless separately granted as a user) |
| Admin           | Platform-wide, the policy store   | Manages roles, resources and system configuration                                    | None standing; may self-grant explicitly |
| Service account | Explicitly enumerated permissions | Performs system operations only                                                      | No                                       |

**Submitter vs. owner:** submission establishes data provenance. It does not automatically give
management rights, and **whether it gives read access to the submitted data is an open scope
decision**, not a settled property: see the write-versus-read blocker in
[../docs/phase-1.md](../docs/phase-1.md), whose recommendation is that submission and read be
governed independently. **Rejected: read access as a property of submission**, which would settle by
assertion the write-versus-read blocker's own question.
Ownership is an optional, per-resource designation: some submitters are also owners;
others are not. An Owner need not be the submitter. See permissions-model.md "Submitters and
owners" for the full model and the open question on assignment timing.

A user may hold more than one role independently. An Owner can also be a custodian
for an unrelated category; those roles are independent and neither implies the other.

Admins and custodians are privileged actors whose operations change who may reach what
store. Neither role grants data access automatically: that requires a separate, explicit, logged
grant through the same permissions system that governs all users.

---

## EGO replacement scope

Usher is a full replacement for EGO, not an integration partner. The replacement path for
EGO-based instances (primarily iMS):

1. **Resource import.** Enumerate EGO groups named by a study's identifier and a prefix the
   deployment configures, for example `STUDY-<id>`; a study may have several, one per service that
   reads them. Create one Usher resource per study, mapping the study identifier to the resource's
   name and metadata.
2. **Membership import.** Map EGO group members to Usher `grants` rows. EGO user UUIDs resolve
   to Keycloak user IDs (both systems use Keycloak-issued UUIDs for the same user population).
   A membership naming the administrator running the import is refused and never written, as
   the standard grant endpoint refuses self-targeting; that administrator reaches the resource
   through the self-grant flow below.
3. **Policy import.** EGO policies (each named like its group, such as `STUDY-<id>`, with
   `WRITE` permission for the corresponding group) map to Usher category grants. The category in
   Usher is instance-specific; the studies management service's implicit "access to this study"
   becomes an explicit category grant (for example, `registered` or `controlled_access` depending
   on instance policy).
4. **Service retirement.** The studies management service (the orchestration layer over EGO) is
   retired. Its operations (creating a study group, adding a member, removing a member) become
   Usher admin API calls.
5. **Host application change.** What must change is any code that either calls EGO's
   authorization endpoints or builds request context from EGO-derived claims. Two categories:

    - **Services calling EGO endpoints directly.** Portals and gateway APIs that validate EGO
      tokens or resolve EGO group memberships before serving requests. These are updated to use
      Usher's Bridge and token exchange. For services that verify tokens by public key (RS256),
      **key rotation is a required step of the replacement, distinct from code changes**: Keycloak uses its
      own signing key pair, so the configured public key at each dependent service must be updated
      to the Keycloak signing key before the first Keycloak-issued token is accepted. A service
      still configured with EGO's public key will reject all Keycloak-issued tokens at the signature
      verification step, regardless of any other replacement work.
    - **Authorization callbacks reading EGO-populated context.** Search instances may currently
      express authorization by reading EGO claims that a host application placed into request
      context. That callback code lives in the host application's own repo, not in the data
      service's repo, and would not appear in any audit of the ushered service itself. Identify and
      change these in the same pass.

    Ushered services that perform no authentication themselves
    (for example, a search-server instance relying entirely on host-supplied context) are not
    in scope for that replacement as shipped: there is no EGO call to repoint. What requires change
    is the host code that constructs that context.

This replacement must be planned and coordinated before any EGO infrastructure is deprovisioned.

---

## Admin: permissions and constraints

### Can

- Add, view, modify, and remove users on any resource, and their category grants
- Create and manage resources (name, description, category assignments)
- Enumerate all resources (metadata only; see the Admin listing section)
- View full audit log
- Register and manage service accounts in Usher (which permissions a service account holds)
- Self-grant data access to a specific resource (see the Self-grant section)
- Query data applications without a filter, but only where an instance has enabled the adapter-level
  bypass, which is off by default for health-data instances. This is the one route that is not a
  grant, and the section below states what it costs
- Nominate other admins, and remove them, but never the last one (see the Further admins section)

### Cannot

- Read, download, or query record data without either an explicit self-grant or an enabled adapter
  bypass. Absent both, an admin reaches no records
- Delete or modify audit log entries
- Bypass the Usher token path to access data; the separation of admin permission from data
  access is a hard design requirement, not a policy convention

### How Usher determines admin status

Usher keeps its own list of admins and reads admin status from it on every request to the
Management API. The identity provider's role confers nothing once the first admin has accepted, so
every act that makes an admin is Usher's own and recorded in its audit log, whoever administers the
identity provider. Usher never caches admin status between requests, so a change to the list holds
from the next request.

Admin status is read inside each change's own transaction as well, so a change by a removed admin
never commits. A change that alters who is an admin holds the admins lock exclusively, and every other
change by an admin holds it shared, so the two never interleave.

**Adversarial framing:** if an admin account is compromised, the attacker gains grant
management power. But every action they take is logged, and they do not gain silent unlogged data
access.

---

## Bootstrap: how the first admin is established

The seed file names a first user, by a realm role or by the person's subject at the identity
provider, and the first user nominates the first admin. Usher has no admin until one accepts:

1. A Keycloak administrator gives Kim the first-user role the seed file names, `usher-first-user` by
   default. Where the seed file names Kim's subject instead, nothing is configured in Keycloak.
2. Kim signs in. Usher records Kim as a base user, so the audit log can name who nominated the first
   admin.
3. Kim nominates the first admin: themself, or a user who has signed in at least once.
4. The nominee accepts, and Usher records its first admin.
5. From then on the first-user role confers nothing, whoever holds it. Kim is a base user unless
   Kim was the nominee.

**Until an admin has accepted, every Management API operation answers `403`**, except the first
user nominating and the nominee accepting. The health routes and the token exchange answer as
usual: nothing is registered yet, so a token reaches nothing.

**Each step is recorded:** the nomination, and its acceptance, which makes the first admin and is
recorded at `critical`.

**Built after the first release, each as a forward migration:** recovery when no admin can sign in,
an admin owning a resource they registered, and adding grants from a list of email addresses.
Recovery is a command in the Controller's image, run once the
way the schema migration command is, so it needs no particular pipeline, and its procedure in
docs/deployment.md § Break-glass access serves any platform.

**For alternative OIDC providers:** the provider's mechanism for marking the first user (a role, a
group, a custom claim) is configured in the connector, and confers nothing once an admin exists.

**Security note:** the Keycloak realm administrator credential is infrastructure-tier: store it
in a secrets manager, scope it tightly, and log its use at the instance platform level.
Usher's audit log records application-layer policy changes, the making of admins among them;
Keycloak's own audit logs record IdP-level admin operations. Both are needed for a complete audit
trail (see the Non-obvious constraints section).

---

## Further admins

An admin nominates another the way the first admin was nominated: by subject, through the same nomination
route, and the nominee accepts or declines. Accepting makes the nominee an admin. These rules hold once an
admin exists:

- Any admin may nominate, and any admin may revoke a nomination still pending, whoever made it.
- A nominee who is already an admin is refused, and so is a nominee whom a pending nomination already names.
  The pending nomination must be withdrawn first.
- Every admin is kept. Removing an admin writes a removal row of their own and never deletes the admin's
  row, so the nomination that made them stays on record.
- An admin removes another admin, or themself, and the last admin is never removed.
- A removal revokes each nomination the removed admin made that is still pending.
- A person removed may be nominated and accepted again, and then holds a new admin row of their own.

---

## Self-grant flow

When an admin needs data access (incident investigation, data quality audit, operational
support), they must explicitly grant themselves access through the same permissions system that
governs all users. The grant is logged, traceable, and requires a deliberate action.

### Mechanics

1. Admin navigates to the resource in the management UI (or calls the admin API self-
   grant endpoint).
2. They specify the resource, the categories needed, and a TTL.
3. Usher creates a standard `grants` record. The `granted_by` field
   is set to the admin's own `user_id`, flagging this as a self-grant. The audit log entry
   carries `"self_grant": true`.
4. The self-grant endpoint enforces the TTL requirement and the audit flag. The standard grant
   endpoint rejects self-targeting with an error directing the principal to the self-grant endpoint.
   This is technical enforcement, not convention, and it applies to anyone holding `grant.create`
   rather than to administrators alone: an owner writing themselves a grant on their own resource
   takes the same path and the same TTL. There is no `grant.createSelf` capability, because the
   authority to grant is one authority; what differs is the endpoint's rules. See the capability
   vocabulary in [permissions-model.md](permissions-model.md).
5. **No approval in the first release.** From a later release a self-grant needs the approval of the
   resource's owner or of a custodian of one of the data's categories; see
   [decisions.md](decisions.md) § Admin self-grant is approved by the data's owner or custodian.
6. The resulting grant behaves identically to any other grant for PEP adapter purposes. The
   Usher token carries no admin flag; the adapter sees the same token structure
   regardless of whether the grantee is an admin.

### TTL requirement

- Every self-grant must have an explicit TTL.
- Maximum TTL is configurable per instance (recommended default: 24 hours).
- Self-grants cannot be set to never expire.
- When the TTL passes, the self-grant is simply absent from the next token, and the token's `exp`
  was set to end at that moment, so no cached token outlives it. No `revoked_at` is written. See
  [decisions.md](decisions.md) § A grant's expiry is resolved before the token is written.

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
- Which categories are assigned to the resource (`resource_categories`)
- That a grant exists on each, and who holds it

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

This is a deliberate decision. It should be revisited if a specific instance determines that
category assignments are themselves sensitive (for example, if knowing that a resource has a
particular category implies something about the population it describes).

**Operator guidance:** resource names and descriptions are visible to admins and are
set by instance operators. Names that embed sensitive information could constitute an
information disclosure even without record access. Operators must follow naming conventions that
use identifiers or non-sensitive labels. Usher cannot enforce this; it is an instance policy
decision.

---

## Adapter-level bypass for platform admins

An admin who needs to view data across all resources without a self-grant (for example, a portal
admin responding to a governance inquiry) can be accommodated at the
adapter layer rather than through an Usher token entry. The PEP adapter learns that the principal
is on Usher's list of admins, never from a role in the IdP token, and applies no SQON filter for
that request. How an adapter learns it is designed with the bypass, which is not built.

This is distinct from the self-grant flow:

| Mechanism      | How access is obtained                         | Appears in Usher token | Appears in audit log             |
| -------------- | ---------------------------------------------- | ---------------------- | -------------------------------- |
| Self-grant     | Admin creates an explicit grant for themselves | Yes (standard entry)   | Yes (`grant.selfCreation` event) |
| Adapter bypass | Adapter detects admin role; skips SQON filter  | No                     | Yes (adapter access log entry)   |

The adapter bypass does not create any grant record in Usher's policy database; it is an adapter
implementation decision. Adapters must log every bypass event as an access log entry (user ID,
timestamp, resource scope, reason: `platform_admin_bypass`). This keeps the access visible in
the cross-system audit trail even though no Usher grant event fires.

**Configuration option.** The adapter bypass can be disabled per instance. Instances that require
all data access to be grant-based (including admin access) should disable the bypass and require
admins to use the self-grant flow. This is the more restrictive posture and should be the default
for PHI instances.

---

## Admin API

The admin API is not served through the PEP adapter path. It is a separate API, authenticated
by Usher directly: the bearer token is validated and the OIDC admin claim is checked on
every request.

```
# Resource lifecycle management
GET    /admin/resources              list all resources (metadata only)
GET    /admin/resources/{id}         single resource metadata and grant summary
POST   /admin/resources              create a resource
PATCH  /admin/resources/{id}         update resource metadata (name, description)
GET    /admin/resources/{id}/grants  every grant on this resource: holder, category, role, expiry

# Grant management
GET    /admin/audit                  audit log query interface
POST   /admin/grants                 create a grant (resource, category, holder, role, expiry)
DELETE /admin/grants/{grantId}            revoke grant
POST   /admin/grants/self            self-grant endpoint (enforces TTL; sets self_grant flag)
POST   /admin/grants/{grantId}/decisions  the recipient's own answer, appended (accept or decline)

# Service accounts
POST   /admin/service-accounts       register a service account
PUT    /admin/service-accounts/{id}  update service account permissions
```

**Grant acceptance.** `POST /admin/grants/{grantId}/decisions` is called by the recipient, never by an
admin, and appends a row to `grant_decisions` carrying their answer and the capabilities they were
shown. It fires an Usher token refresh for that user. The endpoint validates that the principal
asking is the grant's recipient. Nothing about the grant itself changes: a later answer is another
row, and the current one is the latest. When auto-accept is enabled at the instance level, an
accepting row is written at creation without the recipient acting.

**Usher token for admins:** identical in structure to any other Usher token.
It carries no admin flag. If an admin has not self-granted access to a
resource, their Usher token reflects that: they see no records in data applications, just
like any other non-viewer user.

This cleanly separates two concerns: admin operations go through the admin API; data queries go
through the PEP adapter path. The two paths have different authentication checks and different
response shapes.

**User enumeration:** a global `GET /admin/users` endpoint is not implemented. In a health data
context, knowing that a specific email address is registered may itself be sensitive. User
lookup is scoped to resources: `GET /admin/resources/{id}/grants` returns the grants on a specific
resource, and so the people who hold them. A global directory is explicitly deferred and requires a deliberate
decision on PHI implications before design begins.

---

## Service accounts

Automated processes (Lyric at ingest, import tooling, monitoring scripts) need to interact
with Usher without being admins. A service account is a narrowly-scoped, non-human
identity with an explicitly enumerated permission set.

### Authentication

A service account signs in through the identity provider's client credentials grant (OAuth 2.0
`client_credentials`: machine to machine, with no user signing in). In Keycloak, a Keycloak client,
the provider's record of an application, with that grant enabled is given a service-account user,
and every token issued to it names that user's subject in `sub`. Usher knows a service account by
that issuer and subject, as it knows a user by theirs.

### Registration and permissions

An administrator registers a service account by its Keycloak client. Usher looks up the client's
service-account user once, through the identity provider's user lookup (the connector's lookup
through the provider's admin API, in the capability table below), and stores that user's subject,
with the client's id as its display name. It refuses the registration unless the lookup reports
the user as a service account. The lookup reads with a credential limited to viewing users and
clients, so the connector can change nothing in the identity provider.

**Where no lookup can say, the registration is recorded as unconfirmed.** The administrator gives
the subject, read from a token issued to the client, and Usher records the registration as
unconfirmed at `warning`, so a subject entered in error, a user's in place of a client's, shows in
the audit trail rather than passing silently. Closing this gap is on the
[roadmap](../roadmap.md).

**A service account's permissions are held against its registered subject, like any principal's,
and nothing else in a token decides them:** not `azp`, which a user's token carries too, naming the
application the user signed in through, and not `client_id` or a realm role.

**A recreated client starts with nothing.** Recreating the client in the identity provider gives
it a new service-account user, so the new client holds no permission until it is registered again,
and never inherits a deleted client's.

**At the exchange, a service account holds the baseline and its own grants.** The signed-in rule
confers on users alone. Each Keycloak client using the client credentials grant must issue tokens
carrying at least one of the signs under Service account detection below.

Fine-grained permissions (`resource.register` and `category.associate` are examples, and the
vocabulary is in [permissions-model.md](permissions-model.md#the-capability-vocabulary)) live in
Usher's policy database, not in Keycloak's role or attribute system. This is consistent with the
principle applied to user grants throughout the model: the OIDC provider handles identity, Usher
handles fine-grained authorization.

### Properties

- Service accounts are distinct from admins and cannot self-grant data access.
- They cannot create, modify, or revoke category grants for users directly.
  **Note:** writing a grant that names `owner` is an indirect path to grant management, because an
  owner can grant and revoke access to other people within their resource. A compromised service
  account holding `grant.create` could make a malicious actor the owner of any newly created
  resource. Scope this permission carefully: the containable form is a service account that may
  write only data-plane grants, never a control-plane one, which is a restriction on the plane
  rather than on a level.
- They cannot read or modify audit log entries.
- All service account actions are logged with the service account's subject as the actor, its
  `actorType` `serviceAccount`, distinguishable from human admin actions in the audit trail.
- Admins can revoke all permissions for a service account by removing or disabling its
  registration. Its next request fails the permission check, and the removal sends a principal's
  revocation on the notice stream, so every Bridge drops the Usher tokens it holds for the account
  before they expire.

### Lyric use case

Lyric needs to create a resource record in Usher when a new submission is ingested. Minimum
permission set:

- `resource.register`: register a new resource
- `category.associate`: tag a resource with one or more categories at creation time
- `grant.create` (optional): write the submitter their grant on the new resource, at the instance's
  submitter role

The Lyric service account holds exactly these permissions and nothing else. It cannot read
grants, write grants for arbitrary users, or access any data.

**Resource ID protocol:** when Lyric creates a resource via the service account API, Usher
returns the resource ID. Lyric stores that ID and uses it for all subsequent Usher interactions
for that submission.

### Credential management

Service account credentials (the Keycloak client secret) are managed at the Keycloak client
layer. Rotation interval and secret length are an instance concern. Short-lived client
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
- The schema migration tooling must enforce this; the instance health check should verify it
  on startup.

### Required out-of-band log

- All audit events are emitted as structured JSON to stdout, in addition to the database write.
- The container orchestration platform captures stdout and ships it to a log aggregation system
  inaccessible to Usher application code.
- Step 4 of the tamper chain fails at the application layer (no `DELETE` access). The out-of-
  band log recorded steps 1-3 independently. Both records are needed: the database for query
  and correlation; the out-of-band log as the tamper-evident source of truth.

### Recommended (not required for v1)

- Write audit events to an append-only external store (object storage with object-lock, a WORM
  system, or a dedicated audit log service).
- Use cryptographic chaining (each entry hashes the previous) to enable after-the-fact tamper
  detection.

### Structured audit event schema

The envelope, the event vocabulary, the required fields per event and the severity levels are in
[audit-events.md](audit-events.md). Events follow CloudEvents, so the context attributes are its
own: `time` rather than a `timestamp` field, `type` rather than an `event_type`, and event names of
the form `[namespace.]entity.action`.

Two properties live there rather than here. `actorType` distinguishes a human from a service
account. The self-grant case is its own event type, `grant.selfCreation`, rather than a boolean on an
ordinary creation. Making it a type is what lets alerting route on it without parsing the payload,
which is why CloudEvents puts routable facts in the envelope.

---

## OIDC connector design

Usher reads identity from the validated OIDC token, and admin status from its own list. The connector
interface must expose:

- **Token validation:** verify signature against the provider's JWKS, check expiry and issuer.
- **Claim extraction:** pull `sub` (user subject), `email`, and the first-user indicator.
- **First-user claim configuration:** the claim path and value marking the first user are
  configurable. Default for Keycloak: `realm_access.roles` contains `usher-first-user`. For a
  generic OIDC provider: a configurable top-level claim path and expected value. The claim matters
  only until the first admin accepts.
- **Service account detection, for refusal only:** where an operation is for users alone, a token
  carrying any sign of a service account is refused. In Keycloak, the signs are a `client_id` claim,
  a `preferred_username` starting `service-account-`, or the realm role the instance configures as
  `USHER_SERVICE_ACCOUNT_ROLE`. Any one sign suffices, so a misread token is refused rather than
  admitted. Detection never grants anything: a service
  account's permissions follow its registered subject alone.

The connector is the only component that knows it is talking to a specific provider. The rest of
Usher's code works with a validated, normalized claim set. The monorepo will contain a
`modules/oidc-keycloak` connector and a `modules/oidc-generic` fallback.

### What the connector reuses from the identity provider

Keycloak is the first provider. Each feature below is reached only through the connector, and each
has an answer for a provider that lacks it that never widens access, so supporting another provider
can cost features and never confidentiality.

| Feature                           | Standard or provider-specific                                  | What Usher uses it for                                                     | Where a provider lacks it                                                  |
| --------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| discovery and signing keys (JWKS) | OpenID Connect                                                 | validating the provider's tokens                                           | required of every provider                                                 |
| back-channel logout               | OpenID Connect Back-Channel Logout                             | the application drops a signed-out person's Usher token                    | the token lives until it expires                                           |
| token introspection               | RFC 7662                                                       | confirming at each exchange that the provider's session is still active    | expiry and back-channel logout carry it alone                              |
| authentication strength (`acr`)   | OpenID Connect claim; Keycloak maps it to levels               | requiring a stronger sign-in for sensitive categories or for a self-grant  | whatever needed it is refused                                              |
| a disabled account                | every provider; read through a failed renewal or introspection | an identity-level cut-off: exchanges fail, so no new Usher token is issued | Usher's own suspension, which is needed regardless                         |
| client credentials                | OAuth 2.0                                                      | service accounts as principals                                             | required of every provider that serves machine principals                  |
| terms acceptance at sign-in       | Keycloak required action                                       | the Registered tier's accepted terms of access                             | Usher or the portal records acceptance itself                              |
| admin events                      | Keycloak, through an extension or by polling                   | learning of a disabled, deleted or regrouped account without asking        | introspection at exchange catches a disabled account; groups stay in Usher |
| organizations                     | Keycloak, supported since version 26                           | institution membership feeding Usher groups                                | groups are managed in Usher                                                |
| user lookup through the admin API | Keycloak                                                       | display names at the portal layer, and finding a person to grant access to | the provider's own directory interface                                     |

**OPA note:** Open Policy Agent was considered as a policy evaluation engine. It is not a v1
dependency. Usher's RABAC model is structured (defined schema: `grants`, `grant_decisions`,
resource_categories), and permissions computation is a mechanical derivation from that data
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

**"List all users" permission:** a global user directory endpoint is not implemented (see Admin
API section). If a specific use case arises that requires listing users beyond resource-scoped
user lookup, it must be evaluated for PHI implications before design begins.

**Break-glass emergency access:** if all admins are unavailable (accounts locked, staff
unavailable), recovery requires assigning the admin role in the identity provider.
This is an IdP administration operation. The instance runbook must document who is authorized
to perform this operation and what audit trail is expected at the IdP layer.

**Multi-tenancy admin scope (out of v1):** in a multi-tenant instance, it is unclear whether
an admin is scoped to a tenant or is truly platform-wide. Not designed; do not
implement.

---

## Non-obvious constraints

**Infrastructure access bypasses Usher:** a person with shell access to the instance host or
Kubernetes cluster can access the database directly and bypass all of Usher's access controls.
Usher's admin model governs application-layer access only. Network isolation, cluster RBAC, and
database access controls are a separate layer. Document this boundary in the instance
architecture document.

**Keycloak admin operations are outside Usher's audit scope:** actions taken by Keycloak realm
administrators (assigning the first-user role, disabling user accounts) are
logged by Keycloak's own audit system, not by Usher's audit log. The boundary must be explicitly
documented so that security auditors understand that Usher's audit log is not a complete record
of all privilege changes on the platform. Both logs are required for a complete audit trail.

**Whoever manages a realm's users can name a first user, and that confers nothing once an admin
exists:** in Keycloak, holding `manage-users` for a realm is enough to assign any role in that realm
that is not one of Keycloak's own admin roles, and `usher-first-user` is not one. Until the first
admin accepts, a realm's administrators are trusted at that level, since a first user they name
nominates that admin (accepted 2026-10-13, narrowed 2026-11-15 to the time before the first admin).
A role meant only for user support must get its rights through Keycloak's fine-grained admin
permissions rather than `manage-users`, so that it cannot assign roles.

**Token TTL bounds the deprovisioning lag:** when an admin's account is disabled in the identity
provider, any token they already hold remains valid until expiry. Instances must configure short
IdP token lifetimes (15 minutes or less) to bound this exposure window. Usher's fail-secure
default means it always reads the claim from the current token; it never trusts a cached admin
status.

**Category naming is an operator responsibility:** category assignments are visible to platform
admins (deliberate decision; see Admin listing section). Category names that embed sensitive
information could constitute an information disclosure even without record access. Operators must
follow naming conventions. Usher cannot enforce this.
