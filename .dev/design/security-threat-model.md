# Security Threat Model

_Standard: OWASP Top 10:2025. Verify the current edition at https://owasp.org/www-project-top-ten/_

---

## Context: personal health records

Usher may sit in the authorization path for deployments handling personal health information:
clinical records, genomic data, and Indigenous health data with additional ethical and legal
protections. This context sets the bar for the threat model: a breach or access control failure is
not merely a security incident; it may cause direct harm to individuals, violate applicable health
privacy legislation (e.g. PHIPA in Ontario, HIPAA in the US), and undermine the trust that
clinical and research participation depends on.

The principle throughout: **treat all data behind Usher as sensitive by default.** Do not design
for the average case; design for the most sensitive data the system may ever hold.

---

## OWASP Top 10:2025 mapping

For each category: how it applies to Usher, which design choices address it, and what gaps remain.

---

### A01 — Broken Access Control

**Why this is Usher's primary concern.** Usher exists to prevent broken access control. Every
architectural decision in this system is, directly or indirectly, a response to A01.

| Design choice | Addresses |
|---|---|
| Deny by default: data category access requires an explicit grant; membership alone does not grant category access | Prevents implicit allow |
| Server-side enforcement (PEP plugins apply filters before queries reach the data layer) | Prevents client-side bypass |
| JWE tokens are opaque to the token holder | Prevents a user reading their own restrictions and crafting bypass queries |
| Emergency revocation with per-user `revoked_at` | Prevents continued access after authorization is withdrawn |
| Fail-secure on revocation channel disruption | Prevents an adversary from sustaining access by blocking revocation signals |
| Grants tokens are short-lived (5-minute TTL) | Limits exposure window of a stolen or leaked token |

**Gaps and open questions:**
- Role capability definitions are not yet specced. Until they are, it is not possible to verify
  that role assignments enforce the intended access boundaries. See
  [permissions-model.md](permissions-model.md).
- Field-level restriction enforcement is not yet designed. Records may be visible at the row level
  but sensitive fields within them are not yet protected. See
  [permissions-model.md](permissions-model.md).
- Plugin integration (specifically how plugins validate tokens and apply the grants payload) is not
  yet designed. A misconfigured or missing plugin would bypass all access control for that app.
  See [plugin-integration.md](plugin-integration.md).
- **Decided:** grants token uses an include-list (`categories`: what the user can access).
  Denied category names are absent from the token entirely; no information is leaked if the token
  were ever readable. See [permissions-model.md](permissions-model.md).

---

### A02 — Security Misconfiguration

Usher has several configuration points that, if set incorrectly, degrade security. Defaults must
be safe; misconfiguration must fail loudly, not silently.

| Design choice | Addresses |
|---|---|
| Grace period (60s default) is the tunable knob between security and resilience; must be documented clearly so operators understand what loosening it means | Prevents silent security degradation via misconfiguration |
| IdP validation must check `aud`, `iss`, scope, and expiry (not just signature) | Prevents token reuse across systems or issuers |
| TTL default (5 min) should be safe; longer values require explicit operator decision | Short default limits misconfiguration blast radius |
| Management UI must not ship with default admin credentials | Prevents administrative takeover on first deploy |
| Debug endpoints and introspection must be off by default | Prevents information leakage in production |

**Gaps and open questions:**
- How Usher validates IdP tokens (OIDC discovery, key rotation, accepted `aud` values) is not yet
  designed. A permissive or unconfigured IdP validation is a critical misconfiguration risk.
- The JWE decryption key distribution mechanism is not yet designed. A default or empty key would
  be a severe misconfiguration. See [plugin-integration.md](plugin-integration.md).
- Startup validation: Usher should refuse to start rather than run with insecure defaults
  (missing key, missing IdP config, etc.).

---

### A03 — Software Supply Chain Failures

Usher depends on JWT/JWE libraries and an IdP client. These are part of the attack surface.

| Design choice | Addresses |
|---|---|
| Use established libraries for JWE (`jose`, or equivalent well-maintained package); no custom crypto | Reduces supply chain attack surface; established libraries have external security scrutiny |
| Lock files committed to version control | Reproducible builds; prevents dependency substitution attacks |
| New dependencies require review | Human oversight of new supply chain additions |

