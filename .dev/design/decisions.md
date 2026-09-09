# Design Decisions

Key architectural choices and the reasoning behind them, including tools reviewed and not adopted.
Where a reviewed tool influenced the design, that contribution is noted.

---

## Tools reviewed before building

### Cerbos

Cerbos is a standalone PDP (Policy Decision Point) service. Applications send a request containing
user context and a resource; policies are defined in YAML files.

**Two response modes.** A check returns an allow/deny decision. `PlanResources` performs partial
evaluation and returns a query plan: a discriminated result of `KIND_ALWAYS_ALLOWED`,
`KIND_ALWAYS_DENIED` or `KIND_CONDITIONAL`, the last carrying an AST of operators, variables and
literals, with prebuilt adapters compiling that AST into ORM queries.

**What it contributed.** The standalone PDP service pattern, rather than an embedded library, is
the right architecture for an authorization service shared across applications, and its REST API is
a reference for Usher's decision API: a clear request schema (principal, resource, action) and a
structured, auditable response. Its query plan returns the same three-way result Usher's
enforcement path returns.
`Enforcement` is the same three-way discriminated union and SQON is the same condition AST.

**Three requirements an evaluation would test it against.**

1. **Enforcement against Elasticsearch through SQON.** Cerbos ships query-plan adapters targeting
   ORMs; the first adopter's backend is reached through SQON, so this requirement asks what a
   SQON adapter costs to write.
2. **A revocation channel that pushes grant changes to plugins and suspends serving when the
   channel goes quiet past a grace period.** Usher's fail-secure behaviour depends on this.
3. **Delegated governance:** a custodian holding grant authority over one data category
   platform-wide, fully audited, holding no other administrative rights. This is the OCAP
   requirement and the least likely to be satisfied off the shelf.

A management UI ships in Cerbos Hub rather than the open-source product (see below).

**Assessment status: not run.** The query-plan capability above satisfies the structured-output
requirement. The three above are what remains to test, and they are read from Cerbos's
documentation rather than from running it.

---

### OPA as the decision engine

OPA (Open Policy Agent) is a CNCF-graduated general-purpose policy engine. Policies are written in
Rego and evaluated against input data. OPA is widely adopted for Kubernetes admission control and
API gateway authorization.

**What it offers.** OPA is mature, well-maintained, and well-recognized. Teams familiar with
OPA from Kubernetes work know how to operate it, write policies, and integrate it into CI/CD. Using
OPA as Usher's evaluation engine would have offered ecosystem familiarity as an adoption benefit.

**What it contributed.** OPA's concept of partial evaluation directly influenced the grants token
design. In partial evaluation, OPA accepts some known facts and some unknown ones, and produces a
residual: an unevaluated expression that represents the remaining grants. Usher's grants
token is the same idea in a different form: rather than returning a binary answer, Usher returns the
full set of category grants for the requesting application. The plugin applies that set as a query
filter, which is structurally a residual evaluation applied at the data layer.

OPA also reinforced the value of externalizing authorization state as explicit, queryable data
rather than encoding it implicitly in application logic. That principle is central to Usher's grant
model.

**Why not adopted.** Usher's decision logic is a grant data lookup, not policy evaluation.
The question "what can this user see or do?" is answered by querying which grant records exist for that
user. There is no Rego logic to evaluate: the policy IS the grant record. Using OPA would mean
feeding the grants database into OPA's data store and writing Rego that simply reads it back. That
adds operational complexity (data sync between the grants store and OPA, Rego maintenance) without
adding capability. The migration benefit OPA offers (ecosystem familiarity) also depends on
exposing Rego policies as a customization surface; if the Rego is internal, that benefit does not
transfer. If it is exposed, it adds significant complexity to what is currently a clean, well-defined
data model.

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
plugins: the per-application code that receives the grants token and translates it into
data-layer query filters.

**What it offers.** The mapping from a category grant set to a concrete query filter (e.g.,
"category `registered` in resource `cohort-A`" maps to a specific Elasticsearch DSL fragment or SQL
predicate) is deployment-variable and schema-specific. This is precisely the kind of externalizable,
auditable policy logic OPA is designed for. Organizations already running OPA sidecars could
potentially integrate Usher's enforcement by adding a policy bundle rather than embedding a new
library.

**What it contributed.** The sidecar deployment model: the plugin does not need to be embedded in
application code. It can run as a separate process that the application calls. This pattern,
well-established in OPA deployments, is a valid option for Usher plugins and the plugin interface
is designed to accommodate it.

**Why not mandated.** OPA's primary model for keeping data current is bundle pulls: periodic
fetches from a bundle server. Usher's revocation channel is a push model: the plugin must subscribe
to real-time grant change notifications and invalidate its cached token promptly. These two models
do not align. OPA bundle pulls introduce a staleness window that conflicts with Usher's revocation
guarantees. The time-critical parts of enforcement (revocation subscription, fail-secure on channel
disruption) still require custom plugin code regardless of whether OPA is involved. OPA would
cover only the filter translation slice of a plugin that still needs custom revocation handling.

**Decision.** OPA is not required at the enforcement layer. The plugin SDK handles the generic
parts: JWE decryption, revocation channel subscription, TTL management, and fail-secure response.
Teams with existing OPA investments can use OPA for query filter translation within their plugin
implementation. The plugin interface is designed to accommodate this without requiring it.

---

### Cerbos Hub

Cerbos Hub is a commercial SaaS product that adds a management UI on top of the open-source Cerbos
PDP. It is not self-hosted and not open-source.

**Why not adopted.** Vendor dependency and SaaS hosting make it unsuitable for on-premises
biomedical deployments. Not evaluated technically.

**What it told us.** The existence of Cerbos Hub is informative: the Cerbos team built it because
Cerbos without a UI has significant adoption friction. Authorization services need a management
interface for non-technical administrators to manage grants, review access, and respond to
governance inquiries. This is not a nice-to-have. Usher's design includes the management UI
(PAP layer) in scope from the start rather than treating it as a later addition.

---

### Keycloak Authorization Services

**Status: awaiting assessment.** Every other tool in this section carries a completed review; this
one is listed because it is already deployed in the target environment and is the candidate most
likely to make part of this project redundant.

Keycloak Authorization Services provides resources, scopes, permissions and policies; supports
role-based, attribute-based and context-based access control or any combination of them; is
administered from the Keycloak admin console; and issues a token carrying the permissions granted.
That covers the hybrid pattern, a management interface, and structured grants in a token, which are
three of the four reasons recorded for building rather than adopting.

What to test rather than assume, since none of it has been tried:

- Whether it can emit a **residual filter** for a data backend, as distinct from answering
  per-resource permission questions. This is the capability the whole enforcement model rests on.
- Whether authorization can stay **IdP-independent**. Building it into Keycloak forecloses the
  Azure Entra path the architecture deliberately keeps open.
- Whether **delegated non-administrative governance** is expressible: a custodian holding grant
  authority over one data category platform-wide, fully audited, with no other administrative
  rights. This is the OCAP requirement and the least likely to be satisfied off the shelf.

---

### The wider landscape: "what can this subject access" is now a standard capability

Recorded because the reasons for building were written against a narrower field than currently
exists, and any of these could displace part of this design.

