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
const key = process.env.USHER_KEY;

if (key === undefined) {
  throw new Error('USHER_KEY is not set');
}

const bridge = createBridgeCore({
  audience: 'search',
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

Each route mounted after the middleware reads its request's access from `res.locals` with
`readAccess` from `@overture-stack/usher-types`. On shutdown, `await bridge.stop()`, which settles
once every exchange in flight has ended.

## Design

- [Architecture: the bridge](https://github.com/overture-stack/usher/blob/main/.dev/design/architecture.md#bridge-overture-stackusher-express-bridge):
  what the bridge owns, and what it leaves to the adapter
- [Security workflow](https://github.com/overture-stack/usher/blob/main/.dev/design/security-workflow.md):
  the token exchange, caching, revocation, and failing closed
- [Adapter integration](https://github.com/overture-stack/usher/blob/main/.dev/design/adapter-integration.md):
  how an adapter receives each request's access and applies it
