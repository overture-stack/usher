# Packaging the bridge

Checked on Node 24.16 on macOS against the npm registry (pnpm 12.9.1, npm 11.5.1, TypeScript 5.8.3
to 7.0.2, tsdown 0.23.0, tsx 4.23.15, zod 4.6.5, jose 6.2.12, Express 4.22.3 and 5.2.1, c8 12.0.0),
2026-10-04. Every behaviour stated here was run there unless the sentence says it was read from
source, read from documentation, or reasoned.

This note sets how the shared libraries of Usher, the access enforcement system for
Overture applications, are built, published and tested. The bridge, `@overture-stack/usher-express-bridge`,
is the library each protected application embeds to turn a person's sign-in credential into the
request's access. The types package, `@overture-stack/usher-types`, holds the types and runtime
validators shared by the bridge and every adapter, and it depends on no web framework.

The toolchain itself is decided in [technology-stack.md](../roadmap/technology-stack.md) and is not
reopened here: Node 24, pnpm workspaces, TypeScript and zod at their latest, zod as a peer dependency
only of a published package whose shipped source imports it, tsdown pinned exactly while below 1.0,
`node:test` run as a bare `tsx --test`, and jose for the Usher token. No pnpm version is named there,
and the workspace's version is set below.

## Decisions

### Module format

- Both packages ship as ESM only, with no CommonJS build and no `require` condition.
- Each entry point exports `types`, `import` and `default`, all into `dist`, with `types` first;
  `default` is the condition that lets `require()` resolve it.
- Neither manifest has a top-level `main` or `types` field.
- Both packages export named bindings only.
- Neither package uses top-level await anywhere in its module graph.
- The host creates the bridge, mounts its middleware synchronously, and then awaits an asynchronous
  start.
- Until the start completes, the middleware answers 503 as the cold mode, before any read path.
- A CI step `require()`s and `import()`s the packed tarballs, to catch a dependency that later adds
  top-level await.
- Every cache and the revocation channel live in one instance created by the host, never in module
  state.
- The bridge refuses to start a second instance for the same audience in one process. A duplicate,
  whether from two installed versions of the package or from bundling, then fails at startup, before
  two caches can disagree about a revocation.
- The registry behind that refusal is process-wide and lives on `globalThis`, so that two copies of
  the package share it.
