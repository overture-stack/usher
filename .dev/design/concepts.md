# Concepts and Vocabulary

This document explains the security and authorization concepts referenced throughout the Usher
design documents. Each concept is framed around the problem it solves (the threat or limitation
it exists to address), which should be useful for anyone who approaches security from an
adversarial perspective and wants to understand the defensive design counterparts.

---

## Authentication vs authorization

These two words are often used interchangeably but they describe distinct steps.

**Authentication** answers: _who are you?_ It is the process of verifying an identity claim,
typically by checking a credential (password, hardware key, biometric). The output is a confirmed
identity: "this is user alice@example.com".

**Authorization** answers: _what are you allowed to do?_ Given a confirmed identity, it determines
what that identity is permitted to access, read, or modify. The output is a decision and, in
Usher's case, a set of constraints: "alice can access studies A and B, but not C, and cannot see
fields tagged as indigenous_data".

Usher is an authorization service. Authentication is delegated to the identity provider (IdP).
Conflating the two is a common design error: an IdP that also owns authorization policy becomes a
single point of failure for both security layers, and changing access rules requires touching
identity infrastructure.

---

## RBAC vs ABAC

**RBAC (Role-Based Access Control)** grants access based on roles assigned to a user. A user is
an "admin" or a "viewer"; the role determines what they can do. This is simple and works well when
access rules are uniform: all admins can do X, all viewers can do Y.

RBAC breaks down when access rules become contextual. If different users with the "researcher"
role should see different studies, you need "study-A-researcher" and "study-B-researcher" as
separate roles. Add a data sensitivity dimension (some researchers can see restricted data, others
cannot) and the number of roles explodes. Every combination of scope and permission requires its
own role. This is the role proliferation problem.

**ABAC (Attribute-Based Access Control)** makes access decisions based on attributes of the user,
the resource, and the context, evaluated against policies. Instead of "is this user an admin?",
ABAC asks "does this user have the 'curator' role in study A, and does study A contain
indigenous_data, and does this user hold an explicit grant for indigenous_data in study A?"

ABAC handles contextual access rules without proliferating roles. The cost is a more complex
policy model and a more complex enforcement mechanism. Usher uses a hybrid: roles for coarse
capability (curator vs member), attributes for scope (which resources, which data categories).

---

## The four ABAC components

Using the venue/concert analogy (fitting given the service name):

### PDP: Policy Decision Point

The PDP is the entity that receives a question ("can this person access this?") and returns a
decision ("yes, with these constraints" or "no").

Analogy: the usher checking your ticket. They don't make the rules; they apply them. They tell you
which section you're allowed into and what you're not allowed to bring in.

In Usher: the running service itself. It receives a user identity, validates it with the IdP,
looks up the user's policy in the database, and returns an encrypted constraint token.

### PAP: Policy Administration Point

The PAP is where policies are defined and managed. It is the interface through which administrators
configure who can access what.

Analogy: the box office and event management system. This is where seat allocations are configured,
VIP lists are maintained, and access tiers are defined.

In Usher: the management UI (planned). Administrators assign users to resources, set roles, and
grant or revoke data category access, without needing access to Keycloak or any IdP admin panel.

**PAP admin and platform admin are synonymous.** "Platform admin" is the user-facing term for
the system-wide authorization administrator role. "PAP admin" is the internal architecture
shorthand. Design documents may use either; user-facing text (management UI, operator
documentation) should use "platform admin". See [admin-model.md](admin-model.md) for the full
admin model: OIDC-first identification, bootstrap, self-grant flow, service accounts, and audit
integrity controls.

### PEP: Policy Enforcement Point

The PEP is where the policy decision is actually enforced. It intercepts a request, asks the PDP
for a decision, and either allows or blocks the request (and applies any constraints).

Analogy: the physical door and the staff member checking tickets. The PDP (usher) made the
decision; the PEP (door + staff) is what physically stops you from entering.

In Usher: the per-app plugins (`@overture-stack/usher-arranger`, etc.). They intercept incoming
requests, validate the constraint token, and translate the constraints into the app's native
filter format (SQON, database query conditions, etc.).

### PIP: Policy Information Point

