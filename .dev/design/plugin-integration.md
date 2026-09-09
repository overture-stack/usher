# Plugin Integration

_Status: not started. This document captures what is known about requirements and surfaces the
open questions that need answers before design work can begin._

---

## Concept

Each Overture application integrates with Usher via a **PEP plugin**: a middleware or library
package specific to that app's framework. The plugin's responsibilities:

1. Intercept incoming requests and extract the user's IdP bearer token.
2. Exchange the IdP token for a JWE grants token (on first request or after TTL expiry).
3. Cache the grants token for its TTL duration; validate locally on subsequent requests.
4. Translate the grants payload into the app's native query filter format.
5. Maintain the revocation channel (push subscription + poll fallback).
6. Enter revocation-uncertain mode and suspend sessions if the revocation channel goes dark.

Items 2-3 and 5-6 are implemented by the shared bridge library (`@overture-stack/usher-bridge`).
Each app-specific plugin (`@overture-stack/usher-arranger`, etc.) builds on `usher-bridge` and
adds item 4.

---

## Decided

**JWE decryption is the bridge's responsibility, not the plugin's.** The bridge holds the
decryption key (provisioned at client app deploy time), decrypts grants tokens, and
exposes the result to the plugin as a typed `GrantsPayload` object. Plugins never see the raw
JWE or the decryption key. This keeps the plugin interface simple: receive a payload, translate
it to a query filter, done.

**User IDs (not email addresses) are the identifiers in all API interactions.** The bridge
presents the user's Keycloak subject (`sub` claim) to the controller's token exchange endpoint.
The `GrantsPayload` carries the `sub` as the user identifier. Any plugin feature that needs to
display a user's name or email (for example, a "shared with me" listing showing who shared a
resource) resolves that display information by calling the Keycloak admin API at the portal/app
layer, not by reading email from Usher.

**Plugin config shape is the plugin's own concern, not a Usher pattern.** Usher's contract
with the plugin ends at the `GrantsPayload` boundary: resource ID mapped to role and category
include-list. How the plugin translates that payload into its service's native filter or access
check is entirely the plugin's design problem. Each plugin defines its own config schema
appropriate to its target service. Examples:

- `usher-arranger`: maps resources to catalogues, fieldNames, and fieldValues for SQON filter
  injection. Must be catalogue-aware to prevent a grant scoped to one index from leaking into
  a query targeting a different index, even if both indices contain the same fieldName. "Catalogue"
  is Arranger vocabulary; it has no equivalent concept in Usher's model.
- `usher-lyric`: maps resources to whatever Lyric uses to scope write and read access (submission
  schemas, project identifiers, etc.).
- `usher-song`, `usher-score`, `usher-lectern`: each defines its own config shape.

Usher's plugin-integration.md does not prescribe a shared config format across plugins.
Each plugin's design document (co-located in that service's repo) owns its config schema.

## Writing a plugin design document

A plugin's own design document is what someone builds from, so its failure modes are enforcement
failure modes. These came out of reviewing the first one and are stated generically because the
next plugin will hit them in the same order.

**A terminology table is consulted, not read, and it wins.** Where a table defines a term one way
and prose corrects it fifty lines later, the table is what a reader takes away, because nobody
consults prose to look up a word. Fix the table first when a model changes; every other correction
reads as inconsistent while it stands.

**Attribution makes a line unquestionable, so attribute claims rather than conclusions.** "Agreed
with the authorization owner" stops a reader querying a sentence, and it stays stopped after the
agreement is superseded. Worse, it can circulate: an owner may have agreed to a claim while working
from the document's own premise, so the attribution certifies a conclusion against a source that
inherited it. Record what was agreed and when, so a reader can tell whether the agreement predates
the thing that changed.

**A finding can outlive the problem it describes.** An audit item flagged as the most consequential
open question stays flagged after a replacement resolves it, and it then argues that a fixed thing
is broken. When a section is replaced, re-check the findings that pointed at it.