- A refusal to start rejects `start()` with a fixed-text `UsherContractError` naming the rule. The
  bridge stays cold and logs `bridge.startRefusal`, registered at severity `critical` in
  [audit-events.md](../../../design/audit-events.md#events).

### Build and declarations

- tsdown 0.23.0 builds both packages with `dts: true`, pinned exactly.
- The committed lockfile fixes tsdown's declaration engine and bundler, since tsdown takes both
  through ranges.
- A separate `tsc -p tsconfig.json` step type-checks the source, since the build does not.
- CI type-checks the packed tarballs from a TypeScript 5.8 consumer on every build.
- `@types/node` is pinned to the 24 line.
- `isolatedDeclarations` and `exactOptionalPropertyTypes` are on in `tsconfig.base.json`, so
  rolldown-plugin-dts emits the declarations through its oxc generator, never through tsgo.
- A new TypeScript minor waits until rolldown-plugin-dts's `~7.0.0` peer range admits it, which
  `strictPeerDependencies` enforces, so "TypeScript at its latest"
  means the latest version supported by tsdown, a narrowing absent from
  [technology-stack.md](../roadmap/technology-stack.md).
- Type-aware typescript-eslint, whose peer range on TypeScript stopped below 6.1 on the check date,
  cannot run against TypeScript 7, so linting needs a TypeScript 6 beside it.
- `skipLibCheck` stays off in Usher's own packages. Kept off, it caught the nightly's failure inside
  zod's declarations, at the cost of builds failing on declarations outside Usher's control.
- jose is declared in `dependencies`.
- `@overture-stack/sqon` is a regular dependency of `usher-types`, at `^1.0.0-rc.6`, because the
  validators use its `SqonSchema`, its operator lists, its aliases and its depth limit at run time.
  It is not a peer, so an application whose adapter turns SQON into another query language need not
  install sqon itself.
- Inside Arranger's monorepo, Arranger adds an `overrides` entry pointing the sqon of `usher-types`
  at its workspace module, so the monorepo holds one copy. Two copies would still be safe: only plain
  data crosses between them, and the validator refuses any operator unknown to its own copy.
- Neither `usher-types` nor the bridge has zod as a peer, since
  [technology-stack.md](../roadmap/technology-stack.md) makes zod a peer only of a package whose
  shipped source imports it. `usher-types` keeps zod as a devDependency for its tests.
- tsdown's `deps: { onlyBundle: [] }` turns any package from `node_modules` that would be inlined
  into a build failure. Neither committed tsdown configuration sets it, so only the check on the
  packed JavaScript below catches an inlined dependency.
- No public declaration names `CryptoKey` or a jose type.
- A CI check confirms that the packed bridge's JavaScript imports `jose` and
  `@overture-stack/usher-types` and holds neither's code.
- A CI check confirms that the packed bridge's declarations mention neither `jose` nor `CryptoKey`,
  and import only names they use.
- `usher-types` is a peer dependency of the bridge, never a regular dependency, so the bridge uses
  the copy provided by the host's install rather than a copy of its own. The peer keeps one copy of the
  contract and of `SqonSchema` in a host.
- The peer, together with the host's own dependency on `usher-types`, is enough to hold one copy
  under pnpm.
- In the workspace the bridge declares `usher-types` as a peer at `workspace:^` and in
  `devDependencies`, so the published peer range is a caret range.
- There is no `WeakSet` and no check of which copy attached a value, so two copies of `usher-types`
  in one host interoperate (reasoned, not run: no test runs two copies). What two copies would still do is under
  [Freezing the request's access](#freezing-the-requests-access).

### The core's place

- The framework-free core stays inside `express-bridge`, separate from the Express layer, as the
  [roadmap](../../../roadmap.md#overture-stackusher-express-bridge) records, in a directory kept free
  of Express imports by a test.
- The core moves to a package of its own when a second framework's bridge starts, and both bridges
  depend on it. A subpath of the Express bridge would leave the new bridge depending on a package
  declaring Express as a peer, and a place inside `usher-types` would put the cache, the notice stream
  and jose into a dependency of every adapter.

### The request's access

- `usher-types` defines `attachAccess`, `readAccess`, `resultFor` and the validators. Adapters import
  them from `usher-types` directly, since under
  [adapter-integration.md](../../../design/adapter-integration.md#decided) an adapter depends on
  `usher-types` alone.
- The validators check by hand, never through zod at run time: a zod record skips a `__proto__` key
  unchecked, and zod's issues quote input keys. `SqonSchema` from `@overture-stack/sqon` is still
  applied, as a step of its own.
- Each validator returns a snapshot of the value's own members, reading each once.
- The enforcement validator refuses an empty group anywhere; any exclusion (`not-in`, `some-not-in`
  and their aliases); a pivot, null included; any member beyond `op` and `content` in a node, or
  beyond `fieldName` and `value` in a clause; `wildcard` and its alias `filter`; a value holding a
  marker read by Arranger as an instruction (a `*` pattern, a `set_id:` reference, `__missing__`); a
  `not` anywhere except directly inside an `and` that also holds an `in`; an empty `in` inside a
  narrowing; a range holding no bound, or any bound other than a finite number or a non-empty
  string; and a `between` holding other than two bounds. These are the rules for the bridge's filters recorded in
  [decisions.md](../../../design/decisions.md#the-bridges-filters-carry-no-empty-group-no-empty-exclusion-and-no-pivot),
  with its note to revisit the wildcard and `not` rules for a grant carrying its own SQON after MVP.
- The bridge re-exports the registration types `KeyRegistration`, `OpenKeyRegistration` and
  `RecordKeyRegistration` from `usher-types`; adapters import everything else from `usher-types`
  itself. With `usher-types` a peer, the re-export resolves to the host's one copy.
- The bridge package exports no constant naming the store key, since such a constant invites reads by
  key.
- The access validator follows the shape in
  [adapter-integration.md](../../../design/adapter-integration.md#decided), `suspended` included, as
  [decisions.md](../../../design/decisions.md#a-suspended-principal-is-answered-by-what-the-open-tier-can-settle)
  records.
- A principal states its credential: `none`, never suspended; `unconfirmed`, suspended and served
  the open tier; or `confirmed`, naming its subject as `subject` while its grants hold and as
  `attributionOnlySubject` while suspended. That covers uncertain mode, where no exchange runs, and
  an exchange that fails while the stream is healthy.
- The access validator therefore checks each state's exact members, and requires `openTierOnly` of
  every principal without a confirmed credential and of every suspended one.
- The access validator is strict, so the real bridge and every fake bridge attach exactly this shape.
- The bridge package declares `readonly usher?: unknown` on the global `Express.Locals` interface.
- `attachAccess` validates the value, deep-freezes it, and writes it to the store it is handed as a
  data member that is non-writable, non-configurable and non-enumerable.
- Refusing a store that already holds `usher` is part of the contract of `attachAccess`, so every
  framework's bridge and every fake bridge share that guard, whatever their store.
- `readAccess` accepts only a member shaped as `attachAccess` leaves it: a data member,
  non-writable, non-configurable, non-enumerable and deeply frozen. It never runs an accessor, and
  it returns a fresh frozen copy it has validated.
- `readAccess` throws when the value is missing, invalid or of an unknown version, as
  adapter-integration.md states, and also for a member of any other shape.
- `resultFor(access, key)` reads results by own member only.
- The bridge deep-freezes rendered results before caching them.

### Errors and logs

- Both packages throw only fixed-text errors.
- No zod error, zod message, issue path or input key reaches an error message or a log event.
- A validation failure logs only the fixed fields of its registered event, never zod's issue kinds:
  `token.rejection` with its `reason` code for an Usher token, `revocationChannel.malformed` with its
  `reason` code for a notice or a poll answer, and `bridge.internalError` with its `stage` for any
  other, such as a rendered result refused by `attachAccess`.
- The Express layer catches synchronous throws and asynchronous rejections alike, answers 503 with
  nothing attached, and never calls `next(err)`.
- That 503 is logged as `bridge.internalError`, carrying only its `stage`, at severity `critical`.
- The [core note](core-and-express-layer.md) sets the statuses answered by the Express layer before
  any read path.
- The bridge's log events are registered in [audit-events.md](../../../design/audit-events.md#events),
  and the [core note](core-and-express-layer.md#logging) maps each to its fields.
- A rejected Usher token is logged as `token.rejection` with a reason code, as the
  [jose note](jose-usher-token.md) sets out.
- The bridge checks no zod version at startup, since neither package imports zod at run time.
- No check of the validators' known answers runs at startup either. It is revisited with publishing
  integrity, which is [open](#open-questions).

### Clocks and timers

- The grace period and the poll deadline run on an injected monotonic clock alone, with no
  wall-clock comparison, as the [core note](core-and-express-layer.md#time) sets out. Comparisons
  with `exp` keep the wall clock.
- On Linux and macOS a monotonic clock does not advance while the host is suspended. After a resume
  the bridge stays in normal mode although more than the grace period of wall time may have passed
  since its last check, and it honours grants until its next check or until the grace period has
  passed in running time. The grace period therefore bounds revocation in the host's running time,
  not in wall time, and the bound in
  [security-workflow.md](../../../design/security-workflow.md#revocation-channel-integrity-and-fail-secure-behaviour),
  the grace period as the worst case whatever the attack, holds in running time only. This is
  reasoned from how the operating systems define their clocks, not run.
- Code reaches timers through the globals or an injected clock, never through a named or namespace
  import from `node:timers` or `node:timers/promises`.
- A poll left open past its deadline is aborted at that deadline, and any abort counts as no check,
  whatever its reason.
- Tests inject both clocks and mock only `setTimeout` among the timers, never `Date`: mock timers do
  not drive `performance.now()`, and a mocked `Date` cannot step the wall clock apart from the timers
  ([mock timers](#mock-timers-on-node-2416)).

### Workspace, tests and publishing

- The workspace pins pnpm 12.9.1 and declares every pnpm setting in `pnpm-workspace.yaml`:
  `allowBuilds` with esbuild and `@scarf/scarf` both false, `blockExoticSubdeps`,
  `minimumReleaseAge: 1440`, `strictDepBuilds`, `strictPeerDependencies`, `trustPolicy: no-downgrade`
  and `verifyDepsBeforeRun: error`, a catalogue holding every development tool's version, and a
  committed lockfile.
- Any pnpm 11 older than 11.28.4 crashes when it switches to the 12.9.1 pin and leaves a broken
  entry in the shared store ([pnpm/pnpm#16594](https://github.com/pnpm/pnpm/issues/16594)), so a
  machine's own pnpm is brought to 11.28.4 or later, or to 12, before it runs anything in the
  workspace.
- A move to a new pnpm major is a change of its own, with these settings verified again on it. Under
  a pnpm 12 pin the lockfile gains an additive `packageManagerDependencies` document, so the pin and
  the lockfile change in one commit.
- `minimumReleaseAge` is set explicitly to 1440 minutes, so a version younger than a day is refused
  even under an exact pin. Left unset, an exact pin to a fresh version would pass and be recorded in
  `minimumReleaseAgeExclude`, as [The release-age gate](#the-release-age-gate) shows.
- CI or review treats any change to `minimumReleaseAgeExclude` as a supply-chain decision.
- `strictPeerDependencies` is on in the workspace, which turns pnpm's warning about an out-of-range
  peer into a failure, as [Ranges under npm and pnpm](#ranges-under-npm-and-pnpm) shows. It fails an
  install on a third-party dependency's unmet peer, as a typescript-eslint parser beside TypeScript 7
  showed. The peers of the workspace's own packages are checked where a consumer depends on them.
- Inside the workspace, the bridge resolves `usher-types` through a source export condition,
  `@overture-stack/source`, pointing at `src/index.ts`. Both packages declare it in their exports
  map.
- That condition is set through each package's test script,
  `tsx --conditions=@overture-stack/source --test`, and through TypeScript's `customConditions`.
- The publish step strips the condition from the published exports map, through `publishConfig`.
  Kept, the condition would name `src/index.ts`, left out by `"files"`, and would break
  resolution for any consumer that sets the same condition, such as a workspace in the same
  `@overture-stack` namespace adopting it, since Node does not fall back to another condition when
  the file named by a matched condition is missing (reasoned, not run).
- fast-check 4.10.2 is a devDependency of `usher-types`, for property tests of its validators.
- Every test file is named `*.test.ts`, and shared test helpers take names outside the test glob
  under [Tests](#tests).
- Both packages are published from CI with integrity controls, whose form is open.
- Each package's `prepublishOnly` script refuses unconditionally, which stops a local publish run by
  accident. A publish with scripts skipped never runs it. The release job publishes that way, with
  `pnpm publish --ignore-scripts`.
- Coverage is open, as the
  [roadmap](../../../roadmap.md#finding-untested-code-settled-before-the-bridge-is-built) leaves it.

## The packages

| Package                                           | Latest  | Other versions checked                                               | Published  |
| ------------------------------------------------- | ------- | -------------------------------------------------------------------- | ---------- |
| pnpm                                              | 12.9.1  | 11.28.2 (`latest-11`), 10.34.6 (`latest-10`)                         | 2026-10-03 |
| typescript                                        | 7.0.2   | 5.8.3, 5.9.3, 6.0.3; nightly 7.1.0-dev.20261004.1 (`next`)           | 2026-07-08 |
| zod                                               | 4.6.5   | newest of each 4.x minor: 4.0.17, 4.1.13, 4.2.1, 4.3.6, 4.4.3, 4.5.4 | 2026-09-13 |
| tsdown                                            | 0.23.0  |                                                                      | 2026-09-03 |
| rolldown-plugin-dts (tsdown's declaration engine) | 0.28.6  |                                                                      | 2026-09-16 |
| tsx                                               | 4.23.15 | 4.22.3                                                               | 2026-09-20 |
| express                                           | 5.2.1   | 4.22.3 (`latest-4`, published 2026-09-14)                            | 2025-12-01 |
| @types/express                                    | 5.0.6   | 4.17.25, newest 4.x                                                  |            |
| @types/express-serve-static-core                  | 5.1.3   | 4.19.9, newest 4.x                                                   |            |
| @types/node                                       | 26.6.4  | 24.19.1, newest 24.x                                                 | 2026-10-01 |
| c8                                                | 12.0.0  |                                                                      | 2026-07-14 |
| jose                                              | 6.2.12  |                                                                      | 2026-09-05 |

tsdown 0.23.0 depends on rolldown `~1.2.7` and rolldown-plugin-dts `^0.28.5`. Its optional peer range
for typescript is `^5.0.0 || ^6.0.0 || ^7.0.0`, and its engines field is
`^22.18.0 || ^24.11.0 || >=26.0.0`. rolldown-plugin-dts 0.28.6 peers typescript
`^5.0.0 || ^6.0.0 || ~7.0.0`, which is narrower. A fresh install of tsdown 0.23.0 resolved rolldown
1.2.12 and rolldown-plugin-dts 0.28.6, so only the lockfile fixes them.

`@types/node` 26.6.4 would let the type-check accept APIs missing from Node 24. The newest of
the 24 line on the check date was 24.19.1.

## ESM only

### The manifest

The module fields of each package's manifest, as published:

```json
{
	"engines": { "node": ">=24" },
	"exports": {
		".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" }
	},
	"files": ["dist", "README.md"],
	"type": "module"
}
```

### What require(esm) does on Node 24

| Case                                                            | Result                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `require()` of a package whose exports are `{ types, default }` | loads, unflagged, with no warning; `process.features.require_module` is `true` |
| top-level await anywhere in the graph, an inner module included | `ERR_REQUIRE_ASYNC_MODULE`; `import()` of the same module works                |
| exports with only an `import` condition                         | `ERR_PACKAGE_PATH_NOT_EXPORTED`                                                |
| a default export                                                | arrives as `.default`, beside an `__esModule` key                              |
| `require()` and `import()` of one ESM-only package              | one instance: a `Map` entry set through one is visible through the other       |
| `require()` and `import()` of a dual package                    | two instances, with separate state                                             |

A dual package is one that ships separate files for `import` and for `require`. Because top-level
await breaks `require()`, the bridge cannot read its key or fetch the anonymous payload while its
module loads, and so it starts explicitly.

The shared instance protects only state held at module level, and only while one copy of the package
is installed. Two installed versions of the bridge, or a bundler that evaluates a module more than
once, still give two copies. Each copy would hold its own digest cache, anonymous entry and notice
stream, and a notice applied to one copy never reaches the other. State held in a host-created
instance makes the number of bridges a deliberate act. Refusing a second bridge for one audience
fails such a duplicate at startup, before two caches can disagree about a revocation. The refusal
needs a process-wide registry, and two copies of the package share one only if it lives on
`globalThis` (reasoned, not run), which is why the registry lives there.

jose 6.2.12 is ESM only itself (`"type": "module"`, exports `{ types, default }`), and it loads
through `require()` on Node 24. A CommonJS build of the bridge would still depend on an ESM-only
library, so a dual build gains nothing.

### TypeScript consumers

- An ESM consumer type-checks with `module` set to `nodenext`, or with `moduleResolution` set to
  `bundler`, as Next.js has it.
- A CommonJS file (`.cts`) that imports either package type-checks under `module` `nodenext` on
  TypeScript 5.8.3, and also under `node20` on 5.9.3. Under `node16` and `node18` it reports TS1479,
  because the imported file is an ECMAScript module.
- arethetypeswrong 0.18.5 reports `node10` resolution failing and `node16` from CommonJS as dynamic
  import only, which is expected for an ESM-only package. With `--profile esm-only` it reports no
  problems. publint 0.3.25 reports none either.
- Without top-level `main` and `types`, consumers on TypeScript's `node10` resolution cannot resolve
  the packages. No known consumer uses it.

## Building with tsdown

### How the declarations are emitted

tsdown 0.23.0 emits declarations through rolldown-plugin-dts 0.28.6, which picks one of three
generators. This was read from its source and confirmed by building.

| Generator | Chosen when                                                   | What it does                                                                                                                       | With TypeScript 7.0.2                                            |
| --------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| tsgo      | TypeScript 7.0 is installed and `isolatedDeclarations` is off | runs the native compiler binary with `--declaration --emitDeclarationOnly --noCheck`, writing under the system temporary directory | works; warns that TypeScript 7.0 does not yet have a stable API  |
| oxc       | `isolatedDeclarations` is on                                  | rolldown's isolated declaration transform                                                                                          | fails on exported zod schemas without a type annotation (TS9010) |
| tsc       | TypeScript 5 or 6 is installed                                | the classic compiler API                                                                                                           | refused: "TypeScript 7.0 is not supported when using tsc"        |

The typescript 7.0.2 package exposes no classic compiler API. `require('typescript')` returns only
`version` and `versionMajorMinor`, and its exports map holds `./lib/version.cjs` plus `./unstable/*`
entry points.

The build ran with this configuration, plus `sourcemap: true`:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
	dts: true,
	entry: ['src/index.ts'],
	format: 'esm',
	platform: 'node',
	target: 'node24',
});
```

Its output was `index.mjs` and `index.d.mts`. zod and `usher-types`, declared in that run as a peer
and as a regular dependency, stayed external, and the global `Locals` declaration was kept in
the declaration file.

### jose in the build

A sample bridge module read an Usher token through jose. It imported a 32-byte key from a base64url
string as a non-extractable, decrypt-only `CryptoKey`, called `jwtDecrypt` with `dir`, `A256GCM`, the
audience, the issuer and `typ`, and returned a type of its own. It was built with the configuration
above in four variants.

| Variant                                                                                                 | JavaScript output                                                                                         | Declarations                                                                        |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| jose in `dependencies`                                                                                  | 0.74 kB; imports `base64url` and `jwtDecrypt` from `jose`; no jose code                                   | no `jose`, `CryptoKey`, `Headers`, `Response`, `URL`, `AbortSignal` or `Uint8Array` |
| jose only in `devDependencies`                                                                          | 40.35 kB, jose inlined; exit code 0, with an informational hint naming jose                               | unchanged                                                                           |
| jose only in `devDependencies`, with `deps: { onlyBundle: [] }`                                         | build fails, exit code 1: "jose is located in node_modules but is not included in deps.onlyBundle option" | none                                                                                |
| jose in `dependencies`, with a public function taking a `CryptoKey` and returning `jwtDecrypt`'s result | builds, exit code 0                                                                                       | `CryptoKey` and `import("jose").JWTDecryptResult`                                   |

- The first variant's output decrypted a token minted with jose's `EncryptJWT`, so the external
  import works at run time. It also built unchanged under `deps: { onlyBundle: [] }`.
- The last variant's source fails `tsc` on TypeScript 7.0.2 with `@types/node` 24.19.1 (TS2749,
  "'CryptoKey' refers to a value, but is being used as a type here"), and tsdown built it anyway,
  because its declaration step skips checking.
- From a TypeScript 5.8.3 consumer with `skipLibCheck` off and `lib` set to `es2023`, the first
  variant's tarball type-checks with and without `@types/node`. The last variant's fails both ways.
  Without Node's types it reports TS2304 for `CryptoKey` in the bridge's declarations, and for
  `Headers`, `AbortSignal`, `Response` and `URL` in jose's. With `@types/node` 24.19.1 it reports
  only TS2749, for `CryptoKey`.
- `onlyBundle` checks only packages under `node_modules`. A workspace package resolved through
  TypeScript `paths` lies outside it: with `usher-types` undeclared and mapped to its source, the build
  under `onlyBundle: []` inlined that source and exited 0. Declared as a regular dependency,
  `usher-types` stayed an import. The CI check on the bridge's JavaScript covers that gap.

### What follows from it

- **The build does not type-check.** A file holding `export const wrong: number = 'x'` built with exit
  code 0 and emitted `declare const wrong: number`. `tsc -p` reported TS2322.
- **The declarations hold only while CI checks them.** Declarations emitted with TypeScript 7.0.2
  type-checked cleanly from older consumers (see [Declarations in consumers](#declarations-in-consumers)),
  but the declaration step skips checking and emits the installed compiler's output unchecked.
- **`isolatedDeclarations` does not fit zod.** The oxc generator rejects every exported zod schema that
  lacks an explicit type annotation.
- **TypeScript 7 is recognized by the literal version prefix `7.0`** (read from source). With the
  nightly 7.1.0-dev.20261004.1, npm refuses the install twice over: rolldown-plugin-dts peers
  `~7.0.0`, and tsdown's own `^7.0.0` excludes prereleases. Forced with `--legacy-peer-deps`, the
  default build falls back to the classic API and fails (`Cannot read properties of undefined
(reading 'useCaseSensitiveFileNames')`). The default build therefore breaks on each new TypeScript
  minor until rolldown-plugin-dts follows.
- **Naming the generator explicitly builds on that nightly.** The configuration is
  `dts: { generator: 'tsgo', tsgo: { path } }`, with `path` taken from typescript's
  `lib/getExePath.js`, imported by file path because the exports map does not expose it, so the
  configuration depends on a private file of the typescript package. A new minor therefore waits for
  rolldown-plugin-dts instead.
- **A newer compiler can fail on a dependency's declarations.** The same nightly, with `skipLibCheck`
  off, reports TS5115 ("Instantiations of the following types appear infinitely circular") inside zod
  4.6.5's own declarations, for a bare `zod.string()` import. TypeScript 7.0.2 is clean. `skipLibCheck`
  off caught that failure, at the cost of builds failing on declarations outside Usher's control.
- **The compiler and tsx both write to the system temporary directory.** The tsgo generator writes its
  declarations there, and tsx keeps its transform cache there. CI sets `TMPDIR` if a build must stay
  inside its workspace.

### Smaller quirks

- With `sourcemap: true` and `dts: true`, tsdown writes a `sourceMappingURL` comment into the
  declaration file without emitting the map. `dts: { sourcemap: true }` emits it, but it points into
  `src`, which is not among the published `"files"`.
- TypeScript 7 rejects `.ts` import specifiers (TS5097) unless `allowImportingTsExtensions` is set.
  With it set, `tsc`, tsdown and Node's own type stripping all accept them.

## Declarations in consumers

Each consumer compiled against the packed tarballs with `module` and `moduleResolution` set to
`nodenext`, `strict`, `verbatimModuleSyntax` and `noUncheckedIndexedAccess`, the settings of
Arranger's search-server. The rows marked "both ways" ran once with `skipLibCheck` off and once with
it on.

| Consumer TypeScript | Express types                      | Installer   | Resolution | Result                    |
| ------------------- | ---------------------------------- | ----------- | ---------- | ------------------------- |
| 5.8.3               | 4.17.25 (serve-static-core 4.19.9) | npm         | nodenext   | clean both ways           |
| 5.8.3               | 5.0.6 (serve-static-core 5.1.3)    | npm         | nodenext   | clean both ways           |
| 5.8.3               | 4.17.25                            | pnpm 12.9.1 | nodenext   | clean both ways           |
| 5.8.3               | 5.0.6                              | npm         | bundler    | clean                     |
| 5.9.3, 6.0.3, 7.0.2 | 4.17.25 and 5.0.6                  | npm         | nodenext   | clean                     |
| 5.9.3               | serve-static-core 4.17.33          | npm         | nodenext   | clean, `skipLibCheck` off |
| 5.9.3               | serve-static-core 4.19.8           | npm         | nodenext   | clean, `skipLibCheck` off |
| 5.9.3               | serve-static-core 5.1.3            | npm         | nodenext   | clean, `skipLibCheck` off |

The last three rows compiled the packed `usher-types` and bridge themselves, not the sample, with
`@types/node` 24.19.1. They set the bridge's optional peer on `@types/express-serve-static-core` at
`^4.17.33 || ^5.1.3`: 4.17.33 is the floor `@types/express` 4 declares, and 4.19.8 is what Arranger's
lockfile resolves. A floor above it, such as the 4.19.9 of the first row, made npm nest a second copy
in a consumer resolving 4.19.8, after which that consumer's own declaration build could no longer
name the package. A negative control, writing `res.locals.usher`, failed with TS2540 on all three, so
the `Locals` declaration reached each.

The surface was a sample, not the real `PermissionsPayload`, `Enforcement` and `UsherRequestAccess`.
It held:

- exported zod schemas: an object, a discriminated union and a lazy recursive type;
- types inferred from them;
- the global `Locals` declaration;
- a class with `#private` fields and a `const` type parameter;
- `NoInfer`, a `unique symbol` brand, and a constant derived with `satisfies`;
- `Uint8Array`, `URL` and `AbortSignal` in an options type.

The consumer also composed the package's schemas into its own `zod.object` and called `safeParse`. A
negative control produced the expected errors, so the checks discriminate.

zod's declarations use the global `URL` type. A consumer with `lib` set to `es2023`, no `@types/node`
and `skipLibCheck` off gets four TS2304 errors. Arranger has `@types/node`.

## The Locals declaration

- `@types/express-serve-static-core` 4.19.9 and 5.1.3 both declare an empty `Express.Locals` inside
  `declare global`, extend it with their own exported `Locals`, and type `res.locals` as
  `LocalsObj & Locals`. One global declaration therefore reaches both, with no module resolution.
- A declared key keeps its declared type on both, not `any`, although `LocalsObj` is
  `Record<string, any>`. Undeclared keys stay `any`, so leaving `usher` undeclared would type it `any`.

The decided declaration:

```ts
declare global {
	namespace Express {
		interface Locals {
			readonly usher?: unknown;
		}
	}
}
```

Three forms of the declaration, each checked on TypeScript 5.8.3 against `@types/express` 4.17.25 and
5.0.6 with `skipLibCheck` off, gave the same results on both. A negative control failed as expected.

| Declaration                                     | Type of `res.locals.usher`                  | Direct read of `.principal`                        | Reassignment    | `attachAccess(res.locals)`, `readAccess(res.locals)` |
| ----------------------------------------------- | ------------------------------------------- | -------------------------------------------------- | --------------- | ---------------------------------------------------- |
| `usher?: unknown`                               | `unknown`                                   | refused, TS18046                                   | compiles        | compile                                              |
| `readonly usher?: unknown`                      | `unknown`                                   | refused, TS18046                                   | refused, TS2540 | compile                                              |
| `readonly usher?: Readonly<UsherRequestAccess>` | `Readonly<UsherRequestAccess> \| undefined` | compiles, as `res.locals.usher?.principal.subject` | refused, TS2540 | compile                                              |

With the decided form, the compiler refuses a direct read, which matches the rule that adapters read
only through `readAccess`. It also refuses a reassignment, which matches the runtime lock.
`attachAccess` was declared with a writable `{ usher?: unknown }` parameter, and a `readonly` key
still satisfies it.

- Two declarations of `usher` with different types in one program report TS2717 ("Subsequent property
  declarations must have the same type") with `skipLibCheck` off, and nothing with it on. Two identical
  `readonly usher?: unknown` declarations are accepted. A typed key would therefore conflict whenever
  two bridge versions with different access types meet in one program, and the `unknown` form never
  conflicts (reasoned from the run).
- The declaration applies only when the bridge's declaration file is part of the consumer's program. A
  program that never imports the bridge package sees `res.locals.usher` as `any`. An adapter that
  imports only `usher-types` is such a program.
- Augmenting the module `express-serve-static-core` instead also typed `res.locals.usher`, under npm
  and under pnpm's default layout. It leaves `Express.Locals` untouched, and it depends on that module
  resolving from the bridge's location. The global form needs no resolution.
- The bridge's emitted declarations import `NextFunction`, `Request` and `Response` from
  `express-serve-static-core`, while its runtime JavaScript imports nothing from it. TypeScript
  consumers therefore need `@types/express-serve-static-core`, which fits an optional peer.

The bridge's peer ranges on Express:

```json
{
	"peerDependencies": {
		"@types/express-serve-static-core": "^4.17.33 || ^5.1.3",
		"express": "^4.22.3 || ^5.2.1"
	},
	"peerDependenciesMeta": {
		"@types/express-serve-static-core": { "optional": true }
	}
}
```

The bridge also peers `usher-types`, declared `workspace:^`, which publishes as a caret range on the
workspace version of `usher-types`.

## Express 4 and 5 when middleware fails

| Failure in a middleware   | Express 4.22.3                                                                                                                | Express 5.2.1                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| an asynchronous rejection | never caught; with no `unhandledRejection` handler, Node 24 ends the process with exit code 1, and the request gets no answer | 500; the body holds the stack trace and the error message |
| a synchronous throw       | 500; the body holds the stack trace and the error message                                                                     | 500; the body holds the stack trace and the error message |

With `NODE_ENV=production`, neither 500 body held the stack trace or the message. A bridge that left
failures to the host would therefore answer differently by Express version and by environment.
Catching in the bridge makes the answer one fixed 503. Answering 503 rather than serving the open tier
keeps a bridge defect visible as an error instead of as reduced results.

## Freezing the request's access

A sample `attachAccess` that parsed the value with zod and then called `Object.freeze` showed:

- zod's parse returns a new object, so the input passed in stays unfrozen.
- Only the top level was frozen. `results` and each enforcement result stayed writable, and
  `attached.results.file.kind = 'allow'` turned a deny into an allow.
- `res.locals.usher` itself could be replaced wholesale.
- A `readAccess` that validates shape accepted both the changed value and the replacement.

With a deep freeze in `attachAccess` and the Express layer's lock after it, later ESM middleware on
Express 4.22.3 and on 5.2.1 got the same results:

| Later middleware                                                                      | Result                                                                                                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| reassigns `res.locals.usher`                                                          | `TypeError`                                                                                                                       |
| deletes `res.locals.usher`                                                            | `TypeError`                                                                                                                       |
| redefines `usher` with `Object.defineProperty`                                        | `TypeError`                                                                                                                       |
| changes a nested result                                                               | `TypeError`                                                                                                                       |
| calls `attachAccess` again on the same store                                          | `TypeError`                                                                                                                       |
| spreads `res.locals` into a new object                                                | the same frozen value, in a writable slot                                                                                         |
| replaces `res.locals` with a spread that puts another well-formed value under `usher` | a `readAccess` checking shape returned the other value; one accepting only values recorded by `attachAccess` in a `WeakSet` threw |
| replaces `res.locals` with `{}`                                                       | `readAccess` threw                                                                                                                |

After the first five attempts, the value read back was the original.

- **The lock covers the property, not `res.locals` itself.** On both Express versions `res.locals` is
  an ordinary writable property of the response. Replacing it with an empty object fails closed,
  because `readAccess` then throws. A rebuild that puts another well-formed value under `usher`
  fails closed too, because `readAccess` accepts only a member shaped as `attachAccess` leaves it,
  and a spread or an assignment leaves a writable, enumerable one (reasoned, not run). Only a
  rebuild that defines `usher` with the same attributes around another deep-frozen, well-formed
  value passes (reasoned). The lock in that run left `usher` enumerable, while `attachAccess` as
  decided leaves it non-enumerable, so a spread of `res.locals` carries no `usher` at all (reasoned,
  not run).
- **Two copies of `usher-types` interoperate, and the peer keeps one.** `readAccess` checks the
  member's shape and the value, never which copy attached it, so a value attached through one copy
  reads through another (reasoned, not run). Two copies could still disagree about which access
  versions they accept. That is why `usher-types` is a peer dependency of the bridge: a peer
  resolves to the copy installed by the host, so the host holds one copy of the contract and of
  `SqonSchema`. Under pnpm's isolated layout a peer of the bridge resolves from the host's own
  dependencies, and the adapter's dependency is out of its sight (reasoned, not run), so the host's
  own dependency on `usher-types` is what holds one copy beside the peer. The install's check is
  only as strict as its settings: pnpm links an out-of-range peer with only a warning, as the
  [zod ranges](#ranges-under-npm-and-pnpm) show. The two-copy test covers what an install lets
  through. Every fake bridge, Arranger's included, must attach through the real `attachAccess`.
- **No `WeakSet`, because two copies would turn it into an outage.** Each copy's `WeakSet` would
  refuse the values attached through the other, so every read path would throw: an outage rather than
  a leak (reasoned).
- **`attachAccess` refuses an occupied store itself.** Without that refusal, a second attach would
  take the store over with its own value, since nothing else stops it (reasoned, not run); the lock
  table's row above shows the refusal.
- **The freeze must be deep, and its test must look deep.** `attachAccess` attaches the fresh
  snapshot returned by its validator rather than a cached object, and rendered results are deep-frozen
  before caching, so one request's change can never reach the shared anonymous entry. The "frozen"
  assertion in [bridge-tests.md](../../bridge-tests.md#the-express-layer) must check `results` and
  every SQON node.
  A top-level `Object.isFrozen` check passes against a shallow freeze, and the inversion row that
  attaches the access unfrozen would then prove nothing about nested values.

The threat is a defect in a host or an adapter, such as normalizing a SQON in place, not an outside
attacker. Deep freezing has a consequence for consumers: in strict-mode ESM, writing to a frozen
object throws a `TypeError`. An adapter must compose the narrowed SQON without changing it, and its
tests must show that such an error fails the request closed rather than being caught into a
pass-through (reasoned, not run).

## zod as a peer

Neither `usher-types` nor the bridge has zod as a peer: `usher-types` validates by hand and keeps zod
for its tests alone. The findings below were measured with sample packages that peered zod and built
their validators with it, and they hold for any package that does. zod still runs inside
`SqonSchema`, applied by the validators as a step of their own, since `@overture-stack/sqon`
1.0.0-rc.6 has zod as a regular dependency (read from its manifest).

### Copies of zod in one process

- zod 4.6.5 is itself a dual package: `import` resolves to `index.js` and `require` to `index.cjs`.
  One installed version can therefore load as two instances.
- zod 4 tolerates copies at runtime. Its `instanceof` checks a set of traits rather than a
  constructor, and its global configuration and registry live on `globalThis` (read from source). An
  error thrown through the sample package's ESM copy was `instanceof` a CommonJS consumer's `ZodError`,
  and schemas composed across instances parsed and rejected correctly.
- Two copies at different minors break type assignability. With the consumer on 4.5.4 and the package
  on 4.6.5, assigning a package schema to the consumer's `zod.ZodType` fails, because
  `_zod.version.minor` is a literal type (5 against 6). Composing the schema inside the consumer's
  `zod.object` still compiled. Two copies of one version type-check.

### Why errors and logs carry fixed text only

- zod's default messages carry input. An unexpected key in a strict object is reported as
  `Unrecognized key: "<the key>"`.
- Issue paths hold the payload's record keys, which are resource identifiers and category names.
  `ZodError.message` serializes every issue, keys and paths included.
- A host's `zod.config({ customError })` rewrites the messages of validators built with zod. After a
  consumer set a `customError` that echoes `issue.input`, the sample validators reported messages
  such as `rejected input 7`, where their default message was `Invalid input: expected 1`.
- A host may forward an error's message to its clients. Express does so outside production, as
  [Express 4 and 5 when middleware fails](#express-4-and-5-when-middleware-fails) shows, and a host's
  own error formatting can do the same in production.
- zod's global configuration also holds `jitless` and a post-processing hook. Importing zod's
  `compile` entry point replaces the validation routine of every schema constructed after that import
  (read from zod 4.6.5's source, not run). A host's zod setup can therefore change the engine behind
  a validator built with zod, not only its messages. The hand-written checks in `usher-types` are out
  of that reach, while the `SqonSchema` step can fall within it (reasoned, not run). A check of known
  answers at startup is one countermeasure, and none runs: it is revisited with publishing
  integrity, which is [open](#open-questions).
- zod issue kinds, such as `invalid_type`, carry no input, but each addition to a log event would need
  checking again against the rule that no payload content reaches a log.

### Ranges under npm and pnpm

These rows were measured with a sample package peering zod, so the copy in use was the host's. zod
reports its own version at runtime, as `core.version` on its namespace.

| Consumer's own zod range             | npm 11.5.1                                                                 | pnpm 12.9.1                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| exactly 4.5.4                        | refuses with ERESOLVE; with `--legacy-peer-deps` runs the package on 4.5.4 | warns, links 4.5.4 and exits 0; fails only with `strictPeerDependencies: true` |
| `^4.2.0`, with the lockfile at 4.5.4 | exits 0 and upgrades the shared zod to 4.6.5                               | not run                                                                        |

npm refuses only when the consumer's own range excludes the peer's. In an npm workspace whose zod
users declare a range that admits the peer, adding a package that peers zod upgrades the zod shared
by every package in the workspace. Arranger's ranges and lockfile match the second row
([Consumers](#consumers)), so the upgrade would reach each of its packages that uses zod
(reasoned from that row, not run in Arranger). Under pnpm, `pnpm peers check` names the gap ("unmet
peer zod Installed: 4.5.4 Wanted: ^4.6.5"), and the package runs on 4.5.4. Neither of Usher's
packages peers zod, so a host's zod range meets neither of them.

### The lower bound

Sample schemas built against 4.6.5 (a strict object, a discriminated union, lazy recursion, a record,
a literal and an enum) type-checked on TypeScript 5.8.3 and validated correctly with the newest patch
of every zod minor from 4.0 to 4.6, each as the only copy. `usher-types` imports no zod, so it sets
no zod lower bound of its own, and `@overture-stack/sqon` brings its own range. A package whose
shipped source imports zod sets its lower bound from the API it uses, through a CI matrix over zod
minors.

## The workspace

### pnpm settings

A sample `pnpm-workspace.yaml`, not the workspace's own, installed cleanly under pnpm 12.9.1:

```yaml
allowBuilds:
  esbuild: false
catalog:
  zod: 4.6.5
catalogs:
  peer:
    zod: ^4.6.5
packages: ['apps/*', 'modules/*']
saveExact: true
```

The root `package.json` names `"packageManager": "pnpm@12.9.1"` and holds three devDependencies
through the catalogue: Prettier, and TypeScript and `@types/node` for type-checking the root
`scripts/`. Every development tool's version lives in the catalogue as
a range, except tsdown, which is exact while below 1.0, and the lockfile pins each exact resolution.
Each is taken at its latest when the package is created, with two exceptions: `@types/node` takes
the newest of the 24 line, and typescript the latest version within rolldown-plugin-dts's peer
range.

- **Build scripts.** By default pnpm 12.9.1 fails an install on any dependency build script not yet
  reviewed (`ERR_PNPM_IGNORED_BUILDS`, exit code 1). esbuild's postinstall, pulled in by tsx, is the
  toolchain's only one. TypeScript 7, rolldown and the other native tools ship platform
  packages without scripts. `allowBuilds: { esbuild: false }` records the review, and tsx runs
  without the script. From the documentation: `allowBuilds` arrived in pnpm 10.26.0 and treats any
  package it does not list as unreviewed, `strictDepBuilds` defaults to true, and
  `onlyBuiltDependencies` and its relatives were removed in pnpm 11.
- **Configuration files.** pnpm reads only auth and registry settings from `.npmrc` (from the
  documentation, not run). Everything else lives in `pnpm-workspace.yaml`, so no committed `.npmrc`
  is needed, and registry credentials come from CI.
- **The lockfile.** Under pnpm 12.9.1, with `packageManager` naming that version, it holds two YAML
  documents. The first records pnpm itself, with an integrity hash per platform, taken from the
  `packageManager` field.
- **Catalogues.** A package declaring `"zod": "catalog:peer"` as its peer and `"zod": "catalog:"` for
  development publishes `^4.6.5` and `4.6.5`, so zod stays exact for development and a range for the
  peer. `workspace:*` publishes as the exact version. `workspace:^`, the form of the bridge's peer on
  `usher-types`, publishes as a caret range on that version (from the documentation, not run).

### The release-age gate

pnpm can hold back versions published less than a set number of minutes ago (`minimumReleaseAge`).
By the documentation, the default is 1440 minutes since pnpm 11, and the gate is strict only when the
setting is explicit. Measured against a TypeScript nightly about 18 hours old, with a fresh metadata
cache:

| What the install asks for         | Setting unset                                                                                                          | Set explicitly to 1440                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| an exact pin to the fresh version | installs it, and writes the version and its platform packages into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` | refused: `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, exit 1 |
| a dist-tag pointing at it         | falls back to the older version                                                                                        | falls back to the older version                        |
| a range spanning both versions    | resolves the older version                                                                                             | resolves the older version                             |

Left unset, the gate lets an exact pin through, and pnpm records each pass in a committed file
without asking. Set explicitly, the gate holds, and it also refuses the latest version of anything
published in the last 24 hours. Under an explicit setting, "latest when a package is created"
therefore waits a day.

### Resolving `usher-types` inside the workspace

Inside the workspace the bridge resolves `usher-types` through its exports map, which points at
`dist`. With `usher-types` unbuilt, the bridge's tests fail with `ERR_MODULE_NOT_FOUND`. Three ways
keep the test command a bare `tsx --test`:

| Way                                                                                                                                                                                     | Cost                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build `usher-types` before the bridge's tests run                                                                                                                                       | a build before each test run; running workspace scripts in dependency order is pnpm's documented behaviour, not run                                                                                                                            |
| the decided source export condition, `@overture-stack/source` pointing at `src/index.ts`, set through each package's `tsx --conditions` test script and TypeScript's `customConditions` | the published exports map names a file left out of `"files"`, unless the condition is removed at publish (reasoned, not run); zod ships a `@zod/source` condition of the same kind                                                             |
| TypeScript `paths` mapping the package to its source, honoured by a bare `tsx --test`                                                                                                   | when `usher-types` was not a declared dependency, tsdown inlined its source into the bridge's `dist`, a second set of validators, and `onlyBundle` does not catch it; CI must check that the bridge's `dist` never contains `usher-types` code |

## Tests

### Which files a bare `tsx --test` runs

With no file arguments, tsx 4.23.15 passes Node the glob
`**/{test,test/**/*,test-*,*[.-_]test}.?(c|m)@(t|j)s`, and adds `--enable-source-maps` (read from its
source). In the class `[.-_]`, the hyphen makes a range from `.` to `_`, which leaves out the hyphen
itself.

| File                                                        | bare `tsx --test` | bare `node --test` |
| ----------------------------------------------------------- | ----------------- | ------------------ |
| `*.test.ts`, `*.test.mts`, `*.test.cts`, `*.test.js`        | runs              | runs               |
| `*_test.ts`, `test-*.ts`, `test.ts`, any file under `test/` | runs              | runs               |
| `*-test.ts`, `*-test.mjs`                                   | skipped           | runs               |
| `*.spec.ts`, `*.tests.ts`                                   | skipped           | skipped            |
| `dist/*.test.js`                                            | runs              | runs               |
| anything under `node_modules`                               | skipped           | skipped            |

Test files stay out of `dist`: tsdown with a single entry emits none. A shared helper named
`test-*.ts`, `test.ts` or `*_test.ts`, or placed under `test/`, runs as a test file, so helpers take
names outside the glob.

### Mock timers on Node 24.16

- Supported: `setTimeout`, `setInterval`, `setImmediate`, `Date`, `scheduler.wait` and
  `AbortSignal.timeout`. Refused: `performance`, `queueMicrotask` and `process.hrtime`.
- Mocking `Date` covers both `Date.now()` and `new Date()`. `performance.now()` is not mocked: it
  advanced 0 ms across a mocked hour, so a monotonic clock read through it must be injected in tests.
- Enabling mock timers twice throws `ERR_INVALID_STATE`, so tests reset them in `afterEach`.
- Promise callbacks from a mocked interval need flushing, with two `await Promise.resolve()`, before
  an assertion.
- One mocked clock drives both `Date` and the timers. `mock.timers.setTime` moves it without firing
  anything. A backward `setTime` of an hour left a 60 s timer unfired through 60 s of `tick`, and it
  fired only after another hour. A forward `setTime` past a timer's time fired it on the next
  `tick(0)`. Mocking `Date` therefore cannot model a wall-clock step apart from the timers.
- A mocked `AbortSignal.timeout` aborts with an `AbortError`, and the real one with a `TimeoutError`.
  Code that branches on the reason's name takes a different branch in tests than in production.

| How the code reaches `setTimeout`                       | ESM module, the bridge's format | file transformed to CommonJS by tsx |
| ------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| the global                                              | controlled                      | controlled                          |
| a named or namespace import from `node:timers`          | not controlled                  | controlled                          |
| a named or namespace import from `node:timers/promises` | not controlled                  | controlled                          |
| `require('node:timers').setTimeout`, read at call time  | controlled                      | controlled                          |

A test of code with a named `node:timers/promises` import waited ten seconds of real time.

With only `setTimeout` mocked and a fake wall clock passed in, a model that checked both a watchdog
timer and the wall clock passed three rows: a backward wall step during which the watchdog still
lapsed; a monotonic clock that stood still while the wall check lapsed; and both clocks 1 ms short of
the grace period, which held. That model is not the design, which reads the injected monotonic clock
alone. What the run shows is that passing a clock in lets a test step one clock without the other.

A co-located test file, run by a bare `tsx --test` with given, when, then names, drove three
behaviours through mock timers:

- a cache entry live 1 ms before the earlier of its two expiries, and dropped at it;
- a poll every 30 s with a 60 s grace period: normal at 60 s, uncertain at 90 s, with one mode change;
- a back-off on `setTimeout` that resolved without real waiting.

**The grace row needs a sample between poll ticks.** Samples at 30, 60 and 90 s cannot tell a bridge
that notices the lapse when a request arrives from one that notices it only at its next poll, which
keeps honouring grants for up to one more poll interval. The degraded-mode rows in
[bridge-tests.md](../../bridge-tests.md#degraded-modes) need one asserting uncertain mode 1 ms after
the last successful check plus the grace period, between two poll ticks. They also need a row that
steps the wall clock backward and shows the lapse still arriving on time.

## Coverage, reported and not decided

The fixture: a source file with three branches whose own test reaches two; a second test that reaches
the third branch incidentally; and a file imported by no test. A pair run runs one test file and
measures only the source file beside it. A whole-suite run hides the incidental branch, because
another test reaches it.

| Tool and runner                                                    | Lists the file imported by no test | Uncovered lines reported by a pair run                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| c8 under tsx                                                       | yes with `--all`, at 0%            | partly right: one fixture listed both uncovered lines, another listed one of the two                                         |
| c8 under Node's own type stripping                                 | not run with `--all`               | right                                                                                                                        |
| built-in, under tsx 4.23.9 or later (source maps on)               | no, even with an include filter    | wrong: a type-only line is reported uncovered, and the real uncovered lines were listed in one fixture and missed in another |
| built-in, under tsx 4.22.3 or `node --import tsx` (no source maps) | no                                 | wrong: 100% of lines                                                                                                         |
| built-in, under Node's own type stripping                          | no                                 | right                                                                                                                        |

Branch percentages agreed across tools, except the built-in reporter without source maps, which gave
80% where the others gave 75%. One pair run took 0.26 to 0.40 s under c8, 0.16 to 0.17 s with
built-in coverage, and 0.13 to 0.21 s without coverage, three runs each on the machine named at the
top. A pairing script needs both kinds of run: one c8 run per test file with `--include` set to its
sibling, and one whole-suite `c8 --all` run for files loaded by no test.

The [roadmap](../../../roadmap.md#finding-untested-code-settled-before-the-bridge-is-built) says
built-in coverage under tsx "reports a false 100% unless source maps are enabled", checked on tsx
4.22.3. That holds for tsx 4.22.3 and for `node --import tsx`. A bare `tsx --test` has turned source
maps on by itself since tsx 4.23.9, and line attribution is wrong with them too, so built-in
coverage under tsx misreports lines either way.

## Consumers

- **Arranger's search-server** is an ESM package (`"type": "module"`) on `express` `^4.18.2`,
  `@types/express` `^4.17.21` and `typescript` `^5.8.2`. It compiles with `module` and
  `moduleResolution` set to `nodenext`, `skipLibCheck` on, `verbatimModuleSyntax` and
  `noUncheckedIndexedAccess`. It can import both packages in the decided shape.
- **Arranger as a whole** is an npm workspace. Its lockfile resolves TypeScript 5.9.3 and zod 4.5.4,
  and its packages that use zod declare `^4.2.0`. Its root declares `engines` `node >=20.0.0`, so npm
  only warns about the packages' `node >=24` unless `engine-strict` is set.
- **Arranger's adapter plan** (`.dev/docs/arranger-auth/usher-adapter-tests.md` in the Arranger
  repository) creates `usher-types` once Arranger's TypeScript, zod and pnpm upgrades are settled.
  The declaration results above remove the TypeScript reason, as long as the CI consumer check holds.
  [technology-stack.md](../roadmap/technology-stack.md) gives the same TypeScript reason. The zod
  reason falls away, since neither package peers zod and so neither brings the shared upgrade
  described above (reasoned).
- **Stage** is a Next.js application with a server side, and it was not run. By reasoning, Next.js
  either bundles server code or loads packages listed as server external through Node, and both accept
  ESM. The bridge belongs in the second group, so that separate server bundles do not each hold a copy
  of its state.
- **Lyric and other applications** follow. Nothing was checked for them.

## Not verified

- Stage, and any consumer that tests with Jest, were not run against the ESM-only packages. Jest's
  module runtime does not use Node's `require`, so `require(esm)` may not help a Jest-based consumer.
- The packed packages themselves were compiled only by the TypeScript 5.9.3 consumers in the rows
  naming serve-static-core alone. Every other consumer row compiled the sample surface, so no
  consumer from TypeScript 5.8 has compiled the real declarations.
- The TypeScript 7.1 findings come from a nightly, and may change before release.
- Three things were not run under pnpm 12.9.1: `allowBuilds: { esbuild: true }`, `.npmrc` handling,
  and whether an older pnpm 12 hands over to the version pinned in `packageManager`.
- tsdown inlined jose when jose was only a devDependency, so only the check on the bridge's packed
  JavaScript shows that the `usher-types` peer stays an import.
- No host holding two copies of `usher-types` was run, and no host that gets `usher-types` only
  through its adapter was installed.
- tsdown's own exports generation and its publint and arethetypeswrong integration, Express 5 under
  `exactOptionalPropertyTypes`, and mutation testing remain untested.
- Whether a warm metadata cache lets a fresh version past an explicit `minimumReleaseAge` is not
  established.
- How Node's timers and `performance.now()` behave across a real system clock step, and across a
  suspension of the host, was reasoned, not run. The clock rows above ran against mocked timers and a
  fake wall clock.
- The lock and the `WeakSet` check ran in a stand-alone application with a sample `attachAccess` and
  `readAccess`, not in a host that rebuilds `res.locals` itself.
- What the exchange carries is decided: the sign-in credential, an API key included, which reaches
  the bridge as `Bearer` like any other; the bridge's audience identifier; and the set of payload
  versions supported by the bridge, as [decisions.md](../../../design/decisions.md) records ("Payload
  versions are negotiated at the exchange"). The answer is held to a configurable size cap before
  decryption, 1 MiB by default, which rests on the sizes measured in the
  [jose note](jose-usher-token.md#not-verified). How the exchange is encoded on the wire, its method,
  body and content types, is fixed by the exchange's row under "What this settles for the controller"
  in [bridge-tests.md](../../bridge-tests.md#what-this-settles-for-the-controller).
- The publishing options under [Open questions](#open-questions) (npm provenance, trusted publishing,
  two-factor authentication on the scope) were reasoned, not checked against the registry or the
  release pipeline.
- Whether Node's `--experimental-test-coverage` is stable on Node 24 was not checked. It needs the
  flag on Node 24.16.

## Open questions

1. **Publishing integrity.** The bridge holds the application key and builds every predicate, so a
   tampered publish of either package would undo access control in every ushered application. Option
   (a): publish from a CI provider supported by npm's trusted publishing and provenance, so each
   version is tied to the commit and workflow that built it. Option (b): publish from the existing
   release pipeline with a scoped automation token, and require two-factor authentication on the
   `@overture-stack` scope for people. (a) lets a consumer verify where a version came from; (b) keeps
   the pipeline as it is but protects only the credentials. Which CI providers npm accepts for trusted
   publishing was not checked. The choice belongs to the release work, not to this note. A check of
   the validators' known answers at startup, which neither package runs, is revisited with it,
   as [Why errors and logs carry fixed text only](#why-errors-and-logs-carry-fixed-text-only) notes.
2. **Coverage.** Option (a): c8, one run per test file with `--include` set to its sibling, plus one
   whole-suite `c8 --all` run; only c8 lists files loaded by no test. Option (b): Node's built-in
   coverage, faster, but under tsx it omits files loaded by no test and misplaces lines. Separately:
   whether coverage runs under tsx, like the tests, or under Node's own type stripping. Type stripping
   reported uncovered lines correctly for both tools, and needs `.ts` import specifiers with
   `allowImportingTsExtensions`.