**Gaps:** Dependency scanning and audit policy are not yet defined for the Usher project. This
should be established before the first release.

---

### A04 — Cryptographic Failures

Grants tokens carry authorization policy for personal health data. Cryptographic strength is
non-negotiable.

| Design choice | Addresses |
|---|---|
| JWE (not JWS) for grants tokens | Payload is encrypted; interception does not reveal the grants payload |
| JWE algorithm choices must be strong: AES-256-GCM for content encryption, RSA-OAEP or ECDH-ES for key wrap | Prevents cryptographic downgrade attacks |
| All communication between plugins, Usher, IdP, and database must use TLS | Prevents interception of tokens and policy data in transit |
| `generatedAt` and other claims are encrypted inside the JWE | Prevents an attacker from learning the structure of access restrictions |
| No credentials, tokens, or keys in log output at any level | Prevents credential exposure through log aggregation pipelines |

**Gaps and open questions:**
- JWE algorithm selection is not yet decided. The document describes JWE conceptually; the
  specific algorithms must be chosen and documented before implementation.
- Key rotation: how the JWE decryption key is rotated without downtime is not yet designed.
  Health data contexts may require frequent key rotation. See
  [plugin-integration.md](plugin-integration.md).
- Database encryption at rest: not yet specified. Health data stored in Usher's policy store
  (user assignments, category grants) should be encrypted at rest.

---

### A05 — Injection

Usher constructs queries against its own database and against IdP APIs. Plugins translate
grants payloads into app-native queries (SQON, SQL, etc.).

| Design choice | Addresses |
|---|---|
| All Usher database queries must use parameterized statements or an ORM that handles parameter binding | Prevents SQL injection into Usher's policy store |
| Resource IDs, category names, and user identifiers from grants payloads must be validated against an allowlist before plugins use them to construct queries | Prevents grants payload injection into downstream queries |
| Usher's API validates all input at the boundary (type, length, format) | Prevents malformed input from reaching internal logic |

**Gaps:** Plugin-side injection prevention is the most significant gap. Each PEP plugin
translates grants payload data into a native query format. If a plugin concatenates grants payload values
into a query string rather than parameterizing them, it creates an injection path where a
compromised Usher policy store could inject into an app's data layer. Plugin design must enforce
parameterized application of grants payload data. See [plugin-integration.md](plugin-integration.md).

---

### A06 — Insecure Design

This document, and the design folder as a whole, is the primary mitigation for insecure design:
documenting intent and threat model before writing code surfaces blind spots while they are cheap
to fix.

| Design choice | Addresses |
|---|---|
| Fail-secure on revocation channel disruption | Adversarial condition designed for explicitly: an adversary blocking revocation signals gains nothing |
| Category grants are additive (deny by default) | The system does not need to know every denied category; it only grants what is explicitly authorized |
| JWE opacity: a token holder cannot read their own grants | Prevents the authorization model itself from being used as an oracle for probing access boundaries |
| Grants enforcement is centralized in each app's plugin layer, not distributed across application logic | Single enforcement point reduces the risk of inconsistent or forgotten enforcement |
| Horizontal scaling with no shared in-memory state | Usher instances do not trust each other's in-memory state; all state lives in the database |

**PHR-specific design note:** In health data contexts, "insecure design" includes designing for
the average user rather than the adversarial one. Every design decision in Usher should be stress-
tested against the question: "what does an adversary gain if this decision is wrong?"

---

### A07 — Authentication Failures

Usher delegates authentication to the IdP but must validate what it receives strictly.

| Design choice | Addresses |
|---|---|
| Strict IdP token validation: `aud`, `iss`, `exp`, scope checked on every exchange; not just signature | Prevents token reuse across systems, expired token acceptance, and scope escalation |
| Grants tokens are short-lived (5-minute TTL) | Limits the useful lifetime of a stolen grants token |
| Revocation applies immediately to known-compromised identities | Allows rapid response to credential compromise |
| Usher does not implement authentication itself; it delegates to established IdP infrastructure | Prevents reinventing authentication mechanisms (a common source of authentication failures) |

**Gaps:**
- What Usher does when the IdP is unavailable at grants token exchange time is not yet
  designed. The fail-secure principle implies: if the IdP cannot validate the bearer token, Usher
  should reject the request rather than issuing a grants token based on an unvalidated claim.