**A resolved section is where a retired premise survives longest.** Open questions are honest about
being open and get re-read. Closed ones carry authority and do not. When a model changes, audit what
the document is confident about before auditing what it admits is unsettled.

**A closed defect described as open is the mirror image of a stale resolution**, and both hide in
sections that read as settled. A fix rarely updates the prose describing the thing it fixed,
especially when it closes something as a side effect of closing something else. The result is a
severity claim in a section describing current behaviour, which is the shape most likely to be
quoted as-is. Re-check what a document says is broken as often as what it says is settled.

**A correction has a blast radius, and editing in place hides it.** Fixing a premise in the
paragraph you are looking at feels complete there, and nothing prompts you to ask which downstream
claims depended on it. Searching for the premise's wording will not find them, because a downstream
claim is phrased in the vocabulary of the conclusion it drew, not of the premise it drew it from: a
correction to what a resource is survives four paragraphs later as an assumption about what a
container is.

So after correcting a premise, list what it licensed and search for *those* claims. The check that
you have: name a sentence elsewhere that changed as a result. If a premise correction changes
nothing else in the document, either the premise was inert or you have not looked.

**When a structure is scheduled to change, pick the fix that is correct before and after.** A fix
chosen against the present shape can be right at review and wrong the day the planned change lands,
and it will not announce the transition. The published documents here have no generated index today
and will have one when they move to the platform site, so hand-writing a list of them would be
correct now and a stale duplicate later, while a single link into the directory is correct in both
regimes. Prefer the fix that does not encode the current structure.

**When a canonical form lands, sweep the stopgaps.** A named constructor arriving does not remove
the hand-written encodings written before it, and a document holding three ways to express the same
thing invites an implementer to choose the one that fails open.

---

**The resolution sequence is normative, even though the translation is not.** How a plugin renders
a filter into its service's query language is its own business. The steps by which it decides *what*
to render are not, because that is where the model lives, and a plugin that gets them wrong is
wrong regardless of how well it translates.

Per protected type, per request:

1. **From config:** the resources configured for this type, and for each, the field value that
   identifies a record as belonging to it.
2. **From the token:** the resources this principal holds.
3. **Intersect.** The visible set is those configured for this type that the principal also holds.
4. **Empty intersection denies** this type. Not the absence of an entry: absence of an *overlap*.
5. **Otherwise narrow**, with a single positive clause matching the field values of the visible set.
6. **For a derived artifact, add the ceiling clause**, excluding any artifact whose recorded
   provenance names a resource in the complement.

**Denial is per type because it cannot be per request.** A single query document can select several
types whose configured resources differ, so one selection may be denied while another is permitted
and the request must still run. There is no whole request to refuse, and refusing one is not even
well-formed at a layer that has not yet resolved which types were asked for. Recovering a
request-level short-circuit would mean parsing and interpreting the query document upstream, which
is a pattern that fails as soon as someone renames a variable.

This is also why a denied selection costs a round-trip rather than being rejected cheaply. That cost
is structural rather than an oversight, and it was never avoidable for a mixed request.

**Step 4 is the one to get right, and one-resource-per-type hides the error.** Where a type holds
records from exactly one resource, "no entry for this type" and "no overlap" coincide, so an
implementation can trigger on the first and appear correct. Where a type holds records from several,
they diverge: a principal holding two of five studies in a catalogue has no entry for the catalogue
and must still see two studies' records. Refusing the type is wrong; filtering is the answer.

**A trap in step 6 that step 5 does not have.** A record whose field value matches no configured
resource is excluded by step 5, because the positive clause does not name it. The same unconfigured
value in an artifact's provenance is absent from the complement, so step 6 does not exclude the
artifact. **The same defect therefore fails closed on records and open on artifacts**, which is why
an unmapped value must deny rather than be skipped.

**Config granularity is per queryable type, not per catalogue, and getting this wrong is silent.**
Per catalogue is insufficient: an adopter
may compose additional types into a catalogue's schema, and such a type is backed by a structurally
unrelated index while inheriting the catalogue's resource key.

