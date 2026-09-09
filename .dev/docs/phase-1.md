# Phase 1: Design blockers and implementation gate

**Phase 1 window:** Aug 18 to Sep 15, closing at the design lock. An earlier version ended it Sep 1, two weeks before the lock the blockers feed.
**Goal:** close the open questions that block implementation, and confirm the Nov 15 consumability date

---

## What "consumable by Nov 15" requires

Four pieces must be working together for the iMS UAC integration phase to start on time:

1. iMS portal migrated from EGO to Keycloak (portal passes a Keycloak access token to Arranger; no usher code in the portal itself)
2. `usher-arranger` plugin running in Arranger's search-server, with `usher-bridge` as an in-process library (grants cache, revocation polling, Usher API call)
3. `usher-arranger` injecting per-resource SQON filters at query time, derived from the grants the bridge fetches from Usher
4. Enforcement composed at a boundary every Arranger read path inherits, verified by a shared test asserting a denied principal sees nothing on each of them

Working backwards: two weeks of integration buffer means implementation must be functionally
complete by Nov 1.

**Resourcing:** Usher and its integration pieces (usher-bridge, usher-arranger) are implemented
by the developer and AI agents working from a complete spec and a thorough test suite. Code
review support may be requested from the wider softeng team, but implementation ownership is
here. Given this model, implementation velocity is high once the spec is locked: the
**design lock at Sep 15** is the critical constraint, not implementation duration.

---

## Blockers in urgency order

### 1. Maestro/indexing question (highest risk; longest lead time)

**Status: SUPERSEDED for MVP.** Resource-level enforcement removes the premise, since there is no
per-submission access level on the document: the filter names the resource a record belongs to.
Both of the first deployment's catalogues have since been read directly and neither carries an
access-level field at all, which settles the question rather than answering it. The nesting-depth
and per-submission-versus-per-record questions return only with post-MVP record-level narrowing.

**What it gated:** the entire `usher-arranger` plugin design.

Does the per-submission access level survive onto every indexed document, under what field name,
at what nesting depth, and does it attach per submission or per record? If the access level is a
property of a submission-shaped parent and the indexed unit is a child record, SQON filter
injection on that field does not produce correct per-document access control. The plugin design
is invalid in that case and needs a different approach.

**Finding, from a direct read of Lyric's data model:** no access_level or visibility field exists
anywhere in Lyric's data model. The only field present on every indexed document that relates to
submission provenance is `organization`.

**Revised framing:** `organization` is a submission-level concern (Lyric's own
metadata about who submitted), not a property of the data being submitted. Access control for
the usher-arranger plugin should operate on fields within the submitted data records themselves,
not on Lyric's submission metadata. The boundary between "submission" and "data being submitted"
is the responsibility of a Lyric plugin for Usher, not the bridge.

This reopens the blocker in a different form: what access-relevant fields exist within the
indexed data records, and how does Usher's grant model map to SQON filters on those fields?

**Findings, from a direct read of Lyric's code:**

1. **Lyric understands SQON, but not at submission time.** A working SQON parser and SQL-query
   builder (`@overture-stack/sqon-builder`, `convertSqonToQuery.ts`) exists and is used in two
   read-time places: `POST /category/:id/organization/:org/query` and an internal foreign-key
   existence check in `validationService.ts`. Nothing on the submit/validate/commit path. A
   usher-lyric plugin would require a new hook on the submission path calling the existing
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
   binary and global (the field is either indexed for every document or none), not per-requester
   or per-document. It cannot express "user A sees records where tier=open, user B sees
   tier=open and tier=registered." That row-level, per-requester control is exactly what
   SQON filter injection provides. Field exclusion and SQON filtering are complementary levers
   at different granularities, not substitutes for each other.

**Design implication for `usher-arranger`:** the access-control axis field must be IN the
mapping (so it is SQON-filterable), but being in the mapping does not gate access: the injected
SQON filter is what does the gating. Without the filter a user sees all rows; with it, only the
rows matching their grants. This means the field needs to be intentionally included in the
mapping, and that decision is the deployment team's to make consciously, not a bug-fix shape of
change.

**Design implication for `usher-lyric`:** submission-time gating is separate, not required for
Nov 15. The building blocks exist (SQON machinery), but wiring to the submission path is new
work. Track as a post-Nov-15 item.

**SQON is a shared Overture language, not an Arranger dialect.** Lyric consumes SQON as well,
so a SQON-shaped grant is portable across the read path (Arranger) and the submission path
(Lyric) without translation. Arranger owns the module; it does not own the language.

