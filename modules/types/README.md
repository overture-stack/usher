# @overture-stack/usher-types

The contract shared by Usher's bridges and the adapters of the applications they serve: the shape
of each request's access, the functions that attach it to a request and read it back, and a
validator for each value passed between them.

[Usher](https://github.com/overture-stack/usher) is the access enforcement system for the
[Overture](https://www.overture.bio/) platform. It hands each application the grants saying what
each person may see, and the application enforces them at its own query layer.

## Who uses it

- **An application's adapter** reads each request's access with `readAccess`, and applies the
  result for each catalogue it serves at the application's query layer. It describes those
  catalogues to the bridge with the `KeyRegistration` types. At run time, an adapter depends on this
  package alone.
- **A bridge**, such as `@overture-stack/usher-express-bridge`, validates each request's access and
  attaches it to the framework's per-request store with `attachAccess`.
- **A portal's browser code** reads the bridge's answers through `SUSPENDED_HEADER`,
  `SUSPENDED_VALUE` and `CHALLENGE_ERRORS` rather than writing their values inline.

## Install

    npm install @overture-stack/usher-types

It is an ES module, for Node 24 or later. It depends on `@overture-stack/sqon`, and through it on
zod, since its validators apply sqon's `SqonSchema`. An application using
`@overture-stack/usher-express-bridge` installs this package itself, since the bridge takes it as a
peer dependency, so the bridge and the adapter share one copy.

## Usage

An adapter reads the access attached by the bridge, then looks up the result for each catalogue key
it registered:

```ts
import { readAccess, resultFor } from '@overture-stack/usher-types';

// `store` is the framework's per-request store, such as Express's `res.locals`.
export const queryCatalogue = (store: object, catalogueKey: string): void => {
  const result = resultFor(readAccess(store), catalogueKey);

  switch (result?.kind) {
    case 'allow':
      // The catalogue is open by configuration: query it without a filter.
      break;
    case 'narrow':
      // Query the catalogue under `result.sqon`, a SQON filter.
      break;
    default:
      // A deny, which carries its reason, or no result for the key, which is a deny too: do not
      // query the catalogue.
      break;
  }
};
```

`readAccess` throws an `UsherContractError` when the store holds no access. That means the bridge's
middleware never ran for the request, so an adapter treats it as an error, not as a deny.

Each validator, such as `validatePayload`, `validateRegistration` or `validateRequestAccess`,
returns a typed copy of a valid value, or every problem found, none of them quoting the value.

## Design

- [Adapter integration](https://github.com/overture-stack/usher/blob/main/.dev/design/adapter-integration.md):
  how an adapter receives each request's access and applies each result
- [Permissions model](https://github.com/overture-stack/usher/blob/main/.dev/design/permissions-model.md):
  the grants and categories behind each result
- [Glossary](https://github.com/overture-stack/usher/blob/main/.dev/design/glossary.md): the terms
  these types use