The failure is not a missing restriction. A filter naming a field that type's index does not have is
emitted verbatim and matches nothing, so **everything of that type disappears**. Point the same
mechanism the other way and the documents disappear instead. Either way it presents as data loss
rather than as an authorization error, which is the hardest kind to attribute.

Before configuring a resource key, enumerate every queryable type in the catalogue's schema, not
just the document type it was built for. A type whose access question is answerable from the record
and the authenticated identity alone should not be receiving a grants-derived filter at all; see the
self-scoping rule below.

**The resource key is per-type config, and types within one deployment will differ.** For
MVP the plugin filters on a single field naming the resource a record belongs to. That field name is
plugin config chosen per catalogue, and Usher never learns it. A deployment's bodies of data
typically arrive through different submission services and expose different fields for the same
role, so a plugin that assumes one field name per deployment is wrong.

Four things a plugin must establish about a candidate resource-key field before relying on it. The
values are deployment facts and belong in that integration's own record; what generalizes is that
each must be checked rather than assumed:

- **It is single-valued.** A positive `in` clause on a single-valued field is an exact match whether
  the field is mapped flat or nested, which is what keeps the filter free of any assumption about
  the mapping. If the field is ever multi-valued the same clause silently becomes "carries any of
  these," and the filter widens with no code change and no error.
- **Cardinality is verified against a declaration, not inferred.** An Elasticsearch mapping cannot
  express cardinality: any field may hold one value or many, and the emitted query is identical
  either way. Where a catalogue's own configuration declares it, that declaration is the checkable
  source and the plugin should verify against it at startup.
- **Its values were observed, not read off a label.** A field's display label can describe something
  other than what the field holds. Choose a resource key from actual values.
- **The term is not overloaded elsewhere in the deployment.** A single word can name several
  unrelated concepts across services in one platform: a submission scope, an entity attribute, and a
  connector-level constant. Conflating two yields a filter that is syntactically valid and
  semantically wrong.

**Establish query-language operator semantics by execution, never from reference documentation.**
Anything enforcement depends on gets confirmed by running the compiler and reading the emitted
query. This is not a general caution. Published operator documentation for the query language used
by the first plugin target was found to describe two operators in terms of each other, in exactly
the case where they differ, and a design that took the documented meaning to express subset
containment would have emitted an existential predicate where a universal one was required: the
permissive direction. The idiom that is actually correct was documented nowhere.

The general form is worth recognising, because it appeared twice on this path from different
directions: **a safety property attributed to the wrong layer.** Operator documentation attributed
semantics to a name. Separately, a finding that a submission service "fails secure on empty query
combinations" attributed that guarantee to the query language when it belonged to a particular
library pairing, so it inverts silently on migration. Neither misattribution produces an error when
the thing it depends on changes, which is why the check has to be execution and not reading.

**Enforcement must be installed at every layer that serves protected data.** A deployment where
only one service layer has a Usher plugin enforcing grants is incompletely protected: the unguarded
layer leaks. For a platform where data enters via a submission service (Lyric) and is queried via a
search service (Arranger), both must enforce grants independently. Read enforcement in Arranger does
not prevent unauthorized data entry through Lyric, and write enforcement in Lyric does not prevent
unauthorized reads through Arranger. The grant model is the same across both, since the same grants
token issued for a resource covers both layers, but each layer must have a plugin that verifies
and enforces it. Omitting a plugin at any layer is a deliberate architectural decision that leaves
that surface open, not an acceptable default.

**Platform admin bypass is a plugin-layer decision.** A PEP plugin may detect the
`usher-platform-admin` role in the IdP token and skip SQON filter injection for that request,
allowing platform admins to query without data-category restrictions. This bypass does not produce
a grants token entry; the plugin must log each bypass event with user ID, timestamp, and reason
(`platform_admin_bypass`). The bypass is optional per plugin and per deployment; see
[admin-model.md](admin-model.md) for the full design and the tradeoff between plugin bypass and
the self-grant flow. Do not implement bypass as injecting an empty filter: an empty filter may produce the
correct result but silently drops the audit requirement. The bypass path and the audit emission
must be explicit.

