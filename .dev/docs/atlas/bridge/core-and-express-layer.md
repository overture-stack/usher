# Bridge core and Express layer

Checked on Node 24.16 on macOS against the npm registry (express 5.2.1 and 4.22.3, jose 6.2.12,
zod 4.6.5, lru-cache 11.5.3, TypeScript 7.0.2, 5.9.3 and 5.8.3, `@types/express-serve-static-core`
4.19.9 and 5.1.3, tsx 4.23.15), 2026-10-04. Every behaviour stated here was run there, against a
prototype of the core and its Express layer or against a standalone check, neither of them published,
unless the sentence says it was read from source, from a specification or from the design, or
reasoned. The core and its Express layer are built in the Express bridge package, test first; "Not
built or not run" lists what no run covered.

The bridge is the shared library that each application protected by Usher, Overture's access
enforcement system, embeds to turn a request's credential into that request's access. This note settles its
structure: one core with no web framework in it, a thin Express layer over that core, and the core's
state, stores, clocks, rendering, events and handling of concurrent requests. Four neighbouring topics
have notes of their own: [jose for the Usher token](jose-usher-token.md),
[Revocation notice stream](revocation-notice-stream.md),
[Sign-in signature precheck](signin-signature-precheck.md) and
[Packaging the bridge](packaging-and-toolchain.md).

## Decisions

These state the design. A decision recorded in another design document links that document. One
marked proposed awaits review, and the design document it links marks it proposed. The sections
after the decisions give the evidence, and "Not built or not run" lists what the prototype did not
carry.

**Structure and surface**

- The core sits inside the Express bridge package, under a framework-free directory that a test keeps
  free of Express imports, as [Packaging the bridge](packaging-and-toolchain.md) sets out.
- The core moves to a package of its own when a second framework's bridge starts.
- `createBridgeCoreWithSeams(configuration, seams)` holds the typed configuration, which `start`
  checks, and returns nine members: `applyNotice`, `mode`, `refreshAnonymous`, `register`, `report`,
  `reset`, `resolve`, `start` and `stop`. `report` carries the Express layer's own two events through
  the core's event log. None of the nine renews the grace period. `confirmChannel`, which renews
  it, reaches the revocation channel seam alone, so no host can hold the bridge in normal mode. The package exports `createBridgeCore(configuration, options)` instead, which builds the core
  over the default seams and takes an optional `fetch` in `options` to reach the controller with.
- The controller client, the token reader and the revocation channel are seams: factories built at
  start from the imported keys and the checked configuration. The configuration they receive leaves
  out the application key, which only the imported keys carry. `defaultSeams` supplies the defaults:
  a controller client posting each exchange over fetch, signed by a fresh channel assertion; jose's
  token reader; and the channel's poll and push. The client and the channel fetch through undici on
  an Agent of the bridge's own, created on first use and closed when the core stops, so a global
  dispatcher the host sets never carries the bridge's traffic. A fetch the host hands
  `createBridgeCore` replaces undici's.
- A stop landing during `start` leaves the core stopped: no fetch runs, and the audience is free once
  `stop` settles.
- `stop` cancels every timer at once, and from then on starts no exchange or anonymous fetch. Its
  promise settles once a `start` still running, every exchange and anonymous fetch in flight, and the
  revocation channel's own stop have ended and the seams are closed. Every exchange and fetch in
  flight is left to finish rather than aborted. Only once `stop` settles is the audience free, so a
  host that awaits `stop` can then start another bridge on the same audience, while one started
  before `stop` settles is refused with `audienceInUse`. `stop` never rejects.
- `resolve(credential | null)` is the one operation per request, and it answers access, refused or
  unavailable.
