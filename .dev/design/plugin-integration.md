# Plugin Integration

_Status: designed, not yet a spec. The enforcement seam, the category clause, the cardinality
contract and the failure directions are settled here. What is missing is exact HTTP shapes: request
and response bodies, error codes, and the field names and types a plugin compiles against._

---

## Concept

Each Overture application integrates with Usher via a **PEP plugin**: a middleware or library
package specific to that app's framework. The plugin's responsibilities:

1. Intercept incoming requests and extract the user's IdP bearer token.
2. Exchange the IdP token for an Usher token in JWE form (on first request or after TTL expiry).
3. Cache the Usher token for its TTL duration; validate locally on subsequent requests.
4. Translate the permissions payload into the app's native query filter format.
5. Maintain the revocation channel (push subscription + poll fallback).
6. Enter revocation-uncertain mode and suspend sessions if the revocation channel goes dark.

Items 2-3 and 5-6 are implemented by the shared bridge library (`@overture-stack/usher-bridge`).
Each app-specific plugin (`@overture-stack/usher-arranger`, etc.) builds on `usher-bridge` and
adds item 4.

---

## Decided

**JWE decryption is the bridge's responsibility, not the plugin's.** The bridge holds the
decryption key (provisioned at application deploy time), decrypts Usher tokens, and
exposes the result to the plugin as a typed `PermissionsPayload` object. Plugins never see the raw
JWE or any key. This keeps the plugin interface simple: receive a payload, translate
it to a query filter, done.

**User IDs (not email addresses) are the identifiers in all API interactions.** The bridge
presents the user's Keycloak subject (`sub` claim) to the controller's token exchange endpoint.
The `PermissionsPayload` carries the `sub` as the user identifier. Any plugin feature that needs to
display a user's name or email (for example, a "shared with me" listing showing who shared a
resource) resolves that display information by calling the Keycloak admin API at the portal/app
layer, not by reading email from Usher.

**Plugin config shape is the plugin's own concern, not an Usher pattern.** Usher's contract
with the plugin ends at the `PermissionsPayload` boundary: resource ID mapped to a category
include-list. How the plugin translates that payload into its service's native filter or access
check is entirely the plugin's design problem. Each plugin defines its own config schema
appropriate to its target service. Examples:

- `usher-arranger`: maps resources to catalogues, fieldNames, and fieldValues for SQON filter
  injection. Must be catalogue-aware to prevent a grant scoped to one index from leaking into
  a query targeting a different index, even if both indices contain the same fieldName. A catalogue
  here is the unit [glossary.md](glossary.md) defines, and an Arranger catalogue can hold more than
  one of them.
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
the change.

**A finding can outlive the problem it describes.** An audit item flagged as the most consequential
open question stays flagged after a replacement resolves it, and it then argues that a fixed defect is still broken. When a section is replaced, re-check the findings that pointed at it.

**A resolved section is where a retired premise survives longest.** Open questions are honest about
being open and get re-read. Closed ones carry authority and do not. When a model changes, audit what
the document is confident about before auditing what it admits is unsettled.

**A closed defect described as open is the mirror image of a stale resolution**, and both hide in
sections that read as settled. A fix rarely updates the prose describing what it fixed,
especially when it closes something as a side effect of closing something else. The result is a
severity claim inside a section describing current behaviour, which is exactly the sentence
someone quotes without checking it. Re-check what a document says is broken as often as what it
says is settled.

**A correction has a blast radius, and editing in place hides it.** Fixing a premise in the
paragraph you are looking at feels complete there, and nothing prompts you to ask which downstream
claims depended on it. Searching for the premise's wording will not find them, because a downstream
claim is phrased in the vocabulary of the conclusion it drew, not of the premise it drew it from: a
correction to what a resource is survives four paragraphs later as an assumption about what a
container is.

So after correcting a premise, list what it licensed and search for _those_ claims. The check that
you have: name a sentence elsewhere that changed as a result. If a premise correction changes
nothing else in the document, either the premise was inert or you have not looked.

