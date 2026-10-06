# Bridge tests: the step 2 plan

**Status: a draft for review.** In the build order in [phase-1.md](phase-1.md), step 2 is the
bridge, `@overture-stack/usher-express-bridge`, in this repository: its tests first, with the
controller mocked, then the bridge itself, then the bridge and the Arranger adapter tested together.
This file is the plan for those tests. The adapter's own plan is step 1's, in Arranger's repository
at `.dev/docs/arranger-auth/usher-adapter-tests.md`, and this one picks up exactly where it stops.

The build order's two rules apply here as they did there. **The consumer's tests decide the
interface's shape, and the case table decides its answers.** The adapter has already fixed what it
needs from the bridge; these tests fix what the bridge needs from the controller.

---

## What these tests cover, and what they leave to others

| Concern                                                               | Where it is tested                          |
| --------------------------------------------------------------------- | ------------------------------------------- |
| Exchanging a sign-in token for an Usher token, signed in or anonymous | here                                        |
| Decrypting and validating the Usher token                             | here                                        |
| Rendering each registered key's enforcement result from the payload   | here                                        |
| Caching, and every way a cached token is dropped                      | here                                        |
| The degraded modes: within the grace period, uncertain, and cold      | here                                        |
| Attaching the request's access in Express                             | here                                        |
| The bridge's own log events                                           | here                                        |
| The bridge and the Arranger adapter together                          | here, at the end of the step                |
| What the controller computes from grants, groups and decisions        | step 3, the controller's tests              |
| The schema behind the controller                                      | the schema session, after this plan settles |
| Bridges for other frameworks                                          | each its own thin layer over the same core  |

---

## One request, traced

The case table's principal, Ana, has accepted a grant on HEART_STUDY's `controlled` records (case
5), and this is her first request of the day to the search application.

1. The bridge's middleware, mounted ahead of the GraphQL routers, takes her sign-in token from the
   request.
2. Its cache holds no Usher token for her, so it calls the controller mock's exchange with the
   sign-in token, the application's audience, and the payload versions it can read.
3. The mock answers with an encrypted token holding case 5's payload from `principals.json`.
4. The bridge decrypts it with the application's key and checks its type, audience and expiry, and
   that its payload version is one it listed.
5. It validates the payload against that version's schema.
6. For each key the adapter registered, it renders an enforcement result from the payload and that
   key's mapping, and checks the result with the validator from `@overture-stack/usher-types`.
7. It builds the request's access, her subject and those results, and attaches it with
   `attachAccess` to `res.locals.usher`.
8. Her next request inside the token's lifetime goes from step 1 to step 6 from the cache, with no
   call to the controller.

The value attached in step 7 is exactly what step 1's fake bridge attaches for case 5. That equality
is what closes the chain between the two plans.

---

## The controller mock

The mock follows phase-1's rules for mocks.

- **Seeded from the case table, never from what the bridge asks for.** Its payloads are the entries
  in `.dev/design/conformance/principals.json`, keyed by principal.
- **It refuses anything outside its set.** An unknown principal, an audience it does not serve or a
  payload version it does not hold is refused, the way the real controller would refuse it.
- **It issues real tokens**, encrypted with a test key for the application under test, because
  decrypting them is what the bridge is for.
- **It can be stopped**, which is how the grace period, the uncertain mode and the cold start are
  tested.
- **It serves the channels as scripted events:** revocation notices pushed and polled, category
  changes announced by resource, and the baseline-change notice. What each resource offers arrives
  in the payloads themselves, as `offeredCategories`.

Every endpoint and event the mock serves is a contract the real controller then implements in step 3. That list is the output this plan exists to produce, collected under "What this settles for the
controller" below.

---

## The fixtures

**Inputs:** the payloads in `principals.json`, and the adapter registrations from step 1's synthetic
catalogue: HEART_STUDY offering `controlled`, LUNG_COHORT offering no concrete category, and
REEF_ARCHIVE offering `controlled` and `community-governed`, on flat resource and category fields. A
registration gives each key its field names, the value each concrete category maps to, and the
categories it declares absent.

