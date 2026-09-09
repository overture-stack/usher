# Glossary: Usher and Integration Terminology

Quick reference for terms used across Usher's design documents and client integration guides.
One or two sentences per entry. For deeper coverage, follow the links to the relevant document.

Grouped by theme; alphabetized within each group.

---

## System architecture roles

**IdP (Identity Provider)**
The system that authenticates users and issues identity tokens. In Overture deployments this is
Keycloak. Usher does not authenticate users; it relies on a validated IdP token to establish who
is making a request. See [concepts.md](../../docs/concepts.md).

**PAP (Policy Administration Point)**
The component where administrators manage policies: grants, memberships, roles, and data
categories. In Usher this is the management API and UI. See [admin-model.md](admin-model.md).

**PDP (Policy Decision Point)**
The component that evaluates policy and computes an access decision. In Usher this is the
grants computation engine. External clients see only its output (the grants token), never
the computation itself.

**PEP (Policy Enforcement Point)**
The component that intercepts requests and enforces the access decision at the point of data
access. In Overture, each application has its own PEP implemented as a plugin. The PEP does not
decide: it enforces what the PDP computed. See [plugin-integration.md](plugin-integration.md).

**PEP plugin**
An app-specific library built on `usher-bridge` that translates the grants payload into the
app's native filter format. Examples: `usher-arranger` (grants payload to SQON),
`usher-lyric` (grants payload to Lyric query conditions).

**`usher-bridge`**
The shared library that implements the Usher protocol in client apps: token exchange with
the controller, local caching, grants token decryption and validation, revocation channel
maintenance, and fail-secure session suspension. All PEP plugins build on top of it. Named for
the drawbridge analogy: open when the controller connection is healthy, raised (returning 503)
when it is not.

---

## Tokens and claims

**Audience**
The target service for which a grants token is issued, for example a specific Arranger
instance. A token is scoped to one audience; Usher includes only the resources managed by that
audience in the token, keeping the token focused and the plugin's job simple. Modelled on the
`aud` claim in OAuth 2.0 Token Exchange (RFC 8693).

**Grants token**
A JWE-encrypted token issued by Usher containing the user's access grants for a specific
service. Cached by the plugin for its TTL; decrypted and validated locally on each subsequent
request without a round-trip to Usher. See [security-workflow.md](security-workflow.md).

**`generatedAt`**
A claim embedded in every grants token recording when Usher computed the grants payload.
Used for the fast-path refresh: if no policy changed since `generatedAt`, Usher can reissue
without a full recomputation.

**IdP token (bearer token)**
A JWT issued by the IdP identifying the authenticated user. Short-lived. Passed by the client
application to the PEP plugin, which presents it to Usher's token exchange endpoint.

**JWE (JSON Web Encryption)**
An encrypted JWT. Grants tokens use JWE so that the plugin can decrypt and validate them
locally, while preventing the end user from reading their own grants. Contrast with JWS
(signed but readable by anyone holding the token).

**JWT (JSON Web Token)**
The container format for both IdP tokens (signed JWS) and grants payloads (encrypted JWE).
The two are structurally similar but serve different purposes and must not be confused.

**TTL (time-to-live)**
How long a cached grants token is considered valid before the plugin must request a fresh one
from Usher's exchange endpoint.

---

## Policy model entities

**Catalogue** _(Arranger-specific, used in design examples)_
A single Arranger index configuration, backed by one ES/OS index. One catalogue holds records
belonging to many Usher resources. The plugin config names the field whose value identifies which
resource a record belongs to, per catalogue.

**Auto-accept**
A configurable Usher flag that makes category grants active immediately on creation, skipping the
awaiting-acceptance state. Off by default; the default flow requires an explicit acknowledgment
from the grantee. Enable for deployments where explicit acceptance is not operationally
appropriate (machine-to-machine sharing, internal pipelines). See [permissions-model.md](permissions-model.md).

**Category grant**
An explicit, logged record allowing a specific user to reach a specific data category within a
specific resource, with the capabilities the grant confers. Grants are additive: each renders a
positive predicate, and content no grant selects is simply never reached rather than excluded by a
rule. Under MVP a category is carried by a whole resource; per-record categories are post-MVP. See
[permissions-model.md](permissions-model.md).

**Cohort** _(data science sense: applied to data, not people)_
A named partition of data records sharing one or more defining characteristics, identified by a
field value or filter expression. Usher uses "cohort" exclusively in this data science sense.

The word carries three senses, and they are not separate things: they often describe the same
real-world situation from different angles. A single genomics study produces all three at once:

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

Usher manages data records, not people or teams. What those records represent is a deployment
concern, outside the model. See [concepts.md](../../docs/concepts.md) for the extended discussion
and access composition implications.

**Data category**
A named access dimension that applies to a subset of records or fields within a resource.
Examples: `indigenous_data`, `controlled_access`. Categories are defined at the platform level;
access requires an explicit category grant. See [permissions-model.md](permissions-model.md).

**A resource's grant list** _(the value against each resource in a grants token)_
A list of grants held on that resource, each naming one category and the capabilities held on it,
such as `{ "controlled": ["view"] }`. Only held grants appear, so a category the user lacks is
absent rather than named, revealing nothing about what exists. The list never appears empty: holding
no grant on a resource means what the resource being absent already means, which is no access.

**Membership**
A user's association with a resource, carrying a role. Membership alone does not grant access to
categorized content; category grants are required in addition.