**When a structure is scheduled to change, pick the fix that is correct before and after.** A fix
chosen against the present shape can be right at review and wrong the day the planned change lands,
and it will not announce the transition. The published documents here have no generated index today
and will have one when they move to the platform site, so hand-writing a list of them would be
correct now and a stale duplicate later, while a single link into the directory is correct in both
regimes. Prefer the fix that does not encode the current structure.

**When a canonical form lands, sweep the stopgaps.** A named constructor arriving does not remove
the hand-written encodings written before it, and a document holding three ways to express one condition invites an implementer to choose the one that fails open.

---

**The resolution sequence is normative, even though the translation is not.** How a plugin renders
a filter into its service's query language is its own business. The steps by which it decides _what_
to render are not, because that is where the model lives, and a plugin that gets them wrong is
wrong regardless of how well it translates.

Per protected type, per request:

1. **From config:** the resources configured for this type, each with the field value identifying a
   record as belonging to it; and the categories configured for this type, each with the field value
   marking a record as carrying it.
2. **From the token:** the `(resource, category)` pairs this principal holds.
3. **Intersect.** The visible set is the pairs whose resource is configured for this type.
4. **Empty intersection denies** this type. Not the absence of an entry: absence of an _overlap_.
5. **Otherwise narrow**, with one clause per visible pair, composed with `or`. Each clause is a
   conjunction of two field tests, the resource's and the category's.
6. **For a derived artifact, add the ceiling clause**, excluding any artifact whose recorded
   provenance names a resource in the complement.

**Step 5 carries the whole model, so its two field tests are worth stating separately.** The
resource test is a positive match on the resource field. The category test depends on which kind of
category it is, and the two are not symmetrical:

    a concrete category   the category field matches that category's configured value
    open                  the category field matches none of the configured concrete values

A concrete category has a value of its own to match. `open` does not: it is the residual, meaning
whatever no concrete category covers, so its clause is the complement and is therefore negative where
every other clause is positive. That asymmetry is inherent to a counter-category rather than a
consequence of the query language, and it is where the hazard in the startup check below comes from.

**How the clauses compose, which is an invariant rather than an implementation note.**

    within one grant     AND      the resource test AND the category test
    across grants        OR       the union of what the principal holds
    against the client   AND      always, at every depth

A correct emitted filter is an AND whose enforcement side is an OR of ANDs. **Any mechanism that can
produce OR between the enforcement filter and a client-supplied clause is a disclosure defect,
whatever depth it occurs at**, and it does not become acceptable because the client clause looks
harmless: a client controls its own half, so an OR there is a client-controlled bypass of
enforcement. This matters most in aggregations, where a widened filter discloses through a count
without returning a record anyone can point at, which is the channel the existence invariant is
hardest to defend in.

**Both fields are tested, and testing only the resource would be a different model.** A category
selects records within a resource; it does not decide whether the resource is reachable. Narrowing on
the resource field alone would make a resource of mixed sensitivity unreachable in full until it was
registered as several resources, so its public records would not be public. Both tests are
single-valued exact matches, so the category test costs nothing the resource test does not.

**A record carrying more than one category at once is not covered here.** That case needs a subset
test, which the query layer cannot yet express on this shape, and it is the one part of the model
waiting on work elsewhere. Until it lands, a record carries one category.

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

**Config granularity is per catalogue, and getting this wrong is silent.** An application's own
container can be coarser: Arranger lets one `catalogueId` compose additional queryable types into its
schema, and such a type is backed by a structurally unrelated index while inheriting that Arranger
catalogue's resource field name. Each body of data with its own store and schema is its own catalogue
and needs its own configuration, whatever the application calls the container.

The failure is not a missing restriction. A filter naming a field that type's index does not have is
emitted verbatim and matches nothing, so **everything of that type disappears**. Point the same
mechanism the other way and the documents disappear instead. Either way it presents as data loss
rather than as an authorization error, which is the hardest kind to attribute.

Before configuring a resource field name, enumerate every queryable type in the application's catalogue, not
just the document type it was built for. A type whose access question is answerable from the record
and the authenticated identity alone should not be receiving a permission-derived filter at all; see the
self-scoping rule below.

