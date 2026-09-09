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

**[RESOLVED] Multiple roles per resource, single `role` field in the token.**
The token carries no `role` field. Roles are resolved to capabilities at issuance, so a union of
roles becomes a union of capabilities computed before the token is written and there is nothing to
collapse. Original finding:
`permissions-model.md` explicitly supports multiple simultaneous roles per user per resource, with
effective permissions as the union of all role capabilities. The token structure has a single scalar
`role` field per resource entry. No rule is specified for collapsing multiple roles into one value
at issuance time. A plugin receiving a collapsed value that does not represent the user's full
capability set will apply incorrect filters. Either the token schema needs to support an array, or
the collapsing rule needs to be defined and its safety argued.

**[MEDIUM] Anonymous token cache key is undefined.**
Downgraded: the anonymous role answers most of it. Every anonymous caller receives exactly that
role's grants, so they are all receiving the same token and one shared token per deployment is
correct rather than one of several options. What stays open is narrower: the invalidation key, which
wants a version or generation on the anonymous role, since a change to it is a policy change with no
`sub` to attach to. Original finding:
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
performs a fresh token exchange and the controller correctly excludes the expired grant, so the
grant is not honoured on the next new session. However, the gap to document: whether a cached
token (still within its TTL, issued before expiry) that is presented after the expiry fires would
be correctly rejected by the bridge before the bridge has learned of the expiry.

---

## Admin access paths

**[HIGH] The plugin-level admin bypass skips the gate the grant-gating decision says nothing skips.**
`admin-model.md` documents a bypass in which a plugin detects the platform-admin role in the IdP
token and applies no filter at all. It creates no grant record, is logged only by the plugin, is
disableable per deployment, and the document already recommends disabling it for health-data
deployments.

The grant-gating decision in `decisions.md` states that a grant passes two stages and that there is
no administrative path that skips the second, only a broader entitlement to enter it. The bypass is
exactly such a path: no grant, no custodian approval, no category evaluated.

Both were written deliberately and the bypass predates the custodian decision, so this is a
reconciliation rather than an error in either. The question is narrow and not an engineering one:
**where a category carries a custodian, may a deployment enable a bypass that reaches that
category's data without the custodian's approval?** For community-governed data the answer looks
like no, which would make the bypass conditional on the categories a resource carries rather than a
single deployment-wide switch.

Until it is answered, `decisions.md` overstates. Recorded there as an exception to be resolved
rather than silently left standing.

## Token contract

**[RESOLVED] If roles resolve at issuance, the token's `role` field should not exist.**
Applied. A resource maps to a plain list of category grants, `role` and any detached capability
list are gone, open content is a category, and there is no empty-list case. An anonymous role
defines the baseline and may grant nothing. Recorded in [decisions.md](decisions.md) and applied in
[security-workflow.md](security-workflow.md). Original analysis:
Roles in the source model do two jobs: they are a compact way to assign many permissions at once,
and they are the first stage of a two-stage check evaluated when access is attempted. This design
moves the second job to issuance time so that plugins hold no policy. That leaves roles doing only
the first job, which is an authoring convenience, and an authoring convenience has no reason to
travel in an enforcement payload.

Where roles then live, none of which is the token:

| Place | Job |
|---|---|
| The management interface | Granting by role rather than by enumerating permissions |
| The grant store | Which role was assigned, for provenance and for recomputing when a role's definition changes |
| Usher's own API authorization | Whether a caller may perform a grant operation at all |

**Ownership drops out of the token for a second and independent reason.** An owner's powers are
management operations: granting, revoking, setting visibility. Those are performed against Usher's
own API, which checks them directly. A plugin never enforces them, so the enforcement payload never
needs to say who is an owner. This is the same conclusion an earlier sketch reached the wrong way
round, by inventing a `manage` flag in the token before asking what would consume it.

**A detached `permissions` property is also wrong, and for a reason that runs deeper than shape.**
It exists only to cover a resource's unrestricted content, which presumes that unrestricted content
is a baseline sitting outside the category system. That presumption is the last trace of the
subtractive model this design replaced, and it is the reason the token has been hard to reason
about.

    Subtractive, superseded:  the resource's full category set is the baseline. The token says
                              which categories are held; the plugin subtracts the rest and excludes
                              them. An empty list leaves the unrestricted remainder visible.

    Additive, current:        nothing is a baseline. The token says which grants are held; the
                              plugin emits one positive clause per grant. An empty list is no
                              grants, so it reaches nothing.

