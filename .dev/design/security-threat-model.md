# Security Threat Model

_Standard: OWASP Top 10:2025. Verify the current edition at https://owasp.org/www-project-top-ten/_

---

## Context: personal health records

Usher may sit in the authorization path for instances handling personal health information:
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

### A01: Broken Access Control

**Why this is Usher's primary concern.** Usher exists to prevent broken access control. Every
architectural decision in this system is, directly or indirectly, a response to A01.

| Design choice                                                                           | Addresses                                                                   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Deny by default: reaching a record requires a grant naming the category it carries      | Prevents implicit allow                                                     |
| Server-side enforcement (PEP plugins apply filters before queries reach the data layer) | Prevents client-side bypass                                                 |
| JWE tokens are opaque to the token holder                                               | Prevents a user reading their own restrictions and crafting bypass queries  |
| Emergency revocation by notice naming the principal                                     | Prevents continued access after authorization is withdrawn                  |
| Fail-secure on revocation channel disruption                                            | Prevents an adversary from sustaining access by blocking revocation signals |
| Usher tokens are short-lived (5-minute TTL)                                             | Limits exposure window of a stolen or leaked token                          |

**Gaps and open questions:**

- Role permission definitions are not yet specced. Until they are, it is not possible to verify
  that role assignments enforce the intended access boundaries. See
  [permissions-model.md](permissions-model.md).
- Field-level restriction enforcement is not yet designed. Records may be visible at the row level
  but sensitive fields within them are not yet protected. See
  [permissions-model.md](permissions-model.md).
- Plugin integration is designed and not yet a spec: the enforcement seam, the category clause and
  the failure directions are settled, while exact request and response shapes are not. A
  misconfigured or missing plugin would still bypass all access control for that app.
  See [plugin-integration.md](plugin-integration.md).
- **Decided:** Usher token uses an include-list (`categories`: what the user can access).
  Denied category names are absent from the token entirely; no information is leaked if the token
  were ever readable. See [permissions-model.md](permissions-model.md).

**PHR-specific insider threat note:** Custodians hold meaningful privilege: the ability to approve
and revoke category grants for their assigned category. A compromised or rogue custodian can
silently escalate access for colluders or suppress access for legitimate users without triggering
a technical access control failure. In a health data context this is not a hypothetical; insider
threats and account compromise are among the most common causes of health data breaches.

| Design choice                                                                                                                            | Addresses                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Custodian scope is category-bounded: a custodian can only act on grants for their assigned category within their authorized resources    | Limits blast radius of a compromised or rogue custodian                   |
| A custodian may not issue a grant to themselves (intended; see the gap below)                                                            | Prevents direct privilege escalation via the custodian role               |
| All custodian actions are logged with actor identity, target, resource, category, and timestamp (see [audit-events.md](audit-events.md)) | Makes rogue custodian actions detectable and forensically reconstructable |
| System admin can revoke any custodian role regardless of instance config                                                                 | Enables rapid response to a compromised or rogue custodian                |
| Bulk grant operations above a configurable threshold are alertable                                                                       | Primary detection signal for a rogue custodian acting at scale            |

**Gap:** Self-grant prevention (a custodian cannot add themselves as a grantee for their own category) is not yet specified. It is tracked as an admin-API blocker in [../roadmap.md](../roadmap.md), not in the permissions model.

---

### A02: Security Misconfiguration

Usher has several configuration points that, if set incorrectly, degrade security. Defaults must
be safe; misconfiguration must fail loudly, not silently.

| Design choice                                                                                                                                              | Addresses                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Grace period (60s default) is the tunable knob between security and resilience; must be documented clearly so operators understand what loosening it means | Prevents silent security degradation via misconfiguration |
| IdP validation must check `aud`, `iss`, scope, and expiry (not just signature)                                                                             | Prevents token reuse across systems or issuers            |
| TTL default (5 min) should be safe; longer values require explicit operator decision                                                                       | Short default limits misconfiguration blast radius        |
| Management UI must not ship with default admin credentials                                                                                                 | Prevents administrative takeover on first deploy          |
| Debug endpoints and introspection must be off by default                                                                                                   | Prevents information leakage in production                |

