# Usher Controller: development notes

## Where the tests live

The controller's tests check it from the outside: through its HTTP API (the Policy Management API
under `/admin`, and the bridge-facing `POST /exchange`, `GET /notices` and `GET /notices/stream`),
through the token and notices the bridge reads, and through the database's own constraints. They
live in `test/`, one folder per boundary:

| Folder              | What its tests go through                                                    |
| ------------------- | ---------------------------------------------------------------------------- |
| `test/database/`    | the schema, its constraints and triggers, and the controller's database role |
| `test/exchange/`    | `POST /exchange`: sign-in token validation and the Usher token issued        |
| `test/channel/`     | `GET /notices`, `GET /notices/stream` and the back-channel logout endpoint   |
| `test/admin/`       | the Policy Management API                                                    |
| `test/audit/`       | the audit log, the log stream and `GET /admin/audit`                         |
| `test/conformance/` | the conformance corpus, replayed against the controller                      |
| `test/integration/` | the real bridge running against the controller                               |
| `test/migration/`   | the migration of EGO's study groups                                          |

This is a deliberate exception to the rule that a test sits beside the source file it tests. These
tests pin a contract at a boundary, not a file, so the drift that rule guards against does not
arise, and placing them under `src/` would decide the controller's module layout before its
implementation does. Unit tests of a single module still sit beside that module's source.

Node's test runner treats every file under a directory named `test/` as a test file, so helpers
belong in `test-support/`, never in `test/`.

## Running them

From `apps/controller`, with Docker running:

    pnpm test          # every test, against PostgreSQL 15 and Valkey
    pnpm test:newest   # the same, against the newest PostgreSQL major released
    pnpm typecheck

From the repository's root, `pnpm test:controller` runs the same suites; the root's `pnpm test`
leaves them out, since they need Docker.

The integration suite at the iMS defaults' own timescale takes minutes, so it runs on demand and before
each release rather than with every run:

    USHER_TEST_ON_DEMAND=ims-defaults pnpm test test/integration

`test-support/README.md` describes the shared support code, and how every test reaches the
controller through `test-support/controller.ts` alone.