The same field means opposite things under the two, and four sections of `permissions-model.md`
still describe the subtractive one. Anyone reading both carries the contradiction.

**Making open content its own category removes the baseline entirely.** If the unrestricted portion
is a category like any other, there is no remainder for subtraction to leave behind, and every
reachable record is reachable because of a grant that names it. That also expresses tier
differences that the current shape cannot: anonymous callers holding `open: [view]` while registered
ones hold `open: [view, download]`, which is a real distinction between the tiers with nowhere to
live today.

    "STUDY_A": [ { "open":       ["view", "download"] },
                 { "controlled": ["view"] } ]

**And it retires `categories: []`**, which was flagged in review as not sitting right and whose gloss
has been corrected twice. With open content as a category it cannot occur: any access to a
resource means holding
at least one grant on it, and holding none is the same as absence from the map. One state instead of
two that had to be told apart.

**Consequence to accept deliberately: categories stop being optional.** A resource carrying no
categories becomes ungrantable, because there is nothing to name in a grant. Every resource must
carry at least one, which for ordinary data is the open one.

**Vocabulary.** `view` rather than `read`, matching what the portal flows actually distinguish,
viewing metadata against downloading files. The full set still needs settling as a set, which is the
permission-assignment work in the RABAC alignment note.

**Applied**, with the anonymous role as the mechanism that carries the baseline once the detached
capability list is gone.

## Plugin contract

**[RESOLVED] The bridge is said both to render predicates and to hold no schema knowledge.**
The bridge builds the predicate and the plugin supplies the field name for the catalogue being
queried, which is a parameter rather than stored schema knowledge. SQON is the wire format, so
adopters whose enforcement is not SQON-shaped translate. Original finding:
`decisions.md` has the bridge rendering a resolved grant set as a union of positive predicates, and
also states that a leaf operator's field name is structurally required. `architecture.md` assigns any
knowledge of the client application's data schema, field names included, to the plugin and
explicitly excludes it from the bridge. A component with no field names cannot emit a predicate that
requires one.

The per-catalogue resource key sharpens this from a wording problem into a contract question. One
bridge serves an application, an application serves several catalogues, and the resource-key field
differs between them, so the field cannot be resolved once at bridge startup. Either the bridge
emits resource names and the plugin turns them into predicates, or the plugin supplies the field
name per query and the bridge composes with it. The second preserves both statements, since being
told a field name for one query is not holding schema knowledge, but it is a real interface decision
and neither document makes it.

**Recommendation: the plugin supplies the field name, the bridge builds the predicate.**

The deciding reason is where fail-open defects concentrate. Every enforcement defect this design has
recorded is a predicate-construction defect: denial expressed as a negation instead of
`matchNothing`, an empty `in` read as no constraint, a containment expression double-negating into
the wrong quantifier on a flat field, and a filter composing disjunctively on the aggregation path.
Not one of them is a compilation defect. If the bridge emits resource names and each plugin builds
its own predicate, that entire class of defect is reimplemented once per plugin, and drift between
applications is the problem the shared bridge exists to prevent.

Four supporting reasons:

- **It does not breach the constraint it appears to.** Being told a field name for one query is not
  holding schema knowledge. The bridge is never provisioned with a deployment's schema and never has
  to be kept in sync with one, which is what that exclusion protects.
- **It trusts the plugin with strictly less.** The plugin is the enforcement point and must be
  trusted either way, but supplying one field name is a smaller surface than constructing the whole
  predicate. A wrong field name is also checkable at startup, alongside the mapping-shape check
  already required.
- **The conformance corpus tests one implementation instead of one per plugin.** Predicate semantics
  are exactly what a corpus is for, and they stay in a single place to test.
- **Per-catalogue output is already required.** Catalogue-level denial means the answer differs by
  catalogue regardless, so the bridge must produce per-catalogue results either way. Given that, it
  costs nothing for those results to be predicates: the interface takes a map of catalogue to field
  name and returns a map of catalogue to enforcement.

The cost is one additional input on the bridge interface, and a plugin obligation to supply it
correctly.

