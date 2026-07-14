# Security Workflow

_Status: specced. This is the most fully designed part of Usher. Rationale is documented for each
decision._

See [concepts.md](../../docs/concepts.md) for definitions of JWE, PDP, PEP, fail-secure, and other terms
used here. See [security-threat-model.md](security-threat-model.md) for the full OWASP Top
10:2025 mapping.

**Primary OWASP categories addressed here:**
- **A01 — Broken Access Control:** server-side enforcement, short-lived tokens, emergency
  revocation, fail-secure on revocation channel disruption.
- **A04 — Cryptographic Failures:** JWE (encrypted, not just signed), TLS on all channels,
  no sensitive claims in logs.
- **A07 — Authentication Failures:** strict IdP token validation (`aud`, `iss`, `exp`, scope),
  delegation to established IdP infrastructure.
- **A10 — Exceptional Conditions:** fail-secure failure mode; 503 (unavailable) on uncertain
  revocation state, not 200 or 401.

---

## Overview

```
User --IdP JWT--> App (with usher-bridge + plugin / PEP)
                        |
                        | Bridge exchanges IdP JWT for grants token (once per TTL window)
                        |
                        v
                 +-------------+
                 |  Controller |
                 |    (PDP)    |
                 +------+------+
                        |
             +----------+----------+
             |                     |
      Validate token          Look up policy
      with IdP (PIP)          in Usher DB
      Keycloak / Azure        (resources, roles, permissions)
             |                     |
             +----------+----------+
                        |
                 Compute grants
                        |
                        v
              Encrypted grants token (JWE)
              [ payload, readable only by the bridge (via the decryption key): ]
              {
                "sub": "user-id",           // null for anonymous access
                "iss": "https://usher.example.org",
                "aud": "arranger-prod",
                "iat": 1718611200,
                "exp": 1718611500,
                "generatedAt": 1718611200,
                "grants": {
                  "COHORT_A": { "role": "member", "categories": ["indigenous"] },
                  "COHORT_B": { "role": "owner",  "categories": [] }
                }
              }
                        |
                        v
             Bridge caches token; validates locally on
             every request within the TTL window.
             Plugin translates grants payload into app-native format:
               - Arranger: SQON filter object
               - Lyric: database WHERE clause
               - Stage: API query parameters
```

---

## Grants token format: JWE

Usher issues grants tokens as **JWE (JSON Web Encryption)**: encrypted JWTs, not merely
signed ones. See [concepts.md, JWS vs JWE](../../docs/concepts.md#jws-json-web-signature-signed-jwt)
for the distinction.

### Design rationale

**Why encrypted (not just signed):** A user who can read their own grants token knows exactly
which filters are applied to their queries. In sensitive data contexts, even knowing the shape of
the restriction may be information they should not have. JWE prevents a token holder from reading
the grants it encodes.

**Why self-contained (not opaque):** An opaque token requires a network call to Usher to resolve
its contents. Self-contained tokens are validated and decoded locally by the bridge using the
decryption key. This removes Usher from the hot path of every request, which is the mechanism that
caused per-request auth service crashes in prior deployments.

**Why JWE over a custom encrypted format:** JWE is defined in RFC 7516 and supported by all major
JWT libraries. No custom token infrastructure is needed, and any security engineer can audit the
implementation against a published standard.

**The decryption key** is a shared secret provisioned to each bridge instance at deploy time. It
is not the user's key; users never have it. The key distribution mechanism (how the bridge
receives and rotates this key securely) is a deployment concern not yet designed; see
[plugin-integration.md](plugin-integration.md).

---

## Session and caching

### Problem

Calling Usher on every individual request (per database write in Lyric, per GraphQL resolver
call in Arranger) creates an availability bottleneck. A prior deployment of a third-party
authorization service in this role crashed under normal transactional load due to the per-request
call pattern.

### Goal

Permission changes take effect within a bounded, predictable window, without requiring users to
log out and back in, and without waiting for IdP JWT expiry (which can be hours or days).

### Mechanism

