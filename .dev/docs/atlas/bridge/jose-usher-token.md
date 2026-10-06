# jose for the Usher token

Checked on Node 24.16 on macOS 27.2, on an Apple M4 Pro laptop with 12 cores, against the npm
registry (jose 6.2.12, zod 4.6.5, tsx 4.23.15, TypeScript 7.0.2, pino 10.4.0), 2026-10-04. Every
behaviour stated here was run there unless the sentence says it was read from source, from a
specification, or reasoned. Every timing is that machine's.

Every application that Usher protects embeds a shared library, the bridge, which receives an
encrypted token from the Usher controller and reads the principal's permissions out of it. This note
covers how the bridge decrypts and validates that token with the jose library, and how the controller
mock encrypts one for the bridge's tests. jose's defaults are permissive, its errors carry the
decrypted payload, and its type parameter erases a null subject. Each rule below closes one of those.

## Decisions

**Decrypting**

- The bridge calls `jwtDecrypt` with a key resolver and every option in
  [Each option closes a default](#each-option-closes-a-default) set, and passes no `crit` option.
- The Usher token's clock tolerance is 0.
- Before jose reads anything, the bridge reads the protected header with `decodeProtectedHeader` and
  rejects the token unless `typ` is exactly `usher+jwt`.
- The resolver rejects a protected header carrying any member other than `alg`, `enc` and `typ`.
- `kid` joins that allowlist only together with key rotation.
- The resolver takes the key from a `Map` keyed by `kid`, which holds one entry until rotation lands.

**The key**

- The bridge's API takes the key as a 43-character base64url string in canonical form, and the bridge
  does not start on any other value.
- After import the bridge holds the key only as `CryptoKey`s and keeps no reference to the raw bytes.
- The key that decrypts the Usher token is a non-extractable AES-GCM `CryptoKey` whose only usage is
  decrypt.
- The application key is used directly only for Usher tokens, and every other use gets an HKDF
  subkey, as [Revocation notice stream](revocation-notice-stream.md) sets out.
- The bridge therefore imports the same bytes a second time, as a non-extractable HKDF key.
- The anonymous exchange at startup is the key's self-test.

**Validating**

- The strict `usher-types` validator checks the claims after jose.
- `requiredClaims` is generated from the validator's member list, never written by hand.
- jose's generic type parameter stays at its default, and the validator produces the payload's type.
- The reader for a `payloadVersion` is selected through a `Map` or a zod literal union, never by
  indexing a plain object.
- `sub` is bound to the kind of exchange: a non-null `sub` answering an anonymous exchange, or a null
  `sub` answering an exchange that carried a credential, rejects the token.
- An Usher token whose `sub` differs from the subject of a three-part sign-in token is rejected.
- The [fixture checker](../../../check-fixtures.py) and `usher-types` both require a name after a
  category's scope prefix, reject an empty or `__proto__` resource identifier or category name, and
  require `generatedAt` no later than `iat`.

**A rejected token**

- A rejected Usher token is never rendered and is treated as not received, and the request gets 503.
- A rejected token is never served as suspended, and never answered with the 401 that refuses an
  identity.
- A rejected token is kept apart from a failed exchange, whose outcome is set out in
  [Bridge core and Express layer](core-and-express-layer.md).
- Rejected tokens and failed exchanges are held in the short failure store of
  [Bridge core and Express layer](core-and-express-layer.md), apart from refusals, for a fixed
  interval that is configurable and bounded.
- A broken controller is therefore not asked on every request, and the bridge still recovers quickly
  once the controller is fixed.
- When the anonymous refresh is rejected while the channel is healthy, the anonymous entry is still
  served as ordinary cache while it is unexpired and no notice has dropped it.
- Once that entry has expired or a notice has dropped it, anonymous and open-tier requests get 503.
- A notice that drops the anonymous entry discards it for good, so it is never revived as the
  uncertain-mode fallback, which serves the anonymous results even past the payload's `exp`
  ([Bridge core and Express layer](core-and-express-layer.md)).
- A bridge is cold until it has accepted an anonymous payload since start, so a rejected startup token
  leaves it cold, answering 503 before any read path.
- Each rejection is logged as a `token.rejection` event carrying one of the fixed
  [reason codes](#reason-codes).
- The startup token's rejection is logged as `token.rejection` like any other.
- The cold state that follows a rejected startup token has a reason code of its own, which names a
  probable key mismatch. [audit-events.md](../../../design/audit-events.md) registers that reason on
  `revocationChannel.modeChange`.

**Logging**

- A rejection is logged by its fixed reason code alone. The bridge never logs a jose error, a zod
  error or the `jwtDecrypt` result.
- Neither the exchange's request body nor its response body reaches a log on any path: answers other
  than 2xx, parse failures, retries and the HTTP client's debug output.
- A `kid` stays out of logs like every other value read from the token, since `token.rejection`
  carries only a fixed code.
- The `usher-types` enforcement-result validator, `readAccess` and Arranger's guard each throw a
  fixed-text error with no `ZodError` as its message or cause.
- Arranger logs only the class or a code of what `readAccess` throws.

**Caching**

- Decryption and validation run once per exchange, never per request; where rendering runs is set out
  in [Bridge core and Express layer](core-and-express-layer.md).
- An entry ends at the earliest of its Usher token's `exp`, its receipt plus the TTL timed on the
  monotonic clock, and its sign-in token's `exp`. The receipt bound holds even if a controller defect
  issues a long `exp`.
- No store keeps the Usher token or a decrypted payload; the [core note](core-and-express-layer.md)
  lists what each store holds.

**The exchange response and the controller mock**

- The exchange's HTTP layer caps the response body before jose reads it, with a configurable cap that
  has a default.
- The controller mock mints whole corpus payloads with `new EncryptJWT(payload)` under the header
  `{ alg: 'dir', enc: 'A256GCM', typ: 'usher+jwt' }`.
- The mock never sets the IV, the content encryption key, the subject by its setter, or `zip`.
- The mock's own tests assert that two mints of one payload have different IV segments.
- The mock stamps a distinct `sub` per credential into the payload, because all 31 signed-in cases in
  [principals.json](../../../design/conformance/principals.json) share one `sub`.
- For a three-part sign-in token, the stamped `sub` is the token's own subject. The anonymous cases
  keep `sub: null`.
- Tests pin time with jose's `currentDate` option, never with fake timers.

The `typ` value, `dir` with A256GCM and the key per application are recorded in
[decisions.md](../../../design/decisions.md). The 503 for a failed decryption is in
[adapter-integration.md](../../../design/adapter-integration.md) ("Fail-secure when the bridge cannot
deliver a resolved permissions payload"), and the single 401 for a refused identity is in
decisions.md ("A refused identity gets one 401, whatever the reason"). No design document records
the clock tolerance of 0 yet: [to-discuss.md](../../../design/to-discuss.md) still lists clock skew
for `exp` and `iat` among the token-spec details with no stated answer.

## Terms used here

| Term                  | Meaning in this note                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usher token           | the controller's answer to the exchange, a JWE carrying the principal's payload                                                                                                                                                                     |
| reject (a token)      | the bridge fails to read an Usher token, at any step from the header check to the validator; the token is treated as not received and the request gets 503. [Bridge core and Express layer](core-and-express-layer.md) names this outcome malformed |
| reject (a library)    | jose, zod or WebCrypto throws on an input; inside token reading, that is one way the bridge rejects the token                                                                                                                                       |
| malformed (a payload) | the validator rejects the decrypted payload; one cause of a rejected token, with the same 503                                                                                                                                                       |
| refuse                | reserved for the identity outcome: the controller refuses the identity at the exchange, or the bridge refuses locally a signed sign-in token whose own `exp` has passed; the request gets the one fixed 401                                         |

**A rejected token is never a refusal.** A refusal says something about the person's identity. A
rejection says something about the controller or the deployment.

## The package

| Fact          | Value                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version       | 6.2.12, the only dist-tag (`latest`), published 2026-09-05. Version 6.0.0 was published 2025-02-22.                                                                                 |
| Module format | ESM only: `"type": "module"`. Every export has only the `types` and `default` conditions, and none has `require`. On Node 24, `require('jose')` still works through `require(esm)`. |
| Dependencies  | None. 80 files, 210,660 bytes unpacked.                                                                                                                                             |
| Runtime       | No `engines` field. Version 6 ships only a Web API build, so all of its cryptography goes through Node's built-in WebCrypto (`globalThis.crypto.subtle`).                           |

The [technology stack](../roadmap/technology-stack.md) says jose runs on Node's built-in
cryptography. In version 6 that means WebCrypto. jose accepts a `node:crypto` `KeyObject` but
converts it on every call.

jose's ESM-only build, and keeping its types and `CryptoKey` out of the bridge's public declarations,
belong to [Packaging the bridge](packaging-and-toolchain.md), which covers both.

## The decrypt call

### jwtDecrypt rather than compactDecrypt

`jwtDecrypt` runs three steps (read from source):

1. the same compact decryption core that `compactDecrypt` runs;
2. the claims checks;
3. a check that any `iss`, `sub` or `aud` copied into the protected header equals the claim.

`compactDecrypt` would give the same cryptography and the same allowlists, and leave `exp`, `aud`,
`iss`, `typ` and the presence checks to be written by hand.

### Each option closes a default

Each row was shown by decrypting a token with the option left out.

| Option                        | jose's default                                  | What the default admits                                                                                           | Setting                      |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `keyManagementAlgorithms`     | every algorithm that fits the key, except PBES2 | `A256KW` and `A256GCMKW` tokens that use the application key as the wrapping key, even under the decrypt-only key | `['dir']`                    |
| `contentEncryptionAlgorithms` | every content encryption algorithm              | `A256CBC-HS512` under `dir` with a 64-byte key                                                                    | `['A256GCM']`                |
| `maxDecompressedLength`       | 250,000 bytes                                   | a token with `zip: "DEF"`, decompressed after decryption                                                          | `0`, which rejects any `zip` |
| `requiredClaims`              | none                                            | a token with no `exp`, which then never expires                                                                   | every payload member         |
| `typ`                         | not checked                                     | `typ: "JWT"`                                                                                                      | `'usher+jwt'`, as a backstop |
| `crit`                        | no extension recognized                         | nothing: any `crit` header is rejected before the resolver runs                                                   | leave unset                  |

`audience` is the application's audience, `issuer` the controller's, and `clockTolerance` is 0.

**jose reads a numeric `clockTolerance` in seconds.** It also takes a time-span string such as
`'30s'`. A tolerance of 30000, meant as 30 seconds written in milliseconds, accepted a token eight
hours past its `exp` and rejected one nine hours past. `30` and `'30s'` rejected a token one hour
past. A configuration that holds a tolerance in milliseconds converts it to seconds before it
reaches `jwtDecrypt`. A `NaN` tolerance makes every call throw a `TypeError`, so a bridge that passed
one would reject every token. The Usher token's tolerance is 0, so the unit matters only where a
nonzero tolerance reaches jose.

**A tolerance of 0 makes acceptance and the per-request drop use the same rule.** Skew can then only
shorten an entry. A bridge clock ahead of the controller's by more than a token's life rejects every
token, which fails closed and visibly. The controller's clock tolerance still governs the
local refusal of an expired three-part sign-in token, a separate setting.

**The key's usage restriction does not pin the algorithm.** Without `keyManagementAlgorithms`, jose
accepted an `A256GCMKW` token under the bridge's own non-extractable, decrypt-only key. The allowlist
is what pins `dir`.

**jose's `audience` check accepts an `aud` array that contains the expected audience.** The validator
therefore pins `aud` to a string, as the type says and as [to-discuss.md](../../../design/to-discuss.md)
recommends.

**jose's `maxTokenAge` cannot cap an entry at its receipt plus the TTL.** Decryption runs once per
exchange, so `maxTokenAge` checks age only at receipt. A token whose `exp` was a day out was accepted
under a `maxTokenAge` of 300 seconds. `maxTokenAge` would also reject an `iat` in the future, which
turns skew into a hard failure.

### The shape

The sketch shows the order of the checks. Its parts were run separately, not as this one function.

```ts
import { decodeProtectedHeader, jwtDecrypt } from 'jose';

const allowedHeaderMembers = new Set(['alg', 'enc', 'typ']); // 'kid' joins when rotation lands

const decryptOptions = {
	audience: applicationAudience,
	clockTolerance: 0,
	contentEncryptionAlgorithms: ['A256GCM'],
	issuer: controllerIssuer,
	keyManagementAlgorithms: ['dir'],
	maxDecompressedLength: 0,
	requiredClaims: membersEveryListedVersionRequires, // generated from the usher-types schemas
	typ: 'usher+jwt', // backstop; the exact check below runs first
};

const readProtectedHeader = (usherToken: string) => {
	try {
		return decodeProtectedHeader(usherToken);
	} catch {
		throw new UsherTokenRejected('headerUnreadable');
	}
};

const resolveKey = (protectedHeader: JWEHeaderParameters) => {
	if (Object.keys(protectedHeader).some((member) => !allowedHeaderMembers.has(member))) {
		throw new UsherTokenRejected('headerMember');
	}
	const key = keyring.get(protectedHeader.kid); // a Map; today one entry, under undefined
	if (key === undefined) {
		throw new UsherTokenRejected('headerKeyId');
	}
	return key; // non-extractable AES-GCM CryptoKey, usage ['decrypt']
};

const readUsherToken = async (usherToken: string) => {
	if (readProtectedHeader(usherToken).typ !== 'usher+jwt') {
		throw new UsherTokenRejected('headerType');
	}
	const { payload } = await jwtDecrypt(usherToken, resolveKey, decryptOptions); // payload only
	const reader = payloadReaders.get(payload.payloadVersion); // a Map, never a plain object
	if (reader === undefined) {
		throw new UsherTokenRejected('payloadVersionUnlisted');
	}
	const parsed = reader.safeParse(payload);
	if (!parsed.success) {
		throw new UsherTokenRejected('payloadMalformed');
	}
	return parsed.data;
};
```

The code around `readUsherToken` turns every other error into a reason code, as
[Reason codes](#reason-codes) lists.

## The header, before decryption

**jose's own `typ` check is late and loose** (read from source). It runs after decryption, once the
plaintext has been parsed as a JSON object. It lowercases both sides and adds an `application/` prefix
when there is no slash, so `USHER+JWT` and `application/usher+jwt` both pass it. The exact pre-check
rejects both. No token emitted by the controller fails the exact check.

**The resolver is not first either.** jose calls it only after these steps (read from source):

1. Split the token into five parts.
2. Parse the protected header as JSON.
3. Check `crit`.
4. Check that any `zip` value is one jose supports.
5. Check that `alg` and `enc` are present.
6. Check `alg` against its allowlist.
7. Check `enc` against its allowlist.

A token with `alg: "A256KW"` and `typ: "JWT"` is therefore reported as a disallowed algorithm, never as
a wrong type, when `typ` is checked only in the resolver. `decodeProtectedHeader` reads the first
segment alone. It returns a JWE's protected header, and throws a plain `TypeError`, not a jose error,
for a header it cannot read.

**Rejecting on an unauthenticated header is safe.** jose's own documentation of the resolver says no
part of the token has been authenticated when it runs. Rejecting on such a header only rejects more.
The encoded protected header is the additional authenticated data for AES-GCM (read from
source), so any change to it fails decryption, even reordering the same members. A header that passed
the checks is therefore authenticated the moment decryption succeeds.

**The member allowlist closes two open items on the read side.** It rejects `zip`, `cty`, `crit`,
`jku`, `jwk` and `x5u`, and any `iss`, `sub` or `aud` copied into the header. With the two algorithm
allowlists, it makes RFC 8725 §3.1 (pin `alg` and `enc` on read) and §3.6 (never compress) hold in the
bridge. Both are listed open in [to-discuss.md](../../../design/to-discuss.md). Any future header
member becomes a deliberate change on both sides.

**After decryption, jose checks in this order** (read from source): the decompression limit, the
plaintext being a JSON object, `typ`, the presence of required claims, `iss`, `sub`, `aud`, the type of
`iat` when it is present, `nbf`, `exp`, and the age of `iat` only when `maxTokenAge` is set. jose
reports the first check that fails, so a token for the wrong audience that has also expired is
reported as `aud`.

## The key

### What jose and WebCrypto accept

| Form            | Decrypts a good token | A key of the wrong length                                                                                                      |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Uint8Array`    | yes                   | caught only at the first decrypt, as `JWEInvalid`                                                                              |
| `KeyObject`     | yes                   | caught only at the first decrypt, as `JWEInvalid`                                                                              |
| JWK of type oct | yes                   | caught only at the first decrypt, as `JWEInvalid`; `importJWK` returns the bytes unchecked                                     |
| `CryptoKey`     | yes                   | raw import accepts 16, 24 and 32 bytes and throws on any other length; a 16-byte key fails at decrypt with a plain `TypeError` |

Neither library guarantees a 32-byte key, so the bridge checks it itself.

### The startup check

1. Require the configured key to match `^[A-Za-z0-9_-]{43}$`. Forty-three base64url characters carry
   258 bits, so any match decodes to exactly 32 bytes. The pattern is the length check.
2. Require canonical form: encoding the decoded bytes again gives back the configured string. The last
   character carries two unused bits, so four strings decode to the same 32 bytes. This keeps the
   configured value unambiguous and rejects no other key.
3. Check that the decoded length is 32, as defence in depth.
4. Import with `crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt'])`.

**The bridge does not lean on a decoder's strictness.** jose's base64url decoder throws on invalid
characters but tolerates padding and whitespace. On Node 24.16 that tolerance comes from a fallback
through `atob`, used because `Uint8Array.fromBase64` is absent there (read from source), so it depends
on the runtime. Node's `Buffer` base64url decoding silently drops an invalid character, so a mistyped
43-character key decodes to 31 bytes.

### Why a non-extractable, decrypt-only CryptoKey

- It cannot be exported: `exportKey` throws on it.
- Code inside the process cannot mint tokens with it: encryption with it throws. This is defence in
  depth only, because whoever holds the raw secret can still mint, as
  [decisions.md](../../../design/decisions.md) already accepts.
- `jwtDecrypt` returns the resolved key in its result, beside `payload` and `protectedHeader`. With a
  `Uint8Array` or a `KeyObject`, that is the raw secret as bytes. With this key it cannot be exported.
  The bridge takes `payload` alone from the result either way, so no log, spread or return carries the
  key.
- It is the fastest form on the corpus-sized token: 21 µs per decrypt, against 26 µs for a
  `Uint8Array`, which jose imports again on every call, and 28 µs for a `KeyObject` created once.

### The second import, as an HKDF key

- The decrypt-only key cannot feed HKDF: `deriveBits` and `deriveKey` with it throw
  `InvalidAccessError`, because its only usage is decrypt.
- WebCrypto keeps an HKDF key non-extractable by rule. Importing one marked extractable throws, and
  `exportKey` on one throws.
- An HMAC key derived from the HKDF key with `deriveKey` came back non-extractable, with only the
  usages asked for.
- The HKDF key cannot decrypt an Usher token: jose throws a `TypeError` naming the wrong algorithm.
  Each key serves one role.

The subkeys derived from it, and their agreement with a controller deriving through `hkdfSync`, are
in [Revocation notice stream](revocation-notice-stream.md).

### A wrong key, and the self-test

Any wrong 32-byte key, another application's included, fails as `JWEDecryptionFailed`. Altered
ciphertext, tag or IV fails identically. The failure tells nobody which part was wrong.

The bridge fetches the anonymous payload at startup, so a key mismatch shows as a failed decryption
of that first token. The bridge then stays cold, since it holds no accepted anonymous payload.

**One mismatch passes the self-test.** If the same wrong key is configured for this application on
both sides, decryption succeeds. The audience check is then the only defence, so it stays mandatory.
Key distinctness across applications is a deployment check that the bridge cannot make.

## What jose checks, and what the validator must

The [payload type](../../../design/security-workflow.md#the-payload-as-a-type) has nine members:
`payloadVersion`, `sub`, `iss`, `aud`, `iat`, `exp`, `generatedAt`, `permissions` and
`offeredCategories`. `offeredCategories` is under a proposal in
[decisions.md](../../../design/decisions.md), on where a catalogue's category gap is found. Generating
`requiredClaims` from the validator keeps the bridge right whichever way the proposal goes.

| Concern                                                                                   | jose, with the options above                                                                      | The `usher-types` validator                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| five parts, a JSON header, `crit`, `zip`, pinned `alg` and `enc`, IV, tag and key lengths | yes                                                                                               | nothing more                                                                                                            |
| integrity of the header and the ciphertext                                                | yes                                                                                               | nothing more                                                                                                            |
| the plaintext is a JSON object                                                            | yes                                                                                               | nothing more                                                                                                            |
| `typ`                                                                                     | a normalized comparison                                                                           | nothing; the exact pre-check covers it                                                                                  |
| presence of every member                                                                  | yes; `sub: null` counts as present, and an omitted `sub` is rejected                              | also required                                                                                                           |
| `iss`                                                                                     | equal to the configured issuer                                                                    | a string                                                                                                                |
| `aud`                                                                                     | accepts an array containing the audience                                                          | a string, so an array is malformed                                                                                      |
| `exp`, `iat`, `nbf`                                                                       | times checked only when present; `iat`'s time only with `maxTokenAge`; fractional values accepted | integers for `iat`, `exp` and `generatedAt`                                                                             |
| `payloadVersion`                                                                          | presence only                                                                                     | one of the versions listed by the bridge                                                                                |
| `sub`                                                                                     | presence only                                                                                     | a non-empty string or `null`, then bound to the kind of exchange                                                        |
| members at the root                                                                       | ignored                                                                                           | a strict object: any member outside the type, `nbf` and `jti` included, is malformed                                    |
| category names in `permissions` and in `field`                                            | none                                                                                              | `global.<name>` or `resource.<name>`; a bare name or another prefix is malformed                                        |
| a `resource.` category                                                                    | none                                                                                              | passes, and rendering records it as `category.unenforced`                                                               |
| action lists                                                                              | none                                                                                              | non-empty, each action in its own entity's vocabulary                                                                   |
| an unknown entity key                                                                     | none                                                                                              | tolerated and stripped, so it reaches nothing                                                                           |
| empty `permissions`                                                                       | none                                                                                              | valid: a principal holding no grants                                                                                    |
| `offeredCategories`                                                                       | none                                                                                              | a non-empty list per resource; names exactly the resources named in `permissions`; includes every category held on each |

Every row but the last was run through jose and then a zod 4.6.5 schema written for the purpose. The
last row comes from the type's rules and the [test plan](../../bridge-tests.md), not from a run. A
schema with only the first eight members accepted none of the 35 payloads in
[principals.json](../../../design/conformance/principals.json): all failed on `offeredCategories` as
an unknown member. One with the ninth member accepted all 35.

The [fixture checker](../../../check-fixtures.py) also fails a repeated action in one list and an
`exp` at or before `iat` (read from its source).

Three further rules:

- **Select the reader for `payloadVersion` through a `Map` or a zod literal union, never by indexing a
  plain object.** `payloadVersion` can be any JSON value, and a name such as `constructor` returns an
  inherited member. That still fails, but as an unexpected error rather than an unlisted version.
- **A resource identifier or category name of `__proto__` is malformed.** zod 4.6.5's `record` drops
  such a key silently rather than rejecting it. Dropping narrows, so it fails closed. It still breaks
  "malformed means not received", and leaves the `offeredCategories` rules unchecked for that key.
- **Leave jose's generic at its default.** `jwtDecrypt<PermissionsPayload>` types the payload as
  `PermissionsPayload & JWTPayload`. `JWTPayload` declares `sub?: string`, so the intersection is
  `string` and the `null` disappears. TypeScript 5.8.3 and 7.0.2 both show it.

### Binding sub to the exchange

jose and the type both accept a `sub` of either kind. Only the bridge knows which exchange it made.

- **An anonymous exchange answered with a non-null `sub`.** Serving it would put one principal's
  grants and subject into the shared anonymous entry, which serves every visitor. That fails open.
- **An exchange carrying a credential answered with a null `sub`.** Serving it would treat the
  principal silently as anonymous, and notices naming them would never find the entry. The contract
  already refuses an invalid identity at the exchange rather than serving it as anonymous.
- **A `sub` that differs from a three-part sign-in token's own subject.** The bridge can read that
  subject without verifying the signature. A mismatch catches a coalescing or caching defect that pairs
  one credential with another's answer. Opaque API keys carry no readable subject, so this covers
  sign-in tokens only. It relies on the controller's `sub` being the identity provider's subject
  unchanged, as the type says.

## When a token is rejected

Every failure in reading the token, from the header pre-check to the validator, has one outcome: the
token is rejected, never rendered, treated as not received, and answered 503. The
[test plan](../../bridge-tests.md) says the same of a malformed payload.
[Bridge core and Express layer](core-and-express-layer.md) calls the outcome malformed and answers it
the same way.

### Why errors are never logged

- jose's `JWTClaimValidationFailed` and `JWTExpired` carry the whole decrypted claims set as an own
  enumerable `payload` property, and again in `cause.payload`.
- `JSON.stringify`, `util.inspect` (what `console.error` prints) and pino 10.4.0's error serializer all
  write the principal's permissions and subject into the log line. An ordinary `logger.error({ err })`
  on a claim failure therefore breaks the rule that nothing of the payload is logged.
- zod's issues carry paths that hold resource identifiers and category names. `ZodError.message` and
  `String(error)` include them, `reportInput` adds the received value, and an unknown-member issue names
  the members.
- jose's messages can include header parameter names taken from the token, line breaks included.
  Logging a message lets a token's author write into the log.

So the bridge logs a reason code alone. It never logs an error's message, payload, cause, stack or
issue paths.

### Reason codes

The codes are camelCase, like the other reason values in
[audit-events.md](../../../design/audit-events.md). `token.rejection` is registered there, with
`reason` as a fixed code and no other field, so `claimRejected` names neither the failing claim nor
jose's check. [Bridge core and Express layer](core-and-express-layer.md) holds the complete list of
events the bridge emits.

| Where reading fails                                                                                 | Reason                   |
| --------------------------------------------------------------------------------------------------- | ------------------------ |
| `decodeProtectedHeader` cannot read the header                                                      | `headerUnreadable`       |
| `typ` is not exactly `usher+jwt`                                                                    | `headerType`             |
| a header member outside the allowlist                                                               | `headerMember`           |
| `kid` not in the keyring                                                                            | `headerKeyId`            |
| `JOSEAlgNotAllowed`                                                                                 | `algorithmNotAllowed`    |
| `JOSENotSupported`                                                                                  | `headerUnsupported`      |
| `JWEInvalid`                                                                                        | `tokenMalformed`         |
| `JWEDecryptionFailed`                                                                               | `decryptionFailed`       |
| `JWTInvalid`                                                                                        | `claimsNotObject`        |
| `JWTExpired`                                                                                        | `expired`                |
| `JWTClaimValidationFailed`                                                                          | `claimRejected`          |
| a `payloadVersion` not listed by the bridge                                                         | `payloadVersionUnlisted` |
| the validator rejects the payload                                                                   | `payloadMalformed`       |
| `sub` does not match the kind of exchange, or differs from a three-part sign-in token's own subject | `subjectMismatch`        |
| anything else                                                                                       | `unexpected`             |

### Beyond the token

- **The same rule holds for every SQON validation.** `usher-types`' enforcement-result validator,
  `readAccess`, and Arranger's guard all validate filters carrying resource identifiers and category
  values, which together amount to the principal's grants. Each throws a fixed-text error, with no
  `ZodError` as its message or cause. Arranger logs only the class or a code of what `readAccess`
  throws.
- **The exchange's HTTP layer never logs a body.** Neither the request body nor the response body,
  which is the Usher token, reaches a log on any path: answers other than 2xx, parse failures, retries,
  and the HTTP client's debug output.
- **Timing creates no existence oracle** (reasoned, not run). The cost of decrypting and rendering
  grows only with the requesting principal's own payload, and no error reaches a client.

## Decryption cost

Measured on the machine named at the top: `jwtDecrypt` with a `CryptoKey`, the median of three runs of
10,000 sequential calls after 1,000 warm-up calls. The payloads had eight members, before
`offeredCategories`, so sizes and times are lower bounds for the payload as typed today.

| Payload                                    | Plaintext | Token     | Decrypt | Decrypt and validate |
| ------------------------------------------ | --------- | --------- | ------- | -------------------- |
| the corpus's case 7 shape, three resources | 460 B     | 719 B     | 21 µs   | not measured         |
| three resources, three categories each     | 1,033 B   | 1,483 B   | 25 µs   | 30 µs                |
| five resources, three categories each      | 1,591 B   | 2,227 B   | 27 µs   | 35 µs                |
| 50 resources                               | 14,146 B  | 18,967 B  | 101 µs  | 154 µs               |
| 500 resources                              | 139,696 B | 186,367 B | 863 µs  | 1,438 µs             |

- The cached path, a SHA-256 digest of a 1.3 KB credential with a `Map` lookup and an expiry
  comparison, took about 1 µs.
- A burst of 100 concurrent decrypts averaged 13 µs each.
- The absolute figures belong to that machine; the ratios carry over.
- Decrypting on every request would cost 20 to 1,400 times more, and would mean rendering again.
- Decrypting again gives revocation nothing, because revocation works by notices dropping entries,
  never by validating the token again.

**The cache entry.** An opaque API key and an anonymous request have no sign-in `exp`. `Math.min`
given `undefined` returns `NaN`, and `NaN <= now` is false, so a drop written as "the earliest expiry
is at or before now" never drops such an entry. The per-request drop is therefore written
`!(expiresAt > now)`, and an absent sign-in `exp` is left out of the minimum.
[Bridge core and Express layer](core-and-express-layer.md) lists what the entry holds.

## Rotation readiness

A resolver selecting from a `Map` keeps rotation open without deciding it.
[adapter-integration.md](../../../design/adapter-integration.md) ("Decryption key distribution")
leaves rotation open. These were run with `kid` in the member allowlist, which is how it would stand
once rotation lands:

| Keyring                 | Token                                                                    | Result                                                  |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| one key, under no `kid` | no `kid`                                                                 | accepted                                                |
| one key, under no `kid` | any `kid`                                                                | rejected before decryption                              |
| two keys, `k1` and `k2` | `kid` `k1` or `k2`                                                       | accepted, with the matching key                         |
| two keys, `k1` and `k2` | an unknown `kid`, no `kid`, a `kid` that is an object, `kid` `__proto__` | rejected before decryption                              |
| two keys, `k1` and `k2` | encrypted under `k1`, with a header naming `k2`                          | decryption fails, because the header is authenticated   |
| either                  | a disallowed `alg` with an unknown `kid`                                 | rejected by the allowlist; the resolver is never called |

A `Map` lookup never uses `kid` as a path or a query and never walks a prototype, which is what RFC
8725 §3.10 asks (reasoned). A `kid` is not secret, yet it stays out of logs like every other value read
from the token: `token.rejection` carries only fixed values.

**The AES-GCM bound is an input to rotation policy, not a blocker.** NIST SP 800-38D §8.3 caps a key at
2^32 encryptions when IVs are random (read from the specification, the November 2007 edition, which
NIST plans to revise). jose draws a fresh random 12-byte IV for each encryption. At a sustained 100
tokens a second, one key reaches 2^32 in about 1.36 years; at 10 a second, in about 13.6 years.

## The controller mock

```ts
const usherToken = await new EncryptJWT(payload) // the whole corpus payload, sub, iat and exp rewritten
	.setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'usher+jwt' })
	.encrypt(applicationKeyBytes);
```

- **Pass the payload whole.** `setSubject(null)` throws a `TypeError`, because jose's claim setters
  take strings only. The constructor copies its argument with `structuredClone`, so `sub: null` and the
  member order survive a round trip.
- **Seed it from the corpus.** Passing each payload from
  [principals.json](../../../design/conformance/principals.json) keeps the mock on the corpus, as the
  [test plan](../../bridge-tests.md) requires, `offeredCategories` included.
- **Stamp a distinct `sub` per credential, in the payload.** All 31 signed-in cases in principals.json
  carry the same `sub`, so a test that two principals never share an entry passes vacuously unless
  each credential's payload carries a subject of its own. For a three-part sign-in token, that
  subject is the token's own, so the subject comparison passes. The 4 anonymous cases keep
  `sub: null`.
- **Never call `setInitializationVector` or `setContentEncryptionKey`, and never set `zip`.** jose does
  not guard against IV reuse: two encryptions given the same IV both succeed, with identical IV
  segments. The rule is the only protection, so the mock's own tests assert that two mints of one
  payload have different IV segments. Left to itself, jose gives each mint a fresh 12-byte IV, a
  different ciphertext, an empty encrypted-key segment and a 16-byte tag.
- **Pin time with `currentDate`, not fake timers.** With the corpus instants (`iat` 1767225600,
  `exp` 1767225900) and `clockTolerance` 0, a `currentDate` of `iat` plus 299 seconds is accepted,
  and one equal to `exp` is expired. jose treats `exp` at or before the current time, less the
  tolerance, as expired.
- One mint costs 48 to 52 µs.

## Not verified

- The timings come from the machine named at the top, not from the cluster nodes that run the
  applications. Memory use was not measured here.
- With no controller yet, the cap on the exchange response before decryption was not tested.
- Stage, a Next.js application whose server side would embed a bridge, was not tested. jose's build is
  universal, so it should load there; that is unverified, as are edge runtimes.
- The zod schemas were written for these checks. They are not the `usher-types` validators, and the
  `offeredCategories` rules were not run.
- Whether the controller can hold an encrypt-only, non-extractable `CryptoKey` for `EncryptJWT`, the
  way the bridge holds a decrypt-only one, was not run.
- Whether a draft revision of NIST SP 800-38D changes the 2^32 bound was not checked.

## Open questions

1. **Key rotation**, open on the controller side. How often a key rotates, and how a bridge picks up a
   new key without dropping in-flight tokens, are open in
   [adapter-integration.md](../../../design/adapter-integration.md) ("Decryption key distribution").
   Two triggers fit the 2^32 bound: the controller counts encryptions per application key and rotates
   well before the bound, or rotation runs on a schedule short enough that no plausible rate reaches
   it. `kid` arrives with the mechanism, as [to-discuss.md](../../../design/to-discuss.md) says ("the
   rule and the mechanism arrive together or neither does").
2. **The default of the token size bound, the cap on the exchange response.** Before
   `offeredCategories`, a principal holding grants in 500 resources produced a 186 KB token, and the
   nine-member token is larger and is to be measured again. A cap rejects any answer beyond it. That
   bounds memory but leaves a principal with very many grants unable to get access, so the default
   sets that point for every deployment that does not configure its own.
   [to-discuss.md](../../../design/to-discuss.md) lists the bound as open. The open default does not
   block implementation.
3. **The mode change a startup key mismatch is logged as.**
   [audit-events.md](../../../design/audit-events.md) registers a probable key mismatch among the
   reasons of `revocationChannel.modeChange`, an event that records the bridge moving between modes.
   A bridge whose startup token is rejected never leaves cold, so no mode changes. Either the bridge
   emits a startup `modeChange` whose `fromMode` marks the start, or it emits cold to cold. No design
   document says which.