**Scope: this governs the narrowing arm only.** The enforcement result is already a union of deny,
narrow and allow, and only narrow carries a predicate. Named future plugins do not all narrow:

| Adopter | Operation | Predicate? |
|---|---|---|
| Arranger | Filter a search | Yes, in the query language natively |
| SONG | Filter a metadata listing | In principle, if the predicate stays backend-neutral |
| Score | Authorize one object fetch by identifier | No. Deny or allow only |
| Lectern | Schema and dictionary service, no record filtering | No |

A service whose operation is fetching one object by identifier never narrows, so no predicate is
built under either option and the question does not arise. What such a plugin needs instead is a
membership query in Usher's own vocabulary, "does this principal hold resource R", with the plugin
resolving its identifier to a resource first. That is a third interface shape and the plugin contract
should carry it deliberately rather than treating every adopter as a filtering one.

**What would change this, restated.** Not a backend that cannot narrow, but a backend that narrows in
a way the shared query language cannot express *neutrally*. The MVP predicate is a single positive
containment on a field, which is neutral: it compiles as readily to a relational filter as to a
search-engine one. So the recommendation holds today for every adopter that narrows.

**The post-MVP predicate is not neutral, and this is worth recording on its own.** Record-level
narrowing is expressed as `not` of `not-in`, whose correctness depends on the field being mapped
`nested`, and on a flat field it silently degrades to an existential match in the permissive
direction. That is a search-engine mapping concept, not a property of the query language. The same
expression carried to a plugin over a different store would mean something different, and it would
differ permissively.

Two consequences. Record-level narrowing as currently specified is **specific to the search adopter
rather than a platform capability**, which no document says. And this is an argument *for* central
construction rather than against it: where the meaning of a predicate depends on backend properties,
that reasoning belongs in one component that can vary or refuse on a declared capability, not
replicated across plugins whose authors each decide independently what the expression means.

Must be settled before the plugin contract is written, which has not started.

## Security model

**[RESOLVED] Symmetric key framing is incompatible with the stated algorithm candidates.**
Keys are per-application and asymmetric; the controller holds each application's public key and
never a shared secret. Recorded in [decisions.md](decisions.md) and corrected in
[security-workflow.md](security-workflow.md). Algorithm selection remains open. Original finding:
`security-workflow.md` calls the JWE decryption key "a shared secret provisioned to each bridge
instance at deploy time." `security-threat-model.md` lists RSA-OAEP or ECDH-ES as algorithm
candidates for key wrap. Both are asymmetric: there is no shared secret. With RSA-OAEP, the
bridge generates a key pair; the controller encrypts the CEK with the bridge's public key; only
the bridge's private key can unwrap it. Provisioning is reversed: the bridge generates and the
controller receives, not the other way around. The algorithm selection (listed as unresolved in
the threat model) will determine the key management architecture. The current framing assumes a
symmetric answer and is misleading for either asymmetric candidate.

**[RESOLVED] Audience isolation may be a naming convention, not a cryptographic guarantee.**
Per-application keys make `aud` a cryptographic boundary rather than a claim-level assertion.
Original finding:
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

**[INFO] Overlapping cohort semantics are moot where records cannot overlap, and open otherwise.**
A deployment whose data model gives each record exactly one resource makes overlap structurally
impossible, so neither OR nor AND semantics produces a different result there. That holds for the
first integration; the per-deployment confirmation is recorded on that side. The question stays
open for deployments where a record can satisfy the membership predicates of more than one resource
at once. Do not close this item until such a deployment requires a concrete decision.

**[MEDIUM] Custodian scope: one category vs. one or more, inconsistent across documents.**
`permissions-model.md` role table says "Custodian: one category across all resources."
`admin-model.md` role table and `concepts.md` both say "one or more data categories."
The cardinality of custodianship scope affects the data model (is `category_custodian` a single
foreign key or a join table?), the management UI, and how OCAP delegation is expressed. This is
not phrasing variation; it is an unresolved design choice presented as resolved in different ways
in different documents.

