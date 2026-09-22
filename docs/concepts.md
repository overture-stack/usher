# Concepts and Vocabulary

This document explains the security and authorization concepts used throughout Usher's design.
Security concepts are framed around the threat they address. Model concepts are framed around the
problem they solve.

**Usher is in design and not yet built.** Everything here describes intended behaviour. Where a
capability is planned rather than settled, the text says so. Two things are worth knowing before you
read on: the first release gives every record exactly one resource, and a grant reaches the records
of one category within it, so a resource holding a mix is served in part rather than whole.
Narrowing further, down to individual fields, comes later.

---

## Access control does not modify data

Usher controls who may reach data and what they may do with it, reading included and not only
reading: creating records, changing them and removing them are governed the same way. What it never
does is modify the underlying records in order to enforce any of that.

This is a hard design boundary. A decision is computed from the policy alone, then expressed as a
filter returned to the requesting application, which is where it meets the data. That covers
content-based rules such as "access if fieldA equals X": the rule names a field and a value, and
the application resolves it. The data itself is never modified as a side effect of a policy
decision. There are no permission-driven data migrations and no field redactions written back to
the source. No synthetic columns are added to support access logic.

This matters for two reasons:

**Provenance integrity.** The data that was submitted is the data that exists. Usher cannot
corrupt, alter, or annotate source records. Any system that reads the underlying store directly
(outside Usher's control) sees exactly what was submitted.

**Non-invasive adoption.** Usher can be applied to an existing dataset without any migration or
transformation of the stored records. The access policy layer is additive and external. The data
layer is untouched.

Field-level access control is designed but not built. When it arrives, Usher will express which
fields a user may see as grants in the token. The application will omit the rest from its response.
The stored record stays complete and unchanged either way. See the field-level restriction section
in [permissions-model.md](https://github.com/overture-stack/usher/blob/main/.dev/design/permissions-model.md).

---

## Authentication vs authorization

These two words are often used interchangeably but they describe distinct steps.

**Authentication** answers: _who are you?_ It is the process of verifying an identity claim,
typically by checking a credential (password, hardware key, biometric). The output is a confirmed
identity: "this is user alice@example.com".

**Authorization** answers: _what are you allowed to do?_ Given a confirmed identity, it determines
what that identity is permitted to access, read, or modify. The output is a decision. In Usher's
case it also carries a structured set of grants. For example: "alice is a viewer of
indigenous_data in cohort A, and a viewer of the open records in cohort B".

Usher does authorization. Authentication is delegated to the identity provider (IdP).
Conflating the two is a common design error. An IdP that also owns authorization policy becomes a
single point of failure for both security layers. Changing access rules then requires touching
identity infrastructure.

---

## RBAC vs ABAC

**RBAC (Role-Based Access Control)** grants access based on roles assigned to a user. A user is an
"admin" or a "viewer". The role determines what they can do. This is simple and works well when
access rules are uniform: all admins can do X, all viewers can do Y.

RBAC breaks down when access rules become contextual. Say different users with the "researcher"
role should see different studies. You now need two separate roles: "study-A-researcher" and
"study-B-researcher". Add a data sensitivity dimension (some researchers can see restricted data,
others cannot) and the number of roles explodes. Every combination of scope and permission requires
its own role. This is the role proliferation problem.

**ABAC (Attribute-Based Access Control)** makes access decisions based on attributes of the user,
the resource, and the context, evaluated against policies. Instead of asking "is this user an
admin?", ABAC asks a compound question. Does cohort A carry indigenous_data? Does this user hold a
grant naming that category in that cohort? And what does the role on that grant permit them to do
with the records it reaches?

ABAC handles contextual access rules without proliferating roles. The cost is a more complex
policy model and a more complex enforcement mechanism. Usher uses a hybrid: a role for what acts a
grant permits, attributes for scope (which resource, which category). The roles are not a scale from
narrow to wide. `viewer` and `curator` act on records, `owner` acts on who may reach them, and a
person can hold one, the other, or both.

**This hybrid is a recognized pattern rather than a local invention.** It is close to RABAC,
role-centric attribute-based access control
([Jin, Sandhu and Krishnan, MMM-ACNS 2012](https://www.profsandhu.com/confrnc/misconf/mmm-acns12-rabac-paper.pdf)),
which extends RBAC with an attribute-based filter applied after the role check rather than in place
of it. The role decides which actions are available at all; the attributes decide which data those
actions reach. Both must permit an access for it to proceed.

---

## The four ABAC components

Using the venue/concert analogy (fitting given the service name):

### PDP: Policy Decision Point

The PDP receives a question: "can this person access this?" It returns one of three answers: no,
yes without restriction, or yes narrowed by a filter. Keeping the middle and the last apart is
deliberate: an unrestricted yes and a yes that happens to exclude nothing look identical in a query
and mean opposite things.

Analogy: the usher checking your ticket. They don't make the rules; they apply them. They tell you
which section you're allowed into and what you're not allowed to bring in.

In Usher: the controller, the central service. It receives a user identity and validates it with
the IdP, then looks up that user's grants in the database and returns an encrypted Usher token.

### PAP: Policy Administration Point

The PAP is where policies are defined and managed. Administrators use it to configure who can
access what.

Analogy: the box office and event management system. This is where seat allocations are configured,
VIP lists are maintained, and access tiers are defined.

In Usher: the management UI (planned). Administrators write and revoke grants, each naming a
resource, a category and the role its holder acts in, and decide which categories a resource lists.
None of that requires access to Keycloak or any IdP admin panel.

The platform-wide authorization administrator role is **Admin** (architecture shorthand: **PAP
admin**). See [Privileged roles](#privileged-roles) below for the description, and
[admin-model.md](https://github.com/overture-stack/usher/blob/main/.dev/design/admin-model.md) for
the implementation design.

### PEP: Policy Enforcement Point

The PEP is where the policy decision is actually enforced. It intercepts a request and asks the PDP
for a decision. It then allows or blocks the request, applying any constraints.

Analogy: the physical door and the staff member checking tickets. The PDP (usher) made the decision.
The PEP (door + staff) is what physically stops you from entering.

In Usher: two pieces working together inside the application that serves the data.

The **bridge** (`@overture-stack/usher-bridge`) is a shared library. It obtains the Usher token
from Usher, decrypts it, and works out one of three answers: deny the request, narrow it with a
filter, or allow it unrestricted.

The **plugin** (`@overture-stack/usher-arranger`, and one per application after it) takes that
answer and acts on it. When the answer is "narrow", the plugin translates the filter into whatever
query language its own data store speaks.

Neither runs in the browser. Both live in the service that holds the data.

### PIP: Policy Information Point

The PIP provides attribute data used to make policy decisions: information about the user, the
resource, or the environment. The PDP cannot resolve these on its own.

Analogy: the ticket database the usher can query. It tells them whether a ticket is genuine and
what access level it represents.

In Usher: the identity provider (Keycloak, Microsoft Entra ID). It validates the user's bearer token and
provides identity attributes (email, IdP roles, group memberships). Usher's own policy database
is also a PIP for authorization-specific attributes.

---

## The permissions model entities

Usher's permissions model is built from a small set of composable entities. Knowing what each one
represents, and why they are separate, makes the rest of the model easier to reason about.

### Resources

A **resource** is whatever Usher is protecting. The term is deliberately generic. Usher's core
model does not know or care what kind of thing it is protecting. Domain-specific names appear only
in the management UI layer. That layer is configured per instance.

**In the Overture context, a resource is a cohort.** This is a deliberate departure from the
"study" or "project" vocabulary used in other platforms. Those terms carry a silo implication:
data belongs to one study, and studies do not overlap. Cohorts are a different model.

**What "cohort" means here.** The word carries three common senses. They are not three separate
things: they often describe the same real-world situation from different angles. A single genomics
study produces all three at once:

| Sense                         | "The PEDS-2024 cohort" refers to                 |
| ----------------------------- | ------------------------------------------------ |
| Colloquial                    | The team of researchers who worked on that study |
| Clinical or epidemiological   | The 500 children enrolled and followed over time |
| **Data science (this sense)** | **Records where `study_id == "PEDS-2024"`**      |

The clinical and data science senses correspond closely: the enrolled children generated the
records that now form the data science cohort. Usher uses "cohort" in the data science sense
because it manages data records, not people or teams.

The two senses diverge precisely at the point of access control. In the clinical sense, access to
a cohort implies access to information about those people: the principals are the unit. In the data
science sense, access means the records matching the predicate are visible to you. If a record is
later re-categorized or withdrawn, the clinical cohort is unchanged. The data science cohort changes
automatically, because the predicate no longer matches. What those records represent is your
instance's concern, outside Usher's model.

A cohort in Usher is not a fixed list of enrolled principals. It is a named slice of your dataset.
Which records belong to it is determined by their own field values, not by a separate enrolment
step. So if a record is re-categorized, the cohort changes with it.

**What the first release supports, and what it does not.** Every record belongs to exactly one
resource. Enforcement works by filtering on a single field that names that resource, and the
instance says which field. Support for overlapping cohorts comes in a later release.

The difference matters if you are planning an instance:

|                                                                                                                 | Supported in the first release | Not yet |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- |
| One record, one resource, named by a field value                                                                | Yes                            |         |
| Records narrowed within a resource by the category they carry                                                   | Yes                            |         |
| A record satisfying two cohort predicates at once, such as `disease_type == "rare"` and `age_at_diagnosis < 18` |                                | Later   |
| A record carrying two categories at once, needing a grant for both                                              |                                | Later   |
| Narrowing to individual fields                                                                                  |                                | Later   |

One resource per record also settles a question that would otherwise be open. If a record could
belong to two cohorts and a user held only one of them, should they see it? There was a real choice
there between requiring all of a record's cohorts and requiring any one of them. The case cannot
arise in the first release, so the choice is deferred rather than made. It returns when overlapping
cohorts do.

Resources are the unit of scope for all other entities. Every grant is resource-scoped. Usher does
not think "a user can see record X". It thinks "a user holds a grant on category Z of resource Y,
and acts there in role R".

### Roles

A **role** is a coarse-grained permission label: `owner`, `viewer`, `curator`. It describes what kind
of actions a user can perform. Roles are defined at the platform level, and the exact set is an
instance decision.

A role is named on a grant, which is the only place one is held. Nothing records separately what a
person is trusted with, so the same person can be a curator on one category of a resource and a
viewer on another, and being trusted broadly somewhere confers nothing anywhere else.

Two things have to line up for a grant to reach anything, and they answer different questions. The
role sets the ceiling: the acts its holder could ever perform. The category decides which records
those acts reach.

| Grants held on a resource | What the principal reaches                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| None                      | Only what the baseline grants                                              |
| Some of its categories    | The records carrying those categories, at each grant's role, and no others |
| All of its categories     | Every record in the resource                                               |

A record carrying a category you hold no grant on stays out of reach whatever else you hold, and no
grant reaches further than its own role permits.

### Categories and category grants

A **category** is a named label marking a resource as needing an extra level of grant.
Examples: `indigenous_data`, `controlled_access`, `restricted_clinical`. One resource can carry
several.

A **category grant** is the entry saying a specific user is granted a specific category in a
specific resource. A viewer sees the records in that resource carrying that category. Where a record
carries several categories, the viewer needs a grant for every one of them, so missing one is enough
to see none of that record.

**A note on granularity, because it changes what you can express.** A category selects records
within a resource, so a resource holding a mix of sensitivities does not have to be split: a viewer
granted one of its categories reaches those records and not the rest. What the first release cannot
yet express is the line above, a single record carrying two categories and needing a grant for
both, which asks the query layer for a test it does not offer.

Narrowing below the record, to individual fields, comes later as well.

Categories and category grants are how the Controlled access tier (see Data access tiers below) is
implemented in practice.
The category names the protected dimension; the category grant says who is granted to see it.
Two users with the same role in the same resource can have meaningfully different views of the data
depending on their category grants.

### User groups

Administering access for a research team of 40 users as 40 individual grants would be error-prone
and slow. **User groups** exist to make administration tractable at scale.

Access is held by people. A person holds grants, and each one names a resource, a category within
it, and the role they act in there. Their effective access is the union of the grants they hold and
have accepted, each reaching the records of the category it names and permitting what its role
allows.

User groups, which would let one operation cover a whole team, are designed and not in the first
release.

Three relations carry this, and only two of them are about access:

| Entity            | What it means                                               |
| ----------------- | ----------------------------------------------------------- |
| `group_users`     | which users are in a group                                  |
| `grants`          | who acts in which role, on which category of which resource |
| `grant_decisions` | whether the recipient accepted, and what they were shown    |

A group confers nothing by belonging to it. What a group does is let one grant name a set of people
instead of one, so the same set can be trusted as a curator in one place and a viewer in another.
Each person the grant reaches accepts or declines it for themselves. If a grant is revoked, everyone
who reached data through it loses that access at once, and revocation propagates through the standard
channel.

Groups do not create a separate access model. They are a convenience layer over the same entity
structure individual users use.

### Privileged roles

Beyond the resource-level roles (`owner`, `viewer`), Usher defines two roles with broader scope.
Actions taken in these roles are always logged as auditable events.

**Custodian** holds grant-management rights over one or more categories, across all resources
in the platform. A Custodian can approve or revoke category grants for the categories they govern
without holding full Admin rights. This is the governance role for instances where a specific
community needs direct control over who accesses their data. A community representative is
designated as Custodian for their category. They then govern grants for it independently of
platform staff.

The role is in the design and not in the first release, because nothing appoints a custodian in it.

OCAP is the First Nations principles of Ownership, Control, Access and Possession, administered by
the First Nations Information Governance Centre. Those principles concern who holds authority over
data, not only who may read it, so this role is at most a mechanism for honouring them and never
evidence of having done so. Usher has not been studied against OCAP, and that study belongs with
the communities concerned rather than in a design document.

**Admin** holds platform-wide authorization management rights: creating resources, assigning
roles, managing any grant, and performing emergency revocations. An Admin does not have implicit
data access. To read a resource, an Admin must explicitly self-grant access, with a mandatory time
limit and a logged audit event. The full Admin model, covering bootstrap, self-grant flow, and
audit integrity design, is in
[admin-model.md](https://github.com/overture-stack/usher/blob/main/.dev/design/admin-model.md).

---

## Data access tiers

Not all data requires the same level of protection. Not all users require the same level of
verification before access is granted. A three-tier model expresses this cleanly. It is the
organizing principle for how Usher's permissions model is applied in practice.

**Open:** no authentication required. Data is publicly accessible to any user, including anonymous
requests. Aggregated statistics, counts without record-level detail, and published datasets with
no privacy risk fall into this tier. The bridge requests an anonymous Usher token from the
controller, with no IdP bearer needed. The controller returns a token containing only open-tier
grants. This keeps all access, including anonymous requests, audited and fail-secure.

**Registered:** the user must have a confirmed identity and must have accepted the platform's
terms of access. No further approval is required beyond that. This tier is appropriate when
accountability matters but a full approval process would be disproportionate. Examples: summarized
clinical data, or non-sensitive genomic aggregates where knowing who accessed the data is
sufficient protection.

In Usher terms: the user authenticates and Usher issues an Usher token. The open grant alone is
enough for a resource whose only category is its unrestricted portion.

**Controlled:** access requires an explicit, per-dataset grant. In simpler instances, an
Admin or Custodian grants access directly through the management UI. In larger or federated
instances, a Data Access Committee (DAC) reviews researcher applications. It approves or denies
access based on research purpose and institution. Approved grants can be mapped automatically via
GA4GH Passports, if configured.

In Usher terms: the records carrying that category are reached only by a grant naming it, held in
that resource. The resource's other records answer to their own categories, so the tier applies to
the records rather than to the resource as a whole. This is deny-by-default at the tier level.

| Tier       | Usher mechanism                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Open       | Anonymous Usher token issued (no IdP bearer needed); open-tier grants only                     |
| Registered | Usher token issued on authentication; the open grant reaches a resource's unrestricted records |
| Controlled | Reaching a categorized record requires a grant naming that category in the policy store        |

The category and category grant concepts in the permissions model exist specifically to
implement the Controlled tier. The Open and Registered tiers come out of that same model rather than
sitting beside it: a resource's unrestricted records are reachable by everyone holding a grant in it
(Registered), and by anyone at all in an instance whose baseline confers that category (Open).

The controller computes grants across all three tiers in a single additive pipeline. For how, see
[security-workflow.md: Permission computation pipeline](https://github.com/overture-stack/usher/blob/main/.dev/design/security-workflow.md#permission-computation-pipeline).

---

## GA4GH Passports and federated identity

This section covers an optional integration path. Some instances manage all grants internally,
through the management UI or a local approval workflow. They do not need Passport support. Passport
integration is relevant when researchers hold access approvals issued by institutions outside the
instance. Those approvals then need to be honoured automatically.

The scenario: a researcher at one institution holds a data access approval. It was issued by a data
access committee (DAC) at a different institution. Those two institutions do not share identity
infrastructure. Without a shared standard, each data holder must establish a direct trust
relationship with each approving institution. That does not scale.

GA4GH (Global Alliance for Genomics and Health) is an international standards body. Its
**Passport** specification defines a standard format for expressing access claims inside OIDC
tokens. Specifically, it defines a structured JWT claim (`ga4gh_passport_v1`) that any
OIDC-compliant identity system can carry. It is not a new protocol. It is a defined schema for
access grants inside tokens you already use.

### Visa types

A Passport contains one or more **Visas**: individual signed claim assertions. The types
relevant to Overture:

| Visa type                  | What it asserts                                                             |
| -------------------------- | --------------------------------------------------------------------------- |
| `ControlledAccessGrants`   | Researcher is granted dataset X, access type Y, until date Z                |
| `AcceptedTermsAndPolicies` | Researcher accepted data use agreement B                                    |
| `AffiliationAndRole`       | Researcher is affiliated with institution A in role R                       |
| `ResearcherStatus`         | Researcher holds bona fide researcher status, for example ELIXIR Researcher |

`ControlledAccessGrants` is the visa type that maps directly to Usher's Controlled access tier. A
DAC grant for a specific dataset is the external origin of a category grant.

### The three roles in a Passport ecosystem

Different parties in a Passport-enabled ecosystem play distinct roles:

| Role                | What it does                                                           | Examples                             |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| **Visa Issuer**     | Signs and issues individual Visa assertions after a grant event        | REMS, ELIXIR AAI, institutional DACs |
| **Passport Broker** | Aggregates Visas from multiple Issuers into a single Passport          | LifeScience Login, ELIXIR Login      |
| **Clearinghouse**   | Validates incoming Passports and maps approved claims to access grants | Usher, via Keycloak                  |

The examples above are real services you may meet in this space. REMS is the Resource Entitlement
Management System from CSC Finland, described further below. ELIXIR is Europe's life-science data
infrastructure, and ELIXIR AAI is its authentication and authorization service. GHGA, mentioned
later, is the German Human Genome-Phenome Archive. A DAC is a Data Access Committee: the group that
reviews and approves researcher applications.

Usher plays the Clearinghouse role. It does not validate Passport signatures itself: that belongs
to the identity layer, which validates each Visa's signature against the issuer's public JWKS
endpoint, checks the issuer against a configured trusted-issuers list, verifies expiry, and maps
validated claims to token attributes. Usher reads those attributes and maps them to
`grants` in its policy store. Which component performs that validation for a given
instance is an integration choice rather than a settled part of this design. The per-app PEP plugins see only
the Usher token. They do not know whether a grant came from an internal admin action or an
external Passport Visa.

### The flow

    Researcher obtains Visas from external DAC via REMS or similar
      -> Passport Broker (LifeScience Login / ELIXIR) bundles them into a Passport
      -> Researcher authenticates to Keycloak with their Passport
      -> Keycloak (GA4GH Passport extension):
           validates each Visa signature against issuer JWKS
           checks issuer against trusted-issuers list
           maps ControlledAccessGrants claims to Keycloak token attributes
      -> Usher reads Keycloak attributes, maps to grants
      -> Usher issues JWE Usher token
      -> PEP plugin enforces it as normal (unchanged)

### Visa expiry and revocation

Passport Visas carry their own `expires` timestamp, set by the Visa Issuer. When a Visa expires,
Usher treats this as a revocation trigger. The same `revoked_at` mechanism used for internal
revocations fires. The researcher's session is suspended during the fail-secure grace period.
Resuming it means re-authenticating with a refreshed Passport.

Local administrators can also revoke a grant that originated from an external Visa. Local policy
can always restrict access downward. It cannot grant access that no Visa covers.

### REMS: running your own Visa Issuer

An Overture instance may want its own controlled-access approval workflow. That means a DAC
reviewing applications and approving or denying them through a managed process. For that, REMS
(Resource Entitlement Management System, from CSC Finland) is the standard tool. REMS issues
`ControlledAccessGrants` Visas as output when a DAC approves a request, and integrates with
Keycloak. It is used in production by ELIXIR, GHGA, and other GA4GH-aligned platforms.

REMS is optional. An Overture instance can accept Passports from external Brokers without running
its own REMS instance. Accepting external grants and issuing internal grants are separable
permissions.

---

## JWTs: signed (JWS) vs encrypted (JWE)

A JWT (JSON Web Token) is a compact, self-contained token that encodes claims about a principal
(typically a user). There are two important variants with very different security properties.

### JWS: JSON Web Signature (signed JWT)

A JWS encodes claims as base64url and appends a cryptographic signature. The signature proves the
token was issued by a trusted party. It also proves the token has not been tampered with. But the
claims themselves are not secret. Anyone who intercepts or inspects the token can decode and read
them.

Analogy: a signed cheque. The account holder's signature proves it is genuine. But the amount,
payee, and account number are printed on the front. Anyone who handles it can see them.

A standard Keycloak access token is a JWS. You can paste it into [jwt.io](https://jwt.io) and
read every claim.

### JWE: JSON Web Encryption (encrypted JWT)

A JWE encrypts the claims. The payload is ciphertext, unreadable to anyone who does not hold
the decryption key. JWE is also tamper-evident: the encryption carries an authentication tag, so
any modification makes decryption fail rather than yield altered claims. That is not a signature.
A JWE proves the content is intact and came from someone holding the key. It does not prove who
that was. Adding that requires nesting a signed token inside the encrypted one, which Usher does
not currently do and does not need, because there is exactly one issuer.

Analogy: a sealed, tamper-evident envelope. Only the recipient with the right key can open and
read the contents. The seal proves it was not already opened and resealed.

Usher issues Usher tokens as JWE. The token never reaches a browser. It travels from Usher to the
ushered service that holds the bridge. The bridge decrypts it there.

**Why encrypt a token the user never sees?** Two reasons.

**Each application gets its own key.** An Usher token is issued for one application. Encrypting it
to that application's key means no other application can read it. If Usher ever computed a token
for the wrong recipient, that recipient would fail to decrypt it rather than quietly honour it. The
mistake becomes a visible error instead of a silent leak.

**Grant contents stay out of places they might otherwise land.** Logs, error reports, crash dumps
and tracing spans all collect whatever passes through them. An encrypted payload in any of those
reveals nothing.

---

## Usher token TTL

An Usher token's TTL is how long it is valid after issuance. After the TTL expires, the token is
rejected regardless of its content.

TTL is a security control, not a convenience feature. The threat it mitigates: a token can be
compromised, whether intercepted, stolen, or leaked. The attacker can then use it to impersonate
the user. A short TTL limits the window of exposure: a stolen token is useless after a few minutes.

The tradeoff runs the other way too. A shorter TTL means more re-issuance. More re-issuance means
more calls to Usher, and so more load and latency.

Usher combines a short TTL with local validation. The bridge validates and caches the token, so no
call to Usher happens on each request. That gives a short exposure window without per-request
overhead.

The designed lifetime is five minutes, and it is configurable. For comparison, the EGO access token
Usher replaces on the iMS platform lives three hours, so the window this closes is a large one.

---

## Revocation: the self-contained token problem

A self-contained token (one that can be validated locally without contacting the issuer) cannot be
"unissued". Once issued, it remains valid until its TTL expires, regardless of what happens in the
meantime.

Analogy: a paper concert ticket. Once printed, you cannot remotely invalidate it. If you need to
stop someone from entering, your only options are:

1. Wait for the ticket to expire naturally.
2. Check a blocklist at the door.
3. Use a signal that marks a class of tickets invalid, for example "all tickets printed before 3pm
   are invalid".

Usher uses approach (3), with the signal kept next to whatever changed rather than on the person.
The controller caches the payload it computed for each principal, and anything altering what that
principal holds deletes the entry, so absence means recompute. Separately, each resource carries a
category version, bumped by any change to the categories it lists and recorded alongside the cached
payload. On refresh the controller reissues from the cache only when the entry is still there and the
versions recorded with it still match. Both halves are the controller's own state, so nothing a
the request sends decides whether a cached answer is still fresh. Meanwhile the revocation signal reaches bridges by push (immediate, best
effort) and poll (configurable interval, reliable fallback).

A marker on the principal was the first design and does not work, which is worth knowing because it
is the obvious one. Adding a category to a resource changes nothing about that person's own records,
so a marker scoped to them never moves and their cached answer stays valid while the resource has
closed to them. The two markers above each sit next to the write that changes them, so no list of
writes has to be remembered.

A per-token blocklist (approach 2) is more precise. But it requires the issuer to track every token
ID ever issued, and plugins to check the blocklist on each request. That reintroduces the
per-request network call, at much greater cost than either marker.

---

## Fail-secure vs fail-open

A security system can meet an unexpected condition: a network failure, a timeout, an ambiguous
state. It must then choose: allow the request (fail-open) or deny it (fail-secure).

**Fail-open** prioritizes availability. If the authorization check fails, the request is allowed
through. Services remain available during outages. But a deliberate attack on the authorization
system, blocking the revocation channel for instance, allows unauthorized access to continue.

**Fail-secure** prioritizes safety. If the authorization check fails, the request is denied.
Legitimate users are affected by outages. But an attacker who blocks the authorization channel
gains nothing. They cannot keep a revoked session alive by disrupting the revocation mechanism.

Analogy: a fire door.

- Fail-secure: the door locks when power fails. People cannot exit freely, but unauthorized
  parties cannot enter. Prioritizes containment over egress.
- Fail-open: the door opens when power fails. People can exit, but so can unauthorized parties.
  Prioritizes egress over containment.

Usher's revocation channel is fail-secure. If the bridge cannot confirm revocation status within a
configurable grace period, it suspends active sessions until connectivity is restored. Suspended
sessions resume when Usher is reachable again, without requiring re-authentication. That differs
from an expired Passport Visa, which does require re-authenticating, because the two failures are
not the same: here the grants are still valid and only the channel confirming them is down, whereas
an expired Visa means the underlying grant itself has lapsed.

**Suspending rather than continuing to serve is the deliberate part**, and the reason is
adversarial: someone able to block the revocation channel could otherwise keep a compromised session
alive indefinitely.
That threat is more serious than the inconvenience of a brief service interruption for legitimate
users, so silence denies rather than preserves.

---

## Local vocabulary vs Usher model vocabulary

Usher's model uses generic terms throughout: resource, role, category grant. This is
deliberate. The same authorization model applies to any domain, whatever that domain calls the
things it protects.

In practice, every instance will have its own name for what Usher calls a "resource":

| Instance                  | What they call it | Usher model term |
| ------------------------- | ----------------- | ---------------- |
| iMS (iMicroSeq)           | study             | resource         |
| OHCRN                     | project           | resource         |
| A clinical trial registry | cohort            | resource         |
| A biobank                 | collection        | resource         |

These domain-specific names appear in:

- The management UI's labels (configured per instance)
- The plugin's field mapping config, which names the field identifying which records belong to a
  given resource
- User-facing documentation for that instance

They do not appear in Usher's API responses, entity schema, audit records, or internal logic.
Usher always uses "resource". Domain terms are a presentation layer concern.

**A worked example.** Suppose an instance calls its resources "studies". A study is the set of
records sharing a value in some field. A researcher is "in" a study if they hold a grant in the
corresponding Usher resource. If that instance's search plugin is configured with
`fieldName: "study_id"`, then a resource named `PEDS-2024` corresponds to records where
`study_id == "PEDS-2024"`. Usher never learns the field name. That mapping lives entirely in the
plugin config.

The field name is chosen per catalogue, meaning per body of data with its own store and schema,
not once per instance. A single
instance routinely uses different fields for different bodies of data, since data arriving
through different submission services exposes different identifiers. Treat the example above as illustrative, not as a default. An instance's actual field
mappings are recorded with that instance, not here.

This is why Usher's replacement of the studies management service introduces no "study" concept
into Usher's model. The studies management service used `STUDY-<id>` as a naming convention to
encode domain vocabulary in EGO group names. Usher does not replicate that. Resources have IDs and
names, and what those names mean is up to the instance.

---

## SONG's narrowed role

SONG is Overture's submission and file-management service. It tracks submitted genomic files, their
metadata, and the biological entities (donors, samples, specimens) they describe.

In Overture instances that include both Usher and SONG:

- **Usher** owns resource metadata: which resources exist, their names and descriptions, which
  categories they list, and who holds a grant on each of those categories, in which role.
- **SONG** owns file metadata: file checksums, donor/sample identifiers, file object paths, and
  the links between files and the biological entities they describe.

Prior to Usher, SONG's study records were the authoritative source of what resources existed.
The studies management service read SONG to discover studies, then created corresponding EGO
groups. Usher inverts this: Usher is the authoritative source. SONG file records reference Usher
resource IDs, not the other way around.

Instances without SONG are fully supported. Usher has no SONG dependency and does not call
SONG's API.

---

## Usher tokens

A standard authorization decision is binary: allowed or denied. A **Usher token** extends this. It
carries structured data describing the specific conditions under which access is allowed.

A binary decision says "this user may query the dataset". An Usher token says something more
specific: which datasets, which classes of data within them, and what may be done with each.

Here is one, for a researcher who reaches two studies:

```json
{
  "payloadVersion": 1,
  "sub":         "8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b",
  "iss":         "https://usher.example.org",
  "aud":         "arranger-prod",
  "iat":         1718611200,
  "exp":         1718611500,
  "generatedAt": 1718611200,

  "permissions": {
    "HEART_STUDY": { "open":       { "record": ["read", "update"] },
                     "controlled": { "record": ["read"] } },

    "LUNG_COHORT": { "open":       { "record": ["read"] } }
  }
}
```

Read out: in `HEART_STUDY` this user may read and update the open records, and may read the
controlled ones without changing them. In `LUNG_COHORT` they may view the open records and
nothing else. Every other resource on the platform is absent, and absence means no access rather
than a denial recorded somewhere.

`payloadVersion` is the one member not about this user at all. It names the schema the rest of the
token is written in, agreed between Usher and the plugin when the token was issued, so that a future
version can add something an older plugin would have to be told about rather than allowed to skip.

Three things about the shape are worth naming, because each is a decision rather than a detail.

**A resource's unrestricted portion is a category like any other.** `open` is named in a grant the
same way `controlled` is. Nothing is reachable because a grant declined to exclude it, so there is
no baseline sitting outside the category system for a reader to infer.

**Permissions attach to a category, not to the resource.** That is what lets this user update open
records while only reading controlled ones. Two independent grants, and holding both reaches what
either covers.

**Role and ownership both resolve before the token is written, which is why neither appears in it.**
A role is how access is granted rather than how it is enforced: the controller resolves a role to
permissions first, so a plugin tests permissions and never has to learn what an instance means by
"viewer". Ownership is a power over how access is managed, exercised against Usher itself, so
anything enforcing a query has its answer already.

There is also no empty list. Holding no grant on a resource means the same as the resource being
absent, so the token has one state to enforce rather than two that had to be told apart. For the
authoritative schema, written as the `PermissionsPayload` type the plugin receives, see
[security-workflow.md: The payload as a type](https://github.com/overture-stack/usher/blob/main/.dev/design/security-workflow.md#the-payload-as-a-type).

The app plugin (PEP) reads the permissions payload and applies it to the outgoing query, before the query
reaches the data layer. The payload is enforced server-side, not client-side. The client never
receives data it was not supposed to see. It cannot bypass the payload by modifying the query.

Usher tokens are the core mechanism by which Usher delegates enforcement to per-app plugins,
without requiring those plugins to understand the full policy model. The plugin does not need to
know why a user is excluded from certain data. It only needs to translate the permissions payload into
its app's native query format.

Each Usher token is scoped to a specific **audience**: the application service that requested it.
Usher includes only the resources that service manages, and of those only the ones this person holds
a grant in. That keeps the payload focused
and prevents one service from reading another service's grants. A platform running multiple data
applications issues a separate token for each. The user's effective access is the same across them,
but each service sees only its own slice. An application must verify that a presented token names it
as the intended audience before trusting its contents.

For Usher's own Usher tokens the check is stronger than that. Each application has its own
encryption key. A token issued for another application does not decrypt at all. It fails before any
claim is read. The audience claim is a second layer rather than the mechanism.