**Planning assumption:** Lyric converges on the same SQON library that Arranger's
`graphql-router` consumes, namely `@overture-stack/sqon` (the `modules/sqon` workspace in the
Arranger repo). Every finding below is stated against that assumption. The findings previously
recorded here were measured against Lyric's current pin, `@overture-stack/sqon-builder@^1.1.0`,
and are superseded; they are kept in the list with the reason, since the difference between the
two is where the safety-relevant change lives.

- **`fieldName` is the property-name key on both sides.** Previously recorded as a fortunate
  coincidence between Lyric's `sqon-builder` pin and Arranger v3 naming. Under a shared module
  it holds by construction. No property-name translation layer is needed between Usher's
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
  does not survive the move. In `@overture-stack/sqon`, an empty and-combination is a valid,
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
  guard gets written once for every adopter rather than once per plugin.

  **Consequence for the conformance corpus:** the zero-entitlement section cannot merely assert
  `visible: false` for a principal with no grants. It needs a case whose failure mode is
  match-all, that is, a zero-grant principal evaluated against a non-empty record set, so a
  regression to an empty combination is caught rather than passing silently.

- **SQL injection in Lyric's SQON handler is now an open PR.** Lyric PR 219 (open since
  2026-08-20) parameterizes `fieldName` and value through drizzle's SQL template instead of
  splicing them into `sql.raw()`. Must land before any usher-lyric integration work. The PR
  notes a second gap it deliberately leaves open: `fieldName` still has no allowlist against
  the dictionary's real field names. That is directly relevant to Usher, because a
  grants-derived filter supplies `fieldName` values into the same path; parameterization makes
  it safe from injection but does not make it a validated field reference.

- **Dependency risk to record, not a blocker.** `@overture-stack/sqon` is at `0.0.0-dev` with
  no stable release, published under an `rc` dist-tag. If both enforcement points depend on it
  before Nov 15, Usher's filter correctness rests on an unreleased module. Worth an explicit
  decision on pinning strategy rather than discovering it during integration.

**RESOLVED. The blocker's premise was wrong, and resource keys are not Usher's to
know.**

The question this blocker opened with, whether a per-submission access level survives onto every
indexed document, does not need an answer. Under resource-level enforcement there is no access level
on the document: enforcement filters on the field naming the resource a record belongs to, and the
access decision is made in Usher against that resource's categories. The nesting-depth and
per-submission-versus-per-record sub-questions dissolve with it.

What replaces the question is a per-integration one, and it lands outside this repository by design:
each catalogue supplies a resource-key field name as plugin config, and Usher never learns it. A
plugin must establish that the candidate field is single-valued, that its cardinality is verified
against a declaration rather than inferred from an Elasticsearch mapping (which cannot express it),
that its values were observed rather than read off a display label, and that the term is not
overloaded elsewhere in that deployment. Those four checks are recorded in
[`plugin-integration.md`](../design/plugin-integration.md).

For the first integration these are settled and documented on that side, in the integration
repository's own `.dev/docs/usher-integration.md`: two catalogues fed by different submission
services, using different fields for the same role, at matching granularity. The deployment detail
stays there because none of it constrains Usher's design, and stating it here would make a
deployment's configuration read as a platform rule.

One general finding is worth keeping on this side: **migration must derive resources from a
registered vocabulary rather than by enumerating values found in data.** Where a deployment has both,
the accumulated set drifts from the curated one, including near-duplicate spellings of the same
identifier. Enumerating splits one resource in two, and a grant on either silently misses the
other's records. That fails closed, so it presents as missing data rather than as a disclosure,
which makes it harder to notice.

**Status:** RESOLVED. The `dynamic: false` and SQON-operator constraints recorded above remain
accurate and become relevant again for post-MVP record-level narrowing.

---

### 2. HTTP framework

**Status:** RESOLVED. Fastify.

See [`technology-stack.md`](atlas/roadmap/technology-stack.md) for the full decision rationale
and the architectural constraint that accompanies it: Fastify owns HTTP concerns only; all
application logic is framework-independent and must be unit-testable without starting the server.

---

### 3. Grants payload schema and JWE algorithm

**What it gates:** `usher-bridge`, `usher-arranger`, and any future plugin. The bridge decrypts
the token; the plugin reads its fields. Neither can be implemented without a stable schema.

Core shape is clear: resource grants (resource ID, categories), open-tier grants (anonymous
access), `generatedAt` and `exp`. Open sub-questions:

- Schema versioning mechanism (`schemaVersion` field; reject or degrade on mismatch)
- JWE algorithm: RSA-OAEP vs ECDH-ES for key wrap; AES-256-GCM for content encryption
  (see OWASP A04 gap in `security-threat-model.md`)