**A second axis, surfaced by the rename pass: resource scope.** The same role is described both as
spanning every resource and as bounded to a subset. `permissions-model.md` and `admin-model.md` say
"across all resources"; `security-threat-model.md` says a custodian "can only act on grants for
their assigned category within their authorized resources"; `audit-events.md` records the role as
assigned "for a category within a resource". The two readings differ in blast radius: authority that
follows a category wherever it appears, against that category granted on named resources. This
question and the cardinality one above together decide whether `category_custodian` is one column,
one join table, or two.

**[MEDIUM] `admin-model.md` header claims to fully specify Custodian; the body does not.**
The document overview states: "This document specifies them fully." The Custodian role has one row
in the role taxonomy table and no capability list (no "Can/Cannot" section equivalent to the
Admin section). Custodian is the role with the most governance sensitivity, and OCAP compliance
depends on it, yet it is the least specified. The header claim should be removed or qualified,
and the Custodian capability specification should be treated as a named gap.

---

## Ownership and custodianship

**[HIGH] Self-grant prevention is not specified in the permissions model.**
**Still open, and the grant-gating decision makes it sharper rather than answering it.** An
administrator may self-grant, with the custodians of the data's categories as the final gate. An
administrator who may appoint custodians can appoint themselves and then satisfy that gate, so the
rule below and the gating decision have to be reconciled: either appointment is constrained, or
approval must reject an approver who is also the grantee, or both. The audit event on appointment is
the minimum and is not by itself a control.

The threat model (A01, insider threat note) states that a custodian cannot issue a grant to
themselves. This rule is not specified in `permissions-model.md` or `admin-model.md`. Without an
explicit check at the PAP layer, a custodian could approve their own category access, bypassing the
intended governance separation. The check must be specified before the grant approval endpoint is
implemented: the approving custodian's identity must be compared against the grantee identity, and
self-approval must be rejected. The audit log alone (detecting after the fact) is not a sufficient
control.

**[MEDIUM] Resource visibility suppression and embargo share implementation concerns.**
The ownership invariant breach state (resource hidden due to no owner) and the embargo mechanism
(resource hidden until a scheduled date) both suppress resource visibility without changing user
grants. They are distinct governance reasons for the same technical effect. The implementation
must not conflate them: a resource in the orphan-hidden state should not be treated as embargoed,
and lifting the embargo should not restore a resource that is still ownerless. Whether these share
a single `visibility` state field with typed reasons, or are separate flags, needs a deliberate
decision before the data model is finalized.

**[MEDIUM] Guardian-to-subject ownership transfer on age of majority is not designed.**
When data is submitted for a minor subject, the legal guardian holds ownership over that
resource. When the subject reaches the age of majority, their right to govern their own data
supersedes the guardian's authority. No flow exists for transferring ownership in this case.

Several design questions are open:

- **Trigger:** Is the transfer initiated by the guardian, by the now-adult subject, or by a
  platform admin acting on a legal notification? A time-based automatic trigger requires Usher
  to know the subject's date of birth, which it probably should not store.
- **Subject identity:** At submission time the subject has no Usher presence. When they reach
  adulthood and want to claim their data, they must establish an IdP identity and link it to the
  correct resource. The linkage mechanism is not designed.
- **Guardian refusal:** If the guardian does not initiate a transfer and the subject is now of
  age, what recourse does the subject have? This is a legal question, but the platform must have
  an admin-mediated path to honour a valid legal claim.
- **Jurisdiction:** Age of majority varies by jurisdiction. The platform must either take a
  conservative stance (lowest applicable age) or make this a deployment configuration.
- **OCAP intersection:** If the subject is a First Nations member, community data sovereignty
  interests (held by the nation, not the individual) may coexist with the individual's newly
  acquired personal data rights. These do not automatically resolve in the same direction.

This flow shares the same ownership transfer mechanism as ordinary ownership handoffs but has
unique trigger and identity-establishment steps. It should be designed before Usher handles
any paediatric dataset.

**[MEDIUM] Clinical submission service to Usher relationship is not designed.**
The category management section of `permissions-model.md` describes cohort-level category
assignment defaults applied at submission time, but does not specify how the submission service
(Lyric) communicates cohort existence and category assignments to Usher. Two approaches: (1)
pre-registration, where an admin creates the resource in Usher before any data is submitted and
submission is rejected for unregistered cohorts; (2) submission-time creation, where Lyric creates
the Usher resource as part of the ingest flow. Both have different trust and privilege implications
for the Lyric service account. The preferred approach for MVP is pre-registration; submission-time
creation is an optional post-MVP path sharing the same code foundation. Neither is designed in
detail. This must be resolved before the Lyric integration work begins.

