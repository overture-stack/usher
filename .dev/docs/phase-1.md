# Phase 1: Design blockers and implementation gate

**Phase 1 began:** Aug 18.
**Goal:** close the open questions that block implementation, and confirm the Nov 15 consumability date

---

## What "consumable by Nov 15" requires

**Two milestones are in play and this document scopes the first.** Usher's own is phase 1, called
the MVP internally and phase 1 wherever anyone outside this team will read it. iMicroSeq's is **the
deliverable**, which phase 1 feeds into and which is larger: it adds submission, and at least a
minimum management surface so data administrators can create resources and categories. Those land
in phases after this one. Nothing below is scoped to the deliverable.

Four pieces must be working together for the iMS UAC integration phase to start on time:

1. Keycloak issuing a token the controller can validate (no usher code in the portal itself)
2. The Arranger adapter running in Arranger's search-server, with the bridge as an in-process library (Usher token cache, revocation polling, Usher API call)
3. The Arranger adapter injecting per-resource SQON filters at query time, derived from the grants the bridge fetches from Usher
4. Enforcement composed at a boundary every Arranger read path inherits (hits, aggregations, saved sets and download), verified by a shared test asserting a denied principal sees nothing on each of them

**Migrating the portal off EGO is not among them.** Phase 1 runs on `overture-dev`, which has no
EGO at all, so the move belongs to a later phase.

Working backwards: two weeks of integration buffer means implementation must be functionally
complete by Nov 1.

**Resourcing:** Usher and its integration pieces (the bridge, the Arranger adapter) are implemented
by the developer and AI agents working from a complete spec and a thorough test suite. Code
review support may be requested from the wider softeng team, but implementation ownership is
here. Given this model, implementation velocity is high once the spec settles, so the open design
work is the critical constraint rather than implementation duration.

---

## The first integration target is Stage, and this document's flows are not Stage's

**Stage first, in overture-dev, with the learnings carried to iMS afterwards.** The iMS UAC user
flows define the behaviour Usher must support and they describe portal-ui, so the flows are the
requirement and Stage is where it gets proven. Those are different lists, and reading the build order
below as though it delivered the flows is the mistake this paragraph exists to prevent.

**What it reorders.** Notification, the "Shared with Me" surface and the sharing interface are all
portal-ui's and arrive with iMS, so none of them is on the Stage-first path. What is on it is the
enforcement chain end to end, plus a way for grants to exist with no management interface, which the
build order answers by mocking them.

**Why Stage rather than the portal that has the flows.** Stage already runs a server side in
overture-dev: three API routes, a server-side token exchange, and an httpOnly cookie encrypted with a
server-only secret. A bridge sits inside a trust boundary that exists. Portal-ui is the same framework
and simply not configured for one, so the setup carries across rather than being invented twice, which
is the reason the order pays twice rather than once.

## The build order, and why it runs backwards

Settled plan. The controller is built last and the consumer side first, against a mock.

    0. Configure Keycloak, so that a person can sign in.
    1. A barebones controller with mocked grants. The Usher backend is faked.
    2. The Arranger adapter and the bridge, built against it.
    3. Compare results in the portal: signed in against anonymous, rows and counts.
    4. The profile surface and the rest of the Keycloak integration.
    5. The real controller, tying it together.
    6. Management UI, and the submission bridge and adapter, in parallel.

**Step 2 is where the contract gets defined**, by the thing that consumes it rather than by
specifying it in advance. How a filter is actually applied, what the adapter needs and when, and which
blindspots the design has are all discovered by building the path instead of reviewing it. The real
controller then has a proven contract to implement rather than a proposed one.

**Step 3 is the acceptance test for enforcement.** Signed in against anonymous over the same query is
the smallest thing that proves the whole chain, and it fails visibly rather than silently.

**It has to compare counts as well as rows.** Aggregate counts are half the enforcement surface and
the half where existence leaks, because a count discloses without returning a record anyone can point
at. It is also where the search layer has a known defect: two mechanisms disagree on AND against OR
and one is dead at depth 2, which a multi-category filter reaches and a flat resource filter does not.
Comparing rows only passes the chain while leaving the leak path untested.

**And against the first deployment's data it tests the resource clause only.** Neither catalogue
carries a field distinguishing categories, so signed in and anonymous differ solely in which
resources they hold, and per-category enforcement would reach production having never run. One
synthetic catalogue carrying a category field, used for nothing else, closes that. overture-dev is a
playground, so this is cheap.

Four things this order asks of the mock, and each is a way it could quietly fail to prove anything.

**Seed it from the case table rather than from what the adapter asks for.** `token-calculation.md`
holds twenty-nine cases with expected outputs, and the count moves as the model does, so read it
there rather than trusting a number written here. A mock grown to answer whatever the adapter needs lets
the adapter define the contract by its own appetite, and every case nobody happened to exercise ships
unproven. Driven the other way the mock is the specification, and step 5 becomes a matter of matching
known answers.

**It must not be accommodating.** It should hold a fixed, hand-written set of grants and refuse
anything outside them, because the real controller may not be able to answer a question the mock
obliged.

