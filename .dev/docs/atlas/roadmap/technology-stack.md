# Technology stack decisions

## Confirmed

**Language:** TypeScript (Overture ecosystem consistency).

**Policy store:** PostgreSQL. Handles grants, memberships, categories, `revoked_at` timestamps, and the audit log; requires transactions and foreign-key integrity.

**Shared cache and revocation pub/sub:** Valkey (already deployed in the Overture environment; protocol-compatible with Redis). Two roles: caching computed grants payloads across Usher instances (the `generatedAt` fast-path), and pub/sub backbone for the push revocation channel (one instance processes a revocation; Valkey notifies SSE subscribers on all others). Valkey Streams provides durable in-process event passing for v1; see Kafka in Future scope for external consumer fan-out.

**Structured logging:** Pino (strongly preferred; to confirm with HTTP framework choice). Integrates natively with Fastify; outputs structured JSON by default; one of the fastest Node.js loggers, which matters on the auth hot path.

**Audit event channels:** dual-channel: stored in the policy database (queryable source of truth for governance reviews) and emitted as Pino structured log lines (forwarded to a log aggregator for real-time alerting and external system integration). Both channels are required; the database alone is insufficient for real-time security monitoring.

## Open: HTTP framework

Decision required before implementation begins. Two genuine candidates:

**Fastify:** performant, TypeScript-native, Pino built in, larger ecosystem, `@fastify/express` compatibility shim for any existing Express middleware. Battle-tested at scale; most relevant prior art for this kind of service.

**Hono:** newer, lightweight, edge/multi-runtime native. Strong TypeScript ergonomics and a clean middleware API. Smaller ecosystem and fewer production references at this service's security and concurrency profile. Worth evaluating seriously if the team is already investing in it elsewhere.

Note: PEP plugins (`usher-arranger`, `usher-lyric`) are Express middleware for their respective target applications and are unaffected by this choice; they communicate with the controller over HTTP regardless of framework.
