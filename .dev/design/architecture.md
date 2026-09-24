# System Architecture

_Status: in progress. Component responsibilities and infrastructure roles are documented here.
Deployment topology, high-availability configuration, and container strategy are not yet designed;
see the roadmap._

A running Usher instance consists of five software components and two infrastructure services.
Each section states what the component owns and what it explicitly does not, with ownership
attributed in each case.

See [concepts.md](../../docs/concepts.md) for the PDP/PAP/PEP/PIP roles referenced throughout.

---

## System scope: Usher as resource lifecycle management layer

Usher's responsibility extends beyond access decisions to owning the full lifecycle of the
resources it protects. This scope is a deliberate expansion from the original "authorization
service" framing and replaces two components from the previous Overture stack:

### EGO (replaced)

EGO was Overture's previous combined identity and authorization service. It managed users, groups,
and access policies. Usher replaces EGO's authorization responsibilities entirely; Keycloak (the
IdP already deployed alongside EGO) handles the identity responsibilities.

EGO is deprovisioned once the migration is complete. See [admin-model.md](admin-model.md) for the
migration steps.

### Studies management service (retired)

The studies management service was a stateless orchestration layer specific to iMS. It mapped SONG
studies to EGO groups and policies, and exposed a simplified API for managing which users could
reach which study. All of its operations are absorbed by Usher:

| Studies management service operation | Usher equivalent                                     |
| ------------------------------------ | ---------------------------------------------------- |
| Create study group in EGO            | `POST /admin/resources`                              |
| Add user to study group              | `POST /admin/grants`                                 |
| Remove user from study group         | `DELETE /admin/grants/{id}`                          |
| List users in a study                | `GET /admin/resources/{id}/grants`                   |
| Create EGO policy for study          | Implicit: resource creation creates the access scope |

The service is retired once Usher's resource management API is live and migrated data is verified.

### SONG (narrowed role)

SONG remains in the instance but its role is narrowed to file-level manifest data: file
checksums, donor/sample links, and file object identifiers. SONG is no longer the source of truth
for resource metadata (cohort existence, category assignments, or grants). Usher owns that metadata.

Instances that do not include SONG are fully supported; Usher has no dependency on SONG.

---

## Which plane each component sits in

**Usher is the access control plane; the applications are the data plane.** All three of Usher's own
components sit in the control plane, the bridge and the adapter included, even though both run inside
an application's own process: they carry and apply a decision rather than serve data. Keycloak sits
there with them, governing identity rather than access, so the control plane is wider than Usher and
Usher is the part of it that access control runs in. The data plane is the application's own
query execution and the records it returns, which no Usher component reads or writes.

The components listed below are the whole instance rather than Usher alone. SONG and the ushered
service are among them and sit in the data plane, which is why the list and the plane split do not
line up one to one.

The adapter is the boundary between the two. It takes the control plane's decision and attaches it to
a query before the data plane runs, which is why enforcement happens inside the application while
the decision never does.

**Disambiguation note:** A plane is a functional division, and Usher's two are the control plane and
the data plane. A layer is a level of abstraction inside a component, so the data layer is the part
of an application that runs queries, and the data plane is that layer plus the records it returns.

## Components

### Keycloak

**Role:** Identity provider (IdP). Handles authentication and issues IdP tokens.

**Owns:**

- Authenticating users: password login, SSO, federated institutional login
- Issuing IdP tokens (JWS access tokens and ID tokens per OIDC)
- Maintaining the user directory, groups, and coarse-grained role assignments
- Validating GA4GH Passport Visas (optional; via Keycloak extension, for multi-institution
  federated instances)
- Exposing public keys so downstream services can verify IdP token signatures

**Does not own:**

- Data access decisions (which records or fields a user may see) → **controller**
- Categories, cohorts, or the grant model → **controller** (policy store)
- Usher token issuance → **controller**; Usher token validation and decryption → **bridge**
- Any awareness of bridges or adapters: Keycloak is not aware they exist; the controller validates
  IdP tokens against Keycloak on the bridge's behalf

---

### Controller

**Role:** The control plane's central service. It holds the resources, the categories each lists and
the grants over them, computes what each principal may reach, and distributes that to the
applications. Implements the PDP (Policy Decision Point) and
PAP (Policy Administration Point). The controller is the central service; the bridge is the library
that connects applications to it.

**Disambiguation note:** In this architecture, Keycloak fits better in what OAuth calls
"authorization server". That term names the component which authenticates a person and issues them an
access token, and Keycloak is what does both. The Usher Controller instead takes an
already-authenticated principal, decides what they may reach, and issues the resulting token to an
application. Two components, two jobs, and our modular design depends on keeping them apart.