- Multi-factor authentication is an IdP concern; Usher should document that MFA is expected to
  be enforced at the IdP level for any deployment handling sensitive health data.

---

### A08 — Software or Data Integrity Failures

Usher's authorization decisions depend on the integrity of its policy store and the grants
tokens it issues.

| Design choice | Addresses |
|---|---|
| JWE tokens are tamper-evident: the encryption scheme includes authentication (AEAD) | A modified token is rejected at decryption; the alteration is detectable |
| Grants payload must be validated against a schema on every decode | Prevents malformed or unexpected payloads from propagating to app query layers |
| Policy store changes must be transactional: partial writes should not leave policy in an inconsistent state | Prevents a partially applied permission change from creating an exploitable gap |
| The `generatedAt` claim is inside the encrypted envelope | Prevents replay attacks using an old token with a manipulated timestamp |

**Gaps:**
- Database integrity controls (foreign key constraints, audit triggers) are not yet designed.
- Grants payload schema version handling: if the schema changes, old tokens must be rejected
  cleanly, not silently misinterpreted. A schema version claim inside the JWE is one approach.

---

### A09 — Security Logging and Alerting Failures

In a PHR context, the audit log is not optional. It is a legal and ethical requirement.

| Design choice | Addresses |
|---|---|
| Every authorization decision (allowed or denied) should be logged: user identity, resource, data categories in scope, timestamp, decision | Provides the audit trail required for health data governance and breach investigation |
| Every revocation event logged: who triggered it, scope, timestamp | Enables forensic reconstruction of access control changes |
| Revocation-uncertain mode transitions must be logged and alertable | Makes attempted revocation channel suppression observable |
| Logs must never contain the grants token payload, health record identifiers, or raw bearer tokens | Prevents the audit log from becoming a secondary sensitive data exposure |
| Structured log format (JSON) | Parseable by log aggregators; prerequisite for effective monitoring and alerting |

**Gaps:**
- Audit log storage, retention policy, and queryability are not yet designed. Health data contexts
  may require specific minimum retention periods. See [management-ui.md](management-ui.md).
- Alerting thresholds (e.g. repeated access denials for the same user, unusual revocation
  frequency) are not yet defined.

---

### A10 — Mishandling of Exceptional Conditions

| Design choice | Addresses |
|---|---|
| Fail-secure: if revocation status cannot be confirmed, sessions are suspended (not silently permitted) | Errors in the revocation channel result in safe failure, not continued unauthorized access |
| Revocation-uncertain mode returns 503 (unavailable), not 401 (unauthenticated) or 200 (permitted) | Error response does not reveal internal state; does not grant access; allows recovery without re-auth |
| JWE decryption failure must reject the token cleanly, not partially process it | A corrupt or tampered token is rejected at the boundary |
| Plugin errors during grants payload application must fail the request, not apply a partial grants payload | A half-applied grants payload could produce a result set that is more permissive than intended |

**Gaps:**
- What Usher does when its own database is unavailable is not yet specified. Since Usher cannot
  compute grants without policy data, the only safe behaviour is to reject all grants
  token exchanges and fail plugins into revocation-uncertain mode.
- Error responses from Usher must not include internal state, stack traces, or policy details.
  This must be enforced at the API layer.

---

## Summary: addressed vs. open

| Category | Status |
|---|---|
| A01 — Broken Access Control | Core design addresses key vectors; field-level and plugin enforcement not yet designed |
| A02 — Security Misconfiguration | Principles established; IdP validation and key distribution details not yet designed |
| A03 — Supply Chain Failures | Principles noted; dependency policy not yet established |
| A04 — Cryptographic Failures | JWE approach specified; algorithm selection and key rotation not yet designed |
| A05 — Injection | Usher-side: to be enforced at implementation; plugin-side: open design gap |
| A06 — Insecure Design | Addressed by the existence of this threat model and the design-first approach |
| A07 — Authentication Failures | Delegation to IdP is specified; IdP-unavailable behaviour not yet designed |
| A08 — Data Integrity Failures | Token tamper-evidence specified; DB integrity controls not yet designed |
| A09 — Logging and Alerting | Requirements stated; storage, retention, and alerting not yet designed |
| A10 — Exceptional Conditions | Fail-secure specified; DB-unavailable and API error format not yet designed |
