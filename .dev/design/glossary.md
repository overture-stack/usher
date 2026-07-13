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
decide — it enforces what the PDP computed. See [plugin-integration.md](plugin-integration.md).

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
The target service for which a grants token is issued — for example, a specific Arranger
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
A single Arranger index configuration, backed by one ES/OS index. One catalogue maps to one Usher
resource in the plugin config.

**Category grant**
An explicit, logged record allowing a specific user to access records or fields tagged with a
specific data category within a specific resource. Grants are additive; lacking a grant for a
category means that category's content is excluded from the user's view. See
[permissions-model.md](permissions-model.md).

**Cohort**
The Overture-platform term for a Usher resource. A virtual grouping of data records defined by
shared characteristics. Unlike Song/Lyric "studies" (one record belongs to exactly one study),
records can belong to multiple cohorts simultaneously.

**Data category**
A named access dimension that applies to a subset of records or fields within a resource.
Examples: `indigenous_data`, `controlled_access`. Categories are defined at the platform level;
access requires an explicit category grant. See [permissions-model.md](permissions-model.md).

**`categories`** _(per-resource field in grants token)_
The include-list of data categories the user holds grants for within a specific resource. Only
granted categories appear; denied categories are absent entirely, revealing nothing about what
the user cannot access. The PEP plugin derives what to filter by subtracting this list from the
full category set in its own config, then translates each absent category into a native filter
expression. Empty list = member access with no category grants (uncategorized records only).
Resource absent from the token entirely = no access to that resource.

**Membership**
A user's association with a resource, carrying a role. Membership alone does not grant access to
categorized content; category grants are required in addition.

**Resource**
Usher's generic, model-agnostic unit of managed data: a named grouping to which users can be
granted access. Usher makes no assumptions about what the data is, where it is stored, or what
schema it follows. In Overture the concrete term is cohort.

**Role**
A coarse-grained capability label attached to a membership (for example `member`, `owner`).
Describes what kind of actions a user can perform within a resource, independent of which data
categories they can access.

---

## Admin roles

**Steward**
A user with grant-management rights over one or more data categories across all resources, without
holding full admin rights. Required for OCAP-compliant deployments where community-level
data sovereignty must be delegated to community representatives rather than held by platform staff.
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
See [security-workflow.md — Grant computation pipeline](security-workflow.md#grant-computation-pipeline).

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

**Server-side filter** _(Arranger-specific)_
A SQON filter injected into every Arranger query by the plugin before the query reaches the search
engine. The primary mechanism for record-level access enforcement in Arranger; derived by
subtracting the token's `categories` include-list from the plugin's full category config, then
translating each absent category into a SQON expression.

**SQON (Structured Query Object Notation)** _(Arranger-specific)_
Arranger's filter expression format. The `usher-arranger` plugin derives the exclusion set from
the `categories` include-list in the grants payload and translates it into SQON server-side
filters applied to every query.

**Token exchange**
The call a PEP plugin makes to Usher presenting an IdP bearer token and receiving a scoped
grants token in return. The `audience` parameter identifies the calling service; Usher
returns a token containing only the resources that service manages. Modelled on OAuth 2.0 Token
Exchange (RFC 8693). See [plugin-integration.md](plugin-integration.md).
