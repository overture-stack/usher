# Bridge core and Express layer

Checked on Node 24.16 on macOS against the npm registry (express 5.2.1 and 4.22.3, jose 6.2.12,
zod 4.6.5, lru-cache 11.5.3, TypeScript 7.0.2, 5.9.3 and 5.8.3, `@types/express-serve-static-core`
4.19.9 and 5.1.3, tsx 4.23.15), 2026-10-04. Every behaviour stated here was run there, against a
prototype of the core and its Express layer or against a standalone check, neither of them published,
unless the sentence says it was read from source, from a specification or from the design, or
reasoned.

The bridge is the shared library that each application protected by Usher, Overture's access-control
service, embeds to turn a request's credential into that request's access. This note settles its
structure: one core with no web framework in it, a thin Express layer over that core, and the core's
state, stores, clocks, rendering, events and handling of concurrent requests. Four neighbouring topics
have notes of their own: [jose for the Usher token](jose-usher-token.md),
[Revocation notice stream](revocation-notice-stream.md),
[Sign-in signature precheck](signin-signature-precheck.md) and
[Packaging the bridge](packaging-and-toolchain.md).

## Decisions

These state the design. A decision recorded in another design document links that document. One
marked proposed awaits review, and the design document it links marks it proposed. "Open questions"
at the end holds the points no decision settles yet. The sections after them give the evidence, and
"Not built or not run" lists what the prototype did not carry.

**Structure and surface**

- The core sits inside the Express bridge package, under a framework-free directory that a test keeps
  free of Express imports, as [Packaging the bridge](packaging-and-toolchain.md) sets out.
- The core moves to a package of its own when a second framework's bridge starts.
- `createBridgeCore(configuration)` validates the configuration synchronously and returns eight
  members: `applyNotice`, `confirmChannel`, `mode`, `refreshAnonymous`, `register`, `resolve`, `start`
  and `stop`.
- `resolve(credential | null)` is the one operation per request, and it answers access, refused or
  unavailable.