**It must issue real tokens.** The token is a JWE and the bridge exists to decrypt it. A mock handing
over a plain object skips the component step 2 is meant to exercise.

**Stop it, at step 2, while that is free.** The bridge's most distinctive behaviour is raising when
the controller is unreachable past the grace period, and with a mock the test is to turn the mock
off. Left to step 5 this arrives as a large unexercised body of fail-secure behaviour, which is the
worst kind to meet late.

**Whether the mock outlives step 5 decides whether any of this survives.** A throwaway harness loses
the contract knowledge the moment the real controller lands. Wired to the conformance corpus, whose
approved location is below, it becomes what keeps the real controller honest afterwards: the same
cases run against the mock during steps 2 to 4 and against the real thing from step 5 on, and a
divergence is a defect rather than a surprise.

## Blockers, in the order they can be worked

**Numbers are identities, not positions.** They are cited from `adapter-integration.md` and from
several session records, so they stay fixed and the sections below stay in numeric order.

| Do    | #   | Item                 | Waits on | Why it sits here                                                                                                          |
| ----- | --- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| now   | 6   | Database schema      | nothing  | Every decision that fed it has landed. The largest single piece of design work left, and it gates all core implementation |
| after | 4   | Adapter API contract | 6        | Implementation rather than design: turning intent into typed shapes. Needed for Nov 15, not before implementation starts  |

**Five are closed and kept below for the reasoning rather than as work.** Item 1 is live as a finding
rather than a task, since neither catalogue carries an access-level field. Item 2 resolved to Fastify.
Item 3 settled the payload, the JWE algorithm and payload versioning. Item 5 closed by scope, because
nothing creates a resource at submission time in the first release. Item 7 resolved by reading the
deployment's own Helm values. Item 8 is closed by replacement: there is no per-principal timestamp,
and the fast path now invalidates by resource.

**What changed about the critical path.** Item 8 was the heaviest judgement call and the thing item 6
waited on. With it closed, item 6 is no longer waiting on anything, which means the schema session is
the only design work between here and implementation.

### 1. Maestro/indexing question (highest risk; longest lead time)

**Status:** LIVE, and the reading that closed it is what makes it live. The enforcement clause now
names a category field alongside the resource field, so the nesting-depth and
per-submission-versus-per-record questions apply from the first release rather than after it.

**Both of the first instance's catalogues have been read directly and neither carries an
access-level field at all.** That is the answer rather than a deferral, and one consequence follows: with no field distinguishing categories, the category clause
has nothing to test, and the emitted filter is the resource clause alone. Per-category
enforcement is correct in the model and inert in this deployment until the data carries a marking for
it to read.

What then stands between that and a community-governed record reaching a reader who holds no grant on
the community's resource is a single unenforced property: that the resource field carries one value
per record. Where it does, no record belongs to two resources and the case cannot arise. Where it
silently does not, the resource clause matches existentially and the record is returned. Nothing
detects the difference, which is why that property is recorded as a deployment precondition rather
than a caveat.

**What it gated:** the entire the Arranger adapter design.

Does the per-submission access level survive onto every indexed document, under what field name,
at what nesting depth, and does it attach per submission or per record? If the access level is a
property of a submission-shaped parent and the indexed unit is a child record, SQON filter
injection on that field does not produce correct per-document access control. The adapter design
is invalid in that case and needs a different approach.

**Finding, from a direct read of Lyric's data model:** no access_level or visibility field exists
anywhere in Lyric's data model. The only field present on every indexed document that relates to
submission provenance is `organization`.

**Revised framing:** `organization` is a submission-level concern (Lyric's own
metadata about who submitted), not a property of the data being submitted. Access control for
the Arranger adapter should operate on fields within the submitted data records themselves,
not on Lyric's submission metadata. The boundary between "submission" and "data being submitted"
is the responsibility of a Lyric adapter for Usher, not the bridge.

This reopens the blocker in a different form: what access-relevant fields exist within the
indexed data records, and how does Usher's grant model map to SQON filters on those fields?

**Findings, from a direct read of Lyric's code:**

1. **Lyric understands SQON, but not at submission time.** A working SQON parser and SQL-query
   builder (`@overture-stack/sqon-builder`, `convertSqonToQuery.ts`) exists and is used in two
   read-time places: `POST /category/:id/organization/:org/query` and an internal foreign-key
   existence check in `validationService.ts`. Nothing on the submit/validate/commit path. A
   the Lyric adapter would require a new hook on the submission path calling the existing
   SQON-to-SQL machinery. That wiring is new integration work, but the machinery it calls
   already exists.

2. **Indexed documents contain the submitted data fields, not just Lyric metadata.** Donor
   documents include `bmi`, `vital_status`, `primary_site`, etc.; correlation documents include
   `cancer_type`, `hugo_symbol_a/b`, `pearsoncorr`. `cancer_type` is a real example of a
   study-defined categorical field already flowing through and indexed today.