The PIP provides attribute data used to make policy decisions: information about the user,
the resource, or the environment that the PDP cannot resolve on its own.

Analogy: the ticket database that the usher can query to verify whether a ticket is genuine and
what access level it represents.

In Usher: the identity provider (Keycloak, Azure Entra). It validates the user's bearer token and
provides identity attributes (email, IdP roles, group memberships). Usher's own policy database
is also a PIP for authorization-specific attributes.

---

## The permissions model entities

Usher's permissions model is built from a small set of composable entities. Understanding what
each one represents, and why they are separate, makes the rest of the model easier to reason about.

### Resources

A **resource** is whatever Usher is protecting. The term is deliberately generic: Usher's core
model does not know or care what kind of thing it is protecting. Domain-specific names appear only
in the management UI layer, which is configured per deployment.

**In the Overture context, a resource is a cohort.** This is a deliberate departure from the
"study" or "project" vocabulary used in other platforms. Those terms carry a silo implication:
data belongs to one study, and studies do not overlap. Cohorts are a different model: a cohort is
a grouping of data records defined by shared characteristics, and the same record can belong to
multiple cohorts simultaneously.

Concretely: a patient's genomic sample might belong to a "rare disease" cohort and a "pediatric"
cohort at the same time. Those cohorts overlap; they are not separate containers. The venn-diagram
framing is the right mental model. A researcher granted access to the "rare disease" cohort sees
its records; a researcher granted access to the "pediatric" cohort sees its records; a researcher
granted access to both sees the intersection too.

This affects how the access model composes when records belong to multiple cohorts. If a record
belongs to cohort A and cohort B, and a user is a member of cohort A only, should they see that
record? This is an open design question. The conservative answer (require membership in all cohorts
a record belongs to, AND semantics) aligns with deny-by-default; the permissive answer (require
membership in any cohort, OR semantics) is more operationally convenient but risks exposing
records the user was not explicitly approved for. This question is flagged in the permissions model
open questions and needs a deliberate decision before implementation.

Resources are the unit of scope for all other entities. Access grants and memberships are always
resource-scoped. "A user can see record X" is not how Usher thinks; "a user is a member of
resource Y and holds a category grant for category Z within resource Y" is.

### Roles and memberships

A **role** is a coarse-grained capability label: `curator`, `member`, `viewer`. It describes what
kind of actions a user can perform within a resource. Roles are defined at the platform level; the
exact set is a deployment decision.

A **membership** is the record that a specific user holds a specific role in a specific resource.
Without a membership, a user has no access to that resource at all.

Membership is necessary but not sufficient for controlled-tier data access. A member who lacks a
category grant for a data category is excluded from records tagged with that category, even if
they are fully joined to the resource in the `member` role.

Think of it as two separate gates: the first gate (membership) determines whether you are allowed
into the venue at all. The second gate (category grant) determines which areas of the venue you
can access once inside.

### Data categories and category grants

A **data category** is a named label that marks a subset of records or fields within a resource as
requiring an additional level of access. Examples: `indigenous_data`, `controlled_access`,
`restricted_clinical`. A resource can have multiple categories; the categories that apply to a
resource are stored in `resource_categories`.

A **category grant** is the explicit permission record that allows a specific user to see records
tagged with a specific category within a specific resource. Without a grant, a member is excluded
from all records tagged with that category.

This is how the Controlled access tier (see Data access tiers below) is implemented in practice.
The data category names the protected dimension; the category grant says who is approved to see it.
Two users with the same role in the same resource can have meaningfully different views of the data
depending on their category grants.

### User groups

Administering access for a research team of 40 users as 40 individual grants would be error-prone
and slow. **User groups** exist to make administration tractable at scale.

A user group is a named collection of users. Groups are first-class entities in Usher's model:
they can hold memberships in resources and hold category grants, in exactly the same way individual
users can. A user's effective access is the union of their personal grants and all grants held by
every group they belong to.

This is where the word "membership" becomes overloaded, because it refers to two different
relationships:

| Entity               | What it means                                                               |
|----------------------|-----------------------------------------------------------------------------|
| `user_group_members` | A user belongs to a group (group administration, not resource access)       |
| `memberships`        | A user has a role in a resource (resource access)                           |
| `group_memberships`  | A group has a role in a resource (resource access, applied to all members)  |