- The bridge provides no category dictionary. The category checks read the global categories Usher
  defines and the categories each resource offers, both from the payload, as "Rendering" sets out,
  and category dictionary introspection is a post-MVP proposal in
  [adapter-integration.md](../../../design/adapter-integration.md#category-dictionary-introspection).
- A host creates the core, calls `register`, mounts the middleware and then awaits `start`, which
  imports the application key and fetches the anonymous payload.
- A refusal to start, for a second bridge on one audience, an unusable key, a configuration value
  the bridge refuses, or a seam that throws as `start` builds it or starts the channel, rejects
  `start()` with a fixed-text `UsherContractError` naming the rule. The bridge then stays cold and
  logs `bridge.startRefusal`, registered as critical in
  [audit-events.md](../../../design/audit-events.md).
- The core runs on Node only, keeping `node:crypto` and `Buffer`.
- The bridge imports no zod at runtime and has no zod peer. A package has zod as a peer only when its
  shipped source imports it, and usher-types validates by hand, never through zod at runtime, keeping
  zod as a devDependency for its tests
  ([technology-stack.md](../roadmap/technology-stack.md#decided-toolchain-for-this-repository)).
- The application key arrives as 43 base64url characters. After import the bridge holds it only as
  non-extractable `CryptoKey`s: the decrypt-only AES-GCM key for the Usher token, and the four
  subkeys derived at start from an HKDF import of the same bytes, whose base key and bytes are not
  kept, as [jose for the Usher token](jose-usher-token.md) sets out. Nothing past the import receives
  the key's text.

**Credentials and the Express layer**

- The layer reads every `Authorization` line through `req.headersDistinct`.
- Every bearer value the layer can read goes to the exchange, with no grammar check.
- API keys are presented as `Bearer`, so a key of any shape reaches the controller, and the
  [test plan](../../bridge-tests.md) answers 400 to any other scheme.
- The bridge never refuses a credential the controller would accept
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
- The bridge therefore checks no signature (decided in decisions.md on 2026-10-06). The research is
  in
  [Sign-in signature precheck](signin-signature-precheck.md).
- Two `Authorization` lines, a scheme other than `Bearer`, or an `access_token` query parameter get
  400 with `error="invalid_request"`, and are never exchanged and never served as anonymous.
- Every refused identity gets one 401 with fixed text, and the layer sends its 400, 401 and 503
  answers before anything downstream runs.
- The access value is attached deep-frozen as the data member `res.locals.usher`, non-writable,
  non-configurable and non-enumerable, declared to TypeScript as `readonly usher?: unknown`.
- `attachAccess` refuses a store that already holds `usher`, which is its contract.
- `readAccess` accepts only a member shaped as `attachAccess` leaves it, never runs an accessor, and
  returns a fresh frozen copy it has validated, so a replaced value fails closed.
- `resultFor(access, key)` reads results by own member only.
- `usher-types` is a peer dependency of the bridge, declared `workspace:^` and also as a
  devDependency, so a host holds one copy of the contract and of `SqonSchema`. There is no `WeakSet`
  and no provenance check: two copies interoperate, and the peer plus the host's own dependency is
  enough to hold one copy under pnpm, as [Packaging the bridge](packaging-and-toolchain.md) sets out.
- The layer never hands Express a promise and never calls `next(error)`, so an internal error becomes
  a 503 with fixed text and an event naming only the stage.
- A host mounts the layer after its health routes and CORS, and before body parsing.
- The layer sets `Cache-Control: private, no-store` and a `Vary` naming its credential source on every
  response it lets through.
- When the attached principal is suspended, the layer sets `Usher-Suspended: true` and appends that
  name to `Access-Control-Expose-Headers`, keeping any value already there. An anonymous principal and
  a confirmed one get neither.
- The Express layer's tests run on a real server bound to `127.0.0.1`, rather than supertest's
  listener.

**Exchanges**

- Concurrent requests on one digest share one exchange.
- A global bound on exchanges in flight answers 503 beyond it. The controller sets that bound and
  tells its bridges, since a bound each bridge set for itself would multiply with the replicas
  ([decisions.md](../../../design/decisions.md), decided on 2026-10-06). The number and how it reaches
  a bridge are open, and the bridge's own default stands in until then.
- Each exchange carries its own timeout, from an `AbortController` that a `setTimeout` aborts, never
  tied to one request.
- The anonymous refresh runs outside the bound, in its own single flight.
- A controller's 403 is a refused identity. Its 401 refuses the channel assertion, not the identity,
  so it is unavailable and never cached as a refusal. A timeout, a network failure, a 5xx or a 408 is
  a failure.
- A 429, and every other status, is unavailable: 503, not cached, and logged as
  `token.exchangeFailure` with cause `status`.
- An Usher token the bridge cannot read, whose `sub` does not match the kind of exchange, or whose
  `sub` differs from a three-part sign-in token's own subject, is treated as not received: 503, and
  never served as suspended, as [jose for the Usher token](jose-usher-token.md) sets out.
- A failed exchange serves that principal the anonymous results, marked `openTierOnly` and
  `suspended`, with its credential `unconfirmed`.
- A grant answered after the grace period lapsed during its exchange is served as the open tier,
  suspended and naming its subject for attribution alone, and answered 503 once the bridge is cold,
  since the mode is read again when the answer arrives.
- Each exchange is raced against its own timeout, so a client that ignores the abort signal cannot
  hold a flight, or its place in the bound, for good.
- A rejected token is held briefly in a short failure store, apart from refusals, so a broken
  controller is not asked again on every request (the [test plan](../../bridge-tests.md),
  "Exchange").
- The failure store holds each for a fixed interval that is configurable and bounded.
- A failed exchange is held in the same store, so a credential whose exchange keeps failing does not
  wait out the exchange timeout on every request.
- An answer overtaken by a notice that affects it is discarded for every waiter and exchanged once
  more, a test adopted by [Revocation notice stream](revocation-notice-stream.md).
- An answer overtaken a second time serves the open tier, marked `suspended` and naming the subject
  its verified Usher token carried for attribution alone, since a notice affecting the principal was
  missed, or 503 when no usable anonymous payload is held.
- An answer overtaken after `stop` is never exchanged again, since `stop` starts no exchange or
  anonymous fetch. It ends as one overtaken a second time does.
- `token.overtaken` records each discard, with `outcome` `exchangedAgain` for the first, and for the
  second or any after `stop`, which ends the flight, `servedOpenTier`, or `abandoned` when nothing was
  served. An anonymous fetch discarded twice, or once after `stop`, is `abandoned` too.

**Stores**

- Each store is a bounded map written for the bridge, not lru-cache.
- Positive entries are keyed by the SHA-256 digest of the whole credential.
- Positive entries are indexed by the subject read from the decrypted payload
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
- The index holds that subject's per-audience tag, the tag principal notices carry (proposed in
  [schema.md](../../../design/schema.md#the-notice-stream), Decide E), as
  [Revocation notice stream](revocation-notice-stream.md) sets out.
- The controller's refusals live in a bound of their own, failures in the short failure store, and
  the anonymous entry outside all of them.
- A token refused for its own `exp` is never stored, since its `exp` refuses it again on every
  request, so a stream of such tokens cannot push the controller's refusals out.
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
- The bridge is cold until a check is confirmed and it has accepted an anonymous payload since start, again when the grace
  period lapses with none held, and while the key's self-test fails.
- Cold answers 503 to every request.
- At startup, a wrong application key shows first on the anonymous exchange, whose channel
  assertion the controller refuses with 401: the bridge logs `token.exchangeFailure` with cause
  `assertionRefused` and `revocationChannel.modeChange` with reason `probableKeyMismatch`, and stays
  cold. An anonymous token failing decryption at startup is named the same way, after its
  `token.rejection` with reason `decryptionFailed`.
- Uncertain mode never exchanges, so it adds no load on the controller during an outage.
- In uncertain mode, a presented credential gets the anonymous results, marked `openTierOnly` and
  `suspended`. A live cached entry for it names its subject for attribution alone; without one, its
  credential is `unconfirmed`. Reading the entry never extends its expiry.
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
- A principal states its credential. One presenting none is `none` and never suspended. One the
  controller vouched for, through a live cached entry or this request's own exchange, is
  `confirmed`, and names its subject as `subject` while its grants hold and as
  `attributionOnlySubject` while suspended. Any other is `unconfirmed`: signed in, identity
  unconfirmed, suspended and served the open tier. This covers uncertain mode, where no exchange
  runs, and an exchange failing while the stream is healthy
  ([adapter-integration.md](../../../design/adapter-integration.md#decided);
  [glossary.md](../../../design/glossary.md)).
- The request-access validator checks each state's exact members, requires `openTierOnly` of every
  principal without a confirmed credential and of every suspended one, and refuses a `none`
  principal that is suspended and an `unconfirmed` one that is not.
- Only a poll answered within its deadline is a check (decided on 2026-10-06, in
  [security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour)),
  and the [notice stream](revocation-notice-stream.md) note builds on it. A poll left open past its
  deadline D is aborted at D, and any abort counts as no check.
- The channel layer calls `confirmChannel(checkStartedAt)` only after applying every notice of a
  check, in the same tick, with the check's start read from the injected monotonic clock.
- A wall clock, `Date.now()` by default, serves every comparison with an `exp`, jose's `currentDate`
  and event times.
- A monotonic clock, `performance.now()` by default and injected in tests, times the grace period,
  the poll deadline and each entry's TTL.
- The core reads the monotonic clock on every request, and a timer only logs a lapse when no request
  arrives.

**Rendering**

- `register` validates each registration with usher-types' `validateRegistration`, and compiles each
  record key's categories once: its global categories and each resource's own, every condition
  normalized. The compiled conditions are held in that key's own
  compiled form, never in a table shared across keys, so two keys may give one category name
  different conditions.
- Rendering runs once per exchange and interns its results. A record key's narrowing is usher-types'
  `canonicalRecordNarrowing`, which excludes what is not held, one clause per category
  ([decisions.md](../../../design/decisions.md#a-category-is-a-condition-over-records-and-a-record-needs-every-category-it-matches)).
- A record key's narrowing is served only past the bridge's two guards. The rendering guard reads it
  back and compares what it says with what the payload and the key's registration say, computed
  apart from rendering, and denies the key with `rendering-mismatch` on any difference
  ([decisions.md](../../../design/decisions.md#a-category-is-a-condition-over-records-and-a-record-needs-every-category-it-matches)).
  The clause guard then denies it with `filter-limit` when its clause count exceeds
  `filterClauseLimit`.
- usher-types exports the one condition normalizer, `normalizedCondition`, which both the bridge's
  compiled form and usher-types' rendering use, so the rendering guard never finds a difference of
  spelling alone.
- An entry carrying `field`, `field: {}` included, counts for nothing, and `category.unenforced`
  records it.
- A global category Usher defines that a record key neither defines nor declares absent denies that
  key's whole result with `unmapped-category`
  ([decisions.md](../../../design/decisions.md#a-catalogues-category-gap-is-found-by-the-bridge-from-the-categories-each-resource-offers)).
- A resource offering a resource category that a key does not define under it is withheld from that
  key alone, and falls into the key's complement.
- A category a key defines that Usher does not list, a global one, or a resource category of a
  resource `permissions` names, is never held, so its records are always excluded, and
  `category.unknown` names it.
- Those checks stay generic. The adapter turns its application's configuration, whatever its shape,
  into the one registration read by the bridge, and the bridge only compares that registration with
  the categories named in the payload.
- `register` refuses a category both declared absent and defined. Absence is the last resort, for a
  catalogue whose records cannot match the category.
- The category members are enforcement input only. They never reach the access value, a log line
  beyond `category.unmapped`'s, or anything a principal can see.
- `register` refuses at startup any registration that would render openly.
- A refusal names every problem of every registration, each positioned under its catalogue key, as in
  `files.resourceFieldName`. Catalogue keys are the operator's configuration, never request content,
  so naming them keeps the value-free rule, which protects payload content, and an adapter needs no
  validator of its own. For the same reason, a problem under a category or a resource names that
  key as well.
- Catalogue keys, resource identifiers and category names are all written in a position by
  usher-types' `keySegment`. A key of ASCII letters, digits, `_` and `-` is written bare after a
  dot, as in `files.categories.resource.HEART_STUDY`. Any other key is a JSON string in brackets,
  with its line breaks and control characters escaped, as in
  `["files.v2"].categories.global["global.controlled"]`. A bare segment never holds a dot, a bracket
  or a quote, so a reader always knows which form it is reading. Catalogue keys need the bracketed
  form because Arranger takes a catalogue id as a free string, so a dot or a space can be part of a
  catalogue key.
- A key knows the resources served by the payload, its `servedResources`, held or not, together with
  the key's own resource list when it has one. A record holding a known resource the principal does
  not hold is withheld through the complement, even beside a held one.
- A key's resource list is optional. Only a resource it lists is held for that key, a served one it
  leaves out falls into the complement, and only a key with one renders "every grant sits in other
  keys" as `deny` with `no-grants`. A listed resource the payload does not serve is never held, since
  no grant can name it, and is known, so a record holding it is withheld through the complement even
  beside a held one. Nothing is logged for it.
- `register` refuses an artifact key, at its `kind` and with a rule of its own, because a download
  service checks each file's own recorded sources and so needs no filter from the bridge.
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
- The revocation channel's failed checks are counted the same way, one
  `revocationChannel.failure` per cause per interval, and its stop logs the counts it still
  holds, even when the logger throws.
- The bridge's `logger` parameter is a minimal structured interface: `info`, `warn` and `error`, each
  taking an object and a message. Pino satisfies it, and the type does not require Pino, so a host
  with no Pino supplies a shim.
- `start` checks the configuration, and a refusal names the rule, never a value.
- `start` refuses any listed payload version the token reader cannot read, as
  `payloadVersionUnreadable`. The check reads the reader's own list of versions, so the two cannot
  disagree.
- `filterClauseLimit`, 1024 by default, is the most clauses a record key's filter may hold, counted as
  OpenSearch counts them. `start` holds it to a positive whole number, as it does every bound.
- `start` refuses any configuration in which 1.1 T + 2D is not below G: the ordering T + 2D < G
  of [Revocation notice stream](revocation-notice-stream.md), with the poll interval T at its 10%
  jitter maximum.
- The configuration carries all three, as `pollIntervalMs`, `pollDeadlineMs` and `graceMs`, so one
  check sees them together.
- The local refusal reads its clock tolerance from configuration as `localRefusalClockToleranceMs`,
  60000 ms by default
  ([decisions.md](../../../design/decisions.md#the-bridges-cache-is-keyed-by-the-sign-in-token-never-by-a-claim-inside-it)).
- The controller's tolerance for a sign-in token's `exp` never exceeds the bridges' local-refusal
  tolerance, or a bridge would refuse what the controller accepts. The bound sits on the
  controller's side, in the contract table of the [test plan](../../bridge-tests.md).
- The Usher token's clock tolerance is 0, with no parameter to change it, as the jose note sets out.
- Plain HTTP to the controller is refused except to loopback, so any other route to the controller
  uses TLS.
- Loopback is accepted in all three of its spellings: `127.0.0.1`, `localhost` and `[::1]`.

## Terms used here

| Term                    | Meaning in this note                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| credential              | what a request presents: a sign-in token, or an opaque API key                                                                                                                                      |
| digest                  | the base64url SHA-256 of the whole credential, which keys the stores                                                                                                                                |
| key                     | one entry an adapter registers and the request access value's `results` carries; in Arranger, one catalogue                                                                                         |
| application key         | the 32-byte secret the Usher token is encrypted under, one per application; the configuration's `key` parameter carries it                                                                          |
| entry                   | what a store holds for one digest, or the anonymous store's one slot, the anonymous entry                                                                                                           |
| flight                  | one exchange in progress for one digest, shared by every request waiting on it                                                                                                                      |
| check                   | an event that renews the grace period; the notice stream defines it                                                                                                                                 |
| wall clock              | the clock that tells the time of day; `exp` and event times are read against it, and it can step backward                                                                                           |
| monotonic clock         | a clock that only moves forward, used to measure elapsed time                                                                                                                                       |
| refused                 | the controller refused the identity, or the credential is a signed token past its own `exp`; the request gets 401                                                                                   |
| malformed               | the controller answered, and the bridge rejected the Usher token in it; treated as not received, so the request gets 503                                                                            |
| failed                  | the controller gave no usable answer: a timeout, a network failure, a server error or a 408                                                                                                         |
| unavailable             | the outcome answered with 503                                                                                                                                                                       |
| anonymous               | a principal presenting no credential: its credential `none`, never suspended                                                                                                                        |
| suspended               | a principal whose grants are on hold, served the open tier: `unconfirmed`, or `confirmed` naming its subject for attribution alone                                                                  |
| cold, normal, uncertain | the bridge's three modes, set out under "Modes"                                                                                                                                                     |
| per-principal degraded  | in normal mode, one principal served from the anonymous payload because their exchange failed while the channel is healthy                                                                          |
| held resource           | for one key, a resource whose unmarked records are held with record view, or that holds with record view a category applying to it: a global category the key defines, or one of the resource's own |
| known resources         | for one key, the resources served by the payload, its `servedResources`, together with the key's own resource list when it has one, held or not                                                     |
| complement              | the known resources not held for the key; a record holding any of them is withheld                                                                                                                  |
| clause count            | the clauses a search engine counts in a filter once it has rewritten it, which is not the number of SQON nodes: an `in` counts 1 and a range 2, as "The guards" sets out                            |
| unmapped                | of a category Usher defines: one the key neither defines nor declares absent. A global one denies the key's whole result; a resource's own withholds that resource from the key                     |
| unknown                 | of a global category a key defines: one Usher does not list, so it is never held and its records are always excluded                                                                                |

Malformed and failed both leave the bridge with no usable token for the principal, and they stay
apart. A malformed answer is a deployment fault, refused loudly with 503. A failed exchange is an
outage, which serves the open tier marked suspended.

"Key" has two meanings in the bridge. A registered key is what the contract and the adapters call a
key. The application key is the secret, carried by the configuration's `key` parameter, which is that
word's one meaning inside `BridgeConfiguration`. Where the context does not settle which is meant,
this note says "application key".

## The core

### Its surface

The surface as built, abridged; the sources document each member.

```ts
interface Clock {
	now(): number;
}

interface BridgeConfiguration {
	audience: string;
	controllerUrl: string | URL; // https, or plain http only to loopback; normalized to end in /
	eventSource: string; // this deployment's event source, a URI reference, the same on every replica
	exchangeTimeoutMs?: number; // default 5000
	filterClauseLimit?: number; // default 1024; a record key's filter counting more is denied with filter-limit
	graceMs?: number; // default 60000
	inFlightMax?: number; // default 64, standing in until the controller sets the bound
	issuer: string;
	key: string; // 43 base64url characters; imported at start, never held as bytes
	localRefusalClockToleranceMs?: number; // default 60000; the controller's own never exceeds it
	logger: BridgeLogger; // info, warn and error, each taking (object, message); Pino satisfies it
	monotonicClock?: Clock; // default performance.now(): grace period, poll deadline, entry TTL
	payloadVersions: NonEmpty<number>; // each one the token reader can read, or start refuses it
	pollDeadlineMs?: number; // default 10000
	pollIntervalMs?: number; // default 30000, at least 1000
	pollRecoveryIntervalMs?: number; // default the smaller of 10000 and pollIntervalMs, from 1000 to pollIntervalMs; the poll interval while checks are failing
	pushIdleMs?: number; // default 25000, at most pollIntervalMs
	responseCapBytes?: number; // default 1048576
	stores?: {
		failureHoldMs?: number; // default 10000, from 1000 to 60000
		failureMax?: number; // default 1000
		positiveMax?: number; // default 10000
		refusalMax?: number; // default 10000
	};
	tokenTtlMs?: number; // default 300000
	wallClock?: Clock; // default Date.now(): exp comparisons and event times
}

// KeyRegistration: imported from usher-types, which validates it, and re-exported by the bridge.
type KeyRegistration =
	| { kind: 'open' } // always { kind: 'allow' }
	| {
			absentCategories?: readonly CategoryName[]; // global categories declared absent, never also defined
			categories: {
				global: Partial<Record<CategoryName, CategoryCondition>>; // empty when none is defined
				resource?: Partial<Record<string, Partial<Record<CategoryName, CategoryCondition>>>>;
			};
			kind: 'record';
			resourceFieldName: string; // never read by a condition
			resources?: readonly string[]; // optional; an empty list denies
	  };

interface CoreSeams {
	close?: () => Promise<void>; // releases the seams' connections, once stop has waited for every flight and the channel
	createChannel?(context: ChannelContext): Channel; // built at start with the core's own confirmChannel; started and stopped with it
	createControllerClient(context: SeamContext): ControllerClient; // built at start
	createTokenReader(context: SeamContext): TokenReader; // built at start
	random?: () => number; // the refresh's backoff jitter; Math.random by default
}

// Notice: imported from usher-types, the union set out in Revocation notice stream.

interface BridgeCore {
	applyNotice(notice: Notice): void;
	mode(): 'cold' | 'normal' | 'uncertain';
	refreshAnonymous(): Promise<boolean>;
	register(registrations: Readonly<Record<string, KeyRegistration>>): void; // keyed by the key
	report<Name extends LayerEventName>(name: Name, data: BridgeEventData[Name]): void;
	reset(): void; // a 410 from the channel: drops every entry, forgets the category gaps logged and re-arms the first check's gate
	resolve(credential: string | null): Promise<ResolveOutcome>;
	start(): Promise<void>; // imports the application key, then fetches the anonymous payload
	stop(): Promise<void>; // waits for start, every flight and the channel, then closes the seams and frees the audience; never rejects
}

type ResolveOutcome =
	| { kind: 'access'; access: Readonly<UsherRequestAccess> }
	| { kind: 'refused' }
	| { kind: 'unavailable' };

// createBridgeCoreWithSeams(configuration: BridgeConfiguration, seams: CoreSeams): BridgeCore
// createBridgeCore(configuration: BridgeConfiguration, options?: { fetch?: ControllerFetch }): BridgeCore // the package's export, over the default seams
```

The host's order follows from [Packaging the bridge](packaging-and-toolchain.md), which allows no
top-level await to read the application key or fetch the anonymous payload while the module loads.
The middleware answers 503 while the bridge is cold.

**`register` is called once, before the first request, and is then frozen.** Cached results were
rendered from the registration, so registering again throws. `validateRegistration` returns a copy of
what the adapter hands it, and `register` compiles each record key from that copy and freezes the
result, because freezing the adapter's own objects in place would change the adapter's configuration
as a side effect (reasoned).

**`register` refuses every shape that would render openly**, among the registration rules usher-types
holds and tests:

- a condition outside the grammar of a category condition, or nesting too deep to leave room for the
  narrowing rendered around it;
- a condition reading the resource field;
- a category both declared absent and defined, or a resource defining categories that a given
  resource list leaves out;
- an empty field name, or a resource that Arranger reads as an instruction;
- no key at all, an empty key, or a key named `__proto__`.

A condition holding a value Arranger reads as an instruction was run through `register`: the refusal
positioned every problem under the catalogue's key and then the category's name, and named no field
or value.

**`register` refuses an artifact key.** A download service checks each file's own recorded sources,
so no filter drawn by the bridge over a list of resources is needed. `validateRegistration` refuses
a registration of kind `artifact` with a rule of its own, positioned at `kind`, which says what to
do instead and names no value; any other kind outside `open` and `record` gets the kind rule.

**`start` and `refreshAnonymous` refuse to run before `register`.** Run in the other order, the
anonymous entry was rendered against no keys. Anonymous requests were then served access with empty
results, and the startup `category.unmapped` check logged nothing. Rendering the anonymous entry
again on `register` would also close this, but refusing is simpler and keeps one order. The first
anonymous fetch is also the application key's self-test, which
[jose for the Usher token](jose-usher-token.md) sets out.

**A refusal to start rejects `start()`** with a fixed-text `UsherContractError` naming the rule. The
bridge stays cold and logs `bridge.startRefusal`, whose `reason` is a fixed code naming the rule and
never a configured value.

**`start` holds the decoded key bytes only for the imports.** It imports them as a non-extractable
AES-GCM key whose only usage is decrypt, imports them again as a non-extractable HKDF key, derives
the four subkeys from it, and then zero-fills them. The import copies the bytes, so a token was still decrypted after the fill (run,
with the AES-GCM import alone). A key handed over as bytes would instead stay in the configuration
object for the life of the process. The key's format, its canonical-form check and the properties
of both imports belong to the jose note.

### Free of any framework, but tied to Node

The core compiled under TypeScript 7.0.2 with `types: ["node"]` and no Express types, and under
TypeScript 5.8.3 with `skipLibCheck` on, which usher's own packages keep off; a 5.8.3 compile with it
off was not run. No core file imports from Express, and no core file reads
`process.env`. The prototype's core imported `node:crypto`, jose and zod at runtime, and nothing
else. The bridge imports no zod, since usher-types validates by hand and neither package has a zod
peer.

The core digests with `createHash` and reads a signed token's `exp` through the `Buffer` global. A host
running the bridge outside Node, such as an edge runtime for a Next.js server side, could not use the
core as written (reasoned). The alternative, Web-standard APIs such as `crypto.subtle.digest`, is
asynchronous and adds a step to every request (not measured). The core keeps `node:crypto` and
`Buffer`. The alternative would matter only if a host, such as Stage's server side, ran the bridge
outside Node.

## Modes

| Mode                               | Entered when                                                                                                                                                                                                      | A request carrying a credential                                                                                                                                                                                                                                                                                                                                                                          | An anonymous request                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| cold                               | at start, until `start` has imported the application key, a check is confirmed and an anonymous payload is accepted; when the grace period passes with no anonymous payload held; while the key's self-test fails | 503, nothing attached                                                                                                                                                                                                                                                                                                                                                                                    | 503, nothing attached                                                                      |
| normal                             | a check is confirmed and an anonymous payload is held                                                                                                                                                             | its entry, or a shared exchange                                                                                                                                                                                                                                                                                                                                                                          | the anonymous entry; 503 once that entry has expired or been dropped and its refetch fails |
| uncertain                          | the grace period passes on the monotonic clock since the start of the last confirmed check, with an anonymous payload held                                                                                        | a credential in the refusal store, or a signed token past its `exp`, still gets 401; one whose rejected Usher token the failure store holds gets 503; otherwise the anonymous results, `openTierOnly` and `suspended`, with no exchange: credential `confirmed`, naming its subject as `attributionOnlySubject`, while a live cached entry vouches for it, and `unconfirmed`, with no subject, otherwise | the anonymous results, even past the payload's own `exp`                                   |
| per-principal degraded (in normal) | this principal's exchange failed while checks are confirmed                                                                                                                                                       | the anonymous results, `openTierOnly` and `suspended`, credential `unconfirmed` with no subject; 503 when no usable anonymous payload is held                                                                                                                                                                                                                                                            | not applicable                                                                             |

**The `suspended` mark is what keeps a signed-in person apart from an anonymous visitor.** Without it,
a credential the bridge has never exchanged gets no subject and `openTierOnly` true in uncertain
mode, which looks exactly like an anonymous visitor (run). The same holds on the per-principal
degraded path. An adapter that serves anonymous exports as normal would then serve that signed-in
person's export as open tier, which the design rejects.

**A refused identity is never served as anonymous, in any mode.** decisions.md rejects serving a
refused identity as anonymous ("A refused identity gets one 401, whatever the reason"). The design
gives a suspended session 503 rather than 401
([security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour)),
and says nothing of a credential already refused. A refusal-store hit therefore stays 401 in
uncertain mode, the closed side.

**A cached entry's subject is served in uncertain mode for attribution alone.** Notices were missed,
so the principal's revocation status is unknown, and
[adapter-integration.md](../../../design/adapter-integration.md#decided) makes `subject` the trusted
identity, later a saved set's owner. So the suspended principal carries it as
`attributionOnlySubject` rather than `subject`, and a read of `subject` compiles only once the
suspended case is named, which keeps it from backing an ownership decision while the principal's
grants are on hold. The entry's expiry still bounds it: an expired or notice-dropped entry confirms
nothing, and the credential is `unconfirmed`.

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
   marked `suspended`, naming its subject as `attributionOnlySubject`.
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

**`start` enforces the ordering of intervals.** It refuses a `graceMs` that is not above
`pollIntervalMs`. The stream's ordering is T + 2D < G, for a poll interval T, a poll deadline D and
a grace period G. The stream note sets what they mean, jitters T by 10% and gives D a default of
10 s. The check therefore refuses any configuration in which 1.1 T + 2D is not below G. T = 38 s,
D = 10 s and G = 60 s keep T + 2D at 58 s, yet the jittered worst case is 41.8 + 20 = 61.8 s, past
G. The defaults give 33 + 20 = 53 s against 60 s. The core's configuration carries all three, as
`pollIntervalMs`, `pollDeadlineMs` and `graceMs`, so one check sees them together. The same check
refuses a `pushIdleMs` above `pollIntervalMs`. The stream note holds the push's idle timeout I to at
most T, so that a dead push is replaced within one poll interval. I defaults to 25 s whatever T is:
derived from T, it could fall below what the controller's heartbeat needs, at least twice the
heartbeat plus jitter, and a healthy push would be replaced as silent. So a host lowering
`pollIntervalMs` below 25000 lowers `pushIdleMs` with it, keeping it at least twice the controller's
heartbeat plus jitter. The same check refuses a `pollRecoveryIntervalMs` above `pollIntervalMs` as
well. The stream note times the poll at the recovery interval R in place of T while checks are
failing, and R at most T keeps that a shortening
of the wait between failing polls, never a lengthening. G still bounds how long cached answers are
served, whatever R is. A host that sets no `pollRecoveryIntervalMs` gets the smaller of 10000 and
`pollIntervalMs` as R, so lowering `pollIntervalMs` needs no R set with it. An R set above T is
still refused.

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
in a URL reaches request logs, so the query parameter is refused rather than ignored. The layer reads
the query from the request target's own text, so a target that the URL parser refuses is read like
any other. A host can pass
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

`attachAccess` validates the value with the usher-types validator, which returns a snapshot of the
value's own members read once, and deep-freezes that snapshot. Validation cost about 11.5 µs for two
keys narrowed over 300 resources, measured with the prototype's validator. `attachAccess` then
defines `usher` on the store handed to it by the layer, `res.locals`, as a data member with
`writable: false`, `configurable: false` and `enumerable: false`, and it refuses a store that already
holds `usher`. In ESM code, which runs in strict mode, reassigning `res.locals.usher` throws, and so
does mutating a result (run on both versions). In sloppy-mode CommonJS code the reassignment is
ignored silently, and the value is still not replaced. Object rest and spread skip a member that is
not enumerable, so a copy of the store made by spreading carries no access. usher-types implements
all of this, and its tests cover the member's flags, the refusal of an occupied store, and copies by
spreading and by JSON.

`readAccess` accepts only a member shaped as `attachAccess` leaves it: a data member, non-writable,
non-configurable and non-enumerable, holding a deeply frozen value. It never runs an accessor, and it
returns a fresh frozen copy it has validated. A store carrying `usher` as an ordinary property is
refused, so a value that replaces the attached one fails closed. `resultFor(access, key)` then reads
each result by own member only. usher-types implements both, with tests. There is no `WeakSet` and no provenance check, so two copies of
`usher-types` in one host interoperate. `usher-types` is a peer dependency of the bridge all the
same, so that a host holds one copy of the contract and of `SqonSchema`, as
[Packaging the bridge](packaging-and-toolchain.md) sets out.

Deep freezing is required because results are shared across requests. Every anonymous request shares
the anonymous results, and interning makes principals with equal results share one object. One
mutation would reach all of them.

Two rules make the freeze complete (reasoned). First, freezing recurses into every child
unconditionally: a freeze that stops at any object already frozen leaves the children of a
shallow-frozen value mutable. Second, `attachAccess` is a public usher-types function that fake
bridges and other frameworks' bridges call, so it cannot assume its input came from the core.

### Marking a suspended principal

A suspended principal is served the open tier alone, and Usher's table requires every application to
show a notice saying so, or reduced results would read as complete. When the attached principal is
suspended, the layer sets `Usher-Suspended: true` on the response and appends `Usher-Suspended` to
`Access-Control-Expose-Headers`, so a browser can read it. It appends rather than sets, because the
host mounts CORS ahead of the layer and a value CORS already exposes must survive. An anonymous
principal and a confirmed one get neither header. A header serves every application the same way,
GraphQL or not, and no application has to read the principal's marks itself. The package exports the
name as `SUSPENDED_HEADER`. The layer's tests cover the three principals and a value exposed before
the layer runs, on both Express versions.

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

The layer returns nothing to Express. It chains `.then(onOutcome, fail)` on the outcome, and runs
the work before that promise exists, a host's `extract` included, inside a `try` whose `catch` also
calls `fail`. Synchronous throws and asynchronous rejections then both reach `fail`, as
[Packaging the bridge](packaging-and-toolchain.md) requires. `fail` logs `bridge.internalError`
carrying only `{ stage }` and answers 503 with fixed text, unless headers have already been sent. A
`.catch` after the chain does the same for a throw while settling the outcome, such as one from
`next`, logging the stage `attach`. A throw while answering is caught in both: from the `try` it
would reach Express, which would answer with its own error page, and from the `.catch` it would
become an unhandled rejection, which would end the process. The layer's tests cover, on both
versions:

1. an anonymous request attached, with the value frozen and not replaceable;
2. two concurrent principals, each seeing only its own access;
3. a bearer value outside RFC 6750's `b64token` grammar passed to the exchange;
4. a duplicate header answered 400;
5. a refusal answered 401 with `WWW-Authenticate`;
6. cold, answered 503 with nothing downstream run;
7. a core that throws an error whose message contains a subject, answered 503 with only the stage
   logged.

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

| Store     | Key      | Holds                                                                                                                                                                            | Dropped                                                                                                                                          |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| positive  | digest   | the subject and its per-audience tag, the resource names, the interned results, `openTierOnly`                                                                                   | at the earliest of the Usher token's `exp`, receipt plus the TTL on the monotonic clock, and the sign-in token's `exp`; on eviction; by a notice |
| refusal   | digest   | an expiry, for a credential refused by the controller; a token refused for its own `exp` is never stored                                                                         | at the signed sign-in token's own `exp`, capped at now plus the TTL; for an opaque key, now plus the TTL                                         |
| failure   | digest   | whether the token was rejected or the exchange failed, and an expiry                                                                                                             | after the fixed interval; on eviction                                                                                                            |
| anonymous | one slot | the set of grants named in the anonymous payload, the resource names, its frozen access value and the same value marked suspended, both holding the interned results, its expiry | by a notice, for good; replaced on refresh                                                                                                       |

A hit in the failure store answers without asking the controller: 503 for a rejected token, and the
per-principal degraded path for a failed exchange. A broken controller is then not asked on every
request, and the bridge still recovers within one interval.

Reading `exp` from a sign-in token the bridge never validates is sound in both stores that use it
(reasoned). For a positive entry, the digest binds the exact bytes the controller accepted, so that
acceptance authenticates the claim. For a refusal, a forged `exp` can only shorten the refusal, since
the TTL caps it.

The anonymous slot discards its payload after rendering, as
[jose for the Usher token](jose-usher-token.md) requires of every payload. It keeps the set of grants
named in the payload, each as a resource, a category, an entity, any field category and an action,
with whether a record grant's entry is partitioned by field. That set is the input definition A
compares against: each exchange reads the set held when it starts, and computes `openTierOnly` from
it. Nothing else needs the payload once the anonymous results are rendered.

### What each notice drops

Every removal runs through one `onRemove` hook, which keeps the subject-tag index in step. A removal is
an eviction, an expiry, a delete or a clear.

| Notice kind       | Drops                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `principal`       | every entry indexed under that subject tag                                                                 |
| `category`        | every entry naming the resource, found by scanning; the anonymous entry too if it names it, then a refetch |
| `baseline`        | every positive entry and the anonymous entry, then a refetch                                               |
| `global`          | the positive store, the refusal store and the anonymous entry, then a refetch                              |
| `servedResources` | every positive entry and the anonymous entry, then a refetch, as `baseline` does                           |

A 410 from the stream also drops every positive entry and the anonymous entry, as the stream note sets
out. The core's `reset` does this for a 410: it keeps refusals, forgets which category gaps it has
logged, and re-arms the gate so that a fetch before the next check serves only as a self-test and an
exchange started before it is served without being cached. Each reset also starts a new generation,
which every flight reads when it starts: a flight spanning a reset is overtaken, its answer neither
installed nor cached, and no fetch after the reset joins one started before it.

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

| Held per entry, for a principal naming 300 resources     | Heap     |
| -------------------------------------------------------- | -------- |
| the decrypted payload, with a category list per resource | 99.3 KiB |
| a `Set` of 300 resource names                            | 10.1 KiB |
| a rendered narrowing for one key                         | 3.1 KiB  |

An entry therefore never keeps the payload, and results are interned. Resource sets are worth
interning too, or replacing with a bitset over resource identifiers, because every payload with the
baseline on names every open resource. Fifty thousand entries each holding its own `Set` of 300 names
come to about 490 MiB (arithmetic, not measured). A scan over entries that each held their own `Set`
peaked at 1.34 GB resident (measured).

### A map written for the bridge, against lru-cache 11.5.3

Each store is a `Map` kept in recency order, with one removal hook and an absolute expiry per entry,
one instant on each clock. It has no timers of its own, and drops an entry at its exact expiry
instant.

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

`createSingleFlight({ max, onOverload, overloaded, timeoutMs })` is a `Map` from digest to a
promise of an outcome. The work is deferred by
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
out in [Sign-in signature precheck](signin-signature-precheck.md). Overloaded requests are counted
into one event per interval, since one event each would turn a flood of requests into a flood of log
lines.

### Timeout

Each flight carries its own abort signal, from an `AbortController` that a `setTimeout` aborts, and
the timer is cleared when the flight settles. A client disconnecting therefore cannot cancel an
exchange that others are waiting on. node:test's mock timers drive that form whenever `setTimeout` is
mocked (run). They drive `AbortSignal.timeout` only when it is listed among the mocked APIs, and the
mocked signal then aborts with an `AbortError`, where the real one aborts with a `TimeoutError`
(run). The `AbortController` form behaves the same in tests and in production, and code never
branches on the abort reason's name.

The default fetch client, against a controller mock on a local port, maps its outcomes as follows
(run):

| Controller        | Outcome                            |
| ----------------- | ---------------------------------- |
| never answers     | timeout                            |
| answers 403       | refused                            |
| answers 401       | unavailable: the assertion refused |
| answers 500       | a status failure                   |
| nothing listening | a network failure                  |

`new URL('/exchange', base)` drops the base URL's path. `new URL('exchange', base)` keeps it only when
the base ends in `/` (run). Configuration therefore normalizes `controllerUrl` to end in `/`, and
every request URL is built relative to it.

### Reading the answer

| Controller answer                                                                                                                  | Outcome                       | Held           | The request gets                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| success, token accepted                                                                                                            | granted                       | positive store | access                                                                                                                                |
| success, token rejected, `sub` not matching the kind of exchange, or `sub` differing from a three-part sign-in token's own subject | malformed                     | failure store  | 503                                                                                                                                   |
| an answer past the response cap                                                                                                    | malformed, as `tokenTooLarge` | failure store  | 503                                                                                                                                   |
| 403                                                                                                                                | refused                       | refusal store  | 401                                                                                                                                   |
| 401, the channel assertion refused                                                                                                 | unavailable                   | no             | 503, logged as `token.exchangeFailure` with cause `assertionRefused`; at startup, a probable key mismatch                             |
| timeout, network failure, 5xx or 408                                                                                               | failed                        | failure store  | the anonymous results, `openTierOnly` and `suspended`, credential `unconfirmed` with no subject; 503 with no usable anonymous payload |
| 429, or any other status                                                                                                           | unavailable                   | no             | 503, logged as `token.exchangeFailure` with cause `status`                                                                            |
| beyond the in-flight bound                                                                                                         | overloaded                    | no             | 503, counted in the aggregated `token.exchangeFailure` event with cause `overloaded`                                                  |

Mapping every status other than 403 to a failure fails open. With a simulated controller that refused
an identity with 400 or 403, a client mapping that way served the credential the open tier (run). A
429 read as a failure would likewise serve every signed-in person the open tier for as long as the
controller sheds exchanges. Reading any other status as a refusal, answered 401, would tell a portal
to sign the person out over what may be a bridge defect or a busy controller. A refused assertion is
the sharpest case: read as a refused identity, a key revoked or rotated away would sign everyone
out. A 408 stays a failure,
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
global notice. If so, the answer is discarded for every waiter and exchanged once more, unless the
core has stopped, which starts no exchange. If the log no
longer reaches back to the flight's start, the payload is treated as affected. The check runs after
the last `await`, and rendering and the cache write follow it synchronously, so no notice can land
between the check and the write (reasoned: no other callback runs between two statements with no
`await` between them). Measured: two exchanges when the notice named the principal, one when it named
somebody else. The anonymous refresh runs the same check.

The notice stream adopts this test. Every waiter on a discarded answer exchanges again, including
waiters who joined before the notice. An answer overtaken twice serves the open tier, marked
`suspended` and naming its verified subject for attribution alone, and so does one overtaken once
after `stop`. Notices are rare, so this case is rare too (reasoned).
[audit-events.md](../../../design/audit-events.md) registers `token.overtaken` for each discard, with
`outcome` `exchangedAgain` when the bridge exchanges again, and for the second discard or any after
`stop`, which ends the flight, `servedOpenTier` when the open tier is served or `abandoned` when
nothing is.

## Rendering

### What rendering produces

`compileKey(registration)` runs once per key, at `register`. A record key's global categories and each
resource's own are compiled into that key's own form: each condition with the keys of every node
sorted. An open key is kept as registered.

`renderKey(payload, key, filterClauseLimit)` is pure:

- A key open by configuration gets `allow`.
- **The global check.** Every category in `globalCategories` must be defined by a record key or
  declared absent from it. One in neither state denies the key's whole result with
  `unmapped-category`, and `category.unmapped` is logged at critical severity once per catalogue and
  category, with no resource. A global category the key defines that `globalCategories` does not list
  is never held, so its records are excluded wherever the key renders, and `category.unknown` is
  logged as a warning once per catalogue and category. A resource category the key defines under a
  resource `permissions` names, but which `resourceCategories` does not list there, is never held
  either, so its records are excluded for that resource, and `category.unknown` is logged as a
  warning once per catalogue, category and resource.
- **The resource-category check.** The candidates are the resources `permissions` names, within the
  key's resource list when it has one. A candidate offering, per `resourceCategories`, a resource
  category the key does not define under it is left out of the held resources, which places it in the
  complement, since the payload serves it. `category.unmapped` is logged at error severity once per
  catalogue, category and resource, naming the resource as `resourceId`.
- **What is held.** Only an entry carrying `record` with `view` and no `field` counts. On each
  remaining candidate R, H(R) is every category held that way, global or R's own, apart from
  `global.unmarked`, which is its own flag. R is held when its unmarked records are, or when H(R)
  holds a category that applies to it: a global category the key defines, or one of R's own. A
  resource whose grants apply to nothing falls outside the held resources.
- **What is known.** The resources served by the payload, together with the key's own resource list
  when it has one. The validator guarantees `servedResources` includes every resource `permissions`
  names, so every held resource is known. A resource listed by the key and not served by the payload
  is known and never held, so it falls into the complement, and no event names it.
- A resource category defined by the key under a resource absent from `permissions` is never held
  there, and no event names it. Nothing is held on that resource, so every one of its records is
  excluded: through the complement when the payload serves it or the key lists it, and by the held
  test otherwise.
- No held resource gives `deny` with `no-grants`, or with `unknown-resource` for a record key
  registering an empty list, which holds none; the application still starts.
- Otherwise the result is `narrow`, with the filter usher-types' `canonicalRecordNarrowing` renders
  from the key's compiled global conditions, the held resources, each with H(R), its own compiled
  conditions and whether its unmarked records are held, the known resources and the resource field
  name. That filter excludes what is not held, one clause per category: the held test, the
  complement, one exclusion for each category with a lacking list, and the unmarked clause, in that
  order, as
  [decisions.md](../../../design/decisions.md#a-category-is-a-condition-over-records-and-a-record-needs-every-category-it-matches)
  sets out. Its clause count grows with the categories, not with the resources. It is served only
  past both guards below.
- A key holding every category on every held resource, with nothing known beyond them, renders the
  held test alone, inside the root `and`.

usher-types normalizes each condition with `normalizedCondition`, sorts every list and orders the
exclusions by category name and then resource, all by code unit, never `localeCompare`, so the
output is byte-identical across processes.

`globalCategories` and `resourceCategories` are carried by the
[payload type](../../../design/security-workflow.md#the-payload-as-a-type), and decisions.md
("A catalogue's category gap is found by the bridge") decides the checks that read them.
`globalCategories` lists every concrete global category Usher defines, once for the whole payload,
since a global category applies to every resource whose records match it. `resourceCategories`
lists, under each resource named in `permissions`, that resource's own categories. The checks stay
generic: the adapter turns its application's configuration, whatever its shape, into the one
registration read by the bridge, and the bridge only compares that registration with the categories
named in the payload. Without the category members, the bridge could not find a global category the key
leaves unmapped, whose records would be served as unmarked, nor the resources offering a resource
category the key does not define.

### The guards

A lost exclusion widens access, so a record key's narrowing passes two guards in `guardedNarrowing`
before it is served. They are the bridge's own pair: the "two guards" of
[decisions.md](../../../design/decisions.md#a-category-is-a-condition-over-records-and-a-record-needs-every-category-it-matches)
are the rendering guard and Arranger's refusal of an access filter holding an empty group, and the
clause guard is not among them. Each guard's event is logged once each time the key is rendered, so
once per key for each payload received, never per request.

**The rendering guard compares the filter with what it must say.** It first holds that the key
defines or declares absent every global category listed in the payload, the precondition on which
rendering rests, rather than trust that rendering denied the key. It then reads the filter back with
usher-types' `parseRecordNarrowing`, and computes what the filter must say from the payload and the
key's registration alone, in a module importing nothing from rendering, so a fault in either is
caught by the other:

- the resource field name;
- the held resources, found again from `permissions`, the key's list, the categories each resource
  offers and the entries holding whole-record view;
- the complement: the resources served by the payload, together with the key's own resource list when
  it has one, less the held resources;
- for each category with a non-empty lacking list, its condition and that list: for a global
  category, every held R whose H(R) lacks it; for R's own category, R alone, when H(R) lacks it;
- when some held resource's unmarked records are not held, the unmarked clause's lacking list, the
  key's global conditions and each lacking resource's own conditions.

Lists compare as sets, and conditions by their JSON once `normalizedCondition` has normalized them.
A filter the parse refuses, which includes one with a missing clause dropped, or any difference
denies the key with `rendering-mismatch`, and `catalogue.renderingMismatch` is logged as critical.
The guard reads the registration's own conditions rather than their compiled form, so a fault in
compiling a condition is caught as well (reasoned).

**The clause guard counts the filter as OpenSearch does.** Only a filter passing the rendering guard
is counted. `filterClauseCount` weighs each node by its operator, read through SQON's aliases:

| Node                                         | Weight                        |
| -------------------------------------------- | ----------------------------- |
| `in`, whatever the number of values it lists | 1                             |
| `in` on `__missing__`                        | 2                             |
| `gt`, `gte`, `lt`, `lte` or `between`        | 2                             |
| `not`                                        | 1, beside what it holds       |
| `and`, `or`                                  | nothing beyond what they hold |
| any other operator                           | more than any limit           |

No filter passing the rendering guard holds another operator. A count above `filterClauseLimit`,
1024 by default, denies the key with `filter-limit`: the grants are more than this catalogue's filter
can express, which is not a rule the person broke. `catalogue.filterLimit` is logged at error
severity, naming the catalogue and the configured limit, never a count of grants or categories.

The weights follow OpenSearch because it counts clauses across the whole query once it has rewritten
it ([decisions.md](../../../design/decisions.md#a-category-is-a-condition-over-records-and-a-record-needs-every-category-it-matches)), so a
filter's count is taken the way the engine takes it, rather than as the number of SQON nodes. They
were measured on Elasticsearch and OpenSearch alike. Past the engine's own limit, the engine refuses
the query and the request fails; a `filterClauseLimit` no higher than that limit makes the bridge
deny the key first, by name and with an event (reasoned).

### What it was checked against

- The bridge's tests read each narrowing back through `parseRecordNarrowing` and compare the held
  resources, the complement, each category's lacking list with its condition, and the unmarked
  clause with what the payload and registration say, for cases 2, 5, 9, 19 and 24 and for the rows
  that belong to the bridge alone (run).
- Every corpus payload, rendered for a record key with and without a resource list and for an open
  key, each registered to match the payload's configuration, gave a result the
  enforcement validator accepts and met no category gap, and every record narrowing read back (run).
- A key defining `global.controlled` only, with no absence declared, was denied with
  `unmapped-category` for case 5 and for case 1 alike, and the startup anonymous fetch logged
  `category.unmapped` once; two later payloads naming the same gap logged nothing more (run).
- With `resource.pilot` offered by HEART_STUDY and undefined by two keys, HEART_STUDY was withheld
  from both into the complement, and `category.unmapped` was logged once for each key; a second
  payload offering it logged nothing more (run).
- Two keys defining `global.controlled` with different conditions each rendered their own condition
  for one payload (run).
- A payload whose `resourceCategories` disagreed with its `permissions`, or that held a category
  listed in neither category member, was rejected as malformed.
- A payload whose `servedResources` was absent, `null`, or left out a resource `permissions` names
  was rejected as malformed (run).
- A resource served by the payload, with nothing held on it by the principal, fell into the
  complement, for a key with no resource list and for one whose list leaves it out. A resource listed
  by a key and not served by the payload fell into the complement too and was never held, and a
  record holding it beside a held resource was withheld when judged against the narrowing as rendered
  (run).
- One rendered narrowing, holding a complement of two, two exclusions and an unmarked clause, was
  tampered with seven ways, and each was denied with `rendering-mismatch`: one exclusion removed, a
  lacking list shortened by one resource, a complement missing a value, an extra held resource, the
  unmarked clause dropped, an excluded condition altered, and a missing clause dropped, which the
  parse refuses. The narrowing as rendered was served (run).
- Checked against a payload serving one resource more, that narrowing was denied with
  `rendering-mismatch`. Against a payload serving one fewer that the key still lists, the narrowing
  rendered for it kept that resource in its complement and was served, and with the resource
  dropped from its complement it was denied (run).
- Every corpus payload, rendered for a record key with and without a resource list, passed the
  rendering guard, the only denial being `no-grants` (run).
- That narrowing counted 25 clauses. It was served under a limit of 25 and denied with
  `filter-limit` under 24, and a tampered one under a limit of 1 was denied with
  `rendering-mismatch`, never `filter-limit`. With one more held resource holding the same
  categories it still counted 25 (run).
- With `filterClauseLimit` at 13, two keys whose narrowing counted 20 were denied with
  `filter-limit` for two principals, and `catalogue.filterLimit` was logged four times, once per key
  and payload, while the anonymous narrowing, counting 13, was served (run).

Passing the validator shows that a result is well formed, not that it is right. Both gaps below passed
it.

### Two gaps that rendered openly

**A field partition rendered as the whole record.** Case 24b holds HEART_STUDY's unmarked records with
`record.view` and a `field` entry naming only `global.clinician`. Rendered without regard to `field`,
the entry held those unmarked records whole, so every column of them would be served (run).
[token-calculation.md](../../../design/token-calculation.md) expects the clinician columns and no
others.
[decisions.md](../../../design/decisions.md#an-unimplemented-capability-fails-closed-only-where-the-action-has-no-path)
rates an unenforced `field.view` as open and severe, and [phase-1.md](../../phase-1.md) keeps
field-level restriction out of MVP. Counting such an entry for nothing keeps the principal's other
grants working, where treating the payload as malformed would refuse everything. The cost is visible
in case 24: that principal sees none of HEART_STUDY's records through the entry, fewer than an
anonymous visitor sees, and HEART_STUDY falls into the complement. `field: {}`, which phase-1.md
suggests as a stub, reaches no field category and is treated the same way.

**A resource category the key does not define rendered as unmarked.** With the resource-category
check left out, a resource offering `resource.pilot` to a key defining none was rendered as held, with
no condition for `pilot` in its description, so its pilot records were served wherever its unmarked
records were (reasoned from the rendering; three tests failed with the check left out). The check
withholds the resource instead.

### Grants held only in another key

Without a resource list on a record key, a principal whose grants all sit on resources served by
another key gets a narrowing that matches nothing in this key, not a deny (run). With the list given,
the same payload rendered `deny` with `no-grants`. The producer rule in
[decisions.md](../../../design/decisions.md) ("every grant sits in other catalogues" is a deny) needs
the bridge to know which resources each key serves, so only a key with a list can apply it. The
difference reaches people: a deny is named at catalogue level, while an empty narrowing reads as
nothing found. The [test plan](../../bridge-tests.md#the-fixtures) carries both rows.

### Interning

The interning key is the results serialized as JSON. Plain `JSON.stringify` is stable here only
because usher-types normalizes each condition and sorts every list, and the registration's order is
fixed. Equal keys map to one frozen object, from a bounded pool of 4,096. The corpus's 35 payloads
render to 10 distinct results for one record key defining both of the default configuration's global
categories, with no resource list (run): cases 19 and 24 render alike, since HEART_STUDY is served
and not held in both. For cases 3 and 4, the result is the anonymous principal's
own.

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
depends on the registration and on withholding driven by `globalCategories` and
`resourceCategories`.
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
when no request arrives, as the outage trace shows at t = 120 s.

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

Each event name maps to its exact fields.
`createEventLog({ logger, source, wallClock }).emit(name, data)` copies only the allow-listed fields, so a cast that smuggles in extra fields still loses them. It wraps
them in the CloudEvents envelope: `specversion`, `id`, `source`, `type` as `bio.overture.<name>`,
`time` from the wall clock, and severity. Severity `info` goes to `logger.info`, `warning` to
`logger.warn`, and `error` and `critical` to `logger.error`. An event whose severity depends on a
field takes it from the fields copied, so the severity logged always matches the fields logged. The
`logger` parameter is a minimal structured
interface: `info`, `warn` and `error`, each taking an object and a message. Pino, the structured
logger decided by the [technology stack](../roadmap/technology-stack.md), satisfies it, so a host can
pass its own Pino instance. The type does not require Pino, and a host with no Pino supplies a shim.

The logger must not throw. These events are the bridge's audit trail, and a dropped event is lost
from it. When a host's logger breaks the contract, a call that throws drops that one event, and
nothing else happens. `emit` returns normally, and the next event goes to the logger as usual. The
drop is reported nowhere, since the logger is the only path a report could take: no second log call,
no console and no stderr. Dropping the event protects the bridge's availability, not the audit trail.
A logger that throws cannot end the process or halt the bridge's work, whether it throws while a
request is answered or from one of the bridge's timers, such as the push's idle timer, the grace
period's timer or a tally's interval.

Every event the bridge emits, as registered in [audit-events.md](../../../design/audit-events.md):

| Event                             | Emitted when                                                                                                                                                                                                                                                                                             | Fields                                                                                                                                                                                          | Severity                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `revocationChannel.modeChange`    | the mode changes among `cold`, `normal` and `uncertain`; once at startup when the bridge stays cold on a probable key mismatch; and once while cold when the anonymous token is refused for its audience, a probable audience mismatch                                                                   | `fromMode`, `toMode`, `reason`; the reasons include holding no anonymous payload, a probable key mismatch (`probableKeyMismatch`) and a probable audience mismatch (`probableAudienceMismatch`) | `critical` into cold or uncertain, `info` into normal             |
| `category.unenforced`             | an entry carrying `field` reaches nothing; once per such entry in each payload received, never per request                                                                                                                                                                                               | `userId`, `resourceId`, `category`, `payloadVersion`, `reason` (`notImplemented`), `entry` (`fieldPartition`)                                                                                   | `warning`                                                         |
| `category.unknown`                | a key defines a category the payload does not list, global or for a resource it names, so its records are always excluded there; once per catalogue and category, and per resource for a resource category                                                                                               | `catalogue`, `category`, `resourceId` for a resource category                                                                                                                                   | `warning`                                                         |
| `category.unmapped`               | a key is denied for a global category it neither defines nor declares absent, once per catalogue and category; or a resource is withheld from a key for a resource category the key does not define, once per catalogue, category and resource                                                           | `catalogue`, `category`; `resourceId` for a resource category only                                                                                                                              | `critical` for a global category, `error` for a resource category |
| `credential.refusal`              | an identity is refused                                                                                                                                                                                                                                                                                   | `origin`: `controller`, `localExpiry` or `cachedRefusal`                                                                                                                                        | `info`                                                            |
| `token.exchangeFailure`           | an exchange cannot complete, whether failed or unavailable, or requests are overloaded                                                                                                                                                                                                                   | `cause`: `timeout`, `network`, `status`, `assertionRefused` or `overloaded`; an overload event adds `count`                                                                                     | `warning`                                                         |
| `token.rejection`                 | an Usher token is rejected                                                                                                                                                                                                                                                                               | `reason`, one of the jose note's reason codes; a token whose `aud` does not name this application is `audienceRejected`                                                                         | `warning`                                                         |
| `notice.applied`                  | a notice is applied                                                                                                                                                                                                                                                                                      | `kind`, `entriesDropped`                                                                                                                                                                        | `info`                                                            |
| `token.overtaken`                 | an exchange answer is discarded because a notice affecting it arrived while it was in flight: the first time the bridge exchanges again, the second it serves the open tier, marked suspended and naming its verified subject for attribution alone, or nothing when no usable anonymous payload is held | `outcome`: `exchangedAgain`, `servedOpenTier` or `abandoned`                                                                                                                                    | `info`                                                            |
| `catalogue.renderingMismatch`     | the rendering guard finds a record key's filter saying something other than its payload and registration, or refused by the parse, and denies the key; once each time the key is rendered                                                                                                                | `catalogue`                                                                                                                                                                                     | `critical`                                                        |
| `catalogue.filterLimit`           | the clause guard denies a record key whose filter counts more clauses than `filterClauseLimit`; once each time the key is rendered                                                                                                                                                                       | `catalogue`, `filterClauseLimit`, the configured limit and never a count                                                                                                                        | `error`                                                           |
| `catalogue.resourceListMissing`   | a record key registers an empty resource list, which denies every request to it; once per key at start                                                                                                                                                                                                   | `catalogue`                                                                                                                                                                                     | `critical`                                                        |
| `credential.malformed`            | no single credential can be read, or one arrives in the query                                                                                                                                                                                                                                            | `reason`: `multiple`, `scheme` or `query`                                                                                                                                                       | `info`                                                            |
| `bridge.internalError`            | an unexpected failure inside the layer or the core                                                                                                                                                                                                                                                       | `stage`                                                                                                                                                                                         | `critical`                                                        |
| `bridge.startRefusal`             | the bridge refuses to start, and stays cold                                                                                                                                                                                                                                                              | `reason`, a fixed code naming the rule, never a configured value                                                                                                                                | `critical`                                                        |
| `revocationChannel.failure`       | a poll fails, answered with a status other than 200, 406 or 410, unable to reach the controller or aborted at its deadline, or a defect is thrown while polling, applying a pushed notice, or handing a 410 to the channel; counted by the channel layer, one event per cause per interval               | `cause`: `status`, `network`, `timeout` or `defect`; `count`, the failures of that cause counted                                                                                                | `warning`                                                         |
| `revocationChannel.pushReconnect` | the push is silent past its idle timer and reconnects                                                                                                                                                                                                                                                    | `reason`                                                                                                                                                                                        | `info`                                                            |
| `revocationChannel.reset`         | the stream answers 410, and every positive entry and the anonymous entry are dropped                                                                                                                                                                                                                     | none                                                                                                                                                                                            | `warning`                                                         |
| `revocationChannel.malformed`     | a notice or a poll answer fails to read, a poll page asks for more from a cursor its check already asked after, the controller refuses the notice versions listed, or the push is answered with a 200 that is not an event stream                                                                        | `reason`, a fixed code                                                                                                                                                                          | `warning`                                                         |

The last four events come from the channel layer, as
[Revocation notice stream](revocation-notice-stream.md) sets out.

Three rules from [audit-events.md](../../../design/audit-events.md) shape these names and severities:

- No word is both an entity and an action. The catalogue already has `token.exchange`, where exchange
  is the action, so a refused identity is `credential.refusal` and a failed exchange is
  `token.exchangeFailure`. The refusal's field is `origin`, because the envelope owns `source`.
- Every event carries `actorType`, a payload property in `data` rather than an envelope attribute,
  since CloudEvents allows only lower-case letters and digits in attribute names.
- Severity is `info`, `warning`, `error` or `critical`. `category.unmapped` takes two: `critical`
  for a global category, which denies the catalogue, and `error` for a resource category, which
  withholds one resource. Its definition chooses between them by whether `resourceId` is carried, so
  no call site can pair a severity with the other scope.

`category.unenforced` is one event per entry partitioned by field in each payload received, never one
per request. Its `entry` is `fieldPartition` and its `reason` is `notImplemented`. A resource
category's entry is enforced, so it is never recorded there.

`category.unmapped` and `category.unknown` are each logged once per gap while the core remembers
having logged it. The core remembers the last 4,096 gaps of each kind, the same bound as the intern
pool, so a payload naming many resources cannot grow that memory without limit. A reset forgets them
all. A gap pushed out of the bound, or met again after a reset, is therefore logged again.

What the builders guarantee, and what they do not:

- `reason`, `cause`, `origin`, `outcome`, `entry`, `stage` and `kind` are closed enumerations.
- An error's message is never logged.
- `resourceId`, `category`, `catalogue` and `userId` are typed as strings. The allow-list stops
  extra fields, not what a string field holds. Keeping a token or a record identifier out of those
  fields is a convention of the call sites, not a property of the types.
- No event carries any part of a sign-in token, its key identifier included.
- `catalogue.filterLimit` carries the configured limit, never a count of the principal's grants or
  categories, and neither guard's event carries a value from the payload or the filter.
- `category.unenforced` and `category.unmapped` are the only events carrying values taken from the
  payload. `category.unmapped` carries no principal at all, and `category.unknown` carries only names
  from the registration: a category, and for a resource category its resource. `category.unenforced` is the one event allowed to carry a
  grant, and carries a single one, because it records that grant reaching nothing.
- `token.exchangeFailure` carries no `userId`: before an exchange succeeds, the bridge has no trusted
  subject to put there (reasoned).
- A scan of every event logged by the Express suites found no credential, no JWE and no `permissions`.
  Those suites logged only 7 events of 4 kinds, though, and none of them carried payload values.

## Configuration

Configuration reaches the core as typed parameters, and the core never reads `process.env`.
`start` rejects with an `UsherContractError` whose message names the rule and never a value, stays
cold and logs `bridge.startRefusal`. `checkConfiguration` holds the rules, judged in this order, with
a test for each, and the first broken one is the refusal's reason:

| Reason                    | Refused                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loggerInvalid`           | a logger without `info`, `warn` and `error` methods, checked first so that every later refusal can be logged                                                                                                     |
| `clockInvalid`            | a clock given without a `now` method                                                                                                                                                                             |
| `keyUnusable`             | a `key` that is not 43 base64url characters in canonical form once whitespace around it is removed, the first steps of the startup check in the jose note                                                        |
| `audienceEmpty`           | an empty audience                                                                                                                                                                                                |
| `issuerEmpty`             | an empty issuer                                                                                                                                                                                                  |
| `eventSourceEmpty`        | an empty event source                                                                                                                                                                                            |
| `controllerUrlInvalid`    | a controller URL that does not parse, uses a scheme other than `http` or `https`, or carries credentials, a query or fragment                                                                                    |
| `controllerUrlInsecure`   | a plain `http` controller URL to any host other than `127.0.0.1`, `localhost` or `[::1]`                                                                                                                         |
| `payloadVersionsInvalid`  | a `payloadVersions` list that is empty, or holds anything but distinct positive whole numbers                                                                                                                    |
| `numberOutOfRange`        | any bound, interval, timeout or cap that is not a positive whole number, or a `pollIntervalMs` or `pollRecoveryIntervalMs` below 1000                                                                            |
| `failureHoldOutOfBounds`  | a `stores.failureHoldMs` that is not a whole number of milliseconds from 1000 to 60000                                                                                                                           |
| `refusalToleranceInvalid` | a `localRefusalClockToleranceMs` that is NaN, infinite or negative                                                                                                                                               |
| `intervalsOutOfOrder`     | `pushIdleMs` above `pollIntervalMs`, `pollRecoveryIntervalMs` above `pollIntervalMs`, or 1.1 T + 2D not below G, computed in whole numbers as 11 T + 20 D < 10 G, so `graceMs` must also exceed `pollIntervalMs` |

A `numberOutOfRange` error carries one problem for each setting at fault, positioned at its name, as
in `pollIntervalMs` or `stores.failureMax`, while the event's `reason` stays the fixed code. Only a
setting the host gave is named: every default passes, and R's default is never below a T that
passes, so a T below the floor is named once, at T. The floor of 1000 on T and R is the failure
hold's lower bound, so that a 10 typed for 10000 is refused rather than setting every bridge polling
the controller every 10 ms.

The core's `start` then adds refusals of its own, judged in this order:

- `payloadVersionUnreadable`, for a listed payload version the token reader cannot read. The error
  names each such version by a problem positioned at its index, as in `payloadVersions[1]`, while
  the event's `reason` stays the fixed code.
- `notRegistered`, for a `start` before `register`.
- `audienceInUse`, for a second bridge on one audience in a process.
- `startDefect`, for a seam that throws as `start` builds the controller client, the token reader
  or the revocation channel, or starts the channel. Whatever had started is stopped before `start`
  rejects. The event's `reason` stays the fixed code, never the thrown error's message.

| Parameter                      | Default                                 |
| ------------------------------ | --------------------------------------- |
| `exchangeTimeoutMs`            | 5000                                    |
| `filterClauseLimit`            | 1024                                    |
| `graceMs`                      | 60000                                   |
| `inFlightMax`                  | 64, until the controller sets the bound |
| `localRefusalClockToleranceMs` | 60000                                   |
| `pollDeadlineMs`               | 10000                                   |
| `pollIntervalMs`               | 30000                                   |
| `pollRecoveryIntervalMs`       | 10000, or `pollIntervalMs` when lower   |
| `pushIdleMs`                   | 25000                                   |
| `responseCapBytes`             | 1048576, so 1 MiB                       |
| `stores.failureHoldMs`         | 10000                                   |
| `stores.failureMax`            | 1000                                    |
| `stores.positiveMax`           | 10000                                   |
| `stores.refusalMax`            | 10000                                   |
| `tokenTtlMs`                   | 300000                                  |

**Two clock tolerances, never one.** The local refusal of a three-part sign-in token whose own `exp`
has passed uses a tolerance read from configuration as `localRefusalClockToleranceMs`, 60000 ms by
default. The controller's own tolerance for a sign-in token's `exp` never exceeds it, or a bridge
would refuse what the controller accepts. The Usher token's tolerance is 0, fixed in the decrypt call with
no parameter, and the jose note owns it. Passed to jose, a millisecond value
read as seconds admitted a token an hour past its `exp`, an undefined value over 1,000 made every
token fail, and -61 refused a live token (run). jose reads `clockTolerance` in seconds, so a nonzero
Usher token tolerance, if one ever became configurable, would be named in milliseconds, validated as
the local refusal's is, and divided by 1,000 at the jose boundary.

**Loopback means three spellings.** A check on the literal `127.0.0.1` refused `http://localhost` and
`http://[::1]` (run). The check accepts all three.

**Plain HTTP beyond loopback is refused.** The exchange carries the sign-in token, so plain HTTP would
expose bearer credentials on the network between the application and the controller. Refusing it is
the closed side.

**usher-types validates by hand.** Its own code never imports zod, since a zod record
skips a `__proto__` key unchecked and zod's issues quote input keys. `SqonSchema` from
`@overture-stack/sqon` is still applied, as its own step and through sqon's own zod, and each validator returns a snapshot of own
members, read once. The enforcement validator refuses an empty group anywhere; any exclusion
(`not-in`, `some-not-in` and their aliases); a pivot, null included; any member beyond `op` and
`content` in a node, or beyond `fieldName` and `value` in a clause; `wildcard` and its alias
`filter`; a value holding a marker read by Arranger as an instruction (a `*` pattern, a `set_id:`
reference, `__missing__`); a `not` anywhere except directly inside an `and` that also holds an `in`;
an empty `in` inside a narrowing; a range holding no bound, or any bound other than a finite number or
a non-empty string; and a `between` holding other than two bounds, since Arranger sends every bound
it is given to the search engine.
[decisions.md](../../../design/decisions.md#the-bridges-filters-carry-no-empty-group-no-empty-exclusion-and-no-pivot)
records these rules, and that the wildcard and `not` rules may need revisiting after MVP, for a
grant carrying its own SQON.

A validator written with zod was checked first. A non-empty list written `zod.tuple([item], item)`
infers a non-empty tuple with zod 4.6.5, so a recursive SQON validator written with a getter
typechecked against the hand-written `NonEmpty` SQON type, under TypeScript 7.0.2 and 5.8.3, and
refused an empty value list, an empty group, a pivot key and `not-in`. `zod.array().min(1)` infers a
plain array and fails that assignment.

## In a host application

None of this was tested inside Arranger. It is read from Arranger's source, from RFC 9111, and
reasoned.

- **After the health routes.** A cold bridge answers 503 to everything mounted behind it. A liveness
  check routed through the bridge would restart the application while the controller is down. A
  readiness check can read `mode()`, so a cold replica stops receiving traffic instead.
- **After CORS.** Otherwise a cold bridge answers preflight requests with 503.
- **Before body parsing.** Refused and cold requests are then answered without parsing a body.
- **Adapters read the access through `readAccess(res.locals)`, never from a merged copy.** Spreading
  `res.locals` into another object leaves `usher` behind, since it is not enumerable, and a later
  spread with a `usher` key sets an ordinary writable property. Arranger's GraphQL router builds its
  context by spreads. `readAccess` refuses both, the missing member and one not shaped as
  `attachAccess` leaves it, as "Attaching" sets out, so a merged or replaced value fails closed: the
  request errors rather than being served the replacement. Reading `res.locals` directly avoids that
  error.
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
- **The local refusal's tolerance is refused when NaN, infinite or negative**, with the rule's name
  and not its value, and it takes 60000 ms when left out.
- **The grace period lapses on the monotonic clock.** With the wall clock stepped back 30 s, the mode
  turns uncertain 1 ms after 60 s on the monotonic clock, not at 90 s.
- **A request reads the mode itself.** With the monotonic clock advanced past the grace period and no
  timer ticked, a request is already served as uncertain.
- **The exchange timeout fires under mock timers** with only `setTimeout` mocked, and the abort
  reason's name decides nothing.
- **The Usher token's tolerance is 0 at jose.** A token is accepted 1 ms before its `exp` in
  milliseconds and refused at that instant.
- **A host's `extract` that throws synchronously** gets 503 with only the stage logged, the same as a
  rejection from the core. A throw while answering then never reaches Express.
- **A throw while settling the outcome**, such as one from `next`, gets 503 with the stage `attach`
  logged. A response that throws as it answers then raises no unhandled rejection.
- **The Express layer's tests run on a real server bound to `127.0.0.1`**, rather than supertest's
  listener.

## Not built or not run

- Rendering's cost per exchange was not measured. usher-types parses each filter it renders back
  before returning it, and the rendering guard parses it again, which adds to that cost.
- The bridge's tests count filters by the weights and run no engine, so a change in how an engine
  counts clauses would not fail them.
- The poll and the push, which the core builds at start as its channel seam, ran against a
  controller mock serving both over a local socket, not against the controller. Recovery ordering
  rests on the channel calling `confirmChannel` only after a check's notices are applied.
- The exchange ran against a controller mock on a local port, which checks the channel assertion and
  mints real tokens, not against the controller.
- The package's declarations import the Express types from the host and name neither `CryptoKey`
  nor jose, as [Packaging the bridge](packaging-and-toolchain.md) requires. That is checked by hand,
  as [tech-debt.md](../../../tech-debt.md) records, and no consumer from TypeScript 5.8 was run
  against the built declarations.
- Stage's server side was not explored. Its layer may need a cookie credential source, and it may run
  outside Node.
- Memory with interned resource sets or bitsets was not measured at scale. The core interns its
  results, not its resource sets.
- Definition A's cost per exchange was not measured.
- The Express suites ran against a stand-alone application, not inside Arranger's search-server. Code
  that replaces `res.locals` wholesale would lose the value, and `readAccess` would then throw, which
  fails closed; that was not tested.
- CORS preflight behaviour was reasoned, not tested. `Vary` and `Cache-Control` on the responses the
  layer lets through are tested on both Express majors.
- Node's monotonic clock was not run against a real step of the system clock.