3. **Critical caveat: `dynamic: false`.** Only fields explicitly declared in a repository's ES
   index template (`index-templates/*.yaml`) are queryable. An unmapped field lands in `_source`
   but is invisible to any SQON filter.

   **Important distinction:** a field absent from the mapping is
   not necessarily a bug. It may be a deliberate privacy choice: kept out of the index so it
   is never searchable or exposed through Arranger. Do not assume either way without confirming
   intent. Furthermore, field exclusion from the mapping is the wrong shape for ABAC: it is
   binary and global (the field is either indexed for every document or none), not per-principal
   or per-document. It cannot express "user A sees records where tier=open, user B sees
   tier=open and tier=registered." That row-level, per-principal control is exactly what
   SQON filter injection provides. Field exclusion and SQON filtering are complementary levers
   at different granularities, not substitutes for each other.

**Design implication for the Arranger adapter:** the access-control axis field must be IN the
mapping (so it is SQON-filterable), but being in the mapping does not gate access: the injected
SQON filter is what does the gating. Without the filter a user sees all rows; with it, only the
rows matching their grants. This means the field needs to be intentionally included in the
mapping, and that decision is the instance team's to make consciously, not a bug-fix shape of
change.

**Design implication for the Lyric adapter:** submission-time gating is separate, not required for
Nov 15. The building blocks exist (SQON machinery), but wiring to the submission path is new
work. Track as a post-Nov-15 item.

**SQON is a shared Overture language, not an Arranger dialect.** Lyric consumes SQON as well,
so a SQON-shaped grant is portable across the read path (Arranger) and the submission path
(Lyric) without translation. Arranger owns the module; it does not own the language.

**Planning assumption:** Lyric converges on the same SQON library that Arranger's
`graphql-router` consumes, namely `@overture-stack/sqon` (the `modules/sqon` workspace in the
Arranger repo). Every finding below is stated against that assumption. Findings measured
against Lyric's current pin, `@overture-stack/sqon-builder@^1.1.0`, are superseded; they are kept in the list with the reason, since the difference between the
two is where the safety-relevant change lives.

- **`fieldName` is the property-name key on both sides.** Not a coincidence between Lyric's
  `sqon-builder` pin and Arranger v3 naming: under a shared module it holds automatically. No property-name translation layer is needed between Usher's
  grants-to-filter output and either consumer.

- **Superseded: the operator-subset constraint.** The earlier finding held that any
  grants-to-filter translation targeting both systems had to stay inside Lyric's intersection
  of `in`, `gt`, `lt`, `and`, `or`, `not`. A shared module removes the intersection.
  `@overture-stack/sqon` defines `and`, `or`, `not`, `in`, `all`, `gt`, `gte`, `lt`, `lte`,
  `between`, `wildcard`, and `filter`. Confirmed in `modules/sqon/src/operators/constants.ts`
  and `src/schema/index.ts`. Access control still needs only `in` and the combination
  operators, so nothing in the grant model depends on the wider set; the constraint simply
  stops being a constraint.

- **Superseded, and this is the one that matters: empty combinations are no longer
  fail-secure.** The earlier finding held that Lyric rejects an empty `and`/`or` with
  `BadRequest`, so a user holding no grants produces a rejected query rather than an
  open-access one. That protection is a property of the `sqon-builder` plus drizzle path and
  does not survive the change of library. In `@overture-stack/sqon`, an empty and-combination is a
  valid,
  intentional, first-class value:

  `SqonCombinationSchema` declares `content: zod.array(SqonSchema)` with no `.min(1)`, while
  every leaf schema constrains its own content (`fieldName: min(1)`, `value: min(1)` or
  `.length(2)`, `fieldNames: min(1)`). So `{ op: 'and', content: [] }` validates.
  `SqonBuilder.empty()` produces exactly that value, and three tests assert it:
  `modules/sqon/src/builder/index.test.ts:9`, `:482`, and `:514`. Reduction converges on it,
  since removing the last remaining filter yields the empty combination and inner empties are
  pruned into the parent.

  This is correct behaviour for a search library, where "no filter" legitimately means
  "everything." It is exactly wrong as the encoding of "no grants" in an authorization context,
  where an empty and-combination compiles to match-all.

  **Design constraint that follows:** no Usher component may rely on SQON schema validation to
  reject a zero-grant filter. The guard has to be explicit and must sit in Usher's own code,
  before a filter is handed to any SQON builder or serializer. A zero-grant principal must
  short-circuit to a denial, never to a filter that happens to be empty. This is a stronger
  requirement than the previous entry implied, because it now has to be built rather than
  inherited. It also strengthens the case for locating shared SQON handling in the bridge: the
  guard gets written once for every application rather than once per adapter.

  **Consequence for the conformance corpus:** the zero-grant section cannot merely assert
  `visible: false` for a principal with no grants. It needs a case whose failure mode is
  match-all, that is, a zero-grant principal evaluated against a non-empty record set, so a
  regression to an empty combination is caught rather than passing silently.

