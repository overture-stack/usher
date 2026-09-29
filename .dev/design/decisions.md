# Design Decisions

Key architectural choices and the reasoning behind them, including tools reviewed and not adopted.
Where a reviewed tool influenced the design, that contribution is noted.

---

## Tools reviewed before building

### Cerbos

Cerbos is a standalone PDP (Policy Decision Point) service. Applications send a request containing
user context and a resource; policies are defined in YAML or JSON files.

**Two response modes.** A check returns an allow/deny decision. `PlanResources` performs partial
evaluation and returns a query plan: a discriminated result of `KIND_ALWAYS_ALLOWED`,
`KIND_ALWAYS_DENIED` or `KIND_CONDITIONAL`, the last carrying an AST of operators, variables and
literals, with prebuilt adapters compiling that AST into ORM queries.

**It holds no grants.** Cerbos is stateless: the application passes the principal's and the
resource's attributes on every request. Policies may be stored in a database and changed through its
Admin API, but they are rules, not records of who was granted what, so the grants and who may change
them would stay in Usher whichever engine evaluates them.

**What it contributed.** The standalone PDP service pattern, rather than an embedded library, is
the right architecture for an access control service shared across applications, and its REST API is
a reference for Usher's decision API: a clear request schema (principal, resource, action) and a
structured, auditable response. Its query plan returns the same three-way result as Usher's
enforcement path.
`Enforcement` is the same three-way discriminated union and SQON is the same condition AST.

**Three requirements to test it against.**

1. **Enforcement against Elasticsearch through SQON.** Cerbos's query-plan adapters target ORMs in
   TypeScript, Python, Go and Java, plus a Java adapter emitting Elasticsearch Query DSL that is built
   from source, tested against Elasticsearch 8 and absent from the documentation. None targets SQON,
   and the first application's backend is reached through SQON, so this requirement asks what a SQON
   adapter costs to write.
2. **A revocation channel that pushes grant changes to adapters and suspends serving when the
   channel goes quiet past a grace period.** Usher's fail-secure behaviour depends on this. The
   open-source PDP reloads its own policies from disk or git and notifies no application of any
   change.
3. **Delegated governance:** a custodian holding grant authority over one category
   platform-wide, fully audited, holding no other administrative rights. This is what Indigenous
   data governance asks of the design, and the least likely to be satisfied off the shelf.

A management UI ships in Cerbos Hub rather than the open-source product (see below).

**Assessment status: not run.** The query-plan permission above satisfies the structured-output
requirement. The three above are what remains to test, and they are read from Cerbos's
documentation rather than from running it, checked on 2026-09-28 against v0.55.0.

---

### OPA as the decision engine

OPA (Open Policy Agent) is a CNCF-graduated general-purpose policy engine. Policies are written in
Rego and evaluated against input data. OPA is widely adopted for Kubernetes admission control and
API gateway authorization.

**What it offers.** OPA is mature, well-maintained, and well-recognized. Teams familiar with
OPA from Kubernetes work know how to operate it, write policies, and integrate it into CI/CD. Using
OPA as Usher's evaluation engine would have offered ecosystem familiarity as an adoption benefit.

**What it contributed.** OPA's concept of partial evaluation directly influenced the Usher token
design. In partial evaluation, OPA accepts some known facts and some unknown ones, and produces a
residual: an unevaluated expression that represents the remaining grants. Usher's grants
token is the same idea in a different form: rather than returning a binary answer, Usher returns the
full set of category grants for the requesting application. The adapter applies that set as a query
filter, which is structurally a residual evaluation applied at the data layer.

OPA also reinforced the value of externalizing authorization state as explicit, queryable data
rather than encoding it implicitly in application logic. That principle is central to Usher's grant
model.

**Why not adopted.** Usher's decision logic is a grant data lookup, not policy evaluation. The
question "what can this user see or do?" is answered by querying which grant records exist for that
user. There is no Rego logic to evaluate: the policy IS the grant record. Using OPA would mean
feeding the grants database into OPA's data store and writing Rego that simply reads it back. That
adds operational complexity (data sync between the grants store and OPA, Rego maintenance) without
adding functionality. OPA's migration benefit (ecosystem familiarity) also depends on exposing Rego
policies as a customization surface; if the Rego is internal, that benefit does not transfer. If it
is exposed, it adds significant complexity to what is currently a clean, well-defined data model.

**It now produces filters itself, which does not change the answer.** Since v1.9.0 (September
2025), open-source OPA's Compile API turns a policy's residual into SQL for PostgreSQL, MySQL, SQL
Server and SQLite, or into UCAST conditions, a feature previously confined to Enterprise OPA. It has
no Elasticsearch target, and no output format touches the objection above, which is about the
grants being the policy.

**Its maintainers moved and its status did not.** OPA's original developers moved from Styra to
Apple in August 2025. The project remains CNCF graduated, with maintainers from Apple, Google and
Microsoft voting by organization; Enterprise OPA was contributed to it and then archived in June 2026,
and releases continue (v1.21.0, September 2026).

**Conditions for revisiting.** If a future requirement introduces conditional policy logic that
cannot be expressed as grant records (e.g., "grant access only if the user has completed training
Y, as asserted by institution X"), OPA becomes a much better fit as the evaluation engine for that
layer. At that point, the grant model would feed data into OPA and Rego would express the
conditions. This is worth reconsidering before implementing any conditional evaluation feature.

**GA4GH Passport interpretation is that requirement, and it is already in scope.** Evaluating
signed Visas from multiple issuers against a trusted-issuer list, with per-Visa expiry, is
conditional policy over claims rather than a grant-record lookup, so the objection above does not
reach it. The reference work in this space pairs Keycloak with Rego for exactly this. See the
GA4GH Passport item in `.dev/roadmap.md`.

---

### OPA at the enforcement layer

Separate from its role as a decision engine, OPA was considered as a component within enforcement
adapters: the per-application code that receives the Usher token and translates it into
data-layer query filters.

**What it offers.** The mapping from a category grant set to a concrete query filter (e.g.,
"category `registered` in resource `cohort-A`" maps to a specific Elasticsearch DSL fragment or SQL
predicate) is instance-variable and schema-specific. OPA is designed for precisely this kind of
externalizable, auditable policy logic. Organizations already running OPA sidecars could
potentially integrate Usher's enforcement by adding a policy bundle rather than embedding a new
library.

**What it contributed.** The sidecar instance model: the adapter does not need to be embedded in
application code. It can run as a separate process called by the application. This pattern,
well-established in OPA instances, is a valid option for Usher adapters and the adapter interface
is designed to accommodate it.

**Why not mandated.** OPA keeps its data current by pulling bundles from a bundle server, refined by
long polling and by delta bundles carrying data only. Data can also be pushed into it through its
REST API, but only by something outside it: open-source OPA has no streaming source of its own, and
third-party projects such as OPAL fill that gap. Usher's revocation channel is a push model: the
adapter must subscribe to real-time grant change notifications and invalidate its cached token
promptly. These two models do not align. Pulling, however refined, leaves a staleness window that
conflicts with Usher's revocation guarantees. The time-critical parts of enforcement (revocation subscription, fail-secure on channel
disruption) still require custom adapter code regardless of whether OPA is involved. OPA would
cover only the filter translation slice of an adapter that still needs custom revocation handling.

**Decision.** OPA is not required at the enforcement layer. The adapter SDK handles the generic
parts: JWE decryption, revocation channel subscription, TTL management, and fail-secure response.
Teams with existing OPA investments can use OPA for query filter translation within their adapter
implementation. The adapter interface is designed to accommodate this without requiring it.

---

### Cerbos Hub

Cerbos Hub is a commercial product that adds a management UI and policy distribution on top of the
open-source Cerbos PDP. It began as SaaS only; since 22 January 2026 it is also available on premises
and air-gapped, at the enterprise tier. It is not open source.

**Why not adopted.** Vendor dependency and commercial licensing make it unsuitable as a required
component of an open, self-hosted platform. Not evaluated technically.

**What its interface covers.** It authors and distributes policies, including a guided editor for
role-based ones, and records nobody's grants: a custodian's half of the problem is absent from it as
much as from the open-source PDP.

**What it told us.** The existence of Cerbos Hub is informative: the Cerbos team built it because
Cerbos without a UI has significant adoption friction. Authorization services need a management
interface for non-technical administrators to manage grants, review access, and respond to
governance inquiries. This is not a nice-to-have. Usher's design includes the management UI
(PAP layer) in scope from the start rather than treating it as a later addition.

---

### Keycloak Authorization Services

**Status: closed. Keycloak is not the replacement, and Usher is not built inside it.** It was the
candidate most likely to make part of this project redundant, and it is already deployed in the
target environment, which is why it stayed open longest. The reasoning is recorded below in full,
because a question this cheap to re-ask will be re-asked.

**Two questions were being held as one.** Adopting Keycloak Authorization Services means using its
model instead of building one. Shipping Usher as a Keycloak extension means keeping this model and
running it inside Keycloak's process. Both are closed, and the second was never written down at all,
which is how it kept coming back.

**The decisive reason is the same for both, and it is a commitment already made elsewhere.**
Authorization has to stay independent of the identity provider. Three documents state that Usher's
design does not depend on Keycloak specifically and that other providers follow the first release.
Either form of this forecloses that absolutely: the architecture deliberately refuses to be tied to
the identity provider, and the policy model would live inside it.

**Three more, in descending weight, for the extension form specifically.**

The grants live in their own database, away from the accounts, so that an identity provider owning
authorization policy does not become a single point of failure for both layers. Running inside
Keycloak invites using Keycloak's store and collapses that separation by convenience rather than by
decision.

The revocation channel holds long-lived push connections out to every bridge, with fail-secure
suspension when it goes quiet. That is not what an identity provider's process is shaped for, and
putting it there makes Keycloak's availability into the data plane's availability by a new route.

An extension is coupled to Keycloak's version, so upgrading the identity provider gates every Usher
release, and the admin surface lands inside Keycloak's console. This design exists to keep people
out of that console: the recorded reason for the layer is that administering access through Keycloak
means handing someone the controls for the whole identity system.

**The two open questions are answered from its documentation, without running it,** checked on
2026-09-28 against Keycloak 26.7.4.

1. **A filter: no, though it can list.** A single request with `response_mode=permissions` returns
   all of a user's permissions, but as a list of resources registered in Keycloak rather than a
   filter, so every protected object would first have to be registered there as a resource.
2. **Delegated governance: no.** It has no way to hand someone part of one resource server's
   policies. The realm roles for managing authorization cover every resource server in the realm,
   and fine-grained admin permissions (version 2, supported since 26.2) grant management of a
   client's authorization settings as a whole, so a custodian over one category has no counterpart.

Neither changes the decision, which rests on provider independence. Authorization Services itself is
supported and not deprecated, and the experimental AuthZEN endpoint added in 26.7 evaluates requests
without searching resources.

**This closes Keycloak only.** The build-versus-adopt re-evaluation has two steps left, and the
Cerbos query planner is still a live candidate for the evaluation step inside a standalone Usher.
Adopting an engine for that step is compatible with everything above; adopting an identity provider
as the policy store is not.

**What it does offer, recorded so that the decision is not read as dismissal.** Keycloak
Authorization Services provides resources, scopes, permissions and policies; supports role-based,
attribute-based and context-based access control or any combination; is administered from the
Keycloak admin console; and issues a token carrying the permissions granted. That is the hybrid
pattern, a management interface, and structured grants in a token, which were three of the four
reasons recorded for building rather than adopting. The fourth is the one that decided it.

---

### The wider landscape: "what can this principal access" is now a standard feature

Recorded because the reasons for building were written against a narrower field than currently
exists, and any of these could displace part of this design. Checked against each project's
documentation and releases on 2026-09-28; the sources are listed at the end of this section.

| Project | What it offers here                                                                                     | Model                           | Status, September 2026                                                   |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| Cerbos  | Query plan as a filter AST, with ORM adapters and an unpublished Java one for Elasticsearch            | Policy as code, attribute-based | v0.55.0; Hub on premises at the enterprise tier                          |
| OPA     | Compile API emitting SQL or UCAST filters, since v1.9.0                                                 | Policy as code (Rego)           | CNCF graduated; v1.21.0                                                  |
| OpenFGA | `ListObjects` returns identifiers, 1000 per call unless streamed; `ReadChanges` is polled               | Relationship-based (Zanzibar)   | CNCF incubating since October 2025; Auth0 FGA is its hosted form         |
| SpiceDB | `LookupResources`; a Watch API streaming relationship changes, replayable for about a day               | Relationship-based (Zanzibar)   | Apache-2.0, v1.56.2; search-index replication only in hosted Materialize |
| Permify | Data filtering and lookup; a Watch API                                                                  | Relationship-based (Zanzibar)   | Acquired by FusionAuth in November 2025; AGPL-3.0, releases slowed       |

Three qualifications. Most of these implement relationship-based access control, which differs from
role-plus-attribute in how policy is expressed rather than only in vocabulary. Oso's open-source
library has been deprecated since December 2023, and what remains active is commercial, hosted or
since May 2025 a self-hosted beta, so it sits outside scope here. And SpiceDB's replay window is the
datastore's garbage-collection window, typically 24 hours, so a subscriber away longer than that
cannot catch up from the stream.

**None of them emits a filter for a search engine.** They return lists of identifiers (OpenFGA,
SpiceDB, Permify) or filters for SQL (OPA) and ORMs (Cerbos), with Cerbos's unpublished Java adapter
the one exception, and nothing above emits SQON.

**The relationship stores do not decide who may write a relationship.** OpenFGA checks no write
against its model, so any credential allowed to write tuples can write any tuple, including a
custodian granting themselves read access. The check belongs to whatever administers the store, which
here is Usher.

**Two hosted services, for completeness.** Auth0 FGA runs only as Auth0's service, in the United
States, the European Union and Australia or in a private cloud operated by Auth0, with no Canadian
region. Permit.io hosts its control plane by default and offers it on premises at its enterprise
tier.

### Comparable platforms in biomedical data sharing

Checked on 2026-09-28. These are reviewed to learn from rather than as candidates for adoption: each
is either part of another platform or answers a different part of the problem.

**Gen3.** Its authorization belongs to a platform occupying the same place as Overture, so adopting
it would mean adopting that platform. What it does is still the nearest existing match to Usher's
first release:

- Arborist, its policy engine, grants roles over resource paths arranged as a tree. It answers a yes
  or no for one request, and also returns a map of every resource reachable by a user, with the
  actions allowed on each.
- Guppy, its search service over Elasticsearch, applies that map as a filter on a field carried by
  every document, which is the bridge's job here. Each index sits at one of three access levels:
  authorized records only; aggregations over everything, subject to a minimum count; or everything.
- Requestor, its access-request service, lets an approver act for one project's resource path without
  administrator rights.
- Fence, its authentication service, consumes GA4GH Passports issued by NIH RAS.

**What to take from it.** Guppy's minimum count is a small-cell threshold shipped as a per-index
setting, and the first integration applies none
([count-only principal](../docs/atlas/roadmap/count-only-principal.md)). Its limits against Usher's
requirements are where this design differs: access stops at program and project, so there are no
categories within a dataset; the filter is applied inside Guppy, one application; and an approver is
scoped by resource path, so authority over one kind of data across every dataset would need a policy
per project.

**Apache Ranger.** Central policy administration, enforced by plugins inside each data engine.

- Row-filter and column-masking policies exist for Hive, Trino, and Spark through Apache Kyuubi. Its
  Elasticsearch plugin controls whole indices only.
- A policy's delegated-admin flag and security zones let people manage the policies for a subset of
  resources without full administrator rights, the nearest existing form of a custodian's authority.
- Plugins pull policies on a schedule. Version 2.9.0 (August 2026) added a standalone decision
  service. Apache-2.0.

**CanDIG v2.** A Canadian federated genomics platform using OPA. A shared service works out which
programs a user may access for a given path and method, and several services filter on that, with
site administrator, program curator and team member as the roles. Access stops at program level.
LGPL-3.0, v8.0.2 (September 2026). It is the working example of building this layer on a general
policy engine.

**Upstream of enforcement: REMS, DUOS and GA4GH Passports.**

- REMS manages applications, approvals and licences, sends each entitlement to a configured endpoint,
  and can issue signed GA4GH `ControlledAccessGrants` visas. Organization owners administer only their
  own organization's items. MIT.
- DUOS runs data access committee review against GA4GH DUO codes and records approvals, leaving access
  to be provided elsewhere. It runs as a Broad Institute service.
- A GA4GH Passport (v1.2) names its holder's approved datasets or objects, never records.

All three decide or assert who is approved, and none enforces anything when data is queried, so each
is a possible source of grants for Usher rather than an alternative to it.

**No system found filters records within a dataset consistently across several applications.** Guppy
filters records inside one application, at project level; CanDIG and Terra's SAM share a user's
authorized list across services at program or workspace level. That is a search coming up empty, not
a proof.

### The case for building, stated against this landscape

Four requirements carry it, and the check above sharpens each:

| Requirement                                       | What exists                                                                                                                   | What is left to Usher                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Delegated governance                              | Relationship stores express a custodian's check but do not enforce it on writes; Ranger's zones and Gen3's Requestor bound an administrator by resource | Authority over one kind of data across datasets, enforced     |
| Independence from the identity provider           | Every engine above already has it                                                                                             | Distinguishes Usher from Keycloak only                         |
| Push revocation with fail-secure suspension       | SpiceDB's Watch pushes relationship changes; OpenFGA is polled; Ranger and OPA pull; none suspends when its channel goes quiet | The push to every application, and the suspension             |
| Enforcement against Elasticsearch through SQON    | Only Cerbos's unpublished Java adapter targets Elasticsearch; nothing emits SQON                                               | The SQON path, as an adapter whichever engine evaluates        |

Structured grants output is supplied by several of the engines above, so it belongs among the
requirements to evaluate rather than among the reasons to build. Restate this section once an
evaluation has been run.

**Sources, checked 2026-09-28.**

- Cerbos: <https://docs.cerbos.dev/cerbos/latest/api/index.html>,
  <https://github.com/cerbos/query-plan-adapters>,
  <https://www.cerbos.dev/blog/cerbos-hub-now-available-on-premise>
- OPA: <https://github.com/open-policy-agent/opa/releases/tag/v1.9.0>,
  <https://www.openpolicyagent.org/docs/management-bundles>,
  <https://github.com/open-policy-agent/opa/blob/main/MAINTAINERS.md>,
  <https://github.com/open-policy-agent/eopa>
- Oso: <https://github.com/osohq/oso>, <https://www.osohq.com/post/oso-self-hosted-beta>
- Keycloak: <https://www.keycloak.org/docs/latest/authorization_services/index.html>,
  <https://www.keycloak.org/server/features>,
  <https://www.keycloak.org/securing-apps/authzen-authorization>
- OpenFGA: <https://openfga.dev/docs/getting-started/perform-list-objects>,
  <https://openfga.dev/docs/interacting/read-tuple-changes>,
  <https://openfga.dev/docs/getting-started/setup-openfga/access-control>,
  <https://www.cncf.io/blog/2025/11/11/openfga-becomes-a-cncf-incubating-project/>
- SpiceDB: <https://authzed.com/docs/spicedb/concepts/querying-data>,
  <https://authzed.com/docs/spicedb/concepts/watch>,
  <https://authzed.com/docs/authzed/concepts/authzed-materialize>