| Project | Relevant capability | Model |
| ------- | ------------------- | ----- |
| Cerbos | Query plan as a filter AST, with ORM adapters | Policy as code, attribute-based |
| OpenFGA | `ListObjects` returns what a subject can reach | Relationship-based (Zanzibar) |
| SpiceDB | `LookupResources`, plus a Watch API for cache invalidation | Relationship-based (Zanzibar) |
| Permify | Built-in data filtering and lookup | Relationship-based (Zanzibar) |

Two qualifications. Most of these implement relationship-based access control, which differs from
role-plus-attribute in how policy is expressed rather than only in vocabulary. Oso's open-source
library is deprecated with only its hosted product active, so it sits outside scope here.

**The case for building, stated against this landscape.** Four requirements carry it: delegated
governance, IdP independence, push revocation with fail-secure suspension, and an enforcement path
targeting Elasticsearch through SQON rather than an ORM. Structured grants output is supplied by
several of the engines above, so it belongs among the requirements an evaluation tests rather than
among the reasons to build. Restate this section once an evaluation has been run.

---

## Architectural decisions

### Grants token over binary allow/deny

A binary response from the PDP (allowed/denied) requires every application to call back to the
decision service on every data access, or to cache a broad allow/deny that cannot express partial
access. Neither fits a platform where a user may be permitted to see some records and not others.

Usher returns a structured grants token: the full set of category grants the user holds, scoped
to the resources the requesting application manages. The application plugin applies this as a
query-time filter. A single token fetch covers the session; the plugin uses it for every query
without a round-trip per request.

**Tradeoffs accepted.** The plugin must implement query filter logic, not just a gate check. This
is more work per integration. It is unavoidable: the filtering logic requires application-specific
query language and schema knowledge that Usher cannot have.

---

### JWE (encrypted) over JWS (signed) for the grants token

**Primary rationale: audience separation is enforced cryptographically, and fails closed.**
Grants tokens are audience-scoped per application. Encrypting each token to the target
application's own key means an application physically cannot read a payload issued for a
different one. A controller defect that computes or routes a payload to the wrong audience
becomes a decryption failure at the receiving bridge rather than a silent cross-application
grant leak. With a signed token, the same defect produces a readable payload and the audience
claim is enforced only by whatever code remembers to check it.

This is the same fail-secure posture the rest of the design takes: an internal fault should
deny access, not widen it. See the revocation-channel decision below for the same principle
applied to connectivity loss.

**Secondary rationale: grant sets stay out of incidental disclosure surfaces.** A signed
payload is readable wherever it happens to land: request logs, error reports, crash dumps,
tracing spans. An encrypted payload in any of those places discloses nothing. This does not
depend on the token reaching an untrusted party; it only requires that something logged it.

**The token never transits the user agent.** The bridge is a library embedded in client data
services and obtains the grants token from the controller directly, so the two rationales above are
the whole of the case: neither depends on where the user sits.