**Gaps and open questions:**

- How Usher validates IdP tokens (OIDC discovery, key rotation, accepted `aud` values) is not yet
  designed. A permissive or unconfigured IdP validation is a critical misconfiguration risk.
- Key provisioning is settled: one symmetric key per controller-and-application pair, held in the
  secrets store and delivered to both pods by the secrets operator. Rotation is not settled, and a
  default or empty key would be a severe misconfiguration. See
  [plugin-integration.md](plugin-integration.md).
- Startup validation: Usher should refuse to start rather than run with insecure defaults
  (missing key, missing IdP config, etc.).
- **Introspecting API keys needs Usher's first credential to Keycloak, and it is a powerful one.**
  Everything Usher does with the identity provider today is public-key verification against the
  published JWKS, which needs no secret. The API key check requires the service calling it
  to authenticate, and where that service presents a bearer token, the token's subject must own the
  key. Usher introspects other
  people's keys by definition, so it needs basic auth, and that credential can introspect anybody's
  key. It reintroduces the shared-secret shape the token design avoided by having applications
  register public halves. Open: whether it is its own Keycloak client rather than shared with
  anything else Usher later needs, and how it rotates. See
  [../docs/atlas/roadmap/api-keys.md](../docs/atlas/roadmap/api-keys.md).

---

### A03: Software Supply Chain Failures

Usher depends on JWT/JWE libraries and an IdP client. These are part of the attack surface.

| Design choice                                                                                       | Addresses                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Use established libraries for JWE (`jose`, or equivalent well-maintained package); no custom crypto | Reduces supply chain attack surface; established libraries have external security scrutiny |
| Lock files committed to version control                                                             | Reproducible builds; prevents dependency substitution attacks                              |
| New dependencies require review                                                                     | Human oversight of new supply chain additions                                              |

**Gaps:** Dependency scanning and audit policy are not yet defined for the Usher project. This
should be established before the first release.

---

### A04: Cryptographic Failures

Usher tokens carry authorization policy for personal health data. Cryptographic strength is
non-negotiable.

| Design choice                                                                                                    | Addresses                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| JWE (not JWS) for Usher tokens                                                                                   | Payload is encrypted; interception does not reveal the permissions payload |
| JWE algorithm choices must be strong: A256GCM for content encryption, `dir` with a per-application symmetric key | Prevents cryptographic downgrade attacks                                   |
| All communication between plugins, Usher, IdP, and database must use TLS                                         | Prevents interception of tokens and policy data in transit                 |
| `generatedAt` and other claims are encrypted inside the JWE                                                      | Prevents an attacker from learning the structure of access restrictions    |
| No credentials, tokens, or keys in log output at any level                                                       | Prevents credential exposure through log aggregation pipelines             |

**Gaps and open questions:**

- Key rotation: how an application's key is rotated without dropping tokens still in flight is not
  yet designed. Health data contexts may require frequent rotation. It is the one part of the key
  design left open, the algorithm and the provisioning path both being settled. See
  [plugin-integration.md](plugin-integration.md).
- Database encryption at rest: not yet specified. Health data stored in Usher's policy store
  (user assignments, category grants) should be encrypted at rest.

---

### A05: Injection

Usher constructs queries against its own database and against IdP APIs. Plugins translate
permissions payloads into app-native queries (SQON, SQL, etc.).

| Design choice                                                                                                                                                    | Addresses                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| All Usher database queries must use parameterized statements or an ORM that handles parameter binding                                                            | Prevents SQL injection into Usher's policy store               |
| Resource IDs, category names, and user identifiers from permissions payloads must be validated against an allowlist before plugins use them to construct queries | Prevents permissions payload injection into downstream queries |
| Usher's API validates all input at the boundary (type, length, format)                                                                                           | Prevents malformed input from reaching internal logic          |

