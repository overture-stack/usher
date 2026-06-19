# Plugin Integration

_Status: not started. This document captures what is known about requirements and surfaces the
open questions that need answers before design work can begin._

---

## Concept

Each Overture application integrates with Usher via a **PEP plugin**: a middleware or library
package specific to that app's framework. The plugin's responsibilities:

1. Intercept incoming requests and extract the user's IdP bearer token.
2. Exchange the IdP token for a JWE constraint token (on first request or after TTL expiry).
3. Cache the constraint token for its TTL duration; validate locally on subsequent requests.
4. Translate the constraint payload into the app's native query filter format.
5. Maintain the revocation channel (push subscription + poll fallback).
6. Enter revocation-uncertain mode and suspend sessions if the revocation channel goes dark.

Plugins share a common client library (`@overture-stack/usher-client`) for items 2-6. Each
app-specific plugin (`@overture-stack/usher-arranger`, etc.) adds item 4 on top.

---

## Known requirements

- Plugins must hold the JWE decryption key to validate and decode constraint tokens locally.
- Plugins must maintain a persistent connection to Usher (SSE or WebSocket) for push revocation
  events, with reconnection logic.
- Plugins must poll `GET /revocations?since=<timestamp>` as a fallback at a configurable interval.
- TTL, grace period, and poll interval must be configurable per plugin instance.
- Constraint translation must be app-specific: SQON for Arranger, query conditions for Lyric, etc.

---

## Open questions

### Decryption key distribution

How does a plugin receive and hold the JWE decryption key?

Options:
- Environment variable at deploy time (simple, but rotation requires redeploy)
- Fetched from a secrets manager (Vault, AWS Secrets Manager) at startup
- Issued by Usher itself via a key-exchange endpoint requiring mutual TLS or a bootstrap token

Key rotation strategy (frequency, how plugins pick up a new key without downtime) is also open.
A rotation scheme needs to allow the old key to remain valid for in-flight tokens during the
switchover window.

### API contract

The specific endpoints, request/response shapes, error codes, and authentication scheme for the
Usher REST API are not yet defined. The constraint token exchange, revocation poll, and push
subscription endpoints all need a formal contract before plugins can be built.

### Constraint payload schema

The attribute names used in the constraint payload (`resources`, `record_filters`,
`exclude_categories`, `field_restrictions`, etc.) are illustrative in current design documents.
The final schema needs to be versioned and stable before plugins depend on it.

### Per-app translation design

How should the translation layer (constraint payload to app-native filter) be structured? Should
the `usher-client` library provide a translation interface that each app plugin implements, or is
the translation entirely the plugin's concern with no shared abstraction? The answer affects how
testable and consistent constraint enforcement is across apps.

### Error handling and fallback

What should a plugin do if the constraint token exchange fails (Usher is unreachable at first
request)? Options: reject the request, allow through with a default "no access" constraint, or
queue and retry. The answer must be consistent with the fail-secure principle.
