# Sign-in signature precheck

Checked on Node 24.16 on macOS against the npm registry (jose 6.2.12, openid-client 6.8.8), Entra
ID's public discovery documents and key sets, and Keycloak's documentation and source (latest release
26.8.0), 2026-10-04.

The Usher bridge is the library embedded in each ushered application to trade a person's sign-in
token for their access. This note holds the research behind two of the bridge's contracts in
[decisions.md](../../../design/decisions.md): the bridge checks no sign-in token's signature,
proposed there on 2026-10-04, and the bridge answers a flood of junk credentials with its in-flight
bound alone, a trade accepted for the first release.

## Decisions

- The bridge never refuses a credential acceptable to the controller
  ([decisions.md](../../../design/decisions.md), "The bridge's cache is keyed by the sign-in token,
  never by a claim inside it").
- The bridge does not check a sign-in token's signature, in any form that can refuse it; decisions.md
  records this as proposed on 2026-10-04.
- The bridge refuses locally only a three-part signed token whose own `exp` has passed, by the
  controller's clock tolerance, and sends every other bearer credential it can read to the exchange.
- Two `Authorization` lines, a scheme other than `Bearer`, or an `access_token` query parameter get
  `400` with `error="invalid_request"`, and are never exchanged
  ([Bridge core and Express layer](core-and-express-layer.md), "Reading the credential"). API keys
  come as `Bearer`. That `400` is not a refusal in this note's terms, so the never-refuse rule holds.
  The rule's edge is the scheme: a credential sent under any scheme but `Bearer` never reaches the
  controller, so it is neither accepted nor refused.
- Any later local check has to show that it keeps the never-refuse rule before it is built.
- In the first release, the in-flight bound alone answers a flood of unique junk credentials.
- That trade is accepted: the controller stays up and cached principals keep their access until their
  entries end, while new sign-ins and refreshes are answered 503 for as long as the flood lasts.
- The anonymous refresh runs outside the in-flight bound, so a flood cannot stop the open tier from
  refreshing.
- Admission control that keeps sign-ins served through a flood is research on the
  [roadmap](../../../roadmap.md), "Admission control against a flood of junk credentials".
- The admission-priority lane is the leading candidate for that research.
- If a signature check or the lane is ever built, the controller serves the key sets to bridges, and
  each bridge refreshes its copy in the background (see "Provider knowledge in every application").
- A rate-limit answer from the controller, a 429, has the unavailable outcome: 503, with its status
  logged. It never has the failed outcome, the one that serves a signed-in person the open tier. So a
  controller shedding exchanges with 429 moves no signed-in person to the open tier, while one
  shedding with 503 lands on the failure path
  ([Bridge core and Express layer](core-and-express-layer.md), "Reading the answer", which names
  both outcomes).
- No log event carries a sign-in token's key identifier. A bridge behind on a key rotation is
  diagnosed from the controller's side.

**Why no refusing check, whether strict or lenient.**

| Reason                                                                                                                                                                                                                                                 | Evidence                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| It cannot stop the flood it exists for. A check keeping the never-refuse rule must let through a token naming a key not held by the bridge, and the sender writes that name. API keys carry no signature at all.                                       | "Why a refusing check cannot keep the flood out" |
| It puts identity provider configuration into every ushered application. The design gives that configuration to the controller's connector alone. Keys fetched from the providers also need network access from every application pod to each provider. | "Provider knowledge in every application"        |
| It is a second validator. Every way it can disagree with the controller refuses a person admitted by the controller.                                                                                                                                   | "A second validator that can disagree"           |

## Terms used here

| Term              | Meaning in this note                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| precheck          | a check by the bridge of the sign-in token's signature, against the identity provider's published keys, before the exchange                                                                         |
| refuse            | answer a credential with the one fixed `401`; distinct from `deny`, which is an enforcement result and never answers a credential, and from the `400` for a request whose credential cannot be read |
| junk              | a credential refused by every exchange, such as a token signed by no published key; in a flood, each one is unique                                                                                  |
| key identifier    | the `kid` member of a signed token's header, naming which published key signed it; the token's sender writes it                                                                                     |
| held key          | a key in the key set held by the bridge at that moment                                                                                                                                              |
| never-refuse rule | the bridge never refuses a credential acceptable to the controller, as decisions.md records it                                                                                                      |
| strict precheck   | refuses on any failure to verify                                                                                                                                                                    |
| middle option     | refuses only when the signature fails under a held key and an allowed algorithm, and lets everything else through                                                                                   |

## What the decided design already handles

The stores, coalescing and the in-flight bound are specified in
[Bridge core and Express layer](core-and-express-layer.md); this table reads them against forged and
junk credentials.

| Credential                                        | What happens, with no precheck                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| a token forged to carry a cached person's subject | a new digest, so it misses the cache, goes to the exchange, and is refused there             |
| the same refused token sent again                 | answered from the refusal store, with no exchange                                            |
| one token carried by many requests at once        | one exchange, shared                                                                         |
| a three-part token whose own `exp` has passed     | refused locally                                                                              |
| a stream of unique junk                           | each is a new digest: it misses both stores, shares no exchange, and takes an in-flight slot |

**So a precheck adds nothing to confidentiality.** Keying the cache by a digest of the whole token
already defeats a forged subject. What is left is availability, and only against the last row.

**The test plan overstates what a check would do.** The "Open for review" item in the
[test plan](../../bridge-tests.md) says a check would keep forged tokens off the exchange entirely.
It keeps off only forgeries that claim a held key. That item also calls the check an option
being researched, while decisions.md records as proposed that the bridge checks no signatures.

## One flood, traced

**The decided design.**

1. A sender streams three-part tokens, each unique, each unexpired, each signed by no published key.
2. Each token is a new digest, so neither the positive store nor the refusal store holds it.
3. Its `exp` has not passed, so the bridge does not refuse it locally.
4. It takes a slot in the in-flight bound and waits for the exchange.
5. The controller refuses it. The refusal is stored and never read again, since the token never
   returns.
6. A person signing in for the first time arrives while every slot is taken, and is answered 503.
7. A person already cached is served from their entry until it ends, at most one TTL (5 minutes by
   default).
8. Their refresh is an exchange too, so it is answered 503 for as long as the flood lasts.

**With the middle option, and junk carrying an invented key identifier.** Steps 1 to 3 as above, then:

3a. The precheck holds no key under that identifier. A newly rotated key looks the same, so the
token goes through. Steps 4 to 8 follow unchanged, both 503s included.

**With the middle option, and junk claiming the provider's real key identifier.** Steps 1 to 3 as
above, then:

3a. The signature fails under the held key, so the bridge refuses the token locally and it never
takes a slot. At step 6 the person signing in is served.

**With an admission-priority lane, and any junk.** Steps 1 to 3 as above, then:

3a. The token's signature does not verify under a held key, so it may take only a slot in the capped
lane. Nothing is refused locally. At step 6 the person signing in carries a token that verifies, so
it takes a slot in the reserved lane and is served.

## What was measured

Two independently written single-process models of the bridge, each with the decided refusal store,
coalescing per digest, and an in-flight bound of 16 that answers 503 beyond it. A mock controller on
a local port answered after 50 ms and accepted only 200 legitimately signed tokens. 128 concurrent
senders cycled 3000 unique junk credentials while 200 legitimate first exchanges arrived 5 ms apart.
Only the comparison between rows means anything; the absolute numbers are not sizing.

| Scenario                                                                                         | First sign-ins served, of 200 |
| ------------------------------------------------------------------------------------------------ | ----------------------------- |
| no precheck, junk claiming the provider's key identifier                                         | 0 in all four runs            |
| middle option, the same junk                                                                     | 200 in all four runs          |
| middle option, junk with invented key identifiers                                                | 9 to 20                       |
| middle option, junk shaped as API keys (UUIDs)                                                   | 0 to 1                        |
| no flood                                                                                         | 200 in all four runs          |
| priority lane, unverified credentials capped at 8 of the 16 slots, each of the three junk shapes | 200 (one model)               |

A precheck placed before the in-flight bound, as modelled, does unbounded work of its own; see "Cost
per check".

## Why a refusing check cannot keep the flood out

**A new key cannot be told from an invented one in time.** Keycloak signs every new token with a new
key as soon as it is available: "Once new keys are available, all new tokens and cookies will be
signed with the new keys" ([Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/),
"Rotating keys"). jose's remote key set learns a missing key only once its cooldown, 30 s by default,
has passed since its last successful fetch. Measured with a virtual clock: a token signed by a newly
published key failed with no fetch 5 s after the last fetch, and verified at 31 s.