**Gaps:** Plugin-side injection prevention is the most significant gap. Each PEP plugin
translates permissions payload data into a native query format. If a plugin concatenates permissions payload values
into a query string rather than parameterizing them, it creates an injection path where a
compromised Usher policy store could inject into an app's data layer. Plugin design must enforce
parameterized application of permissions payload data. See [plugin-integration.md](plugin-integration.md).

---

### A06: Insecure Design

This document, and the design folder as a whole, is the primary mitigation for insecure design:
documenting intent and threat model before writing code surfaces blind spots while they are cheap
to fix.

| Design choice                                                                                          | Addresses                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Fail-secure on revocation channel disruption                                                           | Adversarial condition designed for explicitly: an adversary blocking revocation signals gains nothing |
| Category grants are additive (deny by default)                                                         | The system does not need to know every denied category; it only grants what is explicitly authorized  |
| JWE opacity: a token holder cannot read their own grants                                               | Prevents the authorization model itself from being used as an oracle for probing access boundaries    |
| Grants enforcement is centralized in each app's plugin layer, not distributed across application logic | Single enforcement point reduces the risk of inconsistent or forgotten enforcement                    |
| Horizontal scaling with no shared in-memory state                                                      | Usher instances do not trust each other's in-memory state; all state lives in the database            |

**PHR-specific design note:** In health data contexts, "insecure design" includes designing for
the average user rather than the adversarial one. Every design decision in Usher should be stress-
tested against the question: "what does an adversary gain if this decision is wrong?"

---

### A07: Authentication Failures

Usher delegates authentication to the IdP but must validate what it receives strictly.

| Design choice                                                                                         | Addresses                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Strict IdP token validation: `aud`, `iss`, `exp`, scope checked on every exchange; not just signature | Prevents token reuse across systems, expired token acceptance, and scope escalation         |
| Usher tokens are short-lived (5-minute TTL)                                                           | Limits the useful lifetime of a stolen Usher token                                          |
| Revocation applies immediately to known-compromised identities                                        | Allows rapid response to credential compromise                                              |
| Usher does not implement authentication itself; it delegates to established IdP infrastructure        | Prevents reinventing authentication mechanisms (a common source of authentication failures) |

**Gaps:**

- What Usher does when the IdP is unavailable at Usher token exchange time is not yet
  designed. The fail-secure principle implies: if the IdP cannot validate the bearer token, Usher
  should reject the request rather than issuing an Usher token based on an unvalidated claim.
- Multi-factor authentication is an IdP concern; Usher should document that MFA is expected to
  be enforced at the IdP level for any instance handling sensitive health data.

---

### A08: Software or Data Integrity Failures

Usher's access decisions depend on the integrity of its policy store and the grants
tokens it issues.

| Design choice                                                                                               | Addresses                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| JWE tokens are tamper-evident: the encryption scheme includes authentication (AEAD)                         | A modified token is rejected at decryption; the alteration is detectable        |
| Permissions payload must be validated against a schema on every decode                                      | Prevents malformed or unexpected payloads from propagating to app query layers  |
| Policy store changes must be transactional: partial writes should not leave policy in an inconsistent state | Prevents a partially applied permission change from creating an exploitable gap |
| The `generatedAt` claim is inside the encrypted envelope                                                    | Prevents replay attacks using an old token with a manipulated timestamp         |

**Gaps:**

- Database integrity controls (foreign key constraints, audit triggers) are not yet designed.
- **Settled: payload versions are negotiated at the exchange, never tolerated at read time.** The
  bridge sends the versions it supports and the controller emits the highest in the intersection or
  refuses. Read-time tolerance was the approach considered and rejected, because an added field can
  _narrow_: a future withholding marker would be silently ignored by an older bridge, and that
  failure direction is open. See the payload-version decision in [decisions.md](decisions.md).

---

### A09: Security Logging and Alerting Failures

In a PHR context, the audit log is not optional. It is a legal and ethical requirement.

