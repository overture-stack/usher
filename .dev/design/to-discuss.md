# Design Issues: To Discuss

Items flagged during design review that require a deliberate decision or design work before the
affected area can be considered ready for implementation. Grouped by theme; severity noted inline.

This document is distinct from the open questions already captured in individual design files.
Those are design decisions not yet made. Items here are either gaps in designs presented as
settled, inconsistencies between documents, or security properties that are claimed but not fully
closed.

---

## Token and grants model

**[CRITICAL] Fast-path refresh does not account for `resource_categories` changes.**
`security-workflow.md` describes comparing `generatedAt` against "the user's last policy change."
If that means changes to the user's `memberships` or `category_grants` rows (the most natural
reading), then tightening `resource_categories` (adding a new controlled category to a resource)
does not invalidate any active cached tokens until their TTL expires. A user who should no longer
see certain records after a category is added to their resource will continue to see them for up
to one TTL window. For a system handling PHI this is a correctness gap in the access control
guarantee. Resolution requires specifying exactly which operations update the "last policy change"
timestamp and confirming that `resource_categories` writes are included.

**[CRITICAL] `generatedAt` is not in the entity schema.**
The fast-path check and the revocation comparison both depend on a per-user "last policy change"
timestamp. Its storage location is not described: not in `permissions-model.md`'s entity schema,
not in the PostgreSQL section of `architecture.md`. Is it a column on `users`? A separate
`user_policy_versions` table? A Valkey key? What writes to it? The fast path is the primary
performance mechanism; its correctness depends on this field being updated by exactly the right
set of operations.

**[HIGH] Multiple roles per resource, single `role` field in the token.**
`permissions-model.md` explicitly supports multiple simultaneous roles per user per resource, with
effective permissions as the union of all role capabilities. The token structure has a single scalar
`role` field per resource entry. No rule is specified for collapsing multiple roles into one value
at issuance time. A plugin receiving a collapsed value that does not represent the user's full
capability set will apply incorrect filters. Either the token schema needs to support an array, or
the collapsing rule needs to be defined and its safety argued.

**[HIGH] Anonymous token cache key is undefined.**
The bridge caches grants tokens per user, identified by `sub`. Anonymous tokens have `"sub": null`.
Multiple anonymous users share the same bridge. What is the cache key? One shared token for all
anonymous sessions? One per request? One per session cookie? Each option has different security
and performance characteristics. Revocation of open access (a resource taken offline) also needs
a defined path for the anonymous case, since the existing per-user `revoked_at` mechanism cannot
address a null `sub`.

**[HIGH] `revoked_at` is a scalar; reinstatement and multiple revocations have undefined semantics.**
The document describes revocation but not reinstatement. If a user is revoked, reinstated, then
revoked again, there are two `revoked_at` events. Is `revoked_at` a single overwritten timestamp
or a history? A token issued between the two revocations (with `generatedAt` falling between them)
may or may not be valid depending on implementation. The race condition between reinstatement and
a bridge that is still applying the previous `revoked_at` is also unaddressed.

**[MEDIUM] Self-grant TTL expiry sets user-level `revoked_at`, disrupting personal memberships.**
When an admin's self-grant expires, "the standard `revoked_at` revocation mechanism fires."
`revoked_at` is per-user and invalidates all grants tokens for that user. If the admin also holds
legitimate personal memberships in resources, those sessions are disrupted by the self-grant
expiry. The design needs either per-grant or per-resource revocation scope, or an explicit
statement that admins holding personal memberships must accept periodic session disruption as a
consequence of self-grant use.

**[MEDIUM] Grant expiry for inactive users is not covered by the revocation propagation path.**
When a `category_grant` expires, the `revoked_at` mechanism fires. But push events and poll
responses are only received by bridges that are currently active. If a user has no active session
at expiry time, no bridge picks up the event. When the user later becomes active, the bridge
performs a fresh token exchange and the controller correctly excludes the expired grant — so the
grant is not honoured on the next new session. However, the gap to document: whether a cached
token (still within its TTL, issued before expiry) that is presented after the expiry fires would
be correctly rejected by the bridge before the bridge has learned of the expiry.