**Pending grant**
A category grant in one of three states before it becomes (or fails to become) active:

- *Pending* : the invitation was sent to an email address belonging to a user who has not yet
  registered with the platform. The grant is keyed by email address and cannot appear in any
  grants token until the user registers and the grant is migrated to their Keycloak user ID.
- *Awaiting acceptance* : the grant was issued to a registered user (keyed by their Keycloak
  user ID) who has not yet explicitly confirmed they accept the associated data-sharing
  responsibility. The grant does not appear in the grants token until accepted.
- *Active* : the grantee has accepted. The grant appears in grants tokens and is enforced by
  the plugin.

Only active grants appear in the grants token. See [permissions-model.md](permissions-model.md).

**Resource**
Usher's generic, model-agnostic unit of managed data: a named grouping to which users can be
granted access. Usher makes no assumptions about what the data is, where it is stored, or what
schema it follows. In Overture the concrete term is cohort. Deployments may expose this concept
under domain-specific names in their management UI: iMS calls it a study; other deployments may
use project, dataset, or program. Those names are deployment vocabulary; Usher's internal model
uses "resource" throughout. See "Deployment vocabulary" in [concepts.md](../../docs/concepts.md).

**Role**
A label attached to a membership (for example `member`, `owner`) standing for the capabilities it
confers. A role is how access is authored rather than how it is enforced: the controller resolves it
to capabilities before writing a grants token, so no role name reaches a plugin. Capabilities are
held per category rather than across a resource, which is what lets one grant permit downloading
while another permits only viewing.

---

## Admin roles

**Custodian**
A user with grant-management rights over one or more data categories across all resources, without
holding full admin rights. Required for OCAP-compliant deployments where community-level
data sovereignty must be delegated to community representatives rather than held by platform staff.
Called a custodian rather than a steward because the business requirements already use
"Data Steward" for the resource owner.
See [permissions-model.md](permissions-model.md).

**Owner**
A user designated with management rights over a specific resource: granting and revoking access,
setting visibility policy, and transferring ownership. An Owner holds member-level data
access to their resource. Distinct from the submitter role, though a single person can hold both.

**Admin (PAP admin)**
A user identified by an OIDC token claim (`usher_roles: platform_admin`) who can manage all
grants platform-wide. Does not have implicit data access; must explicitly self-grant access to any
resource they want to read, with a mandatory TTL and a logged audit event. See
[admin-model.md](admin-model.md).

**Service account**
A non-human identity used by Overture services (for example Lyric) to perform system-level
operations in Usher, such as creating a resource at submission time. Authenticated via Keycloak
client credentials, not user sessions. See [admin-model.md](admin-model.md).

**Submitter**
The user who uploaded data via Lyric. Submission establishes provenance and confers automatic
member access to the resulting resource; it does not confer management rights unless the user is
also designated as owner.

---

## Integration concepts

**Fail-secure**
The design principle that uncertainty about authorization state defaults to denial of access rather
than continuation of service. Applied at multiple points: revocation channel disruption, token
decryption failure, and a resource absent from the grants token all produce denial, not access.

**Grace period**
The configurable window after the revocation channel goes silent before the plugin enters
revocation-uncertain mode. Exists to tolerate brief network interruptions without immediately
suspending all user sessions.

**Open access**
A data tier in which records require no authentication. The controller issues an anonymous grants
token (no IdP bearer required); bridge and plugin handle it identically to an authenticated token.
See [security-workflow.md § Grant computation pipeline](security-workflow.md#grant-computation-pipeline).

**Revocation**
The invalidation of a user's access, recorded as a `revoked_at` timestamp in Usher's database.
Applies to all grants tokens the plugin holds for that user regardless of their individual
TTLs. See [security-workflow.md](security-workflow.md).

**Revocation channel**
The mechanism by which Usher notifies plugins of revocations near-real-time. Two sub-channels:
push (SSE or WebSocket subscription) and poll (`GET /revocations?since=<timestamp>` fallback).
Plugins maintain both; the poll channel recovers from push channel interruptions.

**Revocation-uncertain mode**
The state a plugin enters when its revocation channel has been silent for longer than the grace
period. All sessions are suspended and requests return 503 until the channel reconnects. This is
the fail-secure default: uncertainty about revocation status produces denial, not access.

**EGO**
Overture's previous authorization service (managing users, groups, and policies). Usher is
EGO's full replacement, not an integration: deployments that adopt Usher retire EGO and the
studies management service that orchestrated EGO. Existing EGO group data migrates to Usher
resources and memberships; see [architecture.md](architecture.md).

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
grants token in return. The `audience` parameter identifies the calling service; Usher
returns a token containing only the resources that service manages. Modelled on OAuth 2.0 Token
Exchange (RFC 8693). See [plugin-integration.md](plugin-integration.md).

---

## Related Overture services

**SONG**
Overture's genomic file metadata service. SONG's scope in Usher-adopting deployments is narrowed
to file-level manifest data: file checksums, donor/sample links, and file object identifiers.
Resource metadata (cohort membership, category assignments, ownership, grants, and embargo state)
is Usher's responsibility. Deployments that do not include SONG are unaffected; Usher does not
depend on SONG.

**Studies management service** _(iMS-specific; retiring)_
A stateless orchestration layer that maps SONG studies to EGO groups and policies. Its role is
absorbed by Usher: resource creation, membership management, and category assignment are all
Usher admin API operations. The studies management service is retired once EGO is replaced.
