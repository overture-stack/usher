# Usher: Developer Guide

Internal guide for contributors.

## What Usher is

Usher is the access enforcement system for the Overture platform: it holds the grants that say who may
reach what and hands them to each application, which enforces them at its own query layer.
Decisions follow RABAC (role-centric attribute-based access control): a role decides which actions
are available, and attributes such as a record's categories decide which data they reach. The
answer travels as an encrypted Usher
token applied by a per-app adapter. The [README](README.md) has the full framing, including the two
properties that separate it from a conventional authorization service.

Usher is not an authentication service. Authentication is delegated to the configured identity
provider (Keycloak, Microsoft Entra ID, or any OIDC-compatible provider).

## The specification

The design documents in `.dev/design/` are the primary specification, and the packages under
`modules/`, usher-types and the Express bridge, implement it.

## Repository structure

    usher/
      .dev/
        design/          (design documents; see design/README.md for the index)
        roadmap.md       (planned work)
        tech-debt.md     (known issues)
        sessions/        (session log, one file per contributor per day)
        docs/            (phase and traceability documents, and the atlas)
      AGENTS.md          (instructions for Codex and general AI agents)
      CLAUDE.md          (instructions for Claude)
      DEVELOPMENT.md     (this file)
      modules/
        express-bridge/  (@overture-stack/usher-express-bridge, the bridge for Express applications)
        types/           (@overture-stack/usher-types, the types and schemas the packages share)
      package.json       (workspace scripts)
      pnpm-workspace.yaml (workspace packages, pnpm settings and shared dependency versions)
      scripts/           (repository tooling: the packaging check and its tests)
      tsconfig.base.json (compiler settings every package extends)

## Building and testing

The workspace uses pnpm 12.9.1, the version named by `packageManager` in `package.json`, and Node 24
from 24.11 or Node 26 and later, the versions the build tooling supports. A pnpm 11 older than
11.28.4 crashes when it switches to that pin and damages its store, so bring your own pnpm to
11.28.4 or later, or to 12, before running anything here.

    pnpm install      (installs from the lockfile; dependency install scripts stay blocked)
    pnpm build        (builds every package into its dist/)
    pnpm check:pack   (packs every built package as publishing would and checks what it ships)
    pnpm test         (runs every package's tests, going on past a package that fails)
    pnpm test:scripts (runs the tests of the scripts in scripts/, which pnpm test leaves out)
    pnpm typecheck    (type-checks every package, going on past a package that fails)
    pnpm typecheck:scripts (type-checks the scripts in scripts/, which pnpm typecheck leaves out)
    pnpm format       (formats every file Prettier reads, under .prettierrc.json)
    pnpm format:check (fails on any file Prettier would change)

Tests and type-checks read each package's source through the `@overture-stack/source` export
condition, so neither needs a build first; the published manifests leave that condition out. Running
a script after changing a `package.json` fails until `pnpm install` has been run,
so the lockfile only changes on an explicit install.

**Test files sit next to their source and are named `*.test.ts`.** Each package runs
`tsx --conditions=@overture-stack/source --test` with no path or glob, which finds files by name, so
the name decides what runs:

- a `*.spec.ts` file is never run, and nothing reports it;
- a file under a `test/` directory, or one named `test.ts`, `test-*.ts` or `*_test.ts`, is run as a
  test file even when it is only a helper, so helpers and fixtures go under a name such as
  `fixtures/`;
- a package with no test files passes, reporting zero tests.

**`pnpm check:pack` checks each package as publishing would ship it.** It runs `pnpm pack` for every
package under `modules/`, into a temporary directory it removes afterwards. `pnpm pack` applies
`publishConfig` and rewrites `workspace:` and `catalog:` ranges, as publishing does. It packs what is
on disk, so build first. It prints one line per finding, naming the package and the rule, and exits
non-zero on any failure:

- `only-intended-files`: only `dist`, a README, a licence and `package.json` ship;
- `no-test-files`: nothing in `dist` is a test file, a fixture, a test helper or the test-only SQON
  evaluator;
- `readme-ships`: a README ships at the package root, named `README` or `README.*` in any case, as
  npm looks for one for the package's page on the registry;
- `exports-resolve`: every `exports` target is a file in the tarball;
- `types-beside-exports`: each JavaScript file named by `exports` has its declaration file beside it;
- `types-first`: `types` is the first condition in each `exports` conditions object holding it, since
  TypeScript takes the first condition it matches;
- `no-source-condition`: the packed manifest holds no `@overture-stack/source` condition;
- `no-source-paths`: no other manifest field points into `src`;
- `no-local-protocol`: no `workspace:`, `catalog:`, `file:` or `link:` range is left in
  `dependencies`, `peerDependencies` or `optionalDependencies`;
- `no-pinned-peer`: no `peerDependencies` range admits only one version, since a consumer installs
  one copy of a peer for every package sharing it;
- `private`: names a package marked private, which cannot be published.

`no-pinned-peer` reads two forms as admitting one version: an exact version, bare or after `=`, and
a caret on a `0.0.z` release, as in `^0.0.0`, which admits only `0.0.0`. A tilde on `0.0.z` admits
every later `0.0` release, so it is not one of them.

A package marked private gets notes rather than failures from `readme-ships` and `no-pinned-peer`,
since those defects matter only on the registry. The `private` finding is always a note, and no note
fails the check. The scripts run
under Node's own type stripping, with no build step. `pnpm test:scripts` runs their tests, and
`pnpm typecheck:scripts` type-checks them under `scripts/tsconfig.json`, which extends the base
settings.

## Working documents

The `.dev/` directory is the shared working memory for this project across sessions and
contributors, human and AI.

- **`roadmap.md`**: planned features and architectural work. Items are open unless marked
  `[in progress]`. Completed items are removed; `sessions/` is the historical record.
- **`tech-debt.md`**: issues logged scope-adjacently. `standalone: yes` entries can be picked
  up without broader context.
- **`sessions/`**: one file per contributor per day, named `YYYY-MM-DDTHHMMSS.md`, logging what
  was done: design decisions made, documents changed, tech-debt entries added. No conversational
  activity. ISO names sort chronologically, so no index is needed.
- **`docs/`**: documents that outlive a session. The phase-1 blocker set and implementation gate,
  requirement and user-flow traceability, and the atlas of longer-form roadmap detail.
- **`design/`**: design documents covering security workflow, permissions model, adapter
  integration, and the management UI. Start at `design/README.md`.

## AI tooling

This project uses Claude and Codex as development partners, with `CLAUDE.md` and `AGENTS.md` at
the repo root. `AGENTS.md` carries the substance and `CLAUDE.md` defers to it, so conventions,
session checklists and security triggers are stated once. Agents that read neither by default are
pointed at `AGENTS.md` rather than given a third copy to drift from. Do not modify either without explicit agreement from the lead
developer.

## Security

Usher is built so that the systems relying on it can handle sensitive data such as personal health
information (PHI). The design is calibrated to OWASP Top 10:2025 and
documented in `.dev/design/security-threat-model.md`. Security concerns are treated as first-class
design requirements, not afterthoughts.

Key principles:

- Fail-secure: errors in the authorization path must deny, not permit
- Deny by default: category access requires explicit grants
- Fail-open is never acceptable in the authorization or revocation path