**Junk does not lengthen that window, but it keeps one open.** Every refetch, including one triggered
by junk with an invented identifier, loads the whole current key set, so a rotation stays
unverifiable for at most one cooldown. With invented identifiers arriving every second, the bridge's
last fetch is always recent, so a rotation reliably lands inside a window. Measured delays were 15 to
29 s with that junk, and none in the run without it, where the last fetch was more than one cooldown
old.

**So the rule forces the gap.** A strict precheck would refuse valid people for up to one cooldown
after every rotation. A precheck keeping the never-refuse rule must let unknown identifiers through.
The sender chooses the identifier, so junk with an invented one costs nothing extra.

**API keys cannot be checked locally at all.** They are `UUID.randomUUID()` strings, hashed at rest
and checked at the exchange ([api-keys.md](../roadmap/api-keys.md), "What the existing API key plugin
does"). A UUID has no signature, so any local check lets it through. Junk shaped as UUIDs left 0 to 1
of 200 sign-ins served under the middle option. A shape check, refusing credentials that are neither
a signed token nor shaped as a UUID, does not help: random UUIDs pass it, and it contradicts the
decided rule that every bearer value the bridge can read goes to the exchange, with no grammar check
([Bridge core and Express layer](core-and-express-layer.md), "Reading the credential").

## What a check would cost

### Provider knowledge in every application

| Cost                                                                                                                               | Why it matters                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issuer, key set location and allowed algorithms in every ushered application; with several providers, a map from issuer to key set | [architecture.md](../../../design/architecture.md) lists among what Keycloak does not own "Any awareness of bridges or adapters: Keycloak is not aware they exist; the controller validates IdP tokens against Keycloak on the bridge's behalf". [admin-model.md](../../../design/admin-model.md) says "The connector is the only component that knows it is talking to a specific provider". |
| each provider added to the controller must also reach every bridge                                                                 | under a strict check, a bridge that has not caught up refuses that provider's people                                                                                                                                                                                                                                                                                                          |
| network egress from application pods to the identity provider                                                                      | today they need egress to the controller only. By default Keycloak's backchannel URLs equal its frontchannel URLs, so discovery from an address inside the cluster returns the public key set location unless `hostname-backchannel-dynamic` is enabled ([hostname guide](https://www.keycloak.org/server/hostname)).                                                                         |
| a discovery client                                                                                                                 | jose has no OpenID Connect discovery (read from its source, not run), so finding the key set from an issuer needs openid-client or a hand-written metadata fetch                                                                                                                                                                                                                              |

architecture.md also lists among Keycloak's duties "Exposing public keys so downstream services can
verify IdP token signatures". Read beside the same section's statement that Keycloak is unaware of
bridges and adapters, the downstream service meant there is the controller.

**If a check or the lane is ever built, the controller serves the key sets.** Configured in each
bridge, per provider, that knowledge would cost every row above. Served by the controller and
refreshed in the background, the key sets keep one source of truth, need no egress from application
pods to providers, and leave the connector the only component that talks to a provider. That costs a
new controller endpoint and a refresh loop in the bridge. Even then, the bridge holds a map from
issuer to key set and an algorithm allowlist equal to the controller's (conditions 4 and 5 under
"If a refusing check is ever built"). Until
its next refresh it also lacks a newly added provider's keys, so a strict check refuses that
provider's people.