- **SQL injection in Lyric's SQON handler is now an open PR.** Lyric PR 219 (open since
  2026-08-20) parameterizes `fieldName` and value through drizzle's SQL template instead of
  splicing them into `sql.raw()`. Must land before any the Lyric adapter integration work. The PR
  notes a second gap it deliberately leaves open: `fieldName` still has no allowlist against
  the dictionary's real field names. That is directly relevant to Usher, because a
  permission-derived filter supplies `fieldName` values into the same path; parameterization makes
  it safe from injection but does not make it a validated field reference.

- **Dependency risk to record, not a blocker.** `@overture-stack/sqon` is at `0.0.0-dev` with
  no stable release, published under an `rc` dist-tag. If both enforcement points depend on it
  before Nov 15, Usher's filter correctness rests on an unreleased module. Worth an explicit
  decision on pinning strategy rather than discovering it during integration.

**RESOLVED. The blocker's premise was wrong, and resource fields are not Usher's to
know.**

The question this blocker opened with, whether a per-submission access level survives onto every
indexed document, does not need an answer. Under resource-level enforcement there is no access level
on the document: enforcement filters on the field naming the resource a record belongs to, and the
access decision is made in Usher against that resource's categories. The nesting-depth and
per-submission-versus-per-record sub-questions dissolve with it.

What replaces the question is a per-integration one, and it lands outside this repository by design:
each catalogue supplies a resource field name as adapter config, and Usher never learns it. An
adapter must establish that the candidate field is single-valued, that its cardinality is verified
against a declaration rather than inferred from an Elasticsearch mapping (which cannot express it),
that its values were observed rather than read off a display label, and that the term is not
overloaded elsewhere in that instance. Those four checks are recorded in
[`adapter-integration.md`](../design/adapter-integration.md).

For the first integration these are settled and documented on that side, in the integration
repository's own `.dev/docs/usher-integration.md`: two catalogues fed by different submission
services, using different fields for the same role, at matching granularity. The instance detail
stays there because none of it constrains Usher's design, and stating it here would make a
instance's configuration read as a platform rule.

One general finding is worth keeping on this side: **migration must derive resources from a
registered vocabulary rather than by enumerating values found in data.** Where an instance has both,
the accumulated set drifts from the curated one, including near-duplicate spellings of the same
identifier. Enumerating splits one resource in two, and a grant on either silently misses the
other's records. That fails closed, so it presents as missing data rather than as a disclosure,
which makes it harder to notice.

The `dynamic: false` and SQON-operator constraints recorded above remain accurate and become
relevant again for post-MVP record-level narrowing. They were marked resolved separately before this
blocker was superseded as a whole; the status above covers both.

---

### 2. HTTP framework

**Status:** RESOLVED. Fastify.

See [`technology-stack.md`](atlas/roadmap/technology-stack.md) for the full decision rationale
and the architectural constraint that accompanies it: Fastify owns HTTP concerns only; all
application logic is framework-independent and must be unit-testable without starting the server.

---

### 3. Permissions payload schema and JWE algorithm

**What it gates:** the bridge, the Arranger adapter, and any future adapter. The bridge decrypts
the token; the adapter reads its fields. Neither can be implemented without a stable schema.

Core shape is clear: resource grants (resource ID, categories), open-tier grants (anonymous
access), `generatedAt` and `exp`. Open sub-questions:

- ~~Schema versioning mechanism~~ **settled: negotiated at the exchange, never tolerated at read
  time. See the payload-versioning decision in [decisions.md](../design/decisions.md).**
- ~~JWE algorithm~~ **settled: `dir` with A256GCM, symmetric, one key per
  controller-and-application pair, held in Vault and injected by the secrets operator. Per
  application is what makes `aud` a cryptographic boundary rather than a claim. See the JWE decision
  in [decisions.md](../design/decisions.md).**

**Encryption is confirmed, and the reason changed.** The original rationale for JWE assumed the
user held and forwarded the Usher token; that is false under the current architecture, where the
bridge is a library inside the ushered service and fetches the token from the controller itself.
Encryption is retained on a different and stronger basis: audience scoping becomes cryptographic,
so a payload issued for the wrong application fails to decrypt instead of leaking. The algorithm is
`dir` with A256GCM and the key is symmetric, one per controller-and-application pair, so
per-application scoping costs one secret written once and injected into two pods. Recorded in
[`decisions.md`](../design/decisions.md) under the JWE decision. Nothing remains open here but
rotation.

**Field-level restrictions are out of scope for MVP.** Row-level access control via SQON
filter injection is sufficient. The `fields.exclude` shape in nested grants is a post-MVP item;
stub the field as absent or empty object in the v1 schema to leave the door open.

**Design note (post-MVP, for reference):** field exclusion can be applied by the adapter after
the ES response arrives and before surfacing to the client, giving per-row field control in a
single ES round trip. This would require a response transformer hook in the adapter API contract
in addition to the query modifier, which becomes a blocker 4 concern at that point.

