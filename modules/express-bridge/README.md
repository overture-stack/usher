# @overture-stack/usher-express-bridge

Express middleware connecting an application to [Usher](https://github.com/overture-stack/usher),
the access enforcement system for the [Overture](https://www.overture.bio/) platform. For each
request, it turns the credential presented into that person's access and attaches it to
`res.locals`, where the application's adapter reads it and applies it at the application's own
query layer.

Behind the middleware, the bridge:

- exchanges each credential with Usher's controller for an Usher token, then decrypts and caches
  the token, so a request within the token's lifetime needs no call to the controller;
- keeps a revocation channel open to the controller, and drops a cached token once the controller
  announces that its access was withdrawn;
- fails closed: once the controller has been out of reach for longer than the grace period, it
  serves only what is open to everyone, and marks each signed-in person suspended;
- answers 503 until it has first reached the controller.

## Who uses it

An Overture application mounts the middleware ahead of its read paths and registers each catalogue
it serves, as its adapter describes them. The adapter reads each request's access through
`@overture-stack/usher-types`.

## Install

    npm install @overture-stack/usher-express-bridge @overture-stack/usher-types express

| Peer dependency                    | What it is for                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `@overture-stack/usher-types`      | the contract shared by the bridge and the adapter, installed once by the application |
| `express`                          | the framework the middleware runs in, version 4 or 5                                 |
| `@types/express-serve-static-core` | optional: the Express types named in the bridge's declarations, for TypeScript       |

It is an ES module, for Node 24 or later.

## Usage

```ts
import {
  createBridgeCore,
  createUsherMiddleware,
} from '@overture-stack/usher-express-bridge';
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
application with the controller, as
[Registering resources](https://github.com/overture-stack/usher/blob/main/docs/deployment.md#registering-resources)
describes:

| Option          | Where it comes from                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `audience`      | the application's `id`, in the answer registering it                                                                               |
| `key`           | the `key.value` in that same answer, the only answer that shows it                                                                 |
| `controllerUrl` | where the application reaches the controller: https, or plain http only to `127.0.0.1`, `localhost` or `[::1]`                     |
| `issuer`        | the controller's `USHER_ISSUER`, the `iss` of every Usher token                                                                    |
| `eventSource`   | the application's own: a URI reference naming this deployment rather than one replica, the `source` of every event the bridge logs |

Each route mounted after the middleware reads its request's access from `res.locals` with
`readAccess` from `@overture-stack/usher-types`. On shutdown, `await bridge.stop()`, which settles
once every exchange in flight has ended.

## The exchange timeout

Three terms name the timing of an exchange with the controller:

- the **deadline**: when the controller must have answered an exchange, measured from the
  request's arrival, `CONTROLLER_EXCHANGE_DEADLINE_MILLISECONDS` (4 s);
- the **timeout**: how long the bridge waits for that answer, its `exchangeTimeoutMs`;
- the **margin**: the difference between them, left for the network and for writing the answer,
  `EXCHANGE_DEADLINE_MARGIN_MILLISECONDS` (1 s).

`exchangeTimeoutMs` defaults to `BRIDGE_EXCHANGE_TIMEOUT_MILLISECONDS`, the deadline plus the
margin (5 s), each exported by `@overture-stack/usher-types`. Keep it at least that: the controller
answers every exchange by its deadline, so a bridge waiting the deadline plus the margin always
receives the answer. A shorter timeout is accepted, since the bridge cannot see the controller's
deadline, but the bridge may then give up on an exchange the controller answers in time, and its
start logs `bridge.exchangeTimeoutShort` at warning, naming the timeout and the minimum.

## Design

- [Architecture: the bridge](https://github.com/overture-stack/usher/blob/main/.dev/design/architecture.md#bridge-overture-stackusher-express-bridge):
  what the bridge owns, and what it leaves to the adapter
- [Security workflow](https://github.com/overture-stack/usher/blob/main/.dev/design/security-workflow.md):
  the token exchange, caching, revocation, and failing closed
- [Adapter integration](https://github.com/overture-stack/usher/blob/main/.dev/design/adapter-integration.md):
  how an adapter receives each request's access and applies it