**Expected outputs:** step 1's fixture rows. For each case those rows cover, the bridge must render
exactly the result step 1's fake bridge holds. The bridge also takes every other case in the case
table, since rendering is the bridge's job and the adapter only passes results through.

**Cases that belong to the bridge alone**, because no payload or no adapter row expresses them:

| Case                                                                                              | Expected                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| grants held only in another registered key, this key having registered its resource list          | `deny`, `no-grants`, for this key                                                                                                                                     |
| the same, with no resource list registered for this key                                           | the narrowing as rendered, which matches nothing here; a list is optional, and only a key with one can tell "held elsewhere" apart                                    |
| every grant names a category this key's mapping leaves out                                        | `deny`, `no-grants`                                                                                                                                                   |
| a narrowing whose every predicate falls away when rendered                                        | `deny`, `no-grants`                                                                                                                                                   |
| an artifact key with its resource list missing or empty, or a record key registering an empty one | `deny`, `unknown-resource`, and `catalogue.resourceListMissing` logged at startup; the application still starts, and every other key is unaffected                    |
| an artifact type, every configured resource held                                                  | the provenance ceiling left out                                                                                                                                       |
| an artifact type, one configured resource not held                                                | the provenance ceiling present, naming it                                                                                                                             |
| an artifact whose recorded provenance is empty                                                    | matched by nothing: the narrowing holds an `in` over the held resources beside the `not`                                                                              |
| a configured resource held on some of the categories it offers but not all                        | treated as not held, so it stays in the complement                                                                                                                    |
| a key registered as open by configuration                                                         | `allow`                                                                                                                                                               |
| an entry carrying `artifact` actions alone, or `record` with `count` alone                        | no clause, and `deny` where it was the key's only entry                                                                                                               |
| a key mapping no concrete category                                                                | its `unmarked` clause is the resource test alone                                                                                                                      |
| a resource offering a concrete category the key neither maps nor declares absent                  | the resource left out of every clause for this key, other keys unaffected, and one `category.unmapped`, critical, naming the catalogue, the category and the resource |
| the same catalogue, category and resource met again                                               | no second event                                                                                                                                                       |
| a resource offering a category the key declares absent                                            | rendered, and `unmarked` needs no exclusion for it                                                                                                                    |
| a declared absence on a key that names a category field                                           | the registration refused at startup, since absence is only for a catalogue with no field that could carry the category                                                |
| any request, after a payload naming offered categories the principal does not hold                | no offered category in the attached access value or in any log line beyond `category.unmapped`                                                                        |
| a resource offering a `resource.` category the key does not map                                   | withheld like any other: a version 1 bridge grants nothing on it, and its records are still outside `unmarked` only if mapped                                         |
| every resource a key would render withheld                                                        | `deny`, `no-grants`                                                                                                                                                   |
| the anonymous payload fetched at startup naming a resource with a gap                             | the event logged at startup, before any request is served                                                                                                             |
| case 33, a revoked identity                                                                       | refused at the exchange with `401`, before any query runs                                                                                                             |
| case 34, an expired sign-in token                                                                 | refused at the exchange with `401`, never served as anonymous                                                                                                         |

Cases 33 and 34 are why `principals.json` omits them: neither produces a payload, so their
expectation is a refusal and lives here.

---

## The suites

Test names state the requirement.

### Exchange

