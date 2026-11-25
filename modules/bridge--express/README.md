# @overture-stack/usher-bridge--express

Express middleware connecting an application to [Usher](https://github.com/overture-stack/usher),
the access enforcement system for the [Overture](https://www.overture.bio/) platform. For each
request, it turns the credential presented into that person's access and attaches it to
`res.locals`, where the application's adapter reads it and applies it at the application's own
query layer.

Behind the middleware, the Bridge:

- exchanges each credential with Usher's Controller for an Usher token, then decrypts and caches
  the token, so a request within the token's lifetime needs no call to the Controller;
- keeps a revocation channel open to the Controller, and drops a cached token once the Controller
  announces that its access was withdrawn;
- fails closed: once the Controller has been out of reach for longer than the grace period, it
  serves only what is open to everyone, and marks each signed-in person suspended;
- answers 503 until it has first reached the Controller.

## Who uses it

An Overture application mounts the middleware ahead of its read paths and registers each catalogue
it serves, as its adapter describes them. The adapter reads each request's access through
`@overture-stack/usher-types`.

## Install

    npm install @overture-stack/usher-bridge--express @overture-stack/usher-types express

| Peer dependency                    | What it is for                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `@overture-stack/usher-types`      | the contract shared by the Bridge and the adapter, installed once by the application |
| `express`                          | the framework the middleware runs in, version 4 or 5                                 |
| `@types/express-serve-static-core` | optional: the Express types named in the Bridge's declarations, for TypeScript       |

It is an ES module, for Node 24 or later.

## Usage

```ts
import {
  createBridgeCore,
  createUsherMiddleware,
} from '@overture-stack/usher-bridge--express';
import express from 'express';
import pino from 'pino';

// The application reads its own configuration; the bridge reads no environment variable.
const audience = process.env.USHER_AUDIENCE;
const key = process.env.USHER_KEY;

if (audience === undefined) {
  throw new Error('USHER_AUDIENCE is not set');
}

if (key === undefined) {
  throw new Error('USHER_KEY is not set');
}

const bridge = createBridgeCore({
  audience,
  controllerUrl: 'https://usher.example.org',
  eventSource: 'https://search.example.org/usher-bridge',
  issuer: 'https://usher.example.org',
  key,
  logger: pino(),
  payloadVersions: [1],
});

// One registration for each catalogue the application serves, as its adapter describes it. This
// one is open by configuration, so every request gets `allow` for it.
bridge.register({ files: { kind: 'open' } });

const app = express();

// After the health routes and CORS, and before body parsing.
app.use(createUsherMiddleware(bridge));

await bridge.start();
app.listen(3000);
```

The options naming this deployment come from these places, the first two from registering the
application with the Controller, as
[Registering resources](https://github.com/overture-stack/usher/blob/main/docs/deployment.md#registering-resources)
describes:

| Option          | Where it comes from                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `audience`      | `id` at the root of the answer registering it                                                                                      |
| `key`           | the `key.value` in that same answer, the only answer that shows it                                                                 |
| `controllerUrl` | where the application reaches the Controller: https, or plain http only to `127.0.0.1`, `localhost` or `[::1]`                     |
| `issuer`        | the Controller's `issuer` setting, the `iss` of every Usher token                                                                  |
| `eventSource`   | the application's own: a URI reference naming this deployment rather than one replica, the `source` of every event the Bridge logs |

Each route mounted after the middleware reads its request's access from `res.locals` with
`readAccess` from `@overture-stack/usher-types`. On shutdown, `await bridge.stop()`, which settles
once every exchange in flight has ended.

## The exchange timeout

Three terms name the timing of an exchange with the Controller:

- the **deadline**: when the Controller must have answered an exchange, measured from the
  request's arrival, `CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS` (4 s);
- the **timeout**: how long the Bridge waits for that answer, its `exchangeTimeoutMs`;
- the **margin**: the difference between them, left for the network and for writing the answer,
  `EXCHANGE_DEADLINE_MARGIN_MILLISECONDS` (1 s).

`exchangeTimeoutMs` defaults to `BRIDGE_EXCHANGE_TIMEOUT_MILLISECONDS`, the deadline plus the
margin (5 s), each exported by `@overture-stack/usher-types`. Keep it at least that: the Controller
answers every exchange by its deadline, so a Bridge waiting the deadline plus the margin always
receives the answer. A shorter timeout is accepted, since the Bridge cannot see the Controller's
deadline, but the Bridge may then give up on an exchange the Controller answers in time, and its
start logs `bridge.exchangeTimeoutShort` at warning, naming the timeout and the minimum.

## Bounds and defaults

The Bridge reads no environment variable, so each of these is set in its configuration or keeps
its default.

| Option                         | Default                                       | What it bounds                                                                                  |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `graceMs`                      | 60 s                                          | how long after the latest recorded check the Bridge still honours grants                        |
| `pollIntervalMs`               | 30 s                                          | the time between polls of the revocation channel, jittered by 10% either way                    |
| `pollRecoveryIntervalMs`       | 10 s, or `pollIntervalMs` if smaller          | the time between polls while checks are failing                                                 |
| `pollDeadlineMs`               | 10 s                                          | how long one check may run                                                                      |
| `pushIdleMs`                   | 25 s, whatever the poll interval              | how long the push may stay silent before it is replaced; at most `pollIntervalMs`               |
| `localRefusalClockToleranceMs` | 60 s                                          | how long past its `exp` a sign-in token is still passed on rather than refused locally          |
| `tokenTtlMs`                   | 5 min                                         | the longest an exchange's outcome is held, ending sooner at its token's expiry                  |
| `responseCapBytes`             | 1 MiB                                         | the most bytes read from the Controller's answer to an exchange or a poll                       |
| `stores`                       | 10,000 accepted, 10,000 refused, 1,000 failed | the credentials each store holds, the least recently used evicted first; a failure is held 10 s |

**An evicted credential is exchanged again.** A live credential evicted from a full store costs
another exchange at the Controller on its next request, so a store sized below an application's
active credentials turns into exchange load.

**The response cap is the Bridge's, and the Controller does not read it.** The Controller refuses
to issue a token over a fixed 1 MiB, as `tokenOverResponseCap`. A Bridge whose cap is set lower
reads a larger token the Controller issued as unreadable, `tokenTooLarge`, and the Controller records
nothing about it, so lower the cap only knowing that a principal holding many resources may then be
refused.

**The exchanges in flight are bounded, not configured.** The Bridge holds at most 64 new exchanges
in flight at once. It honours a `Retry-After` of up to 5 s for its back-off window and up to 60 s
for one hold, counting a longer one as that.

## Design

- [Architecture: the Bridge](https://github.com/overture-stack/usher/blob/main/.dev/design/architecture.md#bridge-overture-stackusher-bridge--express):
  what the Bridge owns, and what it leaves to the adapter
- [Security workflow](https://github.com/overture-stack/usher/blob/main/.dev/design/security-workflow.md):
  the token exchange, caching, revocation, and failing closed
- [Adapter integration](https://github.com/overture-stack/usher/blob/main/.dev/design/adapter-integration.md):
  how an adapter receives each request's access and applies it