**Absent resource: reject at the router, never attempt filter construction.** When a grants token
is valid but contains no entry for the resource the plugin is protecting, the plugin rejects the
request before filter construction begins.

The response shape is a choice **among indistinguishable shapes**, not an open one. An earlier
version of this line said simply that the shape was the plugin's own choice, which was too loose:
the plugin picks which shape suits its service, and does not get to pick whether "does not exist"
and "you lack access" are distinguishable. A 403 confirms existence, which for a search endpoint is
itself a disclosure.

Indistinguishable covers more than the wording. Response time, body structure, side effects such as
an audit event or a rate-limit counter, and cache or retry behaviour must not differ between the two
cases either, or the message is theatre and the endpoint is still an enumeration oracle. Timing is
the one most often missed.

One calibration keeps this from being paid for by legitimate users: opacity is owed to a requester
who does not already know the resource exists. Where they demonstrably do, holding a lapsed or
pending grant or a membership without the needed category, the response may say precisely what
happened. See the existence-denial invariant in
[permissions-model.md](permissions-model.md), and the zero-entitlement decision in
[decisions.md](decisions.md).

Expressing denial as an empty filter is wrong for any target service. An empty exclusion set does
not mean "deny all"; it means "exclude nothing from scope." The existence-denial invariant
(unauthorized users must not learn that records exist, even through aggregate counts) survives only
if the rejection happens before any result is computed.

**Fail-secure when the bridge cannot deliver a resolved grants payload.** If the bridge cannot
complete the token exchange (Usher unreachable at first request, decryption failed, or revocation
channel unavailable beyond the grace period), the upstream middleware layer must return 503 before
the translation callback is invoked. The callback must never be called with a null or absent
grants payload; the fail-secure principle extends to the grants-not-yet-loaded case: the bridge
yields 503, not an empty-access token.

## Known requirements

The full responsibility split between bridge and plugin is in [architecture.md](architecture.md).
The lists below summarise the requirements relevant to implementation, including specifics not
captured in the component description.

**Bridge (`usher-bridge`), shared by all plugins:**

- Hold the JWE decryption key (provisioned at deploy time; key distribution mechanism TBD)
- Exchange the user's IdP bearer token for a JWE grants token with the controller; for
  unauthenticated requests, perform the exchange with no bearer token to receive an
  anonymous grants token containing only open-tier grants
- Decrypt the grants token and expose a typed `GrantsPayload` to the plugin
- Cache the grants token; validate locally within the TTL window
- Maintain the revocation channel: SSE or WebSocket push with reconnection logic, and poll
  fallback at a configurable interval
- Enter revocation-uncertain mode and return 503 after the grace period

**Plugin (per-app, e.g. `usher-arranger`), specific to each integration:**

- Intercept incoming requests and extract the user's IdP bearer token
- Call the bridge to get the `GrantsPayload` for the requesting user
- Translate the payload into the app's native query filter format
- TTL, grace period, and poll interval must be configurable per bridge instance

