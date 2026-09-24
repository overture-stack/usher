# Usher Roadmap

Planned work across design, implementation, integration, and infrastructure. Items are open unless
marked `[in progress]`. Completed items are removed; `.dev/sessions/` is the historical record.

---

## Design (pre-implementation)

These must be completed or sufficiently resolved before the relevant implementation phase begins.

### System context diagram

Architectural diagram showing Usher's connections to Overture services and infrastructure (portal-ui, Keycloak, Lyric, Arranger, PEP adapters). Prerequisite for the portal-ui API contract and design review sessions. See `.dev/design/architecture.md`.

### Admin model: open questions

Four items gate the admin API: self-grant compensating controls, self-grant peer revocability, the break-glass procedure, and where an adapter learns that a principal is an administrator (Usher's own role, adapter-side config, or the platform access model, and whether an administrator of an ushered application is the same principal as an administrator of Usher). The last one also gates the bypass audit requirement, since a bypass cannot be logged as such until its source is defined. Lower-priority follow-ups (step-up auth, audit schema, multi-tenancy) can trail v1. See [admin model open questions](docs/atlas/roadmap/admin-model-open-questions.md).

**Self-grant is confirmed as a real path, and its approval requirement is scheduled to change.** It
needs no approval in MVP and will need one once community custodianship is implemented. Build it as
an authority check carrying an exception rather than as a bare write, so the later change removes a
branch instead of introducing an approval workflow. Whose approval is not settled: the owner is the
natural authority over the resource, while the trigger is custodianship, which points at the
custodian. Treating a self-grant
as an ordinary grant subject to the resource's and the category's authorities admits both without
choosing now. See the admin-authority decision in [design/decisions.md](design/decisions.md).

### Complete permissions model

Seven open items before the core service can be implemented: role permission definitions, field-level restriction approach, overlapping cohort access, user groups design, custodian scoping, custodian notification, and category change propagation UI. See [permissions model gaps](docs/atlas/roadmap/permissions-model-gaps.md) and `.dev/design/permissions-model.md`.

Role permission definitions is now reshaped rather than open-ended: see the RABAC alignment item below, which turns it into defining the capability vocabulary and which permissions each role carries. Note also that this list and `permissions-model.md` § Open questions disagree, and that neither is complete; write versus read access appears only in the design document despite gating the database schema. Reconciling the two is itself outstanding.

### Align the permissions model with RABAC

The role and attribute hybrid is a named pattern, RABAC, which evaluates access in two stages: a role check for whether a permission is held at all, then attribute filtering for which objects it reaches. Usher built the second stage as category grants and never defined the first, so the token carries a role label with no permission set behind it and no verbs anywhere in the model. The correction is to resolve roles to permissions at issuance and carry the permission set in the token. This closes the create/read/update/delete gap, the contradiction between a single `role` field and a union of roles, and the `public` synthetic-role exception in one change. See [RABAC alignment](docs/atlas/roadmap/rabac-alignment.md).

**Partly ungated.** The identity-provider half of the build-versus-adopt question is closed: Keycloak is not the replacement and Usher is not built inside it, so nothing here would be rewritten by an adopt-the-IdP answer. What remains open is whether an engine takes the evaluation step inside a standalone Usher, which changes how permissions are computed and not what they mean.

### Re-evaluate build versus adopt

The recorded case for building rests partly on a false premise: Cerbos was rejected for producing binary allow/deny decisions, but its query planner performs partial evaluation and returns a three-way discriminated result carrying a condition AST, which is the mechanism this design independently arrived at. Keycloak Authorization Services was never evaluated at all and is already deployed, covering the hybrid pattern, a management UI, and structured grants in a token. "Return what this principal can access" is now a standard permission across several open-source engines rather than a differentiator.

What survives as genuinely ours, pending assessment: delegated governance (a custodian with platform-wide authority over one category and no other admin rights), IdP independence, push revocation with fail-secure suspension, and a non-ORM enforcement path against Elasticsearch through SQON. Corrected evaluation and the wider landscape are in `.dev/design/decisions.md` § Tools reviewed before building.

**Step one is closed by decision rather than by evaluation.** Keycloak is not the replacement and Usher is not built inside it, on provider independence: the policy model cannot live in the one component the architecture refuses to be tied to. The two questions that were never tested, whether Keycloak Authorization Services can emit a residual filter and whether delegated non-administrative governance is expressible in it, are accepted as untested, because neither answer would have changed the reason. See the Keycloak decision in [design/decisions.md](design/decisions.md).

Two steps remain: spike the Cerbos query plan plus a thin grants and custodian layer against one real Arranger query, then restate the build rationale in terms of what is left over. An engine for the evaluation step is compatible with a standalone Usher, so this no longer blocks the RABAC alignment work or the database schema the way an adopt-the-identity-provider answer would have.

### Restructure the docs against the onboarding artifact's order

Reviewing the onboarding artifact with non-technical readers produced fifteen defect classes, sorting under resolvability, fidelity, presentation, and content addressed to the wrong reader, none of which the existing mechanical checks can express: density, affirmative framing and the dash rules had all been run over that same text and caught none of them. Two outputs: a convention proposal for agentics, and a restructuring pass here. See [documentation review patterns](docs/atlas/roadmap/doc-review-patterns.md), which is appended to as review continues.

The order the artifact establishes, arrived at by a reader rather than an author: what the system is and the question it answers, the problem, the two questions and which software answers each, the access tiers as the organizing idea, the mechanism and the shape of the decision it carries, the decisions with their reasoning, what it is not, status, then vocabulary last as reference rather than prerequisite.

`docs/concepts.md` deviates most: it opens with theory and reaches the access tiers sixth, asking a reader to hold abstractions before anything attaches to them. `docs/intro.md` is problem-first but never presents the tiers as the organizing idea. Both restructures wait until review of the artifact settles, since the order is still being tested.

A second review round, run as three independent reading passes, is written up in [onboarding audit](docs/atlas/roadmap/onboarding-audit.md). Five line-level items remain, plus two whole-document single-word sweeps: `instance`, which carries the design's meaning and ordinary English's in the same text, and `application`, 60 uses where the settled word is `ushered application`.

**Acceptance is on hold rather than missing.** The glossary says a permission counts only while its grant is accepted, and nothing in the body introduces the idea, so a reader meets the word once in a definition. Closing it means a section on the recipient's answer being its own record, which is held until the reader-facing side of the model is worth another pass. The token's payload version is a deliberate omission on the same grounds: negotiation costs a non-technical reader more than the accuracy returns.

### Reconcile the role model across the corpus

Three independent reading passes over every markdown file found the two planes conflated at scale: nine passages actively teaching that a control-plane role reaches data, one of them the published `docs/concepts.md` reader's first walkthrough of an access decision, plus ten definitional sites, a plane inversion repeated at three places, four capability and role lists left incomplete by this session's decisions, three stale claims that a token carries a role name, and no `Viewer` glossary entry for the role every other entry is defined against. Ranked with a verified site for each in [role model sweep](docs/atlas/roadmap/role-model-sweep.md).

**Two role vocabularies are live, and the disagreement has inverted since this was written.** The
2026-07-13 rename dropped `curator`, and `rabac-alignment.md` was the lone document that never
received it. The model work of September then built on `curator` throughout: `decisions.md`,
`permissions-model.md` and `token-calculation.md` all turn on it, because the case that settles
grant-carries-the-role is one person being a curator on one category and a viewer on another. So the
dropped term is now the majority usage in the newest documents while `terminology-usage.md` still
lists it retired.

**Decide the vocabulary before sweeping.** Either September reversed the July rename and
`terminology-usage.md` is stale, or September reintroduced a retired term across three documents.
Sweeping first standardizes on whichever vocabulary the sweeper happens to hold.

**Partly applied.** The corpus pass of 2026-09-19 closed three of the nine tier-1 sites and every
stale claim that a token carries a role name, and re-anchored the survey on quoted content after its
line numbers stopped pointing at anything. The remainder is marked open in place.

### GA4GH Passport integration: three gaps

**Not required for iMS v1**, which the business requirements state directly, so this is post-v1 work rather than a launch dependency.

The Clearinghouse design is sound and the `ControlledAccessGrants` mapping is clean, with a Visa's dataset scope matching the resource granularity MVP enforces and its `expires` feeding the existing revocation path. Three gaps remain.

**Only one of four Visa types is mapped, and the other three have obvious homes.** `AcceptedTermsAndPolicies` is what the Registered tier already requires. `ResearcherStatus` is the usual gate for registered-access datasets in GA4GH instances. `AffiliationAndRole` maps onto resource roles and bears on the write-versus-read decision, since submission access is gated on organizational affiliation.

**The signature-validation component is unconfirmed.** `docs/concepts.md` places Visa validation at the identity provider. A search found no maintained Keycloak extension providing it, and the reference work in this space (CINECA) pairs Keycloak with Rego policy code to interpret Passports instead. Confirm the component exists before scheduling Passport work: if it does not, the Clearinghouse design has a hole where its validation belongs. Not exhaustively established, so treat as unconfirmed rather than absent.

**Passport interpretation satisfies the OPA revisit condition, and the two records do not reference each other.** `decisions.md` § OPA as the decision engine says OPA becomes a better fit given "conditional policy logic that cannot be expressed as grant records". Evaluating signed claims from multiple issuers against a trusted-issuer list is exactly that, and is unlike the grant-record lookup that argument rejected OPA for. This is the one layer where a policy engine has a clear case.

Revocation before Visa expiry and trusted-issuer governance are already tracked in `.dev/design/to-discuss.md` at HIGH and MEDIUM.

### API keys stay opaque, and their scope field becomes Usher's

Programmatic access runs on API keys from a Keycloak plugin the team maintains, with Score as the main consumer. **Decided: keys stay opaque strings, checked at the exchange rather than self-verifying.** A signed credential with a multi-year expiry sits outside both halves of Usher's revocation guarantee, the five-minute token life and the push channel, and withdrawing one early needs the issuer-side state that self-verification removes. An opaque key revokes as a row. The check lands in the exchange path at session-start frequency rather than per request, which is the rate that makes it affordable.

**The scope field already exists and already carries EGO-style policy scopes**, so two systems encode access decisions today. It is redefined to carry Usher scope, intersected at the exchange rather than validated at issue, which makes the reduce-only property structural and keeps the dependency one-directional. `DENY` is refused rather than ignored, because under intersection a negative is inert and an inert restriction is a widening relative to what someone intended. The format waits on the capability vocabulary, since the parser's suffix must be a level and EGO's READ and WRITE cannot express view without download.

Introspection needs Usher's first credential to Keycloak, a basic-auth one able to check anybody's key, since the endpoint requires a bearer token's subject to own the key it checks. The format must be settled before the first key is issued in it, because an unparseable scope makes the whole key unreadable rather than one entry unrecognized. See [API keys](docs/atlas/roadmap/api-keys.md).

### Move ownership from a single owner to a set

The business requirements call for several owners of one resource at once, with equal rights to restrict, share and revoke, naming the real case: a principal investigator holds legal authority while submitters do the work, so all of them need it. `permissions-model.md` instead requires exactly one owner per resource and builds the ownership cascade, last-owner promotion and transfer-before-removal on that singularity.

**Decided in the requirements' favour.** The change is from exactly-one to a non-empty set, which the requirements already state from the other side as at least one owner per dataset.

What changes: the cascade seeds a set rather than resolving to one owner; the no-owner invariant becomes non-empty-set, blocking removal of the last owner rather than any; last-owner promotion loses its purpose, since the invariant now prevents the case it repaired. The transfer-with-consent flag survives, with one sub-decision left open, whether adding an owner counts as a transfer for consent purposes, since removal plausibly does and addition plausibly does not. See `.dev/docs/brd-traceability.md`.

### Decisions from the UAC user flows: what remains

All four are answered; see
[docs/uac-flows-traceability.md](docs/uac-flows-traceability.md). Virtual-cohort sharing is out of
MVP, the flows' "Data Admin" is a system administrator rather than one who administers access to data, and the submitter-to-owner
correlation is instance policy rather than an Usher rule. The resource is the study, and "dataset"
is a looser label used at several levels beneath it.

**Still open: may a system administrator grant data access as an override?** Role assignment,
deciding who owns or has custody of what, is clearly the system administrator's. Granting a consumer
access to a dataset is clearly the data-plane roles'. Whether the second is ever reachable as an
override is unanswered, and the flows say no while this design currently allows it.

**Decouple the ownership cascade from Usher.** The cascade in `design/permissions-model.md` reads as
Usher behaviour and should read as an instance-supplied policy with a default. The mechanism does
not change; who decides does.

### Notification mechanism

Recorded previously as absent from the design with nothing addressing it. The flows put email on the
critical path in four places: sharing with an existing user, sharing with an unregistered address,
declining an invitation, and the registration invitation. Revocation and owner-removal notices are
nice-to-have in both documents. A design omitting notification does not deliver these flows, so this
moves from unaddressed to specified-but-undesigned.

### Authorization for long-running operations

Submission is the only enforcement path that runs long enough for a credential to expire
underneath it, and the system being replaced solved that by lengthening a platform-wide token to
three hours. That trade is closed by decision; what replaces it needs designing.

Open, and none of it is settled: where re-authorization happens on the upload path, whether per part
or per session; whether an upload session is a first-class object that can be revoked while in
flight; how that composes with whatever short-lived delegation the transfer service issues for the
bytes themselves; and which adapter owns it, since submission spans both halves of the environmental
service. Related to the download enforcement item above, which shares the file API and not
the duration problem.

### Enforcement on the download path

The flows put constraint-token validation on every file request and block direct URL access at the
API layer, independently of the search path. Two enforcement paths rather than one. Ownership of
this was previously open; it now needs designing rather than deciding.

### Conformance case per endpoint that returns data

**Replaces the aggregation-path requirement violation, which is settled.** The defect required an
authorization field at nesting depth two or greater; the settled filter is a single positive
containment clause on a flat, depth-one field, so the triggering condition cannot arise. With one clause there is also no sibling composition, which makes the `should` versus
`must` question moot rather than answered. Two conditions keep it that way, and both are already
required elsewhere: the adapter establishes the field's mapping shape at startup and refuses to
enforce where it cannot, and record-level narrowing stays post-MVP, since a per-record category
field is exactly what would put an authorization field deep enough to trigger it.

**What is not settled by that, and needs building.** An endpoint that returns data can discard the
filter entirely, which no mapping depth affects and no configuration reveals. An application found
exactly that: an aggregation wrapper returning whole-index counts while the record path was
correct, caught by comparing counts rather than by reading code. So the corpus needs a case per
endpoint that returns data, comparing what an under-privileged principal sees against a
fully-privileged one, not only assertions that records are filtered. Specified in
`design/permissions-model.md`; this is the entry it previously lacked.

### Reconcile design docs after the resource-level decision

**Closed by the pass of 2026-09-19, and its findings list is superseded.** That list was written
against resource-level enforcement, which has since been reversed, so it points at the wrong target
in several places; [doc reconciliation](docs/atlas/roadmap/doc-reconciliation.md) is marked as such
and kept for how it located contradictions rather than for what it concluded. The later pass swept
the same ground against the current model: the grant-carries-the-role change, the retired
resource-membership relation, the superseded asymmetric key model, the grant lifecycle states, and
the per-principal revocation timestamp.

One item from it was never a documentation fix and stays open: the `deny` arm of the bridge's
`Enforcement` result cannot be expressed at the first application's integration point, whose hook is
a synchronous total function returning a query node. Needs a decision, not an edit.

### Artifact provenance must be checked on every write, once artifacts can be written twice

**A precondition on the sets feature, not a live gap.** The search application's saved sets are
immutable today: creation is the only write path, so the provenance check that refuses a set drawn
from an unconfigured resource runs on every version of a set that exists. Confirmed on that side after
this roadmap had briefly recorded the opposite.

The reasoning survives the correction. That check runs at the only moment both a set's sources and the
configured list are in hand, so the moment a set can be added to, a set created clean and later
extended from an unconfigured resource never meets it again. The full sets feature is the work that
introduces that second write path.

**Kept here rather than as a defect, deliberately.** A gap recorded as live gets checked, found
absent, and dropped, and the constraint goes with it. Attached to the feature that would introduce
it, it is waiting at the only moment anyone could reintroduce the problem. See the artifact entity in
[design/permissions-model.md](design/permissions-model.md).

### Enforcement gaps from the first adapter integration

Eleven items surfaced by preparing the first adapter integration, none of them waiting on adapter work. Two were fail-open defects and are now resolved in the design, recorded under "The two permissive failures are closed" in [decisions.md](design/decisions.md). They were: an unconfigured resource value fails closed on records but **open** on derived artifacts, because it is absent from the complement the ceiling clause is built from; and an unauthenticated request currently renders to no filter at all, which is the allow-everything case rather than a restrictive default. Also covers widening the enforcement seam to distinguish no-relationship from lapsed-grant, and the mapping-format and administrator-source decisions. See [Arranger integration blockers](docs/atlas/roadmap/arranger-integration-blockers.md).

### Saved-set identity and its grants vocabulary

Usher must publish the vocabulary expressing own-sets-by-default, an administrator listing across users, and no reliance on an unguessable set identifier. Recorded as a cycle deliberately: the integration lists this as a prerequisite for Usher while its central fix depends on Usher, and Usher publishing the vocabulary first is what breaks it. Bounded by the derived-artifact constraint, so per-principal set scoping cannot be an end-to-end property on its own. See [Arranger integration blockers](docs/atlas/roadmap/arranger-integration-blockers.md).

### Federation posture

Whether an instance holding grants should federate at all, given that a remote cannot be compelled to enforce and a remote that ignores a forwarded filter is indistinguishable from one that applied it and matched everything. Needs a decision rather than more description.

### Rework permissions model for resource-level MVP

Four sections of `.dev/design/permissions-model.md` describe record-level enforcement, which is now post-MVP: the visibility rule, its worked example, composition across categories, and category-to-field mapping. All four are marked in place. MVP enforces at resource level, one positive clause on the resource field, so the rework is to separate the MVP mechanism from the deferred one rather than to replace anything. Decisions recorded in `.dev/design/decisions.md`.

### Embargo needs a design, and the one on record was withdrawn

The mechanism previously in `permissions-model.md` mapped embargo to a grant on a `private` category
with `expires_at`, releasing the data when that grant expired. It could not have worked: a submitter
loses their view when the grant ends and nobody gains one, and
the deadline sat on a principal's grant rather than on the embargo state. Withdrawn in place, with
four requirements recorded where the mechanism was: embargo is a state rather than a grant, it
reaches below the resource with several segments carrying separate deadlines, the segment must be
computable by the enforcing adapter since no record says it is embargoed, and access within an
embargoed segment differs by principal.

**What this does not block.** Category grant expiry is settled and available: see
[decisions.md](design/decisions.md) § A grant's expiry is resolved before the token is written. A
instance needing time-bounded access has it today. What expiry cannot do is release data, because
it only ever subtracts.

### The token calculation, and the schema that should follow it

The calculation the controller performs to produce a token is stale in three ways and is the
prerequisite for the associative tables rather than the other way round. Written up with nineteen
cases, the rules settled, and the four still open, in
[token-calculation.md](design/token-calculation.md).

Four questions block it. Whether a role's ceiling is global to the principal or held per resource.
Whether a group's grants may span resources, which today they may, with nobody named as controlling
group membership. What acceptance is for, since a group grant bypasses it. And what RABAC defines for
assignment, which matters because the ceiling and grant structure is taken from it deliberately.

### Terminology: six open overloads, and DCAT as the outside check

`catalogue` and `dataset` are resolved. Six words remain, tracked with counts and verdicts under
"Open overloads" in [terminology usage rules](docs/atlas/roadmap/terminology-usage.md): `payload`,
`artifact`, `ceiling`, `corpus`, `plane`, `scope`, ordered by damage rather than by count. `payload`
leads because it names the central object the system produces and the corpus disagrees with itself
about whether the compound means the token or a field in it.

`ceiling` joined the list when a reader asked what "the ceiling clause" meant: 32 uses across nine
files, reaching published `docs/concepts.md`, and defined nowhere. It is the cheapest of the six,
needing a definition rather than a rename, but the definition waits on whether a role's ceiling is
global to the principal or held per resource.

`dataset` went to a register rule rather than a rename: design documents say `resource`,
reader-facing prose keeps `dataset`, and the glossary entry carries the mapping. **What that pass
did not cover is `docs/`**, where `concepts.md`, `intro.md` and `README.md` use the word about a
dozen times and sit between the two registers.

DCAT now governs any word it defines, per [decisions.md](design/decisions.md). One mapping is open
and belongs to Arranger: whether an Arranger catalogue is a Dataset, a Distribution or a DataService.

### Record-level narrowing on a field an instance already supplies (post-MVP)

Renamed from "record-level category tagging". "Tagging" named the mechanism as an act of writing
labels onto records, which this design does not do: enforcement filters on fields the data already
carries, and only on descriptive ones. See the descriptive-versus-prescriptive rule under "Usher is
data-agnostic" in [decisions.md](design/decisions.md). The old name survives in several documents
and should go with the terminology pass, which now has somewhere to record its rules: see
[terminology usage rules](docs/atlas/roadmap/terminology-usage.md).

**This item is narrowing by category specifically, not record granularity in general.** The
distinction was blurred and is worth holding: this item needs each record to carry category labels,
compared against the labels a principal holds. That needs a per-record category field mapped
`nested`, and neither iMS catalogue has one. The clinical index's `file_access` is prescriptive,
holds one value across every record and is unexercised; the environmental catalogue has no
equivalent. Since data is not modified to suit enforcement, this form stays unavailable there.

**Narrowing within a resource by predicate is available now and is not this item.** A filter over
descriptive fields the records already carry narrows at record granularity with positive clauses on
flat keywords, on both catalogues, with no mapping change. Granularity finer than a study can come
from a narrower resource field or from a predicate-scoped grant, neither of which waits on this. The
two differ in whether fields can be combined: a resource field is one existing single-valued field, so
a key composed of two of them is not expressible, while a predicate carries as many clauses as it
needs. Combining fields therefore belongs to the grant's predicate, never to the key.

Narrowing within a resource, the same permission as SQON-scoped grants. Two constraints already established: subset containment is expressible in one clause as `not` of `not-in`, verified by executing the compiler rather than reading it, and it requires the field to be mapped `nested`, degrading silently to an existential match on a flat field. Usher cannot require a mapping shape, so this is available only where an instance supplies conforming data, verified at adapter startup. See [SQON-scoped grants](docs/atlas/roadmap/sqon-scoped-grants.md).

One design item to settle when this is picked up: the shape of the resource predicate. Additive rendering has no implicit baseline for records carrying no category, so a role must render to a positive predicate of its own rather than being the default that exclusions carve into. Not needed for MVP, where the resource-field clause covers it.

The same startup-verification rule extends to mapping depth, not just mapping type: where an authorization field sits at depth two or deeper, an adapter's filtered-aggregation path does not apply and filtering falls back to a disjunctive one, which for an authorization predicate is OR where AND was intended. An adapter must establish the field's mapping shape at startup and refuse to enforce where it cannot, so a non-conforming instance is one where this narrowing is unavailable rather than one where it silently degrades.

### Define resource derivation for migration

`architecture.md`'s migration table maps each EGO study group to an Usher resource one to one. That holds only where a resource corresponds to an entity with its own creation operation. Where an instance's resources instead correspond to a registered vocabulary or to an attribute of some other entity, there is no creation operation to map and the step needs its own definition.

Two rules for that step. Derive resources from the registered vocabulary, never by enumerating distinct values found in data: where an instance has both, the accumulated set drifts from the curated one, including near-duplicate spellings of the same identifier, and enumerating splits one resource in two so that a grant on either silently misses the other's records. And reconcile before creating, since the failure is fail-closed and therefore presents as missing data rather than as an error.

Per-instance specifics belong in that integration's own repository, not here.

### Cohort registration and Lyric integration

MVP uses pre-registration: cohorts exist in Usher before data is submitted. Three design items gate Lyric integration. See [cohort registration and Lyric integration](docs/atlas/roadmap/cohort-registration-lyric.md).

### Deployment runbook has no home, and three procedures now want one

Three sequences are recorded in design documents and nowhere an operator reads, which means each is a responsibility with no owner. They are not related to each other beyond that, and the absence of a destination is what they have in common.

- **Break-glass access.** If every platform administrator is unavailable, recovery is an IdP operation. Who is authorized to perform it, and what audit trail the IdP layer is expected to produce, is undocumented. See [admin-model.md](design/admin-model.md).
- **Establishing a category.** Define the category, appoint whoever governs it, and only then accept data carrying it. The decision to treat a custodian vacancy as a governance failure rather than a system state depends on this sequence being followed. See [decisions.md](design/decisions.md) § Granting is one function.
- **Adding a category to a live instance.** Configure the mapping in the ushered application first, then define the category in the controller. The reverse order serves the affected records to everyone until the application catches up. See [adapter-integration.md](design/adapter-integration.md) § Category dictionary introspection.

A design document that says an operator must do something, without a document the operator reads, has moved the responsibility rather than discharged it.

### Category dictionary introspection

Adapter configuration maps each category to a predicate over its own schema's fields, and the list of categories lives in Usher. Nothing connects the two today, so every instance transcribes the dictionary into each adapter's configuration by hand and keeps it in step by remembering to. The proposal is an introspection endpoint on the controller returning the dictionary, reachable only by a bridge and encrypted to that application's key the way an Usher token is, so configuration is generated rather than copied.

It carries names only, since what a category selects is defined per schema and Usher never learns it, so it does not weaken data-agnosticism. Beyond removing the duplication it lets an adapter check its configuration against the full list at startup and refuse to start on an unmapped category, moving a failure that currently presents as quietly missing data to instance time. It is also the compensating control for computing `open` as the complement of known categories: a category the adapter has no mapping for is not in the set being subtracted, so records carrying it are served as open rather than hidden. Post-MVP, arriving with record-level narrowing, since resource-level enforcement puts no category in the filter and needs no mapping. See [adapter-integration.md](design/adapter-integration.md) § Category dictionary introspection.

### Adapter integration design

API contract, request/response shapes, and error codes for token exchange, revocation poll, and push subscription. Also: JWE key distribution and payload schema versioning. See `.dev/design/adapter-integration.md`.

### How an adapter maps resources to an application's data

Being worked out with the first integration, to be documented here so other adapters can follow it.
Usher stays agnostic of how data is structured, so the mapping is the adapter's. One case it has to
answer: a study whose records sit in two catalogues under different access.

### Database schema design

Physical schema for the permissions model entities: column types, indexes, foreign key constraints, and migration strategy. The engine is decided (PostgreSQL); the logical entity list is drafted in `.dev/design/permissions-model.md`, with four of its twelve tables marked placeholders and no entity at all for custodian scoping.

Correctly blocked rather than behind: the write-versus-read decision determines whether submission writes grant rows or only registers a resource, the RABAC alignment turns permissions into entities, and an adopt decision would replace most of these tables outright.

**The data access layer is a separate decision that currently exists nowhere.** No ORM or query builder is chosen, and the only mention in the corpus is the threat model requiring parameterized statements or an ORM that binds parameters, which constrains the choice without making it. Decide it on its own merits, and note that authorization-filtering Usher's own admin queries (a custodian seeing only the grants they govern) is the same residual-filter problem the enforcement layer solves, so the PAP may want the same machinery as the PEP.

### JWE algorithm selection

**Settled.** `dir` with A256GCM, symmetric, one key per controller-and-application pair, held in Vault and injected by the secrets operator. Per application is what makes `aud` a cryptographic boundary rather than a claim. See the JWE decision in [decisions.md](design/decisions.md).

### Deployment architecture

High-availability design for stateless Usher instances sharing a policy database as source of truth. Container strategy, health check endpoints, replica configuration.

### Keycloak realm configuration via Terraform operator

Keycloak Terraform operator under evaluation in overture-dev. If adopted, Usher can ship a module provisioning the `usher-platform-admin` role, the Lyric service account, and realm config. Track outcome; update the instance architecture doc.

### Usher ↔ portal-ui API contract

Portal-facing API covering user-visible flows (access request, token exchange, denied-access states) in addition to the shared bridge protocol. Depends on the system context diagram; draft before portal-ui begins implementation against a mock.

### Researcher experience design

Three UX decisions gate researcher-facing documentation: access request workflow, denied access presentation, and category grant expiry/renewal. See [researcher experience design](docs/atlas/roadmap/researcher-experience.md).

### Resource identifier collision at creation

Nothing in the design prevents a second resource claiming an identifier an existing one already uses, and the identifier is not a label: it is the field value records carry, so it is the enforcement key. Two resources over one identifier are two governance surfaces over one body of records, and whoever holds the second can grant access to data governed by the first. It runs the other way too: a submitter reaching an existing identifier has their data land inside someone else's resource, under governance they cannot see. So collision is a write-side injection path as well as a read-side problem, and silently extending the existing resource is the most dangerous handling rather than the friendliest.

**Refusing the duplicate is itself a disclosure**, and the design already forbids it in principle: "Denying an oracle means every channel that distinguishes the two cases has to be closed." A uniqueness error distinguishes them precisely, at an endpoint nobody checked.

The answer differs by creation path, which the corpus currently treats as one. An administrator creating through the management UI already holds the account list, every grant and the audit log, so telling them a resource exists discloses nothing they lack. A submission-path creation runs under a service account acting for a person who holds none of that, and the error reaches that person.

Three things to settle: whether submission-path creation becomes a request whose response is identical regardless of outcome, so the channel closes by making the cases indistinguishable; who resolves a collision, which has to be someone who can see both resources rather than the submitter or the system; and whether identifier uniqueness is scoped to the instance or to the catalogue, since two catalogues each holding a `HEART_STUDY` produce the same collision through configuration rather than through creation. Arranger cannot help with the last one: it has no concept of a resource, so it cannot see, report or refuse two catalogues whose records carry the same value.

**Separate the constraint from the handling when taking these.** Whether a duplicate errors, queues or offers an extension is the handling. Whether a duplicate can exist at all is a uniqueness constraint on the identifier, and a schema shipped without one permits the split-brain rather than merely failing to handle it.

### Just-in-time access, as a frame for what the admin self-grant already does

The admin self-grant is zero standing privilege under another name: no standing access, a mandatory time limit, a logged event, recorded at `concepts.md`. The pattern matters because the people who will audit this platform already know it, and because standing grants answer "who held access to this data, when, and why" badly.

Three gaps against the full pattern, each real rather than terminological. A request approved by someone else, where ours is self-service; the approval requirement is already scheduled to change. Expiry mandatory on the sensitive path, where `expires_at` exists everywhere and is required only for the self-grant. And zero standing privilege as a stated principle, which holds for administrators and for nobody else, since a curator's grant stands until revoked.

One item points the other way and should be weighed as a departure rather than a feature: the post-MVP option letting an organization switch on administrator reads without a grant.

### Structured logging: settled, with two items owed

The platform envelope is decided and applied to [audit-events.md](design/audit-events.md): CloudEvents `specversion` `"1.0"`; `time` required here though optional in the spec; `type` as `bio.overture.<entity>.<act>` with the organization prefix and no service segment; `dataschema` left optional; one `source` per logical producer rather than per replica, with instance attribution in `data`; `actorId` carrying the `sub` claim and never a client-supplied `userId`; `actorType` with `human`, `serviceAccount`, `anonymous` and `system`.

**The shared package is deliberately not built.** The JSON Schema is the cheaper artifact and does the load-bearing work, so a package would have to be argued for on its own merits rather than arriving attached to a naming decision. Worth knowing the platform is converging on TypeScript if that case is ever made: Maestro is 219 TS files with no Java, Lyric 258, and Arranger, Lectern, Stage and Usher are already there, leaving SONG at 309 Java files and Score at 267, both slated to migrate, with Ego retiring. Any such package is envelope construction and validation only, no transport, sinks, formatting or correlation-id propagation, and takes configuration as typed parameters rather than reading the environment.

**Two items are owed rather than deferred, and the envelope is incomplete without the first.** A `source` convention, because `source` plus `id` is the key deduplication depends on and nothing is agreed about the attribute's shape. And a shared entity vocabulary, which only the flat type form requires: two services meaning different things by one entity produce two occurrences under one name and a consumer joins them, with no registry and no owner to prevent it. Neither belongs to Usher alone.

**One field set still needs reconciling before it is built.** Arranger's per-request event carries `catalogId`, `queryType`, `sqonSize`, `hitsReturned` and `durationMs`, with `userId` absent now and populated when auth lands. Those are `data` contents and nothing conflicts, but `userId` there is a client-supplied GraphQL argument on `saveSet` persisted as a set's owner, while `actorId` is server-derived from the token. Same-looking names, opposite trust properties, and the mistake a shared name invites is reading a client-asserted value as an audit identity.

---

## Implementation: Core service

### Technology stack

TypeScript confirmed; HTTP framework decided (Fastify, with an explicit framework-agnostic application layer constraint). See [technology stack decisions](docs/atlas/roadmap/technology-stack.md).

### IdP integration

OIDC token validation: discovery endpoint consumption, public key caching and rotation, strict `aud`/`iss`/`exp`/scope claim validation. Fail-secure on IdP unavailability.

### Permissions computation engine

Resolve current permissions from the policy database and compute the `PermissionsPayload`. Supports the fast-path refresh, whose two tests are the controller's own: the principal's cached payload still being present, and the category versions recorded with it still matching the resources' current ones.

### JWE token issuance

Encrypt the permissions payload with the selected algorithms; embed `generatedAt` and `exp`. Usher must refuse to start if the decryption key is unconfigured.

### Revocation system

Revocation notice naming the principal; push channel (SSE or WebSocket); poll endpoint (`GET /revocations?since=<timestamp>`); scopes: single user, resource-wide, global.

### Audit logging

Structured JSON (Pino) for every access decision and revocation event. Dual-channel: policy database (queryable source of truth) and log stream (real-time alerting, SIEM). No token payloads, health record identifiers, or bearer tokens in output.

Two parts of this are design prerequisites rather than implementation, and their cost grows by waiting: the event shape must exist before any enforcement path emits, with the principal field present and null where there is no authenticated principal, or populating it later becomes a schema migration; and the principal identifier is a cross-system correlation key rather than a local choice, so it must match whatever an adapter emits. Denial and administrator-bypass events both need a defined destination. See `.dev/design/audit-events.md`, which carries the catalogue but neither of these.

### Policy database

Schema implementation and migration tooling. Integrity controls: transactions, foreign key constraints, audit triggers for policy changes.

---

## Implementation: Integration

### `@overture-stack/usher-express-bridge`

Shared library embedded in all applications: token exchange, local validation, TTL caching, revocation channel (push + poll fallback), revocation-uncertain mode (503 after grace period). Lives in `modules/express-bridge` in this repository, created when implementation begins, and is published from here for adapters to import.

### `@overture-stack/arranger-usher-adapter`

Express middleware for `arranger-graphql-router`. Translates permissions payload into server-side SQON filters. First integration target. Arranger-specific design in `arranger/.dev/docs/arranger-auth/usher-adapter.md`.

### Additional per-app adapters

The Lyric adapter and others, each translating the permissions payload into the app's native query format.

---

## Implementation: Management UI

Design not yet started; see `.dev/design/management-ui.md`. High-level scope: resource, role, and category management; assigning roles and grants; emergency revocation; audit log viewer.

---

## Testing

### Load and latency testing

Usher sits on the hot path of every authenticated request. Response latency on the token
exchange endpoint, the revocation poll endpoint, and the SSE connection handshake must be
validated under load as part of the standard test suite, not as a one-off exercise.

Include a load/performance test suite alongside the unit and integration tests. `autocannon`
is the natural choice for a Fastify service (Fastify itself uses it for benchmarks); `k6` is
the alternative if the team wants a more expressive scripting model or cross-service scenarios.

The test must cover at minimum: token exchange throughput under concurrent load, SSE connection
count at the expected bridge-per-instance ceiling, and latency distribution (p50/p95/p99) on
the critical path. Define acceptable thresholds before implementation so regressions are caught
rather than discovered in integration testing.

---

## Documentation

### Docs-tier gaps (blocked on prior design)

- Researcher journey guide: blocked on access request workflow design
- Denied access UX documentation: blocked on denied access UX decision
- Category grant expiry and renewal guide: blocked on expiry notification design
- Usher token payload schema: unblocked. `PermissionsPayload` is written as a type in
  `security-workflow.md`, and the docs-tier version is a reader-facing rendering of it

### Integration guide

Consumer-facing companion to `adapter-integration.md` for adapter developers. Blocked on `adapter-integration.md` being completed.

### Administration guide

Consumer-facing companion to `admin-model.md` and `management-ui.md`; must cover data tier classification. Blocked on admin model open questions and management UI design.

---

## Future scope

### DACO-style access approval workflows

Ethics-review-gated access with time-limited validity and renewal. The `expires_at` field on category grants anticipates this; the approval workflow is not yet designed.

### Multi-tenancy

Single instance serving multiple independent organizations with full policy isolation. Not in initial scope; architecture must not preclude it.

### Additional IdP connectors

Beyond Keycloak and Microsoft Entra ID: other OIDC providers, SAML-based IdPs.

### Globus integration

Globus Auth as an OIDC identity source; Globus Groups as a potential source for group users. Integration scope TBD: IdP connector only, or deeper Globus data access and transfer integration.

### SQON-scoped grants

Optional `sqon` field on `grants` narrowing which records within a category a grant covers, enabling community-specific access and filtered-subset sharing. See [SQON-scoped grants](docs/atlas/roadmap/sqon-scoped-grants.md).

### Security event streaming (Kafka)

Upgrade path from Valkey Streams for durable, replayable event fan-out to external consumers (SIEM, compliance, alerting). Not needed for v1; no architectural changes required to add it later.

### A surveyor who views a bounded number of records

`view` without `count` or `export`, held per grant between a minimum and a maximum number of records
per query, so a researcher sees what the data looks like without its size or its bulk and has a
reason to request access. Post-MVP: the first integration cannot limit one category within a
response, and a grant written before the limits are enforced serves a full viewer. See [bounded
surveyor](docs/atlas/roadmap/bounded-surveyor.md).

---

## Research on ideas and possible scenarios

Ideas worked through far enough to record what is known, and not identified as needed. Future scope,
above, is work identified as needed at some point.

### A principal who counts and does not view

Theoretical: the model permits `count` without `view` and nothing yet needs it. What such a
principal gets, what any rule for it has to survive, and a set of rules recommended and not adopted,
in [count-only principal](docs/atlas/roadmap/count-only-principal.md).
