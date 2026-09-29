# Why Usher

> If you are not yet familiar with the access control problem addressed by Usher, read
> [docs/intro.md](intro.md) first. This document assumes that context.
>
> This document is primarily aimed at developers and architects evaluating or integrating Usher.
> If you are exploring adoption from a governance or research perspective,
> [Concepts](concepts.md) covers the data access tier model, roles, and grants more directly.

Access control for a data platform is not a single problem. It is a stack of problems, each
handled at a different layer. Where Usher fits follows from what each layer does and which tool is
responsible for it.

---

## The layers

**Authentication: who is this user?**

This layer validates identity: checking that a request comes from who it claims to come from,
issuing and validating tokens, and managing sessions. Keycloak handles this in the Overture
platform. Usher is not an authentication service and does not replace or duplicate this layer.
Usher receives the identity token issued by Keycloak. It verifies the signature against
Keycloak's published keys before reading anything from it.

**Coarse authorization: what groups or roles does this user hold?**

Keycloak also handles this, through groups, roles, and group memberships. For many applications,
this is sufficient: a user is either an administrator or they are not. Usher reads the output of
this layer (the identity token's claims) as one input to its own decisions.

**Fine-grained data access: exactly what can this user see in this query?**

Keycloak's built-in authorization is not shaped for this layer. A data platform serving
multiple resources, each carrying its own categories, needs more than group membership to answer
"which records can this user see right now?" The answer changes when grants change. It must be
applied as a query filter, not just a gate at the endpoint. It must be consistent across every
application that serves the data. And when access is revoked, the change must take effect promptly.

Usher occupies this layer.

---

## Where Usher sits among policy tools

Several tools address parts of the access control problem. Most of them decide access, given rules
and facts. Usher is the layer around that decision: it holds the grants, lets the people who govern
access change them, and delivers them to every application, and a decision engine could run inside
it. The facts below were checked against each project's documentation on 2026-09-28, and the sources
are listed in
[decisions.md](https://github.com/overture-stack/usher/blob/main/.dev/design/decisions.md).

**Keycloak**

Keycloak authenticates users and holds groups and roles, and its Authorization Services feature can
decide access too: resources, scopes and policies, a token carrying the permissions granted, and a
mode returning all of a user's permissions. That list covers only objects registered in Keycloak one
by one, and it is a list rather than a query filter. Nor can it hand someone authority over part of
the policies: its administrative roles cover every resource server in a realm, or a client's
authorization settings as a whole.

The deciding reason is independence. Usher's design does not depend on Keycloak specifically, and
support for other identity providers follows the first release, so the rules about who may reach what
cannot live inside one of them. Usher works with Keycloak rather than replacing it: Keycloak
authenticates the user, and Usher resolves the grant set and delivers it to the application as a
[Usher token](concepts.md#usher-tokens), applied by the adapter to every query.

**OPA (Open Policy Agent)**

OPA is a general-purpose policy engine and a graduated CNCF project. Policies are written in Rego (a
declarative query and policy language) and evaluated against input data. OPA is used widely for
Kubernetes admission control and API gateway authorization. Its partial evaluation produces residual
expressions rather than only allow or deny, and since version 1.9 its Compile API turns those into
SQL or UCAST filters, with no Elasticsearch target. That concept directly influenced the Usher
token's design: the token is a pre-computed, encrypted residual, applied by the adapter at the data
layer.

OPA is a possible foundation for Usher, not a tool that makes Usher unnecessary. It still needs the
access management layer on top: a data model for resources, categories and grants; a management
interface for administrators; and a revocation channel for propagating access changes. OPA keeps its
own data current by pulling it, so pushing a revocation to every application promptly is not
something it does alone. Teams already running OPA can use it within their enforcement adapter; the
adapter interface is designed to accommodate this.

**Cerbos**

Cerbos is a standalone PDP service with a clean REST API and policies written in YAML or JSON. It is
the closest architectural match to Usher of the tools reviewed: a separate service called by
applications to resolve authorization decisions, and its API design is a reference for Usher's.
Besides allow or deny, its query planner returns a filter as a condition tree, with adapters for
several ORMs and one for Elasticsearch in Java.

The gap is everything around the decision. Cerbos is stateless: it holds no grants, the application
supplies the facts on every request, and it notifies no application when access changes. Cerbos Hub,
its commercial add-on, authors and distributes policies rather than recording who was granted what.
Usher's evaluation step is a candidate for Cerbos rather than a reason to prefer Usher over it.

For the full technical evaluation of OPA and Cerbos, including what each tool contributed to
the design, see [decisions.md](https://github.com/overture-stack/usher/blob/main/.dev/design/decisions.md).

**Zanzibar-style relationship stores (OpenFGA, SpiceDB, Permify)**

Zanzibar is Google's internal authorization system, described in a 2019 research paper. Its
open-source derivatives model access as a graph of relationships: user A is a member of group B,
which has viewer access to document C. They answer "does A have access to C?" and also "what can A
reach?", as a list of identifiers, and SpiceDB streams relationship changes to subscribers.

What they do not provide is a filter for a search engine, or a check on who may write a
relationship: OpenFGA writes any relationship submitted by a permitted credential, so a custodian
granting themselves access has to be stopped by whatever administers the store. Usher is that
administering layer, with its governance rules, its audit trail and its delivery to applications.
Deploying a relationship store also carries operational overhead that is hard to justify for
platforms with no need for relationship-graph permissions.

**Commercial authorization services (Auth0 FGA, Permit.io, others)**

Several commercial products provide authorization as a service with management interfaces, SDKs and
policy engines. Auth0 FGA runs only as Auth0's service, in regions that do not include Canada.
Permit.io hosts its control plane by default and offers it on premises at its enterprise tier.
Overture platforms are self-hosted, often on premises, and may handle personal health information
subject to privacy legislation, so a required dependency on a vendor's service or licence is not
compatible with them.

**Gen3**

Gen3 is a data commons platform, and its authorization is the nearest existing match to what Usher's
first release does. Its policy engine, Arborist, returns a map of every resource reachable by a
user, and its Elasticsearch search service, Guppy, applies that map as a filter, with access levels
that include aggregate counts above a minimum. An access-request service lets an approver act for
one project without administrator rights. It is part of Gen3 rather than a separate component, and
its access stops at program and project: there are no categories within a dataset, the filter is
applied inside the one search service, and an approver's authority follows the resource tree rather
than one kind of data across datasets.

**Apache Ranger**

Ranger administers policies centrally and enforces them through plugins inside each data engine,
including row filters and column masking for Hive, Trino and Spark, and delegated administration over
a subset of resources. Its Elasticsearch plugin controls whole indices only, and its plugins pull
policies on a schedule.

**CanDIG**

CanDIG, a Canadian federated genomics platform, uses OPA to work out which programs a user may
access, and several of its services filter on that. It is the working example of building this layer
on a general policy engine, at program level.

**REMS, DUOS and GA4GH Passports**

These manage or carry access approvals. REMS runs applications and approvals and can issue signed
GA4GH visas, DUOS supports data access committee review, and a GA4GH Passport lists its holder's
approved datasets. None enforces anything when data is queried, so they sit upstream of Usher, as
possible sources of grants rather than alternatives to it.

**Building it per application**

The most common approach on data platforms is to implement access control separately in each
application. This is the default before a shared access control service exists.

The result is enforcement drift: each application's rules diverge over time. Audit trails are
fragmented across application logs. Access changes must be propagated to every application
independently. Revocation has no reliable mechanism. Usher exists because this approach fails at
platform scale.

---

## What Usher specifically adds

Usher is in design and not yet built, so the list below describes intended behaviour rather than
shipped features.

One capability is deliberately absent from it. Several policy engines already produce a filter
describing what a principal may reach, rather than a yes or no for one request: Cerbos returns
exactly that from its query planner, and the Zanzibar-derived systems answer it as a resource
lookup. Usher's evaluation step is a candidate for one of those engines rather than a reason to
prefer Usher over them.

Across the tools above, its specific contribution is the combination of:

- **Categories within a dataset, enforced alike by every application.** The platforms above filter at
  program, project or index level, or inside one application. Usher's grants name a category within a
  dataset, and every application serving the data applies them the same way.
-  **Grant lifecycle as data.** Access is a set of grant records, each with an origin, an expiring
  validity and an audit trail, administered through an interface rather than deployed as policy
  files. This is what a governance reviewer reads and what a custodian changes, and it is the half
  of the problem left unaddressed by a policy engine.
- **Built-in grant management.** A management interface for non-technical administrators to assign
  and revoke access, audit the current state, and respond to governance reviews without touching
  application code or configuration files.
- **Push revocation.** Applications are notified when grants change, so cached decisions are
  invalidated promptly rather than waiting for a token to expire.
- **Fail-secure by design.** When the revocation channel is unavailable, applications suspend data
  access rather than continuing from a potentially stale cache.
- **Data-agnostic.** Usher does not know the schema or content of the data it protects.
  It can be adopted without modifying the underlying data and removed without leaving data
  artifacts.
- **Self-hosted, open source.** Suitable for on-premises biomedical platforms where data
  residency and external service dependencies are constrained.

---

## What Usher is not

- **Not an authentication service.** Usher does not issue identity tokens or manage sessions.
  It requires an identity provider (Keycloak or compatible) to be in place.
- **Not a data proxy.** Usher does not sit between the application and the data layer. It issues
  Usher tokens; enforcement happens inside the application adapter.
- **Not a general-purpose policy engine.** Usher's policy model is specific: explicit grants over
  resources and categories. It is not designed for complex conditional policies or relationship
  graphs. Teams with those requirements may find OPA or a Zanzibar-style system a better fit,
  potentially with Usher's management and delivery layer on top.
-  **Not a compliance framework.** Usher provides the technical mechanism for access control. The
  policies (who gets access, under what conditions) are a governance and organizational concern,
  implemented by Usher but not defined by it. Who reviews a request, and where that review happens,
  is the part of this that is scoped to the first release rather than settled. A data access
  committee layer is expected to be an application governed by Usher rather than part of it, so that
  Usher stores no application documents or applicant details.