Arranger-specific design (grants payload to SQON server-side filters, the two-layer
request/callback contract, Phase 0 audit consequences, and the mock-first implementation
approach) is in the Arranger repo under
[`.dev/docs/arranger-auth/`](https://github.com/overture-stack/arranger/tree/main/.dev/docs/arranger-auth/),
with [`usher-plugin.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/usher-plugin.md)
as the entry point for the plugin design proper. The Phase 0 audit that identified three bypass
paths on the current enforcement seam is in
[`phase-0-audit.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/phase-0-audit.md).

**Logging (shared responsibility between bridge and plugin):**

Usher logs the policy plane: who holds what grants and when that changes. It has no visibility
into whether a token was used or what data was returned. Access decisions happen at the plugin
layer and are that application's audit responsibility.

Each plugin must emit structured log entries for:

| Event            | Required fields                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| Access permitted | `user_id`, `resource_id`, `categories_in_scope`, `filter_applied`, `timestamp`  |
| Access denied    | `user_id`, `resource_id`, `reason`, `timestamp`                                  |

`filter_applied` is a boolean that must be `true` whenever the plugin ran, even when full access
means no filter was injected. Without it, a fully-entitled user's request may be indistinguishable
from one where enforcement did not run.

These events must never contain the grants token payload, raw bearer tokens, or health record
identifiers.

A complete audit trail for a health data access event requires correlating Usher's policy logs
(permission in place) with the plugin's access logs (permission exercised). Consuming applications
must ensure their plugin logs are shipped to the same log aggregation infrastructure as Usher's
logs, with a shared `user_id` field suitable for cross-system correlation.

---

## Open questions

### Decryption key distribution

The bridge holds the JWE decryption key; plugins do not. How is the key provisioned to the
bridge at client app deploy time?

Options:

- Environment variable at deploy time (simple, but rotation requires redeploy)
- Fetched from a secrets manager (Vault, AWS Secrets Manager) at startup
- Issued by the controller itself via a key-exchange endpoint requiring mutual TLS or a bootstrap
  token

Key rotation strategy (frequency, how the bridge picks up a new key without downtime) is also
open. A rotation scheme must allow the old key to remain valid for in-flight tokens during the
switchover window.

### API contract

The specific endpoints, request/response shapes, error codes, and authentication scheme for the
Usher REST API are not yet defined. The grants token exchange, revocation poll, and push
subscription endpoints all need a formal contract before plugins can be built.

### Grants payload schema

The top-level `grants` map (keyed by resource ID, per-resource `role` + `categories` include-list)
is decided; see [security-workflow.md](security-workflow.md) for the full structure and examples.
Field-level restriction representation (if included) is not yet designed. The schema must be
versioned and stable before plugins depend on it.

### Per-app translation design

How should the translation layer (grants payload to app-native filter) be structured? Should
the `usher-bridge` library provide a translation interface that each app plugin implements, or is
the translation entirely the plugin's concern with no shared abstraction? The answer affects how
testable and consistent constraint enforcement is across apps.

### Per-plugin filter shape

Each plugin's translation algorithm (how it converts a grants payload into its target service's
native filter format) is the plugin's own design concern, documented in that service's repo. The
Usher-level constraint is the fail-closed invariant: a plugin must not produce a result that
grants access when the correct result is denial.

One cross-cutting principle that applies regardless of algorithm choice: **plugin config formats
should be startup-validatable against the target service's schema.** A misconfiguration that is
detectable at startup and fails the resource closed is always preferable to one that silently
produces the wrong filter at request time. Each plugin's design doc should specify how its config
is validated at startup and what happens when validation fails.