**RESOLVED, and simplified by the resource-level decision.** Under resource-level
enforcement there are no per-record category predicates, so the emitted filter is a single positive
clause on the resource field and the additive-versus-subtractive question is moot for MVP. It governs
the post-MVP record-level case, where the single-clause encoding is `not` of `not-in` (verified by
executing the compiler) and requires a `nested` mapping. Both recorded in
[`decisions.md`](../design/decisions.md).

The adapter
renders a resolved grant set as a union of positive predicates, one branch per grant held, rather
than computing exclusions by subtracting held categories from a locally configured category set.
The decision depends on failure direction: in a subtractive model, losing a term widens access; in
an additive model, losing a term narrows it.

| Failure                                                   | Subtractive                          | Additive                      |
| --------------------------------------------------------- | ------------------------------------ | ----------------------------- |
| Category exists in Usher, unmapped in the adapter         | No exclusion generated, records leak | Contributes no branch, denies |
| Data carries a tag value not yet registered as a category | Nothing excludes it, visible         | Matches no predicate, hidden  |
| A bug drops a clause from the composed filter             | Access widens                        | Access narrows                |
| A field mapping points at the wrong field                 | Fails open                           | Fails open                    |
| Principal holds zero grants                               | Denies                               | Denies                        |

Term loss is a demonstrated property of `@overture-stack/sqon` rather than a speculative risk
(empty combinations validate as match-all, `reduce.ts` prunes empty inner combinations,
`removeFilter` converges on an empty), which is what makes failure direction the deciding
criterion. Full rationale, including the audit-locality and pipeline-inversion arguments, in
[`decisions.md`](../design/decisions.md).

Three things follow for the payload:

- **The token carries held grants only.** Moving a resource's full configured category set into
  the token was considered, to make subtractive rendering fail closed on config drift. Additive
  rendering does not need it.
- **A role in a resource becomes an explicit positive grant.** There is no implicit baseline for untagged
  records any more, so a role must render to a predicate of its own. The exact shape is open
  and is tracked in `roadmap.md`.
- **Zero grants never becomes a filter.** The bridge returns the `Enforcement` discriminated
  result; see the zero-grant decision in `decisions.md`.