**The resource field name is per-catalogue config, and catalogues within one instance will differ.** For
MVP the plugin filters on a single field naming the resource a record belongs to. That field name is
plugin config chosen per catalogue, and Usher never learns it. An instance's bodies of data
typically arrive through different submission services and expose different fields for the same
role, so a plugin that assumes one field name per instance is wrong.

Four things a plugin must establish about a candidate resource field before relying on it. The
values are instance facts and belong in that integration's own record; what generalizes is that
each must be checked rather than assumed:

- **It is single-valued.** A positive `in` clause on a single-valued field is an exact match whether
  the field is mapped flat or nested, which is what keeps the filter free of any assumption about
  the mapping. If the field is ever multi-valued the same clause silently becomes "carries any of
  these," and the filter widens with no code change and no error.
- **Cardinality is verified against a declaration, not inferred.** An Elasticsearch mapping cannot
  express cardinality: any field may hold one value or many, and the emitted query is identical
  either way. Where a catalogue's own configuration declares it, that declaration is the checkable
  source and the plugin should verify against it at startup.

  **This check is currently unverifiable rather than merely unverified, and the distinction decides
  how much weight it carries.** A declaration is a claim about the data and nothing compares it to
  the data. The search layer's only cardinality instrumentation sits on the response path, warns
  only when a returned field holds two or more values, and is silent at exactly one; the
  filter-compilation path has none at all, confirmed by grep on the search layer rather than
  assumed. So a field used solely in an enforcement clause and never returned in a selection set has
  nothing watching it, and a field that silently gains a second value widens the filter with no code
  change, no error and no warning. The honest fix is a sampling query against live data at startup
  or on a schedule, which nobody has built. Until it exists, treat single-valuedness as an assumption
  the integration asserts rather than a property the system checks.

  **The contract is three parts, and the third is the one usually left out.**

  **The deployment commits** that every enforcement field carries one value per record, and keeps it
  so. Usher's controller cannot check this and never will, since it does not know field names by
  design.

  **The search layer samples and reports.** The plugin declares which fields are enforcement fields;
  the search layer samples the live index at catalogue load and compares observed cardinality against
  each field's declaration, reporting both a wrong declaration and an absent one over multi-valued
  data. It is deliberately **report-only and off the critical path**: it does not fail the catalogue,
  because failing closed on a first run could stop catalogues that have worked for months, and the
  density of declarations across real deployments is unknown.

  **So nothing gates, and the deployment has to supply what the report does not.** A reported
  violation on an enforcement field is not a diagnostic. It is a live disclosure: every filter naming
  that field is already widened, and in a deployment whose data carries no category field it is the
  only clause enforcing anything. Treat it as an incident with an owner, not a log line, because a
  report nobody reads is not a control.

  **And drift after the sample is unclosed**, in those words. A bounded sample shows the presence of
  a violation within what it sampled and can never show absence, and it is stale the moment the next
  document lands. No instrumentation on the filter path, no mapping signal, nothing watching. "Detection
  deferred" is the wrong phrasing because it lets a reader believe detection is coming.

- **The field's `nested` configuration is correct**, which the search layer now derives from the
  index mapping at every call site rather than from configuration, so a missing list throws instead
  of compiling a flat filter. That closes the misconfigured-nesting half of this family and leaves
  cardinality, which no mapping can express.
- **Its values were observed, not read off a label.** A field's display label can describe something
  other than what the field holds. Choose a resource field from actual values.

**Two failure modes push in opposite directions, so no clause shape is safe against both.** This is
worth stating because the obvious reading, that positive clauses are the safe ones, holds for one and
inverts for the other.

| Failure                           | Positive `in`                                              | Negated `must_not` over the complement     |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| The field name is wrong or absent | matches nothing, **fails closed**, noticed within the hour | matches everything, **fails open**, silent |
| The field gains a second value    | matches more, **fails open**                               | excludes the record, **fails closed**      |

`terms` is existential over a multi-valued field, so a record whose resource field holds
`[HEART_STUDY, REEF_ARCHIVE]` satisfies `in(resource, [HEART_STUDY])`. That is what makes the second
row's left cell the dangerous one, and the resource clause is positive with no exclusion counterpart
to hide behind. So the exposure sits on the clause that reads as the safe one.