A second consideration in choosing a filter shape: **how the filter degrades under
misconfiguration.** An exclusion filter built from a category field that is misspelled or absent
from the target schema may match everything (since `NOT(matches nothing)` compiles to match-all),
degrading toward full access. An inclusion filter under the same conditions degrades toward no
access. Where a target service's type system allows it, prefer the shape that degrades toward
denial, and supplement it with startup validation that catches the misconfiguration before any
request is served. The plugin-specific design doc (in that service's repo) records which shape
was chosen and why. See the Arranger plugin design for a concrete worked example of this
tradeoff: [`arranger-auth/usher-plugin.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/usher-plugin.md).

### Authorization unit chain

The resource ID that Usher tracks must be traceable through the full serving pipeline to the
indexed field the enforcement plugin filters on. This chain typically has four steps in Overture
deployments:

1. **Submission unit.** The boundary the submission service uses for write-access gating (an
   organization identifier, a programme code, a project ID). This is the unit the submitter's
   `context.scope` is checked against.
2. **Data service unit.** The cohort or grouping identifier used by Lyric or SONG as a record
   attribute (the value that distinguishes which resource a record belongs to). This maps to the
   submission unit, but the mapping is deployment-specific and may involve a transformation.
3. **Indexed field.** The field name and value Maestro emits into the search index from the data
   service unit.
4. **Plugin filter field.** The `fieldName` (and its expected values) the enforcement plugin uses
   to construct query filters from the grants token's resource ID.

If any link is broken (the submission unit does not map to the data service unit, the data
service unit is not indexed, or the indexed field name differs from the plugin config) enforcement
is silently misconfigured. The plugin runs but produces incorrect filters with no error signal.

Each deployment must verify this chain explicitly at plugin configuration time. Usher cannot
validate it: it has no visibility into submission schemas, data service models, or index mappings.
Startup validation (see Per-plugin filter shape above) can verify that named fields exist in the
index; it cannot verify that the chain is semantically correct end-to-end.

The authorization unit is also not guaranteed to be the same across all services in the pipeline.
A submission boundary of "organization" does not imply that the indexed field is an organization
identifier; it may have been transformed into a study or cohort identifier by the data service
layer. Deployments must trace this explicitly rather than assuming the unit is preserved. See
[permissions-model.md § Write vs read access](permissions-model.md) for the related question
of whether organizational write access implies read access at the resource level.

The iMicroSeq submission service current-state writeup documents this chain for the iMS platform
and confirms the unit changes shape at every hop. That document is the reference for what the
chain looks like in practice:
[`imicroseq/submission-service: .dev/docs/auth/ego-integration-current-state.md`](https://github.com/imicroseq/submission-service/blob/main/.dev/docs/auth/ego-integration-current-state.md).
The per-hop analysis is also recorded in the Arranger plugin design:
[`arranger-auth/usher-plugin.md § The authorization unit is not stable across the pipeline`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/usher-plugin.md).

The indexing-side question remains open and its shape has been clarified: the relevant question is
not whether an organization identifier survives to the index, but **whether the per-submission
access level survives onto every indexed document: under what field name, at what nesting depth,
and whether it attaches per submission or per record**. The last clause is the design-invalidating
one: if access level is a property of a submission-shaped parent and the indexed unit is a record
child, SQON filter injection on that field does not produce correct per-document access control.
This question is already tracked as an existing open item in the Arranger repo at
[`.dev/docs/atlas/lyric-maestro-indexing-gap.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/atlas/lyric-maestro-indexing-gap.md);
it now has a second reason to matter beyond the ES mapping question it was originally tracking.

**Superseded for MVP.** Resource-level enforcement removes the premise: there is no per-submission
access level on the document, because enforcement filters on the field naming the resource a record
belongs to. The nesting-depth and per-submission-versus-per-record questions return only with
post-MVP record-level narrowing.

### Access level changes and index freshness

**Superseded, and not only for MVP.** The premise is that the plugin filters on an indexed field
encoding the access level, which is a prescriptive field. Enforcement reads descriptive fields only,
so no indexed field changes when a grant changes and the two layers have nothing to disagree about.
The three open questions below are recorded as answered: no reindex is triggered by an access
change, no coordination owner is needed, and there is no window for the plugin to degrade through.
They return only if a deployment chooses to filter on a prescriptive field, which this design
excludes.


When the enforcement plugin filters on a field in a search index that encodes the access level
(for example, a field marking whether a document belongs to an open or restricted resource),
a change to that access level in Usher does not automatically propagate to the index. The
revocation channel propagates grant revocations to the bridge and plugin, but the indexed field
reflects the state at the last reindex. Between an access-level change and the completion of a
reindex, the two layers may disagree.

The dangerous direction is open to restricted: during that window, Usher has withdrawn the
grant but the index still returns the record, and the enforcement plugin's filter, built from
the now-withdrawn grant, does not exclude it. The size of the window is the indexing
pipeline's reindex latency.

Open questions:
- Does an access-level change in Usher need to trigger a synchronous reindex or an explicit
  invalidation, rather than relying on the normal indexing cadence?
- Who owns this coordination: Usher (as the source of the change), Lyric (as the submission
  service), or Maestro (as the indexing service)?
- What should the plugin do during the reindex window: serve with the stale filter, suspend
  access to the resource entirely, or surface a degraded state to the caller?
