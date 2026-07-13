# Data access control

Not all data should be accessible to all users. Implementing that constraint correctly, consistently, and in a way that can evolve as policies change is the core challenge we need to address here.

> Not familiar with OAuth 2.0, JWTs, or access control basics? Start with the [IAM Primer](iam-primer.md). Technical vocabulary is introduced here as it becomes relevant; see [Where to go next](#where-to-go-next) for persona-specific reading paths.

---

## The problem

A platform hosting multiple datasets rarely applies one access rule to all of them. Some data is publicly available. Some requires a registered account. Some carries restrictions defined by the community or jurisdiction that contributed it, or by an external ethics or approval process. The [categories](concepts.md#data-categories-and-category-grants) that apply to one deployment may be entirely different from those that apply to another.

Access rules are not binary. A given user may be permitted to see one subset of records and not another. [Permissions](concepts.md#data-categories-and-category-grants) can overlap: a single record may require satisfying more than one condition simultaneously.

This is already complex at rest. In practice, several secondary challenges compound it.

**Access changes.** A permission granted today may be revoked tomorrow. The [revocation](concepts.md#revocation-the-self-contained-token-problem) needs to take effect promptly, across every application that touches the data.

**Enforcement needs to be consistent.** A platform is rarely one application. Access rules implemented separately in each application tend to drift apart. A user who should not have access may find it through a service that enforced an outdated rule.

**Decisions need to be auditable.** Governance reviews, regulatory inquiries, and security investigations all require being able to reconstruct who could access what, and when. That answer needs to be available without inspecting application code.

**Failure must be safe.** If a system cannot determine what a user is permitted to see, the correct response is to show nothing, not to fall through to an open default. Uncertainty is not permission.

**The underlying data should not need to change.** Migrations are expensive and error-prone. Access policy is a query-time concern, not a storage-time one. A platform should be able to apply new rules without modifying the records being protected.

---

## How this is typically addressed

Several patterns have emerged for solving selective data access at platform scale.

### Separating the decision from the enforcement

A central service holds the access policy and answers "what can this user see?" on request. Each application, or a [plugin](concepts.md#pep-policy-enforcement-point) within it, enforces that answer at the point of data access. The [decision service](concepts.md#pdp-policy-decision-point) makes no data queries; the application makes no policy decisions.

This separation keeps policy consistent across applications and auditable in one place. Applications can be updated independently of the policy service, and adding a new application to the platform does not require re-implementing the policy logic.

### Expressing access as explicit grants

Rather than listing what each user is denied, access models record what each user is granted. Access is denied by default. A user needs an explicit [grant](concepts.md#data-categories-and-category-grants) to see a given category of data within a given [resource](concepts.md#resources). The absence of a grant is always a denial.

This is easier to audit and reason about: the full set of a user's access rights is the set of grants on record. There is no implied access, no inherited open default, and no list of denials to maintain in parallel with the list of grants.

### Communicating the decision securely

The decision service needs to deliver its answer to the application in a form the application can verify but the end user cannot tamper with or read. A short-lived [encrypted token](concepts.md#jwe-json-web-encryption-encrypted-jwt) is a common approach: issued by the decision service, decrypted locally by the application, and opaque to the user making the request.

Opacity matters. If a user can read the constraints applied to their session, they can probe for what they are not permitted to see and potentially craft queries to bypass enforcement.

The token is cached for a short window so most requests do not require a round-trip to the decision service.

### Handling revocation promptly

Caching introduces a window where a revoked grant may still be honoured. A revocation channel closes this gap: the decision service notifies applications when grants are revoked, so cached answers are invalidated promptly rather than expiring naturally.

If the revocation channel is disrupted, the safe response is to stop serving data entirely rather than continuing from a potentially stale cache. An adversary who can silence the revocation channel should gain nothing from doing so.

---

## How Usher implements these patterns

Usher is Overture's [authorization](concepts.md#authentication-vs-authorization) service. It implements the decision/enforcement separation, explicit grant model, encrypted token delivery, and revocation channel described above.

**Resources and categories** are Usher's units of access control. A resource is a named grouping of data (a cohort, a study, an index, or any other logical unit defined by the deployment). A category is a named access dimension, also defined by the deployment. What categories mean, and how they map to actual records or fields, is configuration that lives in the application's enforcement plugin. Usher is not aware of the underlying data or its schema.

**Grants** are explicit records: this user holds access to this category within this resource. Usher enforces deny-by-default. No grant means no access, always.

**[The grants token](concepts.md#grants-tokens)** is Usher's encrypted answer to the question "what can this user see?" It contains the categories the user holds grants for within each resource the requesting application manages. The application's plugin decrypts it locally and applies it as a filter on every query before the query reaches the data layer. Users cannot read the token's contents.

**The revocation channel** is a push notification stream (SSE or WebSocket) backed by a poll endpoint. Active plugins subscribe; Usher emits on any grant change. If the channel is silent for longer than a configurable grace period, the plugin suspends access and returns 503 until connectivity is restored.

**Usher does not touch the underlying data.** It does not write to the data store, run migrations, or modify records. Access policy is applied at query time by the plugin. A deployment can adopt Usher without touching the data it protects, and removing it leaves no data artefacts behind.

**Community data governance.** For deployments where a specific community holds data sovereignty rights over their contributed data, Usher's **Steward** role enables a community representative to govern grants for their data categories independently of platform administrators. See [Concepts](concepts.md#privileged-roles) for the Steward and Admin roles.

---

## Where to go next

**New to OAuth, JWTs, or access control systems?**
Start with [IAM Primer](iam-primer.md): it covers the background (OAuth 2.0, OIDC, JWTs,
PDP/PEP/PAP) before Usher-specific vocabulary.

**Evaluating Usher for your deployment** (PI, data manager, governance lead)
- [Concepts](concepts.md): the data access tier model, how grants work, what the Steward and
  Admin roles enable, and data sovereignty support
- [Why Usher](why-usher.md): how Usher relates to adjacent tools and what it specifically adds

**Working with data on a Usher-enabled platform** (researcher, analyst)
- [Concepts](concepts.md): data access tiers, what a category grant means for what you can see

**Building or integrating with Usher** (developer, integration engineer)
- [Concepts](concepts.md): ABAC, PDP/PAP/PEP, grants tokens, fail-secure, revocation
- [Why Usher](why-usher.md): architectural context and tool comparisons
- [Design Index](https://github.com/overture-stack/usher/blob/main/.dev/design/README.md): full document set with reading order by role
- [Plugin integration](https://github.com/overture-stack/usher/blob/main/.dev/design/plugin-integration.md): the API contract for building an enforcement plugin
- [Permissions model](https://github.com/overture-stack/usher/blob/main/.dev/design/permissions-model.md): resources, categories, grants, and visibility semantics
- [Security model](https://github.com/overture-stack/usher/blob/main/.dev/design/security-threat-model.md): OWASP Top 10 mapping and security design decisions
- [Glossary](https://github.com/overture-stack/usher/blob/main/.dev/design/glossary.md): quick-reference definitions

**Any of the above may become a Steward or Admin.** Stewards govern data category access for a
specific community or data type; Admins manage the platform authorization model. Both are covered
in [Concepts](concepts.md) and the [Design Index](https://github.com/overture-stack/usher/blob/main/.dev/design/README.md).