- The bridge provides no category dictionary. The check against an unmapped category reads the
  categories each resource offers, as "Rendering" sets out, and category dictionary introspection is a
  post-MVP proposal in
  [adapter-integration.md](../../../design/adapter-integration.md#category-dictionary-introspection).
- A host creates the core, calls `register`, mounts the middleware and then awaits `start`, which
  imports the application key and fetches the anonymous payload.
- The core runs on Node only, keeping `node:crypto` and `Buffer`.
- The application key arrives as 43 base64url characters. After import the bridge holds it only as
  two non-extractable `CryptoKey`s: a decrypt-only AES-GCM key for the Usher token, and an HKDF key
  from which every other use derives its own subkey, as
  [jose for the Usher token](jose-usher-token.md) sets out.

**Credentials and the Express layer**

- The layer reads every `Authorization` line through `req.headersDistinct`.
- Every bearer value the layer can read goes to the exchange, with no grammar check.
- API keys are presented as `Bearer`, so a key of any shape reaches the controller, and the
  [test plan](../../bridge-tests.md) answers 400 to any other scheme.
- The bridge never refuses a credential the controller would accept
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
- The bridge therefore checks no signature. The research is in
  [Sign-in signature precheck](signin-signature-precheck.md).
- Two `Authorization` lines, a scheme other than `Bearer`, or an `access_token` query parameter get
  400 with `error="invalid_request"`, and are never exchanged and never served as anonymous.
- Every refused identity gets one 401 with fixed text, and the layer sends its 400, 401 and 503
  answers before anything downstream runs.
- The access value is attached deep-frozen under a non-writable, non-configurable
  `res.locals.usher`, declared to TypeScript as `readonly usher?: unknown`.
- `attachAccess` records the value in a module-level `WeakSet`, and `readAccess` accepts only a value
  recorded there, so a replaced value fails closed.
- `usher-types` is therefore a peer dependency of the bridge, since two copies in one host refuse each
  other's values, as [Packaging the bridge](packaging-and-toolchain.md) sets out.
- The layer never hands Express a promise and never calls `next(error)`, so an internal error becomes
  a 503 with fixed text and an event naming only the stage.
- A host mounts the layer after its health routes and CORS, and before body parsing.
- The layer sets `Cache-Control: private, no-store` and a `Vary` naming its credential source on every
  response it lets through.

**Exchanges**

- Concurrent requests on one digest share one exchange.
- A global bound on exchanges in flight answers 503 beyond it.
- Each exchange carries its own timeout, from an `AbortController` that a `setTimeout` aborts, never
  tied to one request.
- The anonymous refresh runs outside the bound, in its own single flight.
- A controller's 401 is a refusal, and a timeout, a network failure, a 5xx or a 408 is a failure.
- A 429, and every other status, is unavailable: 503, not cached, and logged as
  `token.exchangeFailure` with cause `status`.
- An Usher token the bridge cannot read, whose `sub` does not match the kind of exchange, or whose
  `sub` differs from a three-part sign-in token's own subject, is treated as not received: 503, and
  never served as suspended, as [jose for the Usher token](jose-usher-token.md) sets out.
- A failed exchange serves that principal the anonymous results, marked `openTierOnly` and
  `suspended`, with a null subject.
- A rejected token is held briefly in a short failure store, apart from refusals, so a broken
  controller is not asked again on every request (the [test plan](../../bridge-tests.md),
  "Exchange").
- The failure store holds each for a fixed interval that is configurable and bounded.
- A failed exchange is held in the same store, so a credential whose exchange keeps failing does not
  wait out the exchange timeout on every request.
- An answer overtaken by a notice that affects it is discarded for every waiter and exchanged once
  more, a test adopted by [Revocation notice stream](revocation-notice-stream.md).
- An answer overtaken a second time serves the open tier, marked `suspended`.
- `token.overtaken` records a discard followed by another exchange, and the second discard, which ends
  the flight, has no event of its own.

**Stores**

- Each store is a bounded map written for the bridge, not lru-cache.
- Positive entries are keyed by the SHA-256 digest of the whole credential.
- Positive entries are indexed by the subject read from the decrypted payload
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
- The index holds that subject's per-audience tag, the tag principal notices carry (proposed in
  [schema.md](../../../design/schema.md#the-notice-stream), Decide E), as
  [Revocation notice stream](revocation-notice-stream.md) sets out.
- Refusals live in a bound of their own, failures in the short failure store, and the anonymous entry
  outside all of them.
- No store keeps a decrypted payload.
- The anonymous slot keeps the set of grants named in its payload, for `openTierOnly`.
- A positive entry ends at the earliest of its Usher token's `exp`, its receipt plus the TTL timed on
  the monotonic clock, and its sign-in token's `exp`.
  [decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)
  records the two `exp` bounds, and the receipt bound holds even if a controller defect issues a long
  `exp`.
- A category notice is handled by scanning the positive store rather than by a resource index.
- A baseline-change notice drops every positive entry and the anonymous entry
  ([decisions.md](../../../design/decisions.md#a-category-change-is-announced-to-the-applications-that-serve-the-resource)).

**Modes and time**

- The bridge has three modes, cold, normal and uncertain, and one per-principal degraded state
  inside normal mode.
- The bridge is cold until it has accepted an anonymous payload since start, again when the grace
  period lapses with none held, and while the zod in use is outside its tested range or the key's
  self-test fails.
- Cold answers 503 to every request, and a probable key mismatch has a reason code of its own.
- Uncertain mode never exchanges, so it adds no load on the controller during an outage.
- In uncertain mode, a presented credential gets the anonymous results, marked `openTierOnly` and
  `suspended`, with a null subject, even when a cached entry holds one.
- In uncertain mode, a credential in the refusal store, or a signed token past its own `exp`, still
  gets 401, since a refused identity is never served as anonymous
  ([decisions.md](../../../design/decisions.md#a-refused-identity-gets-one-401-whatever-the-reason)).
- In uncertain mode, a credential whose rejected Usher token the failure store still holds gets 503,
  since a rejected token is never served as suspended.
- In uncertain mode, the anonymous results are served even past the anonymous payload's own `exp`.
- In normal mode, once the anonymous entry has expired or a notice has dropped it, anonymous and
  open-tier requests get 503 until a refetch succeeds.
- A notice that drops the anonymous entry discards it for good, so it is never revived as the
  uncertain-mode fallback, as [jose for the Usher token](jose-usher-token.md) sets out.
- `suspended` is part of the request access contract
  ([adapter-integration.md](../../../design/adapter-integration.md#decided);
  [decisions.md](../../../design/decisions.md#a-suspended-principal-is-answered-by-what-the-open-tier-can-settle)).
- Only a poll answered within its deadline is a check (proposed in
  [security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour)),
  and the [notice stream](revocation-notice-stream.md) note builds on it.
- The channel layer calls `confirmChannel(checkStartedAt)` only after applying every notice of a
  check, in the same tick, with the check's start read from the injected monotonic clock.
- A wall clock, `Date.now()` by default, serves every comparison with an `exp`, jose's `currentDate`
  and event times.
- A monotonic clock, `performance.now()` by default and injected in tests, times the grace period,
  the poll deadline and each entry's TTL.
- The core reads the monotonic clock on every request, and a timer only logs a lapse when no request
  arrives.

**Rendering**

- Rendering runs once per exchange, follows the canonical grouped form, sorts by code unit, and
  interns its results.
- All clauses go under one `or`, even a single clause.
- An entry carrying `field`, `field: {}` included, earns no clause in version 1, and
  `category.unenforced` records it.
- A resource offering a category that a key neither maps nor declares absent is withheld from that
  key alone, read from `offeredCategories` (proposed in
  [decisions.md](../../../design/decisions.md#a-catalogues-category-gap-is-found-by-the-bridge-from-the-categories-each-resource-offers)).
- `register` refuses at startup any registration that would render openly.
- A key's resource list is optional, and only a key with one renders "every grant sits in other
  keys" as `deny` with `no-grants`.
- An artifact-type key carries a provenance ceiling, left out only when its configured resource list
  is present and every resource in it is held.
- `openTierOnly` is definition A: every grant in the principal's payload also appears in the anonymous
  payload. Definition B, comparing rendered results, depends on what was withheld, which
  [adapter-integration.md](../../../design/adapter-integration.md#known-requirements) rules out.
- `openTierOnly` is computed at the exchange and stored on the entry, where it stands until the entry
  ends.

**Events and configuration**

- Events go through typed builders that copy allow-listed fields, with closed reasons and never an
  error's message.
- Every event under "Logging" is registered in [audit-events.md](../../../design/audit-events.md),
  where a refused identity is `credential.refusal` and a failed exchange is `token.exchangeFailure`,
  so exchange stays an action.
- Overloaded requests are logged as one aggregated event per interval, carrying a count.
- Construction validates the configuration, and a failure names the parameter, never its value.
- Construction refuses any configuration in which 1.1 T + 2D is not below G: the ordering T + 2D < G
  of [Revocation notice stream](revocation-notice-stream.md), with the poll interval T at its 10%
  jitter maximum.
- The configuration carries all three, as `pollIntervalMs`, `pollDeadlineMs` and `graceMs`, so one
  check sees them together.
- The local refusal uses the controller's clock tolerance
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
  How the bridge learns that tolerance is open question 1.
- The Usher token's clock tolerance is 0, with no parameter to change it, as the jose note sets out.
- Plain HTTP to the controller is refused except to loopback, so a cluster needs TLS or mesh
  encryption.
- Loopback is accepted in all three of its spellings: `127.0.0.1`, `localhost` and `[::1]`.

## Terms used here

| Term                    | Meaning in this note                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| credential              | what a request presents: a sign-in token, or an opaque API key                                                             |
| digest                  | the base64url SHA-256 of the whole credential, which keys the stores                                                       |
| key                     | one entry an adapter registers and the request access value's `results` carries; in Arranger, one catalogue                |
| application key         | the 32-byte secret the Usher token is encrypted under, one per application; the configuration's `key` parameter carries it |
| entry                   | what a store holds for one digest, or the anonymous store's one slot, the anonymous entry                                  |
| flight                  | one exchange in progress for one digest, shared by every request waiting on it                                             |
| check                   | an event that renews the grace period; the notice stream defines it                                                        |
| wall clock              | the clock that tells the time of day; `exp` and event times are read against it, and it can step backward                  |
| monotonic clock         | a clock that only moves forward, used to measure elapsed time                                                              |
| refused                 | the controller refused the identity, or the credential is a signed token past its own `exp`; the request gets 401          |
| malformed               | the controller answered, and the bridge rejected the Usher token in it; treated as not received, so the request gets 503   |
| failed                  | the controller gave no usable answer: a timeout, a network failure, a server error or a 408                                |
| unavailable             | the outcome answered with 503                                                                                              |
| suspended               | a signed-in principal served the anonymous results because their grants are on hold                                        |
| cold, normal, uncertain | the bridge's three modes, set out under "Modes"                                                                            |
| per-principal degraded  | in normal mode, one principal served from the anonymous payload because their exchange failed while the channel is healthy |

Malformed and failed both leave the bridge with no usable token for the principal, and they stay
apart. A malformed answer is a deployment fault, refused loudly with 503. A failed exchange is an
outage, which serves the open tier marked suspended.

"Key" has two meanings in the bridge. A registered key is what the contract and the adapters call a
key. The application key is the secret, carried by the configuration's `key` parameter, which is that
word's one meaning inside `BridgeConfiguration`. Where the context does not settle which is meant,
this note says "application key".

## The core

### Its surface

The surface below typechecks under TypeScript 7.0.2 and 5.8.3, with `strict`,
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, against stub types for the parts defined
elsewhere (run, before the failure store's two parameters and the poll deadline were added). A
`Uint8Array` key and a notice kind outside the schema's names both fail to compile.

```ts
interface Clock {
	now(): number;
}

interface BridgeConfiguration {
	audience: string;
	controllerClient?: ControllerClient;
	controllerUrl: URL;
	exchangeTimeoutMs: number;
	graceMs: number; // default 60000
	inFlightMax: number;
	issuer: string;
	key: string; // 43 base64url characters; imported at start, never held as bytes
	localRefusalClockToleranceMs: number; // the controller's tolerance; how it is learned is open
	logger: BridgeLogger; // info, warn and error, each taking (object, message?)
	monotonicClock?: Clock; // default performance.now(): grace period, poll deadline, entry TTL
	payloadVersions: NonEmpty<number>;
	pollDeadlineMs: number; // default 10000
	pollIntervalMs: number; // default 30000
	stores: {
		failureHoldMs: number; // the failure store's fixed interval, within bounds
		failureMax: number;
		positiveMax: number;
		refusalMax: number;
	};
	tokenReader?: TokenReader;
	tokenTtlMs: number; // default 300000
	wallClock?: Clock; // default Date.now(): exp comparisons and event times
}

type KeyRegistration =
	| { key: string; kind: 'openByConfiguration' } // always { kind: 'allow' }
	| {
			categories: Partial<Record<CategoryName, { value: string } | 'absent'>>;
			fields: { category?: string; provenance?: string; resource: string };
			key: string;
			kind: 'enforced';
			requiresResourceList?: boolean;
			resources?: readonly string[];
	  };

// Notice: the union set out in Revocation notice stream, whose kinds are the
// schema's notices.kind values.

interface BridgeCore {
	applyNotice(notice: Notice): void;
	confirmChannel(checkStartedAt: number): void; // a reading of monotonicClock
	mode(): 'cold' | 'normal' | 'uncertain';
	refreshAnonymous(): Promise<boolean>;
	register(registrations: readonly KeyRegistration[]): void;
	resolve(credential: string | null): Promise<ResolveOutcome>;
	start(): Promise<void>; // imports the application key, then fetches the anonymous payload
	stop(): void;
}

type ResolveOutcome =
	| { kind: 'access'; access: Readonly<UsherRequestAccess> }
	| { kind: 'refused' }
	| { kind: 'unavailable' };
```

The host's order follows from [Packaging the bridge](packaging-and-toolchain.md), which allows no
top-level await to read the application key or fetch the anonymous payload while the module loads.
The middleware answers 503 while the bridge is cold.

**`register` is called once, before the first request, and is then frozen.** Cached results were
rendered from the registration, so registering again throws. `register` clones what the adapter hands
it before freezing, because freezing the adapter's own objects in place would change the adapter's
configuration as a side effect (reasoned).

**`register` refuses three shapes, each of which would render openly:**

- a key that maps a concrete category but names no category field;
- an empty field name or an empty mapped value;
- an enforced key with no field names at all.

The first was run. With no category field, the unmarked clause rendered as the resource test alone,
and an anonymous principal (case 02) was then served records carrying concrete categories, in a result
that passed the request-access validator.

**`start` and `refreshAnonymous` refuse to run before `register`.** Run in the other order, the
anonymous entry was rendered against no keys. Anonymous requests were then served access with empty
results, and the startup `category.unmapped` check logged nothing. Rendering the anonymous entry
again on `register` would also close this, but refusing is simpler and keeps one order. The first
anonymous fetch is also the application key's self-test, which
[jose for the Usher token](jose-usher-token.md) sets out.

**`start` holds the decoded key bytes only for the imports.** It imports them as a non-extractable
AES-GCM key whose only usage is decrypt, imports them again as a non-extractable HKDF key, and then
zero-fills them. The import copies the bytes, so a token was still decrypted after the fill (run,
with the AES-GCM import alone). A key handed over as bytes would instead stay in the configuration
object for the life of the process. The key's format, its canonical-form check and the properties
of both imports belong to the jose note.

**The artifact provenance ceiling is missing from the prototype.** Resolution step 6 in
[adapter-integration.md](../../../design/adapter-integration.md) and two rows in the
[test plan](../../bridge-tests.md) require it for an artifact-type key, and
[decisions.md](../../../design/decisions.md#the-bridges-filters-carry-no-empty-group-no-empty-exclusion-and-no-pivot)
says when it is left out. Rendering an artifact-type key like a record key would show an artifact
derived from a resource not held by the principal (reasoned). A registration for an artifact-type key
therefore also needs a provenance field name, which the surface carries as `fields.provenance`.

### Free of any framework, but tied to Node

The core compiled under TypeScript 7.0.2 with `types: ["node"]` and no Express types, and under
TypeScript 5.8.3 with `skipLibCheck`. No core file imports from Express, and no core file reads
`process.env`. The core imports `node:crypto`, jose and zod at runtime, and nothing else.

The core digests with `createHash` and reads a signed token's `exp` through the `Buffer` global. A host
running the bridge outside Node, such as an edge runtime for a Next.js server side, could not use the
core as written (reasoned). The alternative, Web-standard APIs such as `crypto.subtle.digest`, is
asynchronous and adds a step to every request (not measured). The core keeps `node:crypto` and
`Buffer`. The alternative would matter only if a host, such as Stage's server side, ran the bridge
outside Node.

## Modes

| Mode                               | Entered when                                                                                                                                                                                                                                                        | A request carrying a credential                                                                                                                                                                                                                      | An anonymous request                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| cold                               | at start, until `start` has imported the application key, a check is confirmed and an anonymous payload is accepted; when the grace period passes with no anonymous payload held; while the zod in use is outside the tested range; while the key's self-test fails | 503, nothing attached                                                                                                                                                                                                                                | 503, nothing attached                                                                      |
| normal                             | a check is confirmed and an anonymous payload is held                                                                                                                                                                                                               | its entry, or a shared exchange                                                                                                                                                                                                                      | the anonymous entry; 503 once that entry has expired or been dropped and its refetch fails |
| uncertain                          | the grace period passes on the monotonic clock since the start of the last confirmed check, with an anonymous payload held                                                                                                                                          | a credential in the refusal store, or a signed token past its `exp`, still gets 401; one whose rejected Usher token the failure store holds gets 503; otherwise the anonymous results, `openTierOnly` and `suspended`, subject null, and no exchange | the anonymous results, even past the payload's own `exp`                                   |
| per-principal degraded (in normal) | this principal's exchange failed while checks are confirmed                                                                                                                                                                                                         | the anonymous results, `openTierOnly` and `suspended`, subject null; 503 when no usable anonymous payload is held                                                                                                                                    | not applicable                                                                             |

The zod range check is in [Packaging the bridge](packaging-and-toolchain.md).

**The `suspended` mark is what keeps a signed-in person apart from an anonymous visitor.** Without it,
a credential the bridge has never exchanged gets subject null and `openTierOnly` true in uncertain
mode, which looks exactly like an anonymous visitor (run). The same holds on the per-principal
degraded path. An adapter that serves anonymous exports as normal would then serve that signed-in
person's export as open tier, which the design rejects.

**A refused identity is never served as anonymous, in any mode.** decisions.md rejects serving a
refused identity as anonymous ("A refused identity gets one 401, whatever the reason"). The design
gives a suspended session 503 rather than 401
([security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour)),
and says nothing of a credential already refused. A refusal-store hit therefore stays 401 in
uncertain mode, the closed side. The "Degraded modes" row of the [test plan](../../bridge-tests.md)
reads otherwise: in uncertain mode, every request is rendered from the last anonymous payload.

**A cached entry's subject is not served in uncertain mode.** Notices were missed, so its revocation
status is unknown, and [adapter-integration.md](../../../design/adapter-integration.md#decided) makes
`subject` the trusted identity, later a saved set's owner. A null subject keeps it from backing an
ownership decision while the principal's grants are on hold.

**A rejected token held in the failure store stays 503 in uncertain mode.** A rejected Usher token
is never served as suspended, as [jose for the Usher token](jose-usher-token.md) sets out, and the
failure store answers it without asking the controller in every mode.

**One outage, traced.** The grace period is 60 s. The trace ran under node:test mock timers, with one
clock serving as both wall and monotonic clock, which changes nothing here because no wall-clock step
occurs in it. `confirmChannel` stands in for a timely check.

1. t = 0 s. `register` has run, and nothing is confirmed. The mode is cold. Every request, anonymous
   included, is answered 503.
2. t = 0 s. A check is confirmed, but the anonymous payload is not yet fetched. The mode is still cold.
3. t = 0 s. The anonymous payload arrives. The mode is normal, logged as cold to normal. An anonymous
   request gets access.
4. t = 59 s. Another check is confirmed.
5. t = 119 s. No request arrives. One mode change has been logged so far.
6. t = 120 s. Still no request. The core's own timer finds the grace period passed and logs normal to
   uncertain.
7. t = 120 s. A signed-in request with a cached entry gets the anonymous results, `openTierOnly` true,
   and its subject from the entry. The prototype predates the `suspended` mark: the design also marks
   this request `suspended` and gives it a null subject.
8. t = 520 s. The anonymous payload is past its own `exp`, and it is still served.
9. A check is confirmed again, after the channel layer has applied every notice it carried. The mode
   is normal, logged as uncertain to normal, and grants are honoured again.

**A second case** (reasoned from the rules above, not run). A category notice names a resource also
named in the anonymous payload, so it drops the anonymous entry and every entry naming that resource. The
refetch fails because the controller has gone down. Until the grace period runs out, signed-in
requests with surviving entries are served from them, and anonymous and open-tier requests get 503.
Once it runs out, no anonymous payload is held, so the mode is cold and every request gets 503.
[security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour)
says the bridge holds an anonymous payload whenever the controller has answered at least once, and
this case breaks that. Reviving the dropped payload as the fallback would keep that statement true,
at the cost of serving open data known to be out of date.

**Recovery ordering comes from the call order.** The channel layer applies every notice a check
returns, across every page, and only then calls `confirmChannel`, within one tick. No request is
served between the two. How a multi-page catch-up signals that it is complete belongs to the
[notice stream](revocation-notice-stream.md).

**Construction enforces the ordering of intervals.** It refuses a `graceMs` that is not above
`pollIntervalMs`. The stream's ordering is T + 2D < G, for a poll interval T, a poll deadline D and
a grace period G. The stream note sets what they mean, jitters T by 10% and gives D a default of
10 s. The check therefore refuses any configuration in which 1.1 T + 2D is not below G. T = 38 s,
D = 10 s and G = 60 s keep T + 2D at 58 s, yet the jittered worst case is 41.8 + 20 = 61.8 s, past
G. The defaults give 33 + 20 = 53 s against 60 s. The core's configuration carries all three, as
`pollIntervalMs`, `pollDeadlineMs` and `graceMs`, so one check sees them together.

## The Express layer

### Reading the credential

Node keeps only the first of two `Authorization` lines in `req.headers.authorization` and drops the
second silently. `req.headersDistinct.authorization` returns both (run, with a raw request). Reading
`headersDistinct` lets the layer see that a request carries more than one credential.

| What the request carries                       | What the layer does                                    |
| ---------------------------------------------- | ------------------------------------------------------ |
| no `Authorization` line                        | resolves the request as anonymous                      |
| one line, `Bearer` in any letter case, a value | passes the value to `resolve`, whatever its characters |
| more than one line                             | 400, never anonymous, never exchanged                  |
| a scheme other than `Bearer`                   | the same                                               |
| an `access_token` query parameter              | the same                                               |

Refusing a value outside the `b64token` grammar of RFC 6750 would be a local refusal the contract does
not allow, and it would stop an API key outside that grammar from reaching the exchange. A credential
in a URL reaches request logs, so the query parameter is refused rather than ignored. A host can pass
its own `extract` function, for example for a cookie session on a portal's server side. The layer
logs every unreadable credential as `credential.malformed` with a closed reason.

### Answering

- **400** carries `error="invalid_request"`, as RFC 6750 gives it, and says nothing about the
  identity.
- **401** carries `WWW-Authenticate: Bearer error="invalid_token"`, `Cache-Control: no-store` and the
  fixed text the [test plan](../../bridge-tests.md) gives under "Exchange". Every refused identity gets
  this one response.
- **503** carries `Retry-After` and a fixed text.
- All three are sent before anything downstream runs. On both Express versions, the tests confirmed
  that nothing downstream ran after a 401 or a 503.

### Attaching

`attachAccess` validates the value with the usher-types validator and deep-freezes it. Validation
costs about 11.5 µs for two keys narrowed over 300 resources. The Express layer then defines
`res.locals.usher` with `writable: false` and `configurable: false`. In ESM code, which runs in strict
mode, reassigning `res.locals.usher` throws, and so does mutating a result (run on both versions). In
sloppy-mode CommonJS code the reassignment is ignored silently, and the value is still not replaced.
The property stays enumerable, because object rest and spread skip properties that are not
enumerable.

`attachAccess` also records the value in a module-level `WeakSet`, and `readAccess` accepts only a
value recorded there, so a value that replaces the attached one fails closed. Each copy of
`usher-types` keeps a `WeakSet` of its own, so a host holding two copies would refuse every value
the bridge attaches. That is why `usher-types` is a peer dependency of the bridge, as
[Packaging the bridge](packaging-and-toolchain.md) sets out, where the check ran with a sample
`attachAccess`.

Deep freezing is required because results are shared across requests. Every anonymous request shares
the anonymous results, and interning makes principals with equal results share one object. One
mutation would reach all of them.

Two rules make the freeze complete (reasoned). First, freezing recurses into every child
unconditionally: a freeze that stops at any object already frozen leaves the children of a
shallow-frozen value mutable. Second, `attachAccess` is a public usher-types function that fake
bridges and other frameworks' bridges call, so it cannot assume its input came from the core.

### Never handing Express a promise

An async middleware that rejects behaves differently on the two Express majors:

| When the middleware's promise rejects | Express 4.22.3                                                     | Express 5.2.1                                                                     |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| who sees the rejection                | nobody: it surfaces as `unhandledRejection`                        | `finalhandler`, as a 500                                                          |
| the request                           | hangs, when the process handles `unhandledRejection`               | answered 500                                                                      |
| the process                           | exits with code 1 under Node 24's default, when nothing handles it | keeps running                                                                     |
| the response body                     | none                                                               | the error's message and stack while `NODE_ENV` is unset; clean under `production` |
| standard error                        | the stack, on exit                                                 | the message and stack, under `production` too                                     |

V8's `JSON.parse` error messages can quote part of their input. A parse failure on a payload-shaped
string put a resource name into its message (run). Some kinds of parse error give only a position.
Any path that lets an error reach Express can therefore put payload fragments into a response or a
log.

The layer returns nothing to Express. It chains `.then(onOutcome).catch(fail)` on the outcome, and
runs the work before that promise exists, a host's `extract` included, inside a `try` whose `catch`
also calls `fail`. Synchronous throws and asynchronous rejections then both reach `fail`, as
[Packaging the bridge](packaging-and-toolchain.md) requires. `fail` logs `bridge.internalError`
carrying only `{ stage }` and answers 503 with fixed text. The prototype layer is about 70 lines,
and seven of its tests passed on both versions:

1. an anonymous request attached, with the value frozen and not replaceable;
2. two concurrent principals, each seeing only its own access;
3. a bearer value outside RFC 6750's `b64token` grammar answered 401;
4. a duplicate header answered 401;
5. a refusal answered 401 with `WWW-Authenticate`;
6. cold, answered 503 with nothing downstream run;
7. a core that throws an error whose message contains a subject, answered 503 with only the stage
   logged.

Tests 3 and 4 expected outcomes the design no longer has. In the real layer's suite, test 3 checks
that such a value reaches the exchange, and test 4 expects 400.

### Typing `res.locals`

```ts
declare global {
	namespace Express {
		interface Locals {
			readonly usher?: unknown;
		}
	}
}
```

This declaration lives in the Express bridge package, never in usher-types. Both
`@types/express-serve-static-core` 4.19.9 and 5.1.3 declare a global `Express.Locals` and type
`locals` as `LocalsObj & Locals`, so one augmentation covers both majors (read from source).
Arranger's lockfile resolves 4.19.8, which declares the same global (read from source).

Under TypeScript 7.0.2, 5.9.3 and 5.8.3, against both 4.19.9 and 5.1.3 (run):

| Code                                       | With the declaration                               | Without it         |
| ------------------------------------------ | -------------------------------------------------- | ------------------ |
| `readAccess(res.locals).principal.subject` | compiles                                           | compiles           |
| `res.locals.usher.principal.subject`       | TS18046: `'res.locals.usher' is of type 'unknown'` | compiles, as `any` |
| `res.locals.usher = { version: 1 }`        | TS2540: cannot assign to a read-only property      | compiles           |
| `res.locals.anythingElse`                  | `any`, as before                                   | `any`              |

Typed as `UsherRequestAccess` instead, a direct read compiles with the full type, which leaves the
decided rule that adapters read only through `readAccess` a convention. Typed `unknown`, the compiler
enforces it. The declaration reaches only programs that include the bridge's declarations, so an
adapter that imports usher-types alone still sees `any`.

## The stores

### What each holds

| Store     | Key      | Holds                                                                                                                   | Dropped                                                                                                                                          |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| positive  | digest   | the subject and its per-audience tag, the resource names, the interned results, `openTierOnly`                          | at the earliest of the Usher token's `exp`, receipt plus the TTL on the monotonic clock, and the sign-in token's `exp`; on eviction; by a notice |
| refusal   | digest   | an expiry                                                                                                               | at the signed sign-in token's own `exp`, capped at now plus the TTL; for an opaque key, now plus the TTL                                         |
| failure   | digest   | whether the token was rejected or the exchange failed, and an expiry                                                    | after the fixed interval; on eviction                                                                                                            |
| anonymous | one slot | the set of grants named in the anonymous payload, its results, its frozen access value, its expiry, a generation number | by a notice, for good; replaced on refresh                                                                                                       |

A hit in the failure store answers without asking the controller: 503 for a rejected token, and the
per-principal degraded path for a failed exchange. A broken controller is then not asked on every
request, and the bridge still recovers within one interval.

Reading `exp` from a sign-in token the bridge never validates is sound in both stores that use it
(reasoned). For a positive entry, the digest binds the exact bytes the controller accepted, so that
acceptance authenticates the claim. For a refusal, a forged `exp` can only shorten the refusal, since
the TTL caps it.

The anonymous slot discards its payload after rendering, as
[jose for the Usher token](jose-usher-token.md) requires of every payload. It keeps the set of grants
named in the payload, each as a resource, a category, an entity, an action and any field partition.
That set is the input definition A compares against, and nothing else needs the payload once the
anonymous results are rendered (reasoned; not built).

### What each notice drops

Every removal runs through one `onRemove` hook, which keeps the subject-tag index in step. A removal is
an eviction, an expiry, a delete or a clear.

| Notice kind | Drops                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `principal` | every entry indexed under that subject tag                                                                 |
| `category`  | every entry naming the resource, found by scanning; the anonymous entry too if it names it, then a refetch |
| `baseline`  | every positive entry and the anonymous entry, then a refetch                                               |
| `global`    | the positive store, the refusal store and the anonymous entry                                              |

A 410 from the stream also drops every positive entry and the anonymous entry, as the stream note sets
out.

**The baseline drop covers signed-in entries because every signed-in payload carries the baseline as
its floor.** Dropping the anonymous entry alone would let a narrowed baseline reach signed-in
principals for up to one TTL, while the bar bounds revocation by the poll interval and the grace
period. The controller clears its payload cache with it, and the in-flight bound holds the rush of
exchanges that follows
([decisions.md](../../../design/decisions.md#a-category-change-is-announced-to-the-applications-that-serve-the-resource)).

**A category notice drops the anonymous entry only when the anonymous payload names the resource.**
[decisions.md](../../../design/decisions.md#a-category-change-is-announced-to-the-applications-that-serve-the-resource)
drops every cached token naming that resource, signed in or not. An anonymous payload that does not
name the resource holds nothing there to revoke, and a resource that gains open access is the safe
direction, reached at the next refresh.

### Scanning rather than indexing by resource

| Scan                                     | Time           |
| ---------------------------------------- | -------------- |
| 10,000 entries naming 300 resources each | 7.5 to 10.7 ms |
| 50,000 entries naming 300 resources each | 37 to 42 ms    |
| 50,000 entries, none naming the resource | 30 to 42 ms    |

A resource index at those sizes would hold 3,000,000 and 15,000,000 memberships. The scan blocks the
event loop for as long as it runs, once per category notice. Those notices are rare enough to afford
it.

### Memory per entry

| Held per entry, for a principal naming 300 resources | Heap     |
| ---------------------------------------------------- | -------- |
| the decrypted payload, with `offeredCategories`      | 99.3 KiB |
| a `Set` of 300 resource names                        | 10.1 KiB |
| a rendered narrowing for one key                     | 3.1 KiB  |

An entry therefore never keeps the payload, and results are interned. Resource sets are worth
interning too, or replacing with a bitset over resource identifiers, because every payload with the
baseline on names every open resource. Fifty thousand entries each holding its own `Set` of 300 names
come to about 490 MiB (arithmetic, not measured). A scan over entries that each held their own `Set`
peaked at 1.34 GB resident (measured).

### A map written for the bridge, against lru-cache 11.5.3

Each store is a `Map` kept in recency order, with an absolute expiry per entry and one removal hook.
It is about 40 lines, has no timers of its own, and drops an entry at its exact expiry instant.

|                                                 | lru-cache 11.5.3                                                                                                                                                                                       | map written for the bridge    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| dependencies                                    | none; licence BlueOak-1.0.0                                                                                                                                                                            | none                          |
| injected clock                                  | through its `perf` option                                                                                                                                                                              | yes                           |
| timers of its own                               | `ttlResolution`, default 1 ms, caches a clock reading and clears it by `setTimeout`; a read within that window of an earlier read sees the cached reading and misses a clock advanced in the same tick | none                          |
| expiry                                          | a TTL relative to when the entry was set                                                                                                                                                               | an absolute instant           |
| at exactly the expiry instant                   | still served, since its staleness test is strict (read from source, then run)                                                                                                                          | dropped, as a JWT `exp` means |
| an entry set at time 0                          | never expires, since a start time of 0 reads as no TTL; node:test's mocked `Date` starts at 0 (run: set at 0, still served at 1,000,000)                                                               | an ordinary instant           |
| removal hook                                    | `dispose`, with a reason                                                                                                                                                                               | `onRemove`                    |
| flood of 100,000 refusals into a bound of 1,000 | 14 to 18 ms                                                                                                                                                                                            | 30 to 33 ms                   |

Both kept all 100 positive entries through the flood. Both pass the same store suite once lru-cache
gets `ttlResolution: 0` and the boundary is tested one millisecond past expiry. The map written for
the bridge is exact at the boundary, has no hidden timers, and has no falsy test on a start time. A
smaller dependency surface also suits a security library. The 15 ms difference over 100,000 refusals
is no reason to take lru-cache.

## Exchanges

### One flight per digest

`createSingleFlight(max)` is a `Map` from digest to a promise of an outcome. The work is deferred by
one microtask, so the flight is registered before anything runs. When the flight settles, the map
entry is deleted only if it is still the same flight. The work never rejects: a refusal is an outcome
value, so every waiter learns of it the same way.

| Run                                         | Exchanges                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ten concurrent requests on one digest       | 1                                                                                          |
| five concurrent requests on a refused token | 1; all five refused, and the next request answered from the refusal store with no exchange |
| a bound of 3, five distinct tokens at once  | 3; the other two answered 503 before the controller replied, each logged as overloaded     |

Requests joining an existing flight do not count against the bound. The bound is one budget shared by
every new digest. The flood of distinct junk credentials that can hold it is an accepted trade, set
out in [Sign-in signature precheck](signin-signature-precheck.md). The prototype logged every
overloaded request, so a flood of requests became a flood of log lines, which the aggregated event
replaces.

### Timeout

Each flight carries its own abort signal, from an `AbortController` that a `setTimeout` aborts, and
the timer is cleared when the flight settles. A client disconnecting therefore cannot cancel an
exchange that others are waiting on. node:test's mock timers drive that form whenever `setTimeout` is
mocked (run). They drive `AbortSignal.timeout` only when it is listed among the mocked APIs, and the
mocked signal then aborts with an `AbortError`, where the real one aborts with a `TimeoutError`
(run). The `AbortController` form behaves the same in tests and in production, and code never
branches on the abort reason's name.

A fetch-based client against a controller on a local port mapped its outcomes as follows:

| Controller        | Outcome                                      |
| ----------------- | -------------------------------------------- |
| never answers     | timeout, after 306 ms against a 300 ms limit |
| answers 401       | refused                                      |
| answers 500       | a status failure                             |
| nothing listening | a network failure                            |

`new URL('/exchange', base)` drops the base URL's path. `new URL('exchange', base)` keeps it only when
the base ends in `/` (run). Configuration therefore normalizes `controllerUrl` to end in `/`, and
every request URL is built relative to it.

### Reading the answer

| Controller answer                                                                                                                  | Outcome     | Held           | The request gets                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| success, token accepted                                                                                                            | granted     | positive store | access                                                                                                    |
| success, token rejected, `sub` not matching the kind of exchange, or `sub` differing from a three-part sign-in token's own subject | malformed   | failure store  | 503                                                                                                       |
| 401                                                                                                                                | refused     | refusal store  | 401                                                                                                       |
| timeout, network failure, 5xx or 408                                                                                               | failed      | failure store  | the anonymous results, `openTierOnly` and `suspended`, subject null; 503 with no usable anonymous payload |
| 429, or any other status                                                                                                           | unavailable | no             | 503, logged as `token.exchangeFailure` with cause `status`                                                |
| beyond the in-flight bound                                                                                                         | overloaded  | no             | 503, counted in the aggregated `token.exchangeFailure` event with cause `overloaded`                      |

Mapping every status other than 401 to a failure fails open. With a simulated controller that refused
an identity with 400 or 403, a client mapping that way served the credential the open tier (run). A
429 read as a failure would likewise serve every signed-in person the open tier for as long as the
controller sheds exchanges. Reading any other status as a refusal, answered 401, would tell a portal
to sign the person out over what may be a bridge defect or a busy controller. A 408 stays a failure,
because it reports a timeout, which the contract already treats as one. A controller that sheds with
503 rather than 429 lands on the failure path. The registered `token.exchangeFailure` carries no
status code, so its cause `status` reads the same for a 429 answered 503 and for a 5xx served the
open tier.

How the token is decrypted and validated, and why `sub` is bound to the kind of exchange, belongs to
[jose for the Usher token](jose-usher-token.md).

### A notice that overtakes an exchange

1. An exchange starts.
2. A notice is applied that names that principal, names a resource named in the coming payload, or
   covers everything.
3. The answer, computed before the notice, arrives. Cached, it would honour a revoked grant for up to
   one TTL.

The core keeps a notice epoch and a bounded log of applied notices. After decrypting, it asks whether
any notice applied since the flight began affects the payload: its subject, a resource it names, or a
global notice. If so, the answer is discarded for every waiter and exchanged once more. If the log no
longer reaches back to the flight's start, the payload is treated as affected. The check runs after
the last `await`, and rendering and the cache write follow it synchronously, so no notice can land
between the check and the write (reasoned: no other callback runs between two statements with no
`await` between them). Measured: two exchanges when the notice named the principal, one when it named
somebody else. The anonymous refresh runs the same check.

The notice stream adopts this test. Every waiter on a discarded answer exchanges again, including
waiters who joined before the notice. An answer overtaken twice serves the open tier, marked
`suspended`. The prototype served the open tier when the second answer was overtaken too, before the
mark existed. Notices are rare, so this case is rare too (reasoned).
[audit-events.md](../../../design/audit-events.md) registers `token.overtaken` for a discard followed
by another exchange, and registers no event for a second discard, which ends the flight.

## Rendering

### What rendering produces

`renderKey(payload, registration)` is pure:

- A key open by configuration gets `allow`.
- A key needing a resource list, with that list missing or empty, gets `deny` with
  `unknown-resource`.
- A resource is admitted to a key only if it is in the key's resource list, when one is given, and
  every concrete category it offers, of either scope, is mapped by the key or declared absent from it.
  Otherwise it is withheld from that key alone, and `category.unmapped` is logged once per key and
  category.
- Only `global.` entries carrying `record` with `view` count. A `resource.` entry earns nothing and is
  recorded as `category.unenforced`.
- An entry carrying `field` earns no clause in version 1.
- Each held mapped category, in code-unit order, gives `and(in(resource, [resources]), in(category, [value]))`.
- The unmarked clause is `and(in(resource, [resources]), not(in(category, [every mapped value])))`. On a
  key mapping no concrete category, it is the resource test alone.
- All clauses go under one `or`, even when there is one clause, so every narrowing has the same shape
  and structural comparison holds, and usher-types pins that form.
  [glossary.md](../../../design/glossary.md) ("Filter, predicate, clause") still describes a
  one-grant filter as a single clause. No clauses gives `deny` with `no-grants`.

Sorting uses code-unit comparison, never `localeCompare`, so the output is byte-identical across
processes. Reversing every map in a payload left the output unchanged (run).

`offeredCategories` is carried by the
[payload type](../../../design/security-workflow.md#the-payload-as-a-type), and decisions.md
("A catalogue's category gap is found by the bridge") marks the check that reads it as proposed. If
it is not adopted, the bridge cannot tell which resources offer an unmapped category. The only closed
fallback it can implement alone drops the unmarked clause for the whole key, which hides every
unmarked record from that key. The other option, rendering unmarked as before, serves records
carrying the unmapped category as open.

### What it was checked against

- The visible records matched step 1's fixture rows for cases 1, 2, 5, 9 and 19, which the
  [test plan](../../bridge-tests.md) ("The fixtures") names as the bridge's expected outputs. Case 5's
  structure equals the canonical form literally.
- All 35 corpus cases, rendered for three keys, passed the request-access validator: 4 denials, 35
  allows and 66 narrowings.
- With `resource.pilot` mapped, a payload holding `global.unmarked` and `resource.pilot` rendered from
  the unmarked entry alone, with pilot in the excluded list.
- With `community-governed` unmapped, case 5 saw h1, h2 and l1: REEF_ARCHIVE was withheld from that
  key alone.
- The startup anonymous fetch logged `category.unmapped` once, before any request. Two later payloads
  naming the same pair logged nothing more.
- A payload whose `offeredCategories` disagreed with its `permissions` was rejected as malformed.

Passing the validator shows that a result is well formed, not that it is right. Both gaps below passed
it.

### Two gaps that rendered openly

**A field partition rendered as the whole record.** Case 24b holds HEART_STUDY's unmarked records with
`record.view` and a `field` entry naming only `global.clinician`. Rendered without regard to `field`,
the entry earned the full unmarked clause, so every column of those records would be served (run).
[token-calculation.md](../../../design/token-calculation.md) expects the clinician columns and no
others.
[decisions.md](../../../design/decisions.md#an-unimplemented-capability-fails-closed-only-where-the-action-has-no-path)
rates an unenforced `field.view` as open and severe, and [phase-1.md](../../phase-1.md) keeps
field-level restriction out of MVP. Earning no clause keeps the principal's other grants working,
where treating the payload as malformed would refuse everything. The cost is visible in case 24: that
principal sees none of HEART_STUDY's unmarked records through the entry, fewer than an anonymous
visitor sees. `field: {}`, which phase-1.md suggests as a stub, reaches no field category and is
treated the same way.

**A missing category field rendered every record.** A key that mapped concrete categories but named no
category field had its unmarked clause rendered as the resource test alone. The anonymous case 02 then
saw records carrying concrete categories, and the result passed the validator (run). `register`
refuses that registration at startup.

### Grants held only in another key

Without a resource list on a record key, a principal whose grants all sit on resources served by
another key gets a narrowing that matches nothing in this key, not a deny (run). With the list given,
the same payload rendered `deny` with `no-grants`. The producer rule in
[decisions.md](../../../design/decisions.md) ("every grant sits in other catalogues" is a deny) needs
the bridge to know which resources each key serves, so only a key with a list can apply it. The
difference reaches people: a deny is named at catalogue level, while an empty narrowing reads as
nothing found. The [test plan](../../bridge-tests.md#the-fixtures) carries both rows.

### Interning

Rendering costs about 130 µs for two keys over 300 resources, once per exchange. The interning key is
the results serialized as JSON, about 14.5 µs. Plain `JSON.stringify` is stable here only because
rendering sorts and the registration's order is fixed. Equal keys map to one frozen object, from a
bounded pool with a `WeakMap` fallback for objects the pool has evicted; a pool of 4,096 was run. The
corpus's 35 payloads render to 10 distinct result sets for one key. For cases 3 and 4, the shared
object is the anonymous principal's own.

## openTierOnly

Two definitions were compared over the corpus:

- **A:** every grant in the principal's payload, by resource, category, entity and action, also
  appears in the anonymous payload.
- **B:** this application's rendered results are exactly the anonymous principal's.

| Case    | What the principal holds beyond the anonymous payload | A     | B     |
| ------- | ----------------------------------------------------- | ----- | ----- |
| 3, 4    | nothing                                               | true  | true  |
| 24, 24b | a `field` partition on HEART_STUDY's unmarked records | false | true  |
| 26      | `revision.view`                                       | false | true  |
| 27      | `artifact.create`                                     | false | true  |
| 30      | MEMBERS_ARCHIVE, the registered tier                  | false | false |

Cases 19 and 19b each come with a configuration of their own. Compared with their own configuration's
anonymous payload, the two definitions agree on both; compared with the default configuration's, they
appear to differ, which says nothing about either definition.

**A is the definition the design allows.** [adapter-integration.md](../../../design/adapter-integration.md#known-requirements)
("Known requirements") says the signal describes the principal, anonymous or holding nothing beyond
the open tier, and never whether anything was withheld from a result, because a signal that depends
on what was withheld is an existence oracle. Its "Decided" section words `openTierOnly` as the
results holding the open tier alone, which describes the results rather than the principal, but it
too rules out saying whether anything was withheld. B compares rendered results, and rendering
depends on the registration and on withholding driven by `offeredCategories`.
A resource gaining an unmapped category would flip B to true for the people holding grants on it. A
reads the two payloads alone. B's advantages, a pointer comparison against interned results and no
payload needed, do not outweigh that.

A field partition is a restriction, not an extra, so under A case 24 is false: the principal holds
something absent from the anonymous payload. The registered tier, case 30, is false under both. Under
A, the comparison runs against the anonymous grant set held when the exchange runs, which is why the
anonymous slot keeps that set. The stored value stands until its entry ends, which needs nothing
more. Recomputing it on each anonymous refresh would need every entry to keep its own grant set, at a
cost in memory per entry. A's cost per exchange was not measured.

## Time

| Clock           | Default             | Read for                                                                                                                  | Why this clock                                             |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| wall clock      | `Date.now()`        | the expiry of entries and refusals against `exp`; jose's `currentDate`; event times                                       | `exp` is wall time                                         |
| monotonic clock | `performance.now()` | the grace period, on every request; the poll deadline; the start of a check, passed to `confirmChannel`; each entry's TTL | a step in the wall clock must not open or close the window |

**Why the grace period needs a monotonic clock.** With the grace period written as `Date.now()`
arithmetic, a 30 s backward step of the wall clock, taken 30 s after a check, left the elapsed time
reading 30 s once 60 s had passed, and the grace period lapsed only at 90 s (run, under a mocked
`Date`). The bar bounds revocation by the poll interval and the grace period, so a clock step must not
stretch either. The W3C High Resolution Time specification, which `performance.now()` implements, says
the monotonic clock's current time "never decreases, so it can't be changed by system clock
adjustments" (read from the specification, not run against a clock step).

**Why the core reads it on every request, rather than relying on a watchdog timer.** A watchdog timer
re-armed by each check also involves no wall clock, but it fires only when the event loop reaches it.
With a 50 ms grace period, a second request pipelined behind a handler that blocked the loop for
200 ms was handled 205 ms after the check, before the overdue watchdog had fired; a monotonic reading
in the same handler saw the lapse (run, on a local port). The timer that remains only logs the lapse
when no request arrives, as step 6 of the trace shows.

**How tests drive it.** node:test's mock timers do not drive `performance.now()`: it advanced 0 ms
across a mocked hour, while the mocked `Date.now()` advanced the full hour (run). Tests therefore
inject both clocks. A test that read its monotonic clock from the mocked `Date.now()`, kept its wall
clock as a separate offset, and stepped only the wall clock back by 30 s saw the mode stay normal at
exactly 60 s and turn uncertain 1 ms later, with one lapse logged (run). `mock.timers.setTime` cannot
stand in for a wall-clock step, because it moves the mocked timers' own clock too: a 60 s watchdog
armed before a 30 s backward `setTime` had not fired after 60 s of ticks (run).

Those runs read their clocks from the mocked `Date`. The bridge's own tests follow
[Packaging the bridge](packaging-and-toolchain.md) instead: they pass in fake clocks and mock only
`setTimeout` among the timers, never `Date`. The notice stream times a check from its first page's
start, and reads that start through the injected monotonic clock, so those tests drive it too. The
exchange timeout runs on the global `setTimeout`, and so does the timer that logs a lapse, re-armed
after each firing rather than run by `setInterval`, so mocking `setTimeout` alone drives both
(reasoned).

jose takes the wall clock as `currentDate`. It floors the current time to whole seconds, so with a
tolerance of 0 it accepts a token until 1 ms before its `exp` in milliseconds and expires it from
that instant on, the instant at which the stores drop its entry (read from source, then run). Its
options belong to [jose for the Usher token](jose-usher-token.md).

## Logging

Each event name maps to its exact fields. `createEventLog(logger, clock, source).emit(name, data)`
copies only the allow-listed fields, so a cast that smuggles in extra fields still loses them. It wraps
them in the CloudEvents envelope: `specversion`, `id`, `source`, `type` as `bio.overture.<name>`,
`time` from the wall clock, and severity. Severity `info` goes to `logger.info`, `warning` to
`logger.warn`, and `critical` to `logger.error`. The `logger` parameter has the shape of a Pino
logger, the structured logger the [technology stack](../roadmap/technology-stack.md) decides, so a
host passes its own Pino instance.

Every event the bridge emits, as registered in [audit-events.md](../../../design/audit-events.md):

| Event                             | Emitted when                                                                                                                        | Fields                                                                                                                           | Severity   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `revocationChannel.modeChange`    | the mode changes among `cold`, `normal` and `uncertain`                                                                             | `fromMode`, `toMode`, `reason`; the reasons include holding no anonymous payload and a probable key mismatch                     | `critical` |
| `category.unenforced`             | a `resource.` entry, or an entry carrying `field`, reaches nothing; once per such entry in each payload received, never per request | `userId`, `resourceId`, `category`, `payloadVersion`, `reason` (`notImplemented`), `entry` (`resourceScope` or `fieldPartition`) | `warning`  |
| `category.unmapped`               | a resource is withheld from a key, once per key and category                                                                        | `catalogue`, `category`                                                                                                          | `critical` |
| `credential.refusal`              | an identity is refused                                                                                                              | `origin`: `controller`, `localExpiry` or `cachedRefusal`                                                                         | `info`     |
| `token.exchangeFailure`           | an exchange cannot complete, whether failed or unavailable, or requests are overloaded                                              | `cause`: `timeout`, `network`, `status` or `overloaded`; an overload event adds `count`                                          | `warning`  |
| `token.rejection`                 | an Usher token is rejected                                                                                                          | `reason`, one of the jose note's reason codes                                                                                    | `warning`  |
| `notice.applied`                  | a notice is applied                                                                                                                 | `kind`, `entriesDropped`                                                                                                         | `info`     |
| `token.overtaken`                 | an exchange answer is discarded because a notice affecting it arrived while it was in flight, and the bridge exchanges again        | none                                                                                                                             | `info`     |
| `catalogue.resourceListMissing`   | a key needing a resource list has none                                                                                              | `catalogue`                                                                                                                      | `critical` |
| `credential.malformed`            | no single credential can be read, or one arrives in the query                                                                       | `reason`: `multiple`, `scheme` or `query`                                                                                        | `info`     |
| `bridge.internalError`            | an unexpected failure inside the layer or the core                                                                                  | `stage`                                                                                                                          | `critical` |
| `revocationChannel.pushReconnect` | the push is silent past its idle timer and reconnects                                                                               | `reason`                                                                                                                         | `info`     |
| `revocationChannel.reset`         | the stream answers 410, and every positive entry and the anonymous entry are dropped                                                | none                                                                                                                             | `warning`  |
| `revocationChannel.malformed`     | a notice or a poll answer fails to read                                                                                             | `reason`, a fixed code                                                                                                           | `warning`  |

The last three events come from the channel layer, as
[Revocation notice stream](revocation-notice-stream.md) sets out.

Three rules from [audit-events.md](../../../design/audit-events.md) shape these names and severities:

- No word is both an entity and an action. The catalogue already has `token.exchange`, where exchange
  is the action, so a refused identity is `credential.refusal` and a failed exchange is
  `token.exchangeFailure`. The refusal's field is `origin`, because the envelope owns `source`.
- Every event carries `actorType`, a payload property in `data` rather than an envelope attribute,
  since CloudEvents allows only lower-case letters and digits in attribute names.
- Severity is `info`, `warning` or `critical`. `category.unmapped`, which decisions.md calls
  error-level, is `critical`, the severity that logs at error level.

`category.unenforced` is one event per unenforced entry in each payload received, never one per
request, and its `entry` field tells a resource-scoped entry from a field partition. Its `reason` is
`notImplemented` for both.

What the builders guarantee, and what they do not:

- `reason`, `cause`, `origin`, `entry`, `stage` and `kind` are closed enumerations.
- An error's message is never logged.
- `resourceId`, `category`, `catalogue` and `userId` are typed as strings. The allow-list stops
  extra fields, not what a string field holds. Keeping a token or a record identifier out of those
  fields is a convention of the call sites, not a property of the types.
- No event carries any part of a sign-in token, its key identifier included.
- `category.unenforced` and `category.unmapped` are the only events carrying values taken from the
  payload. `category.unmapped` carries no principal at all. `category.unenforced` is the one event
  allowed to carry a grant, and carries a single one, because it records that grant reaching nothing.
- `token.exchangeFailure` carries no `userId`: before an exchange succeeds, the bridge has no trusted
  subject to put there (reasoned).
- A scan of every event logged by the Express suites found no credential, no JWE and no `permissions`.
  Those suites logged only 7 events of 4 kinds, though, and none of them carried payload values.

## Configuration

Configuration reaches the core as typed parameters, and the core never reads `process.env`.
Construction throws a `BridgeConfigurationError` whose message names the parameter and never its
value. Construction refuses (run, except where marked):

- a `key` that is not 43 base64url characters in canonical form, the first steps of the startup check
  in [jose for the Usher token](jose-usher-token.md) (run as a standalone check);
- an empty audience;
- a plain `http` controller URL to any host other than loopback (run as a check on the literal
  `127.0.0.1` alone);
- a `graceMs` not above `pollIntervalMs`;
- an empty `payloadVersions` list;
- a configuration in which 1.1 T + 2D is not below G, read from `pollIntervalMs`, `pollDeadlineMs`
  and `graceMs` (not built);
- a `stores.failureHoldMs` outside its bounds (not built);
- a `localRefusalClockToleranceMs` that is not a finite, non-negative number (not run at
  construction).

**Two clock tolerances, never one.** The local refusal of a three-part sign-in token whose own `exp`
has passed uses the controller's tolerance, as decisions.md requires. No design document says how
the bridge learns that value, which is open question 1. Carried in configuration as
`localRefusalClockToleranceMs`, as the surface carries it, it must match the controller's value with
nothing to check it. The Usher token's tolerance is 0, fixed
in the decrypt call with no parameter, and the jose note owns it. Passed to jose, a millisecond value
read as seconds admitted a token an hour past its `exp`, an undefined value over 1,000 made every
token fail, and -61 refused a live token (run). jose reads `clockTolerance` in seconds, so a nonzero
Usher token tolerance, if one ever became configurable, would be named in milliseconds, validated as
the local refusal's is, and divided by 1,000 at the jose boundary.

**Loopback means three spellings.** A check on the literal `127.0.0.1` refused `http://localhost` and
`http://[::1]` (run). The check accepts all three.

**Plain HTTP inside a cluster is refused.** The exchange carries the sign-in token, so plain HTTP would
expose bearer credentials on the pod network. Refusing it is the closed side.

**Non-empty lists in usher-types' validators.** They are written `zod.tuple([item], item)`, which with
zod 4.6.5 infers a non-empty tuple. A recursive SQON validator written with a getter then typechecks
against the hand-written `NonEmpty` SQON type, under TypeScript 7.0.2 and 5.8.3. It refuses an empty
value list, an empty group, a pivot key and `not-in`. `zod.array().min(1)` infers a plain array and
fails that assignment.

## In a host application

None of this was tested inside Arranger. It is read from Arranger's source, from RFC 9111, and
reasoned.

- **After the health routes.** A cold bridge answers 503 to everything mounted behind it. A liveness
  route behind the bridge would make Kubernetes restart pods while the controller is down. A readiness
  route can read `mode()`, so a cold replica leaves rotation instead.
- **After CORS.** Otherwise a cold bridge answers preflight requests with 503.
- **Before body parsing.** Refused and cold requests are then answered without parsing a body.
- **Adapters read the access through `readAccess(res.locals)`, never from a merged copy.** Spreading
  `res.locals` into another object copies `usher` into an ordinary writable property, and a later
  spread with a `usher` key replaces it. Arranger's GraphQL router builds its context by spreads
  today. A replacement that `attachAccess` did not record makes `readAccess` throw, because of the
  `WeakSet` check under "Attaching", so a replaced value fails closed: the request errors rather than
  being served the replacement. Reading `res.locals` directly avoids that error.
- **Caching headers.** RFC 9111 §3.5 already forbids a shared cache to reuse a response to a request
  carrying `Authorization`, unless the response opts in with `public`, `s-maxage` or
  `must-revalidate`. It does not cover a credential carried in a cookie, which a portal's server side
  may use. The layer therefore sets `Cache-Control: private, no-store` on every response it lets
  through, with `Vary: Authorization`, or `Vary: Cookie` when its extract function reads a cookie. A
  host that sets `public` or `s-maxage` on such a response undoes this.
- **Request logging.** A request logger that records headers redacts `Authorization`. A credential
  never travels in a URL, which request logs record.
- **Versions.** Arranger's search-server is an ESM package on `express` ^4.18.2, `@types/express`
  ^4.17.21 and `typescript` ^5.8.2, and its GraphQL router module also depends on `express` ^4.18.2.
  Its lockfile resolves express 4.22.2 and, at the root, TypeScript 5.9.3. The Express suites ran on
  4.22.3.

## For the bridge's own tests

- Every signed-in case in [principals.json](../../../design/conformance/principals.json) carries the
  same `sub`: 31 cases, with the other 4 anonymous. A test that two principals never share an entry
  passes vacuously unless the controller mock stamps a distinct subject per credential. How the mock
  mints tokens belongs to the jose note.
- Test files are named `*.test.ts`, and shared helpers take a name outside the test glob, as
  [Packaging the bridge](packaging-and-toolchain.md) sets out.
- **The local refusal's tolerance is refused when undefined, NaN, infinite or negative**, at
  construction, with the parameter's name and not its value.
- **The grace period lapses on the monotonic clock.** With the wall clock stepped back 30 s, the mode
  turns uncertain 1 ms after 60 s on the monotonic clock, not at 90 s.
- **A request reads the mode itself.** With the monotonic clock advanced past the grace period and no
  timer ticked, a request is already served as uncertain.
- **The exchange timeout fires under mock timers** with only `setTimeout` mocked, and the abort
  reason's name decides nothing.
- **The Usher token's tolerance is 0 at jose.** A token is accepted 1 ms before its `exp` in
  milliseconds and refused at that instant.
- **A host's `extract` that throws synchronously** gets 503 with only the stage logged, the same as a
  rejection from the core.

## Not built or not run

- No push or poll channel was built. Recovery ordering rests on the core's contract that
  `confirmChannel` is called only after a check's notices are applied.
- No core test has driven an exchange timeout under mock timers. The `AbortController` form was run on
  its own.
- The two-clock design, the eight-member surface, the string key and its import in `start`, and the
  clock tolerances were checked as standalone runs and typechecks, not inside the prototype core.
- The reading of a 429 was not run.
- The real core has no default controller client yet. The fetch client was checked on its own, and the
  exchange request's body belongs to the exchange's topic.
- [Packaging the bridge](packaging-and-toolchain.md) built a sample surface with tsdown and
  type-checked its TypeScript 7 declarations from TypeScript 5.8 to 7.0 consumers. The real core's
  surface was not built or consumed that way.
- Stage's server side was not explored. Its layer may need a cookie credential source, and it may run
  outside Node.
- The anonymous refresh schedule, for example at 80% of the payload's lifetime and retried each poll
  interval, was not built.
- Memory with interned resource sets or bitsets was not measured at scale.
- The Express suites ran against a stand-alone application, not inside Arranger's search-server. Code
  that replaces `res.locals` wholesale would lose the value, and `readAccess` would then throw, which
  fails closed; that was not tested.
- `Vary`, `Cache-Control` and CORS preflight behaviour were reasoned, not tested.
- The artifact provenance ceiling, definition A and its cost, the anonymous grant set, and the
  corrected registration checks were not built, so none of them was run.
- Node's monotonic clock was not run against a real step of the system clock.
- These came after the prototype and were not built: the `suspended` mark, the short failure store
  and its configuration, the second import as an HKDF key, the subject-tag index, the baseline drop
  of every positive entry, the TTL on the monotonic clock, the 400 answers, the 1.1 T + 2D < G check
  and its `pollDeadlineMs` parameter, the loopback check's three spellings, the `try` around the
  layer's synchronous work, the Usher token's tolerance fixed at 0 with no parameter, the aggregated
  overload event, `category.unenforced` for a `field` entry, the null subject in uncertain mode, the
  503 for a rejected token held in the failure store in uncertain mode, the check of `sub` against a
  three-part sign-in token's own subject, and the `WeakSet` check in `attachAccess` and `readAccess`.
- The registered event names and fields were not built either. The prototype emitted working names
  where the catalogue now has `credential.refusal` with `origin`, `token.exchangeFailure`,
  `token.overtaken`, and `catalogue.resourceListMissing` with `catalogue`.

## Open questions

1. **How the bridge learns the controller's clock tolerance.** The local refusal uses the controller's
   tolerance, and no design document says how the bridge learns it. Option (a): configuration, as
   `localRefusalClockToleranceMs`, which is simpler but can drift from the controller's value unseen.
   Option (b): the controller states it in the exchange answer or at startup, which cannot drift.
2. **If `offeredCategories` is not adopted.** decisions.md proposes the check that reads it. Without
   it, the bridge either drops the unmarked clause for the whole key, the only closed fallback it can
   implement alone, or keeps rendering unmarked as before, which serves records carrying the unmapped
   category as open, as "What rendering produces" sets out.
