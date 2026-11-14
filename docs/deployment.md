# Deploying the controller

> This page is for an operator deploying the Usher controller: the service holding a platform's access policy, called by the bridge inside each ushered application and by the management UI. For what Usher does and why, read [Data access control](intro.md) first. To run the controller and its services on one machine for development, see the controller's [development notes](https://github.com/overture-stack/usher/blob/main/apps/controller/DEVELOPMENT.md).

---

## What a deployment runs

| Part                         | What it is                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Controller instances         | One or more processes from the controller's image, sharing one store                       |
| The schema migration command | The same image, run once before each rollout to bring the store's schema up to the release |
| PostgreSQL 15 or later       | The store: the policy, the audit log, and the notices read by bridges                      |
| An identity provider         | The realm issuing the tokens trusted by the controller                                     |

---

## First deployment

A first deployment takes these steps, in order, each one detailed in its section:

1. Create the database and its two roles: [PostgreSQL](#postgresql), [The two database roles](#the-two-database-roles).
2. Make the two keys: [Keys](#keys).
3. Set up the realm: [The identity provider](#the-identity-provider).
4. Set the variables, from what steps 1 to 3 made: [Variables](#variables).
5. Run the image once as the schema migration command: [The image](#the-image), [Schema migration before each rollout](#schema-migration-before-each-rollout).
6. Start the controller's instances, and wait for `GET /health/ready` to answer 200: [Readiness and liveness](#readiness-and-liveness).
7. Register each application and its resources, then confirm with an anonymous exchange: [Registering resources](#registering-resources).

---

## The image

One image runs both commands. Its entrypoint is `/nodejs/bin/node`, and its arguments choose the command.

| Arguments                                    | Command                      |
| -------------------------------------------- | ---------------------------- |
| None, which runs the default, `dist/main.js` | The controller               |
| `dist/migrate.js`                            | The schema migration command |

Set the arguments alone to choose a command, and leave the entrypoint as it is.

- **Its base is distroless, running Node 26.** It holds no shell, no package manager and no curl.
- **It runs as user and group 65532**, never as root.
- **It listens on the port in `USHER_PORT`**, which has no default. The image declares no port of its own.

---

## Variables

Each command reads its settings from environment variables once, at start, and checks every one before using any. A refusal lists every rule broken, naming each variable and never its value. The process then ends with exit code 1, before it connects to anything.

| Kind     | Meaning                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Required | It has no default, so leaving it unset is refused.                                                                 |
| Optional | It takes the default shown when unset. Set to an empty value, it is refused, unless its row says what empty means. |
| Secret   | It is required, and it holds a credential.                                                                         |

**Unless its row says otherwise, a variable takes one value on every instance sharing the store.** Two kinds of row say otherwise:

- **Per instance.** `USHER_INSTANCE_NAME` differs on every instance. `USHER_HOST` and `USHER_PORT` are each instance's own listening address.
- **Both commands, alike.** The schema migration command creates the schema in `USHER_DATABASE_SCHEMA`, grants to the runtime role named in `USHER_DATABASE_URL`, and stores the notice retention floor: the sum of `USHER_TOKEN_LIFETIME_SECONDS`, `USHER_RETENTION_GRACE_SECONDS` and `USHER_RETENTION_MARGIN_SECONDS`. The controller relies on all five, so give both commands these values from one source.

A whole number is written in digits alone, with no sign, decimal point or unit. A comma-separated list has the whitespace around each entry left out, and an empty entry between two commas is refused.

### Listening

| Variable                | Kind           | What it is, and its rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_HOST`            | Required       | **Per instance.** The listening address, such as `0.0.0.0` for every IPv4 interface.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `USHER_PORT`            | Required       | **Per instance.** The listening port: a whole number from 0 to 65535, where 0 asks for any free port.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `USHER_TRUSTED_PROXIES` | Optional: none | The proxies trusted to report a client's address in `X-Forwarded-For`, as a comma-separated list of IP addresses and CIDR ranges of either IP version, such as `192.0.2.10, 198.51.100.0/24`. An empty value is none. A request's address is the nearest address in the chain not added by a trusted proxy. A range holding every address of an IP version is refused, since it would let any client name its own address: prefix length 0, or an IPv6 range holding every IPv4 address in its IPv6 form, such as `::ffff:0:0/96`. |

### This instance and its events

| Variable              | Kind     | What it is, and its rule                                                                                                                                                  |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_INSTANCE_NAME` | Required | **Per instance.** This instance's name, carried as `data.instance` by every event it records. Give each instance sharing the store its own, such as its host or pod name. |
| `USHER_EVENT_SOURCE`  | Required | The CloudEvents `source` carried by every event, such as `https://usher.example.org/controller`. It names the deployment, never one instance.                             |
| `USHER_ISSUER`        | Required | The controller's own issuer: the `iss` of every Usher token.                                                                                                              |

### The database

| Variable                              | Kind           | What it is, and its rule                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_DATABASE_URL`                  | Required       | **Both commands, alike.** A `postgres:` or `postgresql:` URL connecting as the runtime role, at the address accepting writes. It must name that role, in its user information or as a `user` parameter. It never carries a password, in either place. The schema migration command reads the role's name from it and nothing else. |
| `USHER_DATABASE_PASSWORD`             | Secret         | The runtime role's password. The controller alone reads it.                                                                                                                                                                                                                                                                        |
| `USHER_DATABASE_SCHEMA`               | Required       | **Both commands, alike.** The schema holding the controller's tables.                                                                                                                                                                                                                                                              |
| `USHER_DATABASE_EXCHANGE_CONNECTIONS` | Optional: 10   | The store connections each instance holds for token exchanges: their own transactions, the confirmation of each application key's first exchange, and the recording of refused channel assertions. Each application's share of an instance's exchanges divides them. A whole number of at least 1.                                 |
| `USHER_DATABASE_CONTROL_CONNECTIONS`  | Optional: 5    | The store connections each instance holds for everything but token exchanges and readiness: the Management API, the back-channel logout, the notice channel, key reloads, the counts of refusals it records, and the start. A whole number of at least 1.                                                                          |
| `USHER_STORE_TIMEOUT_MILLISECONDS`    | Optional: 5000 | How long the controller waits on the store for one unit of work, such as a request's statement or transaction, a start, or a readiness probe, before giving up on it. The server also applies it to each of the controller's sessions, as its statement and idle-in-transaction limits. A whole number from 1 to 2147483647.       |

### The schema migration command's own

The controller never reads these two, so give them to the schema migration command alone.

| Variable                                   | Kind     | What it is, and its rule                                                                                                                              |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_SCHEMA_MIGRATION_DATABASE_URL`      | Required | A `postgres:` or `postgresql:` URL connecting as the schema migration role, at the address accepting writes, under the rules of `USHER_DATABASE_URL`. |
| `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD` | Secret   | The schema migration role's password.                                                                                                                 |

### The keys

| Variable                   | Kind   | What it is, and its rule                                                            |
| -------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `USHER_KEY_ENCRYPTION_KEY` | Secret | The key-encryption key, encrypting every stored application key. See [Keys](#keys). |
| `USHER_CURSOR_KEY`         | Secret | The key encrypting every notice stream cursor. See [Keys](#keys).                   |

### The identity provider's settings

| Variable                                       | Kind                              | What it is, and its rule                                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_IDENTITY_PROVIDER_ISSUER`               | Required                          | The realm's issuer, exactly as its tokens carry it in `iss`, such as `https://idp.example.org/realms/platform`. It is an https URL, or an http URL to a loopback host alone (`localhost`, `127.0.0.1` or `[::1]`), and it never carries a password. |
| `USHER_ADMINISTRATOR_ROLE`                     | Optional: `usher-platform-admin`  | The realm role making whoever holds it a platform administrator.                                                                                                                                                                                    |
| `USHER_SERVICE_ACCOUNT_ROLE`                   | Optional: `usher-service-account` | The realm role marking a service account's token, which is refused on every Management API operation, whether or not it also carries the role in `USHER_ADMINISTRATOR_ROLE`. It must name a role other than that one.                               |
| `USHER_MANAGEMENT_AUDIENCE`                    | Required                          | The audience required in every management token's `aud`: the Management API's identifier at the identity provider, such as `usher-management`.                                                                                                      |
| `USHER_MANAGEMENT_CLIENTS`                     | Required                          | The client identifiers the management UI signs in through, as a comma-separated list. A management token's `azp` must be one of them. An empty value is an empty list, accepting no management token.                                               |
| `USHER_API_DOCS_CLIENT`                        | Optional: none                    | The client used by the API documentation page at `/api-docs` to sign people in, which must be one of `USHER_MANAGEMENT_CLIENTS` exactly. Unset or empty means no page. Its requirements are under [The identity provider](#the-identity-provider).  |
| `USHER_BACK_CHANNEL_LOGOUT_AUDIENCES`          | Required                          | The audiences allowed in a back-channel logout token's `aud`, as a comma-separated list: the platform's client identifiers. An empty value is an empty list.                                                                                        |
| `USHER_SIGN_IN_TOKEN_MAXIMUM_LIFETIME_SECONDS` | Required                          | The longest lifetime of a sign-in token accepted by the controller, in seconds: a whole number of at least 1.                                                                                                                                       |

### Token lifetime and notice retention

The sum of these three durations is the notice retention floor: how long each notice is kept at least, for bridges to read. The schema migration command stores it, and refuses a floor above 2147483647 seconds.

| Variable                         | Kind          | What it is, and its rule                                                                                                                                    |
| -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_TOKEN_LIFETIME_SECONDS`   | Optional: 300 | **Both commands, alike.** How long an Usher token lives, in seconds: a whole number of at least 1.                                                          |
| `USHER_RETENTION_GRACE_SECONDS`  | Optional: 60  | **Both commands, alike.** The grace period counted by the retention floor beyond the token lifetime, in seconds: a whole number of at least 0.              |
| `USHER_RETENTION_MARGIN_SECONDS` | Optional: 30  | **Both commands, alike.** The margin added by the retention floor beyond the token lifetime and the grace period, in seconds: a whole number of at least 0. |

### The notice channel

| Variable                                | Kind            | What it is, and its rule                                                                                                            |
| --------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_HEARTBEAT_MILLISECONDS`          | Optional: 10000 | How long an open notice stream may stay silent before a heartbeat: a whole number from 1 to 2147483647.                             |
| `USHER_NOTICE_PAGE_LIMIT`               | Optional: 500   | The most notices carried by one poll answer before it names a next page: a whole number of at least 1.                              |
| `USHER_NOTICE_REREAD_MILLISECONDS`      | Optional: 2000  | How often each instance reads the notice stream again when nothing has woken it: a whole number from 1 to 2147483647.               |
| `USHER_STREAM_LIMIT_PER_AUDIENCE`       | Optional: 64    | How many push streams one audience, an ushered application, may hold open on one instance: a whole number of at least 1.            |
| `USHER_STREAM_MAXIMUM_LIFETIME_SECONDS` | Optional: 900   | How long a notice stream stays open at most, in seconds: a whole number of at least 60.                                             |
| `USHER_STREAM_QUEUE_LIMIT`              | Optional: 1000  | The most notices queued for one stream before the stream is closed for a reader that stopped reading: a whole number of at least 1. |

### Access policy

| Variable               | Kind                          | What it is, and its rule                                                                                                                                                                                             |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_BASELINE`       | Optional: `count,view,export` | The record actions conferred on everyone, anonymous visitors included, as a comma-separated list drawn from `count`, `view` and `export`, each named once. An empty value confers none. Any other action is refused. |
| `USHER_SIGNED_IN_RULE` | Optional: `count,view,export` | The record actions conferred on every signed-in principal, under the rules of `USHER_BASELINE`.                                                                                                                      |

A start under a baseline or signed-in rule differing from those recorded in the store records the new rules, with a `baseline.change` event at warning, since every principal's reach changes with them.

---

## Keys

`USHER_KEY_ENCRYPTION_KEY` and `USHER_CURSOR_KEY` are each 32 random bytes, written as 43 characters of unpadded base64url in canonical form. Whitespace around a key is left out, and any other form is refused. Either of these commands makes one:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

```sh
node --eval "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The same commands make passwords needing no quoting in a shell or an environment file.

- **The key-encryption key encrypts every stored application key.** The store's first start records a check value derived from it, and a later start under any other key is refused. Every instance uses the same key, and without it no stored application key can be read.
- **The cursor key encrypts the cursors handed to bridges reading the notice stream.** Every instance uses the same key, since any instance may answer a bridge's next poll.

---

## PostgreSQL

- **PostgreSQL 15 or later.** Its schema needs 15, and the controller is tested against 15 and 18. The schema migration command refuses an older server before writing anything, naming `USHER_SCHEMA_MIGRATION_DATABASE_URL`.
- **The address accepting writes.** Point both database URLs at the primary, never at a read replica or a standby. An instance with a role allowed to write reports itself unready, with the cause `readOnly`, while its store answers as read-only.

### Connections and poolers

1. The controller sends `statement_timeout` and `idle_in_transaction_session_timeout` as startup parameters on every connection, each set to `USHER_STORE_TIMEOUT_MILLISECONDS`.
2. Those limits are what end a statement or transaction the controller has given up on, since the server goes on running it after its client has gone.
3. At each start, the controller reads both limits back from the server, on a connection of each of its pools. It refuses to start, naming `USHER_DATABASE_URL`, when either is missing or differs.
4. So connect directly, or through a pooler only where each of the controller's connections keeps one server session carrying both limits. A pooler in transaction mode hands each transaction whichever server session is free, and a pooler that refuses or drops startup parameters it does not track, in any mode, fails the check at start.

The schema migration command holds a session-level lock for its whole run, so it too needs one server session throughout: connect it directly, or through a pooler in session mode.

**Each instance holds at most as many connections as `USHER_DATABASE_EXCHANGE_CONNECTIONS` plus `USHER_DATABASE_CONTROL_CONNECTIONS` plus one**, the last for its readiness probe alone: 16 at the defaults. The connections the database must take at once are:

- that sum, times the most instances that can run at once: the replicas, plus those a rolling update starts before it stops old ones (its surge);
- plus the schema migration command's own connection while it runs.

Keep that total at most the database's `max_connections`, less the connections it keeps reserved and those its other clients hold. Through a pooler, each instance's sum counts against the pooler's limit on client connections, and the pooler's own connections to the database count against `max_connections`.

For example, 3 replicas with a surge of 1, at the defaults, hold at most 4 × 16 = 64 connections, and a schema migration run adds 1, for 65. A database whose `max_connections` is 100, with 3 reserved and 10 held by other clients, leaves 87, so it takes them.

### The two database roles

| Role                  | Holds                                                                   | Used by                            | Its password                                                            |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Schema migration role | Ownership of the database, the controller's schema and everything in it | The schema migration command alone | `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD`, given to that command alone |
| Runtime role          | Only what the migrations grant it                                       | Every controller instance          | `USHER_DATABASE_PASSWORD`                                               |

**The runtime role is a separate login role: neither the schema migration role, nor a member of it, nor a superuser.** The schema migration command refuses a runtime role breaking that rule, or one not yet created, before writing anything. The split is what protects the store from a compromised controller: it can read and write policy, which it must, but it cannot widen its own privileges or drop the audit log.

Create both roles and the database once, before the first run, as a role allowed to create roles and databases. The names here are examples:

```sql
CREATE ROLE usher_migration LOGIN;
CREATE ROLE usher_controller LOGIN;
CREATE DATABASE usher OWNER usher_migration;
```

Then set each password from psql, with `\password usher_migration` and `\password usher_controller`. The `\password` command hashes the password before sending it, so the server never receives it in plain text. The two URLs then name each role and the database:

```sh
USHER_SCHEMA_MIGRATION_DATABASE_URL=postgres://usher_migration@db.example.org:5432/usher
USHER_DATABASE_URL=postgres://usher_controller@db.example.org:5432/usher
```

- **The schema migration command creates the schema** in `USHER_DATABASE_SCHEMA` on its first run. A schema created beforehand must be owned by the schema migration role, or the command refuses it.
- **The runtime role connects through the `CONNECT` privilege**, which every role holds on a database by default. The migrations grant nothing on the database itself, so where that default has been revoked, grant `CONNECT` on the database to the runtime role.
- **The runtime role may not create in any schema, `public` included.** PostgreSQL 15 and later give `PUBLIC` no `CREATE` on the `public` schema, but a database upgraded from an earlier version keeps its earlier privileges. There, run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`.

### What the controller refuses in its role

At each start, before anything listens, the controller reads every privilege held by its role: directly, through a role it inherits from, or through `PUBLIC`. It refuses to start, naming `USHER_DATABASE_URL`, when the role holds any of these:

- a role attribute beyond logging in: `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS`;
- membership in `pg_write_all_data`, `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`;
- `CREATE` on the database, or on any of its schemas;
- ownership of the controller's schema or of anything in it, or the right to grant on any of them;
- `TRUNCATE` or `TRIGGER` on any table in the schema;
- any write beyond what the migrations grant, `INSERT` included, on an append-only table: `audit_log`, `change_records`, `grant_decisions`, `key_encryption_key_check` or `notices`.

It also refuses a role allowed to write some table but not to insert into `audit_log`, since a change could then go unrecorded. A missing schema, or one unusable by the role, is refused naming `USHER_DATABASE_SCHEMA`.

**Any other grant beyond the release's is tolerated, and logged.** Examples are membership in `pg_read_all_data`, `UPDATE` on a column never updated by the release, and `EXECUTE` on another function in the schema. Once the start commits, each one is written at warning as `store.grantBeyondUse`, with its `privilege`, its `object` and, for a grant on one column, its `column`. That tolerance lets an instance of one release keep running after the next release's migration grants more.

---

## Schema migration before each rollout

**Run the image once with the arguments `dist/migrate.js`, as a one-shot job, before each rollout of the controller, and roll out only once it has succeeded.** It reads these variables. Give the controller's instances neither of the first two.

| Variable                                                                                          | What the command takes from it                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `USHER_SCHEMA_MIGRATION_DATABASE_URL`                                                             | Its connection, as the schema migration role                                                                  |
| `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD`                                                        | That role's password                                                                                          |
| `USHER_DATABASE_URL`                                                                              | The runtime role's name alone. The command never reads `USHER_DATABASE_PASSWORD`, so leave it out of the job. |
| `USHER_DATABASE_SCHEMA`                                                                           | The schema it creates and migrates                                                                            |
| `USHER_TOKEN_LIFETIME_SECONDS`, `USHER_RETENTION_GRACE_SECONDS`, `USHER_RETENTION_MARGIN_SECONDS` | The notice retention floor, their sum, which it stores                                                        |

A run goes through these steps, and every refusal comes before anything is written:

1. It connects, and gives up after 30 seconds, refusing and naming `USHER_SCHEMA_MIGRATION_DATABASE_URL`.
2. It refuses a server older than PostgreSQL 15.
3. It takes a lock held for its whole session, so two runs at once on one database apply each migration once.
4. It refuses a runtime role that does not exist or could act as the schema's owner, and a schema owned by another role.
5. It refuses a database whose record departs from this release's migrations: a migration it does not hold, one changed since it was applied, or one missing below an applied one.
6. It applies each pending migration in a transaction of its own, which records it.
7. It stores the notice retention floor, when it differs from the stored one.

| Outcome                          | What it writes                                                                                                                                            | Exit code                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Success                          | One line at info on standard output, with the message `schemaMigrations.applied`, `applied` naming each migration it applied, and `retentionFloorSeconds` | 0                                   |
| Refusal or failure               | One fatal line on standard error, as [Logs](#logs) describes                                                                                              | 1                                   |
| Stopped by `SIGTERM` or `SIGINT` | One fatal line on standard error, saying the run was stopped                                                                                              | 143 for `SIGTERM`, 130 for `SIGINT` |

- **A run on a current database applies nothing**, so `applied` is an empty list. All it may change is the retention floor. Changing any of the three durations therefore takes a run, with the new values, before the controller rolls out with them.
- **A failed migration leaves none of itself applied**, and every migration before it stays applied. Run the command again to apply the rest.
- **Connecting is bounded at 30 seconds, but statements are not**, since a migration's changes to the schema may run long. Give the job a deadline of your platform's own, such as a Kubernetes Job's `activeDeadlineSeconds`, so a run that stops making progress cannot hold a rollout indefinitely.
- **A stop rolls back the migration in flight.** The first `SIGTERM` or `SIGINT` ends the run's connection, and every migration committed before it stays applied. A second signal ends the process at once. The run's session checks every second that its client is still connected, so even a process ended outright has its session ended by the server within about a second, rolling back and releasing the lock.
- **Migrations only move forward.** Rolling back the controller's image does not roll back the schema, and rolling it back one release needs no change to the schema: the controller's start reads no record of migrations, and a release removes from the schema only what the release before it stopped reading. So the previous release's controller runs on the current schema.
- **A rollback skips the schema migration run.** The previous release's schema migration command refuses a database recording a migration it does not hold, so a rollout that always runs it first would block its own rollback.

A controller started before any migration run is refused, naming `USHER_DATABASE_SCHEMA`.

---

## The identity provider

The controller trusts one realm of one identity provider. Its requirements, in Keycloak's terms:

- **Discovery at the issuer.** The discovery document, at the issuer followed by `/.well-known/openid-configuration`, answers 200 without a redirect, since the controller follows none. It names the issuer exactly as `USHER_IDENTITY_PROVIDER_ISSUER` does, and a `jwks_uri` over https, or over http to a loopback host.
- **Tokens signed with an asymmetric algorithm**: RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384 or ES512. The controller accepts no symmetric algorithm.
- **Bearer access tokens from every client.** Every client sending tokens to an ushered application or to the Management API, the management UI among them, sends bearer access tokens, never a token bound to a key held by the client (DPoP), since the controller is handed the token alone and cannot check the client's proof of possession.
- **A subject and an audience in every access token.** Every access token sent to an ushered application is a full one carrying a subject (`sub`) and an audience (`aud`) naming the application's id as registered with Usher, added as the management UI client's audience is below, never a reduced form leaving them out (Keycloak's lightweight access token, for one), since the controller refuses a token missing either.
- **The platform administrator role.** A realm role named as in `USHER_ADMINISTRATOR_ROLE`, carried in each access token's `realm_access.roles`.
- **A client for the management UI.** Its access tokens carry the audience in `USHER_MANAGEMENT_AUDIENCE` in their `aud`, which in Keycloak takes an audience mapper. Its client id is listed in `USHER_MANAGEMENT_CLIENTS`, since the controller checks each management token's `azp` against that list. The management UI signs people in through the authorization code flow with PKCE, as a public client. Every management token carries `sub` and `exp`.
- **A client for the API documentation page**, where `USHER_API_DOCS_CLIENT` is set. It is a public client using the authorization code flow with PKCE, Keycloak's standard flow, with every other flow off. Its redirect URI is `/api-docs/oauth2-redirect.html` at the controller's origin as browsers reach it, such as `https://usher.example.org/api-docs/oauth2-redirect.html`, and that origin is one of its web origins, so the page can fetch its tokens. It carries the same audience mapper as the management UI's client, and its client id is listed in `USHER_MANAGEMENT_CLIENTS`. Its access tokens carry the role in `USHER_ADMINISTRATOR_ROLE`, which in Keycloak takes that role in the client's scope wherever its full scope is off. The identity provider's discovery document names its authorization and token endpoints at the issuer's origin, with no user name or password in them. The page's contract, at `/api-docs/openapi.json`, is answered `503` while the controller cannot read these endpoints from the discovery document.
- **Access tokens living 15 minutes or less.** The controller reads the administrator role from each token, never from a cache, so removing the role takes effect only as the tokens issued before its removal expire.

---

## Registering resources

**A resource is what a catalogue's records name in their resource field, such as a study's id, and an application reaches only the resources registered as served by it.** A platform administrator registers each through the Management API, with a management token from a client in `USHER_MANAGEMENT_CLIENTS`:

1. **Register the application** with `POST /admin/applications`, sending its `displayName`. The answer holds the application's `id`, which is also its audience, and its first key, whose `value` that answer alone shows. Give both to the application's [bridge](https://github.com/overture-stack/usher/blob/main/modules/express-bridge/README.md#usage), as its `audience` and its `key`. `POST /admin/applications/{id}/keys` issues another key.
2. **Register each resource** with `POST /admin/resources`, sending its `externalId`, its `displayName`, its `accessLevel`, and in `applications` the id of each application serving it. `accessLevel` is required: `open` for a resource whose unmarked records reach everyone, the anonymous visitor included, `registered` for one whose unmarked records reach every signed-in person, and `grant` for one reached through a grant alone. An application serving it later is added with `PUT /admin/resources/{externalId}/applications/{applicationId}`.
3. **Confirm with an anonymous exchange.** Start the application. Its bridge's start makes the anonymous visitor's exchange, which the controller logs as `bio.overture.token.exchange` with `result` `succeeded` and the application's id as `audience`, and which sets the key's `confirmedAt` in `GET /admin/applications/{id}`. `GET /admin/resources/{externalId}` names each application serving a resource in `applications`.

Where `USHER_API_DOCS_CLIENT` is set, these calls can also be made from a browser at `/api-docs`, signed in through that client.

**The externalId is the value carried by the records, matched exactly.** Each catalogue's records name their resource in the field named by its adapter as the catalogue's resource field. A terms aggregation on that field, over the catalogue's index, lists every value to register, given a size larger than the number of values. An externalId holds from 1 to 128 ASCII letters, digits, dots, underscores and hyphens, starting with a letter or a digit, and one externalId names one resource in any letter case, a retired resource included.

---

## Readiness and liveness

**Nothing listens until a start has checked the store and read the application keys**, so both probes fail to connect while an instance starts. Neither endpoint takes a credential, and neither answer carries a body.

| Endpoint            | Answers                                              | Use it for |
| ------------------- | ---------------------------------------------------- | ---------- |
| `GET /health/live`  | 200 until a log write fails, 503 from then on        | Liveness   |
| `GET /health/ready` | 200 while the instance is ready, 503 while it is not | Readiness  |

An instance is ready while all four hold, checked in this order:

1. It has started, and is not stopping.
2. Every line it has written has reached its log stream.
3. Its store answers a probe within `USHER_STORE_TIMEOUT_MILLISECONDS`.
4. Its store does not answer as read-only, for an instance with a role allowed to write.

- **The store's answer is reused for one second**, so however often readiness is asked, the store is probed at most once a second.
- **Each change of readiness is logged when readiness is next asked.** Becoming unready is `readiness.lost` at warning, with its `cause`: `stopping`, `logUnwritable`, `storeTimeout`, a SQLSTATE, `storeFailed` for a failure carrying no code, or `readOnly`. Becoming ready again is `readiness.restored` at info.
- **Once its log stream fails to take a line, an instance fails liveness as well as readiness, until it is restarted.** A restart is the only recovery, and no line can report the failure, since the stream it would go to is the one that failed. So the liveness probe is the signal: an instance restarting over and over points at its log stream.

The image holds no shell and no curl. Probe over HTTP on the port in `USHER_PORT`, or run Node itself as an exec probe, with 3000 replaced by that port:

```sh
/nodejs/bin/node --eval "fetch('http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(2000) }).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"
```

That probe reaches the instance at `127.0.0.1`, so `USHER_HOST` must accept loopback connections, as `0.0.0.0` does.

**On `SIGTERM` or `SIGINT`, an instance stops in order.** It reports itself unready, ends every notice stream, then stops accepting connections and lets requests in flight finish. It then closes its store connections and exits.

---

## Logs

**Standard output carries one JSON object per line.** Each holds a numeric `level`: 30 for info, 40 for warning and 50 for error.

- **An operational line** carries `message`, its name, such as `readiness.lost`, with its fields and `time`.
- **An event** carries a CloudEvents 1.0 envelope: `id`, `source` from `USHER_EVENT_SOURCE`, a `type` starting `bio.overture.`, `time`, `severity`, and `data` naming the actor and, as `instance`, the value of `USHER_INSTANCE_NAME`. Each event is also stored in the database's `audit_log`.

**A single `retention.sweepFailed` line, at error, means the instance's retention sweep, which each second deletes the records of exchanged sessions whose sign-in tokens have expired and the notices past the retention floor, has stopped deleting until one of its runs succeeds**: it is written once as the runs start failing, naming the `cause`, so a fault that persists, such as a missing grant, writes that one line and nothing more.

**Standard error carries a refused start, or any failure ending the process, as one line at level 60, fatal.** The process then ends with exit code 1, except for a stopped schema migration run. The line holds codes and the controller's own messages only, never a database's or a library's message, either of which could quote a value.

- **A refusal** carries `variables`, naming each variable at fault, and a `message` naming each one with the rule it broke:

  ```json
  {"level":60,"variables":["USHER_PORT"],"message":"the controller refuses to start: USHER_PORT is missing","time":"2026-11-09T15:01:18.421Z"}
  ```

- **Any other failure** carries `error`, the failure's class name, `code`, a SQLSTATE or a system error's code, or both, beside a message naming what failed.

---

## Break-glass access

**If every platform administrator is unavailable, restore one in the identity provider:** assign the realm role named in `USHER_ADMINISTRATOR_ROLE` to someone trusted at that level. The controller reads the role from each token, so the assignment applies from that person's next token.

- **Usher's audit log never records the assignment.** Only the identity provider's own record of administrative changes does, such as Keycloak's admin events, where they are enabled. A complete record of privilege changes on the platform takes both logs.
- **Anyone allowed to manage the realm's users can make a platform administrator, themselves included.** In Keycloak, `manage-users` is enough to assign any realm role outside Keycloak's own admin roles. A support role meant only to help users gets its rights through Keycloak's fine-grained admin permissions instead, so it cannot assign roles.
- **Each deployment decides who may perform this, and where its record is kept.** Write both down beside the realm's configuration, before they are needed.