**Whether that existential match is a defect depends on a fact about the deployment, and stating it
flat either way is wrong.** A resource is a selection and a category is a restriction, so where the
category clause exists, a record reachable through a cohort you were granted is correct rather than
leaked: its content is protected by the category, which a custodian governs across every resource
carrying it, so which cohort brought a reader to the record does not matter. Where the deployment's
data carries no category field, there is no category clause, the resource clause is the only clause,
and the resource axis is carrying governance it was not designed to carry. A second cohort that
granted nothing then has an authority over the record rather than a label on a selection, and
reachability through the first cohort is the leak.

Both halves are needed. Recording only the first reads as "this is fine" in exactly the deployment
where it is not, and recording only the second demands a control the complete model does not need.

**Evidence level, stated because this claim is load-bearing.** That a `terms` clause matches a
document when any one of the field's values is in the list is Elasticsearch's documented behaviour,
confirmed by reading the emitted query rather than by running it against a live index. Two tests
close it, and they are different tests with opposite assertions: index a document whose resource
field holds `[A, B]` and filter on `A`, then assert it **does** come back, which confirms how the
clause behaves; and assert on the same fixture that it does **not**, which states the access
requirement and fails today. Collapsing them produces a failing test that reads as a closed boundary.

- **The term is not overloaded elsewhere in the instance.** A single word can name several
  unrelated concepts across services in one platform: a submission scope, an entity attribute, and a
  connector-level constant. Conflating two yields a filter that is syntactically valid and
  semantically wrong.

**Establish what a query-language operator does by running it, never from reference documentation.**
Anything enforcement depends on gets confirmed by running the compiler and reading the emitted
query. This is not a general caution. Published operator documentation for the query language used
by the first plugin target was found to describe two operators in terms of each other, in exactly
the case where they differ, and a design that took the documented meaning to express subset
containment would have emitted an existential predicate where a universal one was required: the
permissive direction. The idiom that is actually correct was documented nowhere.

The general form is worth recognizing, because it appeared twice on this path from different
directions: **a safety property attributed to the wrong layer.** Operator documentation attributed
a behaviour to a name. Separately, a finding that a submission service "fails secure on empty query
combinations" attributed that guarantee to the query language when it belonged to a particular
library pairing, so it inverts silently on migration. Neither misattribution produces an error when
what it depends on changes, which is why the check has to be execution and not reading.

**Enforcement must be installed at every layer that serves protected data.** An instance where
only one service layer has an Usher plugin enforcing grants is incompletely protected: the unguarded
layer leaks. For a platform where data enters via a submission service (Lyric) and is queried via a
search service (Arranger), both must enforce grants independently. Read enforcement in Arranger does
not prevent unauthorized data entry through Lyric, and write enforcement in Lyric does not prevent
unauthorized reads through Arranger. The grant model is the same across both, since the same grants
token issued for a resource covers both layers, but each layer must have a plugin that verifies
and enforces it. Omitting a plugin at any layer is a deliberate architectural decision that leaves
that path open, not an acceptable default.

**Platform admin bypass is a plugin-layer decision.** A PEP plugin may detect the
`usher-platform-admin` role in the IdP token and skip SQON filter injection for that request,
allowing platform admins to query without category restrictions. This bypass does not produce
an Usher token entry; the plugin must log each bypass event with user ID, timestamp, and reason
(`platform_admin_bypass`). The bypass is optional per plugin and per instance; see
[admin-model.md](admin-model.md) for the full design and the tradeoff between plugin bypass and
the self-grant flow. Do not implement bypass as injecting an empty filter: an empty filter may produce the
correct result but silently drops the audit requirement. The bypass path and the audit emission
must be explicit.

**Absent resource: reject at the router, never attempt filter construction.** When an Usher token
is valid but contains no entry for the resource the plugin is protecting, the plugin rejects the
request before filter construction begins.

The response shape is a choice **among indistinguishable shapes**, not an open one. An earlier
version of this line said the choice was the plugin's own, which was too loose:
the plugin picks which shape suits its service, and does not get to pick whether "does not exist"
and "you lack access" are distinguishable. A 403 confirms existence, which for a search endpoint is
itself a disclosure.

