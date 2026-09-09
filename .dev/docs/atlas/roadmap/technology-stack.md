# Technology stack decisions

## Confirmed

**Language:** TypeScript (Overture ecosystem consistency).

**Policy store:** PostgreSQL. Handles grants, memberships, categories, `revoked_at` timestamps, and the audit log; requires transactions and foreign-key integrity.

**Shared cache and revocation pub/sub:** Valkey (already deployed in the Overture environment; protocol-compatible with Redis). Two roles: caching computed grants payloads across Usher instances (the `generatedAt` fast-path), and pub/sub backbone for the push revocation channel (one instance processes a revocation; Valkey notifies SSE subscribers on all others). Valkey Streams provides durable in-process event passing for v1; see Kafka in Future scope for external consumer fan-out.

**Structured logging:** Pino (strongly preferred; to confirm with HTTP framework choice). Integrates natively with Fastify; outputs structured JSON by default; one of the fastest Node.js loggers, which matters on the auth hot path.

**Audit event channels:** dual-channel: stored in the policy database (queryable source of truth for governance reviews) and emitted as Pino structured log lines (forwarded to a log aggregator for real-time alerting and external system integration). Both channels are required; the database alone is insufficient for real-time security monitoring.

## Decided: HTTP framework: Fastify

**Decision:** Fastify. Rationale: purpose-built for Node.js; `fast-json-stringify` generates
optimized serialization code from JSON Schema at startup (not at request time); `find-my-way`
radix-tree router. Strongest performance profile for a long-running Node.js service on
Kubernetes. Pino is native. Zod is usable via `fastify-type-provider-zod`, which converts Zod
schemas to JSON Schema at startup so the fast serialization path applies at runtime.

Hono was the primary alternative: more portable across runtimes, first-class SSE API,
TypeScript-first. It runs on Node.js via `@hono/node-server` (an adapter, not a native target),
and its production track record on long-lived Node.js processes is thinner than Fastify's --
SSE backpressure, connection cleanup on abrupt disconnect, and graceful shutdown behaviour on
Node are less documented. For a service that must maintain persistent SSE revocation streams,
this was the deciding gap.

Note: PEP plugins (`usher-arranger`, `usher-lyric`) are middleware for their respective target
applications and are unaffected by this choice; they communicate with the Usher controller over
HTTP regardless of framework.

## Architectural constraint: framework is a delivery mechanism only

**Fastify owns HTTP concerns exclusively: routing, request/response lifecycle, schema
serialization, and SSE streams. It owns nothing else.**

Application logic (grants computation, permissions resolution, revocation processing, audit
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