The same word "membership" is used for both the user-group relationship and the resource-access
relationship, which is the source of the confusion. A more explicit reading:

- Belonging to a **group** (`user_group_members`) is about administration: which collection of
  users does this person get lumped with?
- Belonging to a **resource** (`memberships`, `group_memberships`) is about access: which
  resources does this person (or group) have a role in?

A user who is added to a group immediately inherits all of that group's resource memberships and
category grants. If the group is later removed from a resource, all users who had access only
through that group lose it, and revocation propagates through the standard channel.

Groups do not create a separate access model; they are a convenience layer over the same entity
structure individual users use.

---

## Data access tiers

Not all data requires the same level of protection, and not all users require the same level of
verification before access is granted. A three-tier model expresses this cleanly and is the
organizing principle for how Usher's permissions model is applied in practice.

**Open:** no authentication required. Data is publicly accessible to any user, including anonymous
requests. Aggregated statistics, counts without record-level detail, and published datasets with
no privacy risk fall into this tier. Usher is not involved: requests pass through unauthenticated
and unconstrained.

**Registered:** the user must have a confirmed identity and must have accepted the platform's
terms of access. No further approval is required beyond that. This tier is appropriate when
accountability matters but a full approval process would be disproportionate, for example
summarized clinical data or non-sensitive genomic aggregates where knowing who accessed the data
is sufficient protection.

In Usher terms: the user authenticates, Usher issues a constraint token, and membership alone is
sufficient to access all uncategorized records and fields within the resources the user belongs to.

**Controlled:** access requires an explicit, per-dataset approval from a data access authority.
Typically this is a Data Access Committee (DAC) that reviews a researcher's application and
approves or denies access based on their research purpose and institution. Each dataset may have
its own DAC with its own criteria.

In Usher terms: records and fields tagged with a data category require an explicit `category_grant`
in Usher's policy store. Membership without a grant is not sufficient. This is the deny-by-default
principle expressed at the tier level.

| Tier       | Usher mechanism                                                                  |
|------------|----------------------------------------------------------------------------------|
| Open       | No constraint token required; no Usher involvement                               |
| Registered | Constraint token issued on authentication; membership grants access to uncategorized data |
| Controlled | Access to categorized records and fields requires an explicit `category_grant`   |

The data category and category grant concepts in the permissions model exist specifically to
implement the Controlled tier. The Open and Registered tiers follow from the same model by
absence: no categories on a resource means all members see all records (Registered). No Usher
involvement means no constraint at all (Open).

---

## GA4GH Passports and federated identity

The three-tier model describes what level of access is required. It does not address a practical
problem in genomics and health research: researchers from one institution often need access to
data held by another institution, and those institutions do not share the same identity
infrastructure.

Without a shared standard, each data holder must establish a direct trust relationship with each
institution whose researchers they serve. That does not scale. GA4GH Passports are the solution.

GA4GH (Global Alliance for Genomics and Health) is an international standards body. Their
**Passport** specification defines a standard format for expressing access claims inside OIDC
tokens: specifically, a structured JWT claim (`ga4gh_passport_v1`) that any OIDC-compliant
identity system can carry. It is not a new protocol; it is a defined schema for access grants
inside tokens you already use.

### Visa types

A Passport contains one or more **Visas**: individual signed claim assertions. The types
relevant to Overture:

| Visa type                  | What it asserts                                                             |
|----------------------------|-----------------------------------------------------------------------------|
| `ControlledAccessGrants`   | Researcher is approved for dataset X, access type Y, until date Z           |
| `AcceptedTermsAndPolicies` | Researcher accepted data use agreement B                                    |
| `AffiliationAndRole`       | Researcher is affiliated with institution A in role R                       |
| `ResearcherStatus`         | Researcher holds bona fide researcher status (e.g. ELIXIR Researcher)      |

`ControlledAccessGrants` is the visa type that maps directly to Usher's Controlled access tier:
a DAC approval for a specific dataset is the external origin of a `category_grant`.

### The three roles in a Passport ecosystem