### A second validator that can disagree

**The controller's acceptance is already narrower than a valid signature.** It checks expiry and
issuer. Where the provider supports it, the controller also confirms through token introspection
(RFC 7662) at each exchange that the provider's session is still active
([admin-model.md](../../../design/admin-model.md), "OIDC connector design"). So a bridge check can
only ever be a necessary condition. Each row below is a way it would refuse someone admitted by the
controller.

| Source of disagreement                                | What happens                                                                                                                                                                                                                                                                      | Strict precheck                              | Middle option                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| claims checked with jose's `jwtVerify`                | it always checks `exp` and `nbf` when present, with zero clock tolerance by default. Measured: a token whose `nbf` was 2 s ahead was refused, and accepted with a 5 s tolerance and by `compactVerify`.                                                                           | refuses                                      | unaffected: it uses `compactVerify`, which checks no claims |
| Entra's issuer is a template                          | discovery names `https://login.microsoftonline.com/{tenantid}/v2.0` for v2 and `https://sts.windows.net/{tenantid}/` for v1. jose matches an issuer exactly; Microsoft's rule is to substitute the token's `tid`, and to check each signing key's own issuer, which jose ignores. | needs provider-specific code                 | unaffected while no claim is checked                        |
| Entra's v1 and v2 key sets differ                     | at one moment, v1 served 5 key identifiers and v2 served 7, v1 a subset of v2; the two keys only in v2 name one specific tenant as their issuer                                                                                                                                   | refuses a v2-only key at a bridge reading v1 | lets it through as unknown                                  |
| Entra keys specific to one application                | an application using claims mapping signs with keys served at the key set location plus an `appid` query parameter ([access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens))                                                                     | refuses                                      | lets it through as unknown                                  |
| an algorithm allowlist narrower than the controller's | a key published without an `alg` member, as Entra publishes them, verified RS256, RS384, RS512, PS256, PS384 and PS512 alike (measured), so the allowlist alone decides                                                                                                           | refuses                                      | lets it through                                             |
| a key identifier kept for new key material            | Keycloak's java-keystore provider gives each configured component a random identifier and keeps it when the keystore's key changes (read from source, not run)                                                                                                                    | refuses                                      | refuses, until the bridge's next refresh                    |
| signature encoding                                    | jose refused a DER-encoded ES256 signature and an RSA signature with its leading zero byte stripped; OpenSSL through `node:crypto` accepted the DER one (measured)                                                                                                                | refuses                                      | refuses, if the controller's verifier is that lenient       |
| a fault inside the crypto call                        | jose reads an exception thrown inside WebCrypto's verify as a failed signature (read from source, not run)                                                                                                                                                                        | refuses                                      | refuses, unless the bridge checks the result itself         |
| the bridge holds no keys                              | the provider has been unreachable since start, or jose's cache age has passed with the provider down                                                                                                                                                                              | refuses everyone                             | lets everything through                                     |