Indistinguishable covers more than the wording. Response time, body structure, side effects such as
an audit event or a rate-limit counter, and cache or retry behaviour must not differ between the two
cases either, or the message is theatre and the endpoint is still an enumeration oracle. Timing is
the one most often missed.

The refusal says the same thing to every principal, with no exception. An earlier calibration
relaxed it for someone holding a lapsed or unaccepted grant, and it was dropped because a plugin
cannot identify such a person: a grant that is not live puts nothing in the token, so a lapsed grant
and a stranger arrive looking identical. The support load that calibration existed to prevent is
carried instead, and Usher tells the person directly. See the existence-denial invariant in
[permissions-model.md](permissions-model.md), and "A refusal carries no exception, and expiry is
announced rather than inferred" in [decisions.md](decisions.md).

Expressing denial as an empty filter is wrong for any target service. An empty exclusion set does
not mean "deny all"; it means "exclude nothing from scope." The existence-denial invariant
(unauthorized users must not learn that records exist, even through aggregate counts) survives only
if the rejection happens before any result is computed.

**Fail-secure when the bridge cannot deliver a resolved permissions payload.** If the bridge cannot
complete the token exchange (Usher unreachable at first request, decryption failed, or revocation
channel unavailable beyond the grace period), the upstream middleware layer must return 503 before
the translation callback is invoked. The callback must never be called with a null or absent
permissions payload; the fail-secure principle extends to the grants-not-yet-loaded case: the bridge
yields 503, not an empty-access token.

## Known requirements

The full responsibility split between bridge and plugin is in [architecture.md](architecture.md).
The lists below summarize the requirements relevant to implementation, including specifics not
captured in the component description.

**Bridge (`usher-bridge`), shared by all plugins:**

- Hold its own application's JWE key. The key is symmetric and reaches the bridge and the controller
  from the secrets store, so onboarding is one secret written once rather than a registration
  distribution; rotation is the part still open
- Exchange the user's IdP bearer token for an Usher token in JWE form with the controller; for
  unauthenticated requests, perform the exchange with no bearer token to receive an
  anonymous Usher token containing only open-tier grants
- Decrypt the Usher token and expose a typed `PermissionsPayload` to the plugin
- Cache the Usher token; validate locally within the TTL window
- Maintain the revocation channel: SSE or WebSocket push with reconnection logic, and poll
  fallback at a configurable interval
- Enter revocation-uncertain mode after the grace period: 503 for anything needing a granted
  permission, while continuing to serve the open tier, which needs no grant and so has nothing to
  be uncertain about
- Signal to the plugin that a result is open-tier only, so the interface can say so rather than
  showing a silently reduced set

**Plugin (per-app, e.g. `usher-arranger`), specific to each integration:**

- Intercept incoming requests and extract the user's IdP bearer token
- Call the bridge to get the `PermissionsPayload` for the requesting user
- Translate the payload into the app's native query filter format
- TTL, grace period, and poll interval must be configurable per bridge

