# Design Decisions

Key architectural choices and the reasoning behind them, including tools reviewed and not adopted.
Where a reviewed tool influenced the design, that contribution is noted.

---

## Tools reviewed before building

### Cerbos

Cerbos is a standalone PDP (Policy Decision Point) service: applications send a request containing
user context and a resource, and Cerbos responds with an allow/deny decision based on policies
defined in YAML files.

**What we borrowed.** The standalone PDP service pattern (rather than an embedded library) is the
right architecture for a shared authorization service across multiple applications. Cerbos confirmed
this and its REST API design is a reference for Usher's decision API: a clear request schema
(principal, resource, action) and a structured, auditable response.

**Why not adopted.** Two gaps: decisions are binary (allow/deny), and there is no management UI.
Usher's use case requires a structured constraint output rather than a pass/fail answer: the
application needs to know not just "can this user see data?" but "which categories of data can they
see, in which resources?" That structured answer cannot come from Cerbos without significant
wrapping. The absence of a management UI is a separate gap (addressed by Cerbos Hub, see below).

---

### OPA as the decision engine

OPA (Open Policy Agent) is a CNCF-graduated general-purpose policy engine. Policies are written in
Rego and evaluated against input data. OPA is widely adopted for Kubernetes admission control and
API gateway authorization.

**Why we looked at it.** OPA is mature, well-maintained, and well-recognized. Teams familiar with
OPA from Kubernetes work know how to operate it, write policies, and integrate it into CI/CD. Using
OPA as Usher's evaluation engine would have offered ecosystem familiarity as an adoption benefit.

**What we borrowed.** OPA's concept of partial evaluation directly influenced the constraint token
design. In partial evaluation, OPA accepts some known facts and some unknown ones, and produces a
residual: an unevaluated expression that represents the remaining constraints. Usher's constraint
token is the same idea in a different form: rather than returning a binary answer, Usher returns the
full set of category grants for the requesting application. The plugin applies that set as a query
filter, which is structurally a residual evaluation applied at the data layer.

OPA also reinforced the value of externalizing authorization state as explicit, queryable data
rather than encoding it implicitly in application logic. That principle is central to Usher's grant
model.

**Why not adopted.** Usher's decision logic is a grant data lookup, not policy evaluation.
The question "what can this user see?" is answered by querying which grant records exist for that
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

---

### OPA at the enforcement layer

Separate from its role as a decision engine, OPA was considered as a component within enforcement
plugins: the per-application code that receives the constraint token and translates it into
data-layer query filters.

**Why we looked at it.** The mapping from a category grant set to a concrete query filter (e.g.,
"category `registered` in resource `cohort-A`" maps to a specific Elasticsearch DSL fragment or SQL
predicate) is deployment-variable and schema-specific. This is precisely the kind of externalizable,
auditable policy logic OPA is designed for. Organizations already running OPA sidecars could
potentially integrate Usher's enforcement by adding a policy bundle rather than embedding a new
library.

**What we borrowed.** The sidecar deployment model: the plugin does not need to be embedded in
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

## Architectural decisions

### Constraint token over binary allow/deny

A binary response from the PDP (allowed/denied) requires every application to call back to the
decision service on every data access, or to cache a broad allow/deny that cannot express partial
access. Neither fits a platform where a user may be permitted to see some records and not others.

Usher returns a structured constraint token: the full set of category grants the user holds, scoped
to the resources the requesting application manages. The application plugin applies this as a
query-time filter. A single token fetch covers the session; the plugin uses it for every query
without a round-trip per request.

**Tradeoffs accepted.** The plugin must implement query filter logic, not just a gate check. This
is more work per integration. It is unavoidable: the filtering logic requires application-specific
query language and schema knowledge that Usher cannot have.

---

### JWE (encrypted) over JWS (signed) for the constraint token

A signed token (JWS) is readable by anyone with the public key, including the user. A user who can
read their own constraint token can enumerate which categories they do not hold grants for and
potentially craft queries to probe or bypass enforcement.

The constraint token is encrypted (JWE) and decrypted only by the application plugin. The user
receives and forwards an opaque token they cannot inspect.

**Tradeoffs accepted.** Each plugin needs a decryption key provisioned at deploy time. Key
distribution and rotation are operational concerns that would not exist with a signed token.

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

### Push revocation over pure TTL

A short token TTL limits the staleness window but requires frequent token refreshes and adds
round-trip latency. A long TTL reduces round-trips but widens the window where a revoked grant is
still honoured.

Usher uses a push revocation channel (SSE or WebSocket with poll fallback): plugins subscribe and
receive notification when grants change. Cached tokens are invalidated on notification rather than
on expiry. The TTL is a backstop, not the primary revocation mechanism.

**Tradeoffs accepted.** Plugins must maintain a persistent connection to the revocation channel.
If the channel is disrupted, the plugin cannot know whether its cached grants are still valid.

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
design choice rather than an oversight.

---

### Usher is data-agnostic

Usher does not know the schema of the data it protects. It does not query the data store, run
migrations, or write to any data table. It holds grants (user, resource, category) and issues
constraint tokens. What those categories mean in terms of actual records or fields is
application-specific configuration that lives in the plugin.

This allows Usher to be adopted without modifying the data being protected, and removed without
leaving data artefacts. It also keeps Usher generic across data formats (relational, document,
search index) without needing format-specific logic.

**Tradeoffs accepted.** Usher cannot validate that a category or resource name corresponds to
anything real in the data layer. Misconfigured grants (referencing a nonexistent category) are
silent. Validation is the responsibility of the management UI and the plugin configuration.