**Checking only the signature removes the claim rows, not the others.** Three rows refuse under the
middle option too, which is why it needs the controller invariants listed under "If a refusing check
is ever built".

### Behaviour of jose's remote key set

`createRemoteJWKSet` fetches inside the verification call. Its defaults are a 5 s timeout, a 30 s
cooldown and a 10 minute cache age (read from source). The behaviours below were measured against a
key set served on a local port, unless marked.

| Behaviour                                                  | Measured                                                                                                                                                                  | What a bridge must do instead                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a key endpoint that accepts connections and never answers  | each verification waited about 5 s with the default timeout, and about 0.5 s with a 500 ms timeout                                                                        | never wait on the network inside a request                                   |
| past the cache age, with the provider down                 | even a valid token failed with the fetch error, though the old keys were still held                                                                                       | refresh in the background and keep the last good set                         |
| a failed fetch starts no cooldown                          | with the provider down, every call needing a fetch tried one: 100 sequential calls made 100 fetches, 100 concurrent calls made 1                                          | pace retries off the request path                                            |
| a key endpoint that redirects                              | refused: redirects are not followed and a 200 is required (read from source, not run)                                                                                     | configure the final location                                                 |
| a token with no key identifier, against two candidate keys | fails; jose does not try each candidate                                                                                                                                   | let it through                                                               |
| errors from claim checks                                   | `JWTClaimValidationFailed` and `JWTExpired` carry the token's full claims on `.payload` and on `cause.payload`; signature and parsing errors carry only a code and a name | never log a jose error object; `compactVerify` never raises the claim errors |

