# System Architecture

_Status: in progress. Component responsibilities and infrastructure roles are documented here.
Deployment topology, high-availability configuration, and container strategy are not yet designed;
see the roadmap._

A running Usher deployment consists of five software components and two infrastructure services.
Each section states what the component owns and what it explicitly does not, with ownership
attributed in each case.

See [concepts.md](../../docs/concepts.md) for the PDP/PAP/PEP/PIP roles referenced throughout.

---

## Components

### Keycloak

**Role:** Identity provider (IdP). Handles authentication and issues IdP tokens.

**Owns:**
- Authenticating users: password login, SSO, federated institutional login
- Issuing IdP tokens (JWS access tokens and ID tokens per OIDC)
- Maintaining the user directory, groups, and coarse-grained role assignments
- Validating GA4GH Passport Visas (optional; via Keycloak extension, for multi-institution
  federated deployments)
- Exposing public keys so downstream services can verify IdP token signatures

**Does not own:**
- Data access decisions (which records or fields a user may see) → **controller**
- Data categories, cohorts, or the grant model → **controller** (policy store)
- Grants token issuance → **controller**; grants token validation and decryption → **bridge**
- Any awareness of bridges or plugins: Keycloak is not aware they exist; the controller validates
  IdP tokens against Keycloak on the bridge's behalf

---

### Controller

**Role:** Authorization server. Implements the PDP (Policy Decision Point) and PAP (Policy
Administration Point). The controller is the central service; the bridge is the library that
connects client apps to it.

**Owns:**
- Validating incoming IdP bearer tokens against Keycloak's public keys (and any configured OIDC
  provider)
- Resolving user grants and memberships from the policy database
- Computing the grants payload: which categories the user holds grants for within each
  resource the requesting plugin manages
- Issuing JWE grants tokens: encrypted, short-lived, audience-scoped per application; see
  [security-workflow.md](security-workflow.md)