**Tradeoffs accepted.** Each bridge instance needs a decryption key provisioned at deploy
time, and audience scoping makes those keys per-application rather than deployment-wide. Key
rotation is an operational concern that would not exist with a signed token. The cost is
smaller than it first appears: both candidate key-wrap algorithms (RSA-OAEP, ECDH-ES) are
asymmetric, so the controller holds each application's public key and never a shared secret.
Onboarding an application is a public-key registration, not a secret distribution. For the
full mechanism, see
[security-workflow.md: Grants token format](security-workflow.md#grants-token-format-jwe).

---

### Resource-level enforcement for MVP; record-level narrowing is post-MVP

A record is visible if the principal holds every category carried by the **resource** the record
belongs to.

**The quantifier is over the data's requirements, not over the holder's grants.** The wording invites
a misreading worth heading off: it does not mean a principal reaches only where all their categories
apply at once. Holding more categories always reaches more data, never less. Worked at record
granularity, for a principal holding both `controlled` and `indigenous`:

| Record carries | Holding both | Holding `controlled` only |
|---|---|---|
| nothing | Visible | Visible |
| `controlled` | Visible | Visible |
| `indigenous` | Visible | Hidden |
| `controlled` and `indigenous` | Visible | Hidden |

So holding both yields the union of the two segments *and* their overlap, which is the intuitive
reading. What holding only one does not yield is the overlap, because data requiring two approvals
is not reachable with one. The conjunction is inside a single record's requirements and never
across a principal's grants.

**At resource granularity the same intent takes a different route.** A resource is atomic, so a
study holding both kinds of data carries both categories and needs both to be reached at all. Where
those are meant to be separately grantable segments, the study becomes two resources and each is
granted on its own. That is the split requirement below, and it is what "segments of a study" means
before record granularity exists.

**Why every category rather than any.** Categories are restrictions, and a restriction that another
restriction can bypass is not one. Under any-category semantics a principal holding `controlled`
would reach a resource also carrying `indigenous`, without the approval that second category exists
to require. This is not specific to community governance: it holds for any two independent
restrictions, and community governance only makes the consequence severe.

Two properties follow. Restrictions compose monotonically, so adding a category to a resource can
only narrow access and never widen it, which lets a deployment introduce a classification without
auditing existing grants. And an unrecognized category fails closed, contributing no clause and
leaving the resource invisible, where any-category semantics would leave it reachable through some
other category the principal happens to hold.

The cost is the split requirement below: a resource of mixed sensitivity has to become several,
because a category states what a resource requires rather than which part of it it describes.

**Unexercised in v1.** Where a deployment defines one category, all-versus-any is not observable.
The first deployment defines one, so nothing depends on this rule until a second arrives.

**Categories are restrictions, not partitions.** Expressing which part of a resource someone may
reach is a different mechanism, either record-level narrowing or a second concept, rather than a
reinterpretation of this one. Enforcement therefore filters on one field, the resource key, and the emitted filter
is a single positive clause:

    { op: 'in', content: { fieldName: <resource key>, value: [...permitted resources] } }

No category field appears in the index, and the plugin needs no per-category field mapping.

`permissions-model.md` was ambiguous between this and a record-level reading in which each
category maps to its own field predicate and records within one resource are individually tagged.
Both readings are present in that document. This resolves it toward resource-level for MVP.

**Why.** Every unverifiable dependency found while designing the filter came from the
record-level reading, which forces the filter to assert things about arbitrary data fields whose
nesting and cardinality Usher can neither see nor require:

| Dependency | Visible to |
| ---------- | ---------- |
| Whether the field is mapped `nested` (the compiler's `nestedFieldNames` argument) | Neither the query nor the SQON |
| How many values the field actually holds | Neither the query nor the mapping |

Resource-level enforcement needs one field, and that field must be single-valued. That is a
precondition each integration has to verify at plugin startup, not something the model guarantees.
See [permissions-model.md](permissions-model.md), which notes that records can satisfy more than
one cohort predicate. It is also why the open OR-versus-AND question is unreachable for MVP rather
than merely moot: a multi-valued key would decide it as OR, silently, in the permissive direction. A positive `in` clause is then an exact match whether the field is flat or nested, so
neither dependency applies. It also aligns the enforcement unit with the sharing unit already
committed to in the study-level sharing decision below, where the grant *is* the dataset definition.

**The resource key is per-catalogue plugin config, and keys are homologues across data types.** One
slot, filled differently for each body of data a deployment serves, which is the
deployment-vocabulary position stated further down applied at the enforcement layer. Usher never
learns any of these field names.

Two properties generalize and are worth stating as expectations rather than as observations of any
one deployment:

- **Catalogues within a single deployment will disagree.** Different bodies of data arrive through
  different submission services and expose different fields for the same role. A plugin that
  assumes one field name per deployment is wrong; the mapping is per catalogue. Confirmed in the
  first deployment rather than anticipated: the clinical catalogue keys on a study identifier, and
  the environmental catalogue has no such field at all, grouping instead on an organization code. A
  single global field name would compile to a clause against a field absent from one of the two
  mappings, which fails permissively.
- **A submission-level identifier can be a legitimate resource key, or a serious mistake, and the
  distinction is not visible in the field.** It is legitimate where the submitting body is the
  governance unit and the value comes from a registered vocabulary. It is wrong where it is used as
  a proxy for a property of the data. The same field name can be either, so the judgement is
  per-integration and belongs in that integration's own record.

**What MVP gives up.** A resource containing records of mixed sensitivity must be split into
separate resources; there is no sub-resource granularity. Under OCAP that is arguably the correct
outcome, since separately governed data gets its own resource and its own custodian rather than
living as a tag inside another study. Row-level and field-level narrowing within a resource were
already out of MVP scope, and record-level narrowing sits post-MVP alongside SQON-scoped grants: they
are the same capability, narrowing within a resource.

**Tradeoffs accepted.** Resolving the ambiguity this way makes four sections of
`permissions-model.md` describe a post-MVP model, and they are marked accordingly.

Deployment-specific resource keys, catalogue topology, and the reasoning behind a given
integration's choice of field belong in that integration's own repository, not here. See
[plugin-integration.md](plugin-integration.md) for what a plugin must establish about a candidate
field before using it.

---

### Additive rendering over subtractive exclusion

> **Scope: moot for MVP, operative afterwards.** Under resource-level enforcement
> (see the decision above) there are no per-record category predicates, so the filter is a single
> positive clause and additive rendering is what it does trivially. This decision governs the
> post-MVP case where record-level narrowing arrives.
>
> Two things were established while resolving it, and both are recorded here so the post-MVP work
> does not repeat them.
>
> **Additive rendering is expressible in one clause, but not via the operator its name suggests.**
> A record is visible iff `categories(record)` is a subset of the held set, which is universally
> quantified over the categories a principal does *not* hold. Enumerating that additively costs
> `2^|held|` branches. The single-clause form is `not` of `not-in`:
>
>     { op: 'not', content: [ { op: 'not-in', content: { fieldName: <field>, value: [...held] } } ] }
>
> Read out: no nested object holds a value outside the granted list, therefore every value is
> within it. Linear in the number of grants. Verified by executing the compiler, not by reading it.
>
> **It requires the field to be mapped `nested`.** On a flat field the same expression
> double-negates to plain `in`, which on a multi-valued field is existential rather than
> universal: silently the wrong quantifier, in the permissive direction. There is no `terms_set`
> in the compiler to fall back on.
>
> Worked, with a principal holding only `controlled` and a record carrying
> `["controlled", "indigenous"]`, which should be invisible to them:
>
> | Step | Flat field | `nested` field |
> |---|---|---|
> | Inner `not-in` | Asks whether the *field* lacks `controlled`. It does not lack it, so no match | Asks, per element, whether *that element* is outside the held set. `indigenous` is, so it matches |
> | Outer `not` | Nothing matched, so the record is admitted | An element matched, so the record is excluded |
> | Result | Visible. Wrong, and permissively so | Invisible. Correct |
>
> The mechanism is per-element evaluation. A flat multi-valued field is one field with several
> values, so a negation applies to the whole field and can only say "none of the record's values is
> `controlled`". `nested` indexes each element separately, which is what makes "there exists an
> element I do not hold" expressible, and negating that yields "every element is one I hold".
>
> The alternative encoding, a stored count of a record's categories compared against how many of
> them fall in the held set, is equally a demand on how the data is shaped. Neither is reachable
> without the deployment modelling for it. Usher cannot require a mapping shape from deployments whose
> data models it does not know, so record-level narrowing is available only where a deployment
> supplies data satisfying that precondition, verified at plugin startup rather than assumed.
>
> **The precondition is unmet on the first deployment, and it is narrower than it first reads.**
> What is missing is a per-record *category* field. Neither iMS catalogue carries one, and nothing
> may be written into the data to create one, so the subset semantics above have no field to operate
> on.
>
> **Narrowing within a resource by predicate is a different thing and is available now.** A filter
> over descriptive fields the records already carry, a study paired with a data type for instance,
> narrows at record granularity using positive clauses on flat keywords. It needs no `nested`
> mapping and no new field, and it works on both catalogues today.
>
> The two need separating by name, because "record-level" has been carrying both. **Narrowing by
> category** is what these preconditions block. **Narrowing by predicate** is not blocked by any of
> them.

The bridge renders a resolved grant set as a union of positive predicates, one branch per grant
held, composed with `or`. The plugin compiles that into its own backend dialect. It does not compute exclusions by subtracting the held categories from
the full category set configured for a resource.

This supersedes the subtractive visibility rule currently described in
[permissions-model.md](permissions-model.md); those sections are marked for rework.

**Primary rationale: the direction the system fails when information is lost.** In a subtractive
model, losing a term widens access. In an additive model, losing a term narrows it.

| Failure | Subtractive | Additive |
| ------- | ----------- | -------- |
| Category exists in Usher, unmapped in the plugin | No exclusion is generated for it, records **leak** | Contributes no branch, **denies** |
| Data arrives carrying a tag value not yet registered as a category | Nothing excludes it, **visible** | Matches no predicate, **hidden** |
| A bug drops a clause from the composed filter | Access **widens** | Access **narrows** |
| A field mapping points at the wrong field | Fails open | Fails open |
| Principal holds zero grants | Denies | Denies |

Rows two and three decide it. The remaining rows are ties or are fixable under either model.

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

**Secondary rationale: it removes an inversion in the middle of the pipeline.** Grant computation
is already additive across the three tiers (see the additive grant pipeline decision below). A
subtractive plugin inverts that result into exclusions for no reason. Making the rendering additive
means the pipeline runs one direction end to end.

**Secondary rationale: audit answers become local.** Under additive rendering, "why can this
person see this record" always resolves to a specific grant. Under subtractive it resolves to "no
exclusion matched," which is an absence, and absences are considerably harder to review or
reproduce.

**Consequence: membership becomes an explicit positive grant.** Subtractive rendering gave access
to untagged records for free, since nothing excluded them. Additive rendering has no implicit
baseline, so membership must render to a predicate of its own (scoping to the resource, for
example `resource_id in [...]`), with category grants adding branches on top. This is treated as
an improvement rather than a cost: it makes the baseline an auditable grant like any other instead
of an unstated default.

**Consequence: the grants token carries held grants only.** Moving the resource's full configured
category set into the token was considered, as a way to make subtractive rendering fail closed on
config drift. Additive rendering does not need it, since an unmapped category contributes nothing
rather than silently skipping an exclusion. The token therefore continues to name only positive
grants, and `permissions-model.md`'s least-information instinct is preserved, though note its
stated rationale (parity with OAuth scopes, UMA RPT permissions, and GA4GH Passport Visas) was
inherited from the superseded assumption that the user holds the token. The conclusion stands on
the absence of any remaining benefit, not on that parity.

**Relationship to GA4GH Passport: none.** Passport is inbound, an institution's
`ControlledAccessGrants` Visa validated by Keycloak and mapped to a `category_grant`. This
decision concerns how a resolved grant set is rendered into a query filter, downstream of that.
Passport support is unaffected either way.

**Tradeoffs accepted.** The subtractive mechanism is described in detail across four sections of
`permissions-model.md` (the visibility rule, its worked example, composition across categories, and
category-to-field mapping), all of which need rework. That cost is accepted because it is
design-phase work, which is the cheapest moment it will ever be. The untagged-record default also
has to be decided explicitly rather than inherited, which is the point.

---

### A self-scoping predicate is not an authorization decision

Some access questions are answered by the record together with the authenticated identity, with no
reference to any grant. Whether a saved query belongs to the person asking, whether a profile is
their own, whether a draft submission is theirs. **Usher is not involved in those, and routing them
through it is a mistake rather than an excess of caution.**

The test is what the predicate is over. A grant-derived predicate asks what the principal holds, and
only the authorization service knows the answer. A self-scoping predicate asks whether the record
names the principal, and the record already carries it.

Both produce different rows for different principals, which is the resemblance that misleads. It
misled an adopter into reading per-principal ownership as row-level narrowing within a resource, and
therefore as blocked until post-MVP, when it was never an authorization question at all.

**Authorization begins where identity stops being sufficient.**

**Two consequences worth stating, because they are not obvious from the rule.**

A self-scoping question must be answered from the authenticated subject and never from a parameter
carrying an identifier. A parameter is a request; identity is a fact. The distinction is the whole
difference between "show me my sets" and "show me anyone's sets".

Sharing does not automatically move a question into the grant model. An access list stored on the
record, naming subjects, is still answered by the record plus identity. What pulls a thing into the
grant model is a governance decision made elsewhere about a body of data, not the fact that more
than one person can see it.

**Where the boundary actually falls.** A collection of records assembled by a user is their artifact
and stays self-scoped. A body of data with a custodian, a category, and an approval process is a
resource. Revocation still reaches the first, because a revoked subject fails at the bridge before
any query runs, so keeping user artifacts out of the grant model costs nothing in enforcement.

**The carve-out: widening who may read an artifact is not itself a self-scoping act.**

Every read of a shared artifact is answered by the record and the subject. The decision to widen it
is not, because it turns on what the artifact was derived from, and that is a governance question
about a body of data.

The case that produced this rule is a saved cohort. Such a record can carry the materialized
identifier list and the query that selected it, and reading the record is not resolving it, so
neither passes through data enforcement. Sharing one therefore discloses which subjects share a
clinical or genomic property, and what property, to someone who cannot retrieve a single one of
those records. In this domain that is the disclosure rather than a step toward it.

**Holding a grant is permission to see data, not permission to republish something derived from
it.** Those are different authorities, and the model already separates them: an owner sets
visibility policy for a resource, a member does not. So the check needs no new concept.

Four properties of the check, because each is easy to get wrong:

- **It gates any widening, not just publication.** Sharing with named subjects discloses the same
  thing to a smaller audience.
- **It is a question about provenance, not a permission to share.** An artifact derived only from
  open data requires no authority to widen, because it discloses nothing the reader could not
  obtain directly. The check asks whether the provenance demands authority the sharer lacks.
- **Multiple contributing resources conjoin.** Authority is required for every resource the
  artifact draws on, not any of them.
- **It needs no new API surface.** The grants token already names the resources held and the role
  held in each, so the check is evaluated where the sharing happens, against provenance recorded on
  the artifact. This is why provenance has to be stored at creation: the contributing resource's
  categories may have changed by the time anyone asks, and derivation-time state cannot be
  reconstructed afterwards.

**Superseded in mechanism, not in principle: gate the reader, not the sharer.**

The check above authorizes the act of widening. A better mechanism authorizes the read: an artifact
is visible only to a principal holding every resource that contributed to it. Provenance is on the
record, the principal's holdings are in their own token, and no lookup about any other subject is
needed, so the self-scoping property survives.

Three things this buys that the share-time check does not:

- **A visibility ceiling falls out rather than needing a rule.** An artifact derived from open
  resources can genuinely be public. One derived from a controlled resource is invisible to anyone
  lacking that grant whatever its stored visibility says. A mistaken share becomes ineffective
  rather than harmful.
- **It cannot be bypassed by a bad decision at share time**, because it is evaluated on every read.
- **It subsumes the share-time check.** If a share cannot disclose, permitting the share is a
  presentation problem rather than a disclosure one.

**The encoding, and why it works on a flat field.** Subset containment normally needs a nested
mapping. Passing the *complement*, the resources the reader lacks, converts a subset test into a
disjointness test, and disjointness is expressible against a flat keyword array. An artifact
survives exactly when it requires none of what the reader lacks.

**The complement is computed locally, and the token does not change.** A first reading of this
concluded the token had to carry the complement, which would have reversed the least-information
position on naming unheld resources. It does not, and the reason is worth keeping.

The complement does not need the full registry. It needs the resources *this deployment is
configured for*, which the plugin already enumerates: config maps each resource to a catalogue, a
field name, and a field value, because that mapping is how a record is attributed to a resource at
all. So the left half comes from config at startup and the right half from the token, and neither
requires Usher to name anything the principal lacks.

    complement = (resources this plugin is configured for) minus (resources the principal holds)

**Why a local complement is sufficient rather than merely convenient.** Over-inclusion is harmless:
naming a resource that cannot appear in any artifact's provenance excludes nothing. Under-inclusion
is not: a lacked resource missing from the complement lets an artifact requiring it pass. So the
question is only whether the local set can under-include, and it cannot, because an artifact created
here can only draw on resources served here.

**That closure has a precondition, and it is the one to guard.** It holds only while every resource
value present in the data is configured. A record carrying an unconfigured resource value can enter
an artifact's provenance, and that value will be absent from the complement, so the artifact passes
the ceiling. This is the unknown-resource case, and it is why an unmapped value must deny rather
than be ignored: here it is not merely a missing restriction on one record, it silently lifts the
ceiling on every artifact derived from it.

**An artifact with no recoverable provenance can never be widened.** Not as a policy choice: the
check has nothing to evaluate, and derivation-time state cannot be reconstructed after the fact. So
artifacts predating provenance recording stay private permanently, and no migration recovers them.
A migration can restore ownership, which makes an artifact readable by its owner, because that is
self-scoping and needs no provenance. It cannot make one shareable.

Anywhere the widening operation is unavailable, it must be **absent rather than permitted**. A
deployment with no authentication has no identity to narrow by, so every artifact is already visible
to everyone and there is nothing to widen. The correct implementation is that the operation does not
exist in that mode, not a check that returns true. A check that passes because its inputs are
missing looks like enforcement and is not, which is the same failure as a control named for a gate
it does not implement.

**The residual risk, which is accepted rather than solved.** Checking at share time keeps every
read self-scoping, and means a share can outlive the governance that permitted it. That is the
category-change propagation problem already open in the roadmap rather than a new one: when a
resource's categories tighten, existing shares of artifacts derived from it need re-evaluation, and
that belongs on an administrative surface rather than in a read-path filter.

---

### Catalogue-level denial is an empty `in`, and never a negation

Request-level denials (no valid token, revoked, bridge unreachable) are decided in middleware before
the resolver runs, the way the 503 case already is. Catalogue-level denials cannot be, because the
adopter's hook is supplied per catalogue and one request can span catalogues whose answers differ.
Denying the whole request because one catalogue is denied would take the permitted ones with it.

So a catalogue-level denial has to be a filter.

**Decision: express it with the query module's `matchNothing(fieldName)` constructor, and never by
hand-constructing a negation of an empty group.**

**A filter must carry at least one leaf clause.** An empty combination is not a restriction, and a
negation is not a way to make one. Only a leaf carries the restriction reliably, because the
transformations a filter passes through operate on combinations, and a leaf has nothing for them to
collapse.

**Deny is a value, not an absence, and it needs a name.** Written by hand it looks like an
omission, which invites a well-meaning rewrite into a form that does not restrict anything. The
constructor exists so the intent is visible in the call and survives that edit. It is verified for
node shape, schema acceptance, round-trip survival, and composition inside a builder chain, and it
lives in the module that owns the semantics rather than in a plugin.

**The field name is required and that is structural, not an inconvenience.** Every leaf operator
takes one, so any field-free form is a combination, and a combination cannot carry the restriction
per the rule above. For Usher the resource-key field is always in plugin config, so the constructor
always has one available.

**Verified end to end on 2026-08-24, and what that verification does not cover.** A principal
holding no grants returns nothing on every read path, with the enforcement clause asserted present
in the emitted query rather than inferred from the empty result, and with a positive control on the
same records in the same run.

The coverage boundary matters and is not uniform across deployments:

| Condition | Covered |
| --------- | ------- |
| Elasticsearch 7.17.28, flat fields | Yes |
| OpenSearch | No |
| Nested access fields | No |

The first integration runs Elasticsearch with a flat resource key, so it sits inside what was
verified. Another deployment runs OpenSearch, and its clinical index carries the access-relevant
field nested at several depths, so both untested conditions land together there. Treat that
deployment as unverified until the conformance corpus covers both, rather than reading this result
as engine-independent.

**Two constraints that follow.**

The value is produced by a named constructor, never written inline. The intent has to be visible in
the type, because a literal empty array reads as a mistake and the natural cleanup of it is B.

Its pinning test must assert the **emitted Elasticsearch**, and must assert the value survives a
builder round-trip unchanged. A test on the SQON node shape alone would not have caught the failure
that ruled out B.

---

### Zero entitlement is a distinct state, never an empty filter

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

**Decision.** Zero entitlement is represented as a distinct state that never becomes a SQON
value. The bridge returns a discriminated result to the plugin rather than a filter:

    type Enforcement =
      | { kind: 'deny';   reason: 'no-grants' | 'unknown-resource' }
      | { kind: 'narrow'; sqon: SqonNode }
      | { kind: 'allow' }

**How each arm reaches the adopter.** All three now have a concrete expression, and
none of them is a hand-written literal:

| Arm | What the plugin returns |
| --- | --- |
| `deny` | `matchNothing(fieldName)` from the query module |
| `narrow` | The rendered filter |
| `allow` | The adopter's exported allow-all sentinel, taken from its package root |

**The callback is total, and returning nothing is now an error rather than a permission.** The
adopter has made `null` or `undefined` throw instead of granting everything. So a plugin that falls
through a branch fails loudly. This removes the last path by which an omission read as consent, and
it is why `allow` has to be a value the plugin asks for by name rather than something it expresses
by declining to answer.

The `allow` arm exists because a catalogue can be open by configuration, and such a catalogue
needs an unrestricted query. Without a named arm the only way to serve it would be emitting the
empty match-all combination this decision exists to prohibit. Naming it means the audit trail can
distinguish "unrestricted because this catalogue is configured open" from "unrestricted because
the filter evaporated," which are identical in an emitted query and opposite in intent. It is
consistent with the additive grant pipeline decision below, which already issues a grants token
for anonymous requests specifically so open access stays audited.

The alternative considered was enumerating every open resource into a positive `in` clause, which
keeps a single code path but puts a catalogue's entire resource list into every token and grows
without bound.

A `revoked` reason was considered and dropped as unreachable: the bridge drops a user's cached
token on a revocation event, so the next request re-fetches and receives a payload with no grants
for that resource, which surfaces as `no-grants`.

This adds no new rule. [plugin-integration.md](plugin-integration.md) already requires denial
to be rejected before filter construction, on the grounds that "an empty exclusion set does not
mean 'deny all'; it means 'exclude nothing from scope.'" What was missing was any mechanism
making that unskippable: given a bare `SqonNode`, the natural plugin code has no branch to
forget, because it has no branch. The discriminated return makes the deny arm a compile-time
obligation.

`kind: 'deny'` asserts only "do not query the data layer." It carries no status code, since the
existence-denial invariant means a search endpoint should likely return an empty result set
rather than a 403 that confirms the resource exists; that realization stays the plugin's
decision. The `reason` field exists for the audit trail rather than control flow: access never
held, access withdrawn, and misconfiguration are three different events, and collapsed into a
bare denial the revocation case becomes uncountable.

The unavailable case is deliberately absent. The bridge must return 503 upstream before the
translation callback is invoked, so this type describes only the branch where a payload
resolved.

**Tradeoffs accepted.** Plugin authors must handle two arms rather than composing one value.
That friction is the point.

**The invariant this rests on, stated so it is not rediscovered.** Denial is represented in the
result's kind and never inside the SQON. The moment a deny is expressed as a SQON value, it
inherits every empty-combination hazard above. What made deny safe was deciding it outside SQON.
Putting it back inside returns it to a language with no way to say it. The `in`-with-empty-values
encoding
is a fail-closed way to say "match nothing" where a filter is unavoidable; it is not a licence to
represent the deny arm as a filter.

**The underlying reason is that SQON is a general query language pressed into service as an
authorization artifact.** A language built for narrowing has no natural "match nothing" element,
because narrowing from nothing is not a query anyone writes. That absence is the root of the
hazard, and it is why deny has to be decided outside SQON rather than expressed within it.

**Independently corroborated by an unrelated implementation.** Cerbos's `PlanResources`, built for
the same job of turning a policy into a residual filter, returns exactly this three-way
discrimination: `KIND_ALWAYS_ALLOWED`, `KIND_ALWAYS_DENIED`, and `KIND_CONDITIONAL` carrying an
AST. Its documented rationale is the one recorded here, a discriminated union at the type level so
that callers must handle each case distinctly. Two designs reaching the same three-way split from
different starting points is the strongest available evidence that the problem forces it rather
than that anyone preferred it.

---

### Plugin enforcement over gateway/proxy enforcement

A gateway (API proxy, sidecar) can allow or block requests. It cannot reshape queries. Usher's
enforcement model requires query shaping: the plugin must inject grant-based predicates into every
data query before it reaches the data layer. A gateway operating at the HTTP level cannot do this
for GraphQL, SQON, or other structured query formats without deep protocol awareness.

Plugin enforcement runs inside the application and has access to the query structure before it is
serialized and sent. The plugin shapes the query; the data layer receives a pre-filtered request.

**Tradeoffs accepted.** Every application that serves protected data must implement a plugin.
Enforcement is distributed rather than centralized. An application that skips the plugin has no
enforcement: there is no backstop at the network layer.

---

### Token lifetime never bounds how long an operation may take

**The precedent is in the system being replaced.** EGO's access tokens last three hours. The reason
is that submitters run large uploads, which outlive a short token and fail partway. Lengthening the
token stopped the failures. It also handed every principal and every operation a three-hour
revocation window, not just uploads.

**The error was scope, not duration.** What got lengthened authorized everything a principal may do,
platform-wide, for reads as well as writes. It was lengthened so that one long write would survive.
Scope and duration trade against each other: a credential may be broad, or long-lived, but broad and
long-lived is the worst of the four. Nobody extended the narrow, long-lived permission that upload
actually needed.

**This design does not permit lengthening a credential to fit an operation.** The grants-token lifetime bounds credential exposure. It
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

**Upload is a third enforcement surface, and duration is what distinguishes it.** Searching is
instantaneous. Downloading is short. Only submission runs long enough for a credential to expire
underneath it. See the long-running operation item in [../roadmap.md](../roadmap.md).

---

### Push revocation over pure TTL

A short token TTL limits the staleness window but requires frequent token refreshes and adds
round-trip latency. A long TTL reduces round-trips but widens the window where a revoked grant is
still honoured.

Usher uses a push revocation channel (SSE or WebSocket with poll fallback): plugins subscribe and
receive notification when grants change. Cached tokens are invalidated on notification rather than
on expiry. The TTL is a backstop, not the primary revocation mechanism.

**Tradeoffs accepted.** Plugins must maintain a persistent connection to the revocation channel.
If the channel is disrupted, the plugin cannot know whether its cached grants are still valid.
For the mechanism (push + poll, multi-instance propagation), see
[security-workflow.md § Emergency access revocation](security-workflow.md#emergency-access-revocation).

---

### Fail-secure when the revocation channel is unavailable

If a revoked grant notification is never delivered, the plugin would continue honouring access that
has been withdrawn. An adversary who can silence the revocation channel would preserve stale access
indefinitely with pure TTL fallback.

When the revocation channel is unavailable beyond the configured grace period, the plugin returns
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
grants tokens. What those categories mean in terms of actual records or fields is
application-specific configuration that lives in the plugin.

This allows Usher to be adopted without modifying the data being protected, and removed without
leaving data artefacts. It also keeps Usher generic across data formats (relational, document,
search index) without needing format-specific logic.

**What this forecloses, and the rule it yields.** Enforcement filters on fields the data already
carries, and Usher never causes a field to be written. That splits candidate filter fields in two:

- **Descriptive fields** state what a record is: its study, its data type, its file type. The
  submission pipeline sets them for reasons unrelated to permissions, and they do not change when
  permissions change.
- **Prescriptive fields** state who may see a record, an access level baked into the document. They
  encode an authorization decision inside the data.

**Enforcement reads descriptive fields only.** A prescriptive field holds the decision in two places
at once with no invariant binding them, and makes the search index an authorization store that
nobody owns. Filtering on a descriptive field keeps every permission in Usher and every fact about
the data in the index.

Two consequences. There is no staleness window, because a grant change alters no indexed field, so
the index cannot disagree with a decision it does not hold. And a distinction the data does not
already make cannot be enforced, which turns "does the data already distinguish this?" into a
question to settle before any new category is promised rather than after.

**Tradeoffs accepted.** Usher cannot validate that a category or resource name corresponds to
anything real in the data layer. Misconfigured grants (referencing a nonexistent category) are
silent. Validation is the responsibility of the management UI and the plugin configuration.

---

### Sharing at study level needs no snapshot machinery

The unit of sharing is a study, meaning all records in it including future ones, so the "dataset
definition" a share captures is simply the study identifier. A `category_grant` scoped to that
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

When a category grant is created for a registered user, the default behaviour is that the grant
enters an *awaiting-acceptance* state: the grantee must explicitly confirm they accept
data-sharing responsibility before the grant becomes active and appears in their grants token.
This is distinct from older designs where grant creation immediately activated access.

The reasoning: researchers may not want to hold responsibility over data they did not request, and
accepting access to health data carries legal and ethical obligations in many jurisdictions. Silent
activation removes the grantee's ability to make an informed decision.

A configurable `auto-accept` flag (name TBD) bypasses the acceptance step for deployments where
it is not operationally appropriate (machine-to-machine sharing, internal pipelines, or any case
where all parties are institutional accounts rather than individual researchers). The flag is off
by default across all deployments.

Grants sent to an unregistered email address enter the *pending* state (not awaiting-acceptance)
and remain pending until the user registers. On registration, pending grants are migrated to
awaiting-acceptance under the user's Keycloak user ID, then follow the standard acceptance flow.

**Tradeoffs accepted.** The acceptance step adds friction to the sharing workflow. This is
intentional: the friction is the point. Deployments that cannot tolerate it have the auto-accept
option; deployments handling PHI should leave auto-accept off.

---

### EGO is replaced, not integrated

Usher is the full replacement for EGO (Overture's previous authorization service). The
integration strategy considered (running Usher alongside EGO and having both manage grants)
is not adopted. EGO uses a different data model (groups and policies) that does not align cleanly with
Usher's resource/membership/category-grant model; maintaining both simultaneously doubles the
failure surface and creates policy synchronization risk with no long-term benefit.

The replacement strategy: enumerate EGO's `STUDY-*` groups, map each to a Usher resource, and
map EGO group memberships to Usher memberships. The studies management service (which orchestrated
EGO) is retired; its operations become Usher admin API calls. Backend services in iMS that
currently call EGO's authorization endpoints are updated to use Usher's bridge and token exchange.

**Tradeoffs accepted.** A full replacement requires a migration event and a coordinated cutover
for iMS backend services. This is harder than an incremental integration but avoids indefinite
operational complexity from running two authorization systems.

---

### User IDs (Keycloak subject) as primary identifier; email for pending grants only

Usher uses the Keycloak user ID (the `sub` claim from the OIDC token) as the primary identifier
for memberships, category grants, audit records, and all API interactions involving registered
users. Email addresses are not used as identifiers in any active grant or membership record.

The reasoning: user IDs are opaque identifiers with no intrinsic meaning. An email address
leaked in a token or log exposure reveals PII; a Keycloak UUID reveals nothing without access to
the IdP. Email addresses can also change; subject IDs are stable for the lifetime of the account.

Email is used in exactly one place: the `pending_grants` entity, where a grant has been sent to
an address that belongs to a user who has not yet registered. Once the user registers, the pending
grant is migrated to their Keycloak user ID and the email reference is discarded.

Any portal or consumer-facing feature that needs to display a user's name or email (for example,
a "shared with me" listing) resolves that information via the Keycloak admin API at the portal
layer, not by storing email in Usher's policy tables.

**Tradeoffs accepted.** The portal layer bears responsibility for email-to-ID resolution and
display. This is a deliberate separation: Usher is an authorization service, not a directory.

---

### An anonymous role defines the baseline, and it may be empty

A deployment defines an **anonymous role** whose grants are the floor for every principal, applied
whether or not a caller is authenticated. Open access is what that role ordinarily grants, and an
authenticated caller's grants are this baseline together with their own rather than an alternative
to it.

**Its value is that it may grant nothing.** Where the anonymous role is empty, unauthenticated
callers receive an empty grant set and even open data requires registration. So whether "open" means
publicly readable or registration-gated becomes a deployment decision rather than a property of this
design, which previously assumed the first by computing open grants unconditionally.

This also removes the synthetic `public` role. It existed to label open-tier grants in anonymous
tokens, and described itself in prose as a minimum read capability because there was no field to put
one in. Under the anonymous role there is nothing synthetic left: an anonymous token carries ordinary
grants that happen to have come from the baseline, and zero entitlement stays the distinct state it
already was.

---

### Category grants are a list of independent grants, and resource names are never manufactured

A resource's entry in the token is a list of grants, each naming one category and the capabilities
held on it. Each entry corresponds to one row in the grant store and one act of granting, and
holding several means holding several grants.

    "STUDY_A": [ { "open":       ["view", "download"] },
                 { "controlled": ["view"] } ]

**Every capability is category-scoped, and open content is a category.** There is no separate
resource-level capability list and no baseline outside the category system, because a baseline is
what the superseded subtractive model required. A detached capability list would have reintroduced
it, and was rejected for that reason rather than for shape. It also could not express a real tier
difference: an anonymous caller holding `view` on the open category where a registered one holds
`view` and `download`, same resource, same category.

**No role name and no ownership travel in the token.** A role is how access is authored; the
controller resolves it to capabilities at issuance, so no plugin learns what a deployment means by
`member`. Ownership is a management capability enforced by Usher's own API, so an enforcement
payload has no use for it.

**There is no empty-list case, and categories are therefore not optional.** Any access to a resource
means holding at least one grant on it, so an empty list would mean what absence already means. The
accepted cost is that a resource carrying no categories is ungrantable, since a grant would have
nothing to name.

**Rejected: encoding a category into the resource key.** Manufacturing `STUDY_A_CONTROLLED` and
`STUDY_A_INDIGENOUS` as separate resource keys was floated as the route to separately grantable
segments. It is wrong twice over. It is the duplication that role-and-attribute hybrids exist to
avoid, reappearing on the resource axis instead of the role axis, and growing combinatorially with
the number of categories. And it does not work: no field in the data holds the value
`STUDY_A_CONTROLLED`, so a positive containment on the resource key cannot select it. Splitting the
resource key is only enforceable along an axis the data already expresses, which categories are not.

**What the split requirement actually means.** Where data is separately governed, it becomes its own
resource with its own identifier in the deployment's data, decided at registration. Two studies, not
one study with a manufactured suffix. That is enforceable, and it is the outcome community
governance would want anyway, since separately governed data gets its own custodian rather than
living as a label inside someone else's study.

**What the list shape does not change.** Under resource-level enforcement a category is never a
clause in the filter. Categories are metadata Usher holds about a resource, used to decide whether
that resource appears in the permitted list at all; the emitted filter is the resource key and
nothing else. So the list shape is the right shape to carry now and the one record-level narrowing
will need, but it does not by itself make segments within a resource reachable. That waits on a
per-record category field, which is the precondition recorded above.

---

### The bridge emits SQON; plugins translate it into their own enforcement

The bridge builds the predicate, so the predicate needs a form every adopter can receive. That form
is SQON, the shared Overture query language, and the consequence is accepted rather than avoided:
**an adopter whose enforcement is not SQON-shaped has to translate.**

How that cost falls:

| Adopter | Translation |
|---|---|
| The search adopter | None. It consumes SQON natively |
| A metadata service filtering a listing | Real but small for the MVP predicate, a positive containment on one field, which any store expresses |
| A file-transfer service authorizing one object | None, because it receives no predicate. It asks a membership question instead |
| A schema service | None. It filters no records |

So the burden concentrates on adopters that both narrow and do not already speak SQON, and for the
MVP predicate that burden is a `WHERE ... IN (...)`. It grows only for predicates that are not
backend-neutral, and the one such predicate identified so far is specific to the search adopter
anyway.

**Why accept it.** The alternative distributes predicate *construction* instead of predicate
*translation*, and construction is where every fail-open defect in this design has been found while
translation has produced none. Translating a predicate is mechanical; constructing one is not.
Pushing the mechanical work outward to keep construction central is the deliberate trade.

---

### Admin self-grant is approved by the custodians of the data being granted

Not by the resource's owner. The approving authority is the custodian of each category the data
carries, which is what the trigger for needing approval implies: the requirement appears with
community custodianship because it *is* community custodianship.

**This removes the exception rather than scheduling one.** The rule is uniform from the start: a
self-grant requires the approval of the custodians of the categories on the data reached. MVP needs
no approval because no custodians exist yet, not because MVP holds a bypass to be taken out later.
Nothing has to be removed when custodianship arrives; a set stops being empty.

**An empty approver set is a satisfied one**, and that is accepted rather than prevented: a category
may exist with nobody assigned to approve for it, with a warning to the dataset's owners as the
compensating control. See the grant-gating decision below for what that costs and what it requires.

---

### Granting is one function, and the data's restrictions are the last gate

An administrator may grant permissions, to themselves or to anyone else. Permissions here means more
than reading data: assigning a role, making someone an owner, conferring a capability. What an
administrator cannot do is bypass what the data itself requires.

**A grant passes two stages, and who started it changes only the first.** Authority to issue comes
first, and an administrator holds it broadly. What the data requires comes second. Where a category
requires a custodian's approval, that approval is the final gate. It applies identically whether an
administrator, an owner or a custodian started the request. There is no administrative path that skips the
gate, only a broader entitlement to enter it, **with one exception that predates this decision and
is not yet reconciled**: the plugin-level admin bypass in `admin-model.md` applies no filter at all
and creates no grant. It is off by default for health-data deployments. Whether it may remain
enabled where a category carries a custodian is recorded as an open item in
[to-discuss.md](to-discuss.md).

**A category may have no custodian assigned, and then there is no gate.** An earlier form of this
decision made a non-empty custodian set an invariant. That was stricter than intended. The control
chosen is a warning rather than a refusal. Where a dataset carries a category with nobody assigned
to approve for it, the system must have warned that dataset's owners. An unguarded category is
therefore a known state rather than a discovered one.

**This is the one place the design accepts a permissive failure.** Everywhere else uncertainty
withholds. Here an unassigned custodian lets an administrator reach community-governed data. The
warning is the compensating control, and the owners carry the responsibility to act on it.

Two things follow for the implementation. The warning must be delivered and recorded rather than
displayed, because a control that depends on someone reading it needs evidence it was sent. And the
access it permits needs its own audit event: reached without approval because none was configured is
a different fact from approved.

**Open: whether appointing a custodian needs a second party.** An administrator who may appoint
custodians can appoint themselves, then approve their own grant. The control's strength therefore
rests on appointment being harder than approval. Appointment must at minimum produce its own audit
event.

**On the portal flows.** Flow 5.6 says an administrator has no sharing controls. That is compatible
with this if it describes the portal's interface rather than the capability. The portal's sharing
journey belongs to the data-plane roles; the administrative capability lives at Usher's API. Worth
confirming with the author.

### One account, several addresses, and only verified ones bind

A principal's account has a single identity in the identity provider and may be reachable at more
than one address: a personal one serving as the username, and one per organization the principal
belongs to, which may repeat where the same work address serves several. The motivation is that a
contact address is what other people use to reach someone, and it should not be the address that
identifies their account, particularly for an administrator.

Two consequences for grants:

- **A pending grant matches on any of the account's addresses, not only the username.** This is the
  same conclusion the placeholder decision below reaches, arrived at from the account side rather
  than the invitation side.
- **An address may bind a grant only once verified.** Otherwise claiming an address is enough to
  collect grants intended for whoever really holds it, which turns address entry into a grant-theft
  path. Verification is what makes a secondary address usable, not mere assertion.

**Where the grant is displayed, the contact address is the one to show.** Requirements ask that a
recipient see who shared data with them. Showing the sharer's name and organizational address
satisfies that without exposing the personal address their account is identified by.

**To verify before designing against it: whether the identity provider models more than one address
per user natively, or whether secondary addresses are custom attributes.** If the latter, the
verification flow for a secondary address is something this design has to specify rather than
inherit, and the security property above depends on it existing.

---

### The invited email is a placeholder, not an identifier

A pending grant is held against an email address only until it can be attached to a Keycloak
subject. The magic link in the invitation is what performs that attachment, and it binds the grant
to **whichever account the recipient confirms with**, whether that account is created in response to
the invitation or already existed under a different address. Confirmation happens after account
creation for a new account, or after logging in for an existing one.

This contradicts the portal flows, which hold a grant pending when the recipient registers under a
different address than the one invited. The flows treat the invited address as the identity; this
design treats it as a placeholder that is discarded once a real subject exists, which is the
existing decision that Keycloak subjects are the primary identifier.

**The link is a bearer credential for the grant.** Whoever holds it and confirms receives the grant,
since the whole point is that the confirming account need not match the invited address. Expiry and
single use are therefore load-bearing rather than hygiene, and forwarding is the threat to state
explicitly in the threat model.

---

### The resource-key field is whichever existing field a deployment designates

Confirmed for the first deployment and generalized: a catalogue's resource key is chosen from fields
the data already carries, and which field plays that role is the deployment's designation rather
than a property Usher recognizes. The environmental catalogue's shape is taken as given for MVP
purposes; if it changes, MVP is unaffected, because what matters is only that *some* existing field
carries the deployment's grouping and that the plugin is configured with its name.

---

### The admin role is a policy-plane authority, not a data-plane one

"Admin" is short for **system administrator**. The authorities that administer access *to data* are
the Owner and the Custodian, and calling those data administrators is the clearer reading of the
role set: one administers the system, the others administer access.

A system administrator sees the policy plane in full and the data plane not at all:

| Sees | Does not see |
|---|---|
| Users and the grants they hold | The records inside a resource |
| Resource metadata: what a study is, who owns it | Anything a normal user would need a grant for |
| Audit logs | |

Open data is the one exception, and it is not really an exception: a system administrator reads it
because everyone does, not because of the role.

**Why this is stronger than the alternative.** A platform-level view that is not grant-based
produces no grant record, and the audit trail around administrative data access assumes one exists.
Keeping the administrator on the policy plane means there is nothing to audit rather than an
unaudited capability, which is a better position than logging a power that need not exist.

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

**Open: whose approval.** It was recorded as permission from owners, while the trigger for needing
it is community custodianship, which points at the custodian. The grant-authority framing above
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

### Ownership assignment is deployment policy, not Usher behaviour

A submitter becoming the owner of what they submit is a **rule the deployment chooses**, not
something Usher does on its own. It is true of the first deployment and should not be hardcoded from
that.

Usher provides the mechanism: a resource is created with owners assigned. Which principal that is,
and whether submitting is what qualifies someone, belongs to the submission flow that calls Usher.
This keeps the ownership cascade configurable rather than built in, and it is the same reasoning as
data-agnosticism applied to the policy layer: Usher should not encode one deployment's
organizational rule as a property of the model.

**What this changes.** The cascade described in `permissions-model.md` reads as Usher behaviour and
should read as a deployment-supplied policy with a default. Nothing about the mechanism changes;
what changes is who decides.

---

### Usher is the resource lifecycle management layer

Usher's scope extends beyond authorization decisions to owning the full lifecycle of the resources
it protects: creation, metadata management, membership assignment, category association, visibility
policy (embargo, orphan state), and retirement.

Previously, a separate "studies management service" handled this orchestration on top of EGO.
Absorbing those responsibilities into Usher eliminates the orchestration layer and makes Usher the
single source of truth for resource metadata. Downstream services (Arranger, Lyric) reference
Usher resource IDs; they do not maintain their own resource registries.

This scope is intentionally generic: Usher manages "resources," not "studies." What a resource
represents (a study, a dataset, a project, a programme) is a deployment concern expressed through
the management UI's labelling and the plugin's field mapping config. The core model is the same
regardless.

**Tradeoffs accepted.** Usher must provide a resource management API surface in addition to its
authorization API. This expands the implementation scope but removes an entire service from the
deployment topology.

---

### SONG is file metadata only; Usher owns resource metadata

SONG's role in Usher-adopting deployments is narrowed to file-level manifest data: file
checksums, donor/sample links, and file object identifiers. SONG is not a source of truth for
resource metadata (cohort names, category assignments, ownership, or membership).

Previously, the studies management service used SONG as the authoritative record of which studies
existed. This created a dependency on SONG for authorization decisions, and excluded deployments
that do not run SONG. Usher owns resource metadata instead: when a resource is created (either by
an admin or by the Lyric service account at submission time), Usher is the record of that
resource's existence, name, and category assignments.

Deployments that include SONG use it for its original purpose (file manifests and genomic
metadata) and Usher for access control. Deployments without SONG are fully supported; Usher has
no SONG dependency.

---

### "Study" and other domain terms are deployment vocabulary

Usher's model uses generic terms: resource, membership, category grant. Domain-specific vocabulary
(study, cohort, dataset, project, program) appears only in deployment configuration and management
UI labelling.

A deployment's own term for a resource ("study", "programme", or whatever its users say) appears in
its portal UI and in its plugin configuration, where a field name identifies which records belong to
a resource. Neither the term nor the field name appears in Usher's entity schema or API responses.
A single deployment may use different terms and different fields for different bodies of data; the
mapping is per catalogue, and it belongs in that integration's own record rather than here. Stating
one deployment's field name in this document previously caused it to be read as a platform default.

This is a deliberate inversion of the EGO/studies-management-service model, where "study" was a
first-class concept embedded in group names (`STUDY-<id>`) and service logic. Making the model
generic means Usher can serve deployments with different domain vocabulary without code changes.

---

### Additive grant pipeline with anonymous grants token for open data

A common alternative for open data is to handle unauthenticated requests outside the
authorization system: the plugin applies an exclusion filter for all sensitive categories, no
token exchange occurs, and open access is unlogged. This creates two code paths (authenticated
vs. anonymous) and leaves open access invisible to the audit trail.

Usher issues a grants token for every request, including unauthenticated ones. For anonymous
users the controller computes only the open-data tier (no IdP token validation, no membership
lookup): the result is a grants token containing only open-resource grants. The bridge and
plugin handle this token identically to an authenticated one.

Grant computation is additive across three tiers, always in order:

1. **Open**: computed for all users, including anonymous; no IdP token required
2. **Registered**: computed for authenticated users with a membership in the resource
3. **Controlled**: computed for authenticated users with an explicit category grant record

Standards consulted: GA4GH Data Access Framework (open/registered/controlled tier model),
NIST SP 800-162 (ABAC), NIST SP 800-207 (Zero Trust).

**Tradeoffs accepted.** Every unauthenticated request triggers a token exchange call to the
controller. For high-traffic open-access deployments this is additional load compared to a
static exclusion filter. The cost is mitigated by the `generatedAt` fast-path cache and by
Valkey-backed shared cache across controller instances; it is accepted in exchange for audit
completeness and a single code path across all access tiers.