With a local key set (`createLocalJWKSet`) rebuilt in the background, a forgery under a held key was
refused in under a millisecond with the provider down and no network call.

### Cost per check

| Operation, sequential                   | Time per call                                  |
| --------------------------------------- | ---------------------------------------------- |
| RS256 `compactVerify`                   | about 30 to 37 µs, of which about 10 µs is CPU |
| SHA-256 digest of a 547-character token | under 1 µs                                     |

**The digest lookups go first.** They cost a thirtieth as much, and the test plan needs them first
(see "If a refusing check is ever built").

**The check's work needs a cap of its own.** WebCrypto's verify runs on libuv's thread pool. With a
pool of one thread, a verify waited about 200 to 240 ms behind one `pbkdf2` job, against 0.1 ms with
four threads. Concurrent checks reached about 59,000 to 96,000 per second, and the rate did not grow
with the pool size from one thread to eight, so the gain over the sequential rate is pipelining, not
parallel threads. A flood of junk under held keys therefore costs event-loop time shared by every
request. It also queues on the pool used by `dns.lookup`, including for the bridge's own calls to the
controller.

## Admission control, on the roadmap as research

| Candidate                                                                                               | What it does                                                                                             | Measured                           | What it costs or leaves open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the in-flight bound alone (decided for the first release)                                               | answers 503 beyond the bound                                                                             | 0 of 200 sign-ins under flood      | keeps the controller up, which is its job; every new sign-in and every refresh is answered 503 while a flood lasts                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| an admission-priority lane in the bridge (the leading candidate)                                        | refuses nothing locally; reserves part of the bound for tokens whose signature verifies under a held key | 200 of 200 against each junk shape | needs key knowledge, which the controller serves (see "Provider knowledge in every application"). API key holders, and tokens under a key rotated within the last cooldown, share the capped lane with junk. Anyone able to obtain tokens from the same provider, for example through self-registration, can fill the reserved lane, since no audience is checked. A bridge without keys puts every credential in the capped lane, which lowers capacity and refuses no one (reasoned, not measured). The split between the lanes is one more setting. |
| per-client limits before authentication, at the ingress or the bridge                                   | limits exchanges for new digests per client                                                              | not measured                       | before authentication the only client key is a network address. Behind a portal's server side (Stage is a Next.js application with one), every person arrives as one client, so one abuser exhausts everyone's budget. The bridge reads the address only through the host application's Express `trust proxy` setting. A permissive setting lets forwarded headers rotate identities. A restrictive one gives every person the proxy's address. An address is personal information, so it stays out of every log event.                                |
| rate limiting on the Usher API (listed as not started in the [design index](../../../design/README.md)) | limits exchanges at the controller                                                                       | not measured                       | the client of the exchange is the bridge ([security-workflow.md](../../../design/security-workflow.md), "The token exchange": "The bridge, never the adapter and never a browser"), so a limit there meters a whole application and cannot tell junk from sign-ins. It protects the controller, not the people signing in. How the bridge reads a rate-limit answer from the controller is set in [Bridge core and Express layer](core-and-express-layer.md).                                                                                          |

## If a refusing check is ever built

The proposal in decisions.md is not to build one. Every condition below would be required. The
admission-priority lane needs the conditions on keys and on the request path too, though not the
controller invariants, since a disagreement there only moves a legitimate token into the capped lane.

**Configuration and keys.**

1. Off by default, enabled by configuration per application.
2. `compactVerify` only: the signature, and no claims. The local `exp` refusal stays the only claim
   the bridge reads.
3. The key sets served by the controller, held as a local key set rebuilt in the background, never
   fetched inside a request.