- Holding the JWE encryption key (the corresponding decryption key lives in the bridge)
- Writing `revoked_at` timestamps to the policy database on revocation
- Publishing revocation events to Valkey pub/sub so all controller instances notify their
  connected bridge subscribers (see [Multi-instance propagation](security-workflow.md#multi-instance-propagation))
- Hosting the management API (PAP: grant management, membership management, category management,
  revocation)
- Hosting the revocation poll endpoint (`GET /revocations?since=<timestamp>`) for bridge fallback
- Future: management UI (visual PAP interface)

**Does not own:**
- User authentication → **Keycloak**
- Querying the data layer or executing data queries → the **client app's** own data layer
- Translating the grants payload into application-native query formats → **plugin**
- Holding the JWE decryption key → **bridge** (provisioned at client app deploy time)

---

### Bridge (`usher-bridge`)

**Role:** Shared authorization library embedded in client apps. Connects the client app to the
controller: token exchange, grants caching, decryption, and revocation channel maintenance. Think of it as a drawbridge: when the connection to the controller is
healthy, the bridge is open and requests flow. When the controller is unreachable past the grace
period, the bridge raises and blocks all requests (fail-secure, 503) until connectivity is
restored.

**Owns:**
- Holding the JWE decryption key (provisioned at client app deploy time)
- Presenting the user's IdP bearer token to the controller's token exchange endpoint
- Receiving and locally caching the JWE grants token per user
- Decrypting grants tokens and exposing the decoded payload as a typed `GrantsPayload`
  object to the plugin — plugins never see the raw JWE or the decryption key
- Validating the grants token on every request within the TTL window (no network call to the
  controller in the common case)
- Maintaining the revocation channel: SSE or WebSocket push subscription with reconnection
  logic, and poll fallback on a 30-second interval
- Immediately dropping the cached token for a user when a revocation event is received
- Entering revocation-uncertain mode after the grace period (default: 60 seconds without a
  successful revocation check): suspending sessions and returning 503 until connectivity is
  restored

**Does not own:**
- Translating the grants payload into application-native query formats → **plugin**
- Access decisions (grant existence, category membership) → **controller**; the bridge only
  confirms the token is valid, current, and not revoked
- Any knowledge of the client app's data schema or query language → **plugin**

---

### App plugin

**Role:** Policy Enforcement Point (PEP). A thin adapter layer, built on `usher-bridge`, that
translates Usher's grants payload into the client app's native query format. Named per
integration target: `usher-arranger`, `usher-lyric`.

**Owns:**
- Intercepting incoming data requests before they reach the data layer
- Calling `usher-bridge` to get the current `GrantsPayload` for the requesting user
- Translating that payload into the application's query filter format:
  - `usher-arranger`: SQON filter object injected as a server-side filter in Arranger's GraphQL
    layer
  - `usher-lyric`: query conditions injected into Lyric's data access layer
- Returning 401 or 503 to the caller when `usher-bridge` signals an invalid or uncertain session

**Does not own:**
- Token exchange, grants caching, revocation channel management, or JWE decryption →
  **bridge**
- Access decisions and grant logic → **controller**
- Knowledge of how grants are defined or computed → **controller** (policy store)

---

### Client

**Role:** The data service that embeds `usher-bridge` and a plugin (Arranger, Lyric, or similar).
Not part of Usher itself; described here to complete the picture.

The client app is **stateless with respect to authorization**. It:
- Receives requests from end users carrying an IdP bearer token
- Delegates all auth decisions to `usher-bridge` and the plugin
- Has no awareness of the controller, grants tokens, revocation state, or the grant model

All authorization state lives in `usher-bridge` (per-user grants token cache, revocation
channel state) and the controller (policy database, revocation timestamps). The client app
carries no auth state itself. If it restarts, `usher-bridge` initializes fresh and obtains new
grants tokens on the first request from each user.

This is the intended design: **the controller and `usher-bridge` together own the auth state;
client apps enforce decisions derived from it, without managing that state themselves.**

---

## Infrastructure services

### PostgreSQL

**Role:** Authoritative policy store. The source of truth for all policy decisions.

**Stores:**
- Resources, data categories, and their relationships
- Memberships: which users hold which roles on which resources
- Category grants: which users hold which category grants, with expiry timestamps
- `revoked_at` timestamps per user (for emergency revocation)
- Audit log: authorization decisions, grant changes, and revocation events

**Does not handle:** real-time signaling or pub/sub between controller instances → **Valkey**.

---

### Valkey

**Role:** Shared in-process state and event bus across controller instances.

**Two distinct uses:**

1. **Shared grants-payload cache.** The `generatedAt` fast-path refresh (see
   [security-workflow.md](security-workflow.md#session-and-caching)) is most efficient when all
   controller instances share a consistent view of the last-modified timestamp per user. Valkey
   provides this shared cache, avoiding redundant full policy recomputes across instances.

2. **Revocation pub/sub backbone.** When a revocation is processed by one controller instance,
   it publishes an event to a Valkey pub/sub channel. All other instances subscribe to this
   channel and forward the event to their connected bridge subscribers via SSE or WebSocket. This
   is how revocation propagates across a horizontally scaled deployment without direct
   instance-to-instance coordination. See [Multi-instance propagation](security-workflow.md#multi-instance-propagation).

**Does not own:** authoritative policy state → **PostgreSQL**. Valkey accelerates reads and
distributes events; PostgreSQL is the source of truth.

---

## Responsibility at a glance

| Responsibility | Keycloak | Controller | Bridge | Plugin |
|---|---|---|---|---|
| Authenticate user | ✓ | | | |
| Issue IdP token | ✓ | | | |
| Validate IdP token | | ✓ | | |
| Resolve user grants | | ✓ | | |
| Issue grants token (JWE) | | ✓ | | |
| Hold JWE encryption key | | ✓ | | |
| Hold JWE decryption key | | | ✓ | |
| Cache grants token | | | ✓ | |
| Decrypt and expose `GrantsPayload` | | | ✓ | |
| Validate grants token locally | | | ✓ | |
| Subscribe to revocation channel | | | ✓ | |
| Publish revocation events (cross-instance, via Valkey) | | ✓ | | |
| Dismiss revoked session | | | ✓ | |
| Raise on controller loss (fail-secure) | | | ✓ | |
| Translate grants payload to query filters | | | | ✓ |
| Intercept and filter data requests | | | | ✓ |
| Manage policy (grants, memberships, categories) | | ✓ | | |
| Expose management API and future UI | | ✓ | | |
