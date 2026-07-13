# Why Usher

> If you are not yet familiar with the access control problem Usher addresses, read
> [docs/intro.md](intro.md) first. This document assumes that context.

Access control for a data platform is not a single problem. It is a stack of problems, each
handled at a different layer. Understanding where Usher fits requires understanding what each layer
does and which tools are responsible for it.

---

## The layers

**Authentication: who is this user?**

This layer validates identity: checking that a request comes from who it claims to come from,
issuing and validating tokens, and managing sessions. Keycloak handles this in the Overture
platform. Usher is not an authentication service and does not replace or duplicate this layer.
Usher receives the identity token that Keycloak issues and trusts its contents.

**Coarse authorization: what groups or roles does this user hold?**

Keycloak also handles this, through groups, roles, and group memberships. For many applications,
this is sufficient: a user is either an administrator or they are not. Usher reads the output of
this layer (the identity token's claims) as one input to its own decisions.

**Fine-grained data access: exactly what can this user see in this query?**

This is the layer Keycloak's built-in authorization does not reach. A data platform serving
multiple cohorts, each with their own access dimensions, needs more than group membership to answer
"which records can this user see right now?" The answer changes when grants change. It must be
applied as a query filter, not just a gate at the endpoint. It must be consistent across every
application that serves the data. And when access is revoked, the change must take effect promptly.

Usher occupies this layer.

---

## Where Usher sits among policy tools

Several tools address parts of the access control problem. None of them are direct alternatives to
Usher in the way a competing product would be. They address different sub-problems, and some of
them are building blocks Usher can be used with.

**Keycloak**

Keycloak's resource server feature can enforce access policies at the endpoint level: a request is
allowed or denied based on scopes and roles. This is appropriate for API-level access control ("can
this user call this endpoint?") but not for data-level filtering ("which rows can this user see
within a query to this endpoint?"). Keycloak does not know the schema of the data being served,
does not produce query filters, and does not have a revocation channel for propagating access
changes to caching clients.

Usher is designed to work with Keycloak, not replace it. Keycloak authenticates the user and
establishes coarse membership; Usher resolves the fine-grained grant set and delivers it to the
application as a constraint token the plugin applies to every query.

**OPA (Open Policy Agent)**

OPA is a general-purpose policy engine. Policies are written in Rego and evaluated against input
data. OPA is used widely for Kubernetes admission control and API gateway authorization, and its
partial evaluation feature can produce residual expressions rather than just allow/deny decisions.
That concept directly influenced Usher's constraint token design: the token is a pre-computed,
encrypted residual that the plugin applies at the data layer.

OPA is a tool Usher could build upon, not a tool that makes Usher unnecessary. As a standalone
engine it still requires the access management layer on top: a data model for resources, categories,
and grants; a management interface for administrators; and a revocation channel for propagating
access changes. OPA provides the evaluation engine; Usher provides the rest. Teams already running
OPA can use it for query filter translation within their enforcement plugin; the plugin interface
is designed to accommodate this.

**Cerbos**

Cerbos is a standalone PDP service with a clean REST API and YAML-defined policies. It is the
closest architectural match to Usher of the tools reviewed: a separate service that applications
call to resolve authorization decisions. Cerbos's API design is a reference for Usher's.

The gap: Cerbos decisions are binary (allow/deny). Usher's use case requires a structured output:
not just "can this user see data?" but "which categories of data can they see, in which resources?"
That structured answer is what the constraint token delivers. It cannot come from Cerbos without
significant application-side wrapping.

**Zanzibar-style relationship stores (SpiceDB, AuthZed, others)**

Google Zanzibar and its open-source derivatives model access as a graph of relationships: user A
is a member of group B, which has viewer access to document C. This model is powerful for
social-graph-style permissions and scales to very large relationship sets.

It is a different model from Usher's. Usher's grants are explicit, tabular (user holds category X
in resource Y), and resolved into a constraint token that the plugin applies as a query predicate.
Zanzibar-style systems answer "does user A have access to object C?" rather than "what is the full
set of things user A can see, expressed as a filter?" The constraint token pattern is not native to
these systems. Deploying a Zanzibar-style store also carries meaningful operational overhead that
is hard to justify for platforms that do not need its relationship-graph capabilities.

**Commercial SaaS authorization (Permit.io, Auth0 Fine-Grained Authorization, others)**

Several commercial products provide authorization-as-a-service with management UIs, SDKs, and
policy engines. They are not suitable for Overture deployments. Overture platform instances are
self-hosted, often on-premises, and may handle personal health information subject to applicable
privacy legislation. Sending authorization decisions or user identity data to an external SaaS
service is not compatible with these requirements.

**Building it per application**

The most common approach on data platforms is to implement access control separately in each
application. This is the default before a shared authorization service exists.

The result is enforcement drift: each application's rules diverge over time. Audit trails are
fragmented across application logs. Access changes must be propagated to every application
independently. Revocation has no reliable mechanism. Usher exists because this approach fails at
platform scale.

---

## What Usher specifically adds

Across the tools above, Usher's specific contribution is the combination of:

- **Structured constraint output.** The constraint token tells the application not just whether the
  user has access, but what they have access to, expressed as a filter the plugin applies to every
  query.
- **Built-in grant management.** A management interface for non-technical administrators to assign
  and revoke access, audit the current state, and respond to governance reviews without touching
  application code or configuration files.
- **Push revocation.** Applications are notified when grants change, so cached decisions are
  invalidated promptly rather than waiting for a token to expire.
- **Fail-secure by design.** When the revocation channel is unavailable, applications suspend data
  access rather than continuing from a potentially stale cache.
- **Data-agnostic deployment.** Usher does not know the schema or content of the data it protects.
  It can be adopted without modifying the underlying data and removed without leaving data
  artefacts.
- **Self-hosted, open source.** Suitable for on-premises biomedical platforms where data
  residency and external service dependencies are constrained.

---

## What Usher is not

- **Not an authentication service.** Usher does not issue identity tokens or manage sessions.
  It requires an identity provider (Keycloak or compatible) to be in place.
- **Not a data proxy.** Usher does not sit between the application and the data layer. It issues
  constraint tokens; enforcement happens inside the application plugin.
- **Not a general-purpose policy engine.** Usher's policy model is specific: explicit grants over
  resources and categories. It is not designed for complex conditional policies or relationship
  graphs. Teams with those requirements may find OPA or a Zanzibar-style system a better fit,
  potentially with Usher's management and delivery layer on top.
- **Not a compliance framework.** Usher provides the technical mechanism for access control. The
  policies (who gets access, under what conditions, reviewed by whom) are a governance and
  organisational concern that Usher implements but does not define.