Different parties in a Passport-enabled ecosystem play distinct roles:

| Role                | What it does                                                              | Examples                               |
|---------------------|---------------------------------------------------------------------------|----------------------------------------|
| **Visa Issuer**     | Signs and issues individual Visa assertions after an approval event       | REMS, ELIXIR AAI, institutional DACs   |
| **Passport Broker** | Aggregates Visas from multiple Issuers into a single Passport             | LifeScience Login, ELIXIR Login        |
| **Clearinghouse**   | Validates incoming Passports and maps approved claims to access grants    | Usher, via Keycloak                    |

Usher plays the Clearinghouse role. It does not validate Passport signatures itself; that is
Keycloak's job, via a GA4GH Passport extension. Keycloak validates each Visa's signature against
the issuer's public JWKS endpoint, checks the issuer against a configured trusted-issuers list,
verifies expiry, and maps validated claims to Keycloak token attributes. Usher reads those
attributes and maps them to `category_grants` in its policy store. The per-app PEP plugins see
only the constraint token and have no awareness of whether a grant came from an internal admin
action or an external Passport Visa.

### The flow

```
Researcher obtains Visas from external DAC via REMS or similar
  -> Passport Broker (LifeScience Login / ELIXIR) bundles them into a Passport
  -> Researcher authenticates to Keycloak with their Passport
  -> Keycloak (GA4GH Passport extension):
       validates each Visa signature against issuer JWKS
       checks issuer against trusted-issuers list
       maps ControlledAccessGrants claims to Keycloak token attributes
  -> Usher reads Keycloak attributes, maps to category_grants
  -> Usher issues JWE constraint token
  -> PEP plugin enforces it as normal (unchanged)
```

### Visa expiry and revocation

Passport Visas carry their own `expires` timestamp, set by the Visa Issuer. When a Visa expires,
Usher treats this as a revocation trigger: the same `revoked_at` mechanism used for internal
revocations fires. The researcher's session is suspended during the fail-secure grace period and
must be resumed by re-authenticating with a refreshed Passport.

Local administrators can also revoke a grant that originated from an external Visa. Local policy
can always restrict access downward; it cannot grant access that no Visa covers.

### REMS: running your own Visa Issuer

If an Overture deployment wants its own controlled-access approval workflow (a DAC reviewing
applications and approving or denying them through a managed process), REMS (Resource Entitlement
Management System, from CSC Finland) is the standard tool. REMS issues `ControlledAccessGrants`
Visas as output when a DAC approves a request, and integrates with Keycloak. It is used in
production by ELIXIR, GHGA, and other GA4GH-aligned platforms.

REMS is optional. An Overture deployment can accept Passports from external Brokers without running
its own REMS instance; accepting external approvals and issuing internal approvals are separable
capabilities.

---

## JWTs: signed (JWS) vs encrypted (JWE)

A JWT (JSON Web Token) is a compact, self-contained token that encodes claims about a subject
(typically a user). There are two important variants with very different security properties.

### JWS: JSON Web Signature (signed JWT)

A JWS encodes claims as Base64 and appends a cryptographic signature. The signature proves the
token was issued by a trusted party and has not been tampered with. But the claims themselves are
not secret: anyone who intercepts or inspects the token can decode and read them.

Analogy: a signed cheque. The bank's signature on the back proves it's genuine. But the amount,
payee, and account number are printed on the front and visible to anyone who handles it.

