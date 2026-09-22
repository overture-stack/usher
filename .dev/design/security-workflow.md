# Security Workflow

_Status: specced. This is the most fully designed part of Usher. Rationale is documented for each
decision._

See [concepts.md](../../docs/concepts.md) for definitions of JWE, PDP, PEP, fail-secure, and other terms
used here. See [security-threat-model.md](security-threat-model.md) for the full OWASP Top
10:2025 mapping.

**Primary OWASP categories addressed here:**
- **A01 Broken Access Control:** server-side enforcement, short-lived tokens, emergency
  revocation, fail-secure on revocation channel disruption.
- **A04 Cryptographic Failures:** JWE (encrypted, not just signed), TLS on all channels,
  no sensitive claims in logs.
- **A07 Authentication Failures:** strict IdP token validation (`aud`, `iss`, `exp`, scope),
  delegation to established IdP infrastructure.
- **A10 Exceptional Conditions:** fail-secure failure mode; 503 (unavailable) on uncertain
  revocation state, not 200 or 401.

---

## Overview

    User --IdP JWT--> App (with usher-bridge + plugin / PEP)
                            |
                            | Bridge exchanges IdP JWT for Usher token (once per TTL window)
                            |
                            v
                     +-------------+
                     |  Controller |
                     |    (PDP)    |
                     +------+------+
                            |
                 +----------+----------+
                 |                     |
          Validate token          Look up policy
          with IdP (PIP)          in Usher DB
          Keycloak / Entra ID     (resources, categories, grants)
                 |                     |
                 +----------+----------+
                            |
                     Compute grants
                            |
                            v
                  Encrypted Usher token (JWE)
                  [ payload, readable only by that application's bridge (its key): ]
                  {
                    "payloadVersion": 1,
                    "sub": "user-id",           // null for anonymous access
                    "iss": "https://usher.example.org",
                    "aud": "arranger-prod",
                    "iat": 1718611200,
                    "exp": 1718611500,
                    "generatedAt": 1718611200,
                    "permissions": {
                      "COHORT_A": {"open":{"record":["read"]}, "indigenous":{"record":["read"]}},
                      "COHORT_B": {"open":{"record":["read","update"]}}
                    }
                  }
                            |
                            v
                 Bridge caches token; validates locally on
                 every request within the TTL window.
                 Plugin translates permissions payload into app-native format:
                   - Arranger: SQON filter object
                   - Lyric: database WHERE clause
                   - Stage: API query parameters

---

## Usher token format: JWE

Usher issues Usher tokens as **JWE (JSON Web Encryption)**: encrypted JWTs, not merely
signed ones. See [concepts.md, JWS vs JWE](../../docs/concepts.md#jws-json-web-signature-signed-jwt)
for the distinction.

### Design rationale

**Why encrypted (not just signed):** A user who can read their own Usher token knows exactly
which filters are applied to their queries. In sensitive data contexts, even knowing the shape of
the restriction may be information they should not have. JWE prevents a token holder from reading
the grants it encodes.

**Why self-contained (not opaque):** An opaque token requires a network call to Usher to resolve
its contents. Self-contained tokens are validated and decoded locally by the bridge using the
decryption key. This removes Usher from the hot path of every request, which is the mechanism that
caused per-request auth service crashes in prior instances.

**Why JWE over a custom encrypted format:** JWE is defined in RFC 7516 and supported by all major
JWT libraries. No custom token infrastructure is needed, and any security engineer can audit the
implementation against a published standard.

**The key is per application, and that is what matters rather than whether it is symmetric.** One key
exists per controller-and-application pair, so no bridge can decrypt another application's token and
the `aud` claim is a cryptographic boundary rather than a claim-level assertion. The key is symmetric
and lives in the secrets store, reaching both the controller and that application through the secrets
operator, which is how every other secret on the platform already travels. Onboarding an application
is a secret written once and injected into two pods. Users never hold any of these keys.

The algorithm is settled: `dir` with A256GCM. How keys are rotated remains open; see
[decisions.md](decisions.md) and [plugin-integration.md](plugin-integration.md).

**The `typ` header is `usher+jwt`.** Explicit typing is BCP 225 (RFC 8725) §3.11, against cross-JWT
confusion. The value is deliberately not `at+jwt`: this is not an OAuth access token, and claiming
that profile would be the confusion the parameter exists to prevent. A bridge validates `typ` before
anything else it reads. See the decision and the RFC 9068 comparison behind it in
[decisions.md](decisions.md).

**The JWE protected header is authenticated but not encrypted**, being base64url plaintext used as
additional authenticated data (RFC 7516). So `typ` and, once key rotation lands, `kid` are readable by
anyone holding the token. Neither says anything about grants, which is why they can sit there. Nothing
that does may be added to the header.

---

## The token exchange

The one call every ushered service makes to the controller. Everything else in this document is
either what feeds it, what caches it, or what invalidates it.

**Who calls it.** The bridge, never the plugin and never a browser. The response is encrypted to the
calling application's key, so a service without that key receives something it cannot read.

### One exchange, step by step

A researcher's first request of the day against a search service:

1. The plugin intercepts the request and extracts the IdP bearer token, then asks the bridge for a
   `PermissionsPayload`.
2. The bridge has no unexpired Usher token for this principal, so it calls the controller's exchange
   endpoint, sending the IdP token and its own audience identifier.
3. The controller validates the IdP token against the identity provider's public keys. This answers
   whether the token is genuine and current. It answers nothing about access.
4. The controller reads its own store: which grants reach this principal, what each one's role
   permits, which of them are live, and whether the principal has been revoked. This is the permission computation pipeline below.
5. The controller writes an Usher token: the permissions, an `aud` naming the calling instance, an
   `exp` no later than the earliest expiry among the grants it drew on, and a `generatedAt` stamp. It
   encrypts the token with the key held for that application.
6. The bridge decrypts it with the same key, caches it for its TTL, and hands the plugin a typed
   `PermissionsPayload`.
7. Every later request inside the TTL window is answered from that cache, with no controller call.

**Step 3 and step 4 are different questions asked of different systems**, which is the whole
architecture in one place: the identity provider says who, and only the controller says what.

### The refresh, and why it is usually cheap

**A refresh is the same call as the first exchange.** On expiry the bridge sends the current IdP token
and its audience identifier, exactly as in step 2, and receives a token back. The fast path is
entirely the controller's own business, so the bridge has one operation rather than two and cannot
get the second one wrong.

Inside the controller, the refresh looks for the principal's cached payload and compares the category
versions recorded *with that payload* against the resources' current ones:

- **Cache present and versions match**: reissue from the cached payload with a fresh TTL, bounded by
  the earliest grant expiry cached alongside it, with no policy query at all.
- **Either fails**: recompute from the store and issue updated permissions.

**Both halves of that test are the controller's own state**, which is what makes it sound. The
question the fast path has to answer is whether the payload it is about to reissue was computed under
current categories, so the versions belong with that payload. They were briefly carried in the token
instead, which answered a question about a different artifact. See the fast-path decision in
[decisions.md](decisions.md).

**What `generatedAt` is for, now that it is not part of this test.** It records when the permissions
were computed, which a reissue deliberately does not change, so it and `iat` come apart by exactly the
span a token has been served from cache. That is a diagnostic and an audit correlation rather than an
input to any decision. Whether anything should act on it, such as a bridge forcing a recomputation
once the underlying computation passes some age, is open and unbuilt.

### The anonymous exchange

Identical, with no IdP token sent and `sub` null in the response. The controller skips step 3, and
step 4 computes the open tier only. There is no second code path for unauthenticated traffic, which
is why open access is logged and governed by the same machinery as everything else.

### What the receiving service must not do with it

**The decrypted payload stays inside the service that decrypted it.** It is not forwarded, not
returned to a browser, and not written to a log. An interface that needs to show someone their own
permissions is served a rendered view built from the payload, never the payload, which is what keeps
the encryption meaningful rather than ceremonial.

---

## Session and caching

### The problem with calling Usher per request

Calling Usher on every individual request (per database write in Lyric, per GraphQL resolver
call in Arranger) creates an availability bottleneck. A prior instance of a third-party
authorization service in this role crashed under normal transactional load due to the per-request
call pattern.

### Goal

Permission changes take effect within a bounded, predictable window, without requiring users to
log out and back in, and without waiting for IdP JWT expiry (which can be hours or days).

### Mechanism

The exchange itself is above; this is what caching adds to it.

1. On first request (or on Usher token expiry), the bridge sends the user's IdP JWT to the
   controller.
2. The controller validates the IdP JWT with the configured provider, resolves the user's current
   permissions, and returns an Usher token in JWE form with a short TTL (default: 5 minutes,
   configurable per instance).
3. The bridge caches the Usher token. All requests within the TTL window are validated and
   processed locally, with no controller network call.
4. On TTL expiry, the bridge repeats step 1. A refresh is the same call, carrying the current IdP
   JWT and the bridge's audience identifier and nothing else, so the bridge has one operation rather
   than two.
5. The controller checks two things, both its own state: whether the principal's computed payload is
   still in the shared cache, and whether each resource's category version still matches the one
   recorded with that payload.
   - **Both hold:** re-issue a new JWE from the cached payload with a refreshed TTL, bounded by the
     earliest grant expiry. Fast path: no full policy query.
   - **Either fails:** recompute grants from the policy store and issue a new JWE with
     updated grants.

The fast path skips the full policy computation unless something has actually changed, and
permission changes propagate within at most one TTL window for any active user. `generatedAt` is not
part of that test; it records when the permissions were computed and a reissue leaves it alone, which
is what lets it and `iat` come apart.

**Load comparison:** a user making 100 requests per minute on a 5-minute TTL triggers 1 Usher
call instead of 500. The permissions computation cost is amortized across the TTL window.

**Default value rationale.** The 5-minute TTL is consistent with short-lived access token
conventions in OAuth 2.0 instances and is the upper bound for exposure if an Usher token is
intercepted (the attacker's window is at most 5 minutes, reduced further by push revocation).
The 30-second poll interval is derived from the worst-case revocation propagation window operators
should expect in degraded (push-down) conditions. The 60-second grace period is large enough to
absorb transient network disruptions without false-positive session suspensions, while short
enough that an adversarial channel silence yields a service disruption rather than a meaningful
access window. All three are instance-configurable; instances handling higher-sensitivity data
may tighten them.

---

## Permission computation pipeline

Grants are computed additively. Every user starts with no access; the controller adds grants
in three tiers, in order, and stops where the user's credentials no longer qualify. The result
is a `permissions` object containing every resource the user may access and the categories they hold
within it.

### Tiers

**1. Baseline grants, from instance configuration (computed for every principal, authenticated or not)**

An instance configures a **baseline** whose grants are the floor for every principal. Resources
marked as open data contribute grant entries according to it, and no IdP token is required, so an
unauthenticated request produces a token carrying exactly the baseline's grants.

**An instance may set the baseline to grant nothing**, in which case unauthenticated principals
receive an empty grant set and even open data requires registration. Whether open means publicly
readable or registration-gated therefore becomes an instance decision rather than a property of
this design. Every authenticated principal's grants are this baseline together with their own, since
the baseline is a floor rather than an alternative.

**2. The principal's own grants (computed if an authenticated IdP token is present)**

For an authenticated user the controller resolves their `grants` rows, each naming one resource, one
category within it, and the role the holder acts in there. The baseline from step 1 is already in
hand and is a floor rather than an alternative, so this step adds whatever the principal holds
beyond it. There is no role hierarchy to climb: roles are a flat set and their capabilities union.

**3. What survives to issuance**

A grant counts only while it is live, meaning accepted by its recipient, unexpired and unrevoked,
each read from the grant rather than from any cached copy. Expired and revoked grants are omitted
silently, and a category the principal holds no live grant on is simply not named.

**The three tiers are what the categories mean, not three separate computations.** One pass over one
table produces all of them, and the authority for that pass is
[token-calculation.md](token-calculation.md), which states the rule, the five steps and the cases
that force each branch. Where this section and that document differ, that document is correct.

### Why the additive model matters

- **Uniform code path.** The bridge and plugin handle the same token structure regardless of
  whether the user is anonymous, a basic viewer, or a full-access researcher. The plugin
  translates the `permissions` map into its query format; tiers are invisible to it.
- **Universal audit log.** Because even anonymous access triggers a token exchange, every data
  access, open or controlled, appears in Usher's audit log with the token's `generatedAt`
  timestamp and computed grants. Open data access is not invisible.
- **Consistent fail-secure.** The bridge's revocation channel and fail-secure mode apply to all
  tokens, including anonymous ones. A revocation of open access (resource taken offline,
  misconfiguration) propagates through the same path as a user-level revocation.

### Token structure

The `permissions` object in the token payload is a map keyed by resource ID. Each entry is **a map
from category to the entities reached under it, and from each entity to the actions held**:

```json
"RESOURCE_ID": { "open":       { "record": ["read", "update"] },
                 "controlled": { "record": ["read"] } }
```

**The entity level is load-bearing rather than decorative.** A bare `["read"]` stops saying anything
the moment more than one entity can be acted on, since `record.read` and `field.read` are different
permissions with the same action. Nesting resolves it by structure, so a plugin that has never heard
of an entity skips one key rather than failing to recognize a string.

**`field` is the exception at the entity level**, mapping to its own categories before its actions,
because a field is the one entity a record category further partitions. It appears only where a
category is partitioned by field; absent, the record capabilities carry every column.

**The entries are independent, not conditions on one another.** Holding two means holding both, so
the principal reaches what either admits plus their overlap, and holding more never reaches less.

**One entry is not one grant.** Two grants on the same category union into a single entry, and a
grant scoping fields contributes to the same entry as one scoping records. The entry is what a
category resolves to after everything reaching this principal has been merged, which is why
revocation acts on the grant in the store rather than on anything visible here.

**Every permission is category-scoped, including on unrestricted data.** A resource's open portion
is a category like any other, named in a grant like any other. There is no separate resource-level
permission list, and no baseline sitting outside the category system, because a baseline is what the
superseded subtractive model needed and additive rendering does not. Every record a principal reaches is
reached through a grant that names why.

This is also what makes tier differences expressible: an anonymous principal may hold
`{ "open": { "record": ["read"] } }` where a registered one holds `{ "open": { "record": ["read", "update"] } }`, on the same
resource and the same category.

**A resource absent from the map is unreachable, and there is no empty-list case.** Any access to a
resource means holding at least one grant on it, so an empty list would mean the same as absence. One state to enforce rather than two that had to be told apart. The consequence accepted
deliberately is that **categories are not optional**: a resource carrying none is ungrantable,
because a grant has nothing to name.

The plugin builds its filter additively: a positive clause naming the resources whose configured
categories the entries cover. A resource carrying a category no entry names contributes no clause and
is therefore invisible.

**No role name travels in the token.** A role is how access is authored, not how it is enforced: the
controller resolves a role to the capabilities it carries at issuance, so a plugin tests whether a
capability is present and never has to learn what an instance means by `viewer`. Ownership is absent
for a second reason, being a control-plane permission that Usher's own API enforces rather than any
plugin.

The data-plane capability vocabulary on records is `aggregate`, `read`, `export`, `create`, `update`
and `delete`, in order of increasing reach. `export` was once held back under the name `download` and
now ships; enforcement on the export path is unbuilt, so it is declared unenforced rather than
withheld. See the export decision in [decisions.md](decisions.md).

**Anonymous token example** (no IdP bearer token; only open resources present):
```json
{
  "payloadVersion": 1,
  "sub": null,
  "iss": "https://usher.example.org",
  "aud": "arranger-prod",
  "iat": 1718611200,
  "exp": 1718611500,
  "generatedAt": 1718611200,
  "permissions": {
    "OPEN_COHORT": { "open": { "record": ["read"] } }
  }
}
```

`iss` is present in anonymous tokens: the token is still issued by the controller and the bridge
still validates the `iss` claim. Only `sub` is null; no other standard claims are omitted.

**Authenticated token example** (grants in two cohorts, one of them on a restricted category):
```json
{
  "payloadVersion": 1,
  "sub": "user-id",
  "iss": "https://usher.example.org",
  "aud": "arranger-prod",
  "iat": 1718611200,
  "exp": 1718611500,
  "generatedAt": 1718611200,
  "permissions": {
    "COHORT_A": { "open": { "record": ["read", "update"] },
                  "indigenous": { "record": ["read"] } },
    "COHORT_B": { "open": { "record": ["read", "update"] } }
  }
}
```

### The payload as a type

`PermissionsPayload` is the decrypted token: what the bridge hands a plugin, and the one artifact the
controller, the bridge and the conformance corpus all have to agree on. It is written here rather
than in a source tree because no package layout is decided yet; the file it eventually lands in is a
layout question and blocks nothing.

```typescript
/** A list with at least one element. An empty list would mean what absence already means. */
export type NonEmpty<Element> = [Element, ...Element[]];

/** A resource identifier, as the instance names it. Opaque to the controller. */
export type ResourceIdentifier = string;

/** A category name, as the instance configures it. Opaque to the controller. */
export type CategoryName = string;

/** Actions on a record, in order of increasing reach. */
export type RecordAction = 'aggregate' | 'read' | 'export' | 'create' | 'update' | 'delete';

/** Actions on a field. No `create` or `delete`: a field exists per schema rather than per grant. */
export type FieldAction = 'aggregate' | 'read' | 'export' | 'update';

/** Actions on a revision, in services that keep prior states of a record. */
export type RevisionAction = 'read' | 'export';

/** Actions on an artifact: a kept collection of records carrying provenance. */
export type ArtifactAction = 'create' | 'read' | 'update' | 'delete' | 'export';

/**
 * The entities reached under one category, and the actions held on each. Every key is optional:
 * an entity absent from an entry is one this principal does not act on under that category.
 */
export interface CategoryPermissions {
	record?: NonEmpty<RecordAction>;
	revision?: NonEmpty<RevisionAction>;
	artifact?: NonEmpty<ArtifactAction>;
	/**
	 * The field categories reached within this record category, and the actions held on each.
	 * Absent means the category is not partitioned by field at all, so the record actions carry
	 * every column. Present means only the field categories named inside are reached, which is the
	 * same rule as the record axis one level up.
	 */
	field?: Record<CategoryName, NonEmpty<FieldAction>>;
}

/**
 * The categories reached within one resource. Entries are independent rather than conditions on one
 * another, so holding two reaches what either admits plus their overlap, and holding more never
 * reaches less.
 */
export type ResourcePermissions = Record<CategoryName, CategoryPermissions>;

/**
 * The decrypted contents of an Usher token: the standard claims, the permissions the principal holds
 * for one audience, and the bookkeeping the controller needs to refresh it cheaply.
 */
export interface PermissionsPayload {
	/**
	 * The schema version of this payload, negotiated at the exchange from the set of versions the
	 * bridge declared. A bridge never receives a version it did not list, so it reads this to select
	 * a reader rather than to decide whether to tolerate the payload.
	 */
	payloadVersion: number;

	/**
	 * The principal this payload describes, as the identity provider's subject identifier, or `null`
	 * for anonymous access.
	 */
	sub: string | null;

	/** The controller that issued this payload. The bridge validates it on every request. */
	iss: string;

	/**
	 * The single application this payload was issued for. A bridge presented with any other audience
	 * rejects the payload rather than honouring it.
	 */
	aud: string;

	/** Issued at, in seconds since the Unix epoch. */
	iat: number;

	/**
	 * Expiry, in seconds since the Unix epoch. Never later than the earliest expiry among the grants
	 * this payload drew on, so a reissue from cache cannot extend a token past a lapsed grant.
	 */
	exp: number;

	/**
	 * When the controller computed `permissions`, in seconds since the Unix epoch. Distinct from
	 * `iat` because a reissue from the cached payload renews the token while keeping the
	 * computation, which is exactly the case the two timestamps have to tell apart.
	 */
	generatedAt: number;

	/**
	 * What the principal holds, keyed by resource identifier. A resource absent from this map is
	 * unreachable, no entry is ever a denial, and there is no empty-entry case. The map itself may
	 * be empty, which is a registered principal holding no grants at all.
	 */
	permissions: Record<ResourceIdentifier, ResourcePermissions>;
}
```

**No category version travels in the payload.** The refresh compares the versions recorded with the
cached payload against the resources' current ones, so they belong with that payload; a token is a
different artifact and would answer a question about itself. See the fast-path decision in
[decisions.md](decisions.md).

**Every member is read outside the controller**, so the payload carries no bookkeeping passenger and
holds no invariant beyond what the type states.

**The ordering is the corpus's, not alphabetical.** `payloadVersion` leads because it says how to read
the rest, the standard claims follow in the order every example uses, and the content comes last.

**Unknown keys are tolerated at the entity level and nowhere above it**, which looks like it
contradicts the payload-version decision and does not. The test is what skipping a key does: a plugin
that skips an entity it has never heard of serves nothing for that entity, which fails closed, and a
plugin that skips an unknown member of the payload root may skip a restriction, which fails open. The
same polarity argument that requires the controller to retain what a plugin declared applies here.

**What the type refuses.** An empty action list, an action belonging to another entity, an action
outside the vocabulary, a missing `payloadVersion`, and `sub` omitted rather than set to `null`. That
last one matters: anonymous is an explicit `null`, so an absent `sub` is a malformed token rather than
an anonymous one. Every token example in this corpus satisfies the type, including the field-nesting
and artifact shapes in
[permissions-model.md](permissions-model.md#the-token-shape-and-what-the-nesting-gives).

---

## Emergency access revocation

### The problem with waiting for a token to expire

TTL-based caching means an Usher token remains valid for up to 5 minutes after a permission
change. For routine changes this is acceptable. For emergencies (a compromised account, an access
violation, a resource being taken offline), even 5 minutes is too long.

### Mechanism: a notice naming the principal

Revoking reaches a bridge as a notice naming the principal, and the bridge drops its cached Usher
token for them. That does not require tracking individual token IDs, and it does not require the
bridge to compare timestamps: an identifier is enough to invalidate.

On the controller's side, a grant carries its own `revoked_at`, and the principal's cached payload is
deleted by anything that changes what they hold, so a recomputation cannot serve the revoked grant
again. See the fast-path decision in [decisions.md](decisions.md).

> **Open, and it belongs to the schema session.** Revoking a principal *entirely*, rather than one
> grant, has no settled storage. Setting `revoked_at` on every grant they hold expresses it with no
> new column and leaves nothing to say that the person, rather than each grant, was stopped. A column
> on `users` says it directly and reintroduces a per-principal marker, which was rejected for the
> fast path and may still be right here, since emergency revocation is exactly the case where the
> dangerous change *is* per principal. No such column is in the entity schema, so nothing may be
> written against one until this is decided. See blocker 6 in [phase-1.md](../docs/phase-1.md).

### Propagation: push + poll

**Push (primary):** On revocation, the controller immediately pushes a revocation event to
connected bridges (via SSE or WebSocket) containing the user ID and `revoked_at` timestamp.
Bridges that receive this event drop the cached Usher token for that user immediately.
Revocation takes effect on the next request, within seconds.

**Poll (fallback):** Bridges poll a lightweight endpoint at a short interval (default: 30
seconds):

`GET /revocations?since=<timestamp>`

This returns the list of user IDs whose revocation state changed since the given timestamp. In
normal operation the response is empty and cheap. A bridge that missed the push event picks up
the revocation within one poll interval.

Worst-case revocation propagation: poll interval (30 seconds), not token TTL (5 minutes). Push
provides speed; poll provides reliability.

### Multi-instance propagation

A horizontally scaled Usher instance runs multiple controller instances behind a load balancer.
A revocation request may reach any instance. Without coordination, only that instance would push
the revocation event to its connected bridge subscribers; bridges connected to other instances
would not be notified until their next poll.

To avoid this, every controller instance publishes revocation events to a **Valkey pub/sub
channel** immediately after writing `revoked_at` to PostgreSQL. All instances subscribe to this
channel and push the event to each of their connected bridge subscribers on receipt.

The sequence for a revocation processed by instance A, with bridges connected to both A and B:

1. Instance A writes `revoked_at` to PostgreSQL.
2. Instance A publishes the revocation event to the Valkey channel.
3. Instance A pushes the event to its own connected bridges directly.
4. Instance B receives the Valkey pub/sub message.
5. Instance B pushes the event to its own connected bridges.

The poll endpoint (`GET /revocations?since=<timestamp>`) reads from PostgreSQL, which is already
updated in step 1. Bridges using the poll fallback reach the correct state regardless of which
controller instance they poll.

Controller instances are stateless between requests beyond their Valkey channel subscription.
No direct instance-to-instance coordination is needed: Valkey is the message bus.

See [architecture.md](architecture.md) for the full component breakdown and Valkey's two distinct
roles (shared cache and revocation pub/sub).

**Two pieces of state have no home yet, and both fail the same way when instances multiply.** The
propagation design above holds because revocation state lives in PostgreSQL and travels by Valkey.
Anything a controller instance holds for itself weakens as instances are added, quietly, in
proportion to how far the platform scaled.

- **The grant rate that `grant.rateExceeded` compares against `grantRateThreshold`.** Counted per
  instance, thirty operations across three instances read as ten each, and a threshold of twenty
  never fires. That is the primary detection signal for a custodian acting at scale, so it weakens
  exactly where scale makes the misuse worth detecting. **Recommended: derive it from the audit
  table rather than keeping a counter.** The events are already written there, the window is a
  `WHERE` clause, and a derived count cannot disagree with the audit trail it summarizes. Valkey
  would be faster and would introduce a counter that can. The cost is one query per grant operation,
  on a control-plane write path where operations are rare.
- **The fast path's two markers.** There is no per-principal timestamp; the payload cache is shared
  state by design and the category version lives on the resource row in PostgreSQL. Read as a scaling
  question this is the same question as the one above, and the answer is why it took this shape: a
  copy held per instance is shared state under another name, and a cache no write invalidates is the
  failure mode. Invalidating by deletion, from the write that causes the change, is what removes
  both.

The general form, worth applying to anything added later: if a controller instance would hold it
between requests, it belongs in PostgreSQL or Valkey, and the threat model's "horizontal scaling with
no shared in-memory state" row is what catches the ones that do not.

### Revocation scope

- **Single user:** the standard case.
- **All users of a resource:** when a resource is misconfigured or its data compromised.
- **Global:** break-glass; all active Usher tokens platform-wide are invalidated. The
  management UI must require explicit operator confirmation for this action.

### Interaction with the token refresh fast path

When a revoked user's token expires and the bridge requests a refresh, the controller decrypts the expired
token, reads `generatedAt`, and compares it against `revoked_at`. Since `generatedAt` is earlier
than `revoked_at`, the fast path is skipped. Usher either rejects the refresh (if access remains
revoked) or recomputes grants (if access has been reinstated).

---

## Revocation channel integrity and fail-secure behaviour

### Threat model

An adversary who can selectively block revocation traffic (push events not delivered, poll
requests timing out) while leaving application traffic intact keeps a revoked Usher token
valid for the duration of its TTL. This is an active attack on the revocation mechanism.

### Design response

**If a bridge cannot confirm revocation status, it does not trust cached tokens.**

Each bridge tracks the timestamp of its last successful revocation check (push received, or poll
returned successfully). If this timestamp exceeds a configurable grace period (default: 60
seconds) without a new successful check, the bridge enters **revocation-uncertain mode**.

In revocation-uncertain mode:
- Cached Usher tokens are **suspended**, not expired. A request needing any granted permission is
  rejected with a "service temporarily unavailable" response (HTTP 503), not a "session ended"
  response (HTTP 401).
- **The open tier continues to be served.** Open access requires no grant, so there is nothing a
  revocation could withdraw and nothing for the bridge to be uncertain about. Withholding it hides
  data that was never meant to be hidden.
- The distinction matters: a suspended session resumes automatically when connectivity is restored
  and revocation status is confirmed, without requiring re-authentication. An expired session
  requires a new login.
- The grace period absorbs brief, non-adversarial network interruptions. After the grace period,
  fail-secure applies regardless of cause.

**Serving open during an outage needs no controller, and introduces no new exposure.** A plugin
computes `open` by complement, locally, from its own configuration rather than from the token, so
the open slice is available whether or not the controller is reachable. The known hazard of that
computation, a category the plugin has no mapping for falling outside the set being subtracted and
its records being served as open, is present under normal operation too and is addressed by the
startup check against Usher's category dictionary. An outage neither creates it nor widens it.

**The exemption belongs to a bridge that started cleanly, not to a cold start.** The startup check
needs the controller, so a bridge starting while the controller is unreachable has never validated
its configuration against the dictionary and cannot know what `open` excludes. It serves nothing
until it has, which is what the startup behaviour below already requires.

**A reduced result must say so.** Serving a silently smaller set is worse than serving none, because
a researcher reads missing rows as absent data rather than as withheld data, and acts on it. The
plugin signals that the result is open-tier only, and the interface says so where the results appear.

**Liveness via push connection.** When using SSE or WebSocket for push events, the persistent
connection itself is the liveness signal. A dropped connection that cannot be re-established
within the grace period is sufficient to trigger revocation-uncertain mode; no separate
heartbeat is needed.

**Startup behaviour.** At bridge startup, no cached tokens exist and the revocation channel is
not yet established. The bridge must not serve requests until the revocation channel is confirmed
active: doing so would create a window with no revocation coverage. In practice this means the
bridge enters a brief initializing state on startup, queuing or rejecting requests until the
first successful push connection or poll response confirms channel health. The grace period clock
starts from that point, not from process start.

**The operational trade-off.** Legitimate users are also affected when the revocation channel is
disrupted. This is a deliberate choice: the threat of an adversary exploiting a blocked revocation
channel outweighs the inconvenience of a brief service interruption. Operators should treat Usher
as a high-availability dependency with reliable network paths to all bridges. The grace
period is the tunable knob: shorter values tighten security; longer values allow more tolerance
for transient network conditions.

---

## Identity provider abstraction

Usher validates incoming IdP tokens against a configured provider. The provider is pluggable:
- Keycloak (current Overture standard)
- Microsoft Entra ID (formerly Azure Active Directory)
- Any OpenID Connect-compatible provider

Apps forward the user's bearer token to Usher on first exchange. Usher handles IdP validation.
Subsequent requests within the TTL window use the locally cached Usher token, so IdP
connectivity is not in the hot path.

**Design against a current Keycloak, not against whatever version is running somewhere.** Usher pins no
version and should not, since validation is against whatever the provider publishes. Integration work
nonetheless has to assume something, and the assumption is a current release.

This is worth stating because the first target environment contradicts it. iMS dev runs Keycloak
12.0.4, three majors below the Quarkus rewrite at 17, because its theme is a forked custom image that
has held the version back rather than because anything chose 12. That is debt on the iMS side
and the environment is expected to move. Nothing in Usher should accommodate 12, and an
integration built to work there would be building against an artifact that is going away.

---

## Open questions

### Decryption key distribution

Receiving it is settled: the secrets operator delivers the same symmetric key to the controller and
to that application's pod, which is how every other secret on the platform already travels. Rotation
is not: how often, and how a bridge picks up a new key without dropping tokens still in flight. See
[plugin-integration.md](plugin-integration.md).

### Grace period configurability scope

Should the grace period (default 60s) be configurable globally, per-bridge, or per-resource? A
resource containing highly sensitive data may warrant a shorter grace period than one with
lower-sensitivity data.

### Audit logging of revocation events

Every revocation (who triggered it, for which user, at what timestamp, and via which scope:
single user, resource, or global) should be logged. Where this log lives and how it is
queryable are not yet designed. See [management-ui.md](management-ui.md).