**Owns:**

- Validating incoming IdP bearer tokens against Keycloak's public keys (and any configured OIDC
  provider)
- Resolving the grants that reach a user, from the policy database
- Computing the permissions payload: which categories the user holds grants for within each
  resource the requesting adapter manages
- Issuing JWE Usher tokens: encrypted, short-lived, audience-scoped per application; see
  [security-workflow.md](security-workflow.md)
- Holding one symmetric JWE key per ushered application, and encrypting every token to the one
  application it is issued for, so no bridge can read another application's tokens
- Writing `revoked_at` timestamps to the policy database on revocation
- Publishing revocation events to Valkey pub/sub so all controller instances notify their
  connected bridge subscribers (see [Multi-instance propagation](security-workflow.md#multi-instance-propagation))
- Hosting the management API (PAP: writing and revoking grants, category management,
  revocation)
- Hosting the revocation poll endpoint (`GET /revocations?since=<timestamp>`) for bridge fallback
- Future: management UI (visual PAP interface)

**Does not own:**

- User authentication → **Keycloak**
- Querying the data layer or executing data queries → the **application's** own data layer
- Translating the permissions payload into application-native query formats → **adapter**
- Holding an application's key alone: each application's **bridge** holds the same key, delivered to
  both by the secrets operator

---

### Bridge (`@overture-stack/usher-express-bridge`)

**Role:** Shared authorization library embedded in applications. Connects the application to the
controller: token exchange, Usher token caching, decryption, and revocation channel maintenance.
Think of it as a drawbridge: when the connection to the controller is healthy, the bridge is open
and requests flow. When the controller is unreachable past the grace period, the bridge raises and
blocks every request needing a granted permission (fail-secure, 503), while the open tier keeps
being served, until connectivity is restored.

**Owns:**

- Holding its own application's JWE key, which no other application's bridge holds
- Presenting the user's IdP bearer token to the controller's token exchange endpoint
- Receiving and locally caching the JWE Usher token per user
- Decrypting Usher tokens and exposing the decoded payload as a typed `PermissionsPayload`
  object to the adapter: adapters never see the raw JWE or any key
- Validating the Usher token on every request within the TTL window (no network call to the
  controller in the common case)
- Maintaining the revocation channel: SSE or WebSocket push subscription with reconnection
  logic, and poll fallback on a 30-second interval
- Immediately dropping the cached token for a user when a revocation event is received
- Entering revocation-uncertain mode after the grace period (default: 60 seconds without a
  successful revocation check): suspending sessions and returning 503 until connectivity is
  restored

**Does not own:**

- Compiling a filter into a backend query dialect (Elasticsearch DSL, SQL) → **adapter**
- Access decisions (grant existence, which categories the principal holds) → **controller**; the bridge only
  confirms the token is valid, current, and not revoked
- Any stored knowledge of the application's data schema: index or table layout, or what a category
  means in terms of records → **adapter**. A field name reaches the bridge as a per-query parameter
  supplied by the adapter, which is not the same as holding a schema: the bridge is told which field
  names the resource for the catalogue being queried and forgets it

**On query languages specifically.** The bridge may know SQON; what must stay out of it is the
backend. SQON is a shared Overture language
rather than one application's dialect: Arranger owns the module (`@overture-stack/sqon`), and Lyric
consumes SQON as well, so a SQON-shaped filter is portable across the read path and the
submission path without translation. What must stay out of the bridge is the _backend_, since
Arranger compiles SQON to Elasticsearch DSL and Lyric compiles it to SQL. Rendering a resolved grant
set into SQON is generic and lives in the bridge; compiling SQON into a backend query is
application-specific and belongs in the adapter. That split is decided rather than open, and the reason
is that every fail-open defect found so far has been in constructing a predicate and none in
compiling one.

---

### App adapter

**Role:** Policy Enforcement Point (PEP). A thin layer, built on the bridge, that
translates Usher's permissions payload into the application's native query format. Named per
integration target: the Arranger adapter first, published as `@overture-stack/arranger-usher-adapter`,
and the Lyric adapter after it.

**Owns:**

- Intercepting incoming data requests before they reach the data layer
- Calling the bridge to get the current `PermissionsPayload` for the requesting user
- Translating that payload into the application's query filter format:
  - The Arranger adapter: SQON filter object injected as a server-side filter in Arranger's GraphQL
    layer
  - The Lyric adapter: query conditions injected into Lyric's data access layer
- Returning 401 or 503 to the principal when the bridge signals an invalid or uncertain session

**Does not own:**

- Token exchange, grants caching, revocation channel management, or JWE decryption →
  **bridge**
- Access decisions and grant logic → **controller**
- Knowledge of how grants are defined or computed → **controller** (policy store)

---

### Ushered service

**Role:** The service that embeds the bridge and an adapter (Arranger, Lyric, or similar).
Not part of Usher itself; described here to complete the picture.

The application is **stateless with respect to authorization**. It:

- Receives requests from end users carrying an IdP bearer token
- Delegates all auth decisions to the bridge and the adapter
- Has no awareness of the controller, Usher tokens, revocation state, or the grant model

All authorization state lives in the bridge (per-user Usher token cache, revocation
channel state) and the controller (policy database, revocation timestamps). The application
carries no auth state itself. If it restarts, the bridge initializes fresh and obtains new
Usher tokens on the first request from each user.

This is the intended design: **the controller and the bridge together own the auth state;
applications enforce decisions derived from it, without managing that state themselves.**

---

## Infrastructure services

### PostgreSQL

**Role:** Authoritative policy store. The source of truth for all policy decisions.

**Stores:**

- Resources, categories, and their relationships
- Resource users: which users hold which roles on which resources
- Category grants: which users hold which category grants, with expiry timestamps
- `revoked_at` timestamps per user (for emergency revocation)
- Audit log: access decisions, grant changes, and revocation events

**Does not handle:** real-time signaling or pub/sub between controller instances → **Valkey**.

---

### Valkey

**Role:** Shared in-process state and event bus across controller instances.

**Two distinct uses:**

1. **Shared computed-payload cache.** The fast-path refresh (see
   [security-workflow.md](security-workflow.md#session-and-caching)) holds one entry per principal
   and audience, carrying the computed payload, the earliest grant expiry that bounds any reissue,
   and the category version each named resource stood at when the payload was computed. Valkey gives
   every controller instance the same view of it, so a refresh served by one instance does not
   recompute what another already has.

   **Invalidation is by deletion, and only for this half.** Anything changing what a principal holds
   deletes their entry, so absence means recompute and the entry cannot go subtly stale. A category
   change does not delete it; the versions stored beside the payload are what catch that, compared
   against the resources' current ones on refresh.

   **What this is not.** There is no last-modified timestamp per principal. That was the first
   design and it does not work, because the marker was per principal while the dangerous change is
   per resource, and it is recorded as rejected in
   [decisions.md](decisions.md). The open blocker that once sat here, over whether such a timestamp
   was authoritative in Valkey or cached from PostgreSQL, closed with it: there is no timestamp to
   place.

2. **Revocation pub/sub backbone.** When a revocation is processed by one controller instance,
   it publishes an event to a Valkey pub/sub channel. All other instances subscribe to this
   channel and forward the event to their connected bridge subscribers via SSE or WebSocket. This
   is how revocation propagates across a horizontally scaled instance without direct
   instance-to-instance coordination. See [Multi-instance propagation](security-workflow.md#multi-instance-propagation).

**Does not own:** authoritative policy state → **PostgreSQL**. Valkey accelerates reads and
distributes events; PostgreSQL is the source of truth.

---

## Responsibility at a glance

| Responsibility                                         | Keycloak | Controller | Bridge | Adapter |
| ------------------------------------------------------ | -------- | ---------- | ------ | ------- |
| Authenticate user                                      | ✓        |            |        |         |
| Issue IdP token                                        | ✓        |            |        |         |
| Validate IdP token                                     |          | ✓          |        |         |
| Resolve user grants                                    |          | ✓          |        |         |
| Issue Usher token (JWE)                                |          | ✓          |        |         |
| Hold every application's JWE key                       |          | ✓          |        |         |
| Hold its own application's JWE key                     |          |            | ✓      |         |
| Cache Usher token                                      |          |            | ✓      |         |
| Decrypt and expose `PermissionsPayload`                |          |            | ✓      |         |
| Validate Usher token locally                           |          |            | ✓      |         |
| Subscribe to revocation channel                        |          |            | ✓      |         |
| Publish revocation events (cross-instance, via Valkey) |          | ✓          |        |         |
| Dismiss revoked session                                |          |            | ✓      |         |
| Raise on controller loss (fail-secure)                 |          |            | ✓      |         |
| Translate permissions payload to query filters         |          |            |        | ✓       |
| Intercept and filter data requests                     |          |            |        | ✓       |
| Manage policy (grants, resource users, categories)     |          | ✓          |        |         |
| Expose management API and future UI                    |          | ✓          |        |         |