| Given                                                                                                         | Then                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a sign-in token and an empty cache                                                                            | one exchange, carrying the token, the audience and the payload versions it can read                                                                                                                 |
| no sign-in token                                                                                              | the anonymous exchange, with no token sent, and a payload with a null subject                                                                                                                       |
| a sign-in token the controller refuses as expired or invalid                                                  | case 34: `401`, nothing attached, and no query runs                                                                                                                                                 |
| a principal whose identity is revoked                                                                         | case 33: the same `401` and the same text; only the log names the reason                                                                                                                            |
| a three-part signed token whose own `exp` has passed                                                          | refused locally with the same `401`, by the controller's clock tolerance, with no exchange                                                                                                          |
| an opaque credential, such as an API key                                                                      | exchanged, never refused locally                                                                                                                                                                    |
| a controller answering `401`, its refusal of the channel assertion                                            | unavailable: `503`, never cached as a refusal, logged as `token.exchangeFailure` with the cause `assertionRefused`, and at startup the bridge stays cold with the reason of a probable key mismatch |
| two `Authorization` lines, a scheme other than `Bearer`, or an `access_token` query parameter                 | `400` with `error="invalid_request"`, never exchanged and never served as anonymous                                                                                                                 |
| an Usher token the bridge cannot read, from its header to the validator                                       | treated as not received: `503`, a fixed reason code logged, and the failure held briefly so a broken controller is not asked again on every request                                                 |
| an anonymous exchange answered with a non-null `sub`, or one carrying a credential answered with a null `sub` | the same: not received, `503`                                                                                                                                                                       |
| concurrent requests carrying one sign-in token                                                                | one exchange                                                                                                                                                                                        |
| more exchanges in flight than the bridge allows                                                               | `503` for those beyond it                                                                                                                                                                           |
| an exchange failing for one principal while the notice stream is healthy                                      | that principal served the open tier, marked open-tier only and suspended, and the failure logged                                                                                                    |
| a controller unreachable                                                                                      | the degraded modes below apply                                                                                                                                                                      |

**Every refused identity gets one response**: `401`, with `WWW-Authenticate: Bearer error="invalid_token"` and the fixed text "You are no longer signed in, so this request was not served. You can sign in again, or continue without signing in." An expired, an invalid and a revoked identity are told apart in the log alone, so a refusal never tells a token's holder that the account was revoked. A portal answers it by dropping the session and showing the anonymous view with a notice, as case 34 describes.

### Token handling

| Given                                                                                                                                  | Then                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| a token for another audience, of another type, or expired                                                                              | rejected, never rendered                                                                               |
| a token whose ciphertext was altered                                                                                                   | rejected                                                                                               |
| a payload version the bridge did not list                                                                                              | treated as malformed                                                                                   |
| `global.unmarked` and `resource.pilot` on HEART_STUDY, the key mapping `resource.pilot`, then two requests inside the token's lifetime | rendered from `global.unmarked` alone, with exactly one `category.unenforced` recorded for the payload |
| `offeredCategories` naming a resource `permissions` does not, omitting one it does, or leaving out a category held there               | malformed: treated as not received, the application reports unavailable, and the rejection is logged   |
| a bare `open`, or an unknown prefix such as `local.pilot`                                                                              | malformed: treated as not received, the application reports unavailable, and the rejection is logged   |

The last two rows are phase-1's table for the case its controller never produces; the bridge's tests
build those payloads themselves rather than the mock issuing them.

### Rendering

| Given                                                | Then                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| each case in the case table, for each registered key | the expected result, equal to the canonical form `usher-types` defines, and matching the same records as step 1's row            |
| any narrowing                                        | no empty group, no empty exclusion and no pivot, and a set of values as one leaf's value list                                    |
| a category entry without `record` and `view`         | no clause, since one narrowing serves every read path and only viewing records earns a clause                                    |
| `unmarked` on a key                                  | a `not` around an `in` of every concrete category the key maps, never a `not-in`; on a key mapping none, the resource test alone |
| every result                                         | accepted by the validator in `@overture-stack/usher-types` before it is attached                                                 |

**The canonical form groups by category.** For each category held with `record` and `view`, one `and` of an `in` over every resource holding it and that category's test, composed with `or`, plus one `unmarked` clause over every resource whose unmarked records are held. It grows with categories rather than with resources times categories, which matters once a deployment serves hundreds of studies. These tests compare structure against it; the suites run together with the adapter compare records, since structure is the bridge's concern and records are what a person sees.

### Cache

