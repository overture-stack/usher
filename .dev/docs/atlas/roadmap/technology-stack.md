# Technology stack decisions

## Confirmed

**Language:** TypeScript (Overture ecosystem consistency).

**Policy store:** PostgreSQL. Handles grants, resource users, categories, `revoked_at` timestamps, and the audit log; requires transactions and foreign-key integrity.

**Shared cache and revocation pub/sub:** Valkey (already deployed in the Overture environment; protocol-compatible with Redis). Two roles: caching computed permissions payloads across Usher instances, which is what the fast-path refresh reads, and pub/sub that wakes every instance to read new notices from PostgreSQL and push them to its SSE subscribers. Pub/sub delivers at most once, so it carries a wake-up rather than the notice, and a lost message costs a delay, never a notice. See Kafka in Future scope for external consumer fan-out.

**Structured logging:** Pino, decided with Fastify, which it integrates with natively; outputs structured JSON by default; one of the fastest Node.js loggers, which matters on the auth hot path.

**Audit event channels:** dual-channel: stored in the policy database (queryable source of truth for governance reviews) and emitted as Pino structured log lines (forwarded to a log aggregator for real-time alerting and external system integration). Both channels are required; the database alone is insufficient for real-time security monitoring.

## Decided: toolchain for this repository

Versions as of 2026-09-29, checked against the registry; each is taken at its latest when a package
is created, rather than copied from here.

- **Node 24**, the version Arranger's images build on.
- **pnpm** workspaces, at version 12 or later (developer decision, 2026-10-05). A pnpm 11 older than
  11.28.4 crashes when it switches to a 12 pin and damages its store, so a machine's own pnpm is
  brought to 11.28.4 or later, or to 12, before it runs anything in this repository.
- **TypeScript at its latest** (7.0.2). Arranger's side is on 5.8 and plans the same upgrade, so a
  package published for Arranger to import waits until Arranger can read its declarations.
- **zod at its latest** (4.6.5), as a peer dependency of any published package that imports it, so a
  consumer's own copy is the one in use and no schema crosses two copies of the library.
  `usher-types` validates by hand and imports none: zod's `record` skips a `__proto__` key
  unchecked, and its issues quote input keys, which a security contract can afford neither of.
- **tsdown** for builds, pinned exactly while it is below 1.0. tsup, which Arranger uses, is no longer
  maintained, and its own README points to tsdown.
- **Tests**: `node:test`, run as a bare `tsx --test`, co-located with the source and written in the
  given, when, then shape.
- **jose** for the encrypted Usher token: a widely used library implementing the JOSE standards
  (JWT, JWE, JWS, JWK) on Node's built-in cryptography, with no dependencies of its own. Only the
  controller, which encrypts, and the bridge, which decrypts, use it.

## Decided: HTTP framework: Fastify

**Decision:** Fastify. Rationale: purpose-built for Node.js; `fast-json-stringify` generates
optimized serialization code from JSON Schema at startup (not at request time); `find-my-way`
radix-tree router. Strongest performance profile for a long-running Node.js service on
Kubernetes. Pino is native. Zod is usable via `fastify-type-provider-zod`, which converts Zod
schemas to JSON Schema at startup so the fast serialization path applies at runtime.

Hono was the primary alternative: more portable across runtimes, first-class SSE API,
TypeScript-first. It runs on Node.js via `@hono/node-server` (an adapter, not a native target),
and its production track record on long-lived Node.js processes is thinner than Fastify's:
SSE backpressure, connection cleanup on abrupt disconnect, and graceful shutdown behaviour on
Node are less documented. For a service that must maintain persistent SSE revocation streams,
this was the deciding gap.

Note: adapters (the Arranger adapter, the Lyric adapter) run inside their own applications and are
unaffected by this choice; the bridge they use talks to the Usher controller over HTTP regardless of
framework.

## Architectural constraint: framework is a delivery mechanism only

**Fastify owns HTTP concerns exclusively: routing, request/response lifecycle, schema
serialization, and SSE streams. It owns nothing else.**

Application logic (permissions computation, permissions resolution, revocation processing, audit
event emission) lives in framework-independent modules. Data access (PostgreSQL pool, Valkey
client) is managed independently and injected where needed; it is not registered as a Fastify
plugin. Route handlers are thin: parse the validated request, call the relevant service function,
return the result. No business logic lives inside a route handler or a Fastify plugin.

**Why this rule exists:** Fastify's plugin ecosystem encourages registering database connections,
auth, and other concerns as framework-level plugins (accessible via `fastify.pg`, etc.). This
couples application logic to the framework lifecycle and makes the data layer untestable without
starting the HTTP server. The correct boundary is the opposite: the HTTP server is startable
without the business logic knowing or caring which HTTP framework is running it.

**Practical consequence:** if the team ever needs to move from Fastify to another framework,
only the route handler layer changes. All service functions, data access modules, and business
logic are untouched.

**Test signal:** a business logic function that cannot be unit-tested without starting a Fastify
instance has crossed the boundary. That is a defect in structure, not a testing limitation.