1. On first request (or on grants token expiry), the bridge sends the user's IdP JWT to the
   controller.
2. The controller validates the IdP JWT with the configured provider, resolves the user's current
   permissions, and returns a JWE grants token with a short TTL (default: 5 minutes,
   configurable per deployment).
3. The bridge caches the grants token. All requests within the TTL window are validated and
   processed locally, with no controller network call.
4. On TTL expiry, the bridge sends both the expired token and the current IdP JWT to the
   controller for refresh.
5. Usher decrypts the expired token and reads the embedded `generatedAt` timestamp. It compares
   this against the user's last policy change in its database:
   - **No change since `generatedAt`:** re-issue a new JWE with the same grants and a
     refreshed TTL. Fast path: no full policy query.
   - **Change detected:** recompute grants from the policy store and issue a new JWE with
     updated grants.

The `generatedAt` claim serves as a debounce marker: the fast-path refresh skips the full policy
computation unless something has actually changed. Permission changes propagate within at most one
TTL window for any active user.

**Load comparison:** a user making 100 requests per minute on a 5-minute TTL triggers 1 Usher
call instead of 500. The grants computation cost is amortized across the TTL window.

**Default value rationale.** The 5-minute TTL is consistent with short-lived access token
conventions in OAuth 2.0 deployments and is the upper bound for exposure if a grants token is
intercepted (the attacker's window is at most 5 minutes, reduced further by push revocation).
The 30-second poll interval is derived from the worst-case revocation propagation window operators
should expect in degraded (push-down) conditions. The 60-second grace period is large enough to
absorb transient network disruptions without false-positive session suspensions, while short
enough that an adversarial channel silence yields a service disruption rather than a meaningful
access window. All three are deployment-configurable; deployments handling higher-sensitivity data
may tighten them.

---

## Grant computation pipeline

Grants are computed additively. Every user starts with no access; the controller adds grants
in three tiers, in order, and stops where the user's credentials no longer qualify. The result
is a `grants` object containing every resource the user may access and the categories they hold
within it.

### Tiers

**1. Open grants (always computed, for all users including anonymous)**

Any resource marked as open data contributes a grant entry for that resource. No IdP token is
required. An unauthenticated request produces a grants token containing only open-tier grants.

**2. Registered grants (computed if an authenticated IdP token is present)**

For authenticated users, the controller resolves their membership records and adds grants for
every resource where the user holds a membership with a `registered` or higher tier role.
`categories: []` in the token means member access with no category grants — the user sees
uncategorized records only.

**3. Controlled grants (computed for authenticated users with explicit category grants)**

On top of registration, the controller resolves explicit category grant records for the user
and adds the granted categories to the relevant resource's `categories` list. These grants are
stored with expiry timestamps and are checked at issuance time; expired grants are silently
omitted.

### Why the additive model matters

- **Uniform code path.** The bridge and plugin handle the same token structure regardless of
  whether the user is anonymous, a basic member, or a full-access researcher. The plugin
  translates the `grants` map into its query format; tiers are invisible to it.
- **Universal audit log.** Because even anonymous access triggers a token exchange, every data
  access — open or controlled — appears in Usher's audit log with the token's `generatedAt`
  timestamp and computed grants. Open data access is not invisible.
- **Consistent fail-secure.** The bridge's revocation channel and fail-secure mode apply to all
  tokens, including anonymous ones. A revocation of open access (resource taken offline,
  misconfiguration) propagates through the same path as a user-level revocation.

### Token structure

The `grants` object in the token payload is a map keyed by resource ID. Each entry carries:

```json
"RESOURCE_ID": {
  "role":       "member | owner | public",
  "categories": ["category-a", "category-b"]
}
```

A resource absent from the map means the user has no access to it at all. `categories: []`
means the user has role-level access to uncategorized records only. The plugin derives what to
filter out by subtracting this list from the full set of sensitive categories in its own config.

`role` values are `member`, `owner`, and `public`. The `public` value is **synthetic**: it is
assigned by the controller at issuance time for open-tier grants in anonymous tokens and is never
stored as a membership record in the policy database. A plugin receiving `"role": "public"` should
treat it as equivalent to the minimum read capability — no management actions, no categorized data
beyond what `categories` explicitly grants.

**Anonymous token example** (no IdP bearer token; only open resources present):
```json
{
  "sub": null,
  "iss": "https://usher.example.org",
  "aud": "arranger-prod",
  "iat": 1718611200,
  "exp": 1718611500,
  "generatedAt": 1718611200,
  "grants": {
    "OPEN_COHORT": { "role": "public", "categories": [] }
  }
}
```

`iss` is present in anonymous tokens: the token is still issued by the controller and the bridge
still validates the `iss` claim. Only `sub` is null; no other standard claims are omitted.

**Authenticated token example** (member of two cohorts, explicit category grant on one):
```json
{
  "sub": "user-id",
  "iss": "https://usher.example.org",
  "aud": "arranger-prod",
  "iat": 1718611200,
  "exp": 1718611500,
  "generatedAt": 1718611200,
  "grants": {
    "COHORT_A": { "role": "member", "categories": ["indigenous"] },
    "COHORT_B": { "role": "owner",  "categories": [] }
  }
}
```

---

## Emergency access revocation

### Problem

TTL-based caching means a grants token remains valid for up to 5 minutes after a permission
change. For routine changes this is acceptable. For emergencies (a compromised account, an access
violation, a resource being taken offline), even 5 minutes is too long.

### Mechanism: per-user revocation timestamp

Usher maintains a `revoked_at` timestamp per user. Revocation means: any grants token for
this user with `generatedAt` earlier than `revoked_at` is invalid, regardless of its TTL.

This does not require tracking individual token IDs. Usher stores one timestamp per user and
updates it on revocation. The `generatedAt` claim already present in every JWE token is the
anchor for this check.

### Propagation: push + poll

**Push (primary):** On revocation, the controller immediately pushes a revocation event to
connected bridges (via SSE or WebSocket) containing the user ID and `revoked_at` timestamp.
Bridges that receive this event drop the cached grants token for that user immediately.
Revocation takes effect on the next request, within seconds.

**Poll (fallback):** Bridges poll a lightweight endpoint at a short interval (default: 30
seconds):

```
GET /revocations?since=<timestamp>
```

This returns the list of user IDs whose revocation state changed since the given timestamp. In
normal operation the response is empty and cheap. A bridge that missed the push event picks up
the revocation within one poll interval.

Worst-case revocation propagation: poll interval (30 seconds), not token TTL (5 minutes). Push
provides speed; poll provides reliability.

### Multi-instance propagation

A horizontally scaled Usher deployment runs multiple controller instances behind a load balancer.
A revocation request may reach any instance. Without coordination, only that instance would push
the revocation event to its connected bridge subscribers; bridges connected to other instances
would not be notified until their next poll.

To avoid this, every controller instance publishes revocation events to a **Valkey pub/sub
channel** immediately after writing `revoked_at` to PostgreSQL. All instances subscribe to this
channel and push the event to each of their connected bridge subscribers on receipt.

The sequence for a revocation processed by instance A, with bridges connected to both A and B:

1. Instance A writes `revoked_at` to PostgreSQL.
2. Instance A publishes the revocation event to the Valkey channel.
3. Instance A pushes the event to its own connected bridges directly.
4. Instance B receives the Valkey pub/sub message.
5. Instance B pushes the event to its own connected bridges.

The poll endpoint (`GET /revocations?since=<timestamp>`) reads from PostgreSQL, which is already
updated in step 1. Bridges using the poll fallback reach the correct state regardless of which
controller instance they poll.

Controller instances are stateless between requests beyond their Valkey channel subscription.
No direct instance-to-instance coordination is needed: Valkey is the message bus.

See [architecture.md](architecture.md) for the full component breakdown and Valkey's two distinct
roles (shared cache and revocation pub/sub).

### Revocation scope

- **Single user:** the standard case.
- **All users of a resource:** when a resource is misconfigured or its data compromised.
- **Global:** break-glass; all active grants tokens platform-wide are invalidated. The
  management UI must require explicit operator confirmation for this action.

### Interaction with the token refresh fast path

When a revoked user's token expires and the bridge requests a refresh, the controller decrypts the expired
token, reads `generatedAt`, and compares it against `revoked_at`. Since `generatedAt` is earlier
than `revoked_at`, the fast path is skipped. Usher either rejects the refresh (if access remains
revoked) or recomputes grants (if access has been reinstated).

---

## Revocation channel integrity and fail-secure behaviour

### Threat model

An adversary who can selectively block revocation traffic (push events not delivered, poll
requests timing out) while leaving application traffic intact keeps a revoked grants token
valid for the duration of its TTL. This is an active attack on the revocation mechanism.

### Design response

**If a bridge cannot confirm revocation status, it does not trust cached tokens.**

Each bridge tracks the timestamp of its last successful revocation check (push received, or poll
returned successfully). If this timestamp exceeds a configurable grace period (default: 60
seconds) without a new successful check, the bridge enters **revocation-uncertain mode**.

In revocation-uncertain mode:
- Cached grants tokens are **suspended**, not expired. Requests are rejected with a "service
  temporarily unavailable" response (HTTP 503), not a "session ended" response (HTTP 401).
- The distinction matters: a suspended session resumes automatically when connectivity is restored
  and revocation status is confirmed, without requiring re-authentication. An expired session
  requires a new login.
- The grace period absorbs brief, non-adversarial network interruptions. After the grace period,
  fail-secure applies regardless of cause.

**Liveness via push connection.** When using SSE or WebSocket for push events, the persistent
connection itself is the liveness signal. A dropped connection that cannot be re-established
within the grace period is sufficient to trigger revocation-uncertain mode; no separate
heartbeat is needed.

**Startup behavior.** At bridge startup, no cached tokens exist and the revocation channel is
not yet established. The bridge must not serve requests until the revocation channel is confirmed
active: doing so would create a window with no revocation coverage. In practice this means the
bridge enters a brief initializing state on startup, queuing or rejecting requests until the
first successful push connection or poll response confirms channel health. The grace period clock
starts from that point, not from process start.

**The operational trade-off.** Legitimate users are also affected when the revocation channel is
disrupted. This is a deliberate choice: the threat of an adversary exploiting a blocked revocation
channel outweighs the inconvenience of a brief service interruption. Operators should treat Usher
as a high-availability dependency with reliable network paths to all bridge instances. The grace
period is the tunable knob: shorter values tighten security; longer values allow more tolerance
for transient network conditions.

---

## Identity provider abstraction

Usher validates incoming IdP tokens against a configured provider. The provider is pluggable:
- Keycloak (current Overture standard)
- Azure Active Directory / Entra ID
- Any OpenID Connect-compatible provider

Apps forward the user's bearer token to Usher on first exchange. Usher handles IdP validation.
Subsequent requests within the TTL window use the locally cached grants token, so IdP
connectivity is not in the hot path.

---

## Open questions

### Decryption key distribution

How does the bridge receive and rotate the JWE decryption key securely? Options include:
provisioned as an environment variable at deploy time, fetched from a secrets manager (Vault, AWS
Secrets Manager) at startup, or issued by the controller itself via a key-exchange endpoint that
requires mutual authentication. Key rotation strategy (how often, how the bridge picks up a new
key without downtime) is also unresolved. See [plugin-integration.md](plugin-integration.md).

### Grace period configurability scope

Should the grace period (default 60s) be configurable globally, per-bridge, or per-resource? A
resource containing highly sensitive data may warrant a shorter grace period than one with
lower-sensitivity data.

### Audit logging of revocation events

Every revocation (who triggered it, for which user, at what timestamp, and via which scope:
single user, resource, or global) should be logged. Where this log lives and how it is
queryable are not yet designed. See [management-ui.md](management-ui.md).
