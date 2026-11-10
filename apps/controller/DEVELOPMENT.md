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

## Running it locally

`compose.yaml` starts what the controller needs on this machine: PostgreSQL 15 and Keycloak, at
the tests' versions, each published on 127.0.0.1 alone. From `apps/controller`, with Docker
running:

    node scripts/generate-compose-secrets.ts   # every secret, into .env, which git ignores
    docker compose up --detach --wait          # PostgreSQL on 5432, Keycloak on 8080

The script replaces an existing `.env` only when given `--force`. PostgreSQL keeps the passwords it
was created with, so run `docker compose --profile image down --volumes` before replacing the file.

**To run the controller on this machine**, build it, apply the schema migrations, then start it on
port 3000. `compose/host-settings` holds the settings, none of them secret:

    pnpm build
    node --env-file=compose/host-settings --env-file=.env dist/migrate.js
    node --env-file=compose/host-settings --env-file=.env dist/main.js

Both commands load every secret in `.env`, the schema migration role's password included, since the
account running them can read the file anyway. Under compose, the controller never receives that
password.

**To run the controller's image**, add the `image` profile. It builds the image from the
repository's root, runs the schema migration command once, then starts the controller on port 3001
once the migrations have succeeded:

    docker compose --profile image up --build --detach --wait
    curl --fail http://127.0.0.1:3001/health/ready

The controller takes the identity provider's URLs over http only on a loopback host, so this
controller shares Keycloak's network namespace, and the keycloak service publishes the controller's
port. These two commands are also the check that the image builds and reaches ready. The check runs
by hand rather than under `pnpm test`, since it needs Docker, an image build and the fixed ports
above.

**Keycloak** serves the realm `overture` at http://127.0.0.1:8080, imported from
`compose/overture-realm.json` each time its container is created. The realm is for local development
only. It holds the `usher-platform-admin` role and `usher-ui`, a management client issuing tokens
for the audience `usher-management`. The realm holds no people: add them in the admin console at
http://127.0.0.1:8080/admin, signing in as `usher-dev-admin` with `KEYCLOAK_ADMIN_PASSWORD` from
`.env`. People added there last until Keycloak's container is removed. A person's management token
comes from `usher-ui` through the password grant. `usher-ui` is a public client using that grant,
which suits minting tokens on this machine and nothing else.

To stop everything and delete the database:

    docker compose --profile image down --volumes