4. The key set chosen by the token's unverified issuer, only among issuers served by the controller.
   A fetch address is never derived from the token's `iss`, `jku` or `x5u` or from an embedded `jwk`
   header. Discovery never runs from a token's `iss`. Otherwise an application pod fetches from
   addresses chosen by a sender. jose's local key set ignores those headers. Key sets from several
   providers are never merged, since two providers' identifiers can collide.
5. The algorithm allowlist equal to the controller's.

**Refusing.**

6. Refuse only when the signature check returned false, under a held key and an allowed algorithm.
   jose reads a fault inside WebCrypto as a failed signature. So the bridge cannot key the refusal on
   jose's error class alone. It needs its own check of the verify result, or a fault would tell a
   signed-in person they are no longer signed in.
7. Let everything else through: an unknown key, several matching keys, no keys available, an
   algorithm outside the allowlist, a malformed token, a credential that is not a signed token.
8. Answer a local refusal with the same `401` and the same fixed text as the exchange
   ([decisions.md](../../../design/decisions.md), "A refused identity gets one 401, whatever the
   reason"). Its quicker answer is not an existence oracle. The timing depends only on the token and
   the public key set. It reveals at most whether the check is enabled and which public keys are held
   by the bridge, never whether a principal or resource exists.

**Controller invariants, written down before the check is built.**

9. The controller accepts a sign-in token only if its signature verifies under the key published by
   its provider for that key identifier. A future provider accepted by introspection alone breaks
   this.
10. The controller's signature check is no more lenient than a compact JWS check under RFC 7515 and
    RFC 7518: ECDSA signatures as the raw concatenation of the two integers, RSA signatures at full
    length. One verifier shared by the controller and the bridge, with the same algorithm set, the
    same key selection by issuer and the signature only, keeps the encoding and algorithm rows of the
    disagreement table from drifting. With separate implementations, each row of that table becomes
    a test run against both. Which of the two a check would use is open (see "Open questions").
11. Each provider binds a key identifier to its key material. Keycloak's generated and imported RSA
    providers do: the identifier is the base64url SHA-256 of the encoded public key unless an
    administrator sets one (read from source, not run). Its java-keystore provider does not, as the
    disagreement table shows. So that provider is either declared unsupported where a bridge checks
    signatures, or every key change gets a new key component, and so a new key identifier; which of
    the two is open, like the choice in condition 10. Entra's identifiers are SHA-1 certificate
    thumbprints: for all seven keys in the v2 set, the identifier equals `x5t` and the SHA-1 of the
    certificate in `x5c`, whose public key matches the key (checked against the published set).

**In the request path.**

12. Order: the positive-store and refusal-store digest lookups; the local `exp` refusal; the
    signature check, under its own concurrency cap; coalescing per digest and the in-flight bound;
    the exchange.
13. The check's answer carries no identity. A token whose signature verifies may still be expired
    within tolerance, issued to another client, revoked, or rejected by introspection. So nothing
    downstream may read it as a subject, a cache index, or a reason to mark the principal. The
    decrypted payload's subject stays the only trusted identity.

```ts
/** A refusing check's whole answer: no identity, no claim, no key identifier. */
type SignatureCheck = { kind: 'refuse' } | { kind: 'not-refused' };

/** An admission lane's whole answer: it picks a lane, and is read for nothing else. */
type AdmissionLane = 'held-key' | 'unverified';
```

14. A local refusal is one structured event with no token, no digest, no claim, no subject and no
    key identifier. No trusted subject exists before the exchange. No event may carry any part of the
    sign-in token, and the key identifier is part of it, written by its sender. A bridge behind on a
    rotation is diagnosed from the controller's side. As a `credential.refusal`, the event would need
    an `origin` value not yet registered in [audit-events.md](../../../design/audit-events.md).

**Measured verdicts of the middle option**, against a local key set:

| Credential                                   | Middle option |
| -------------------------------------------- | ------------- |
| a valid token                                | not refused   |
| a held key identifier, signed by another key | refused       |
| the payload altered under a real signature   | refused       |
| an empty or truncated signature              | refused       |
| an unknown key identifier                    | not refused   |
| no key identifier, one key held              | not refused   |
| ES256, outside an RS256 allowlist            | not refused   |
| `alg` `none`                                 | not refused   |
| HS256 using the public key as the secret     | not refused   |
| invalid base64                               | not refused   |
| a UUID                                       | not refused   |

**What changes in the test plan.** A refusing check would empty three rows of the "Cache" suite in
the [test plan](../../bridge-tests.md) of meaning, if their tokens claim a held key:

| Row                                                  | Why it would no longer test anything                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| a forged token carrying a cached principal's subject | refused before the cache key mattered                         |
| a refused token sent again                           | "no exchange" passes without the refusal store doing anything |
| a flood of unique refused tokens                     | never fills the store                                         |

Its inversion under "Each assertion is proven load-bearing", keying the cache by the subject inside
the sign-in token, would no longer fail. These fixtures would have to use unknown key identifiers or
opaque credentials, or the order of the lookups would have to be asserted. The "Exchange" row for an
expired three-part token would change too, as would the "Open for review" item and the line in
decisions.md that the bridge refuses locally only a three-part signed token whose own `exp` has
passed. An admission-priority lane leaves all of these rows intact, since it refuses nothing
(reasoned, not measured).

**The test plan has no row for the never-refuse rule itself**, so a later local check would have no
test to fail against. The nearest is the "Exchange" row for an opaque credential, exchanged and
never refused locally.

## Options compared

| Option                  | Junk it keeps from the exchange                                         | Keeps the never-refuse rule                                                                                        | Provider knowledge in applications                                              | Verdict                                                   |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| strict precheck         | signed tokens under any key identifier; never UUIDs                     | no: rotation, an unreachable provider, Entra's key sets, the allowlist, a new provider, the keystore, the encoding | yes                                                                             | rejected                                                  |
| middle option           | only signed tokens claiming a held key                                  | only with the three controller invariants                                                                          | yes, where enabled                                                              | rejected: an invented key identifier passes it at no cost |
| admission-priority lane | none refused; all three measured shapes kept from crowding sign-ins out | yes: it refuses nothing                                                                                            | yes: an issuer map and an allowlist, with the key sets served by the controller | roadmap research, the leading candidate                   |
| decided design alone    | none                                                                    | yes                                                                                                                | none                                                                            | kept for the first release, as an accepted trade          |

## Not verified

1. No Keycloak instance was run. Token shapes, such as `iss` under internal and external hostnames
   and the defaults for `aud` and `azp`, come from documentation and source, not from issued tokens.
   `aud` in Keycloak is filled by audience mappers, so it is configured per deployment.
2. No Entra tenant was used. Keys specific to one application, and v1 against v2 token issuance, were
   not exercised. The difference between the v1 and v2 key sets is a snapshot at one moment.
3. The controller's sign-in validation is not built, so its algorithm set, clock tolerance, issuer and
   audience rules, key cache and choice among providers are unknown. Everything above holds against a
   controller assumed to verify signatures with the provider's published keys.
4. The flood models run in one process with a mock controller. They do not model network costs,
   ingress limits, several bridge replicas, traffic served from the positive store, or refreshes.
5. The admission-priority lane was measured in one model, with a split of 8 of 16 slots that was not
   tuned.
6. ES256, EdDSA and very large key sets were not measured, and choosing a key set by unverified issuer
   was not built.
7. Microsoft states that tokens whose audience is Microsoft Graph cannot be validated by third
   parties. Whether such a token could reach the exchange in an Overture deployment was not examined.
   The controller would refuse it too, so it is not a disagreement.

## Open questions

1. **Whether a refusing check shares the controller's verifier, and how it treats Keycloak's
   java-keystore provider.** The bridge checks no signatures, as proposed in decisions.md, so this
   arises only if a refusing check is ever built. One verifier shared with the controller keeps the
   encoding and algorithm rows of the disagreement table from drifting, while separate
   implementations make each row a test run against both (condition 10). The java-keystore provider
   keeps a key identifier across new key material, so it is either declared unsupported where a
   bridge checks signatures, or every key change gets a new key component (condition 11).