| Design choice                                                                                                                 | Addresses                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every access decision (allowed or denied) should be logged: user identity, resource, categories in scope, timestamp, decision | Provides the audit trail required for health data governance and breach investigation |
| Every revocation event logged: who triggered it, scope, timestamp                                                             | Enables forensic reconstruction of access control changes                             |
| Revocation-uncertain mode transitions must be logged and alertable                                                            | Makes attempted revocation channel suppression observable                             |
| All custodianship assignment and removal events logged: actor, target, resource, category, timestamp                          | Enables detection of unauthorized custodianship changes                               |
| All ownership transfer events logged: actor, from-owner, to-owner, resource, timestamp                                        | Enables forensic reconstruction of the ownership chain                                |
| Admin overrides of config-disabled operations logged: actor, operation, timestamp                                             | Makes admin power use auditable; prevents silent override                             |
| Bulk grant operations above a configurable threshold logged and alertable                                                     | Primary detection signal for a rogue custodian acting at scale                        |
| Logs must never contain the Usher token payload, health record identifiers, or raw bearer tokens                              | Prevents the audit log from becoming a secondary sensitive data exposure              |
| Structured log format (JSON)                                                                                                  | Parseable by log aggregators; prerequisite for effective monitoring and alerting      |

The full list of auditable events, required fields per event, and severity levels is in
[audit-events.md](audit-events.md).

**Gaps:**

- Audit log storage, retention policy, and queryability are not yet designed. Health data contexts
  may require specific minimum retention periods. See [management-ui.md](management-ui.md).
- Alerting thresholds (e.g. repeated access denials for the same user, bulk grant operations by a
  single custodian, unusual revocation frequency) are not yet defined.
- Self-grant prevention (a custodian cannot approve a grant for themselves) is not yet specified;
  without it, audit logging is the only control against direct privilege escalation. Tracked as an
  admin-API blocker in [../roadmap.md](../roadmap.md).

---

### A10: Mishandling of Exceptional Conditions

| Design choice                                                                                                             | Addresses                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Fail-secure: if revocation status cannot be confirmed, sessions are suspended for granted access (not silently permitted) | Errors in the revocation channel result in safe failure, not continued unauthorized access            |
| Revocation-uncertain mode returns 503 (unavailable), not 401 (unauthenticated) or 200 (permitted)                         | Error response does not reveal internal state; does not grant access; allows recovery without re-auth |
| JWE decryption failure must reject the token cleanly, not partially process it                                            | A corrupt or tampered token is rejected at the boundary                                               |
| Plugin errors during permissions payload application must fail the request, not apply a partial permissions payload       | A half-applied permissions payload could produce a result set that is more permissive than intended   |

**Gaps:**

- What Usher does when its own database is unavailable is not yet specified. Since Usher cannot
  compute grants without policy data, the only safe behaviour is to reject all grants
  token exchanges and fail plugins into revocation-uncertain mode.
- Error responses from Usher must not include internal state, stack traces, or policy details.
  This must be enforced at the API layer.

---

## Summary: addressed vs. open

| Category                       | Status                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01: Broken Access Control     | Core design addresses key vectors; plugin enforcement designed and not yet a spec; field-level restriction not yet designed                                                                             |
| A02: Security Misconfiguration | Principles established; key distribution settled, IdP validation details not yet designed                                                                                                               |
| A03: Supply Chain Failures     | Principles noted; dependency policy not yet established                                                                                                                                                 |
| A04: Cryptographic Failures    | JWE approach and algorithm specified (`dir` with A256GCM, symmetric per application); rotation not yet designed                                                                                         |
| A05: Injection                 | Usher-side: to be enforced at implementation; plugin-side: open design gap                                                                                                                              |
| A06: Insecure Design           | Addressed by the existence of this threat model and the design-first approach                                                                                                                           |
| A07: Authentication Failures   | Delegation to IdP is specified; IdP-unavailable behaviour not yet designed                                                                                                                              |
| A08: Data Integrity Failures   | Token tamper-evidence specified; DB integrity controls not yet designed                                                                                                                                 |
| A09: Logging and Alerting      | Alerting is by recording: severity routes without payload parsing, and four conditions Usher alone can see are emitted as their own types. Storage, retention and response commitments not yet designed |
| A10: Exceptional Conditions    | Fail-secure specified; DB-unavailable and API error format not yet designed                                                                                                                             |