**Encryption is confirmed, and the reason changed.** The original rationale for JWE assumed the
user held and forwarded the grants token; that is false under the current architecture, where the
bridge is a library in a client data service and fetches the token from the controller itself.
Encryption is retained on a different and stronger basis: audience scoping becomes cryptographic,
so a payload issued for the wrong application fails to decrypt instead of leaking. Both candidate
key-wrap algorithms are asymmetric, so per-application scoping costs a public-key registration
rather than secret distribution. Recorded in
[`decisions.md`](../design/decisions.md) under the JWE decision. Only the algorithm choice
remains open here.

**Field-level restrictions are out of scope for MVP.** Row-level access control via SQON
filter injection is sufficient. The `fields.exclude` shape in nested grants is a post-MVP item;
stub the field as absent or empty object in the v1 schema to leave the door open.

**Design note (post-MVP, for reference):** field exclusion can be applied by the plugin after
the ES response arrives and before surfacing to the client, giving per-row field control in a
single ES round trip. This would require a response transformer hook in the plugin API contract
in addition to the query modifier, which becomes a blocker 4 concern at that point.

**RESOLVED, and simplified by the resource-level decision.** Under resource-level
enforcement there are no per-record category predicates, so the emitted filter is a single positive
clause on the resource key and the additive-versus-subtractive question is moot for MVP. It governs
the post-MVP record-level case, where the single-clause encoding is `not` of `not-in` (verified by
executing the compiler) and requires a `nested` mapping. Both recorded in
[`decisions.md`](../design/decisions.md).

The plugin
renders a resolved grant set as a union of positive predicates, one branch per grant held, rather
than computing exclusions by subtracting held categories from a locally configured category set.
The decision turns on failure direction: in a subtractive model, losing a term widens access; in
an additive model, losing a term narrows it.

| Failure | Subtractive | Additive |
|---|---|---|
| Category exists in Usher, unmapped in the plugin | No exclusion generated, records leak | Contributes no branch, denies |
| Data carries a tag value not yet registered as a category | Nothing excludes it, visible | Matches no predicate, hidden |
| A bug drops a clause from the composed filter | Access widens | Access narrows |
| A field mapping points at the wrong field | Fails open | Fails open |
| Principal holds zero grants | Denies | Denies |

Term loss is a demonstrated property of `@overture-stack/sqon` rather than a speculative risk
(empty combinations validate as match-all, `reduce.ts` prunes empty inner combinations,
`removeFilter` converges on an empty), which is what makes failure direction the deciding
criterion. Full rationale, including the audit-locality and pipeline-inversion arguments, in
[`decisions.md`](../design/decisions.md).

Three things follow for the payload:

- **The token carries held grants only.** Moving a resource's full configured category set into
  the token was considered, to make subtractive rendering fail closed on config drift. Additive
  rendering does not need it.
- **Membership becomes an explicit positive grant.** There is no implicit baseline for untagged
  records any more, so membership must render to a predicate of its own. The exact shape is open
  and is tracked in `roadmap.md`.
- **Zero grants never becomes a filter.** The bridge returns the `Enforcement` discriminated
  result; see the zero-entitlement decision in `decisions.md`.

