# Plugin Integration

_Status: not started. This document captures what is known about requirements and surfaces the
open questions that need answers before design work can begin._

---

## Concept

Each Overture application integrates with Usher via a **PEP plugin**: a middleware or library
package specific to that app's framework. The plugin's responsibilities:

1. Intercept incoming requests and extract the user's IdP bearer token.
2. Exchange the IdP token for a JWE grants token (on first request or after TTL expiry).
3. Cache the grants token for its TTL duration; validate locally on subsequent requests.
4. Translate the grants payload into the app's native query filter format.
5. Maintain the revocation channel (push subscription + poll fallback).
6. Enter revocation-uncertain mode and suspend sessions if the revocation channel goes dark.

Items 2-3 and 5-6 are implemented by the shared bridge library (`@overture-stack/usher-bridge`).
Each app-specific plugin (`@overture-stack/usher-arranger`, etc.) builds on `usher-bridge` and
adds item 4.

---

## Decided

**JWE decryption is the bridge's responsibility, not the plugin's.** The bridge holds the
decryption key (provisioned at client app deploy time), decrypts grants tokens, and
exposes the result to the plugin as a typed `GrantsPayload` object. Plugins never see the raw
JWE or the decryption key. This keeps the plugin interface simple: receive a payload, translate
it to a query filter, done.

## Known requirements

The full responsibility split between bridge and plugin is in [architecture.md](architecture.md).
The lists below summarise the requirements relevant to implementation, including specifics not
captured in the component description.

**Bridge (`usher-bridge`) — shared by all plugins:**
- Hold the JWE decryption key (provisioned at deploy time; key distribution mechanism TBD)
- Exchange the user's IdP bearer token for a JWE grants token with the controller; for
  unauthenticated requests, perform the exchange with no bearer token to receive an
  anonymous grants token containing only open-tier grants
- Decrypt the grants token and expose a typed `GrantsPayload` to the plugin
- Cache the grants token; validate locally within the TTL window
- Maintain the revocation channel: SSE or WebSocket push with reconnection logic, and poll
  fallback at a configurable interval
- Enter revocation-uncertain mode and return 503 after the grace period

**Plugin (per-app, e.g. `usher-arranger`) — specific to each integration:**
- Intercept incoming requests and extract the user's IdP bearer token
- Call the bridge to get the `GrantsPayload` for the requesting user
- Translate the payload into the app's native query filter format
- TTL, grace period, and poll interval must be configurable per bridge instance

---

## Open questions

### Decryption key distribution

The bridge holds the JWE decryption key; plugins do not. How is the key provisioned to the
bridge at client app deploy time?

Options:
- Environment variable at deploy time (simple, but rotation requires redeploy)
- Fetched from a secrets manager (Vault, AWS Secrets Manager) at startup
- Issued by the controller itself via a key-exchange endpoint requiring mutual TLS or a bootstrap
  token

Key rotation strategy (frequency, how the bridge picks up a new key without downtime) is also
open. A rotation scheme must allow the old key to remain valid for in-flight tokens during the
switchover window.

### API contract

The specific endpoints, request/response shapes, error codes, and authentication scheme for the
Usher REST API are not yet defined. The grants token exchange, revocation poll, and push
subscription endpoints all need a formal contract before plugins can be built.

### Grants payload schema

The top-level `grants` map (keyed by resource ID, per-resource `role` + `categories` include-list)
is decided; see [security-workflow.md](security-workflow.md) for the full structure and examples.
Field-level restriction representation (if included) is not yet designed. The schema must be
versioned and stable before plugins depend on it.

### Per-app translation design

How should the translation layer (grants payload to app-native filter) be structured? Should
the `usher-bridge` library provide a translation interface that each app plugin implements, or is
the translation entirely the plugin's concern with no shared abstraction? The answer affects how
testable and consistent constraint enforcement is across apps.

### Error handling and fallback

What should a plugin do if the grants token exchange fails (Usher is unreachable at first
request)? Options: reject the request, allow through with a default "no access" constraint, or
queue and retry. The answer must be consistent with the fail-secure principle.