- Permify: <https://fusionauth.io/blog/fusionauth-permify-pr>,
  <https://github.com/Permify/permify/releases>
- Auth0 FGA and Permit.io: <https://docs.fga.dev/getting-started>, <https://docs.fga.dev/private-cloud>,
  <https://docs.permit.io/how-to/deploy/on-prem/installation/>
- Gen3: <https://github.com/uc-cdis/arborist>, <https://github.com/uc-cdis/guppy/blob/master/README.md>,
  <https://github.com/uc-cdis/guppy/blob/master/doc/queries.md>,
  <https://github.com/uc-cdis/requestor/blob/master/docs/authorization.md>,
  <https://github.com/uc-cdis/fence/blob/master/docs/additional_documentation/user.yaml_guide.md>
- Apache Ranger:
  <https://cwiki.apache.org/confluence/display/RANGER/Row-level+filtering+and+column-masking+using+Apache+Ranger+policies+in+Apache+Hive>,
  <https://github.com/apache/ranger/blob/master/agents-common/src/main/resources/service-defs/ranger-servicedef-elasticsearch.json>,
  <https://ranger.apache.org/blogs/policy_model.html>
- CanDIG: <https://github.com/CanDIG/candigv2-authx>, <https://github.com/CanDIG/candig-opa>
- REMS, DUOS and GA4GH Passports: <https://github.com/CSCfi/rems/blob/master/docs/ga4gh-visas.md>,
  <https://duos.blog/help/faqs/>, <https://ga4gh.github.io/data-security/ga4gh-passport>

---

## Architectural decisions

### Usher token over binary allow/deny

A binary response from the PDP (allowed/denied) requires every application to call back to the
decision service on every data access, or to cache a broad allow/deny that cannot express partial
access. Neither fits a platform where a user may be permitted to see some records and not others.

Usher returns a structured Usher token: the full set of category grants held by the user, scoped
to the resources managed by the requesting application. The application adapter applies this as a
query-time filter. A single token fetch covers the session; the adapter uses it for every query
without a round-trip per request.

**Tradeoffs accepted.** The adapter must implement query filter logic, not just a gate check. This
is more work per integration. It is unavoidable: the filtering logic requires knowledge of each
application's query language and schema, and Usher cannot have it.

---

### Decrypted permissions never leave the service that decrypted them

**Decision.** A bridge decrypts an Usher token inside the service it belongs to, and the payload goes
no further. It is not forwarded to another service, not returned to a browser, and not logged. Where
an interface must show someone their own permissions, it is served a view rendered from the payload
rather than the payload.

**Why.** Encryption that stops at the boundary and then hands the plaintext onward is ceremony.
JWE's property, that a token delivered to the wrong place fails to decrypt rather than being
honoured, is only worth having if the decrypted form has the same blast radius as the key.

### The fast path invalidates by deletion, and there is no per-principal timestamp

**Rejected: a per-principal last-policy-change timestamp.** The fast path was to compare a token's
`generatedAt` against a marker on the principal, and the marker had no home in the schema and no
stated list of writes that touch it. Both halves are the same defect: **the marker was per principal
while the dangerous change is per resource.** Adding a category to a resource changes nothing about
any principal's own rows, so a principal-scoped marker does not move, their cached token stays valid,
and they keep reaching a resource that should have closed to them for up to one TTL. Making that
correct means enumerating every write that must reach across to every affected principal, which is a
list that has to be remembered, and the list is exactly what was missing.

**Deletion replaces it, per principal and per resource.**

**A cached payload per principal and audience, invalidated by deletion.** The controller writes the
computed payload to the shared cache when it issues a token. Anything that changes what that
principal holds deletes the entry. Absence means recompute, which, unlike a comparison, cannot be
subtly stale.

**A change to a resource's categories clears the whole cache.** A principal-scoped marker cannot see
it, and it can change what every principal reaches. Finding exactly the entries
naming the resource would need an index from each resource to its entries, which is a list to
maintain, so the controller clears every cached payload instead. Category changes are rare and
computing a payload is meant to be cheap, so the cost is one wave of recomputation, and clearing
leaves the cache's retention policy, not yet defined, with nothing to reconcile.

**Rejected: a category version per resource**, stored on the resource row, bumped by any
`resource_categories` write and compared on refresh with one recorded in the cache entry. It avoided
clearing the cache at the price of a persisted counter kept only for that comparison, an
optimization ahead of any measured cost.

**What the fast path then does.** On refresh the controller looks for the cached payload. Present
means reissue from it without recomputing; absent means a full recomputation.

Three things follow. **The cache entry holds the earliest grant expiry alongside the payload**, which
bounds every reissue. **The freshness test reads nothing supplied by the request**, which closes a
narrow substitution: presenting a valid IdP token together with some other principal's expired token
must not let the expired token decide whether a cached payload is current. It is low severity, since
forging a token needs the per-application key and a bridge holding that key can already mint payloads
directly, but a freshness decision should not rest on an input supplied by the request. **And the
payload carries no category version**: no adapter would read it, and omitting it spares a validator
a key-set invariant to enforce against `permissions`.

**A refresh is therefore the same call as the first exchange**, since the expired token had no other
stated purpose. The bridge sends an IdP token and its audience identifier in both cases. One
operation for the bridge rather than two, and the fast path becomes entirely internal.

**Reissue is not renewal, and the distinction is load-bearing.** What the cache saves is the
computation, never the expiry. A token's `exp` is no later than the earliest expiry among the grants
it drew on, so that earliest expiry is cached alongside the payload and bounds every reissue. A cache
hit must never extend a token past a grant that has since lapsed.

**The resulting asymmetry is the correct one.** A revocation or a category addition takes effect
at once, because both invalidate. A newly granted resource can lag by up to one TTL, because the
token names what the principal already had and nothing about the new grant invalidates the old entry.
Losing access is immediate and gaining it waits, which is the right direction for health data.

