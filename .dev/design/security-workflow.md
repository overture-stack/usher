# Security Workflow

_Status: specced. This is the most fully designed part of Usher. Rationale is documented for each
decision._

See [concepts.md](concepts.md) for definitions of JWE, PDP, PEP, fail-secure, and other terms
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
User --IdP JWT--> App (with Usher plugin / PEP)
                        |
                        | Exchange IdP JWT for constraint token (once per TTL window)
                        |
                        v
                 +-------------+
                 |    Usher    |
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
                 Compute constraints
                        |
                        v
              Encrypted constraint token (JWE)
              [ payload, readable only by plugins with the key: ]
              {
                "sub": "user-id",
                "role": "member",
                "resources": ["RESOURCE_A", "RESOURCE_B"],
                "record_filters": { "exclude_categories": ["indigenous_data"] },
                "field_restrictions": { ... },
                "generatedAt": "2026-06-17T10:00:00Z",
                "exp": "2026-06-17T10:05:00Z"
              }
                        |
                        v
             Plugin caches token; validates locally on
             every request within the TTL window.
             Translates constraints into app-native format:
               - Arranger: SQON filter object
               - Lyric: database WHERE clause
               - Stage: API query parameters
```

---

## Constraint token format: JWE

Usher issues constraint tokens as **JWE (JSON Web Encryption)**: encrypted JWTs, not merely
signed ones. See [concepts.md, JWS vs JWE](concepts.md#jws-json-web-signature-signed-jwt)
for the distinction.

### Design rationale

**Why encrypted (not just signed):** A user who can read their own constraint token knows exactly
which filters are applied to their queries. In sensitive data contexts, even knowing the shape of
the restriction may be information they should not have. JWE prevents a token holder from reading
the constraints it encodes.

**Why self-contained (not opaque):** An opaque token requires a network call to Usher to resolve
its contents. Self-contained tokens are validated and decoded locally by plugins using the
decryption key. This removes Usher from the hot path of every request, which is the mechanism that
caused per-request auth service crashes in prior deployments.

**Why JWE over a custom encrypted format:** JWE is defined in RFC 7516 and supported by all major
JWT libraries. No custom token infrastructure is needed, and any security engineer can audit the
implementation against a published standard.

**The decryption key** is a shared secret provisioned to each plugin at deploy time. It is not
the user's key; users never have it. The key distribution mechanism (how plugins receive and
rotate this key securely) is a deployment concern not yet designed; see
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

1. On first request (or on constraint token expiry), the plugin sends the user's IdP JWT to Usher.
2. Usher validates the IdP JWT with the configured provider, resolves the user's current
   permissions, and returns a JWE constraint token with a short TTL (default: 5 minutes,
   configurable per deployment).
3. The plugin caches the constraint token. All requests within the TTL window are validated and
   processed locally, with no Usher network call.
4. On TTL expiry, the plugin sends both the expired token and the current IdP JWT to Usher for
   refresh.
5. Usher decrypts the expired token and reads the embedded `generatedAt` timestamp. It compares
   this against the user's last policy change in its database:
   - **No change since `generatedAt`:** re-issue a new JWE with the same constraints and a
     refreshed TTL. Fast path: no full policy query.
   - **Change detected:** re-compute constraints from the policy store and issue a new JWE with
     updated constraints.

The `generatedAt` claim serves as a debounce marker: the fast-path refresh skips the full policy
computation unless something has actually changed. Permission changes propagate within at most one
TTL window for any active user.

**Load comparison:** a user making 100 requests per minute on a 5-minute TTL triggers 1 Usher
call instead of 500. The constraint computation cost is amortized across the TTL window.

---

## Emergency access revocation

### Problem

TTL-based caching means a constraint token remains valid for up to 5 minutes after a permission
change. For routine changes this is acceptable. For emergencies (a compromised account, an access
violation, a resource being taken offline), even 5 minutes is too long.

### Mechanism: per-user revocation timestamp

Usher maintains a `revoked_at` timestamp per user. Revocation means: any constraint token for
this user with `generatedAt` earlier than `revoked_at` is invalid, regardless of its TTL.

This does not require tracking individual token IDs. Usher stores one timestamp per user and
updates it on revocation. The `generatedAt` claim already present in every JWE token is the
anchor for this check.

### Propagation: push + poll

**Push (primary):** On revocation, Usher immediately pushes a revocation event to connected
plugins (via SSE or webhook) containing the user ID and `revoked_at` timestamp. Plugins that
receive this event drop the cached constraint token for that user immediately. Revocation takes
effect on the next request, within seconds.

**Poll (fallback):** Plugins poll a lightweight endpoint at a short interval (default: 30
seconds):

```
GET /revocations?since=<timestamp>
```

This returns the list of user IDs whose revocation state changed since the given timestamp. In
normal operation the response is empty and cheap. A plugin that missed the push event picks up
the revocation within one poll interval.

Worst-case revocation propagation: poll interval (30 seconds), not token TTL (5 minutes). Push
provides speed; poll provides reliability.

### Revocation scope

- **Single user:** the standard case.
- **All users of a resource:** when a resource is misconfigured or its data compromised.
- **Global:** break-glass; all active constraint tokens platform-wide are invalidated. The
  management UI must require explicit operator confirmation for this action.

### Interaction with the token refresh fast path

When a revoked user's token expires and the plugin requests a refresh, Usher decrypts the expired
token, reads `generatedAt`, and compares it against `revoked_at`. Since `generatedAt` is earlier
than `revoked_at`, the fast path is skipped. Usher either rejects the refresh (if access remains
revoked) or re-computes constraints (if access has been reinstated).

---

## Revocation channel integrity and fail-secure behaviour

### Threat model

An adversary who can selectively block revocation traffic (push events not delivered, poll
requests timing out) while leaving application traffic intact keeps a revoked constraint token
valid for the duration of its TTL. This is an active attack on the revocation mechanism.

### Design response

**If a plugin cannot confirm revocation status, it does not trust cached tokens.**

Each plugin tracks the timestamp of its last successful revocation check (push received, or poll
returned successfully). If this timestamp exceeds a configurable grace period (default: 60
seconds) without a new successful check, the plugin enters **revocation-uncertain mode**.

In revocation-uncertain mode:
- Cached constraint tokens are **suspended**, not expired. Requests are rejected with a "service
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

**The operational trade-off.** Legitimate users are also affected when the revocation channel is
disrupted. This is a deliberate choice: the threat of an adversary exploiting a blocked revocation
channel outweighs the inconvenience of a brief service interruption. Operators should treat Usher
as a high-availability dependency with reliable network paths to all app plugins. The grace period
is the tunable knob: shorter values tighten security; longer values allow more tolerance for
transient network conditions.

---

## Identity provider abstraction

Usher validates incoming IdP tokens against a configured provider. The provider is pluggable:
- Keycloak (current Overture standard)
- Azure Active Directory / Entra ID
- Any OpenID Connect-compatible provider

Apps forward the user's bearer token to Usher on first exchange. Usher handles IdP validation.
Subsequent requests within the TTL window use the locally cached constraint token, so IdP
connectivity is not in the hot path.

---

## Open questions

### Decryption key distribution

How do plugins receive and rotate the JWE decryption key securely? Options include: provisioned
as an environment variable at deploy time, fetched from a secrets manager (Vault, AWS Secrets
Manager) at startup, or issued by Usher itself via a key-exchange endpoint that requires mutual
authentication. Key rotation strategy (how often, how plugins pick up a new key without
downtime) is also unresolved. See [plugin-integration.md](plugin-integration.md).

### Grace period configurability scope

Should the grace period (default 60s) be configurable globally, per-plugin, or per-resource? A
resource containing highly sensitive data may warrant a shorter grace period than one with
lower-sensitivity data.

### Audit logging of revocation events

Every revocation (who triggered it, for which user, at what timestamp, and via which scope:
single user, resource, or global) should be logged. Where this log lives and how it is
queryable are not yet designed. See [management-ui.md](management-ui.md).