---

## Security model

**[CRITICAL] Symmetric key framing is incompatible with the stated algorithm candidates.**
`security-workflow.md` calls the JWE decryption key "a shared secret provisioned to each bridge
instance at deploy time." `security-threat-model.md` lists RSA-OAEP or ECDH-ES as algorithm
candidates for key wrap. Both are asymmetric: there is no shared secret. With RSA-OAEP, the
bridge generates a key pair; the controller encrypts the CEK with the bridge's public key; only
the bridge's private key can unwrap it. Provisioning is reversed: the bridge generates and the
controller receives, not the other way around. The algorithm selection (listed as unresolved in
the threat model) will determine the key management architecture. The current framing assumes a
symmetric answer and is misleading for either asymmetric candidate.

**[HIGH] Audience isolation may be a naming convention, not a cryptographic guarantee.**
If all bridge instances share a single decryption key, any bridge can decrypt tokens intended for
any other bridge. The `aud` claim check would then be a claim-level assertion rather than a
cryptographic boundary: a compromised bridge can read another service's grants tokens. True
cryptographic audience isolation requires distinct keys per audience (per bridge/app pairing),
with the controller encrypting to the intended recipient's specific key. Whether the design
intends one global key or per-audience keys should be stated explicitly, since the answer changes
the operational complexity and the blast radius of a compromised bridge.

**[HIGH] Adversarial delay within the grace period is distinct from adversarial blocking.**
The fail-secure design responds to blocking of the revocation channel: if events stop arriving,
the bridge enters revocation-uncertain mode after 60 seconds. A more targeted attack delays
(rather than drops) revocation events for a specific user, keeping the bridge's
last-successful-check timestamp just within the grace period indefinitely. The bridge never enters
revocation-uncertain mode; the revoked session is sustained. This is an adversarial delay pattern
and the current design does not address it. Possible mitigations include per-user revocation
confirmation rather than channel-wide liveness checks, or a narrower per-user TTL after a
revocation event is known to be in flight.

**[HIGH] GDPR right to erasure conflicts with the append-only audit log.**
The audit log is INSERT-only by design (application role has no UPDATE or DELETE) and contains
user-identifying fields (`actor_id`, `target_user_id`). GDPR and similar regulations give
individuals the right to erasure of personal data. Mandatory minimum retention periods for audit
logs in health data contexts (PHIPA, HIPAA, GDPR) can conflict with this right. Neither the
conflict nor any resolution is acknowledged. Common approaches: pseudonymization at write time
(store a non-reversible subject identifier rather than the raw user ID, with a separate lookup
table that can be nulled on erasure); or a legal basis argument that audit logs for PHI access
constitute a lawful retention purpose that overrides erasure requests. This should be decided
before the audit schema is finalized.

**[MEDIUM] Controller instance failure produces a thundering-herd reconnection.**
Each controller instance maintains persistent SSE/WebSocket connections to its bridge subscribers.
If an instance goes down, all its connected bridges simultaneously lose their push connections
and attempt to reconnect to surviving instances within the 60-second grace period. Surviving
instances may not be able to absorb the connection spike in time. This is both a denial-of-service
vector (kill one instance, cause 503 on all its bridges) and a capacity planning question (how
many concurrent bridge connections must surviving instances handle in a worst-case failover?).
High-availability design for the controller is listed as not yet designed; this failure mode
should be a named requirement for that design.

**[MEDIUM] Migration tooling DDL access undermines the INSERT-only audit constraint.**
Schema migrations require elevated database privileges (ALTER TABLE, DROP COLUMN). If migration
tooling runs with credentials that include the audit table, the INSERT-only constraint is
vacuously satisfied at the application layer while being bypassed at the migration layer. The
security boundary between migration-time database access and runtime application access should
be described: separate database roles, separate credential paths, and a policy for what migration
scripts are permitted to do with the audit table.

---

## Permissions and roles

