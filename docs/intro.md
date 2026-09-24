# Data access control

Not all data should be accessible to all users. Implementing that constraint correctly, consistently, and in a way that can evolve as policies change is the problem this document sets out.

> Not familiar with OAuth 2.0, JWTs, or access control basics? Start with the [IAM Primer](iam-primer.md). Technical vocabulary is introduced here as it becomes relevant; see [Where to go next](#where-to-go-next) for persona-specific reading paths.

---

## The problem

A platform hosting multiple datasets rarely applies one access rule to all of them. Some data is publicly available. Some requires a registered account. Some carries restrictions defined by the community or jurisdiction that contributed it, or by an external ethics or approval process. The [categories](concepts.md#categories-and-category-grants) that apply to one instance may be entirely different from those that apply to another.

Access rules are not binary. A given user may be permitted to see one subset of records and not another. [Permissions](concepts.md#categories-and-category-grants) can overlap: a single record may require satisfying more than one condition simultaneously.

That is the problem standing still. Several secondary challenges compound it.

**Access changes.** A permission granted today may be revoked tomorrow. The [revocation](concepts.md#revocation-the-self-contained-token-problem) needs to take effect promptly, across every application that touches the data.

**Enforcement needs to be consistent.** A platform is rarely one application. Access rules implemented separately in each application tend to drift apart. A user who should not have access may still reach the data through a service enforcing an outdated rule.

**Decisions need to be auditable.** Governance reviews, regulatory inquiries, and security investigations all require being able to reconstruct who could access what, and when. That answer needs to be available without inspecting application code.

**Failure must be safe.** If a system cannot determine what a user is permitted to do, the correct response is to do nothing: show no records, and refuse the write, rather than falling through to an open default in either direction. Uncertainty is not permission.

**The underlying data should not need to change.** Migrations are expensive and error-prone. Access policy is a query-time concern, not a storage-time one. A platform should be able to apply new rules without modifying the records being protected.

---

## How this is typically addressed

Several patterns have emerged for solving selective data access at platform scale.

### Separating the decision from the enforcement

A central service holds the access policy and answers "what can this user see or do?" on request. Each application, or a [adapter](concepts.md#pep-policy-enforcement-point) within it, enforces that answer at the point of data access. The [decision service](concepts.md#pdp-policy-decision-point) makes no data queries; the application makes no policy decisions.

This separation keeps policy consistent across applications and auditable in one place. Applications can be updated independently of the policy service, and adding a new application to the platform does not require re-implementing the policy logic.

### Expressing access as explicit grants

Rather than listing what each user is denied, access models record what each user is granted. Access is denied by default. A user needs an explicit [grant](concepts.md#categories-and-category-grants) to see a given category of data within a given [resource](concepts.md#resources). The absence of a grant is always a denial.

This is easier to audit and reason about: the full set of a user's access rights is the set of grants on record. There is no implied access, no inherited open default, and no list of denials to maintain in parallel with the list of grants.

### Communicating the decision securely

The decision service needs to deliver its answer to the application in a form the application can verify but the end user cannot tamper with or read. A short-lived [encrypted token](concepts.md#jwe-json-web-encryption-encrypted-jwt) is a common approach: issued by the decision service, decrypted locally by the application, and opaque to the user making the request.

Opacity matters, though not for the reason it might seem. The token never reaches a browser. It travels from Usher to the service holding the data, and is decrypted there. Encryption gives two things: each application gets its own key, so a token issued for the wrong one fails to decrypt instead of being quietly honoured; and grant contents stay out of logs, error reports and traces.

The token is cached for a short window so most requests do not require a round-trip to the decision service.

### Handling revocation promptly

Caching introduces a window where a revoked grant may still be honoured. A revocation channel closes this gap: the decision service notifies applications when grants are revoked, so cached answers are invalidated promptly rather than expiring naturally.

If the revocation channel is disrupted, the safe response is to stop serving data entirely rather than continuing from a potentially stale cache. An adversary who can silence the revocation channel should gain nothing from doing so.

---

## How Usher implements these patterns

Usher is Overture's [authorization](concepts.md#authentication-vs-authorization) service. It implements the decision/enforcement separation, explicit grant model, encrypted token delivery, and revocation channel described above.

**Resources and categories** are Usher's units of access control. A resource is a collection of records (a cohort, a study, an index, or any other logical unit defined by the instance). A category is a named level of sensitivity, also defined by the instance, and a resource lists the ones its records carry. What a category means in terms of actual records is configuration held by the application's enforcement adapter. A grant reaches the records carrying the category it names, so a resource holding a mix is served in part rather than whole. Usher never sees the underlying data or its schema.

**Grants** are explicit records: this holder acts in this role, on this category, within this resource. Usher enforces deny-by-default. No grant means no access, always.

**[The Usher token](concepts.md#usher-tokens)** is Usher's encrypted answer to the question "what can this user see or do?" It carries, for each resource the user holds a grant in, the categories granted there and what they may do with each. A shared library called the bridge, running inside that application, decrypts it and decides one of three things: deny the request, narrow it with a filter, or allow it unrestricted. The adapter then applies that decision before any query reaches the data layer. The token never reaches the user.

**The revocation channel** keeps a live connection open so Usher can announce a grant change immediately, with regular polling as a fallback if that connection drops. Each bridge subscribes to it.

If the channel goes quiet for longer than a configurable grace period, the bridge stops serving data and reports itself unavailable until the connection returns. That is deliberate: an attacker who silences the channel gains nothing, because silence denies access rather than preserving it.

**Usher does not touch the underlying data.** It does not write to the data store, run migrations, or modify records. Access policy is applied at query time by the adapter. An instance can adopt Usher without touching the data it protects, and removing it leaves no data artifacts behind.

**Community data governance.** For instances where a specific community holds data sovereignty rights over their contributed data, Usher's **Custodian** role lets a community representative govern grants for their categories independently of platform administrators. The role is in the design and not in the first release, because nothing appoints a custodian in it. See [Concepts](concepts.md#privileged-roles) for the Custodian and Admin roles.

---

## Where to go next

**New to OAuth, JWTs, or access control systems?**
Start with [IAM Primer](iam-primer.md): it covers the background (OAuth 2.0, OIDC, JWTs,
PDP/PEP/PAP) before Usher-specific vocabulary.

**Evaluating Usher for your instance** (principal investigator, data manager, governance lead)

- [Concepts](concepts.md): the data access tier model, how grants work, what the Custodian and
  Admin roles enable, and data sovereignty support
- [Why Usher](why-usher.md): how Usher relates to adjacent tools and what it specifically adds

**Working with data on an Usher-enabled platform** (researcher, analyst)

- [Concepts](concepts.md): data access tiers, what a category grant means for what you can see

**Building or integrating with Usher** (developer, integration engineer)

- [Concepts](concepts.md): ABAC, PDP/PAP/PEP, Usher tokens, fail-secure, revocation
- [Why Usher](why-usher.md): architectural context and tool comparisons
- [Design Index](https://github.com/overture-stack/usher/blob/main/.dev/design/README.md): full document set with reading order by role
- [Adapter integration](https://github.com/overture-stack/usher/blob/main/.dev/design/adapter-integration.md): the API contract for building an enforcement adapter
- [Permissions model](https://github.com/overture-stack/usher/blob/main/.dev/design/permissions-model.md): resources, categories, grants, and what each person may do with the data they reach
- [Security model](https://github.com/overture-stack/usher/blob/main/.dev/design/security-threat-model.md): OWASP Top 10 mapping and security design decisions
- [Glossary](https://github.com/overture-stack/usher/blob/main/.dev/design/glossary.md): quick-reference definitions

**Any of the above may become a Custodian or Admin.** Custodians govern category access for a
specific community or data type; Admins manage the platform authorization model. Both are covered
in [Concepts](concepts.md) and the [Design Index](https://github.com/overture-stack/usher/blob/main/.dev/design/README.md).
