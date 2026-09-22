# Glossary: Usher and Integration Terminology

Quick reference for terms used across Usher's design documents and client integration guides.
One or two sentences per entry. For deeper coverage, follow the links to the relevant document.

Grouped by theme; alphabetized within each group. Code font marks a literal field, column or table;
plain text marks the concept.

Which term to reach for when writing, and which have been retired, is a separate question with a
separate home: [terminology usage rules](../docs/atlas/roadmap/terminology-usage.md).

---

## Who is asking

Five terms name entities on the asking side of a decision. The relationships between them are the
point: they are not five names for one thing.

**Principal** _(a stance at request time, not a stored type)_
Whoever asks to use a capability.

Requests come in two kinds: to an ushered service for its records, and to Usher's own API to change
who may reach them. This is the default technical term throughout the design documents, and it
carries no assumption of humanity, which matters because a service is subject to exactly the same
decisions on exactly the same terms. Matches the term's use in AWS IAM, Kerberos and JAAS.

**Person** _(the lay term for principal, used deliberately)_
The same thing, in reader-facing prose. Onboarding and introductory documents say "person" because
it reads more naturally, and they say so explicitly rather than leaving a reader to discover that a
pipeline is also meant. Person and principal denote the same set: both cover users and clients.

**User** and **client** _(the two kinds of principal, following Keycloak's own split)_
A **user** is a human account. A **client** is an application or service acting on its own behalf.
Usher treats them identically, and neither is a synonym for principal: principal is the category,
these are its two members.

*Disambiguation:* [client](#client)

**Service account**
A non-human identity used by Overture services (for example Lyric) to perform system-level
operations in Usher, such as creating a resource at submission time. Authenticated via Keycloak
client credentials, not user sessions. See [admin-model.md](admin-model.md).

**Identity**
What the identity provider validates and asserts *about* a principal: the answer to who someone is,
where the principal is the actor asking. A principal has an identity.

**Subject**
The `sub` claim, and the Keycloak subject it names: the string by which one identity provider knows a
principal, recorded as `users.id` and used as the lookup key across groups, grants and audit
records. Because `users.id` holds the subject itself rather than an internal surrogate, it is
producible by every ushered application from the token it already holds, which is what lets
`actorId` on an audit event correlate across services.

*Disambiguation:* [subject](#subject)

---

## System architecture roles

**IdP (Identity Provider)**
The system that authenticates users and issues identity tokens. In Overture instances this is
Keycloak. Usher does not authenticate users; it relies on a validated IdP token to establish who
is making a request. See [concepts.md](../../docs/concepts.md).

**PAP (Policy Administration Point)**
The component where administrators manage policy: resources, the categories each lists, and the
grants over them. In Usher this is the management API and UI. See [admin-model.md](admin-model.md).

**PDP (Policy Decision Point)**
The component that evaluates policy and computes an access decision. In Usher this is the
permissions computation engine. External clients see only its output (the Usher token), never
the computation itself.

**PEP (Policy Enforcement Point)**
The component that intercepts requests and enforces the access decision at the point of data
access. In Overture, each application has its own PEP implemented as a plugin. The PEP does not
decide: it enforces what the PDP computed. See [plugin-integration.md](plugin-integration.md).

**PEP plugin**
An app-specific library built on `usher-bridge` that translates the permissions payload into the
app's native filter format. Examples: `usher-arranger` (permissions payload to SQON),
`usher-lyric` (permissions payload to Lyric query conditions).

**`usher-bridge`**
The shared library that implements the Usher protocol in applications: token exchange with
the controller, local caching, Usher token decryption and validation, revocation channel
maintenance, and fail-secure session suspension. All PEP plugins build on top of it. Named for
the drawbridge analogy: open when the controller connection is healthy, raised (returning 503)
when it is not.

---

## Tokens and claims

**Audience**
The target service for which an Usher token is issued, for example a specific Arranger
instance. A token is scoped to one audience; Usher includes only the resources managed by that
audience in the token, keeping the token focused and the plugin's job simple. Modelled on the
`aud` claim in OAuth 2.0 Token Exchange (RFC 8693).

**Usher token** _(permissions token)_
A JWE-encrypted token issued by Usher carrying a principal's permissions for one service. Cached by
the plugin for its TTL; decrypted and validated locally on each subsequent request without a
round-trip to Usher. See [security-workflow.md](security-workflow.md).

**`generatedAt`**
A claim embedded in every Usher token recording when Usher computed the permissions payload.
A reissue from cache deliberately does not change it, so it and `iat` come apart by exactly the span
a token has been served from cache. That makes it a diagnostic and an audit correlation rather than
an input to the fast-path refresh, whose two tests are both the controller's own state: the
principal's cached payload still being present, and the category versions recorded with it still
matching the resources' current ones.

**`PermissionsPayload`**
The decrypted contents of an Usher token, and the single definition the controller, the bridge and
the conformance fixtures all consume. Written member by member in
[security-workflow.md](security-workflow.md#the-payload-as-a-type). The bridge hands one to a plugin
after decryption, so "the payload" and "the decrypted token" name the same object.

**`payloadVersion`**
A claim naming the schema the rest of the payload is written in, agreed at the exchange from the set
of versions the bridge declared. A bridge never receives a version it did not list, so it reads this
to select a reader rather than to decide whether to tolerate the payload. Named for the payload
rather than as `schemaVersion`, because "schema" names Lectern's job in this ecosystem and a
`schemaVersion` inside an authorization payload reads as the version of the data's schema.

**`typ`, and its value `usher+jwt`**
A JOSE header parameter declaring what kind of JWT this is, against cross-JWT confusion (BCP 225
§3.11). Deliberately not `at+jwt`: an Usher token is not an OAuth access token, and claiming that
profile would be the confusion the parameter exists to prevent. See the RFC 9068 comparison in
[decisions.md](decisions.md).

**IdP token (bearer token)**
A JWT issued by the IdP identifying the authenticated user. Short-lived. Passed by the client
application to the PEP plugin, which presents it to Usher's token exchange endpoint.

**JWE (JSON Web Encryption)**
An encrypted JWT. Usher tokens use JWE so that the plugin can decrypt and validate them
locally, while preventing the end user from reading their own grants. Contrast with JWS
(signed but readable by anyone holding the token).

**JWT (JSON Web Token)**
The container format for both IdP tokens (signed JWS) and permissions payloads (encrypted JWE).
The two are structurally similar but serve different purposes and must not be confused.

**TTL (time-to-live)**
How long a cached Usher token is considered valid before the plugin must request a fresh one
from Usher's exchange endpoint.

---

## Policy model entities

**Meeting the model for the first time**, read these in order: capability, principal, group,
permission, role, grant, resource, category. Each is defined without reaching for anything later in
that list, which is why the data the model governs is met last: nothing before it needs it.

**Capability is read first and numbered zero, because it is the one term there that is not an
entity.** It belongs to whichever service offers it, so Usher holds a vocabulary of capabilities
rather than policy about them. The seven that follow are the model's primary entities, the ones
describing state: what exists, and who may reach it. An invitation is secondary, as an audit entry is. Both record process rather than state,
one a promise and the other a transition, and both are stored without being part of what the model is
made of. The test is whether removing it leaves the model able to say who may reach what: remove
invitations and it can, remove grants and it cannot.

Those eight open with a bare noun phrase, dropping the article, which marks them as the set a reader
works through in order. Every other entry keeps its article.

The entries below are alphabetical, because a glossary is looked up more often than it is read.

**A resource's permission list** _(the value against each resource in an Usher token)_
A list of the grants a principal holds on that resource, each naming one category and the
permissions it carries, such as `{ "controlled": { "record": ["read"] } }`. Only grants the principal holds
appear, so a category they lack is absent rather than named, revealing nothing about what exists.
The list never appears empty: holding no grant on a resource means what the resource being absent
already means, which is no access.

**Approval**
A decision reached before a grant and outside Usher: an ethics approval, an access committee's
determination, a review. Usher records the grant that follows one, with a clause saying where the
decision came from.

**Disambiguation note:** Reader-facing documents use "approval" more broadly, for the act that any
grant records, because "grant" doing duty as both noun and verb reads badly in lay prose. The
onboarding document states that substitution where it introduces the term, and names the federated
case as where the two senses separate.

**Auto-accept**
A configurable Usher flag that writes an accepting decision row at creation, so the recipient reaches
the grant without answering it. Off by default; the default flow requires an explicit answer from the
person the grant reaches. Enable for instances where explicit acceptance is not operationally
appropriate (machine-to-machine sharing, internal pipelines). See [permissions-model.md](permissions-model.md).

**Capability**
Possible action a service offers.

Written `entity.action` and displayed as the action alone. `record.read` and `record.export` are
things an ushered service can do with data; `grant.revoke` is something Usher's own admin API can do.
A capability belongs to whichever service offers it, so Usher ships a vocabulary of them as defaults
and an instance may add to it.

**The entity decides the plane, not the action.** `record.create` is data plane and
`resource.create` is control plane, and both are "create". The baseline vocabulary and the reasoning
behind each entry are in [permissions-model.md](permissions-model.md).

**Entity**
What a capability acts on: the first segment of its name.

`record`, `field`, `revision` and `artifact` are data-plane entities, held by the ushered
application; the first release builds `record` and `artifact`, and the other two arrive by migration.
`resource`,
`category`, `grant`, `group`, `role`, `ownership`, `invitation` and `custodianship` are control-plane
ones, held by Usher. Each sits wholly in one plane, which is what lets `plane` live here rather than
on each capability.

*Disambiguation:* this is the entity of `entity.action`, and the schema's own tables are also called
entities. The two coincide often and not always: `grant` is both, `record` is a capability entity and
never a table, and `users` is a table with no capability entity of its own.

**Permission**
Capability a principal or a group may use.

The limits are what make it a permission rather than the capability itself: who may use it, on which
records, and until when. A capability is unbounded, since the service can simply do it; a permission
is that same action bounded on every side. The permissions in one grant share their limits, which is
why the store keeps the limits on the grant rather than repeating them per permission.

This is what the policy is made of and what an Usher token carries, and the capability a permission
names belongs to the service that will be asked to act.

A permission is in effect only while the grant carrying it is live: accepted where acceptance is
required, unexpired, and not revoked. So a grant can exist while the permission it would give does
not. "Uncertainty is not permission" uses the word in its ordinary English sense, being allowed,
which needs no reservation.

One vocabulary, reached two ways. A **role** bundles permissions and is how access is authored; a
**grant entry** names the ones held on one category and is how access is enforced. The controller
resolves the first into the second at issuance, which is why no role name reaches a plugin.

**Which permissions each role carries is an open design item**, so the resolution above describes a
mechanism with nothing behind it today: roles are currently names carrying no verbs, and a grant's
`permissions` column is the only place one is so far recorded. See
[RABAC alignment](../docs/atlas/roadmap/rabac-alignment.md).

**Catalogue**
One schema, and so the scope within which a field name resolves. A resource field name is configured per
catalogue, since a field name is only meaningful inside one schema: a filter built for one catalogue
names fields another lacks, and the mismatch presents as data loss rather than as an authorization
error.

A catalogue is a configured view rather than a store. Two catalogues can be configured over one
index, and an index can be an alias spanning several, so a dedicated backing store is the common case
rather than a guarantee.

**Bare and qualified.** Bare, the word means the unit above, and every document here uses it that
way. **Arranger catalogue** means the container Arranger keys by `catalogueId`, which can hold more
than one of them: Arranger composes additional queryable types into one `catalogueId`, and such a
type is backed by an unrelated index while inheriting that Arranger catalogue's resource field name.
Where a document counts catalogues in an application's own configuration, it is counting those.

**Disambiguation note:** A catalogue's unit is the schema a field name resolves in, and governance
runs per resource. One catalogue's records belong to many resources, since a resource is a value in a
field on a record rather than a container.

**Category grant**
An explicit, logged record allowing a specific user to reach a specific category within a
specific resource, with the permissions the grant carries. Grants are additive: each renders a
positive predicate, and content no grant selects is simply never reached rather than excluded by a
rule. A category is carried by a record, so a grant reaches the records carrying it rather than the
resource holding them. What is deferred is a record carrying more than one category at once. See
[permissions-model.md](permissions-model.md).

**Cohort** _(data science sense: applied to data, not people)_
A named partition of data records sharing one or more defining characteristics, identified by a
field value or filter expression. Usher uses "cohort" exclusively in this data science sense.

The word carries three senses, and they often describe the same real-world situation from different
angles rather than naming three different things. A single genomics study produces all three at
once:

| Sense | "The PEDS-2024 cohort" refers to |
|---|---|
| Colloquial | The team of researchers who worked on that study |
| Clinical or epidemiological | The 500 children enrolled and followed over time |
| **Data science (this sense)** | **Records where `study_id == "PEDS-2024"`** |

The clinical and data science senses correspond closely: the enrolled children generated the
records that now form the data science cohort. But the lenses diverge at the point of access
control. In the clinical sense, access to the cohort means access to information about those
children. In the data science sense, access means the records matching the predicate are visible
to you. If a record is later re-categorized or withdrawn, the clinical cohort is unchanged; the
data science cohort changes automatically because the predicate no longer matches.

Usher manages data records, not people or teams. What those records represent is an instance
concern, outside the model. See [concepts.md](../../docs/concepts.md) for the extended discussion
and access composition implications.

**Category**
Collection of records, defined by properties they carry.

Usher names the categories for its own instance and holds nothing else about them: which properties define one, and so which records fall
inside it, is settled per schema, because a property only means something inside one schema.
Reaching a segment requires a grant naming that category in that resource. See
[permissions-model.md](permissions-model.md).

**A category name means the same thing across every resource**, which is what makes it grantable and
governable: one custodian governs one category wherever it appears, and a grant on it would otherwise
mean something different in each study. The properties placing a record in a segment are carried by
the record, so a grant reaches the segment rather than the resource holding it. Where an instance's
data carries nothing distinguishing one segment from another inside a resource, that resource has one
segment and a grant reaches all of it, which is the same rule producing a coarser result rather than
a different rule.

**Instance**
One configured Usher: its policy store, the categories defined in it, the resources registered in
it, and the applications it serves. What differs between instances is configuration rather than
code, such as which categories exist and what the baseline grants. Narrower units own
configuration of their own: a resource field name belongs to a catalogue and an Usher token to an
application.

*Disambiguation:* [instance](#instance-bare-and-qualified)

**Entity, relationship, associative entity** _(how the schema is described)_
An **entity** is a thing with its own identity: a user, a group, a resource, a category. A
**relationship** is an association between entities and has no identity of its own: `group_users`
says which users are in a group, `resource_categories` says which kinds of data a resource contains.
An **associative entity** is a relationship that carries attributes and a lifecycle of its own, which
is what a grant is: it cannot exist without the user, resource and category it connects, and it also
has a period, a state and a granter.

*Disambiguation:* [relation](#relation)

**Grant** _(the action, and the record it leaves)_
Action of assigning permissions to a principal or a group.

Nothing is permitted except by a grant, so the record one leaves is what answers why someone may do
something. That record is what the store keeps and what an Usher token is written from: who assigned,
when it takes effect, when it ends, and whether it has been accepted. The permissions in a grant were decided together, so they are accepted, expire and are
revoked together.

The unit the whole policy is built from. It also carries a period and a state saying where in that
period it sits, and, on its governance side, who granted it and when. As a verb, one word covers the
act: X grants permissions to Y in Z, and the record of that act is the grant.

**Group**
Collection of principals.

A grant can name a group in its holder column the way it names a principal, and every member of that
group reaches what the grant names, at the role the grant names: a principal's effective access is
the grants held by them directly plus those held by every group they belong to. A group never makes
a request, so a grant can be recorded against it while it never asks for anything. It carries no
role of its own, and confers nothing by membership alone.

**Not yet designed:** who manages groups, and whether a group's users are synced from the identity
provider. See [permissions-model.md](permissions-model.md) § User groups design.

*Disambiguation:* [group](#group)

**Invariant**
A rule that must always be true, enforced by blocking whatever would make it false rather than by
checking afterwards. "Every resource has at least one owner" is kept by refusing to remove the last
one until ownership has been transferred, so the refusal and the rule are the same thing seen from
two sides.

Two kinds appear here and are enforced differently. A **data invariant** constrains what can be true
of stored data, such as every resource carrying at least one category, and is kept by blocking
writes. A **behavioural invariant** constrains how the system responds, such as a refusal never
confirming that data exists, and is kept by never writing the code that would break it.

**Invitation** _(an access invitation, where the context does not say what for)_
A promise of grants to an email address that has no account yet. It carries the address, the grants it
will create, and its own expiry, and it is not itself a grant: either the person registers and the
grants are created, or the invitation lapses unused. Where the person already has an account, no
invitation is needed and the grant is created directly, with a start date if it is not to begin
immediately.

**Authorization**
Holding permission, which a grant creates and which stands whether or not anyone acts on it.
Distinct from access, which is reaching data at request time: an **access decision** resolves what a
principal may reach on this request, and enforcement carries that out. Being authorized is the
standing state; access is the result, and one does not follow from the other until a request is made.

**Artifact**
Something a person assembled from records and kept, carrying provenance that names the resources it
drew on.

Its own entity on the data plane, because reaching an artifact is not reaching its records: every
read of one is checked against the reader's own grants, which is why handing someone an artifact
confers nothing and no capability governs doing so. A saved set is the first kind of one.

**Field**
One part of a record, and an entity on the data plane in its own right.

A category scopes fields the way another scopes records, so `field.read` reaches the columns a field
category covers while `record.read` reaches whole records. It carries no `create` or `delete`, since
a field exists per schema rather than per grant, and `field.aggregate` is separate from `field.read`
because a column can be withheld from a result and still be countable through a facet. Post-MVP.

**Record**
One row of data in a catalogue, which is what access is ultimately about. Records live in the
applications Usher serves; Usher's own store holds grants.

**Revision**
A prior state of a record, where the service keeps them, and an entity on the data plane.

A submission service has revisions and a search index does not, so a search token never carries
`revision.*`. It carries `read` and `export` only: a revision is produced by updating a record rather
than authored, and prior states are immutable. Deleting one is erasure, which meets the append-only
audit trail and is unresolved. Post-MVP.

**Resource**
Collection of records, defined by an identifier they share.

Usher's generic, model-agnostic unit: it makes no assumption about what the data is, where it is
stored, or what schema it follows.

In Overture the concrete term is cohort. Instances may expose this concept under domain-specific
names in their management UI: iMS calls it a study; other instances may
use project, dataset, or program. Those names are instance vocabulary; Usher's internal model
uses "resource" throughout. See "Local vocabulary" in [concepts.md](../../docs/concepts.md).

**Role**
Collection of permissions.

`viewer`, `submitter` and `owner` appear throughout these documents as examples, in the same way capability names
do: which roles exist is an instance's governance decision, not something Usher ships as a closed
set. A role is named on a grant, which is the only place one is held: the grant says that this
holder, on this category of this resource, acts in this role. Nothing states separately what a
person is trusted with, so the same person can be a curator on one category and a viewer on another.
Where the holder is a group, the role is still the grant's, and every member of that group reaches
the records that grant names, at that role.

A role is how access is authored rather than how it is enforced, so the controller resolves it to the
permissions it carries before writing an Usher token and no role name reaches a plugin.

**A grant's permissions are held per category** rather than across a resource, which is what lets
one grant permit changing records while another permits only reading them. A role's permissions work the other
way, applying across the whole resource as a ceiling: the acts it permits there. A
grant then names which categories, and how much of that ceiling applies to each. What stays open is
whether a grant may carry a permission the role's ceiling does not, which decides whether the ceiling
binds or only advises.

*Disambiguation:* [role](#role)

**Saved set**
A stored list of record identifiers drawn from one catalogue, and belonging to it: an identifier
means nothing, or means something else, against another catalogue. The identifiers are a snapshot of
what the creator could reach when the set was saved, so resolving one re-applies enforcement over the
stored list. See the Arranger integration's own record for the current state of this.

**Submitter** _(a role, and separately a record of who uploaded)_
Someone who may write to a resource.

Named on a grant like any role, so a person may submit to one study and not another, and a group
named "submitters" is the ordinary way an instance arranges it.

Usher also records, immutably, who uploaded each piece of data, and that record is provenance rather
than a role. It never changes, it outlives the role being revoked, and someone may hold the role
having uploaded nothing. The tell is the article: **the** submitter is one fixed person, and **a**
submitter is whoever currently holds the role.

---

## Who governs access

**Dataset** _(the lay term for resource, used deliberately)_
The same thing, in reader-facing prose. The onboarding document says "dataset" throughout for the
unit a grant names, because "resource" is a word a general reader has to be taught before the
sentence carrying it can land.

**Where the simplification has an edge, stated so it is disclosed rather than discovered.** A reader
hearing "dataset" pictures a container holding records. A resource is not a container: it is a value
in a field on a record, so one catalogue holds records belonging to many resources and a record is
not moved into or out of anything. Nothing in the onboarding depends on the difference, and any
sentence that did would have to say "resource" instead.

Design documents say **resource**. Where an instance's own word is being listed rather than used,
"dataset" sits alongside study, project and programme as instance vocabulary, which is a separate
thing from this entry: that is what one deployment calls its resources, and this is which word a
document reaches for given its readers.

*Disambiguation:* W3C DCAT defines `dcat:Dataset` as a collection of data published or curated by a
single agent. A resource satisfies that and so does a catalogue, so the standard cannot be cited to
settle which of them "dataset" means. See "Where DCAT defines a word Usher uses" in
[decisions.md](decisions.md).

**Custodian**
A user with grant-management rights over one or more categories across all resources, without
holding full admin rights. Required for OCAP-compliant instances where community-level
data sovereignty must be delegated to community representatives rather than held by platform staff.
Called a custodian rather than a steward because the business requirements already use
"Data Steward" for the resource owner.
See [permissions-model.md](permissions-model.md).

**Owner**
A user designated with management rights over a specific resource: granting and revoking access,
setting visibility policy, and transferring ownership. Owner is the control-plane role and carries no
data access at all; reading the resource's records takes a grant naming a data-plane role, which the
same person may hold separately. Distinct from the submitter role, though a single person can hold
both.

**Viewer**
The base data-plane role: read on the records its grant reaches, and no authority over anyone else's
access. Every other data-plane role is defined against it.

**Curator**
The data-plane role carrying create, read, update and delete on the records its grant reaches.

*It sits beside Owner rather than under it, and the pairing is the clearest statement of the two
planes.* Both carry the same four acts and they act on different objects: a curator creates, updates
and deletes **records**, an owner creates, updates and deletes **access** to one resource. Neither is
a rung above the other, and no role is a point on a scale running from viewer to owner. A person can
hold one, the other, both, or each on a different category of the same resource.

**Admin (PAP admin)**
A user identified by an OIDC token claim (`usher_roles: platform_admin`) who can manage all
grants platform-wide. Does not have implicit data access; must explicitly self-grant access to any
resource they want to read, with a mandatory TTL and a logged audit event. See
[admin-model.md](admin-model.md).


---

**Grant rate**
How many grant operations one actor performs within a set period, measured as a count over a rolling
window rather than as a running total. Compared against `grantRateThreshold`, and reported by the
`grant.rateExceeded` event when it is above it. See [audit-events.md](audit-events.md).

**Rolling window**
A period measured backwards from now rather than reset on a clock boundary. Ten operations spanning
midnight fall in one rolling hour, where two fixed hours would split them into six and four.

## Integration concepts

**Complement**
The resources a principal lacks, from among those this instance is configured for. A plugin
computes it at startup, from its own configuration minus the resources the token names, and tests a
derived artifact against it: an artifact survives exactly when it requires none of them. Local rather
than platform-wide, which is what keeps Usher from having to name resources a principal does not
hold. See [decisions.md](decisions.md) § A self-scoping predicate is not an access decision.

**Fail-secure**
The design principle that uncertainty about authorization state defaults to denial of access rather
than continuation of service. Applied at multiple points: revocation channel disruption, token
decryption failure, and a resource absent from the Usher token all produce denial, not access.

**Field, field name, value**
A **field** is the whole key-and-value unit a record carries. Its **field name** is the key, and its
**value** is what that record holds there. A filter names a field by its field name and tests its
value, which is why plugin configuration stores names: a name is what identifies the same field
across every record.

**A variable is named for what it holds, and its type supports that name rather than supplying it.**
A string holding a key is a `fieldName`; an object holding the pair is a `field`. Reading the type to
work out which one is meant is the situation this split exists to remove. So the resource field name
is a name, the resource name is a value, and the resource field is the pair on one record.

**Filter, predicate, clause** _(three levels of one thing)_
A **clause** is one syntactic node: `{op: 'in', content: {fieldName, value}}`. A **predicate** is the
condition that clause expresses, the thing true or false of a given record. A **filter** is the whole
object attached to a query, which may be one clause or many composed with `and` or `or`.

**They coincide only where a principal holds exactly one grant**, which is why they blur in examples.
The emitted filter is then a single clause expressing one predicate and all three name the same
object. They come apart at the second grant: the filter becomes a union of clauses, each expressing
its own predicate, and each clause is itself a conjunction of a resource test and a category test.

**Grace period**
The configurable window after the revocation channel goes silent before the plugin enters
revocation-uncertain mode. Exists to tolerate brief network interruptions without immediately
suspending all user sessions.

**Open access**
A data tier in which records require no authentication. The controller issues an anonymous grants
token (no IdP bearer required); bridge and plugin handle it identically to an authenticated token.
See [security-workflow.md § Permission computation pipeline](security-workflow.md#permission-computation-pipeline).

**Revocation**
The invalidation of a user's access, recorded as a `revoked_at` timestamp in Usher's database.
Applies to all Usher tokens the plugin holds for that user regardless of their individual
TTLs. See [security-workflow.md](security-workflow.md).

**Revocation channel**
The mechanism by which Usher notifies plugins of revocations near-real-time. Two sub-channels:
push (SSE or WebSocket subscription) and poll (`GET /revocations?since=<timestamp>` fallback).
Plugins maintain both; the poll channel recovers from push channel interruptions.

**Revocation-uncertain mode**
The state a plugin enters when its revocation channel has been silent for longer than the grace
period. Sessions are suspended and requests return 503 until the channel reconnects, except for the
open tier, which needs no grant and so has nothing a revocation could withdraw. This is
the fail-secure default: uncertainty about revocation status produces denial, not access.

**EGO**
Overture's previous authorization service (managing users, groups, and policies). Usher is
EGO's full replacement, not an integration: instances that adopt Usher retire EGO and the
studies management service that orchestrated EGO. Existing EGO group data migrates to Usher
resources and who belonged to them; see [architecture.md](architecture.md).

**Server-side filter** _(Arranger-specific)_
A SQON filter injected into every Arranger query by the plugin before the query reaches the search
engine. This is where enforcement happens in Arranger. The filter is built additively: each grant the
token carries renders one positive predicate, and those compose with `or`, so a record no predicate
selects is simply never returned. Nothing is subtracted and no exclusion is computed. Under MVP the
whole filter is a single clause naming the resources the principal may reach.

**SQON (Structured Query Object Notation)** _(Arranger-specific)_
Arranger's filter expression format, and the wire format the bridge emits. The bridge builds the
predicate and `usher-arranger` compiles it into the query Arranger runs, supplying the field name for
the catalogue being queried, since which field names a resource differs between catalogues.

**Token exchange**
The call a PEP plugin makes to Usher presenting an IdP bearer token and receiving a scoped
Usher token in return. The `audience` parameter identifies the calling service; Usher
returns a token containing only the resources that service manages. Modelled on OAuth 2.0 Token
Exchange (RFC 8693). See [plugin-integration.md](plugin-integration.md).

---

## Terms borrowed from other systems

A term that arrives from another system keeps that system's meaning there and does not automatically
carry it here. Where the two differ, the difference is the thing worth knowing, so this table says
what each maps to rather than assuming the reader will infer it. "Nothing" is a real answer: some
borrowed terms have no Usher counterpart at all.

This table is the index. A term whose collision needs more than a row is expanded under
[Disambiguations](#disambiguations) below, and linked from wherever it is defined.

| Term | Comes from | Means there | In Usher |
|---|---|---|---|
| `sub`, subject | OIDC, Keycloak | the identifier of the authenticated account | the identifier **of** a principal, not the principal itself. Stored as `users.id` |
| user | Keycloak | a human account in a realm | a human principal. One of the two kinds |
| client | Keycloak | an application authenticating as itself | a machine principal. The other kind |
| group | Keycloak | a collection of users in a realm | a separate entity. A Keycloak group may be mapped onto an Usher group; the two stay distinct |
| role | Keycloak | a realm or client role, held in the IdP | a separate entity. Usher's roles (`viewer`, `owner`) are named on `grants` rows in Usher's own store, and Keycloak's are coarse assignments it keeps for itself |
| scope | OAuth 2.0 | a string limiting what a token permits | **nothing.** What a grant permits is carried as permissions per category |
| authorization server | OAuth 2.0 | the component that authenticates a person and issues them an access token | **Keycloak.** Usher's controller decides what an already-authenticated principal may reach, and issues tokens to applications |
| audience, `aud` | OAuth 2.0 Token Exchange | the service a token is issued for | the same, unchanged |
| subject, resource, action | XACML | three of the four request categories | subject becomes principal; resource is unchanged; action becomes permission |
| PDP, PAP, PEP | XACML | decision, administration and enforcement points | the same, and used as-is |
| group, policy | EGO | study groups, and access policies attached to them | retired. An EGO group maps to a resource, an EGO policy to the grants on it |
| Visa, Passport | GA4GH | signed claims about a researcher | a `ControlledAccessGrants` Visa maps to a category grant. The other three Visa types are unmapped so far |
| dataset | GA4GH | the unit a Visa is scoped to | resource |
| catalogue | Arranger | one index configuration, keyed by `catalogueId` | coarser than a catalogue, and one Arranger catalogue can hold more than one. Always written qualified here, per the Catalogue entry |
| `documentType` | Arranger | the GraphQL root field name | **nothing.** Several Arranger catalogues can share one, as the first instance's development search server shows: five of them, four `records` |
| index, mapping | Elasticsearch, OpenSearch | storage and its field types | **nothing directly.** A catalogue's backing store, which Usher treats as opaque |
| cohort | Overture | a collection of records sharing defining characteristics | **resource.** Usher's generic term; cohort is what Overture calls one, in the data science sense the Cohort entry sets out |
| study | iMS | the top-level collection of the data lake | resource |
| dataset | iMS | used loosely at several levels below a study | no fixed mapping; the term sits at several levels, and which one is meant is local to the document using it |
| Data Steward | iMS flows | owns datasets, shares them, adds other stewards | **owner.** Usher's custodian is a separate role, holding authority over one category across all resources |
| Data Admin | iMS flows | the platform administration persona | **administrator**, meaning system administrator rather than a data-plane role |
| constraint token | iMS flows | the object carrying an access decision | Usher token |

---

## Related Overture services

**SONG**
Overture's genomic file metadata service. SONG's scope in Usher-adopting instances is narrowed
to file-level manifest data: file checksums, donor/sample links, and file object identifiers.
Resource metadata (category assignments, ownership, grants,
and embargo state)
is Usher's responsibility. Instances that do not include SONG are unaffected; Usher does not
depend on SONG.

**Studies management service** _(iMS-specific; retiring)_
A stateless orchestration layer that maps SONG studies to EGO groups and policies. Its role is
absorbed by Usher: resource creation, writing grants, and category assignment are all
Usher admin API operations. The studies management service is retired once EGO is replaced.

---

## Disambiguations

Terms that mean different things in different places. An entry above points here rather than
carrying the explanation itself, so a definition stays a definition. A term earns a place here when
reading it with the wrong meaning produces an understanding that is plausible and wrong, rather than
merely unfamiliar.

### Instance, bare and qualified

**Bare, an instance is one configured Usher**: its policy store, its categories, and the applications
it serves. What differs between instances is configuration rather than code, which is why roles are
defined per instance's configuration rather than by Usher itself. In Usher's own documents this is
the default reading and needs no qualifier.

**Qualified, it names a running process.** A controller instance can go down and take its connected
bridges' push connections with it, which a configured Usher cannot do, not being a process. So a
sentence about a process names the component it is an instance of.

**A bridge needs no qualifier either way.** There is one per application process already, so "each
bridge" and "per bridge" say what "bridge instance" was reaching for.

### Atomic

**In transactions and databases**, an operation is atomic when it either completes entirely or does
not happen at all, with no intermediate state observable. `permissions-model.md` defines it this way
under Atomicity, and that is the sense Usher uses.

**In everyday use**, atomic means indivisible, which is a different claim: that a thing has no parts
rather than that an operation has no halves. `decisions.md` once used it this way of a resource, and
that use has been replaced with the plain phrase, "a resource cannot be divided".

**Here:** atomic describes an operation, never a thing.

### Client

**In Keycloak**, a client is an application authenticating as itself. A client using the
client-credentials grant is materialized as a *service account user*, so it arrives carrying a
user-shaped identity.

**Here:** a client is a machine principal, one of the two kinds. Keycloak's shape is why `users.id`
covers both kinds without a second table, and why a machine principal can look like a human one on
the wire without being treated differently.

### Group

**In Keycloak**, a group is a collection of users in a realm, managed in the identity provider.

**Here:** a group is a separate entity in Usher's own store, and it holds access rather than merely
collecting people. A Keycloak group may be mapped onto an Usher group, and the two remain distinct
entities either way. Who owns that mapping is an open design question, and it decides whether an
Usher administrator can create a group at all.

### Relation

**In the relational model** (Codd, and SQL theory) a relation **is a table**: a set of tuples over a
set of attributes. Every table in the entity schema is a relation by this definition, `users`
included. "Relational database" is named for this, and not for the connections between tables, which
is one of the most commonly mistaken terms in the field.

**In entity-relationship modelling** (Chen) the association between entities is a **relationship**,
and one carrying its own attributes is an **associative entity**. "Relation" is not an ER term at
all.

**Here:** the schema is described in ER terms, so an association is a relationship. Avoid "relation",
which a reader arriving from SQL will take to mean a table, and which is therefore wrong in a way
that reads as correct.

### Role

**In Keycloak**, a realm or client role held in the identity provider. These are coarse assignments
Keycloak keeps for itself, and Usher reads exactly one of them: the claim that marks a platform
administrator.

**Here:** a role is named on a `grants` row, `viewer` or `owner`, living in Usher's own store. The
controller resolves it to permissions before writing an Usher token, so no role name ever reaches a
plugin. The two are unrelated beyond sharing a word.

### Subject

**In OIDC and Keycloak**, the `sub` claim: the string by which one identity provider knows an
account. This is the meaning Usher reserves the word for, stored as `users.id`.

**In XACML**, the subject is the *actor* making a request, which is what Usher calls a principal.
A reader arriving from XACML will take "subject" to mean the asker rather than one of its
identifiers, and the two come apart the moment a second identity provider exists: the same person
authenticating through Keycloak and through Microsoft Entra ID is one principal with two subjects.

**In CloudEvents**, `subject` is an optional attribute naming the specific thing within a source that
an event concerns. Usher does not currently use it. If it ever does, it is the event vocabulary's
word and not this one, since the event model does not inherit the policy model's terms.

**Here:** subject means the `sub` claim and nothing else. Where the actor is meant, the word is
principal.