**[MEDIUM] Steward scope: one category vs. one or more — inconsistent across documents.**
`permissions-model.md` role table says "Steward: one category across all resources."
`admin-model.md` role table and `concepts.md` both say "one or more data categories."
The cardinality of stewardship scope affects the data model (is `category_steward` a single
foreign key or a join table?), the management UI, and how OCAP delegation is expressed. This is
not phrasing variation; it is an unresolved design choice presented as resolved in different ways
in different documents.

**[MEDIUM] `admin-model.md` header claims to fully specify Steward; the body does not.**
The document overview states: "This document specifies them fully." The Steward role has one row
in the role taxonomy table and no capability list (no "Can/Cannot" section equivalent to the
Admin section). Steward is the role with the most governance sensitivity — OCAP compliance
depends on it — and it is the least specified. The header claim should be removed or qualified,
and the Steward capability specification should be treated as a named gap.

---

## Integration and operations

**[HIGH] GA4GH Passport revocation before Visa expiry has no mechanism.**
When a DAC withdraws approval, the corresponding `ControlledAccessGrants` Visa stops being
issued on re-authentication. The existing `category_grant` record in Usher's policy database
persists until `expires_at`. There is no described mechanism for Usher to detect externally-revoked
Visas proactively. For controlled health data where an access withdrawal must take effect
promptly, a Visa expiry window (potentially days) may not satisfy governance requirements.
Options to consider: periodic re-validation of Visa-sourced grants on token exchange; a webhook
from the Visa Issuer on revocation; or an explicit operator-triggered revocation via the
management API when informed of a DAC withdrawal.

**[MEDIUM] No "revoke user everywhere" API surface despite it being the primary emergency operation.**
`security-workflow.md` describes "single user" as the standard revocation scope. `admin-model.md`
describes a global `GET /admin/users` endpoint as explicitly not implemented; lookup is scoped
to resources. An admin performing emergency revocation for a user who is a member of many
resources (or whose resource memberships are unknown) must iterate across all resources to find
and revoke each one. The most critical emergency operation has no direct API path. A
`POST /admin/users/{id}/revoke` endpoint that sets `revoked_at` regardless of resource membership
should be considered as a v1 requirement.

**[MEDIUM] Trusted-issuers governance for GA4GH Passports is not described.**
Adding a new Visa Issuer (a new collaborating DAC) requires updating Keycloak's
trusted-issuers list. A malicious or compromised issuer could grant controlled access to all
data on the platform. The governance workflow for this operation — who approves it, what audit
record it creates, whether it requires two-admin sign-off — is not described anywhere. For a
platform managing PHI, this is a high-impact administrative action and should be treated with the
same care as a global admin grant.

**[MEDIUM] Cross-system audit correlation for admin self-grant data access is not addressed.**
`admin-model.md` logs self-grant creation and revocation as discrete audit events. A PHI breach
investigation requires answering: during admin X's self-grant window, what records did they
query? Grant events are in the controller's audit log. Data access events (if logged at all) are
in the PEP plugin's log (Arranger, Lyric). Correlating these across systems requires a shared
identifier — a self-grant ID, or a correlation token — that links the grant audit record to
downstream data access records. Neither the identifier nor the correlation mechanism is described.

**[MEDIUM] Bridge audience identifier provisioning is not described.**
Every bridge instance must know which `aud` value to request from the controller and to verify in
the returned token. Where does a bridge learn its own audience identifier — deploy-time config?
A registration handshake with the controller? If two independently deployed Arranger instances
both use `aud: "arranger"`, they share tokens and revocation events. If audience identifiers are
deployment-specific, the naming convention and provisioning model should be documented as part of
the bridge deployment requirements.

**[LOW] Valkey failure mode is not described.**
`architecture.md` documents Valkey's two roles (shared cache and revocation pub/sub backbone)
but does not describe failure behavior. If Valkey is unavailable: controller instances cannot
coordinate push revocation events; the fast-path cache is inaccessible (falls back to full
policy recompute). Is the system in a degraded-but-safe mode (poll-only revocation, slower
propagation, higher controller load)? Or does Valkey unavailability trigger fail-secure across
all bridges? The failure mode should be a named design choice, not an implicit consequence of
implementation.