A standard Keycloak access token is a JWS. You can paste it into [jwt.io](https://jwt.io) and
read every claim.

### JWE: JSON Web Encryption (encrypted JWT)

A JWE encrypts the claims. The payload is ciphertext, unreadable to anyone who does not hold
the decryption key. JWE also includes a signature, so it is both confidential and tamper-evident.

Analogy: a sealed, tamper-evident envelope. Only the recipient with the right key can open and
read the contents. The seal proves it was not already opened and resealed.

Usher issues constraint tokens as JWE. The claims inside (which resources the user can access,
which data categories they are excluded from, when the token was generated) are visible only to
app plugins that hold the decryption key. The user holding the token cannot read their own
constraints.

**Why this matters adversarially:** a user who can read their own constraint token knows exactly
what filters are being applied to their queries. In a sensitive data context, even the shape of
the restriction (you are excluded from `indigenous_data` records in study X) may itself be
information they should not have. JWE prevents this.

---

## Token TTL (Time to Live)

A token's TTL is how long it is valid after issuance. After the TTL expires, the token is
rejected regardless of its content.

TTL is a security control, not a convenience feature. The threat it mitigates: if a token is
compromised (intercepted, stolen, leaked), the attacker can use it to impersonate the user. A
short TTL limits the window of exposure: a stolen token is useless after a few minutes.

The tradeoff: shorter TTL means more frequent re-issuance, which means more calls to the
authorization service, which means more load and latency. Usher's constraint tokens use a short
TTL (suggested default: 5 minutes) combined with local validation (plugins validate and cache
the token without calling Usher on each request) to get short exposure windows without
per-request overhead.

---

## Revocation: the self-contained token problem

A self-contained token (one that can be validated locally without contacting the issuer) cannot be
"unissued". Once issued, it remains valid until its TTL expires, regardless of what happens in the
meantime.

Analogy: a paper concert ticket. Once printed, you cannot remotely invalidate it. If you need to
stop someone from entering, your only options are: (1) wait for the ticket to expire naturally,
(2) check a blocklist at the door, or (3) use a signal that marks a class of tickets invalid
(e.g. "all tickets printed before 3pm are invalid").

Usher uses approach (3): each user has a `revoked_at` timestamp in the policy store. Any token
with a `generatedAt` earlier than the user's `revoked_at` is treated as invalid. This works
because `generatedAt` is embedded (encrypted) in every constraint token. The revocation signal
propagates to plugins via push (immediate, best-effort) and poll (30-second interval, reliable
fallback).

A per-token blocklist (approach 2) is more precise but requires the issuer to track every token
ID ever issued, and requires plugins to check the blocklist on each request, reintroducing the
per-request network call. The `revoked_at` approach achieves similar results at much lower cost.

---

## Fail-secure vs fail-open

When a security system encounters an unexpected condition (a network failure, a timeout, an
ambiguous state), it must make a choice: allow the request (fail-open) or deny it (fail-secure).

**Fail-open** prioritizes availability. If the authorization check fails, the request is allowed
through. Services remain available during outages, but a deliberate attack on the authorization
system (blocking the revocation channel, for instance) allows unauthorized access to continue.

**Fail-secure** prioritizes safety. If the authorization check fails, the request is denied.
Legitimate users are affected by outages, but an attacker who blocks the authorization channel
gains nothing; they cannot keep a revoked session alive by disrupting the revocation mechanism.

Analogy: a fire door.
- Fail-secure: the door locks when power fails. People cannot exit freely, but unauthorized
  parties cannot enter. Prioritizes containment over egress.
- Fail-open: the door opens when power fails. People can exit, but so can unauthorized parties.
  Prioritizes egress over containment.

Usher's revocation channel is fail-secure: if a plugin cannot confirm revocation status within a
configurable grace period, it suspends active sessions until connectivity is restored. Suspended
sessions resume when Usher is reachable again without requiring re-authentication. This is
intentional: the threat of an adversary blocking the revocation channel to keep a compromised
session alive is more serious than the inconvenience of a brief service interruption for
legitimate users.

---

## Constraint tokens

A standard authorization decision is binary: allowed or denied. A **constraint token** extends
this with structured data describing the specific conditions under which access is allowed.

Rather than "alice is allowed to query the dataset", a constraint token says "alice is allowed to
query the dataset, restricted to resources A and B, with records tagged `indigenous_data` excluded,
and with no access to fields tagged `controlled_clinical`".

The app plugin (PEP) reads the constraints and applies them to the outgoing query, before the
query reaches the data layer. The constraint is enforced server-side, not client-side: the client
never receives data it was not supposed to see, and cannot bypass the constraint by modifying the
query.

Constraint tokens are the core mechanism by which Usher delegates enforcement to per-app plugins
without requiring those plugins to understand the full policy model. The plugin does not need to
know why a user is excluded from certain data; it only needs to translate the constraint object
into its app's native query format.