The earlier exploration of a two-part grants-and-restrictions payload (from the "open data except
indigenous, plus closed data for projects A and B" example) is **withdrawn**. That case is already
satisfied by the existing category model: the record carries `indigenous_data`, the principal holds
no grant for it, so no branch covers it. No restrictions field and no partition requirement on
categories. The worked example at `permissions-model.md` is that exact scenario.

**Action:** remaining work is schema versioning (a one-field addition) and JWE algorithm
selection (a bounded security decision).

**Status:** payload shape and rendering direction resolved; `schemaVersion` and JWE algorithm
still open.

---

### 4. Plugin API contract spec

**What it gates:** `usher-bridge` and all plugin implementations.

Concrete HTTP shapes are still missing: token exchange request/response bodies, error codes,
revocation poll endpoint (`GET /revocations?since=`), push subscription handshake. The design
intent is in `plugin-integration.md`; it needs to become a spec with exact field names and types.

**Action:** design session, one focused pass to turn the design doc into a typed API spec.

**Status:** open.

---

### 5. Write-vs-read access (v1 scope decision)

**What it gates:** database schema design (directly). The schema needs to know whether
submission creates read grants automatically.

The three options with OCAP implications are in `permissions-model.md`. For v1, deferring to
option 3 (no automatic read access; submission and read independently governed) unblocks the
schema without closing the door on options 1 or 2 later.

**Action:** explicit v1 scoping decision. Does not require resolving the full OCAP question.

**Status:** open; recommend deciding v1 = option 3 and revisiting post-launch.

---

### 6. Database schema

**What it gates:** all core service implementation.

Enough of the permissions model is settled to design the schema for: `resources`, `categories`,
`category_grants`, `pending_grants`, `revocations`, `audit_log`. The seven permissions model
gaps mostly affect edge cases (field-level restrictions, user groups, multi-tenancy) that can be
v2 stubs in the schema.

**Action:** schema design session after blockers 3 and 5 are resolved.

**Status:** blocked on 3 and 5.

---

### 7. EGO token TTL

**Status: RESOLVED.** Read from the deployment's own EGO Helm values rather than asked for, and
consistent across the iMS production and development environments and the Overture demo
environment:

| EGO setting | Value |
|---|---|
| Access token lifetime | 3 hours |
| Refresh token lifetime | 12 hours |

**Why it is three hours, which is the part that matters.** Submitters run large uploads that outlive
a short token and fail partway, so the lifetime was raised until they stopped failing. That is an
availability fix paid for with a platform-wide revocation window, and it is the trade this design
forecloses rather than inherits. See the lifetime-versus-duration decision in
[../design/decisions.md](../design/decisions.md) and the long-running operation item in
[../roadmap.md](../roadmap.md).

**What it gated:** `usher-bridge` cache window sizing, and the migration baseline, since Usher's
token lifetime should not exceed what it replaces without a reason.

**The baseline is satisfied by a wide margin.** The designed grants-token lifetime is five minutes,
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
what updates it. Separately, if "policy change" means only changes to a principal's own membership
or grant rows, then adding a category to a resource invalidates no cached token, so a principal who
should stop seeing records keeps seeing them for up to one TTL.

Both need the same answer: name the storage, then enumerate exactly which writes touch it, with
resource-category writes among them. Until then the primary performance mechanism is also the
primary correctness risk, on a system holding health records.

**These were absent from this list**, which is worth noting because this document is where a reader
looks for what blocks the gate.

---

## What remains open but does not block Nov 15

- Admin model open questions (self-grant controls, break-glass): gates admin API, not enforcement
- Per-catalogue access posture, including whether a given catalogue is open by configuration: gates
  that catalogue's plugin config, not the core service. Recorded per deployment on the integration
  side. Usher's side of it is the `Enforcement` `allow` arm, which is decided.
- Researcher experience UX decisions: gates documentation, not implementation
- System context diagram: nice to have before design review; not an implementation gate
- **Reindex lag as a second revocation window: dissolved, not deferred.** Enforcement reads
  descriptive fields only, never a field encoding an access decision, so a grant change alters no
  indexed value and the index has nothing to be stale about. This returns only if a deployment
  chooses to filter on a prescriptive field, which the design excludes.
- **`usher-lyric` submission-time gating.** SQON machinery exists in Lyric but is not wired to
  the submit/validate/commit path. Building the enforcement seam is new work with known building
  blocks; not required for Nov 15.

---

## Nov 15 feasibility: open risks

Implementation velocity is not the risk. The critical path runs through the Sep 15 design lock
and two external dependencies outside this project's control:

| Risk | Gate | Status |
|---|---|---|
| Design blockers 3, 4, 6 and 8 closed | Sep 15 design lock | In progress. Blockers 1, 2 and 5 are closed; 8 was added after a sweep found both CRITICAL findings absent from this list |
| Keycloak deployed as the portal's token issuer, JWKS reachable from the controller | The controller can validate the token the bridge presents | Unknown; DevOps and infra owned |
| Portal migrated from EGO to Keycloak | Portal can present a token the controller accepts | Unknown timeline; integration team |
| Resource-key field confirmed per catalogue | usher-arranger plugin config | Resolved for the first integration; recorded on that side |

Two corrections to earlier versions of this table. Keycloak's own token exchange endpoint is not a
dependency: the bridge calls the controller's exchange endpoint, and the controller validates the
presented token against Keycloak's JWKS. And the bridge is not embedded in the portal; it is a
library inside the client data service, so the portal's only Usher-related work is the EGO to
Keycloak migration.

If the Keycloak work and the portal migration land before Nov 1, the timeline holds. If either
slips, the integration buffer shrinks or disappears. Worth raising both as explicit dependencies
with the relevant owners before the Sep 15 design lock.

---

## Conformance corpus

**Approved location:** iMS infra repo, `.dev/usher-integration/`.

**Proposed structure**, originating from the submission side and awaiting confirmation or redline here:
```
.dev/usher-integration/
  README.md                    what this is, how each side runs it, how to add a case
  conformance/
    principals.json            actors: subject id + grants payload (Usher owns this file)
    records.json               records with access level, org, submission id
    expectations.json          (principal, record) -> visible, with a reason field
```

**Design constraints agreed:**
- Expectations in neutral terms ("principal P can see record R"), never ES query or SQL predicate
- Zero-entitlement section, exhaustive: principals with no grants, empty grants, grants for org
  with no records, unrecognized subject: all `visible: false` against every record
- `principals.json` is Usher's to own: grants payloads in real token shape verbatim
- Exhaustive over the cross product, not a curated subset
- README scopes what the corpus cannot cover: reindex lag, token issuance/verification,
  Arranger `sets` durability

**Prove each assertion is load-bearing by inverting what it tests.** An assertion that passes tells
you nothing about whether it would fail. Invert the thing under test, a permitted clause into a
denying one or a negation into an affirmation, and confirm the assertion goes red. Anything still
green is measuring something other than what it claims.

This is the discriminating-pair rule made executable, and it is cheap. An adopter ran it against
their own fixture and three assertions failed that would previously have passed, because the helper
tested whether a clause was present rather than what it did. The same run also caught an assertion
that had been passing for the wrong reason entirely.

**A test written before a fix is a specification; written after, it is a description.** Where a
defect is known and scheduled, write the case now rather than waiting or asserting current
behaviour. Asserting current behaviour pins the defect. Waiting leaves the fix with nothing to
verify against and a roadmap entry as the only record, which will not notice the day the defect
closes.

**But first check whether the correct behaviour can already be asserted, because the assumption that
it cannot is usually the thing that has not been checked.** An adopter deferred a case believing it
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

| Question | Discriminating pair exists | Instrument |
| -------- | -------------------------- | ---------- |
| Does a denied principal see records | Yes: denied against permitted, same records | Corpus |
| Does a facet leak values a principal may not see | Yes: under-privileged against fully-privileged, same surface | Corpus |
| Which layer produced an outcome | Partly: some wrong reasons are pairable, "which layer" is not | Corpus for the pairable half only |
| Did a query rewrite rather than scan | No: results are identical by construction | Profile or explain, never the corpus |

The last row is the shape to watch. A property that leaves results identical **by definition** can
never be reached by comparing them, however many cases are added, and a corpus asked to hold it goes
green while measuring nothing.

**Three format constraints are pending a decision, requested from two repositories.** All three
change the file format rather than the case list, so they have to be settled before anyone writes an
adapter against it. The Arranger side is holding its adapter until they are.

1. **The outcome needs a third state beyond a visible boolean.** A legitimately zero-entitlement
   principal receiving an error must be distinguishable from one correctly seeing nothing. Both
   produce zero rows, and a boolean records them identically.
2. **Expectations must cover aggregate results, not only records.** A record-only corpus passes a
   system that leaks through facet counts, `min`/`max`, or `top_hits`. That is not hypothetical: it
   is the worst finding an adopter's own audit produced.
3. **Every negative expectation carries the mechanism responsible and the false-pass modes it must
   not be satisfied by**, with each "sees nothing" case paired to a positive control on the same
   record. Detection is by running the query and comparing counts, because an assertion that the
   filter was applied does not catch a surface discarding it afterwards.

The second and third arrived independently from opposite directions, one from an aggregation escape
and one from an enumerability rule, and converge on the same requirement. The third has already
earned itself once: it caught a harness defect on its first execution, where an aggregation emitted
nothing and both arms of the test looked clean until the positive control failed to move.

**Dependency:** `principals.json` requires a stable grants payload schema. Blocker 3 is now
resolved for the parts the corpus needs, so this is unblocked once `schemaVersion` is settled.

**Where the deployment-side detail lives.** The integration repository holds its own
`.dev/docs/usher-integration.md` with catalogue topology, resource keys, vocabulary drift, and its
submission service's current-state authorization gaps. Design constraints for the corpus stay here,
since they are contract concerns; anything true only of one deployment belongs there.

**One constraint learned while resolving blocker 1, worth building into the corpus.** An expectation
that records only an outcome can keep passing for a reason that has stopped being true. A case
asserting "empty grants yields no access" currently holds on the submission path because of a
particular library pairing rather than because of the query language, so it would stay green through
a migration that breaks it. Either expectations carry which layer is responsible for an outcome, or
a separate test class pins the emitted query. The neutral-terms design above is unaffected and still
correct; this is an additional test class, not a change to the corpus format.