## Integration and operations

**[MEDIUM] Audit log noise from vulnerability scanners and automated probes needs a tagging mechanism.**
Automated vulnerability scanners and pentesting tools will hammer Usher's auth endpoints with
probing requests, flooding the audit log with failed-auth events that are not genuine incidents.
Without a mitigation, real anomalies are buried in scanner noise, defeating the monitoring
purpose of the log.

The correct approach is tag-and-route, not suppression. Suppressing scanner traffic entirely
undermines OWASP A09 and creates an exploitable blind spot: an attacker added to the ignorelist
hides all their activity. The design should:

- Maintain a configurable source list (IP ranges, API key prefixes, user agent patterns) marking
  known scanner or pentesting traffic.
- Tag matching requests in the log record (e.g. `source_type: "scanner"`) rather than dropping
  them.
- Route tagged events to a separate log stream or lower severity tier so they do not trigger
  real-time alerts.
- Treat the source list itself as a policy change: additions and removals must be logged as
  auditable events and require admin authorization.

This was identified from a real incident: a WordPress application's firewall began generating
high-volume automated probes that spammed its security monitoring with false positives. Building
log-noise management in from the start avoids retrofitting it later.

Must be decided before the audit logging implementation begins: the tagging field and routing
logic affect the event schema and the log aggregation pipeline configuration.

**[POST-V1] GA4GH Passport revocation before Visa expiry has no mechanism.**
GA4GH Passport integration is not required for iMS v1, which the business requirements state
directly, so this is not a launch dependency. Kept because it is a real gap in that design and the
severity was misleading in a blocker sweep. Original finding:
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

**[POST-V1] Trusted-issuers governance for GA4GH Passports is not described.**
Same scope as the Visa revocation item above. Original finding:
Adding a new Visa Issuer (a new collaborating DAC) requires updating Keycloak's
trusted-issuers list. A malicious or compromised issuer could grant controlled access to all
data on the platform. The governance workflow for this operation (who approves it, what audit
record it creates, whether it requires two-admin sign-off) is not described anywhere. For a
platform managing PHI, this is a high-impact administrative action and should be treated with the
same care as a global admin grant.

**[MEDIUM] Cross-system audit correlation for admin self-grant data access is not addressed.**
`admin-model.md` logs self-grant creation and revocation as discrete audit events. A PHI breach
investigation requires answering: during admin X's self-grant window, what records did they
query? Grant events are in the controller's audit log. Data access events (if logged at all) are
in the PEP plugin's log (Arranger, Lyric). Correlating these across systems requires a shared
identifier (a self-grant ID, or a correlation token) that links the grant audit record to
downstream data access records. Neither the identifier nor the correlation mechanism is described.

**[RESOLVED] Bridge audience identifier provisioning is not described.**
Per-application asymmetric keys settle both halves. Provisioning happens at registration, since
onboarding an application is a public-key registration rather than a secret distribution. And two
independently deployed instances cannot share an audience identifier, because sharing one would mean
sharing a key and audience separation is cryptographic rather than a string comparison. What follows
is a naming requirement rather than an open question: an audience identifier is per deployed
instance. Original finding:
Every bridge instance must know which `aud` value to request from the controller and to verify in
the returned token. Where does a bridge learn its own audience identifier: deploy-time config?
A registration handshake with the controller? If two independently deployed Arranger instances
both use `aud: "arranger"`, they share tokens and revocation events. If audience identifiers are
deployment-specific, the naming convention and provisioning model should be documented as part of
the bridge deployment requirements.

**[LOW] Valkey failure mode is not described.**
`architecture.md` documents Valkey's two roles (shared cache and revocation pub/sub backbone)
but does not describe failure behaviour. If Valkey is unavailable: controller instances cannot
coordinate push revocation events; the fast-path cache is inaccessible (falls back to full
policy recompute). Is the system in a degraded-but-safe mode (poll-only revocation, slower
propagation, higher controller load)? Or does Valkey unavailability trigger fail-secure across
all bridges? The failure mode should be a named design choice, not an implicit consequence of
implementation.