| Given                                                                              | Then                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| a second request carrying the same sign-in token                                   | no exchange                                                                   |
| a sign-in token forged to carry a cached principal's subject                       | exchanged, never served from the cache, and refused                           |
| an entry past the earlier of its Usher token's `exp` and its sign-in token's `exp` | dropped, so the next request exchanges again                                  |
| a refused sign-in token sent again inside the TTL and before its `exp`             | refused from the refusal store, with no exchange                              |
| a flood of unique refused tokens                                                   | the refusal store evicts its own entries, and no principal's entry is evicted |
| two principals                                                                     | separate entries, and neither's access ever attached to the other's request   |
| anonymous requests                                                                 | one shared entry, fetched at startup and kept fresh                           |

**The cache is keyed by a SHA-256 digest of the whole sign-in token, never by a claim inside it.** The bridge never validates a sign-in token itself, so a subject read from one is whatever its sender wrote. Entries are also indexed by the subject from the decrypted Usher payload, which the bridge can trust, so a notice naming a principal finds every entry of theirs. Positive entries and refusals live in separate bounded stores.

### Revocation and invalidation

**One notice stream carries every kind**, pushed and polled alike: a principal's revocation, a category change, the baseline change, a global revocation and a sign-out. Each notice holds a position in one sequence the controller issues. A pushed event carries it as its id, a reconnecting push resumes with `Last-Event-ID`, and the poll asks for the notices after a position rather than after a time, so neither clock skew nor a late-committing write loses one.

| Given                                      | Then                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| a pushed notice naming a principal         | every entry indexed under them dropped; their next request exchanges again                   |
| a notice of any kind the push missed       | the next poll, from the last position, returns it within one poll interval                   |
| a push reconnecting                        | it resumes from its last position and misses nothing                                         |
| a category change announced for a resource | every entry naming that resource dropped, the anonymous one included                         |
| a baseline-change notice                   | every entry dropped, the anonymous one included, since every payload carries the baseline    |
| a global revocation                        | every entry dropped                                                                          |
| a sign-out from the identity provider      | relayed by the controller as a principal notice, so every bridge drops that person's entries |
| a poll answered within its deadline        | a successful check, timed on the bridge's own clock                                          |
| a poll not answered within its deadline    | aborted at the deadline, no check, and retried at once                                       |
| a push event, with every poll held back    | its notices applied, but no check, so the grace period still runs out                        |

### Degraded modes

| Given                                                    | Then                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the stream silent for less than the grace period         | cached access served as normal                                                                                                                                                 |
| the stream silent past the grace period                  | uncertain: every request rendered from the last anonymous payload, marked open-tier only, each signed-in principal marked suspended, and `revocationChannel.modeChange` logged |
| uncertain, and the anonymous payload's own `exp` passing | still honoured, until the stream returns                                                                                                                                       |
| uncertain, then the stream returning                     | read from the last position, every notice applied before any grant is honoured again, then normal, and the mode change logged                                                  |
| the controller unreachable since the bridge started      | cold: `503` before any read path runs, nothing attached                                                                                                                        |

**What an application does with a suspended principal is its adapter's to test**, since only the application knows which operation a request is: a search is served the open tier, a suspended principal's export answers `503`, a fetch that only a grant could answer answers `503` for a missing object too, and a write answers `503`. The rule is in [adapter-integration.md](../design/adapter-integration.md). The bridge's part is the two marks.

### The Express layer

| Given                                             | Then                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| a request served normally                         | the access attached at `res.locals.usher` through `attachAccess`, frozen             |
| two concurrent requests from different principals | each sees only its own access                                                        |
| the cold mode                                     | the middleware answers 503 itself, and nothing downstream runs                       |
| the published types                               | `usher` declared on Express's `Locals`, in this package rather than in `usher-types` |

### Log events

| Given                            | Then                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| each event the suites above name | recorded once, with the fields the audit catalogue gives it                    |
| any event                        | no token, no payload, no sign-in token and no record identifier anywhere in it |

### Together with the adapter