**"At once" holds end to end for a category change too, because it is announced like a revocation.**
A revocation names the principal and a category change names the resource, and on either a bridge
drops every cached token affected, signed in or not. The cleared cache is what a bridge that missed
the announcement meets at its next refresh, so a lost announcement costs at most one token lifetime
rather than correctness. See [the decision on announcing a category
change](#a-category-change-is-announced-to-the-applications-that-serve-the-resource).

**This is the access-and-refresh-token shape rather than a new one**, and saying so is what stops it
drifting into one. The Usher token is the access token, the exchange is the refresh, the IdP token is
the credential, and the fast path is introspection with a cache. The weakness is the familiar one, a
bearer token outliving a revocation, and the answers are the familiar two: a short TTL and a validity
check. Anything proposed here that has no counterpart in that shape is worth a second look.

**Payload versions are negotiated at the exchange and never tolerated at read time.**

The bridge sends the set of payload versions it supports. The controller emits the highest version in
the intersection, or refuses the exchange with a version mismatch. It never emits a version outside
the bridge's list, including a lower one it believes compatible.

**Read-time tolerance is what this avoids, and the reason is specific to an authorization payload.**
The usual rule, reject an unknown major and ignore an unknown minor, assumes an unknown field is
additive capability. Here an added field can **narrow**: a future version carrying a withholding
marker needed by embargo would be silently ignored by an older bridge and the failure direction is
open. Ignoring what you do not understand is safe for a document and unsafe for a
restriction.

**The directionality is asymmetric, and not in the intuitive way.** A newer bridge with an older
controller is benign: the payload declares its own version, the bridge reads it as that version, and
if the newer version had a restriction, the older controller does not know about it either, so
nothing is skipped. A newer controller with an older bridge is the dangerous direction, and it is
dangerous only because of the narrowing case above.

**A set rather than a single number**, because "highest common" otherwise rests on supporting version
N implying support for N minus one, which holds until someone drops an old reader. A set makes the
overlap a fact rather than an inference.

**Two consequences accepted.** The controller supports more than one payload version during a
rollout, so retiring one is a deprecation policy rather than a field. And anonymous access negotiates
like everything else, since an unauthenticated request still triggers an exchange, so there is no
special case.

**The first release has one schema, so the negotiation has nothing to choose between. Build it
anyway.** The handshake costs almost nothing while the intersection is always a single version, and
building it later costs a coordinated change at both ends: a bridge that never sent its supported set
cannot start being asked for one without being upgraded in step with the controller, and this whole
decision exists to avoid that lockstep. Built now, the second version is a controller-side
addition and nothing else.

**How a new version comes to exist is post-MVP and needs no answer yet**, because there will be one
schema until there is a reason for a second. What already governs it is the rule above: if an older
bridge could misread a change, the change is a new version rather than an amendment, and every added
field that narrows is such a change. Whether the process borrows an existing convention or gets one
of its own is a question for whoever writes version two.

**The payload is a type, and every member has to justify the layer it sits in.**

`PermissionsPayload` is in [security-workflow.md](security-workflow.md#the-payload-as-a-type), member
by member with the reasoning attached. The controller, the bridge and the conformance fixtures all
consume that single definition, which stops a mock from being right in an untested way.

**A member described in prose but never placed is a member whose placement nobody has had to defend.**
Two were in that state, the payload's own version and a category version per resource, each described
across the corpus without a name, a type or a home. `payloadVersion` justified its home and kept it.
Category versions did not, and were later dropped altogether: the fast-path decision above records
why.

**Unknown keys are tolerated at the entity level and nowhere above it.** That reads as an exception to
the no-read-time-tolerance rule and is the same rule applied: what matters is the direction skipping a
key fails in. An adapter that skips an entity it does not recognize serves nothing for that entity and
fails closed; an adapter that skips an unrecognized member of the payload root may skip a restriction
and fails open. Tolerance is safe exactly where ignorance narrows.

### A category change is announced to the applications that serve the resource

**Their bridges drop every cached token naming that resource**, signed in or not, and each affected
principal's next request exchanges for a token computed under the new categories. No list of
sessions is needed in Usher, since a bridge's token cache is the set of live tokens for its
application.

    1. An administrator adds `controlled` to some of a resource's records
    2. The controller clears its cached payloads, and the change is announced
    3. Every bridge of an application serving the resource drops the tokens naming it
    4. Each affected principal's next request exchanges for a fresh token
    5. Nobody who lost access keeps it past the announcement

**Only the applications that serve the resource hear it.** A token names only the resources managed
by its audience, so an announcement reaching every bridge would tell applications about resources
they do not serve, and audience separation exists to prevent that. The controller already knows which
audiences serve which resources, so the fan-out is filtered by audience rather than broadcast.

**Gaining access waits, which is the safe direction.** Someone who gains access, because a resource
opened or a category left it, holds no token naming it yet and gains it at the next refresh.

**The cleared cache is the backstop.** A bridge that missed the announcement meets a recomputed
payload at its next refresh, so a lost announcement costs at most one token lifetime rather than
correctness.

**Rejected: accepting a token lifetime of lag.** It would have kept the channel for withdrawn grants
only and dropped the claim that losing access is immediate, trading a guarantee for a fan-out.

### The Usher token is not an OAuth access token, and three separate tests say so

Each of the three has been asked as "why not just use the standard one?", and each answers the same
way, which is why they are recorded together rather than in three places.

**The registered claim for structured authorization is `authorization_details`, RFC 9396 (Rich
Authorization Requests).** It is the right family for this problem and the wrong shape for this
payload. RAR carries a flat array of objects, each with a required `type` plus optional `locations`,
`actions`, `datatypes`, `identifier` and `privileges`. Resource maps onto `identifier`, category onto
`datatypes`, and then it stops: `actions` is an array of strings, so the entity axis has nowhere to go
but back inside the action string as `record.view`. The entity level was introduced to undo precisely
that collapse, as recorded above. Field categories fare worse, since RAR is explicitly flat and
prescribes "separate objects rather than nesting", and its cross-product reading of one object, all
actions at all locations, cannot express `clinician` holding `count` and `view` beside `basic`
holding only `view`.

**RAR's own members could have carried the map** as a type-specific field, since a RAR `type` governs
what else its object may contain. That gives a registered claim name and a discriminator, at the cost
of a wrapper and an array whose length is always one. A map exists for exactly that shape, and this
payload already rejected the array once, when the resource list became a map.

**The deciding argument is what the token is for.** RAR's value is discoverability by relying
parties outside the issuer's control. This token is encrypted to one application's key, travels
controller to bridge, is never presented by a client and is never read by a third party.
Standardizing an interface with one implementation on each side gains nothing. **If a third party
ever reads this payload, revisit this**, since that is the argument's premise rather than its
conclusion.

**The claim set converged on RFC 9068 without anyone aiming at it, and the gaps are the interesting
part.** The JWT profile for OAuth access tokens requires seven claims. Five are already here.

| RFC 9068 §2.2              | Here                           |
| -------------------------- | ------------------------------ |
| `iss`, `exp`, `aud`, `iat` | present                        |
| `sub`                      | present, `null` when anonymous |
| `client_id`                | absent                         |
| `jti`                      | absent                         |

**`client_id` has no meaning here.** In OAuth it names the client that requested the token, distinct
from `aud`, the resource server that receives it. The bridge requests a token for the application it
runs inside, and the token is encrypted to that application's key, so the two would always name the
same thing. A claim permanently equal to another claim is noise.

**`jti` is required there to let a resource server detect a token replayed by a client.** No client
presents this token. The bridge receives it from the controller and never accepts one from anywhere
else, so there is no presentation to replay, and revocation acts on the principal over the push
channel rather than on a token identifier. Absent by reason rather than by omission.

**`sub: null` has no counterpart there.** An authorization server with no end user sets `sub` to the
`client_id`. An anonymous principal here is genuinely nobody.

**`roles`, `groups` and `entitlements` (§2.2.3.1) look applicable and are not.** No role name travels
in this token, because the controller resolves a role to capabilities at issuance so that an adapter
never learns what an instance means by `viewer`. Carrying `roles` would undo that.

### `typ` is `usher+jwt`, and deliberately not `at+jwt`

BCP 225 §3.11 asks for explicit typing against cross-JWT confusion, and RFC 9068 gives `at+jwt` for
access tokens with that same rationale. This token misses three of that profile's requirements, so
using `at+jwt` here would falsely assert conformance to it: the parameter would cause the very
confusion it exists to prevent rather than defend against it.

`usher+jwt` says what the token is: a bridge reading it knows it is not an access token and must not
be validated as one. The `<thing>+jwt` shape follows `at+jwt` and BCP 225's own `secevent+jwt`.

**This is defence in depth rather than a hole being closed.** Usher issues one JWT kind, API keys are
opaque strings by decision, and the IdP's token is a three-part JWS under asymmetric keys against a
five-part JWE under a per-application symmetric key, so §3.12's mutual exclusivity already follows
from the key separation. The parameter is one header member and becomes load-bearing once a second
kind exists.

### `generatedAt` follows an established pattern and is not an invention

No registered claim carries its meaning, and two carry its shape: `toe`, the time of event in a
Security Event Token (RFC 8417 §2.2), and `auth_time` in OpenID Connect Core §2. Both are a second
timestamp recording when the underlying thing happened, distinct from `iat` and deliberately
unmoved by a reissue that resets it. That is exactly the relationship here.

**`updated_at` (OIDC Core §5.1) reads closest and must not be reused.** "Time the information was last
updated" describes the payload well, but it is a UserInfo claim about the end user's own profile
record, and reusing a registered name to mean something else is what BCP 225 §3.12 warns against.

### The token is encrypted with `dir` and A256GCM, under a key per application

**The algorithm is `dir` with A256GCM, and the key is symmetric and per application.**

**Per application is the part that is load-bearing.** One key shared by every bridge would let any
bridge decrypt any other application's tokens, which makes the `aud` claim a string comparison rather
than a boundary. Distinct keys per controller-and-application pair make audience isolation
cryptographic: a compromised bridge cannot read another application's tokens at all.

**An audience identifier is per deployed instance.** Two independently deployed instances of one
application cannot share one, since sharing an identifier would mean sharing a key, and audience
separation is cryptographic rather than a comparison of strings.

**Symmetric, because the deployment already distributes secrets and asymmetry adds nothing here.**
Keys live in Vault or OpenBao and reach both pods through the secrets operator, so asymmetry would
solve no provisioning problem, no key-exchange endpoint is needed, and the controller fetches no
public key from an application. `dir` also carries no wrapped key, which is the smallest
token and the fastest decrypt on the only cryptographic operation in the request path.

**The objection to symmetric, and why it does not bite.** A bridge holding the key can mint tokens as
well as read them. It is the enforcement point for its own application, so an attacker holding that
key is already inside the process deciding what that application's store returns, and forging a token
grants nothing that ignoring enforcement would not. It cannot forge for another application, because
that key differs.

**What is given up, stated so a later reader can weigh it.** With asymmetric keys every token that
exists was issued by the controller and is therefore in the controller's exchange log, which sits
outside a compromised application's control. Symmetric allows access with no exchange event, so that
detection surface is weaker. It is accepted because the audit trail is a detection surface rather
than evidence against a compromised ushered application, and because such an application can read its
own store without any token at all. **Revisit if a less-trusted application is ever ushered**, where
the argument turns on the trust assumption rather than on the cryptography.

**Consequence for user interfaces.** An interface wanting Usher state needs a server side that holds
a key, which is a backend-for-frontend holding a bridge rather than a browser calling the controller
directly. A browser-only application can still be served data, since enforcement happens in the data
service, but it cannot host a surface built on permissions without gaining that server side.

**Tradeoffs accepted.** A client-only application needs infrastructure it may not have, which is a
real cost where one genuinely cannot exist. It is smaller than it first appears for the interfaces in
view: both Overture portals are the same framework and can host a server side, and the one that does
not is unconfigured rather than architecturally unable, so the cost there is setup carried across
from the one already running it. The alternative trades a structural guarantee for an operational
convenience, and the design chose an encrypted token over a signed one for that guarantee.

---

### JWE (encrypted) over JWS (signed) for the Usher token

**Primary rationale: audience separation is enforced cryptographically, and fails closed.**
Usher tokens are audience-scoped per application. Encrypting each token to the target
application's own key means an application physically cannot read a payload issued for a
different one. A controller defect that computes or routes a payload to the wrong audience
becomes a decryption failure at the receiving bridge rather than a silent cross-application
grant leak. With a signed token, the same defect produces a readable payload and the audience
claim is enforced only by whatever code remembers to check it.

Encrypting to the audience follows the fail-secure posture of the rest of the design: an internal
fault should deny access, not widen it. See the revocation-channel decision below for the same
principle applied to connectivity loss.

**Secondary rationale: grant sets stay out of places they could be disclosed incidentally.** A signed
payload is readable wherever it happens to land: request logs, error reports, crash dumps,
tracing spans. An encrypted payload in any of those places discloses nothing. This does not
depend on the token reaching an untrusted party; it only requires that something logged it.

**The token never transits the user agent.** The bridge is a library embedded in client data
services and obtains the Usher token from the controller directly, so the two rationales above are
the whole of the case: neither depends on where the user sits.

**Tradeoffs accepted.** Each bridge needs a decryption key provisioned at deploy
time, and audience scoping makes those keys per-application rather than instance-wide. Key
rotation is an operational concern that would not exist with a signed token. The cost is smaller than
it first appears because the deployment already solves it: keys live in Vault or OpenBao and reach
both the controller and the application through the secrets operator, so onboarding an application is
a secret written once and injected into two pods rather than a provisioning problem of its own. For
the full mechanism, see
[security-workflow.md: Usher token format](security-workflow.md#usher-token-format-jwe).

---

### A category selects records within a resource; only multi-category records are deferred

A record is visible if the principal holds every category carried by **that record**, for the
resource it belongs to. A resource of mixed sensitivity serves each principal the records reached by
their categories, rather than being reachable in full or not at all.

**What this means concretely**, for a resource with unmarked and controlled records:

    Ana holds unmarked    reaches the unmarked records, and nothing else in that resource
    Bo holds controlled   reaches the controlled records
    Bo holds both         reaches both sets

**The enforcement clause is two field tests, not one.** The adapter matches the resource's field value
and the category's field value together, as a conjunction, and composes one such clause per grant with
`or`. Both are single-valued exact matches, so a category costs no more to enforce than a resource
does. `unmarked` is the exception in shape rather than in principle: being the residual it has no value of
its own, so its clause excludes every configured concrete value instead of matching one.

**What is deferred is a record carrying more than one category at once**, which needs a subset test,
and the query layer cannot yet express one on a flat field. Until that lands, a record carries one
category, and the table below describes what the subset test will enforce rather than a rule running
today.

**The word "every" applies to what the data requires, not to what the principal holds.** The wording invites
a misreading worth heading off: it does not mean a principal reaches only where all their categories
apply at once. Holding more categories always reaches more data, never less. Worked at record
granularity, for a principal holding both `controlled` and `indigenous`:

| Record carries                | Holding both | Holding `controlled` only |
| ----------------------------- | ------------ | ------------------------- |
| nothing                       | Visible      | Visible                   |
| `controlled`                  | Visible      | Visible                   |
| `indigenous`                  | Visible      | Hidden                    |
| `controlled` and `indigenous` | Visible      | Hidden                    |

So holding both yields the union of the two segments _and_ their overlap, which is the intuitive
reading. What holding only one does not yield is the overlap, because data requiring two grants
is not reachable with one. The conjunction is inside a single record's requirements and never
across a principal's grants.

**Why every category rather than any.** Categories are restrictions, and a restriction that can be
bypassed by another is not one. If holding any single category were enough, a principal holding
`controlled` would reach a record also carrying `indigenous`, without the grant required by that
second category. This is not specific to community governance: it holds for any two independent
restrictions, and community governance only makes the consequence severe.

Two properties follow. Adding a category to a record can only narrow access and never widen it, which
lets an instance introduce a classification without auditing existing grants. And an unrecognized
category fails closed where a record carries it alongside a known one, contributing no clause, where
the any-category rule would leave the record reachable through whichever category the principal
happens to hold.

**The `unmarked` complement is where an unrecognized category fails the other way**, and the startup
check in `adapter-integration.md` exists because of it. A category value unmapped in the adapter is
absent from the set subtracted by `unmarked`, so records carrying it satisfy the complement and are
served as unmarked. Checking the adapter's category configuration against Usher's dictionary at
startup, and failing startup rather than warning, is what closes that.

**Unexercised in v1.** Where an instance defines one category, all-versus-any is not observable.
The first instance defines one, so nothing depends on this rule until a second arrives.

**Categories are restrictions, not partitions**, and the distinction survives a category selecting
records. A category states a condition for reading a record; it does not name a slice granted
instead of the rest. Expressing which part of a resource someone may reach on
grounds other than sensitivity is still a different mechanism, either narrowing on a further field or
a second concept, rather than a reinterpretation of this one.

Enforcement filters on two fields, and the emitted clause pairs them:

    or(
      and( in(<resource field>, [HEART_STUDY]), in(<category field>, [controlled]) ),
      and( in(<resource field>, [HEART_STUDY]), not-in(<category field>, [...every concrete value]) )
    )

The second disjunct is `unmarked`. Both fields must be single-valued, and each must be mapped in the
adapter's configuration for the catalogue it serves.

**The filter cannot verify two dependencies about either field**, so both are preconditions asserted
by an integration rather than properties guaranteed by the model:

| Dependency                                                                        | Visible to                        |
| --------------------------------------------------------------------------------- | --------------------------------- |
| Whether the field is mapped `nested` (the compiler's `nestedFieldNames` argument) | Neither the query nor the SQON    |
| How many values the field actually holds                                          | Neither the query nor the mapping |

Both fields must be single-valued, and no running code checks it: the mapping cannot express
cardinality, and the search layer's filter path carries no instrumentation that would notice a field
gaining a second value. See [adapter-integration.md](adapter-integration.md) for why this is
unverifiable today rather than merely unverified, and for the `nestedFieldNames` hazard, which lands
on the permissive side for the negated `unmarked` clause specifically.

A positive `in` clause on a single-valued field is an exact match whether the field is flat or nested,
so neither dependency applies to the concrete-category clauses. They apply to the `unmarked` clause,
because it is the negated one.

**The resource field name is adapter config, set per catalogue, and those fields are homologues across
data types.** One slot, filled differently for each body of data served by an instance, which is the
instance-vocabulary position stated further down applied at the enforcement layer. An application's
own container may be coarser: Arranger can compose a second type into one `catalogueId`, backed by an
unrelated index while inheriting that field, and the resulting filter names a field missing from that
index.
See [adapter-integration.md](adapter-integration.md), which records why that failure is silent. Usher
never learns any of these field names.

Two properties generalize, as expectations rather than as observations of any
one instance:

- **Catalogues within a single instance will disagree.** Different bodies of data arrive through
  different submission services and expose different fields for the same role. An adapter that
  assumes one field name per instance is wrong; the mapping is per catalogue. Confirmed in the
  first instance rather than anticipated: the clinical catalogue identifies resources by a study identifier, and
  the environmental catalogue has no such field at all, grouping instead on an organization code. A
  single global field name would compile to a clause against a field absent from one of the two
  mappings, which fails permissively.
- **A submission-level identifier can be a legitimate resource field, or a serious mistake, and the
  distinction is not visible in the field.** It is legitimate where the submitting body is the
  governance unit and the value comes from a registered vocabulary. It is wrong where it is used as
  a proxy for a property of the data. The same field name can be either, so the judgement is
  per-integration and belongs in that integration's own record.

**What MVP gives up.** A resource containing records of mixed sensitivity must be split into
separate resources; there is no sub-resource granularity. Under Indigenous data governance that is
arguably the correct outcome, since separately governed data gets its own resource and its own
custodian rather than living as a tag inside another study. Row-level and field-level narrowing
within a resource were already out of MVP scope, and record-level narrowing sits post-MVP alongside
SQON-scoped grants: they are the same permission, narrowing within a resource.

**Tradeoffs accepted.** Resolving the ambiguity this way makes four sections of
`permissions-model.md` describe a post-MVP model, and they are marked accordingly.

Instance-specific resource field names, catalogue topology, and the reasoning behind a given
integration's choice of field belong in that integration's own repository, not here. See
[adapter-integration.md](adapter-integration.md) for what an adapter must establish about a candidate
field before using it.

---

### Category names carry their scope from the first release

**Every category name is prefixed by its scope: `global.` for a category shared by the whole
platform, `resource.` for one that exists only in the resource it is listed under.** The first
release creates global categories only, and still names them `global.controlled` rather than
`controlled`, so the token, the adapter mappings, the audit log and the conformance corpus use from
the start the names needed by local categories. Adding the prefix later would change every token,
every mapping and every recorded event at once. Local categories themselves are future scope; see
[local categories](../docs/atlas/roadmap/local-categories.md).

**The prefix names the kind of scope, never the resource.** Every place holding a category name, a
grant, a token entry or an audit record, already names its resource, so `resource.pilot` needs no
resource identifier inside it, and no resource identifier has to be kept free of the separator. A name
itself cannot contain the separator. The schema holds the scope beside the name, a category row
carrying the resource it belongs to or none for a global one, and the prefix follows from that rather
than being stored twice.

**Only an admin creates a global category.** The scope is what lets a resource's owner create
categories of their own once local categories exist: `category.create` bounded to one resource like
every other owner capability, and never reaching the global scope.

**A version 1 bridge accepts `resource.` entries and enforces `global.` ones only.** A `resource.`
entry is removed by the bridge before the payload reaches the adapter, so it reaches nothing, and is
recorded as `category.unenforced` with the reason `notImplemented`, once per payload received rather
than once per request (see [audit-events.md](audit-events.md)). Dropping it is safe, because a grant
that reaches nothing only narrows what its holder sees, and recording it makes a local category
arriving early visible rather than silent. It also gives the first release an event for exercising
the audit path end to end. A bare
name or an unknown prefix is different: it means the controller and the bridge disagree about the
format, so the payload is treated as not received, which the application reports as unavailable
rather than serving as an empty answer, and the rejection is logged.

**Dropping covers a principal's grant and nothing else.** A local category also restricts the
records carrying it, and a bridge that only drops `resource.` entries still serves those records to
anyone holding their global category. So no resource may define a local category while an
application serving it runs a bridge that does not enforce them; enforcing one takes an adapter that
can render a record carrying more than one category.

**Prose keeps everyday words.** Reader-facing documents say "platform" and name categories
without the prefix, since the prefix is a key for software rather than vocabulary for readers.

---

### Additive rendering over subtractive exclusion

> **Scope: operative now.** Each held category renders as its own predicate, paired with the
> resource's and composed with `or`, so this decision governs the first release's filter rather than
> a later one.
>
> Two things were established while resolving it, and both are recorded here so the post-MVP work
> does not repeat them.
>
> **Additive rendering is expressible in one clause, but not via the operator suggested by its name.**
> A record is visible iff `categories(record)` is a subset of the held set, which is universally
> quantified over the categories _not_ held by a principal. Enumerating that additively costs
> `2^|held|` branches. The single-clause form is `not` of `not-in`:
>
>     { op: 'not', content: [ { op: 'not-in', content: { fieldName: <field>, value: [...held] } } ] }
>
> Read out: no nested object holds a value outside the granted list, therefore every value is
> within it. Linear in the number of grants. Verified by executing the compiler, not by reading it.
>
> **It requires the field to be mapped `nested`.** On a flat field the same expression
> double-negates to plain `in`, which on a multi-valued field matches when any element matches
> rather than requiring every element: silently the wrong test, in the permissive direction. There is no `terms_set`
> in the compiler to fall back on.
>
> Worked, with a principal holding only `controlled` and a record carrying
> `["controlled", "indigenous"]`, which should be invisible to them:
>
> | Step           | Flat field                                                                    | `nested` field                                                                                    |
> | -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
> | Inner `not-in` | Asks whether the _field_ lacks `controlled`. It does not lack it, so no match | Asks, per element, whether _that element_ is outside the held set. `indigenous` is, so it matches |
> | Outer `not`    | Nothing matched, so the record is admitted                                    | An element matched, so the record is excluded                                                     |
> | Result         | Visible. Wrong, and permissively so                                           | Invisible. Correct                                                                                |
>
> The mechanism is per-element evaluation. A flat multi-valued field is one field with several
> values, so a negation applies to the whole field and can only say "none of the record's values is
> `controlled`". `nested` indexes each element separately, which is what makes "there exists an
> element I do not hold" expressible, and negating that yields "every element is one I hold".
>
> The alternative encoding, a stored count of a record's categories compared against how many of
> them fall in the held set, is equally a demand on how the data is shaped. Neither is reachable
> without the instance modelling for it. Usher cannot require a mapping shape from instances whose
> data models it does not know, so record-level narrowing is available only where an instance
> supplies data satisfying that precondition, verified at adapter startup rather than assumed.
>
> **The precondition is unmet on the first instance, and it is narrower than it first reads.**
> What is missing is a per-record _category_ field. Neither iMS catalogue carries one, and nothing
> may be written into the data to create one, so the subset comparison above has no field to operate
> on.
>
> **Narrowing within a resource by predicate is a different thing and is available now.** A filter
> over descriptive fields already carried by the records, a study paired with a data type for instance,
> narrows at record granularity using positive clauses on flat keywords. It needs no `nested`
> mapping and no new field, and it works on both catalogues today.
>
> The two need separating by name, because "record-level" has been carrying both. **Narrowing by
> category** is what these preconditions block. **Narrowing by predicate** is not blocked by any of
> them.

The bridge renders a resolved grant set as a union of positive predicates, one branch per grant
held, composed with `or`. The adapter compiles that into its own backend dialect. It does not compute exclusions by subtracting the held categories from
the full category set configured for a resource.

This supersedes the subtractive visibility rule currently described in
[permissions-model.md](permissions-model.md); those sections are marked for rework.

**Primary rationale: which way the system fails when information is lost.** In a subtractive
model, losing a term widens access. In an additive model, losing a term narrows it.

| Failure                                                            | Subtractive                                        | Additive                          |
| ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------- |
| Category exists in Usher, unmapped in the adapter                  | No exclusion is generated for it, records **leak** | Contributes no branch, **denies** |
| Data arrives carrying a tag value not yet registered as a category | Nothing excludes it, **visible**                   | Matches no predicate, **hidden**  |
| A bug drops a clause from the composed filter                      | Access **widens**                                  | Access **narrows**                |
| A field mapping points at the wrong field                          | Fails open                                         | Fails open                        |
| Principal holds zero grants                                        | Denies                                             | Denies                            |

The unregistered tag value and the dropped clause are what decide it. The rest are ties, or fixable
under either model.

**This is not hypothetical in the query library being used.** Terms disappearing is a
demonstrated property of `@overture-stack/sqon`, not a speculative risk: empty combinations
validate and compile to match-all, `reduce.ts` prunes empty inner combinations, and `removeFilter`
can converge on an empty combination. Two further hazards are recorded but unverified,
`groupingOptimizer` flattening empty combinations out of the tree, and `SqonBuilder.not([...])`
inverting AND/OR when merging same-field exclusions. Under subtractive rendering each of those is
a potential over-disclosure; under additive rendering each is a potential under-disclosure.

The `not()` hazard is pointed. A subtractive model expresses every decision as a negation, so it
routes all enforcement through the one operator carrying a flagged merge defect. An additive model
uses `in` for effectively everything, which is the simplest and best-covered path in the module.

**Secondary rationale: it removes an inversion in the middle of the pipeline.** Permission computation
is already additive across the three tiers (see the additive grant pipeline decision below). A
subtractive adapter inverts that result into exclusions for no reason. Making the rendering additive
means the pipeline runs one direction end to end.

**Secondary rationale: audit answers become local.** Under additive rendering, "why can this
person see this record" always resolves to a specific grant. Under subtractive it resolves to "no
exclusion matched," which is an absence, and absences are considerably harder to review or
reproduce.

**Consequence: a role in a resource becomes an explicit positive grant.** Subtractive rendering gave access
to untagged records as a side effect, since nothing excluded them. Additive rendering has no implicit
baseline, so a role must render to a predicate of its own (scoping to the resource, for
example `resource_id in [...]`), with category grants adding branches on top. This is treated as
an improvement rather than a cost: it makes the baseline an auditable grant like any other instead
of an unstated default.

**Consequence: the Usher token carries held grants only.** Moving the resource's full configured
category set into the token was considered, as a way to make subtractive rendering fail closed on
config drift. Additive rendering does not need it, since an unmapped category contributes nothing
rather than silently skipping an exclusion. The token therefore continues to name only positive
grants, and `permissions-model.md`'s least-information instinct is preserved, though note its
stated rationale (parity with OAuth scopes, UMA RPT permissions, and GA4GH Passport Visas) was
inherited from the superseded assumption that the user holds the token. The conclusion stands on
the absence of any remaining benefit, not on that parity.

**Relationship to GA4GH Passport: none.** Passport is inbound, an institution's
`ControlledAccessGrants` Visa validated by Keycloak and mapped to a category grant. This
decision concerns how a resolved grant set is rendered into a query filter, downstream of that.
Passport support is unaffected either way.

**Tradeoffs accepted.** The subtractive mechanism is described in detail across four sections of
`permissions-model.md` (the visibility rule, its worked example, composition across categories, and
category-to-field mapping), all of which need rework. That cost is accepted because it is
design-phase work, which is the cheapest moment it will ever be. The untagged-record default also
has to be decided explicitly rather than inherited, which is the point.

---

### A self-scoping predicate is not an access decision

Some access questions are answered by the record together with the authenticated identity, with no
reference to any grant. Whether a saved query belongs to the person asking, whether a profile is
their own, whether a draft submission is theirs. **Usher is not involved in those, and routing them
through it is a mistake rather than an excess of caution.**

The test is what the predicate is over. A grant-derived predicate asks what the principal holds, and
only the access control service knows the answer. A self-scoping predicate asks whether the record
names the principal, and the record already carries it.

Both produce different rows for different principals, which is the resemblance that misleads. It
misled an integrating team into reading per-principal ownership as row-level narrowing within a resource, and
therefore as blocked until post-MVP, when it was never an authorization question at all.

**Authorization begins where identity stops being sufficient.**

**Two consequences that are not obvious from the rule.**

A self-scoping question must be answered from the authenticated principal and never from a parameter
carrying an identifier. A parameter is a request; identity is a fact. The distinction is the whole
difference between "show me my sets" and "show me anyone's sets".

Sharing does not automatically move a question into the grant model. An access list stored on the
record, naming principals, is still answered by the record plus identity. What pulls a principal into the grant model is a governance decision made elsewhere about a body of data, not the fact that more
than one person can see it.

**Where the boundary actually falls.** A collection of records assembled by a user is their artifact
and stays self-scoped. A body of data with a custodian, a category, and an approval process is a
resource. Revocation still reaches the first, because a revoked principal fails at the bridge before
any query runs, so keeping user artifacts out of the grant model costs nothing in enforcement.

**The carve-out: widening who may read an artifact is not itself a self-scoping act.**

Every read of a shared artifact is answered by the record and the principal. The decision to widen it
is not, because it depends on what the artifact was derived from, and that is a governance question
about a body of data.

The case that produced this rule is a saved cohort. Such a record can carry the materialized
identifier list and the query that selected it, and reading the record is not resolving it, so
neither passes through data enforcement. Sharing one therefore discloses which principals share a
clinical or genomic property, and what property, to someone who cannot retrieve a single one of
those records. In this domain that is the disclosure rather than a step toward it.

**Holding a grant is permission to see data, not permission to republish something derived from
it.** Those are different authorities, and the model already separates them: an owner sets a
resource's base tier, a viewer does not. So the check needs no new concept.

Four properties of the check, because each is easy to get wrong:

- **It gates any widening, not just publication.** Sharing with named principals discloses the same information to a smaller audience.
- **It is a question about provenance, not a permission to share.** An artifact derived only from
  open data requires no authority to widen, because it discloses nothing beyond what the reader
  could obtain directly. The check asks whether the provenance demands authority beyond the
  sharer's.
- **Multiple contributing resources conjoin.** Authority is required for every contributing
  resource, not any of them.
- **It needs no new API.** The Usher token already names the resources reached and the capabilities
  held on each category of them, so the check is evaluated where the sharing happens, against
  provenance recorded on the artifact. This is why provenance has to be stored at creation: the contributing resource's
  categories may have changed by the time anyone asks, and derivation-time state cannot be
  reconstructed afterwards.

**Superseded in mechanism, not in principle: gate the reader, not the sharer.**

The check above authorizes the act of widening. A better mechanism authorizes the read: an artifact
is visible only to a principal holding every resource that contributed to it. Provenance is on the
record, the principal's holdings are in their own token, and no lookup about any other principal is
needed, so the self-scoping property survives.

Three advantages over the share-time check:

- **Nothing can be seen more widely than what it was built from.** No one wrote that rule or has to
  enforce it. It happens because the check runs on every read, against what the reader holds.
  Something built only from open resources can genuinely be public. Something built from a
  controlled resource is invisible to anyone lacking that grant, whatever visibility was set on it.
  So a share made in error stops working rather than doing harm.
- **It cannot be bypassed by a bad decision at share time**, because it is evaluated on every read.
- **It subsumes the share-time check.** If a share cannot disclose, permitting the share is a
  presentation problem rather than a disclosure one.

**The encoding, and why it works on a flat field.** Subset containment normally needs a nested
mapping. Passing the _complement_, the reader's unheld resources, converts a subset test into a
disjointness test, and disjointness is expressible against a flat keyword array. An artifact
survives exactly when it requires none of what the reader lacks.

**The complement is computed locally, and the token does not change.** A first reading of this
concluded the token had to carry the complement, which would have reversed the least-information
position on naming unheld resources. It does not, and the reason is worth keeping.

The complement does not need the full registry. It needs the resources _configured for this
instance_, and the adapter already enumerates those: config maps each resource to a catalogue, a
field name, and a field value, because that mapping is how a record is attributed to a resource at
all. So the left half comes from config at startup and the right half from the token, and neither
requires Usher to name anything outside the principal's holdings.

    complement = (resources this adapter is configured for) minus (resources held by the principal)

**Why computing the complement locally is enough, rather than merely convenient.** Including too
much in it is harmless: a resource that never appears in any artifact excludes nothing. Leaving one
out is not, because an artifact requiring a resource outside the reader's holdings would then pass.
So the only question is whether the local computation can leave one out, and it cannot, for one
reason: **an artifact built here can only draw on resources served by this instance.**

**That last property has one precondition, and it is the thing to guard: every resource value present
in the data must be configured.** A record carrying an unconfigured value can still enter an
artifact's provenance, and that value will be missing from the complement, so the artifact clears a
ceiling it should not have.

An unconfigured value is the unknown-resource case, and this is why an unmapped one must deny rather
than be ignored: here it is not merely a missing restriction on one record, it silently lifts the
ceiling on every artifact derived from it.

**An artifact with no recoverable provenance can never be widened.** Not as a policy choice: the
check has nothing to evaluate, and derivation-time state cannot be reconstructed after the fact. So
artifacts predating provenance recording stay private permanently, and no migration recovers them.
A migration can restore ownership, which makes an artifact readable by its owner, because that is
self-scoping and needs no provenance. It cannot make one shareable.

Anywhere the widening operation is unavailable, it must be **absent rather than permitted**. A
instance with no authentication has no identity to narrow by, so every artifact is already visible
to everyone and there is nothing to widen. The correct implementation is that the operation does not
exist in that mode, not a check that returns true. A check that passes because its inputs are
missing looks like enforcement and is not, which is the same failure as a control named for a gate
it does not implement.

**The residual risk, which is accepted rather than solved.** Checking at share time keeps every
read self-scoping, and means a share can outlive the governance that permitted it. That is the
category-change propagation problem already open in the roadmap rather than a new one: when a
resource's categories tighten, existing shares of artifacts derived from it need re-evaluation, and
that belongs in the admin API rather than in a read-path filter.

---

### Catalogue-level denial is an empty `in`, and never a negation

Request-level denials (no valid token, revoked, bridge unreachable) are decided in middleware before
the resolver runs, as the 503 case already is. Catalogue-level denials cannot be, because the
application's hook is supplied per catalogue and one request can span catalogues whose answers differ.
Denying the whole request because one catalogue is denied would take the permitted ones with it.

So a catalogue-level denial has to be a filter.

**Decision: express it with the query module's `matchNothing(fieldName)` constructor, and never by
hand-constructing a negation of an empty group.**

**A filter must carry at least one leaf clause.** An empty combination is not a restriction, and a
negation is not a way to make one. Only a leaf carries the restriction reliably, because the
transformations applied to a filter operate on combinations, and a leaf has nothing for them to
collapse.

**Deny is a value, not an absence, and it needs a name.** Written by hand it looks like an
omission, which invites a well-meaning rewrite into a form that does not restrict anything. The
constructor exists so the intent is visible in the call and survives that edit. It is verified for
node shape, schema acceptance, round-trip survival, and composition inside a builder chain, and it
lives in the module that owns the rule rather than in an adapter.

**The field name is required and that is structural, not an inconvenience.** Every leaf operator
takes one, so any field-free form is a combination, and a combination cannot carry the restriction
per the rule above. For Usher the resource field name is always in adapter config, so the constructor
always has one available.

**Verified end to end on 2026-08-24, and what that verification does not cover.** A principal
holding no grants returns nothing on every read path, with the enforcement clause asserted present
in the emitted query rather than inferred from the empty result, and with a positive control on the
same records in the same run.

The coverage boundary matters and is not uniform across instances:

| Condition                          | Covered |
| ---------------------------------- | ------- |
| Elasticsearch 7.17.28, flat fields | Yes     |
| OpenSearch                         | No      |
| Nested access fields               | No      |

The first integration runs Elasticsearch with a flat resource field, so it sits inside what was
verified. Another instance runs OpenSearch, and its clinical index carries the access-relevant
field nested at several depths, so both untested conditions land together there. Treat that
instance as unverified until the conformance corpus covers both, rather than reading this result
as engine-independent.

**Two constraints that follow.**

The value is produced by a named constructor, never written inline. The intent has to be visible in
the type, because a literal empty array reads as a mistake and the natural cleanup of it is B.

Its pinning test must assert the **emitted Elasticsearch**, and must assert the value survives a
builder round-trip unchanged. A test on the SQON node shape alone would not have caught the failure
that ruled out B.

---

### Holding no grants is a distinct state, never an empty filter

SQON carries no notion of direction, and its only identity element is the one that suits
narrowing. An empty combination is a valid, intentional, tested value in
`@overture-stack/sqon`: `SqonCombinationSchema` declares `content: zod.array(SqonSchema)` with
no minimum length, `SqonBuilder.empty()` produces `{ op: 'and', content: [] }`, and every
builder chain starts from it (`SqonBuilder.in(...)` is "empty, then add a clause"). A
An empty `and` compiles to `bool.must: []`, which is match-all.

**Verified against a live cluster on 2026-08-24, and it resolves to the unsafe side.** An empty
`or` returns every document, as an empty `and` does.

So every empty combination is fail-open, and an `in` with an empty value list remains the only
fail-closed encoding available. Nothing in this decision changes, but the reason is now measured
rather than assumed for one of the two operators, and the assumption would have been correct only
by luck.

The consequence is that the same literal means "everything" whether it was intended as a
narrowing filter, where that is correct, or as an accumulated set of grants, where it is
catastrophic. Intent lives entirely outside the data structure. An empty grant set composed
into a query with `and` is a no-op: it vanishes, and the emitted query is byte-identical to no
enforcement, with nothing raised and nothing logged.

**A deny encoding exists, and it turned out to be needed.** `in` with an empty value array
validates (`SqonScalarOrArrayValueSchema` has no minimum length, unlike `all` and `wildcard`) and
compiles to `terms` with an empty array, which matches nothing. It is needed because a
per-catalogue denial has nowhere else to go; see the catalogue-level denial decision below.

What survives from the original objection is narrower and still correct. The encoding must never
appear as an inline literal, because `{ value: [] }` reads like an oversight, and the obvious tidy
of it is the one form that inverts.

**Decision.** Holding no grants is represented as a distinct state that never becomes a SQON
value. The bridge returns a discriminated result to the adapter rather than a filter:

    type Enforcement =
      | { kind: 'deny';   reason: 'no-grants' | 'unknown-resource' }
      | { kind: 'narrow'; sqon: SqonNode }
      | { kind: 'allow' }

**How each arm reaches the application.** All three now have a concrete expression, and
none of them is a hand-written literal:

| Arm      | What the adapter returns                                                   |
| -------- | -------------------------------------------------------------------------- |
| `deny`   | `matchNothing(fieldName)` from the query module                            |
| `narrow` | The rendered filter                                                        |
| `allow`  | The application's exported allow-all sentinel, taken from its package root |

**The callback is total, and returning nothing is now an error rather than a permission.** The
instance has made `null` or `undefined` throw instead of granting everything. So an adapter that falls
through a branch fails loudly. This removes the last path by which an omission read as consent, and
it is why the adapter has to ask for `allow` by name rather than expressing it by declining to
answer.

The `allow` arm exists because a catalogue can be open by configuration, and such a catalogue
needs an unrestricted query. Without a named arm the only way to serve it would be emitting the
empty match-all combination prohibited by this decision. Naming it means the audit trail can
distinguish "unrestricted because this catalogue is configured open" from "unrestricted because
the filter evaporated," which are identical in an emitted query and opposite in intent. It is
consistent with the additive grant pipeline decision below, which already issues an Usher token
for anonymous requests specifically so open access stays audited.

The alternative considered was enumerating every open resource into a positive `in` clause, which
keeps a single code path but puts a catalogue's entire resource list into every token and grows
without bound.

A `revoked` reason was considered and dropped as unreachable: the bridge drops a user's cached
token on a revocation event, so the next request re-fetches and receives a payload with no grants
for that resource, which surfaces as `no-grants`.

This adds no new rule. [adapter-integration.md](adapter-integration.md) already requires denial
to be rejected before filter construction, on the grounds that "an empty exclusion set does not
mean 'deny all'; it means 'exclude nothing from scope.'" What was missing was any mechanism
making that unskippable: given a bare `SqonNode`, the natural adapter code has no branch to
forget, because it has no branch. The discriminated return makes the deny arm a compile-time
obligation.

`kind: 'deny'` asserts only "do not query the data layer." It carries no status code, since the
existence-denial invariant means a search endpoint should likely return an empty result set
rather than a 403 that confirms the resource exists; that realization stays the adapter's
decision. The `reason` field exists for the audit trail rather than control flow: access never
held, access withdrawn, and misconfiguration are three different events, and collapsed into a
bare denial the revocation case becomes uncountable.

The unavailable case is deliberately absent. The bridge must return 503 upstream before the
translation callback is invoked, so this type describes only the branch where a payload
resolved.

**Tradeoffs accepted.** Adapter authors must handle two arms rather than composing one value.
That friction is the point.

**This rests on one invariant, stated so it is not rediscovered.** Denial is represented in the
result's kind and never inside the SQON. Once a deny is expressed as a SQON value, it inherits every
empty-combination hazard above. What made deny safe was deciding it outside SQON. Putting it back
inside returns it to a language with no way to say it. The `in`-with-empty-values encoding is a
fail-closed way to say "match nothing" where a filter is unavoidable; it is not a licence to
represent the deny arm as a filter.

**The underlying reason is that SQON is a general query language pressed into service as an
authorization artifact.** A language built for narrowing has no natural "match nothing" element,
because nobody writes a query that narrows from nothing. That absence is the root of the
hazard, and it is why deny has to be decided outside SQON rather than expressed within it.

**Independently corroborated by an unrelated implementation.** Cerbos's `PlanResources`, built for
the same job of turning a policy into a residual filter, returns exactly this three-way
discrimination: `KIND_ALWAYS_ALLOWED`, `KIND_ALWAYS_DENIED`, and `KIND_CONDITIONAL` carrying an
AST. Its documented rationale is the one recorded here, a discriminated union at the type level so
that principals must handle each case distinctly. Two designs reaching the same three-way split from
different starting points is the strongest available evidence that the problem forces it rather
than that anyone preferred it.

---

### Adapter enforcement over gateway/proxy enforcement

A gateway (API proxy, sidecar) can allow or block requests. It cannot reshape queries. Usher's
enforcement model requires query shaping: the adapter must inject grant-based predicates into every
data query before it reaches the data layer. A gateway operating at the HTTP level cannot do this
for GraphQL, SQON, or other structured query formats without deep protocol awareness.

Adapter enforcement runs inside the application and has access to the query structure before it is
serialized and sent. The adapter shapes the query; the data layer receives a pre-filtered request.

**Tradeoffs accepted.** Every application that serves protected data must implement an adapter.
Enforcement is distributed rather than centralized. An application that skips the adapter has no
enforcement: there is no backstop at the network layer.

---

### Token lifetime never bounds how long an operation may take

**The precedent is in the system being replaced.** EGO's access tokens last three hours. The reason
is that submitters run large uploads, which outlive a short token and fail partway. Lengthening the
token stopped the failures. It also handed every principal and every operation a three-hour
revocation window, not just uploads.

**The error was scope, not duration.** What got lengthened authorized everything permitted to a
principal, platform-wide, for reads as well as writes. It was lengthened so that one long write
would survive. Scope and duration trade against each other: a credential may be broad, or
long-lived, but broad and long-lived is the worst of the four. Nobody extended the narrow,
long-lived permission actually needed for upload.

**This design does not permit lengthening a credential to fit an operation.** The Usher token lifetime bounds credential exposure. It
is never adjusted for how long an operation takes. Where an operation cannot finish inside it, the
operation changes.

**Most of the exposure is absent here by accident of shape.** A principal never holds a grants
token; the bridge fetches it and caches it. So its expiry aborts nothing. The bridge re-exchanges,
and the controller re-evaluates current policy when it does. Re-evaluating on every exchange is
what the whole revocation design rests on.

**One exposure does remain.** A principal's own identity token sits in a client for the duration of an
operation. Any upload step needing a valid one can still fail partway. The problem moves; it does
not vanish.

**What that requires, as a constraint rather than a design.** A long-running operation is authorized
as an operation, with a scope naming what it may touch. It is revocable in its own right, so a
withdrawal reaches work in flight rather than waiting for a credential to lapse. That is better than
parity: today an upload in progress cannot be stopped short of three hours.

**Upload is a third enforcement path, and duration is what distinguishes it.** Searching is
instantaneous. Downloading is short. Only submission runs long enough for a credential to expire
underneath it. See the long-running operation item in [../roadmap.md](../roadmap.md).

---

### Push revocation over pure TTL

A short token TTL limits the staleness window but requires frequent token refreshes and adds
round-trip latency. A long TTL reduces round-trips but widens the window where a revoked grant is
still honoured.

Usher uses a push revocation channel (SSE or WebSocket with poll fallback): adapters subscribe and
receive notification when grants change. Cached tokens are invalidated on notification rather than
on expiry. The TTL is a backstop, not the primary revocation mechanism. This is about revocation
specifically: a grant reaching a date it always carried is handled by the token's own `exp`, since
nothing needs announcing when both sides knew the date at issuance.

**Tradeoffs accepted.** Adapters must maintain a persistent connection to the revocation channel.
If the channel is disrupted, the adapter cannot know whether its cached grants are still valid.
For the mechanism (push + poll, multi-instance propagation), see
[security-workflow.md § Emergency access revocation](security-workflow.md#emergency-access-revocation).

---

### Fail-secure when the revocation channel is unavailable

If a revoked grant notification is never delivered, the adapter would continue honouring access that
has been withdrawn. An adversary who can silence the revocation channel would preserve stale access
indefinitely with pure TTL fallback.

When the revocation channel is unavailable beyond the configured grace period, the adapter returns
503 (service unavailable) and suspends data access until connectivity is restored. An adversary who
silences the channel gains no access; they only cause a service disruption.

**Tradeoffs accepted.** A revocation channel outage becomes a data access outage. This is the
correct behaviour for a system handling sensitive or health-adjacent data, and is a deliberate
design choice rather than an oversight. For the failure behaviour and grace period design, see
[security-workflow.md § Revocation channel integrity](security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour).

---

### Usher is data-agnostic

Usher does not know the schema of the data it protects. It does not query the data store, run
migrations, or write to any data table. It holds grants (user, resource, category) and issues
Usher tokens. What those categories mean in terms of actual records or fields is
application-specific configuration that lives in the adapter.

This allows Usher to be adopted without modifying the data being protected, and removed without
leaving data artifacts. It also keeps Usher generic across data formats (relational, document,
search index) without needing format-specific logic.

**What this forecloses, and the rule it yields.** Enforcement filters on fields already carried by the data, and Usher never causes a field to be written. That splits candidate filter fields in two:

- **Descriptive fields** state what a record is: its study, its data type, its file type. The
  submission pipeline sets them for reasons unrelated to permissions, and they do not change when
  permissions change.
- **Prescriptive fields** state who may see a record, an access level baked into the document. They
  encode an access decision inside the data.

**Enforcement reads descriptive fields only.** A prescriptive field holds the decision in two places
at once with no invariant binding them, and makes the search index an unowned authorization store.
Filtering on a descriptive field keeps every permission in Usher and every fact about
the data in the index.

Two consequences. There is no staleness window, because a grant change alters no indexed field, so
the index cannot disagree with a decision it does not hold. And a distinction not already made by
the data cannot be enforced, which turns "does the data already distinguish this?" into a
question to settle before any new category is promised rather than after.

**Tradeoffs accepted.** Usher cannot validate that a category or resource name corresponds to
anything real in the data layer. Misconfigured grants (referencing a nonexistent category) are
silent. Validation is the responsibility of the management UI and the adapter configuration.

---

### Sharing at study level needs no snapshot machinery

The unit of sharing is a study, meaning all records in it including future ones, so the "dataset
definition" captured by a share is simply the study identifier. A category grant scoped to that
resource is the snapshot: it records which resource was shared and when.

**Scope note.** Capturing a dataset definition at share time was a requirement in an earlier draft
of the iMS UAC business requirements and now sits under that document's out-of-scope list. The
decision below stands on its own terms, since study-level sharing is the model regardless, but it
is no longer answering a live requirement. See `.dev/docs/brd-traceability.md`.

No point-in-time record snapshot is needed for MVP. The grant IS the dataset definition. Future
records added to the study are automatically covered by the existing grant, which is the intended
behaviour for study-level access.

**What is deferred.** If a future requirement calls for sharing a filtered subset of records at a
point in time (a SQON-defined cohort rather than a whole study), the grant would need to carry a
SQON filter expression capturing the filter state at share time. This is the post-MVP SQON-scoped
grants extension and is explicitly out of scope for the initial implementation.

---

### Accept/decline invitation flow is the default; auto-accept is configurable

When a grant is created for a registered user, the default behaviour is that it reaches nothing until
its recipient answers: they must explicitly accept data-sharing responsibility before the grant
appears in their Usher token. No decision is not an acceptance. The grant itself carries no state
saying so, because the answer is a row in `grant_decisions` rather than a column here, and its
absence is what the token calculation reads.

The reasoning: researchers may not want to hold responsibility over data they did not request, and
accepting access to health data carries legal and ethical obligations in many jurisdictions. Silent
activation removes the grantee's ability to make an informed decision.

A configurable `auto-accept` flag (name TBD) bypasses the acceptance step for instances where
it is not operationally appropriate (machine-to-machine sharing, internal pipelines, or any case
where all parties are institutional accounts rather than individual researchers). The flag is off
by default across all instances.

Access offered to an unregistered email address is an `invitations` row rather than a grant, and it
remains unclaimed until that person registers. On registration the invitation becomes a grant under
their Keycloak subject, unanswered, and follows the ordinary path from there. The two are different
tables rather than two states of one thing, which is what keeps an unclaimed offer out of every
query that reads grants.

**Tradeoffs accepted.** The acceptance step adds friction to the sharing workflow. This is
intentional: the friction is the point. Instances that cannot tolerate it have the auto-accept
option; instances handling PHI should leave auto-accept off.

---

### EGO is replaced, not integrated

Usher is the full replacement for EGO (Overture's previous authorization service). The
integration strategy considered (running Usher alongside EGO and having both manage grants)
is not adopted. EGO uses a different data model (groups and policies) that does not align cleanly with
Usher's resource/role/category-grant model; maintaining both simultaneously doubles what can
fail and creates policy synchronization risk with no long-term benefit.

The replacement strategy: enumerate EGO's `STUDY-*` groups, map each to an Usher resource, and
map EGO group memberships to Usher `grants` rows. The studies management service (which orchestrated
EGO) is retired; its operations become Usher admin API calls. Backend services in iMS that
currently call EGO's authorization endpoints are updated to use Usher's bridge and token exchange.

**Tradeoffs accepted.** A full replacement requires a migration event and a coordinated cutover
for iMS backend services. This is harder than an incremental integration but avoids indefinite
operational complexity from running two authorization systems.

---

### The identity provider's subject identifies a principal; email for access invitations only

Usher identifies a principal to other services by the identity provider's subject (the `sub` claim
from the OIDC token), stored with the provider that issued it. Audit records and all API interactions
involving registered users carry the subject. Inside Usher, `grants`, `grant_decisions` and every
other reference use Usher's own `users.id`, which never leaves Usher. Email addresses are not used as
identifiers in any active grant record.

**The subject is stored with its issuer, and the two are unique together.** A subject is unique only
within the provider that issued it. Once a second provider is supported, two people can hold the same
subject, and a table keyed by the subject alone would hand one of them the other's grants. The
issuer is stored from the first release, when there is one provider, so that the second one needs no
migration; the token and audit events gain the issuer at that point, which is a payload version
change.

The reasoning: user IDs are opaque identifiers with no intrinsic meaning. An email address
leaked in a token or log exposure reveals PII; a Keycloak UUID reveals nothing without access to
the IdP. Email addresses can also change; principal IDs are stable for the lifetime of the account.

Email is used in exactly one place: the `invitations` entity, where a grant has been sent to
an address that belongs to a user who has not yet registered. Once the user registers, the pending
grant is migrated to their account and the email reference is discarded.

Any portal or consumer-facing feature that needs to display a user's name or email (for example,
a "shared with me" listing) resolves that information via the Keycloak admin API at the portal
layer, not by storing email in Usher's policy tables.

**Tradeoffs accepted.** The portal layer bears responsibility for email-to-ID resolution and
display. This is a deliberate separation: Usher is an access control service, not a directory.

---

### The baseline is instance configuration, not a role, and it may be empty

An instance configures a **baseline** whose grants are the floor for every principal, applied
whether or not a principal is authenticated. Open access is what that role ordinarily grants, and an
authenticated principal's grants are this baseline together with their own rather than an alternative
to it.

**It cannot be a role, and the reason is structural rather than stylistic.** A role attaches to a
holder, every holder is a user or a group, and an unauthenticated request has no `sub` at all. There
is no row to assign anything to. So the schema defining roles cannot hold what a name of the form
"anonymous role" describes, and a reader who goes looking for the row will not find one. The
baseline is a configuration value read by the token calculation, and what it produces looks like
grants because it emits ordinary grant entries.

**A name has now been invented for that gap twice.** The synthetic `public` role was
retired for filling a token field with a value held by nobody. `anonymous role` fills no field and is
not synthetic in that sense, so the sentence below stands as written. It went wrong on the other
axis: it called the configuration a role.

**It may grant nothing.** The baseline is the rule behind a resource's open setting: it gives every
principal the `unmarked` grant on each resource whose unmarked records are open. Where it grants
nothing, a resource set to open is reached by nobody through it, signed in or not. Registration gating
is the registered setting and the signed-in rule, not an empty baseline, so an empty baseline no
longer makes open data require registration. See "Records not covered by any category are `unmarked`" below.

**By default it grants `read` on `unmarked`**, which expands to `count`, `view` and `export`, so
anyone can count, see and download an open resource's unmarked records. The signed-in rule defaults
the same way for a resource set to registered. An instance may narrow either in configuration, for
example to `count` and `view` where open should mean browsing without download.

This also removes the synthetic `public` role. It existed to label open-tier grants in anonymous
tokens, and described itself in prose as a minimum read permission because there was no field to put
one in. Under the baseline there is nothing synthetic left: an anonymous token carries ordinary
grants that happen to have come from the baseline, and holding no grants stays the distinct state it
already was.

---

### Who holds a grant can follow a rule, and the controller evaluates it

**Some grants are conferred by a rule rather than recorded one per holder.** The baseline is the
first: it gives every principal the `unmarked` grant on each resource whose unmarked records are
open. The second, in the first release, gives every signed-in principal the `unmarked` grant on each
resource whose unmarked records are registered, which is what the Registered tier needs: data reachable by anyone signed in without an approval, beside data reachable by an anonymous visitor. Without it a signed-in principal holding no grants receives the
same token as an anonymous one, and registration can gate open data only for a whole instance.

**A rule decides who holds a grant, never which records a category covers.** Neither open nor
registered is a category: both are settings of a resource's `unmarked` records, and the rule is what
reaches them. A setting applies to a whole resource's unmarked records, since mixing tiers among
them would need a field on each record holding an access decision, which is prescriptive. No record
belongs to two categories through it, so the rule needs no both-grants check.

**The controller evaluates rules at the exchange, and no bridge does.** The controller already
verifies the identity provider's token and computes the grants there, so a rule hands the bridge an
ordinary grant and the bridge needs no change. Evaluated in bridges, the same rule would live in
every application and drift between them, and a single decision point exists to prevent exactly that.

**A rule reads only what the identity provider verifies.** "Signed in" needs nothing but a valid
token. A later rule over a person's attributes may read only claims verified by the provider or
managed by an administrator, never one editable by the person, since a rule over an editable
attribute lets the person grant themselves access. The connector declares which claims qualify.

**A rule's result is recorded at each exchange.** A grant conferred by a rule has no grant row, so the
exchange records which rules applied, or the audit trail cannot say who could reach what, and when. A
change to a person's attributes is not a grant change and is not announced, so the token's lifetime
bounds how long an old answer holds.

Rules beyond these two, and conditions bounded in time such as embargo, are recorded as research in
[conditions beyond the data](../docs/atlas/roadmap/conditions-beyond-the-data.md).

---

### Category grants are a list of independent grants, and resource names are never manufactured

A resource's entry in the token is a list of grants, each naming one category and the permissions
held on it. Each entry corresponds to one row in the grant store and one act of granting, and
holding several means holding several grants.

    "STUDY_A": { "global.unmarked":       { "record": ["view", "update"] },
                 "global.controlled": { "record": ["view"] } }

**Every permission is category-scoped, and open content is a category, `unmarked`.** There is no
separate resource-level permission list and no baseline outside the category system, because a
baseline is what the superseded subtractive model required. A detached permission list would have
reintroduced it, and was rejected for that reason rather than for shape. It also could not express a
real tier difference: an anonymous principal holding `view` on `unmarked` where a registered one
holds `view` and `download`, same resource, same category.

**No role name and no ownership travel in the token.** A role is how access is authored; the
controller resolves it to permissions at issuance, so no adapter learns what an instance means by
`viewer`. Ownership is a management permission enforced by Usher's own API, so an enforcement
payload has no use for it.

**There is no empty-list case, and categories are therefore not optional.** Any access to a resource
means holding at least one grant on it, so an empty list would mean what absence already means. The
accepted cost is that a resource carrying no categories is ungrantable, since a grant would have
nothing to name.

**Rejected: encoding a category into the resource name.** Manufacturing `STUDY_A_CONTROLLED` and
`STUDY_A_INDIGENOUS` as separate resource names was floated as the route to separately grantable
segments. It is wrong twice over. Role-and-attribute hybrids exist to avoid exactly this
duplication, and here it reappears on the resource axis instead of the role axis, growing
combinatorially with the number of categories. And it does not work: no field in the data holds the
value `STUDY_A_CONTROLLED`, so a positive containment on the resource field cannot select it.
Splitting a resource is only enforceable along an axis already expressed in the data, and categories
are not one.

**What the split requirement actually means.** Where data is separately governed, it becomes its own
resource with its own identifier in the instance's data, decided at registration. Two studies, not
one study with a manufactured suffix. That is enforceable, and community governance would want that
outcome anyway, since separately governed data gets its own custodian rather than
living as a label inside someone else's study.

**What the list shape does not change.** A category is a clause in the filter, paired with the
resource's, so the list shape is what the emitted filter is built from rather than metadata sitting
beside it. What it does not by itself deliver is a record answering to two categories at once. That
waits on a
per-record category field, which is the precondition recorded above.

---

### The bridge emits SQON; adapters translate it into their own enforcement

The bridge builds the predicate, so every application must be able to receive it in one form. That
form is SQON, the shared Overture query language, and the consequence is accepted rather than avoided:
**an application whose enforcement is not SQON-shaped has to translate.**

How that cost falls:

| Application                                    | Translation                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The search application                         | None. It consumes SQON natively                                                                                                   |
| A metadata service filtering a listing         | Real but small for the MVP predicate, a positive containment on one field, which any store expresses                              |
| A file-transfer service authorizing one object | None, because it receives no predicate. It asks whether the principal holds a grant on the object's resource and category instead |
| A schema service                               | None. It filters no records                                                                                                       |

So the burden concentrates on applications that both narrow and do not already speak SQON, and for the
MVP predicate that burden is a `WHERE ... IN (...)`. It grows only for predicates that are not
backend-neutral, and the one such predicate identified so far is specific to the search application
anyway.

**Why accept it.** The alternative distributes predicate _construction_ instead of predicate
_translation_, and construction is where every fail-open defect in this design has been found while
translation has produced none. Translating a predicate is mechanical; constructing one is not.
Pushing the mechanical work outward to keep construction central is the deliberate trade.

---

### The adapter supplies the field name, and the bridge builds the predicate

**Being told a field name for one query is not holding schema knowledge.** One bridge serves an
application, an application serves several catalogues, and the resource field name differs between
them, so it cannot be resolved once at startup. The adapter passes the bridge a map of catalogue to
field name and receives a map of catalogue to enforcement, since catalogue-level denial already
makes the answer differ by catalogue. The bridge is never provisioned with an instance's schema and
never kept in step with one, which is what excluding schema knowledge from it protects.

**The deciding reason is where fail-open defects concentrate.** Every enforcement defect recorded in
this design is a predicate-construction defect: denial expressed as a negation instead of
`matchNothing`, an empty `in` read as no constraint, a containment expression double-negating into a
test for any element rather than every element on a flat field, and a filter composing disjunctively
on the aggregation path. None is a compilation defect. Had each adapter built its own predicate from
resource names, that whole class would be reimplemented once per adapter, and drift between
applications is what the shared bridge exists to prevent.

**It trusts the adapter with strictly less**, since supplying one field name is a smaller surface
than constructing a predicate, and a wrong field name is checkable at startup beside the
mapping-shape check. **And the conformance corpus tests one implementation** rather than one per
adapter. The cost is one input on the bridge interface, and an adapter obligation to supply it
correctly.

**This governs the narrowing arm only.** The enforcement result is a union of deny, narrow and
allow, and only narrow carries a predicate:

| Application | Operation                                          | Predicate?                                           |
| ----------- | -------------------------------------------------- | ---------------------------------------------------- |
| Arranger    | Filter a search                                    | Yes, in the query language natively                  |
| SONG        | Filter a metadata listing                          | In principle, if the predicate stays backend-neutral |
| Score       | Authorize one object fetch by identifier           | No. Deny or allow only                               |
| Lectern     | Schema and dictionary service, no record filtering | No                                                   |

**A service fetching one object by identifier needs a third interface shape**: a question in Usher's
own vocabulary, whether this principal holds a grant on category C of resource R, with the adapter
resolving its identifier to that pair first. The adapter contract carries it deliberately rather
than treating every application as a filtering one.

**The post-MVP predicate is not neutral.** The MVP predicate is a single positive containment on a
field, which compiles as readily to a relational filter as to a search-engine one. Record-level
narrowing is `not` of `not-in`, whose correctness depends on the field being mapped `nested`, and on
a flat field it silently degrades to an existential match in the permissive direction. That is a
search-engine mapping concept rather than a property of the query language, so record-level
narrowing as specified belongs to the search application rather than to the platform. Where a
predicate's meaning depends on the backend, that reasoning belongs in the one component that can
vary or refuse on a declared capability.

### The enforcement component is an adapter, and the bridge ships from Usher's repository

**Adapter rather than plugin.** An Usher plugin reads as something that extends Usher itself. Usher
may genuinely have such a thing one day, but it is not what is being built: the component extends an
application, translating the permissions payload into that application's enforcement. The identity
provider side, previously also called an adapter, is a connector, so each word faces one way.

**The bridge's code lives in Usher's repository and is published from there**, and every adapter
imports it. It belongs with the protocol it implements rather than with the first application to use
it, and the conformance fixtures it has to satisfy sit beside it.

| Component            | Package                                  | Where it lives                                   |
| -------------------- | ---------------------------------------- | ------------------------------------------------ |
| the bridge           | `@overture-stack/usher-express-bridge`   | `modules/express-bridge` in Usher's repository   |
| the Arranger adapter | `@overture-stack/arranger-usher-adapter` | `modules/usher-adapter` in Arranger's repository |

**The bridge's logic does not depend on Express.** Token exchange, caching, the revocation channel
and dropping tokens live in a core that knows nothing of the web framework, and the Express layer
only wires that core into middleware and routes. A bridge for another framework is then another thin
layer over the same core rather than a rewrite, and the controller already follows that rule with
Fastify.

**Names in prose are the simple ones.** A package and its directory say more than the prose name,
here that the first bridge serves Express applications and that the adapter belongs to both Arranger
and Usher, and the documents call them the bridge and the Arranger adapter.

### Usher reuses the identity provider through the connector, and every reused feature has a fallback

**Keycloak is the first identity provider, and what Usher takes from it goes through one
component.** The connector is already the only part of Usher that knows which provider it is talking
to. Each reused feature is listed there with whether it is a standard or Keycloak's own, and
with what Usher does against a provider that lacks it.

**No fallback widens access.** Where a provider lacks a feature, Usher either does the work itself
or refuses what depended on it, so supporting another provider can cost features and never
confidentiality. The list is in [admin-model.md](admin-model.md), under the connector design.

### Admin self-grant is approved by the data's owner or custodian, from a later release

**The approvers are the data-plane authorities.** A system administrator is control-plane only, so a
self-grant reaching a resource's data needs the approval of that resource's owner or of a custodian
of a category carried by the data, and either one suffices. An approver may never be the grantee.

**The first release has no approval step.** A self-grant there is recorded, flagged in the audit
trail and limited in time, with a maximum configurable per instance and 24 hours recommended, and
nobody approves it. Adding approval later needs no restructuring: it adds an approval record and one
check, and any self-grant made before the switch expires within its time limit, so none is left to
migrate.

**A resource with no available approver keeps its grants as they are until one is assigned.** The
case needs a vacancy unexpected under the no-owner invariant, and no custodian. Existing grants are
untouched, and a system administrator assigns a new owner, which in the first release needs no
further approval. The new owner accepts the ownership grant as anyone accepts a grant. Once
approvals exist, a self-grant on such a resource waits for the new approver rather than proceeding
unapproved; the earlier stance, that an empty approver set is a satisfied one, predates owners being
approvers and is not carried forward.

---

### Granting is one function, and the data's restrictions are the last gate

An administrator may grant permissions, to themselves or to anyone else. Permissions here means more
than reading data: assigning a role, making someone an owner, giving a permission. What an
administrator cannot do is bypass what the data itself requires.

**A grant passes two stages, and who started it changes only the first.** Authority to issue comes
first, and an administrator holds it broadly. What the data requires comes second. From the release
that adds approvals, an administrator's self-grant needs the approval of the resource's owner or of
a category's custodian, as "Admin self-grant is approved by the data's owner or custodian" sets out;
the first release records and time-limits it without one. The resource's owner and a category's
custodian pass no gate: each governs their own scope, as "An owner governs the whole resource, and a
custodian governs their category" sets out below. There is no administrative path that skips the
approval, only a broader grant to enter it, **with one exception not yet reconciled**. The
adapter-level admin bypass in `admin-model.md` applies no filter at all and creates no grant; it is
off by default for health-data instances, and whether it may remain enabled where a category carries
a custodian is recorded as an open item in [to-discuss.md](to-discuss.md). Making oneself an owner
is not a second path, because that assignment is refused, as "An administrator may assign any owner
except themselves" records.

**A category may have no custodian assigned, and the resource's owner then governs it alone.**
Requiring every category to have one, as an invariant, was rejected as stricter than intended. The
control chosen is a warning rather than a refusal. Where a resource carries a category with no
custodian, the system must have warned that resource's owners, so the vacancy is a known state
rather than a discovered one.

**The vacancy removes the community's check, not a gate.** An owner may grant any category of their
resource whether or not it has a custodian, so a vacancy opens no path that was otherwise closed. What
it removes is the custodian's view of every grant on the category and their power to revoke one,
which is the main constraint on an owner releasing community-governed data. The warning is the
compensating control, and the owners carry the responsibility to act on it.

**Two vacancies exist in this model, and they are remedied differently.** A resource can lose its
owner, and a category can lack a custodian. The shape is the same, a governance seat is empty, and
the answers are not:

|                      | resource with no owner                                                | category with no custodian            |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| prevented            | yes: removing an owner requires transferring first                    | no                                    |
| if it happens anyway | the administrator is notified                                         | the resource's owners are warned      |
| in the meantime      | grants are untouched, and the administrator may suppress the resource | the owner governs the category alone  |
| filled by            | an administrator assigning a new owner, who accepts                   | the community, appointing a custodian |

**The remedies cannot be the same, and that, rather than mere strictness, is why the invariant was
rejected.** An owner is a platform role, so an administrator filling a vacant one is ordinary
administration, and `admin.override` records it. A custodian represents a community, and an
administrator filling that seat is precisely what the role exists to prevent. The ownership remedy
is therefore unavailable here, because of how this is built. And if grants froze until a custodian
existed, with only the community able to supply one, the platform would either wait indefinitely or
press someone into a seat they are not the right person for. A warning is worse than a working gate
and better than either of those.

**Decided: the vacancy is a governance failure, and it is not engineered around.** A category exists
before any data carrying it can be submitted, since a resource cannot be registered without declaring
its categories and data cannot be submitted to a resource that has none. Appointing whoever governs a
category belongs to establishing it. A category that reaches live data with no custodian is
therefore a process that was not followed rather than a state to absorb, and the design does not try
to cover every failure of an instance to follow its own process.

One mechanism was weighed and is not built: refusing new grants on a category with no custodian,
while leaving existing ones alone. It fails closed without freezing what already works, and the
ownership case uses the same shape. It is unnecessary under the decision above, and it is recorded
so that a later reader knows it was considered rather than missed.

**What this obliges instead.** The responsibility moves to whoever runs an instance, so it has to
reach them: the sequence of establishing a category, appointing its custodian, and only then
accepting data, belongs in operational guidance rather than only here. A responsibility recorded in a
design document and nowhere else has no owner.

**Three custodian questions stay open, and all resolve after MVP**, since nothing appoints a
custodian in the first release. They are recorded so the reasoning above is not mistaken for having
settled them:

- **The reasoning covers a seat that was never filled, not one that empties later.** A custodian can
  retire or leave the community role years after the category was correctly established, and no
  process was violated when that happens.
- **A candidate answer exists and is not chosen:** while a category has no custodian, refuse to
  create new grants on it, leaving everything already running untouched.
-  **Owners currently get a stronger response than custodians do.** An ownerless resource can be
  suppressed entirely; a custodian-less category stops nothing. Whether that ordering is right is
  worth revisiting alongside the two above.

And separately: whether categories are cut per community rather than as one generic label decides
whether platform-wide custodianship means a community governs its own data or one seat governs
several communities'. That question belongs to whoever the data belongs to, not to this document.

**Scope.** The ownership half is MVP and is specified in
[permissions-model.md](permissions-model.md) § No-owner invariant. The custodian half arrives with
community custodianship, which is post-MVP, and so does the audit record of a grant issued while its
category had no custodian.

Two things follow for the implementation. The warning must be delivered and recorded rather than
displayed, because a control that depends on someone reading it needs evidence it was sent. And the
access it permits needs its own audit event: reached without grant because none was configured is
a different fact from approved.

**Open: whether appointing a custodian needs a second party.** An administrator who may appoint
custodians can appoint themselves, then grant to themselves. The control's strength therefore
rests on appointment being harder than granting. Appointment must at minimum produce its own audit
event.

**On the portal flows.** Flow 5.6 says an administrator has no sharing controls. That is compatible
with this if it describes the portal's interface rather than the permission. The portal's sharing
journey is the resource owner's, exercised in the portal; the administrative permission lives at
Usher's API. Both are control-plane acts, and the flow describes which surface offers them rather
than who holds them. Worth confirming with the author.

---

### An owner governs the whole resource, and a custodian governs their category

**Both act without the other.** An owner may grant and revoke access to every category of their own
resource, a custodian-governed one included. A custodian may grant and revoke access to their
category in every resource carrying it. Neither needs the other's approval. An administrator's
self-grant is the exception: from a later release it needs an owner's or a custodian's approval, as
"Admin self-grant is approved by the data's owner or custodian" records.

**Why not a gate on owners.** Making the custodian's grant the final gate for an owner as well was
weighed and set aside for now. Under it, assigning a custodian silently takes authority from an
owner, and who may assign custodians is not settled. A custodian allowing an owner to act one dataset
at a time was weighed as a middle course and set aside with it. Either can be adopted later without
restructuring, since the grant and its audit record have the same shape under all three.

**What this accepts.** An owner can release community-governed data without the community's
approval. Three things constrain it without preventing it: the custodian sees every grant made on
their category and can revoke it, grants are watched per actor for unusual rates, and each is
audited. The Indigenous data governance frameworks put decisions about a community's collective
information with the community, so this is the position most in need of testing in the consultation
with the communities concerned, and a gate on owners is the first alternative to take to it.

**An administrator may assign any owner except themselves.** Assigning a new owner is ordinary
administration, recorded as `admin.override`, and the new owner accepts the ownership grant as usual.
Assigning ownership to oneself is refused at the endpoint, as a self-grant's rules are enforced
there, because an owner needs no approval to grant themselves data and the assignment would reach
data with nobody else deciding. It follows from a system administrator being control-plane only.

### One account, several addresses, and only verified ones bind

A principal's account has a single identity in the identity provider and may be reachable at more
than one address: a personal one serving as the username, and one for each of the principal's
organizations, which may repeat where the same work address serves several. The motivation is that a
contact address is what other people use to reach someone, and it should not be the address that
identifies their account, particularly for an administrator.

Two consequences for grants:

- **An access invitation matches on any of the account's addresses, not only the username.** This is
  the same conclusion as the placeholder decision below, arrived at from the account side rather
  than the invitation side.
- **An address may bind a grant only once verified.** Otherwise claiming an address is enough to
  collect grants intended for whoever really holds it, which turns address entry into a grant-theft
  path. Verification is what makes a secondary address usable, not mere assertion.

**Where the grant is displayed, the contact address is the one to show.** Requirements ask that a
recipient see who shared data with them. Showing the sharer's name and organizational address
satisfies that without exposing the personal address identifying their account.

**To verify before designing against it: whether the identity provider models more than one address
per user natively, or whether secondary addresses are custom attributes.** If the latter, this design
has to specify the verification flow for a secondary address rather than inherit it, and the
security property above depends on that flow existing.

---

### The invited email is a placeholder, not an identifier

An invitation is held against an email address only until it can be attached to a Keycloak
subject. The magic link in the invitation is what performs that attachment, and it binds the grant
to **whichever account the recipient confirms with**, whether that account is created in response to
the invitation or already existed under a different address. Confirmation happens after account
creation for a new account, or after logging in for an existing one.

This contradicts the portal flows, which hold a grant pending when the recipient registers under a
different address than the one invited. The flows treat the invited address as the identity; this
design treats it as a placeholder that is discarded once a real subject exists, which is the
existing decision that the identity provider's subject identifies a principal.

**The link is a bearer credential for the grant.** Whoever holds it and confirms receives the grant,
since the whole point is that the confirming account need not match the invited address. Expiry and
single use are therefore load-bearing rather than hygiene, and forwarding is the threat to state
explicitly in the threat model.

---

### An instance designates which of its existing fields identifies a resource

Confirmed for the first instance and generalized: a catalogue's resource field is chosen from fields
already carried by the data, and which field plays that role is the instance's designation rather
than a property recognized by Usher. The environmental catalogue's shape is taken as given for MVP
purposes; if it changes, MVP is unaffected, because what matters is only that _some_ existing field
carries the instance's collection and that the adapter is configured with its name.

---

### The admin role governs who may reach what, and reaches data only by granting it to themselves

"Admin" is short for **system administrator**. The authorities that administer access _to data_ are
the Owner and the Custodian, and calling those data administrators is the clearer reading of the
role set: one administers the system, the others administer access.

A system administrator sees everything held by Usher and none of the data it governs:

| Sees                                            | Does not see                                  |
| ----------------------------------------------- | --------------------------------------------- |
| Users and the grants they hold                  | The records inside a resource                 |
| Resource metadata: what a study is, who owns it | Anything a normal user would need a grant for |
| Audit logs                                      |                                               |

Open data is the one exception, and it is not really an exception: a system administrator reads it
because everyone does, not because of the role.

**Why this is stronger than the alternative.** A platform-level view that is not grant-based
produces no grant record, and the audit trail around administrative data access assumes one exists.
Confining the administrator's authority to what Usher holds means there is nothing to audit rather than an
unaudited permission, which is a better position than logging a power that need not exist.

**Self-grant exists, and what changes over time is its approval requirement.** A system
administrator holds no standing data access and may grant it to themselves explicitly. In MVP that
self-grant needs no approval. Once community custodianship is implemented it will.

**So build it as an authority check carrying an exception, not as a bare write.** A self-grant is a
grant like any other, and a grant is issued by a grant authority: a resource's owner for the
resource, a category's custodian for the category. What MVP changes is not the mechanism but the
presence of an exception letting an administrator bypass that authority for themselves. Written this
way the later change removes a branch, rather than introducing an approval workflow where none
existed. That is the difference between a configuration change and a redesign, and it is the reason
to write it this way now rather than when custodianship arrives.

**Open: whose approval.** Two answers point in different directions: permission from the resource's
owners, or approval from the custodian of the category that made the approval necessary in the first
place. The trigger for needing it at all is community custodianship, which favours the second. The grant-authority framing above
admits both without having to choose now: an administrator self-granting into a resource carrying a
category needs the resource's authority and that category's authority, and which apply follows from
what the resource carries rather than from a separate rule. Worth confirming.

**Granting to others is a separate question and is unchanged.** The portal flows say sharing belongs
exclusively to the data-plane roles. Nothing here contradicts that: self-grant is about an
administrator reaching data, not about them distributing it.

**The compensating controls matter again.** With self-grant restored as a real path, the open items
around it, what bounds it, whether a peer can revoke it, and how it is surfaced, are live rather
than moot.

---

### Ownership assignment is instance policy, not Usher behaviour

A submitter becoming the owner of what they submit is a **rule chosen by the instance**, not
Usher's own behaviour. It is true of the first instance and should not be hardcoded from
that.

Usher provides the mechanism: a resource is created with owners assigned. Which principal that is,
and whether submitting is what qualifies someone, belongs to the submission flow that calls Usher.
This keeps the ownership cascade configurable rather than built in, and it is the same reasoning as
data-agnosticism applied to Usher's own model: Usher should not encode one instance's
organizational rule as a property of the model.

**What this changes.** The cascade described in `permissions-model.md` reads as Usher behaviour and
should read as an instance-supplied policy with a default. Nothing about the mechanism changes;
what changes is who decides.

---

### Usher is the resource lifecycle management layer

Usher's scope extends beyond access decisions to owning the full lifecycle of the resources it
protects: creation, metadata management, assigning roles, category association, base tier,
suppression, and retirement.

Previously, a separate "studies management service" handled this orchestration on top of EGO.
Absorbing those responsibilities into Usher eliminates the orchestration layer and makes Usher the
single source of truth for resource metadata. Downstream services (Arranger, Lyric) reference
Usher resource IDs; they do not maintain their own resource registries.

This scope is intentionally generic: Usher manages "resources," not "studies." What a resource
represents (a study, a dataset, a project, a programme) is an instance concern expressed through
the management UI's labelling and the adapter's field mapping config. The core model is the same
regardless.

**Tradeoffs accepted.** Usher must provide a resource management API in addition to its
authorization API. This expands the implementation scope but removes an entire service from the
instance topology.

---

### SONG is file metadata only; Usher owns resource metadata

SONG's role in Usher-adopting instances is narrowed to file-level manifest data: file
checksums, donor/sample links, and file object identifiers. SONG is not a source of truth for
resource metadata (cohort names, category assignments, ownership, or who holds roles).

Previously, the studies management service used SONG as the authoritative record of which studies
existed. This created a dependency on SONG for access decisions, and excluded instances
that do not run SONG. Usher owns resource metadata instead: when a resource is created (either by
an admin or by the Lyric service account at submission time), Usher is the record of that
resource's existence, name, and category assignments.

Instances that include SONG use it for its original purpose (file manifests and genomic
metadata) and Usher for access control. Instances without SONG are fully supported; Usher has
no SONG dependency.

---

### "Study" and other domain terms are instance vocabulary

Usher's model uses generic terms: resource, role, category grant. Domain-specific vocabulary
(study, cohort, dataset, project, program) appears only in instance configuration and management
UI labelling.

An instance's own term for a resource ("study", "programme", or whatever its users say) appears in
its portal UI and in its adapter configuration, where a field name identifies which records belong to
a resource. Neither the term nor the field name appears in Usher's entity schema or API responses.
A single instance may use different terms and different fields for different bodies of data; the
mapping is per catalogue, and it belongs in that integration's own record rather than here. Stating
one instance's field name here invites reading it as a default for every instance.

Keeping domain terms out of the model is a deliberate inversion of the EGO and
studies-management-service arrangement, where "study" was a
first-class concept embedded in group names (`STUDY-<id>`) and service logic. Making the model
generic means Usher can serve instances with different domain vocabulary without code changes.

---

### A refusal carries no exception, and expiry is announced rather than inferred

**No application can implement what the onboarding document promised, and this resolves it.**
It said the existence-denying refusal could be relaxed "for someone already known to hold a lapsed
or access invitation", on the reasoning that being precise costs nothing for someone who already
knows the resource exists. The reasoning is sound and the mechanism does not exist.

**Why it cannot be implemented where it was specified.** The refusal is produced by the enforcing
application. To relax it, that application has to know the principal holds a lapsed grant. A
grant that is not live puts nothing in the token, so absence is the application's only signal, and
absence means both "your grant expired" and "you have never had any relationship with this
resource". The two are indistinguishable where the refusal is written. This is not a gap in the
adapter contract, and no adapter could close it by being more careful: no amount of diligence
recovers information never carried by the token.

**Two adapter designs reached the same conclusion independently**, which is what surfaced it. The
Arranger adapter types its deny arm as `reason: 'no-grants' | 'unknown-resource'` on the reasoning
that one behaviour "is correct for a principal with no relationship to the resource and wrong for
one who holds a lapsed or insufficient grant". Both documents concluded the lapsed case needs
different treatment; neither could carry it.

**Rejected: put the lapsed state in the token.** A marker distinguishing "grant on record but not
live" from "no grant" was available and is bounded by what the principal applied for, so it
discloses nothing they do not already know. It was rejected because it reintroduces a second state
into a model whose denial is absence, which is the same reasoning that removed the empty-grant-list
case: one state to enforce rather than two that have to be told apart. A consumer misreading the
marker as a grant admits access, and this design refuses to fail in that direction.

**Decided: neither the application nor its adapter does anything about a missing grant.** Gating
expiry and revocation is Usher's responsibility, so telling the affected person is too. The channel
is the one already carrying the grant lifecycle, the same email path by which a grant is offered and
accepted: your access to this category in this resource is about to expire, has expired, or has been
revoked.

**This is better than the exception it replaces, not merely cheaper.** A relaxed refusal tells
someone after they have hit a wall. A notice sent before expiry means they never hit it, which
removes the support burden outright, where the exception would only have softened it. Usher can also
say what an application cannot: which grant, on which resource, and when.

**The notices themselves are post-MVP, and this is what that costs.**
MVP delivers the minimum functional requirement, which is that access actually ends when a grant
lapses. Until the notices ship, a researcher whose approval expires gets a refusal that tells them
nothing and no message either, so the first release accepts in full the support burden described
above. What MVP must not do is close the door on the fix: nothing here should make the notices
harder to add, and the decision above is what keeps that true, since the notice lands in Usher's
own notification path rather than in a token field, where every consumer would then have to keep
handling it.

**Consequence for the flows, once the notices are in scope.** The portal flows mark revocation
notices as nice-to-have. They are not, under this decision: notification becomes the only thing
that tells a researcher their access ended. That reclassification applies when the notices are
built, not to the MVP cut. See the notification finding in
[../docs/uac-flows-traceability.md](../docs/uac-flows-traceability.md), and FR-09 in
[../docs/brd-traceability.md](../docs/brd-traceability.md), which records that no mechanism is
designed yet.

---

### A grant's expiry is resolved before the token is written, and enforced by the token's own lifetime

A category grant carries an expiry. The controller applies it when computing a permissions payload, so a
grant past its date is absent from the next token. No per-grant expiry travels on the wire, the
grants structure is unchanged, and an adapter never learns the concept exists: it sees a shorter list
of categories than it saw before.

**A token never outlives the first grant on it to expire.** Its `exp` is set to whichever comes
sooner, the ordinary TTL or that grant's date, so a token holding a grant that lapses in ninety
seconds is issued with ninety seconds to live. When it dies the adapter exchanges for a new one, as
it already does at every `exp`, and the new token no longer names that grant.

**The token already resolves every other lifecycle state this way.** A pending
grant, an unaccepted grant and a revoked grant are all absent rather than marked:
[permissions-model.md](permissions-model.md) § What each condition means for Usher token issuance
records that `pending`, `declined` and `revoked` never appear in any token and only `active` is
included. Expiry joins that set rather than introducing a fourth case, and it is the same reasoning
that rejected a lapsed-state marker in the decision above: denial is absence, and one state is
enforced rather than two that have to be told apart.

**Nothing has to watch the clock, which is the point.** An expiry date is known when the token is
issued, so the token can be made to stop being honoured at that moment instead of something noticing
later and pushing a message. The clock is already being read on every request, by each adapter's
`exp` validation, and that is the whole mechanism. No background job, no scheduled
sweep, and no new channel.

**Which gives one rule covering both ways of narrowing access.**

| Narrowing  | Known when the token is issued? | Mechanism                                                                |
| ---------- | ------------------------------- | ------------------------------------------------------------------------ |
| revocation | no                              | the push channel, because nothing in the token could have anticipated it |
| expiry     | yes                             | `exp`, because the token is issued already knowing when to die           |

**What it costs.** One extra token exchange per expiry per principal: the shortened token is exchanged
at the deadline, and its replacement carries a full TTL again because the lapsed grant is gone. A
principal with several grants expiring in sequence gets one short token per deadline, which is bounded
by the number of grants and is not a load consideration.

**What it does not close.** The deadline is enforced against each side's own clock, so skew between
the controller and an adapter shifts the moment by that skew. That is the ordinary JWT concern rather
than anything specific here, and it wants a stated tolerance during implementation rather than a
mechanism.

**Rejected: accepting a window instead.** Leaving the shortened lifetime available and unbuilt is
defensible where a few minutes past a scheduled date harms nobody. It is not where the date is a
legal boundary: an ethics approval lapsing is not a preference,
and access recorded after it lapsed is a finding whatever its duration. Shortening the token costs
one exchange, so there is nothing to trade against.

**An expiring grant writes nothing and announces nothing.** It sets no `revoked_at` and fires no
event: the controller leaves it out of the next payload it computes, so the person's other grants
and roles are untouched and nothing per person is invalidated.

**A person inactive past an expiry needs nothing either.** A token is issued to expire with the
first grant on it to lapse, so one issued before the deadline is already invalid when presented
after it, and the bridge rejects it on the `exp` check it makes anyway. An inactive bridge misses no
event.

**Expiring a grant narrows access and never widens it.** A principal or group loses permissions when
a grant ends, so expiry cannot be the mechanism by which data becomes visible to anyone else. That
constraint is what the embargo design in `permissions-model.md` violated, and the mistake is easy to repeat: a date on a grant looks like a general-purpose scheduler and
is only ever a scheduled subtraction.

---

### Additive grant pipeline with anonymous Usher token for open data

A common alternative for open data is to handle unauthenticated requests outside the
authorization system: the adapter applies an exclusion filter for all sensitive categories, no
token exchange occurs, and open access is unlogged. This creates two code paths (authenticated
vs. anonymous) and leaves open access invisible to the audit trail.

Usher issues an Usher token for every request, including unauthenticated ones. For anonymous
users the controller computes only the open-data tier (no IdP token validation, no role
lookup): the result is an Usher token containing only open-resource grants. The bridge and
adapter handle this token identically to an authenticated one.

Permission computation is additive across three tiers, always in order:

1. **Open**: computed for all users, including anonymous; no IdP token required
2. **Registered**: computed for authenticated users, from the grants they hold
3. **Controlled**: the same pass, where the category granted is a restricted one

Standards consulted: GA4GH Data Access Framework (open/registered/controlled tier model),
NIST SP 800-162 (ABAC), NIST SP 800-207 (Zero Trust).

**Every anonymous principal receives the same token, one per application.** Each receives exactly
the baseline's grants, and a token is wrapped to one application's key, so anonymous principals of
the search service and of the submission service cannot share one. Dropping it needs no version on
the baseline: a notice telling each bridge to drop the entry it holds for principals with no `sub`
evicts exactly one thing and carries no payload, since a bridge that exchanges again receives
whatever is correct now.

**A category change is announced by resource instead**, and only to the applications that serve that
resource, so no application learns of a resource it does not serve. See [the decision on announcing
a category change](#a-category-change-is-announced-to-the-applications-that-serve-the-resource).

**Tradeoffs accepted.** Every unauthenticated request triggers a token exchange call to the
controller. For high-traffic open-access instances this is additional load compared to a
static exclusion filter. The cost is mitigated by the fast-path refresh and by the Valkey-backed
payload cache shared across controller instances; it is accepted in exchange for audit
completeness and a single code path across all access tiers.

---

### Where DCAT defines a word used by Usher, DCAT's meaning governs

**Status: direction set, one mapping open.**

The terminology work to this point tested words against each other inside this corpus, which is
exactly the condition under which a group agrees on a word that means something else everywhere
else. W3C DCAT is the standing vocabulary for describing data on the web, it defines several of the
words already load-bearing here, and checking against it costs nothing that guessing does not.

**The class definitions, quoted from the specification rather than from a summary.** Retrieved from
the DCAT 3 recommendation and confirmed against the raw document, because a summarizing fetch of the
same page rendered "representations" as "serializations or formats", which would have been quoted
here as normative text.

| Class               | Definition                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dcat:Resource`     | Resource published or curated by a single agent                                                                                           |
| `dcat:Dataset`      | A collection of data, published or curated by a single agent, and available for access or download in one or more representations         |
| `dcat:Distribution` | A specific representation of a dataset                                                                                                    |
| `dcat:DataService`  | a collection of operations accessible through an interface (API) that provide access to one or more datasets or data processing functions |
| `dcat:Catalog`      | A curated collection of metadata about resources. Sub-class of `dcat:Dataset`                                                             |

The American spelling of `dcat:Catalog` is theirs and is part of the identifier. It is not a Canadian
spelling defect and must survive any bulk pass over this file.

**What already agrees.** `resource` is used here as the generic unit that makes no assumption about
what the data is, which is what DCAT uses it for: the superclass above Dataset, Catalog and
DataService. That choice needs no defence it did not already have.

**The hierarchy is what makes the mapping work, and reading the definitions without it misleads.**
`dcat:Catalog` is a sub-class of `dcat:Dataset`, which is a sub-class of `dcat:Resource`. So "this is
metadata about data" and "this is a body of data" are not competing answers: in DCAT a catalog _is_ a
dataset, and calling something a catalog says more about it rather than something else.

**Which is why Arranger's word survives contact with the standard.** What an Arranger catalogue
indexes is largely metadata about sequencing files, joined with clinical data about the donors of
those sequences, so it is a curated collection of metadata about resources in DCAT's sense. The
bio-research shape of the platform is what makes this true rather than a coincidence: the
indexed records describe lab materials that live elsewhere. The clinical half is data in its own
right rather than metadata about a `dcat:Resource`, which is the part that keeps the fit from being
exact, and the sub-class relation absorbs it, since whatever is not Catalog is still Dataset.

**The resulting reading:**

| Thing                                                     | DCAT class                                   |
| --------------------------------------------------------- | -------------------------------------------- |
| Arranger, Lyric, Score, Song: the API a principal queries | `dcat:DataService`                           |
| one Arranger catalogue                                    | `dcat:Catalog`, and so also a `dcat:Dataset` |
| the body of records a catalogue indexes                   | `dcat:Dataset`                               |

The service and the catalogue are different things. They were competing for one slot only because
they had not been told apart, and separating them is what resolves the mapping.

**The three facts it rests on, established against Arranger's code and published documents.** Two
catalogues may be configured over one index: `catalogueId` is the only identity enforced by the
server, `documentType` is explicitly not unique, each catalogue names its index in its own
`base.json`, and nothing compares those names across catalogues. Deleting a catalogue removes
configuration and no data, since Arranger has no code path that deletes a data index; the one
`indices.delete` on anything resembling one targets the deprecated project metadata index. And a
catalogue is configuration rather than storage, as Arranger's published documents state directly.
One limit: the absence of the constraint is established from Arranger's code rather than from a
deployed instance of two catalogues sharing an index, so the claim is that nothing prevents it.

**Arranger reached the same shape independently, which is the stronger half of the evidence.**
Arranger's published concepts document opens "A **catalogue** is one searchable dataset in Arranger.
It maps to a single Elasticsearch index and carries its own set of JSON configuration files". That
sentence was written with no knowledge of DCAT, by people describing their own system in plain
language, and it lands on something made true by the sub-class relation rather than on a rival
claim. An outside reference confirming a word is worth less than an outside reference arriving at
the same shape from the other direction.

**What DCAT cannot do, recorded before anyone cites it for more than it says.** `dcat:Dataset` spans
granularities by design: a study is a collection of data published by a single agent, and so is a
catalogue, and both are Datasets. So the standard legitimizes `dataset` as a word for a body of data
and settles nothing about _which_ body. Arranger's published glossary uses it at catalogue
granularity and Usher's onboarding document uses it at resource granularity, and DCAT makes both true
at once. Anything deciding between them has to come from this model rather than from the standard.

**Scope, stated so it is not assumed wider.** The commitment is terminological: where DCAT defines a
word used here, the usage should not contradict DCAT. It is not a commitment to publish DCAT
metadata, expose a catalog endpoint, or model anything in RDF. Whether Overture should do that is a
real question with real discoverability value, and it is a separate one.

---

### The two permissive failures are closed, and neither needed a new mechanism

Both were recorded as blocking items rather than resolved, on the reasoning that they were
enforcement defects found while preparing the first integration. Both close from facts already in
this file, and leaving them open cost more than deciding them: a design document that discloses
two ways of failing open teaches a reviewer that the fail-secure property is aspirational.

**An unauthenticated request never renders to an absent filter.** The measured behaviour above is
that an empty `and` and an empty `or` both compile to match-all, and an `in` with an empty value
list is the only fail-closed encoding available. So the rule is mechanical: **the only encoding of
what a principal may reach is a positive `in`, and the only encoding of "nothing" is that same `in`
with an empty list.** An unauthenticated request renders to an `in` naming the resources open to
everyone, which is empty where none are, and a request against a resource carrying no restriction
renders to an `in` naming that resource. Two states that previously produced the same absent filter
now produce different value lists, and neither can produce match-all.

The adapter returning nothing is therefore a defect rather than a shorthand. Where an adapter has no
filter to apply it has failed to compute one, and the correct behaviour is the 503 path rather than
an unfiltered query.

**An unconfigured resource value is closed at creation, because query time cannot close it.** The
asymmetry was that the record path tests positively, listing only configured resources so an
unknown value falls outside, while the ceiling tests negatively, excluding provenance that names a
resource in the complement so an unknown value is never excluded. The obvious repair is to make the
ceiling positive too, and it is not available: a subset test over a multi-valued field needs a
`nested` mapping or `terms_set`, and the compiler offers neither, which is why the complement
encoding was chosen.

What follows is that an unbounded value cannot be bounded at query time, so it must not exist by
then. **A derived record whose provenance names an unconfigured resource is not created.** The
service creating it validates provenance against the configured set at that moment, which is the
only moment with both the full provenance and the full configured set in hand, and refuses
otherwise. This sits naturally beside the existing requirement that provenance is stored at
creation, since derivation-time state cannot be reconstructed afterwards.

**Why a second query-time check is not specified.** A filter cannot ask whether a value is absent
from a list it was never given, so there is no expression that detects the case it is meant to
catch. Specifying one would produce a check that looks like a safeguard and tests nothing, which is
worse than the gap it covers. The compensating control is that the creation path refuses, and that
refusal is where the conformance case belongs.

---

### Records not covered by any category are `unmarked`, and open is who reaches them

**Every resource has one implicit category, `global.unmarked`, covering the records not covered by
its other categories.** Every other category is concrete: it is defined by a field value carried by
records, and the adapter renders it as a positive clause naming that value. `unmarked` has no value
of its own. It is what is left once the concrete categories have selected theirs, so its clause is a
complement, and no resource lists it because every resource has it.

**Open is not a category.** It names who reaches a resource's unmarked records. The earlier framing
made `open` a category, so one word named both which records and who reaches them, and reading the
baseline as evidence that `open` was an ordinary category conflated who holds a grant with what the
grant selects. Separating the two is what "Who holds a grant can follow a rule" requires: `unmarked`
is what a grant selects, and open is one answer to who holds it.

**A resource's unmarked records are reached in one of three ways**, a setting on the resource:

| Setting    | Who reaches the unmarked records                        | Through            |
| ---------- | ------------------------------------------------------- | ------------------ |
| open       | everyone                                                | the baseline       |
| registered | anyone signed in                                        | the signed-in rule |
| by grant   | holders of a grant naming `unmarked` on that resource   | ordinary grants    |

**By grant is what makes the leftover reachable when it is not open.** Under the earlier framing,
removing `open` from a resource left its uncategorized records covered by no category, so no grant
could name them and not even an administrator's self-grant reached them. `unmarked` gives them a
grantable name, and an owner can grant it like any other category.

### Where the settings come from, both in MVP

**Per resource.** Any resource takes any of the three settings, independently of the concrete
categories it carries. A resource may be set to registered and still carry `controlled`: the
registered setting reaches its unmarked records, and its controlled records need their own grant.

**Per instance.** The instance names a new resource's starting setting. It is copied onto the
resource when the resource is registered, as `base_tier`, the least access to its records, so
changing the default later changes only resources registered afterwards. Resolving the default at
request time instead was rejected: one configuration change would then open every resource that
never set its own. Where that default is open, a warning at submission time says so, so that nobody
publishes openly by not choosing. Where it is by grant, a new resource's records are reached by
nobody until someone is granted `unmarked` or a concrete category on it.

**The submission-time warning is not yet designed**, and its wording matters more than most: it is
the only thing standing between a default and an accidental publication.

---

### The shipped capability vocabulary is CRUD, and nothing else ships

**`create`, `read`, `update`, `delete`.** Four names, taken from a convention already familiar to
every implementer, rather than invented here. `view` becomes `read` and `edit` is retired: it
straddled creation and modification, and its single appearance in this corpus argued for a read and
write split rather than for that particular word.

**`view` came back, as one member of `read`.** Seeing a record is `view` again, and `read` is the
capability group of the read-shaped capabilities; see the decision that follows this one. The four
names above are still the four acts, and `read` among them now means the group.

**They are granted independently, and no role is a rung above another.** A grant may carry any subset.
Not every ushered service offers all four, and one that serves no writes offers none of the last
three, which is the same rule that already governs a service offering `download` it cannot perform.

| Group or role        | Carries                                                         |
| -------------------- | --------------------------------------------------------------- |
| viewer               | `read`                                                          |
| submitter            | `create`, `read`, `update`                                      |
| owner                | all four, alongside the authority to manage who else holds them |
| system administrator | none by default                                                 |

**Separating `create` from `update` achieves what the provenance work could not.** A submitter
holding `create` without `update` can add records and cannot alter anyone else's. That is the
destructive half of "a submitter reaches only what they submitted", and it closes at the capability
layer with no per-record provenance, no two-level resource relationship and no record-level
enforcement. It does not close the other half: such a submitter still reads everything in the
resource they hold a grant on.

**`download` became `export`, and it ships.** The earlier position held it back as an example of a
capability added by an instance beyond the CRUD four, on the reasoning that how an instance tells an
adapter what `download` means was not worked out. The rename settled half of that: `download` names a
transport and varies, while `export` names the act and does not. The rest is now a seeding decision
rather than a vocabulary one, so `record` carries six actions and `export` is among them.

**It is seeded into `viewer`, `editor` and `curator`**, which is more honest than withholding it. The
split between viewing and exporting was never a confidentiality boundary: anyone who can view a
column through ordinary results can page through and assemble the same extract by hand. What the
split gives is rate and auditability, and those are worth having without pretending they withhold the
value. The role that genuinely should not export is the one that views no records, `submitter`, and
for it the absence means something.

**Seeding it that way also shrinks an exposure rather than creating one.** Enforcement on the export
path is unbuilt, so an adapter serving exports ungated is the state of the world either way. With
`export` held back, every `viewer` grant would have implied an unapplied restriction, which is the
severe direction of the unimplemented-capability rule. Seeded, the only role whose absence of
`export` means anything is one that views nothing either, so there is almost nothing left to fail
open. It stays declared-unenforced until the export path is gated, and the reconciliation check can
report that as a fact rather than a silence.

### `read` is a group of three, `count` counts only, and aggregation is not a capability

**`read` became a capability group, and `view` came back to name seeing a record.** On a record, a
field or an artifact the group is `count`, `view` and `export`; on a revision it is `view` and
`export`; on a control-plane entity it is `view` alone. It is expanded when a role is written, so no
token carries it and no adapter tests for it. The vocabulary is in
[permissions-model.md](permissions-model.md#data-plane).

**What it fixes is one word doing two jobs.** `read` was the R in create, read, update and delete
and also the specific act of seeing a record, so "the two planes are the same four acts" held only
at the coarse grain while the seeded matrix showed six capabilities. With the group both grains hold
at once: `curator` carries four acts and six capabilities, and neither statement contradicts the
other.

**`aggregate` became `count`, and the name is made true by narrowing what it permits.** `aggregate`
governed whether records or a field contributed to aggregations of any kind, and not every
aggregation is a count: `min` and `max` return a field's extreme values and `top_hits` returns
records. Renamed without narrowing, `count` would have granted the extremes of a sensitive numeric
field to a role described as counting. So `count` permits counts only, and anything returning a
value or a record needs `view`.

| Option     | On records | On fields                          | Why not                                                    |
| ---------- | ---------- | ---------------------------------- | ---------------------------------------------------------- |
| A          | `count`    | `count`, meaning every aggregation | the name misleads, which is what the rename existed to fix |
| B          | `count`    | `aggregate`, kept                  | one concept with two names across entities                 |
| C, adopted | `count`    | `count`, meaning counts only       |                                                            |

**Aggregation is the operation, and it consults whichever capability fits what each aggregation
returns.** Making `aggregate` a group of `count` and `view` was rejected: a role meant for summary
statistics would hold `view` and so see every record, the name promising less than it grants. As the
operation, nothing named `aggregate` is ever granted, so nothing is granted by it by accident.

**No seeded role holds `count` alone, and the name `surveyor` moves to a later role.** The discovery
role expected to be needed first views a bounded number of records and counts nothing, and it is
post-MVP. Seeding `surveyor` now as a count-only role and redefining it later would widen every
grant naming it, since a grant confers what its role carries at issuance, so the name waits for the
role it will mean.

**One consequence follows.** A principal holding `count` alone sees totals and no facets, since a facet lists its buckets and each bucket's key is a value. What serving such a principal would take is research, in [count-only principal](../docs/atlas/roadmap/count-only-principal.md).

---

### A category either partitions or overlays, and only the first decides what `unmarked` covers

**A fixed category selects the same records for everyone.** `controlled` names records marked
as controlled in an instance, and the set is the same whoever asks.

**A principal-relative category selects different records for each asker.** `own` names the records
whose submitter field holds the identity of whoever is asking. The adapter already maps a category to
a field, and it already holds the asking principal's identity, so it can render this without Usher
learning the field name or any value in it. It fails closed in the ordinary way, since a record
missing that field matches nothing.

**The axis that decides the residual is partitioning against overlay, and fixedness is not it.**
A **partitioning** category carves up the record set, and `unmarked` is what the partitioning categories
leave. An **overlay** selects within that set and changes nothing about what `unmarked` covers, so a
record can carry an overlay and still be unmarked. The test is one question: does this category take part
in the residual calculation?

**Principal-relative implies overlay, and the converse does not hold**, which is why stating the rule
as "only fixed categories decide what `unmarked` covers" is true and incomplete. `own` must be an overlay
because every record has a submitter, so as a partitioning category it would empty the residual
entirely. But a category can be perfectly fixed and still have no business narrowing `unmarked`: a
`high_quality` marker is the same for everyone, and partitioning on it would mean an unmarked-only grant
sees exactly the records that failed quality control. `own` is an instance of the rule rather than
the reason for it.

**The same distinction runs on the field axis.** `basic` is whatever the partitioning field
categories do not cover, so a field category that classifies without partitioning leaves `basic`
untouched and a column can be both basic and flagged.

**It lives in adapter configuration and has no counterpart in Usher**, for the same reason as `kind`:
what a category selects is the adapter's mapping, and Usher can neither know nor verify it. It differs
from `kind` in one way that matters. A grant's column says which axis a category scopes, so position
encoded that one; nothing about a grant distinguishes a partitioning category from an overlay, since
both sit in `record_category_id`. So this is one more field in the mapping that already says what
each category selects, and there is nowhere else it could go.

**The failure directions are asymmetric, and the dangerous one is silent.** Mark an overlay as
partitioning and `unmarked` empties: loud, immediate, and impossible to miss. Mark a partitioning
category as an overlay and the complement no longer excludes it, so `unmarked` now covers the records it was
meant to remove, and every principal holding the open grant reaches controlled data. Nothing
downstream can notice, because the clause is well-formed and the token is correct; only the adapter's
own configuration holds the mistake. **That makes it a sixth condition for the reconciliation check,
and an unusual one: not a mismatch between two declarations, but a single declaration that is wrong.**

**`own` is post-MVP.** The mechanism is understood and it is not in the first release.

**What that settles for a submitter, and what it leaves.** The corpus records three times that a
submitter reaching only their own submissions is not expressible. The reason is not the enforcement
level: it is that the submitter's identity is not a category, so no category clause selects on it.
That is now narrower on both sides. The half where it matters most is already closed by the
capability split, since a submitter holding `create` without `update` cannot alter anyone else's
records. The half that remains is reading: in the first release a submitter reads everything in a
resource covered by their grant, their colleagues' submissions included. `own` is how that closes
later, which makes it deferred rather than unbuildable.

**One decision to revisit when `own` is built.** "A self-scoping predicate is not an access decision"
says Usher is not involved in questions the record and the identity answer between them, and that
routing them through Usher is a mistake. `own` routes one through Usher deliberately, with the work
split: Usher decides whether someone may reach their own records here, and the adapter resolves which
records are theirs. That split is compatible with the reasoning and not with the sentence, so the
sentence needs narrowing at that point rather than now.

---

### Schema naming, and the three rules behind it

**Three renames, each from a defect rather than a preference.**

| Was               | Is                             | Why                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_groups`     | `groups`                       | Every other entity table is a plain plural. The qualifier disambiguated nothing, and it made `user_groups` and `group_users` the same two words reversed, one an entity and one a relation                                                             |
| `resource_groups` | dropped                        | Groups hold nothing in the first release, so the group half of the role assignment has no row. It returns with groups                                                                                                                                  |
| `category_grants` | `grants` and `grant_decisions` | One name covered two things. What was granted, by whom, until when, and what revocation acts on, is a grant. What one person answered about it is a decision, append-only, and naming it "grants" claimed the row was the thing it is a decision about |

**Where a site says `category_grants`, the sentence says which is meant.** A site mentioning
`granted_by`, `expires_at`, revocation, or what a token is built from means `grants`. A site
mentioning acceptance, a state, or what one person answered means `grant_decisions`.

**`grants` carries no holder qualifier**, because there is one holder. A qualifier marks a holder only
where two shapes need keeping apart, and the group-held shape is a v2 stub.

**Three rules, none previously written down, which is why the list read as inconsistent.** The first
two govern what a table is called; the third governs a set of tables rather than any one of them.

**Name a relation for what the row is, where the model has a word for it. Otherwise name it
container then entity.** A row in `role_permissions` is a permission, so it takes the first. A row in
`group_users` has no name in the model, so it takes the second. Both rules were already in use
and the list looked arbitrary because nobody had said there were two.

**A table named container then entity must actually contain those entities.** `resource_categories`
does. `resource_groups` did not: it promised groups made of resources and delivered a role
assignment. Where the row records a relationship rather than containment, the first rule applies.

**And where a set of tables is split by holder, say the holder on every one of them.** Marking one
side and not the other makes the unmarked one look like the general case. The example that motivated
this rule has since gone: grants are no longer split by holder at all, `holder_type` carries it on one
table, and the reason given at the time, that a user grant carries acceptance state where a group has
nobody to accept, was wrong twice over. Acceptance is a row in `grant_decisions` rather than a state
on the grant, and a group grant produces one decision row per member rather than skipping the step.
The naming rule stands on its own; the example does not.

**The Kind column moves into the schema block.** The block lists the tables and the classification
that makes sense of them sits twenty lines below, so a reader meets thirteen names with no way to
tell an entity from a relation from a grant. That is why the list invites resorting.

### Effective access is a ceiling narrowed by grants, and the invariant is asserted rather than documented

A role's capability is held over every `(resource, category)` pair that exists, and the grant set names
the pairs to keep. Effective access is what remains. This is the shape of the source model, whose
second stage removes from a maximum and can never add to it, and where two filters on one object
combine deny-override.

**It describes the result and not the computation.** Grants are stored and unioned as rows, which
produces the same set; nothing enumerates the universe. RABAC states the same caution about its own
definition, that the description specifies the net result and any optimization is permitted that
reaches it.

**`effective ⊆ ceiling` is asserted where the token is issued.** A property that lives only in prose
is re-derived by whoever reads it next, and this one has to hold at every site that builds a permission
set. As an assertion, a path that forgets to intersect with the ceiling fails; as a sentence, it
passes.

**Four behaviours stop being separate stipulations.** No grants means nothing reachable; a resource
carrying no categories is reachable by nobody; an empty category does not satisfy its own condition;
a category can only ever restrict. Each was asserted on its own, and the third was found as a shipped
hole rather than designed. All four are the same consequence of one rule, so they can no longer drift
apart.

**Fail-closed is structural here rather than a matter of appetite.** An object with no applicable
filter keeps its permissions in RABAC, because a NIST RBAC permission is an `(operation, object)` pair
whose object the role has already named. Usher's ceiling carries verbs only, so the same default would
confer everything.

**Union survives unchanged, and the rule that replaces it is known.** A union of pairs kept is still a
subtraction from the maximum, and two grants cannot contradict because neither can deny. Once a
withholding rule exists, filters combine deny-override and it beats any number of grants.

**The reader-facing prose states the true subset.** Nothing is reachable by default, a grant opens a
path, and a category is a condition of entry. The edge is named where the others are named:
withholding takes access away and no grant restores it, and the additive telling can express
everything except that.

### A known-future item stays in the design, because its shape constrains the present one

Scope decides what gets built. It does not decide what gets designed. Where something is already
known to be coming, its design stays in the corpus with enough shape to be checked against, marked as
not in the release rather than removed.

**Removing it is not neutral, which is the part that is easy to miss.** A model with the future item
deleted is free to drift into a shape incompatible with that item, and nothing objects, because the
thing that would have objected is gone. The item then arrives as a migration rather than as an
addition, and a migration of an access-control schema is where access is silently widened or dropped.

**This happened here, inside an hour.** With groups removed, nothing held a role per resource, so the
role ceiling was rewritten as global to the person. That is coherent on its own and incompatible with
groups: restoring them required putting the resource back on the role assignment. Had the global form
shipped, adding groups would have meant migrating every role row rather than adding a table.

**What counts as enough shape.** A roadmap line saying a feature is coming constrains nothing. Columns
and relations do. The test is whether someone changing the present model would notice they had broken
the future one, and a named table with its keys is the cheapest thing that makes them notice.

**What to delete, and it is a narrow class.** Statements that are false: a mechanism described as
shipping when it is not, a claim contradicted by the requirements, a rule superseded by a decision.
Incompleteness is not falsehood, and "not yet" is not "not".

### An unimplemented capability fails closed only where the action has no path

The vocabulary is deliberately wider than any one service implements, on the reasoning that an
adapter never tests a capability it does not understand, and so nothing opens. That is true of most of
them and false of a specific class, and the class matters because the wide vocabulary is
otherwise a good decision resting on a rule with an unmarked exception.

**The rule holds where a capability permits.** `record.delete` in the vocabulary and no delete path
in the service means there is nothing to reach. Absence of the path is the enforcement.

**It inverts where a capability's _absence_ restricts a path already served by the service.** The
service is answering already; the capability exists to narrow that answer; an adapter that does not
check it narrows nothing. Holding the capability is not what opens the door, so not checking it does
not close one.

| Capability                                                                       | Absent and unimplemented                                                                                                      | Direction                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `record.delete`                                                                  | no delete path exists                                                                                                         | closed                                                              |
| `record.count`, held without it but with `view`                                  | counts are served anyway                                                                                                      | open, and mild: a count over records the principal may already view |
| `record.count`, held without `view`                                              | the discovery tier is simply not served                                                                                       | closed                                                              |
| `view`, on an aggregation returning values, for a principal holding only `count` | unreachable while the discovery tier is unserved; once served, an adapter checking `count` alone returns extremes and buckets | closed today, and **open** if the tier ships without the check      |
| `field.view` on a restricted column                                              | every column is served                                                                                                        | **open, and severe**                                                |

**The severe row is why field restriction carries the weight it does.** A field capability exists
only to withhold, so a service that has not implemented it withholds nothing, and the grant reads as
a restriction that never happened. Two things already in this design answer it: a missing `field` key
means no partition rather than no columns, so the absence is honest rather than silently permissive,
and field restriction is a seam change rather than a configuration one, so a service cannot be
half-way to having it.

**And it is the strongest argument for the controller retaining what each adapter declared.**
Without retention, a grant naming a capability unimplemented by its audience is writable, and the
mistake surfaces at query time as an unenforced restriction rather than at authoring time as a
refusal. The same holds one level down for a grant naming a field absent from every catalogue: the
clause built from it matches nothing, and whether that is safe depends on its polarity, since a
positive clause matching nothing denies while a negated one matching nothing negates to match-all.
The `unmarked` category is rendered as exactly that negation. So non-retention does not defer an
error, it converts an authoring mistake into a silent widening on the one category held by every
principal.

### Every defect found in the model has been one axis collapsed into another

Recorded as a test rather than as history, because it predicts where the next one is.

| What was collapsed                 | How it showed up                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Scope into the role                | A role held per resource, separate from the grant that scoped it                         |
| Records into the resource          | A category gating a whole resource instead of selecting records within it                |
| Two planes into a ladder           | `curator` retired by resolving it to "an owner or a viewer"                              |
| Meaning into the name              | A `kind` on the category, asserting in Usher what only an adapter decides                |
| Scope into the role, again         | Field restriction as a role-by-column matrix                                             |
| The adapter's knowledge into Usher | A `field_categories` table holding field names Usher never learns                        |
| The entity out of the capability   | Bare actions in the token, unreadable once two entities share one                        |
| Two things into one borrowed word  | `set` meaning both a saved set and whatever else a reader brought                        |
| Two acts into one word             | `read` meaning both the R in CRUD and seeing a record, so four acts met six capabilities |

**The test.** Does this put two independent questions in one slot? Each row above reads as a
simplification at the time and as a conflation afterwards, and the tell is always the same: one field
answering a question that belongs to something else. Roles answer what acts are possible; categories
answer which data; adapters answer what a category means; entities answer what an action acts on.
A design where any of those four answers another is the shape to look for.

**It also explains why the corrections cluster.** Undoing one collapse tends to expose the next,
because the conflated field was hiding the question underneath it. The plane split surfaced the role
vocabulary, the role vocabulary surfaced the capability vocabulary, and the capability vocabulary
surfaced three entities that had been folded into `record`.

### The entity decides the plane, and a relation earns a segment by having a lifecycle

A capability is `entity.action`. The plane is a property of the entity, not of the action:
`record.update` is data plane and `resource.update` is control plane, and both are "update". So the
plane is fixed per entity, and every entity sits wholly in one plane.

**The entities are a fixed list in code rather than a table.** A table of them was the first form, to
store the plane once rather than on each capability. It was replaced because a row can never add an
entity, since a new data-plane one changes the payload type and so the wire format and a new
control-plane one is new API, and a list held both in the type and in a table can drift. Holding it
in code keeps the plane stated once per entity, which was the table's reason for existing. An entity
needs no stored label either: an instance's word for one is instance vocabulary, and the decision on
domain terms keeps instance vocabulary out of Usher's schema.

**The artifact is what tests that rule, and it survives by moving the authorization.** An artifact is
a collection of records assembled and kept by someone, so it is data plane. But handing one to another
person decides who may read something, which is a control-plane shape. Had `artifact.share` existed,
a data-plane entity would confer reach and "granting is the control plane" would be false. It does
not exist, because the authorization moved to the read: every read of an artifact is checked against
that reader's own grants, so handing one over confers nothing and needs no capability. Resolving it
the other way, by calling the artifact control plane, would have made reading one a control-plane
act, which is worse.

**A relation earns its own entity segment when it has an identity and a lifecycle.** `grants` has a
surrogate id, an expiry and a revocation, so `grant.*` is right. `group_users`, `role_permissions`
and `grant_decisions` are links: acting on one is an action on an entity it joins, or on nothing.

**For a link, the entity segment names where the authority sits, which makes it a governance
decision rather than a naming one.** `resource_categories` is the live case. `category.associate`
says whoever governs the category chooses which resources carry it; `resource.associateCategory`
says the resource's owner chooses. Picking a name picks an answer, so this one is held until
custodian scoping is settled. The audit event it owes is not held: that write changes what every
principal reaches and clears the controller's payload cache, and nothing records it today.

**Answering a grant is an action with no capability**, deliberately. The authority to accept or
decline is inherent in being the person reached by the grant, so `grant_decisions` has no segment and
the empty cell is a statement rather than an omission.

### A resource is registered, not created

The capability is `resource.register`, and the word is chosen for three reasons.

**A resource is pointed at, not made.** It is a field and a value already carried by the platform's
records, so nobody draws its boundary: registering tells Usher about a grouping defined by the data.
The word "create" would suggest that Usher makes it.

**It keeps one verb to one act.** `record.create` is the data-plane act of putting records into a
resource, and naming the control-plane act that establishes the resource with the same verb would
ask every reader of a role or an audit record to tell the two apart by their entity alone.

**It still fits a resource registered before its data exists.** A resource must declare its
categories before anything can be submitted to it, so it is often registered first; registering a
study before its records arrive reads as naturally as registering a company before it trades.

The reader-facing documents use the same word: an administrator registers a dataset.

### The two planes are the same four acts on different objects, which is why `curator` came back

`curator` is the data-plane role: create, read, update and delete on **records**. `owner` is the
control-plane role: create, read, update and delete on **access** to one resource. Both carry the
same four acts, and what separates them is the object, not the breadth.

        curator   CRUD on the records reached by a grant
    owner     CRUD on who may reach one resource

**Exact at both grains, because `read` is a capability group.** On records it is `count`, `view` and
`export`, so `curator` holds six capabilities under four acts; on access it is `view` alone. The
asymmetry between the planes is real, and it lies in the members rather than in the acts.

**No role is a point on a scale.** Viewer to curator to owner reads as a ladder and is not one: an
owner reads nothing by being an owner, and a curator grants nothing by being a curator. Documents
that present "owner vs viewer" as coarse and fine permission have collapsed two axes into one, and
every plane inversion in this corpus traces back to that reading.

**The July 2026 rename retired `curator` and September reinstated it.** The retirement resolved it to
"an owner or a viewer, whichever the sentence means", which is the conflation above stated as a
rule. The reinstatement is what the grant-carries-the-role work forced: the case that settles that
decision is one person being a curator on one category of a resource and a viewer on another, and
with only `viewer` and `owner` in the vocabulary there is no name for the data-plane write role, so a
document reaching for one reaches for `owner`. A missing word does not stay missing; it gets
substituted, and the substitute here is the one that crosses the plane boundary.

**Consequence for the corpus.** `rabac-alignment.md` kept `curator` through the July pass and is
correct in retrospect. `terminology-usage.md` records the reversal rather than the retirement. The
glossary carries `Viewer` and `Curator` entries, the second stating the pairing above, because the
role against which every other role was defined had no entry at all.

### The grant carries the role, and nothing states separately what a person is trusted with

A grant says: in this resource, on this category, this holder acts in this role. Being trusted as a
curator is a decision made about a resource and a category rather than a standing property of a
person, so there is no second table asserting it and no two answers that can disagree.

    grants:  HEART_STUDY | controlled | user Ana | curator
             HEART_STUDY | open       | user Ana | viewer

    Ana reaches HEART_STUDY's controlled records at curator and its open records at viewer.

**Rejected: a separate role assignment per holder.** Two relations, one naming a user and one naming a
group, each saying which role is held where. They are one relation split by holder, and splitting it
produced two names for one thing. It also fixes a holder's role per resource, which cannot say that
Ana is a curator on one category and a viewer on another, and that case is real.

**Rejected: a group carrying its own role.** It looks tidier and it is less expressive: a set of
people would then be curators everywhere or viewers everywhere, so a team needing both would be two
groups whose membership has to be kept in step. With the role on the grant, a group is a plain named
set and the same set can be granted differently in different places.

**Rejected: resolving a grant to the holder's whole ceiling.** Someone trusted broadly would have
every grant land at their widest role. What a role permits and what a grant confers are different
questions, and collapsing them answers the second with the first.

**Differing capabilities per category within one resource is the case that settles it**, and it is
not expressible while a role is per resource rather than per grant:

    grants:  HEART_STUDY | controlled | group G1 | curator
             HEART_STUDY | open       | group G1 | viewer

    Every member of G1 reaches HEART_STUDY's controlled records at curator
    and its open records at viewer.

The same holds with a user in the holder column, the only kind written by the first release. A
group is a plain named set either way: it supplies who the grant reaches and never what they may do,
because the grant already says.

### Roles resolve at issuance, so no role travels in the token

**Once enforcement holds no policy, a role is an authoring convenience.** In the source model a role
does two jobs: a compact way to assign many permissions, and the first stage of a check evaluated
when access is attempted. This design moves the second job to issuance so that adapters hold no
policy, which leaves roles only the first, and an authoring convenience has no reason to travel in
an enforcement payload. Several roles on one resource become a union of capabilities computed before
the token is written, so there is nothing to collapse into a single field.

| Place                         | What a role does there                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| The management interface      | granting by role rather than by enumerating capabilities                                     |
| The grant store               | which role was assigned, for provenance and for recomputing when a role's definition changes |
| Usher's own API authorization | whether a principal may perform a grant operation at all                                     |

**Ownership is absent from the token for a second, independent reason.** An owner's powers are
management operations, granting, revoking and setting visibility, performed against Usher's own API,
which checks them directly. No adapter enforces them, so the enforcement payload never has to say
who is an owner.

**The same move retired the detached permission list and the empty list.** With open content a
category like any other, a resource maps to the categories held on it, every reachable record is
reached through a grant naming it, and holding nothing is absence from the map. The additive
rendering and `unmarked` decisions carry the detail. Every resource has `unmarked`, so none is
ungrantable: a resource carrying no concrete category holds all its records there.

### Acceptance is the recipient's decision and is recorded apart from the grant

A grant is the granter's act. Whether the recipient takes it up is theirs, and it is a separate row:

    Ana | HEART_STUDY | controlled | as curator | CRUD | accepted | 2026-09-18T14:32:07Z
    Bo  | REEF_ARCHIVE | controlled | as viewer | read | rejected | 2026-09-18T15:04:51Z

    Ana's token carries HEART_STUDY/controlled. Bo's carries nothing for REEF_ARCHIVE.
    Neither grant is changed by the answer to it.

**The user flows require both halves separately.** A steward shares a dataset and the recipient is
prompted to accept or decline, a declined share notifies the steward, and the recipient's dashboard
shows who shared the data, when, and when they accepted it. A single row carrying a granter's
lifecycle and a recipient's history cannot answer all of that, and revocation acts on one half while
the other is a record of what was agreed.

**The separation is what lets a group hold a grant later**, which is the reason to keep it even
though one holder needs it less. A grant made to a group produces one decision row per affected
member, and they answer independently:

    a grant to G1 on HEART_STUDY / controlled, G1 holding curator

    Ana | through G1 | as curator | CRUD | accepted | 2026-09-18T14:32:07Z
    Bo  | through G1 | as curator | CRUD | rejected | 2026-09-18T15:04:51Z

    Ana's token carries it, Bo's does not, and the group's grant is unchanged by either.

So a group grant does not bypass acceptance, which was the objection to groups holding grants at all.
Acceptance was never a property of the grant; it was in the wrong place. A group cannot take on an
obligation, and what a member accepts is what it confers on them.

**The row is an event and the table is append-only.** A decision is a past act, so a later decision
about the same grant is another row rather than an edit, and the current answer is the latest row for
that member and grant. Nothing about a member's access is revised in place, which means no widening
can be introduced by an update.

**The decision time is a UTC instant, never a date.** The rule that selects the latest row needs a
total ordering, and two decisions about one grant can land in the same day, the same hour, or the
same minute. A date-typed column makes the authorization answer depend on row order or on an
unspecified tiebreak. UTC rather than a local zone because the people deciding, the instance, and
whoever later reads the record are not reliably in the same one, and because an offset that shifts
twice a year can put a later decision before an earlier one.

**Nothing stores effective permissions anywhere.** They are computed at issuance from the decision
and what the grant's role confers at that moment. So the table is `grant_decisions`: a name
saying "grants" would claim the row holds the access rather than one person's answer about it.
`user_grants_history` was the alternative and was rejected for implying a current-state twin that
does not exist in this design.

**Revocation and expiry never touch these rows.** Both are the granter's act or the grant's own
lifecycle, so they belong to the group's grant. This table holds one person's decisions and nothing
else, so `expired` and `revoked` are not states on it.

**What is accepted is the outcome, stated per category.** Not membership of a group, but the
capabilities held on one category of one resource. The grantee can act only on that form, because
it is the only form that says what they are taking on, and for controlled data what they are
taking on is usually an obligation rather than a privilege.

**A granter and a grantee decide different things**, which is why these were never one field. The
grant records the granter's decision. The acceptance row records the grantee's.

Four consequences:

1. **A group grant does not bypass acceptance.** It was not a route around a control; acceptance was
   in the wrong place.
2. **The user rows and the group grant cannot contradict each other.** There is one grant and a record
   of each member's decision about it. A record of a decision is not a copy of the thing decided.
3. **The permissions stored on the row are a snapshot rather than a cache.** They are what the member
   was told when they agreed, which is what makes them worth storing and what makes later divergence
   visible. A cache would be refreshed; this is never rewritten.
4. **Divergence has a safe rule: keep what was accepted intersected with what the role now confers.**
   A grant's role narrowing from curator to viewer needs no re-asking, since the member agreed to
   more than they now hold. A widening leaves the added capability unaccepted until accepted.
   Narrowing is silent, widening asks.

**A grant conferred by a rule on `unmarked` requires no acceptance, for two reasons that cover both
settings.** An anonymous request has nobody to accept, and for the registered setting, accepting the
platform's terms of access at registration is the acceptance. So acceptance attaches to grants held
one per holder, and never to what a rule confers.

The `Auto-accept` flag is unaffected and remains the instance-level exception, for machine-to-machine
sharing and internal pipelines where an acknowledgment has no one to come from.