Arranger-specific design (permissions payload to SQON server-side filters, the two-layer
request/callback contract, Phase 0 audit consequences, and the mock-first implementation
approach) is in the Arranger repo under
[`.dev/docs/arranger-auth/`](https://github.com/overture-stack/arranger/tree/main/.dev/docs/arranger-auth/),
with [`usher-plugin.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/usher-plugin.md)
as the entry point for the plugin design proper. The Phase 0 audit that identified three bypass
paths on the current enforcement seam is in
[`phase-0-audit.md`](https://github.com/overture-stack/arranger/blob/main/.dev/docs/arranger-auth/phase-0-audit.md).

**Logging (shared responsibility between bridge and plugin):**

Usher logs who holds what grants and when that changes. It has no visibility
into whether a token was used or what data was returned. Access decisions happen at the plugin
layer and are that application's audit responsibility.

Each plugin must emit structured log entries for:

| Event            | Required fields                                                                |
| ---------------- | ------------------------------------------------------------------------------ |
| Access permitted | `user_id`, `resource_id`, `categories_in_scope`, `filter_applied`, `timestamp` |
| Access denied    | `user_id`, `resource_id`, `reason`, `timestamp`                                |

`filter_applied` is a boolean that must be `true` whenever the plugin ran, even when full access
means no filter was injected. Without it, a fully-entitled user's request may be indistinguishable
from one where enforcement did not run.

These events must never contain the Usher token payload, raw bearer tokens, or health record
identifiers.

A complete audit trail for a health data access event requires correlating Usher's policy logs
(permission in place) with the plugin's access logs (permission exercised). Consuming applications
must ensure their plugin logs are shipped to the same log aggregation infrastructure as Usher's
logs, with a shared `user_id` field suitable for cross-system correlation.

---

## Open questions

### Category dictionary introspection

**The problem.** A plugin's configuration maps each category to a predicate over its own schema's
fields, and an instance may also add capabilities beyond the ones Usher ships, so the dictionary this
endpoint returns covers both vocabularies rather than categories alone. The list of categories lives in Usher. Today nothing connects the two, so every instance
transcribes Usher's dictionary into each plugin's configuration by hand, once per schema, and keeps
it in step by remembering to.

**The proposal.** An introspection endpoint on the controller returning the category dictionary,
reachable only by a bridge and encrypted to that application's key, the same way an Usher token is.
Plugin configuration is then generated against it rather than copied.

**What it carries, and what it must not.** It carries category names, which is all Usher has: what a
category selects is defined per schema and Usher never learns it. So this does not weaken
data-agnosticism, and it must not become a route to enumerate resources, grants or principals, which
would make it a second and unaudited read of the policy store.

**Why it is encrypted rather than open.** The dictionary is disclosive on its own: it names what
kinds of governed data exist on the platform. Wrapping it to the requesting application's key reuses
the key material already provisioned for Usher tokens, adds no new distribution problem, and keeps
the list unreadable to anything that is not a bridge.

**What it gives beyond convenience.** With the full list in hand a plugin can compare its own
configuration against it at startup and refuse to start when a category has no mapping. Today an
unmapped category fails closed at request time, which is the safe direction but presents as data
quietly missing. This moves the detection to instance, which is the position taken elsewhere in
this document: a check that configuration can answer should fail startup rather than warn, because no
request-time behaviour repairs it.

**It is the compensating control for computing `open` by complement, which is the real reason to
build it.** Where `open` means "carrying none of the known categories", a category the plugin has no
mapping for is not in the set being subtracted, so records carrying it satisfy the complement and are
served as open. The failure is silent and points the wrong way: an unmapped category does not hide
its records, it exposes them. Checking the configuration against Usher's dictionary at startup is
what closes that, and it is why this is not merely a convenience that saves transcription.

**A category appears for one of three reasons, and only the third is urgent.**

| Why a category appears                          | Risk while the plugin does not know it                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| segmentation planned ahead of an upload         | none; no records carry it yet                            |
| data is being or has just been uploaded         | records arrive under a category the plugin cannot select |
| data already present is being further segmented | **records currently served as open are no longer open**  |

The third is a tightening, which makes it the same shape as revocation: it has to reach the plugin
promptly or the plugin keeps serving as open what has just stopped being open. The first two are
harmless if they arrive late.

**So the dictionary follows the revocation channel rather than a polling interval**, for the same
reason revocation does: the cases that can wait are the ones that widen, and the case that cannot is
the one that narrows.

**Mapping is configured application-side first, then in the controller**, because the two orders fail
in opposite directions. Map the category in the plugin before defining it in Usher, and the plugin's
predicate subtracts from `open` while nothing yet grants the category: matching records are hidden
until Usher catches up. Define it in Usher first, and it is absent from the set the plugin subtracts:
matching records are served to everyone until the plugin catches up.

**Which makes the two mismatches different faults, not one.**

| Mismatch                                                  | What it means                                               | Response                 |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| the controller knows categories the plugin does not       | the plugin cannot select records it is supposed to exclude  | refuse: this is the leak |
| the plugin maps categories the controller does not define | predicates nobody grants against, hiding records needlessly | warn: nothing is exposed |

**The check belongs in the controller, and it withholds resources rather than blocking an
application.** A plugin cannot perform it: it learns what a principal holds, never what a resource
declares, and what a resource declares is Usher's to know. So the plugin reports the categories it
can map, and the controller omits from the token any resource declaring one that is missing:

    plugin maps         controlled, indigenous
    STUDY_A declares    controlled             -> included in the token
    STUDY_B declares    controlled, nation_a   -> omitted

An omitted resource already means no access, so this needs no new enforcement path and no new
failure mode. It also contains the fault: a category the plugin cannot map takes out the resources
that carry it, not every catalogue the application serves. A wholesale refusal would make adding any
category a platform-wide risk, which is a good way to discourage anyone from adding one.

**Timing.** All of this applies from the first release. The enforcement clause names the category
field, so a plugin needs a category-to-field mapping to render any clause at all, and `open` is
computed as the complement of the mapped concrete values. That is what makes the check load-bearing
rather than tidy: a category the plugin cannot map is absent from the set `open` subtracts, so records
carrying it satisfy the complement and are served as open. The fault the table above calls "the leak"
is that one, and it arrives with the first instance defining a second category.

### Decryption key distribution

Settled: the key is symmetric, one per controller-and-application pair, held in Vault or OpenBao and
delivered to both pods by the secrets operator. Plugins hold none. What remains open is rotation:
how often, and how a bridge picks up a new key without dropping in-flight tokens.

Options considered and not taken:

- Environment variable at deploy time (simple, but rotation requires redeploy)
- Issued by the controller itself via a key-exchange endpoint requiring mutual TLS or a bootstrap
  token

Key rotation strategy (frequency, how the bridge picks up a new key without downtime) is also
open. A rotation scheme must allow the old key to remain valid for in-flight tokens during the
switchover window.

### API contract

The specific endpoints, request/response shapes, error codes, and authentication scheme for the
Usher REST API are not yet defined. The Usher token exchange, revocation poll, and push
subscription endpoints all need a formal contract before plugins can be built.

### Permissions payload schema

**Closed.** The payload is written as a type, member by member, in
[security-workflow.md: The payload as a type](security-workflow.md#the-payload-as-a-type). It is
keyed by resource identifier, then by category, then by the entity acted on, then the actions held.
No role name travels in it, because the controller resolves a role to capabilities before writing the
token, so a plugin tests capabilities and never has to learn what an instance means by `viewer`. The
entity level exists because bare action names stop being readable once more than one entity can be
acted on: `read` alone does not say whether it is `record.read` or `field.read`. Versions are
negotiated at the exchange rather than carried for a reader to tolerate; see the payload-version
decision in [decisions.md](decisions.md).

What remains open is not the schema but where the type lives, which follows the package layout and
blocks nothing.

### Field-level restriction is a contract change, not a configuration one

**The payload can carry it and this seam cannot.** Field categories nest under a record category in
the token, so the wire format is settled. What is not is the boundary: an enforcement hook returns a
filter, a filter selects records, and which fields of a returned record are visible is a projection.
A predicate and a projection are different things, and the callback returns only the first.

**Established against the first integration's own interface rather than inferred**, where the hook's
type is a function from context to a query node with no vocabulary for field visibility. So field
restriction needs a second return channel from the bridge, or a widened one, carrying what to project
alongside what to select. It is the first thing this design has asked for that the seam cannot
express, and it is why field restriction is post-MVP for reasons beyond scope.

**Three properties the enforcing side reported, kept here because they generalize.**

A projection applied to the record path does not reach the aggregation path. Buckets are built from
field values, so a column excluded from returned records stays enumerable through its own facet, and
the restriction has to be applied at both points or it is not applied at all. This is why
`field.aggregate` is a capability separate from `field.read`.

A bulk export path is the most likely place for the restriction to be silently absent, because
nothing about it looks like a query: it may take explicit column descriptors from whoever invoked it rather
than deriving them, which makes the restriction an intersection with what was asked for rather than a
filter over what would otherwise be returned.

**The discovery tier needs a second widening, independent of the first, and they should be costed
separately.** `aggregate` without `read`, counts without rows, requires the enforcement hook to
answer one surface permissively and another not. It cannot: the hook is handed a request context and
no indication of which surface is asking, so one filter serves the record path, the aggregation path
and set materialization alike. Established on the enforcing side rather than inferred.

So there are two distinct changes at this boundary, not one field-level change. **Projection** lets a
plugin say which fields come back. **Resolver identity** lets it know which surface is asking. Field
restriction needs the first; the discovery tier needs the second; neither implies the other.

It does fail closed while unimplemented, which is the one piece of good news: a single filter serving
all three surfaces either permits them all or denies them all, and a principal granted
aggregate-without-read resolves to denied everywhere rather than to rows they should not have.

Removing a restricted field from a generated schema is an oracle and pruning it silently is not.
A client querying a field that has been removed fails validation with a message naming the field,
which discloses both that it exists and that they may not have it, and makes introspection differ per
principal. Returning nothing for it discloses neither. **That is only representable while the field is
nullable**, so a generator that marks a field non-nullable turns a prune into an error and the error
into an oracle. Whoever owns schema generation owns that constraint.

### Per-app translation design

How should the translation layer (permissions payload to app-native filter) be structured? Should
the `usher-bridge` library provide a translation interface that each app plugin implements, or is
the translation entirely the plugin's concern with no shared abstraction? The answer affects how
testable and consistent constraint enforcement is across apps.

### Per-plugin filter shape

Each plugin's translation algorithm (how it converts a permissions payload into its target service's
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
instances:

1. **Submission unit.** The boundary the submission service uses for write-access gating (an
   organization identifier, a programme code, a project ID). This is the unit the submitter's
   `context.scope` is checked against.
2. **Data service unit.** The cohort or collection identifier used by Lyric or SONG as a record
   attribute (the value that distinguishes which resource a record belongs to). This maps to the
   submission unit, but the mapping is instance-specific and may involve a transformation.
3. **Indexed field.** The field name and value Maestro emits into the search index from the data
   service unit.
4. **Plugin filter field.** The `fieldName` (and its expected values) the enforcement plugin uses
   to construct query filters from the Usher token's resource ID.

If any link is broken (the submission unit does not map to the data service unit, the data
service unit is not indexed, or the indexed field name differs from the plugin config) enforcement
is silently misconfigured. The plugin runs but produces incorrect filters with no error signal.

Each instance must verify this chain explicitly at plugin configuration time. Usher cannot
validate it: it has no visibility into submission schemas, data service models, or index mappings.
Startup validation (see Per-plugin filter shape above) can verify that named fields exist in the
index; it cannot verify that the chain is semantically correct end-to-end.

The authorization unit is also not guaranteed to be the same across all services in the pipeline.
A submission boundary of "organization" does not imply that the indexed field is an organization
identifier; it may have been transformed into a study or cohort identifier by the data service
layer. Instances must trace this explicitly rather than assuming the unit is preserved. See
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

**Live for the first release, because the enforcement clause names a category field.** The question
is whether the value that clause tests attaches to each indexed record or to a submission-shaped
parent the records hang from, and at what nesting depth. A clause written against a field that
actually lives on a parent does not produce correct per-record access control, which is what makes
this design-invalidating rather than an indexing detail.

Two things sharpen it. The category field carries the same two unverifiable preconditions as the
resource field, cardinality and nesting, and the search layer decides whether a clause is wrapped in a
`nested` query from its own catalogue configuration, which Usher cannot see. A field mapped nested but
not declared as such compiles to a flat filter with no error, failing closed for the positive
concrete-category clauses and open for the negated `open` one. So the nesting-depth question is not
only about whether the value is reachable, but about which direction it fails when the answer is
wrong.

### Access level changes and index freshness

**Superseded, and not only for MVP.** The premise is that the plugin filters on an indexed field
encoding the access level, which is a prescriptive field. Enforcement reads descriptive fields only,
so no indexed field changes when a grant changes and the two layers have nothing to disagree about.
The three open questions below are recorded as answered: no reindex is triggered by an access
change, no coordination owner is needed, and there is no window for the plugin to degrade through.
They return only if an instance chooses to filter on a prescriptive field, which this design
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
  access to the resource entirely, or surface a degraded state to the principal?