Step 1's suites through the GraphQL router run once more, with this bridge and the controller mock
in place of step 1's fake bridge. Every row must still pass. A row that passes against the fake and
fails against the real bridge is a disagreement between the two plans, and it is settled before
either is changed.

---

## What this settles for the controller

These are the contracts the mock serves. They are what the real controller implements in step 3,
and the channel half of the schema is designed from them.

| Contract                      | What the bridge's tests fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The exchange                  | `POST` to `exchange` under the controller URL, authenticated by the channel assertion as the stream is, so the audience is the assertion's and never a body field; a JSON body of the credential, absent when anonymous, and the payload versions the bridge reads; answered `200` with the compact JWE as `application/jwt` and `Cache-Control: no-store`; one `403` with a fixed body for an expired, invalid or revoked identity, and `401` only for a refused channel assertion, as HTTP reads the request's own `Authorization`; an Usher token's `exp` capped at the sign-in token's `exp` |
| The notice stream             | one sequence across every kind, pushed with event ids and polled after a position. Positions must follow commit order, so the controller serializes notice writes or serves a poll only below its oldest open transaction. Under the controller URL: the poll is `GET notices?after=<cursor>&nonce=<nonce>`, or `head=true` in place of `after`, and the push is `GET notices/stream` with `Accept: text/event-stream`; both carry the channel assertion and an `Usher-Notice-Versions` header listing the notice versions the bridge reads, comma-separated                                     |
| Category-change announcements | what identifies the resource, and how a bridge learns which entries name it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Sign-outs                     | the controller receives the identity provider's back-channel logout, and relays it as a principal notice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The baseline-change notice    | its shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Offered categories            | computed with the payload from the same snapshot, for every resource it names, listing every category each offers, held or not, and refreshed by the category-change notice that drops entries naming the resource                                                                                                                                                                                                                                                                                                                                                                               |
| Resource identifiers          | literal values: registration refuses a name holding any marker in the list `usher-types` exports as `SPECIAL_VALUE_MARKERS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Clock tolerance               | the controller's tolerance for a sign-in token's `exp` never exceeds the bridges' local-refusal tolerance, 60 s by default, or a bridge would refuse a token the controller accepts                                                                                                                                                                                                                                                                                                                                                                                                              |
| The subject tag               | HMAC-SHA256 of the subject under the subkey derived from the application key with HKDF-SHA256, an empty salt and the info `usher/v1/subject-tag`, encoded as base64url without padding; the controller and the bridge produce the same string                                                                                                                                                                                                                                                                                                                                                    |

---

## Each assertion is proven load-bearing

| Suite          | Inversion                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------- |
| exchange       | serve case 34 as anonymous, and its row must fail                                         |
| token handling | skip the audience check, and the other-audience row must fail                             |
| rendering      | emit `unmarked` as a `not-in`, and the validator and its row must both fail               |
| rendering      | render a resource without reading what it offers, and the category-gap row must fail      |
| cache          | key the cache by the subject inside the sign-in token, and the forged-token row must fail |
| revocation     | poll after a time instead of a position, and the missed-notice row must fail              |
| degraded modes | keep honouring grants while uncertain, and the uncertain row must fail                    |
| revocation     | count a push event as a check, and the held-back-poll row must fail                       |
| Express layer  | attach the access unfrozen, and the frozen assertion must fail                            |

---

## Open for review

- **The poll deadline's default**, set with the controller, below the grace period less the poll
  interval. The liveness rows are written to the rule that a check is only a poll answered within its
  deadline.
- **The bound on exchanges in flight**, which the controller sets and tells its bridges. Its row
  holds whatever the number is; how a bridge learns it adds rows when it is designed.
- **Whether the controller mock outlives the controller**, wired to the conformance corpus as phase-1
  suggests, or retires when step 3 lands.
- **`generatedAt` acting on its own.** A bridge forcing a recomputation once a payload passes some age
  is open and unbuilt, so nothing here tests it.
- **Writes during the uncertain mode** answer `503`. Queueing them until the stream returns is revisited with the submission step, which is the first that writes.