The earlier exploration of a two-part grants-and-restrictions payload (from the "open data except
indigenous, plus closed data for projects A and B" example) is **withdrawn**. That case is already
satisfied by the existing category model: the record carries `indigenous_data`, the principal holds
no grant for it, so no branch covers it. No restrictions field and no partition requirement on
categories. The worked example at `permissions-model.md` is that exact scenario.

**Action:** none remaining.

**Status:** CLOSED. Payload shape, rendering direction, the JWE algorithm and payload versioning are
all resolved, so this no longer gates anything: a mock can issue real tokens. The first release
carries one schema, and the negotiation handshake is built alongside it so that a second version is a
controller-side addition rather than a coordinated upgrade at both ends.

---

### 4. Adapter API contract spec

**What it gates:** the bridge and all adapter implementations.

Concrete HTTP shapes are still missing: token exchange request/response bodies, error codes,
revocation poll endpoint (`GET /revocations?since=`), push subscription handshake. The design
intent is in `adapter-integration.md`; it needs to become a spec with exact field names and types.

**Action:** one focused pass to turn the design doc into a typed API spec, once item 3 settles the
payload it carries.

**Status:** open, and not a design blocker. This is implementation work: the design intent exists
in `adapter-integration.md` and this transcribes it into exact field names and types. Needed for
Nov 15, not before implementation starts.

---

### 5. Write-vs-read access (v1 scope decision)

**What it gates:** database schema design (directly). The schema needs to know whether
submission creates read grants automatically.

The three options with OCAP implications are in `permissions-model.md`. For v1, deferring to
option 3 (no automatic read access; submission and read independently governed) unblocks the
schema without closing the door on options 1 or 2 later.

**Action:** none remaining.

**Status:** CLOSED by scope. Resource creation at submission time is not in the first release, so
nothing creates a resource and a grant in one act and the question cannot arise. That is option 3 by
another route: submission and read are independently governed because there is no submission path to
couple them.

**It fits later without a schema change, which is the part worth checking rather than assuming.**
`resources` already carries `created_by`, so a service account creating a resource needs no new
column, and grants created at the same moment are ordinary grant rows. Options 1 and 2 remain
reachable as policy on the submission path rather than as structure here, which is where the
ownership-policy decision already puts them: the cascade is something the submission flow supplies
and Usher provides the mechanism for.

---

### The capability model, and how much of it the first release builds

The model is settled in [permissions-model.md](../design/permissions-model.md). What ships is
narrower than what is designed, and the line between them is not drawn by importance. It is drawn by
what a later change costs.

**A column added later is a migration. A wire format changed later is a negotiated payload version
and a coordinated deploy of every bridge.** So the two are future-proofed differently, and
deliberately:

|                                                            | First release                                        | Arrives later, and how                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Data-plane entities                                        | `record` and `artifact`                              | `field` and `revision`, by migration                                      |
| `grants.field_category_id`                                 | not created                                          | added nullable, no backfill, since null is correct for every existing row |
| `entities` and `capabilities` rows for `field`, `revision` | not inserted                                         | data, not structure                                                       |
| Token nesting by entity                                    | **shipped**, though only `record` ever appears in it | nothing to add                                                            |
| `record_category_id` as the column name                    | **shipped under that name**                          | nothing to rename                                                         |

**The nesting ships even though the first release has one entity in it.** `{"open": {"record":
["view"]}}` gains nothing over `{"open": ["view"]}` while `record` is alone. Adding the level later
costs a payload version negotiated at the exchange and a bridge and controller rolled out in step,
which is the mechanism built for changes nobody could foresee. Spending it on the first change that
was foreseen would be the waste.

**The column keeps its final name from the start** for the same reason inverted: renaming
`category_id` to `record_category_id` later is a migration plus every query that touches it, where
naming it correctly now costs nothing and reads honestly, since the axis exists even while it is the
only one.

**`artifact` is in scope, and the provenance obligation that comes with it is not.** Saved sets are
immutable in the first integration, so the check that refuses a set drawn from an unconfigured
resource runs on every version of a set there is. It becomes an obligation the moment a second write
path exists, which is the full sets feature, and it is recorded against that work rather than against
this release.

**What this does not mean.** The design keeps `field` and `revision` in full, because a future item
removed from a design stops constraining the present one and returns as a refactor. The test is
whether someone changing the model now would notice they had broken the later one, and the entities
and their columns are what make that noticeable.

### 6. Database schema

**What it gates:** all core service implementation.

Enough of the permissions model is settled to design the schema for: `resources`, `categories`,
`grants`, `grant_decisions`, `invitations`, `revocations`, `audit_log`. The seven permissions model
gaps mostly affect edge cases (field-level restrictions, user groups, multi-tenancy) that can be
v2 stubs in the schema.

**One question surfaced by the documentation pass, and it needs answering in that session.**
Revoking a principal entirely has no settled storage. Several documents asserted a `revoked_at`
column on `users`, which is not in the entity schema. Either revocation sets `revoked_at` on every
grant the principal holds, which needs no new column and records no fact about the person, or
`users` carries its own marker, which says it directly and reintroduces the per-principal marker
rejected for the fast path. The rejection was about a change that is per resource; emergency
revocation is the case where the change genuinely is per principal, so the two may resolve
differently and that is worth deciding rather than inheriting.

**Action:** schema design session. Nothing blocks it.

**Status:** UNBLOCKED. All three of its dependencies closed: 3 settled the payload, 5 closed by
scope, and 8 replaced its missing field with a category version on `resources`. What remains is the
schema design session itself, now the largest single piece of design work left.

---

### 7. EGO token TTL

**Status:** RESOLVED. Read from the deployment's own EGO Helm values rather than asked for, and
consistent across the iMS production and development environments and the Overture demo
environment:

| EGO setting            | Value    |
| ---------------------- | -------- |
| Access token lifetime  | 3 hours  |
| Refresh token lifetime | 12 hours |

**Why it is three hours, which is the part that matters.** Submitters run large uploads that outlive
a short token and fail partway, so the lifetime was raised until they stopped failing. That is an
availability fix paid for with a platform-wide revocation window, and it is the trade this design
forecloses rather than inherits. See the lifetime-versus-duration decision in
[../design/decisions.md](../design/decisions.md) and the long-running operation item in
[../roadmap.md](../roadmap.md).

**What it gated:** the bridge's cache window sizing, and the migration baseline, since Usher's
token lifetime should not exceed what it replaces without a reason.

**The baseline is satisfied by a wide margin.** The designed Usher token lifetime is five minutes,
which is a thirty-sixth of the access token it replaces. There is no tension to resolve and no
reason to lengthen it.

**The refresh token is the more meaningful comparison, and it needs one confirmation.** A revoked
principal keeps minting access tokens until their refresh token stops working, so the current
worst-case window is bounded by the 12-hour refresh lifetime rather than the 3-hour access
lifetime, unless revocation invalidates stored refresh tokens server-side. EGO persists refresh
tokens, so it may; that is worth confirming, because it is the number the migration is measured
against and the difference between 3 and 12 hours is the difference between a good improvement and
a large one.

**One residual question, and it is a bigger window than either.** API tokens are a separate,
long-lived credential in EGO, and the iMS environments do not set their lifetime, so the chart
default applies and is unknown here. The Overture demo environment sets it explicitly to 3650 days,
which shows how long that knob can go. If iMS issues EGO API tokens for programmatic access, those
bypass both windows above, and Usher needs a deliberate answer for that use case rather than
inheriting one.

### 8. Where the last-policy-change timestamp lives, and what writes to it

**What it gates:** the database schema, and the correctness of the fast-path refresh.

Two findings in `to-discuss.md` are marked CRITICAL and are halves of one gap. The fast path
compares a token's `generatedAt` against the principal's last policy change, and that timestamp has
no home in any entity schema: not a column, not a table, not a cache key, with nothing stated about
what updates it. Separately, if "policy change" means only changes to a principal's own roles
or grant rows, then adding a category to a resource invalidates no cached token, so a principal who
should stop seeing records keeps seeing them for up to one TTL.

Both need the same answer: name the storage, then enumerate exactly which writes touch it, with
resource-category writes among them. Until then the primary performance mechanism is also the
primary correctness risk, on a system holding health records.

**These were absent from this list**, which is where a reader looks for what blocks the gate.

**Status:** CLOSED. There is no per-principal timestamp to place. The marker was per principal while
the dangerous change is per resource, which is why its write list could not be enumerated. Replaced
by two markers that each sit next to what changes them: the computed payload in the shared cache,
deleted by anything altering what a principal holds, and a category version on `resources` bumped by
any `resource_categories` write and compared on refresh. The schema change is that one column. See
the fast-path decision in [decisions.md](../design/decisions.md).

---

## What remains open but does not block Nov 15

- Admin model open questions (self-grant controls, break-glass): gates admin API, not enforcement
- Per-catalogue access posture, including whether a given catalogue is open by configuration: gates
  that catalogue's adapter config, not the core service. Recorded per instance on the integration
  side. Usher's side of it is the `Enforcement` `allow` arm, which is decided.
- Researcher experience UX decisions: gates documentation, not implementation
- System context diagram: nice to have before design review; not an implementation gate
- **Reindex lag as a second revocation window: dissolved, not deferred.** Enforcement reads
  descriptive fields only, never a field encoding an access decision, so a grant change alters no
  indexed value and the index has nothing to be stale about. This returns only if an instance
  chooses to filter on a prescriptive field, which the design excludes. **A grant changing is what
  this dissolves**, and the record's own data changing is a second case it does not reach, open and
  filed in [to-discuss.md](../design/to-discuss.md) § Adapter contract.
- **the Lyric adapter submission-time gating.** SQON machinery exists in Lyric but is not wired to
  the submit/validate/commit path. Building the enforcement seam is new work with known building
  blocks; not required for Nov 15.

---

## Nov 15 feasibility: open risks

Implementation velocity is not the risk. The critical path runs through the open design blockers
above and one external dependency outside this project's control:

| Risk                                                                               | Gate                                                      | Status                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The open design blockers resolved                                                  | Implementation start                                      | Carried per blocker in its own **Status** line above, so there is one copy of it to maintain |
| Keycloak deployed as the portal's token issuer, JWKS reachable from the controller | The controller can validate the token the bridge presents | Unknown; DevOps and infra owned                                                              |
| Resource field confirmed per catalogue                                             | the Arranger adapter config                               | Resolved for the first integration; recorded on that side                                    |

Keycloak's own token exchange endpoint is not a dependency: the bridge calls the controller's
exchange endpoint, and the controller validates the presented token against Keycloak's JWKS. The
bridge is a library inside the ushered service rather than inside the portal.

If the Keycloak work lands before Nov 1, the timeline holds. If it slips, the integration buffer
shrinks or disappears, so it is worth raising as an explicit dependency with its owners.

## Conformance corpus

**Approved location:** iMS infra repo, `.dev/usher-integration/`.

**`principals.json` is drafted**, at [.dev/design/conformance/](../design/conformance/), with all 29
cases expanded into real payload shape and a validator beside it. It is drafted in this repository
because this section names that file Usher's to own; moving it into the location below is a step of
its own. Its README records two deliberate divergences from the case table.

**Structure**, originating from the submission side:
.dev/usher-integration/
README.md what this is, how each side runs it, how to add a case
conformance/
principals.json actors: principal id + permissions payload (Usher owns this file)
records.json records with access level, org, submission id
expectations.json (principal, record) -> visible, with a reason field

**Design constraints agreed:**

- Expectations in neutral terms ("principal P can see record R"), never ES query or SQL predicate
- Zero-grant section, exhaustive: principals with no grants, empty grants, grants for org
  with no records, unrecognized principal: all `visible: false` against every record
- `principals.json` is Usher's to own: permissions payloads in real token shape verbatim
- Exhaustive over the cross product, not a curated subset
- README scopes what the corpus cannot cover: reindex lag, token issuance/verification,
  Arranger `sets` durability

**Prove each assertion is load-bearing by inverting what it tests.** An assertion that passes tells
you nothing about whether it would fail. Invert what is under test, a permitted clause into a
denying one or a negation into an affirmation, and confirm the assertion goes red. Anything still
green is measuring something other than what it claims.

This is the discriminating-pair rule made executable, and it is cheap. An application ran it against
their own fixture and three assertions failed that would previously have passed, because the helper
tested whether a clause was present rather than what it did. The same run also caught an assertion
that had been passing for the wrong reason entirely.

**A test written before a fix is a specification; written after, it is a description.** Where a
defect is known and scheduled, write the case now rather than waiting or asserting current
behaviour. Asserting current behaviour pins the defect. Waiting leaves the fix with nothing to
verify against and a roadmap entry as the only record, which will not notice the day the defect
closes.

**But first check whether the correct behaviour can already be asserted, because the assumption that it cannot is usually what nobody has checked.** An application deferred a case believing it
was blocked on a scheduled design decision, then found the defect lived on a different code path
from the one the fixture exercised. Two ordinary passing tests were possible all along, and they pin
the correct path so that a change importing the defective behaviour fails loudly.

**A tolerated failing test is the fallback, and it is weaker than it looks.** In a runner that
supports them, a tolerated test that starts passing changes a glyph and nothing else: no failure, no
effect on the exit code, nothing that forces anyone to look. So it is a record that is accurate and
unread, which is the failure mode this document keeps finding elsewhere. Record it as
tolerated-and-unmonitored rather than as a tripwire, and prefer a passing test pinning correct
behaviour wherever one is possible, since that is the only form that announces itself.

**Do not overload the corpus with questions it cannot answer.** The corpus compares results, and the
pressure to make it answer everything will be constant, because it is the one artifact both sides
run.

The test for whether a question belongs here: **can you name two inputs whose results must differ if
and only if the property holds?** If yes, it is a corpus case, and the positive-control pairing is
how you build it. If no, the property is invisible to any instrument that compares results, and it
needs one that observes production instead.

Worked both ways, since the boundary is not where it first appears:

| Question                                         | Discriminating pair exists                                    | Instrument                           |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------ |
| Does a denied principal see records              | Yes: denied against permitted, same records                   | Corpus                               |
| Does a facet leak values a principal may not see | Yes: under-privileged against fully-privileged, same endpoint | Corpus                               |
| Which layer produced an outcome                  | Partly: some wrong reasons are pairable, "which layer" is not | Corpus for the pairable half only    |
| Did a query rewrite rather than scan             | No: results are identical by design                           | Profile or explain, never the corpus |

The last row is the one to watch. A property that leaves results identical **by definition** can
never be reached by comparing them, however many cases are added, and a corpus asked to hold it goes
green while measuring nothing.

**Three format constraints are pending a decision, requested from two repositories.** All three
change the file format rather than the case list, so they have to be settled before anyone writes a test harness against it. The Arranger side is holding its harness until
they are.

1. **The outcome needs a third state beyond a visible boolean.** A legitimately zero-grant
   principal receiving an error must be distinguishable from one correctly seeing nothing. Both
   produce zero rows, and a boolean records them identically.
2. **Expectations must cover aggregate results, not only records.** A record-only corpus passes a
   system that leaks through bucket counts, `min`/`max`, or `top_hits`. That is not hypothetical: it
   is the worst finding an application's own audit produced.
3. **Every negative expectation carries the mechanism responsible and the false-pass modes it must
   not be satisfied by**, with each "sees nothing" case paired to a positive control on the same
   record. Detection is by running the query and comparing counts, because an assertion that the
   filter was applied does not catch an endpoint discarding it afterwards.

The second and third arrived independently from opposite directions, one from an aggregation escape
and one from an enumerability rule, and converge on the same requirement. The third has already
earned itself once: it caught a harness defect on its first execution, where an aggregation emitted
nothing and both arms of the test looked clean until the positive control failed to move.

**Dependency: discharged.** `principals.json` requires a stable permissions payload schema, and one
now exists as the `PermissionsPayload` type in
[security-workflow.md](../design/security-workflow.md#the-payload-as-a-type). The member this line
called `schemaVersion` ships as `payloadVersion`: "schema" names Lectern's job in this ecosystem, so a
`schemaVersion` inside an authorization payload reads as the version of the data's schema, and the
decision recording the mechanism already calls it a payload version.

**The 29 cases and `expectations.json` are different layers, and conflating them is the mistake this
section invites.** The cases in [token-calculation.md](../design/token-calculation.md) assert what the
token _contains_, given grants, group membership, acceptance state and the baseline setting. The
corpus asserts what an application _serves_, given a payload and a set of records. They chain rather
than overlap: a case's expected payload is a `principals.json` entry, and the corpus starts where the
cases stop.

Two consequences. **The cases populate `principals.json`, not `expectations.json`**, which also means
expanding their shorthand into the real nested shape, since the table writes `{open: [view]}` where a
payload carries `{"open": {"record": ["view"]}}`. And **the pre-token half stays here**: acceptance
versus rejection, group membership, baseline on or off, and a principal with no decision row are all
resolved before a payload exists, so no cross-repo corpus can see them and they need Usher-side tests
of their own.

**Where the instance-side detail lives.** The integration repository holds its own
`.dev/docs/usher-integration.md` with catalogue topology, resource field names, vocabulary drift, and its
submission service's current-state authorization gaps. Design constraints for the corpus stay here,
since they are contract concerns; anything true only of one instance belongs there.

**One constraint learned while resolving blocker 1, worth building into the corpus.** An expectation
that records only an outcome can keep passing for a reason that has stopped being true. A case
asserting "empty grants yields no access" currently holds on the submission path because of a
particular library pairing rather than because of the query language, so it would stay green through
a migration that breaks it. Either expectations carry which layer is responsible for an outcome, or
a separate test class pins the emitted query. The neutral-terms design above is unaffected and still
correct; this is an additional test class, not a change to the corpus format.
