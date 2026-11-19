# Deploying the Controller

> This page is for an operator deploying the Usher Controller: the service holding a platform's access policy, called by the Bridge inside each ushered application and by the management UI. For what Usher does and why, read [Data access control](intro.md) first. To run the Controller and its services on one machine for development, see the Controller's [development notes](https://github.com/overture-stack/usher/blob/main/apps/controller/DEVELOPMENT.md).

---

## What a deployment runs

| Part                         | What it is                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Controller instances         | One or more processes from the Controller's image, sharing one store                       |
| The schema migration command | The same image, run once before each rollout to bring the store's schema up to the release |
| PostgreSQL 15 or later       | The store: the policy, the audit log, and the notices read by Bridges                      |
| An identity provider         | The realm issuing the tokens trusted by the Controller                                     |

---

## First deployment

A first deployment takes these steps, in order, each one detailed in its section:

1. Create the database and its two roles: [PostgreSQL](#postgresql), [The two database roles](#the-two-database-roles).
2. Make the two keys: [Keys](#keys).
3. Set up the realm: [The identity provider](#the-identity-provider).
4. Set the variables and write the seed file, from what steps 1 to 3 made: [Variables](#variables), [The seed file](#the-seed-file).
5. Run the image once as the schema migration command: [The image](#the-image), [Schema migration before each rollout](#schema-migration-before-each-rollout).
6. Start the Controller's instances, and wait for `GET /health/ready` to answer 200: [Readiness and liveness](#readiness-and-liveness).
7. Have the first user nominate Usher's first administrator, and the nominee accept, since every other Management API operation is refused until then: [The identity provider](#the-identity-provider).
8. Register each application and its resources, then confirm with an anonymous exchange: [Registering resources](#registering-resources).

---

## The image

One image runs both commands. Its entrypoint is `/nodejs/bin/node`, and its arguments choose the command.

| Arguments                                    | Command                      |
| -------------------------------------------- | ---------------------------- |
| None, which runs the default, `dist/main.js` | The Controller               |
| `dist/migrate.js`                            | The schema migration command |

Set the arguments alone to choose a command, and leave the entrypoint as it is.

- **Its base is distroless, running Node 26.** It holds no shell, no package manager and no curl.
- **It runs as user and group 65532**, never as root.
- **It listens on the port in `USHER_PORT`**, which has no default. The image declares no port of its own.

---

## Variables

Each command reads its configuration from environment variables once, at start, and checks every one before using any. A refusal lists every rule broken, naming each variable and never its value. The process then ends with exit code 1, before it connects to anything.

| Kind     | Meaning                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Required | It has no default, so leaving it unset is refused.                                                                 |
| Optional | It takes the default shown when unset. Set to an empty value, it is refused, unless its row says what empty means. |
| Secret   | It is required, and it holds a credential.                                                                         |

**Unless its row says otherwise, a variable takes one value on every instance sharing the store.** Two kinds of row say otherwise:

- **Per instance.** `USHER_INSTANCE_NAME` differs on every instance. `USHER_HOST` and `USHER_PORT` are each instance's own listening address.
- **Both commands, alike.** The schema migration command creates the schema in `USHER_DATABASE_SCHEMA` and grants to the runtime role named in `USHER_DATABASE_URL`. The Controller relies on that schema and role, so give both commands these values from one source.

A whole number is written in digits alone, with no sign, decimal point or unit. A comma-separated list has the whitespace around each entry left out, and an empty entry between two commas is refused.

**A replaced variable is refused.** Both commands refuse a start with a variable that a setting now holds, set, empty or not, naming `USHER_SEED_FILE` as its replacement. The settings are under [Settings](#settings).

### Listening

The Controller serves plain HTTP. Terminate TLS in front of it, and limit request rates at that same
proxy.

| Variable                | Kind           | What it is, and its rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_HOST`            | Required       | **Per instance.** The listening address, such as `0.0.0.0` for every IPv4 interface.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `USHER_PORT`            | Required       | **Per instance.** The listening port: a whole number from 0 to 65535, where 0 asks for any free port.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `USHER_TRUSTED_PROXIES` | Optional: none | The proxies trusted to report a client's address in `X-Forwarded-For`, as a comma-separated list of IP addresses and CIDR ranges of either IP version, such as `192.0.2.10, 198.51.100.0/24`. An empty value is none. A request's address is the nearest address in the chain not added by a trusted proxy. A range holding every address of an IP version is refused, since it would let any client name its own address: prefix length 0, or an IPv6 range holding every IPv4 address in its IPv6 form, such as `::ffff:0:0/96`. |

### This instance and its events

| Variable              | Kind     | What it is, and its rule                                                                                                                                                  |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_INSTANCE_NAME` | Required | **Per instance.** This instance's name, carried as `data.instance` by every event it records. Give each instance sharing the store its own, such as its host or pod name. |

### The database

| Variable                                     | Kind            | What it is, and its rule                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USHER_DATABASE_URL`                         | Required        | **Both commands, alike.** A `postgres:` or `postgresql:` URL connecting as the runtime role, at the address accepting writes. It must name that role, in its user information or as a `user` parameter. It never carries a password, in either place. Unless it reaches a loopback host or a Unix socket, it must verify the server, as [Verified connections](#verified-connections) says. The schema migration command reads the role's name from it and nothing else. |
| `USHER_DATABASE_PASSWORD`                    | Secret          | The runtime role's password. The Controller alone reads it.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `USHER_DATABASE_SCHEMA`                      | Required        | **Both commands, alike.** The schema holding the Controller's tables.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION` | Optional: false | **Both commands, alike.** `true` or `false`: whether a database connection that leaves the host without verifying the server it reaches is allowed. Left `false`, such a connection is refused, as [Verified connections](#verified-connections) says. Set `true`, every start of either command writes `store.unverifiedConnectionAllowed` at warning, naming this variable.                                                                                            |
| `USHER_DATABASE_EXCHANGE_CONNECTIONS`        | Optional: 10    | The store connections each instance holds for token exchanges: their own transactions, the confirmation of each application key's first exchange, and the recording of refused channel assertions. Each application's share of an instance's exchanges divides them. A whole number of at least 1.                                                                                                                                                                       |
| `USHER_DATABASE_CONTROL_CONNECTIONS`         | Optional: 5     | The store connections each instance holds for everything but token exchanges and readiness: the Management API, the back-channel logout, the notice channel, key reloads, the counts of refusals it records, and the start. A whole number of at least 1.                                                                                                                                                                                                                |
| `USHER_STORE_TIMEOUT_MILLISECONDS`           | Optional: 5000  | How long the Controller waits on the store for one unit of work, such as a request's statement or transaction, a start, or a readiness probe, before giving up on it. The server also applies it to each of the Controller's sessions, as its statement and idle-in-transaction limits. A whole number from 1 to 2147483647.                                                                                                                                             |

### The schema migration command's own

The Controller never reads these two, so give them to the schema migration command alone.

| Variable                                   | Kind     | What it is, and its rule                                                                                                                              |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_SCHEMA_MIGRATION_DATABASE_URL`      | Required | A `postgres:` or `postgresql:` URL connecting as the schema migration role, at the address accepting writes, under the rules of `USHER_DATABASE_URL`. |
| `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD` | Secret   | The schema migration role's password.                                                                                                                 |

### The keys

| Variable                   | Kind   | What it is, and its rule                                                            |
| -------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `USHER_KEY_ENCRYPTION_KEY` | Secret | The key-encryption key, encrypting every stored application key. See [Keys](#keys). |
| `USHER_CURSOR_KEY`         | Secret | The key encrypting every notice stream cursor. See [Keys](#keys).                   |

### The identity provider's configuration

| Variable                              | Kind                              | What it is, and its rule                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_IDENTITY_PROVIDER_ISSUER`      | Required                          | The realm's issuer, exactly as its tokens carry it in `iss`, such as `https://idp.example.org/realms/platform`. It is an https URL, or an http URL to a loopback host alone (`localhost`, `127.0.0.1` or `[::1]`), and it never carries a password.                 |
| `USHER_SERVICE_ACCOUNT_ROLE`          | Optional: `usher-service-account` | The realm role marking a service account's token, which is refused on every Management API operation, whether or not it also carries the first user's role. It must name a role other than the `realmRole` of the `firstUser` setting, when that setting names one. |
| `USHER_MANAGEMENT_AUDIENCE`           | Required                          | The audience required in every management token's `aud`: the Management API's identifier at the identity provider, such as `usher-management`.                                                                                                                      |
| `USHER_MANAGEMENT_CLIENTS`            | Required                          | The client identifiers the management UI signs in through, as a comma-separated list. A management token's `azp` must be one of them. An empty value is an empty list, accepting no management token.                                                               |
| `USHER_API_DOCS_CLIENT`               | Optional: none                    | The client used by the API documentation page at `/api-docs` to sign people in, which must be one of `USHER_MANAGEMENT_CLIENTS` exactly. Unset or empty means no page. Its requirements are under [The identity provider](#the-identity-provider).                  |
| `USHER_BACK_CHANNEL_LOGOUT_AUDIENCES` | Required                          | The audiences allowed in a back-channel logout token's `aud`, as a comma-separated list: the platform's client identifiers. An empty value is an empty list.                                                                                                        |

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

- **The key-encryption key encrypts every stored application key.** The store's first start records a fingerprint derived from it, and a later start under any other key is refused. Every instance uses the same key, and without it no stored application key can be read.
- **The cursor key encrypts the cursors handed to Bridges reading the notice stream.** Every instance uses the same key, since any instance may answer a Bridge's next poll.

---

## The seed file

The seed file is a JSON object that seeds an instance's settings into a store holding none. It holds no secrets: a credential stays in the Controller's environment, as [Variables](#variables) describes.

The schema migration command reads it on every run, from the path in `USHER_SEED_FILE`. The default path is `./seed.json`, relative to the command's working directory, which is `/app/seed.json` in the image. Mount the file at that path, or set the variable to the path where it is.

On a later run, a file that cannot be read warns with the system's reason for the failure, and a file that is not one JSON object warns with the problem its text breaks; neither warning shows the file's content, and the run succeeds without changing the stored settings. On a first run, a file that cannot be read refuses the run, as a missing one does.

| Member                         | Required                                          | What it gives                                                                                                                                 |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                       | Yes, on a first run                               | Usher's own issuer: the `iss` of every Usher token                                                                                            |
| `eventSource`                  | Yes, on a first run                               | The CloudEvents `source` carried by every event, naming the deployment, such as `https://usher.example.org/controller`                        |
| `firstUser`                    | No, default `{ "realmRole": "usher-first-user" }` | Exactly one of `realmRole`, a realm role's name, or `subject`, a person's `sub` at the identity provider. Naming both, or neither, is refused |
| Any other [setting](#settings) | No                                                | A first value for that setting. Omitted, it takes its default                                                                                 |

`issuer`, `eventSource` and `firstUser` are fixed after the first run, whatever the file later says.

An example for an install that relays sign-outs:

```json
{
  "backChannelLogout": true,
  "eventSource": "https://usher.example.org/controller",
  "firstUser": {
    "realmRole": "usher-first-user"
  },
  "issuer": "https://usher.example.org"
}
```

An install that cannot relay sign-outs writes `"backChannelLogout": false` in place of `true`, as [Sign-outs](#sign-outs) describes.

**The first run** validates the whole file, seeds every setting with the file's value where it gives one and the default otherwise, and records one `settings.seeding` event as the system, naming every seeded setting, `firstUser` included. It writes `settings.seedFileRead` at info, with the path. A first run with no file at the path is refused, naming `USHER_SEED_FILE`, after it writes `settings.seedFileMissing` at error, with the path and the variable. A file lacking `issuer` or `eventSource`, or breaking any other rule, is refused, naming `USHER_SEED_FILE`.

**A later run** that finds settings in the store compares the file with the members the first run seeded, and changes nothing. It writes `settings.seedFileUnchanged` at info when they match. When they differ, it writes `settings.seedFileChanged` at warning, naming each top-level key the file added, changed or removed, and never a value. A later run with no file at the path writes nothing about it.

**Editing the file after the first run changes no setting.** Changes go through the Controller, as [Changing a setting](#changing-a-setting) describes. A wrong `firstUser` on a fresh install is fixed by rebuilding that install, since only the first run seeds it.

---

## Settings

Usher's own values are settings: the grant rules, the token and retention durations, the notice channel's limits, and whether sign-outs are relayed. Each instance keeps its settings in its store, each with a default, and reads them from there, so every instance acts on the same values. The seed file may give a first value for any of them. A value from elsewhere, such as a secret or the identity provider's identifiers, is configuration in the environment, as [Variables](#variables) describes.

The Controller reads every setting from the store at its start, and refuses to start when one is missing or invalid, naming the setting and its rule, never its value.

| Setting                             | Default                               | What it is, and its rule                                                                                                              |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `grantRules`                        | see [Grant rules](#grant-rules)       | The record actions conferred on everyone, and on every signed-in principal, by access level                                           |
| `signInTokenMaximumLifetimeSeconds` | 300                                   | The longest lifetime of a sign-in or management token accepted, in seconds: a whole number of at least 1                              |
| `tokenLifetimeSeconds`              | 300                                   | How long an Usher token lives, in seconds: a whole number of at least 1                                                               |
| `retentionGraceSeconds`             | 60                                    | The grace period counted by the notice retention floor beyond the token lifetime, in seconds: a whole number of at least 0            |
| `retentionMarginSeconds`            | 30                                    | The margin the notice retention floor adds beyond the token lifetime and the grace period, in seconds: a whole number of at least 0   |
| `heartbeatMilliseconds`             | 10000                                 | How long an open notice stream may stay silent before a heartbeat: a whole number from 1 to 2147483647                                |
| `noticePageLimit`                   | 500                                   | The most notices carried by one poll answer before it names a next page: a whole number of at least 1                                 |
| `noticeRereadMilliseconds`          | 2000                                  | How often each instance reads the notice stream and the settings again when nothing has woken it: a whole number from 1 to 2147483647 |
| `streamLimitPerAudience`            | 64                                    | How many push streams one audience may hold open on one instance: a whole number of at least 1                                        |
| `streamMaximumLifetimeSeconds`      | 900                                   | How long a notice stream stays open at most, in seconds: a whole number of at least 60                                                |
| `streamQueueLimit`                  | 1000                                  | The most notices queued for one stream before the stream is closed for a reader that stopped reading: a whole number of at least 1    |
| `grantAutoAccept`                   | `false`                               | Whether a grant is accepted as it is created, its holder's acceptance recorded with it: `true` or `false`                             |
| `submitterCategory`                 | `global.unmarked`                     | The record category a `submitter` grant naming none takes: `global.` followed by the name of a global category, which holds no dot    |
| `backChannelLogout`                 | `true`                                | Whether sign-outs are relayed, as [Sign-outs](#sign-outs) describes                                                                   |
| `issuer`                            | none                                  | Usher's own issuer, from the seed file. Fixed after the first run                                                                     |
| `eventSource`                       | none                                  | The CloudEvents `source` of every event, from the seed file. Fixed after the first run                                                |
| `firstUser`                         | `{ "realmRole": "usher-first-user" }` | The first user, from the seed file. Fixed after the first run                                                                         |

### Changing a setting

- `PATCH /admin/settings` takes any subset of the changeable settings, validates them together, and applies them in one transaction, all or nothing. It refuses an unknown name, a fixed setting, and `grantRules`. Each change is recorded as one `settings.change`, its admin as the actor, carrying each `name`, `value` and `previousValue`. Its severity is `critical` when a change names `grantAutoAccept`, `submitterCategory`, `backChannelLogout`, `signInTokenMaximumLifetimeSeconds`, `tokenLifetimeSeconds`, `retentionGraceSeconds` or `retentionMarginSeconds`, and `warning` otherwise.
- It refuses a `signInTokenMaximumLifetimeSeconds` that the calling admin's own token would fail under, since that would lock the admin out. It refuses `backChannelLogout: true` while `USHER_BACK_CHANNEL_LOGOUT_AUDIENCES` is empty.
- `GET /admin/settings` reads every setting, the fixed ones included. `GET /admin/settings/grant-rules` reads the grant rules, and `PUT /admin/settings/grant-rules` replaces the whole list. A replacement is recorded as `grantRules.change` at `critical`, carrying `grantRules` and `previousGrantRules`, and sends the baseline notice to every Bridge.
- Only platform administrators may call these, as with the rest of the Management API.
- A change reaches every instance within one `noticeRereadMilliseconds`. The grant rules are read by each exchange, so they apply to the next exchange on every instance.
- A lowered retention setting takes effect at once. A Bridge whose cursor is trimmed past the new floor is answered `410` and resets, so no notice is missed.

### Grant rules

The grant rules are a list of entries. Each names who it is for and what it reaches:

- `to`: `everyone`, which includes the anonymous visitor, or `signedIn`.
- `resources`: a list of items, each with an `accessLevel`, `open` or `registered`, and its `categories`.
- `categories`: a list of items, each with a `name`, which is `global.unmarked` for now, and `actions`, a list drawn from `count`, `view` and `export`.

A grant rule grants its actions on the unmarked records of each resource at its access level, as a grant does. Every plural key holds a list, even one with a single entry or none. A duplicate entry, an unknown key, and a single value where a list belongs are refused.

The default: everyone counts, views and exports open resources, and every signed-in principal does the same on open and registered ones.

The API validates a change before it is stored, so only a row edited outside the API can break the rules, as the next section describes.

### A stored setting that breaks its rule

A row edited outside the API can break its rule. Each instance then keeps the last valid value of that setting, and writes `settings.storedInvalid` at error on each reread while the row stays invalid. The line names the setting and its rule, never its value. Readiness stays ready.

Grant rules are the exception. An invalid stored grant rule makes readiness unready with the cause `storedSettingsInvalid`, and each exchange is answered `503` with the problem code `storedSettingsInvalid`, issuing nothing. A start refuses an invalid or missing row. A failed read of the settings is written as `settings.readFailed` at error, by its failure's code.

To recover, correct the row to a value its rule accepts. The next reread takes it, and for the grant rules the next exchange does, and the lines stop.

### Sign-outs

`backChannelLogout` is `true` by default, so sign-outs are relayed: the identity provider posts each logout token to the Controller, and the audiences the Controller accepts in it are those in `USHER_BACK_CHANNEL_LOGOUT_AUDIENCES`, the platform's client identifiers. With relaying on and that list empty, the Controller refuses to start, naming the setting and the variable.

An install that cannot relay sets `false`. Each start then writes a warning, and the back-channel logout route refuses every logout token before verifying it, with the reason `backChannelLogoutOff`, answered `400` `logoutTokenRefused` and recorded as `logoutToken.refusal`. The audience list is then ignored.

---

## PostgreSQL

- **PostgreSQL 15 or later.** Its schema needs 15, and the Controller is tested against 15 and 18. The schema migration command refuses an older server before writing anything, naming `USHER_SCHEMA_MIGRATION_DATABASE_URL`.
- **The address accepting writes.** Point both database URLs at the primary, never at a read replica or a standby. An instance with a role allowed to write reports itself unready, with the cause `readOnly`, while its store answers as read-only.

### Connections and poolers

1. The Controller sends `statement_timeout` and `idle_in_transaction_session_timeout` as startup parameters on every connection, each set to `USHER_STORE_TIMEOUT_MILLISECONDS`.
2. Those limits are what end a statement or transaction the Controller has given up on, since the server goes on running it after its client has gone.
3. At each start, the Controller reads both limits back from the server, on a connection of each of its pools. It refuses to start, naming `USHER_DATABASE_URL`, when either is missing or differs.
4. So connect directly, or through a pooler only where each of the Controller's connections keeps one server session carrying both limits. A pooler in transaction mode hands each transaction whichever server session is free, and a pooler that refuses or drops startup parameters it does not track, in any mode, fails the check at start.

The schema migration command holds a session-level lock for its whole run, so it too needs one server session throughout: connect it directly, or through a pooler in session mode.

**Each instance holds at most as many connections as `USHER_DATABASE_EXCHANGE_CONNECTIONS` plus `USHER_DATABASE_CONTROL_CONNECTIONS` plus one**, the last for its readiness probe alone: 16 at the defaults. The connections the database must take at once are:

- that sum, times the most instances that can run at once: the replicas, plus those a rolling update starts before it stops old ones (its surge);
- plus the schema migration command's own connection while it runs.

Keep that total at most the database's `max_connections`, less the connections it keeps reserved and those its other clients hold. Through a pooler, each instance's sum counts against the pooler's limit on client connections, and the pooler's own connections to the database count against `max_connections`.

For example, 3 replicas with a surge of 1, at the defaults, hold at most 4 × 16 = 64 connections, and a schema migration run adds 1, for 65. A database whose `max_connections` is 100, with 3 reserved and 10 held by other clients, leaves 87, so it takes them.

### Verified connections

**A database connection that leaves the host verifies the server it reaches, or the command refuses to start.** Each command judges its own URL, `USHER_DATABASE_URL` for the Controller and `USHER_SCHEMA_MIGRATION_DATABASE_URL` for the schema migration command, as the driver will connect with it:

- **A loopback host or a Unix socket is exempt.** `127.0.0.1`, `::1` and `localhost` are loopback hosts, and a host written as an absolute path, such as `/var/run/postgresql`, is a Unix socket. The host judged is the one the driver connects to: a `host` parameter takes the place of the URL's hostname, so a loopback hostname beside a `host` parameter naming another host is judged as that other host.
- **Any other host needs `sslmode=verify-full`, or `sslmode=verify-ca` with `sslrootcert`.** `verify-full` checks that the server's certificate chains to a trusted CA and names the host connected to. `verify-ca` is taken only beside a CA file of the deployment's own. This driver treats `sslmode=verify-ca` as `verify-full` unless the URL sets `uselibpqcompat=true`, so `verify-ca` checks the certificate chain alone only with that setting. `sslrootcert` names that file, holding one or more CA certificates. Without it, `verify-full` trusts the public CA certificates Node.js holds.
- **Every other `sslmode` is refused, `require` included.** The driver treats `require` as `verify-full` only while the URL leaves `uselibpqcompat` unset, and as encryption with no verification once it is set, so `require` is refused as written, as are `prefer`, `allow`, `disable`, `no-verify` and a URL naming no `sslmode`.
- **A CA file in `sslrootcert` that cannot be read refuses the start**, wherever the URL connects.

Each refusal names the variable and the rule broken, never the URL.

**The Controller reads the CA file again as each new connection opens**, so a CA certificate reissued, or a second CA added to the file beside the first, is taken by the next connection with no restart. A connection already open is unaffected. A change to the file is written once, as `store.caFileChanged` at warning. While the file cannot be read, the Controller trusts no CA at all, so every new connection fails, and it writes `store.caFileUnreadable` at error, naming the failure's code, once each time the file becomes unreadable. Neither line names the file or its contents. The schema migration command runs once per rollout, so it reads its CA file once, at its start.

**`USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION` set to `true` lifts the requirement** for whichever command reads it, and every start of that command then writes `store.unverifiedConnectionAllowed` at warning, naming the variable. It suits a connection crossing no network but one machine's own, such as a local development stack, where the database serves no TLS.

### The two database roles

| Role                  | Holds                                                                   | Used by                            | Its password                                                            |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Schema migration role | Ownership of the database, the Controller's schema and everything in it | The schema migration command alone | `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD`, given to that command alone |
| Runtime role          | What the migrations and the schema migration command grant it           | Every Controller instance          | `USHER_DATABASE_PASSWORD`                                               |

**The runtime role is a separate login role: neither the schema migration role, nor a member of it, nor a superuser.** The schema migration command refuses a runtime role breaking that rule, or one not yet created, before writing anything. The split is what protects the store from a compromised Controller: it can read and write policy, which it must, but it cannot widen its own privileges or drop the audit log.

Create both roles and the database once, before the first run, as a role allowed to create roles and databases. The names here are examples:

```sql
CREATE ROLE usher_migration LOGIN;
CREATE ROLE usher_controller LOGIN;
CREATE DATABASE usher OWNER usher_migration;
```

Then set each password from psql, with `\password usher_migration` and `\password usher_controller`. The `\password` command hashes the password before sending it, so the server never receives it in plain text. The two URLs then name each role and the database:

```sh
USHER_SCHEMA_MIGRATION_DATABASE_URL=postgres://usher_migration@db.example.org:5432/usher?sslmode=verify-full
USHER_DATABASE_URL=postgres://usher_controller@db.example.org:5432/usher?sslmode=verify-full
```

- **The schema migration command creates the schema** in `USHER_DATABASE_SCHEMA` on its first run. A schema created beforehand must be owned by the schema migration role, or the command refuses it.
- **The runtime role connects through the `CONNECT` privilege**, which every role holds on a database by default. The migrations grant nothing on the database itself, so where that default has been revoked, grant `CONNECT` on the database to the runtime role.
- **The runtime role may not create in any schema, `public` included.** PostgreSQL 15 and later give `PUBLIC` no `CREATE` on the `public` schema, but a database upgraded from an earlier version keeps its earlier privileges. There, run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`.

### What the Controller refuses in its role

At each start, before anything listens, the Controller reads every privilege held by its role: directly, through a role it inherits from, or through `PUBLIC`. It refuses to start, naming `USHER_DATABASE_URL`, when the role holds any of these:

- a role attribute beyond logging in: `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS`;
- membership in `pg_write_all_data`, `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files`;
- `CREATE` on the database, or on any of its schemas;
- ownership of the Controller's schema or of anything in it, or the right to grant on any of them;
- `TRUNCATE` or `TRIGGER` on any table in the schema;
- any write beyond what the migrations grant, `INSERT` included, on an append-only table: `audit_log`, `change_records`, `grant_decisions`, `key_fingerprints`, `nominations` or `notices`.

It also refuses a role allowed to write some table but not to insert into `audit_log`, since a change could then go unrecorded. A missing schema, or one unusable by the role, is refused naming `USHER_DATABASE_SCHEMA`. So is a schema holding no record of applied migrations, `schema_migrations`, or one whose record the role may not read: run the schema migration command, which creates the record and grants the runtime role reading it.

**Any other grant beyond the release's is tolerated, and logged.** Examples are membership in `pg_read_all_data`, `UPDATE` on a column never updated by the release, and `EXECUTE` on another function in the schema. Once the start commits, each one is written at warning as `store.grantBeyondUse`, with its `privilege`, its `object` and, for a grant on one column, its `column`. That tolerance lets an instance of one release keep running after the next release's migration grants more.

---

## Schema migration before each rollout

**Run the image once with the arguments `dist/migrate.js`, as a one-shot job, before each rollout of the Controller, and roll out only once it has succeeded.** It reads these variables. Give the Controller's instances neither of the first two.

| Variable                                     | What the command takes from it                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USHER_SCHEMA_MIGRATION_DATABASE_URL`        | Its connection, as the schema migration role                                                                                                                  |
| `USHER_SCHEMA_MIGRATION_DATABASE_PASSWORD`   | That role's password                                                                                                                                          |
| `USHER_DATABASE_URL`                         | The runtime role's name alone. The command never reads `USHER_DATABASE_PASSWORD`, so leave it out of the job.                                                 |
| `USHER_DATABASE_SCHEMA`                      | The schema it creates and migrates                                                                                                                            |
| `USHER_DATABASE_ALLOW_UNVERIFIED_CONNECTION` | Whether its own connection may leave the host without verifying the server, as for the Controller                                                             |
| `USHER_SEED_FILE`                            | The seed file's path, read on every run: seeding the settings on a first run, comparing the file on a later one, as [The seed file](#the-seed-file) describes |

A run goes through these steps, and every refusal comes before anything is written:

1. It connects, and gives up after 30 seconds, refusing and naming `USHER_SCHEMA_MIGRATION_DATABASE_URL`.
2. It refuses a server older than PostgreSQL 15.
3. It takes a lock held for its whole session, so two runs at once on one database apply each migration once.
4. It refuses a runtime role that does not exist or could act as the schema's owner, and a schema owned by another role.
5. It refuses a database whose record departs from this release's migrations: a migration it does not hold, one changed since it was applied, or one missing below an applied one.
6. It creates the record of applied migrations, `schema_migrations`, when the schema has none, and grants the runtime role reading it.
7. It applies each pending migration in a transaction of its own, which records it.
8. On a first run, it seeds the settings from the seed file; on a later run, it compares the file and changes nothing, as [The seed file](#the-seed-file) and [Settings](#settings) describe.

| Outcome                          | What it writes                                                                                                                                                                                        | Exit code                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Success                          | One line at info on standard output, with the message `schemaMigrations.applied`, `applied` naming each migration it applied, and `settingsSeeded`, which is true on the run that seeded the settings | 0                                   |
| Refusal or failure               | One fatal line on standard error, as [Logs](#logs) describes                                                                                                                                          | 1                                   |
| Stopped by `SIGTERM` or `SIGINT` | One fatal line on standard error, saying the run was stopped                                                                                                                                          | 143 for `SIGTERM`, 130 for `SIGINT` |

**To check a run and the rollout after it:**

1. The run exits 0 and writes one `schemaMigrations.applied` line, whose `applied` lists the release's migrations the database did not yet hold, or nothing on a database already current.
2. After the rollout, the Controller reports itself ready, which confirms its database records no migration this release does not know.
3. A Controller that does not become ready says why in its `schema.migrationUnknown` line or its readiness cause, as [Readiness and liveness](#readiness-and-liveness) describes.

- **A run on a current database applies nothing**, so `applied` is an empty list. It may change only the runtime role's reading of `schema_migrations` where that was revoked. Settings change through the Controller, so no run is needed to change one.
- **A failed migration leaves none of itself applied**, and every migration before it stays applied. Run the command again to apply the rest.
- **Connecting is bounded at 30 seconds, but statements are not**, since a migration's changes to the schema may run long. Give the job a deadline of your platform's own, such as a Kubernetes Job's `activeDeadlineSeconds`, so a run that stops making progress cannot hold a rollout indefinitely.
- **A stop rolls back the migration in flight.** The first `SIGTERM` or `SIGINT` ends the run's connection, and every migration committed before it stays applied. A second signal ends the process at once. The run's session checks every second that its client is still connected, so even a process ended outright has its session ended by the server within about a second, rolling back and releasing the lock.
- **Migrations only move forward.** Rolling back the Controller's image does not roll back the schema. A later release may record restrictions, such as sign-outs or suspensions, in tables an earlier release never reads, so an earlier release cannot vouch for a database a later release has migrated.
- **A rollback runs only to a release that knows every applied migration.** The Controller refuses to start, and reports itself unready, while its database records a migration its release does not know, including one changed since it was applied. A release refused this way is fixed forward: deploy a release that knows every applied migration. A rollback to a release holding the same migrations is unaffected, and its schema migration run applies nothing.
- **A rollout applying a migration takes the previous release's instances out of rotation.** Once the schema migration run applies a migration, each instance of the previous release reports itself unready, with the cause `migrationUnknown`, until it is replaced, so no instance is ready from then until the new release's first one is. A rollout applying no migration leaves them ready.

A Controller started before any migration run is refused, naming `USHER_DATABASE_SCHEMA`. So is a Controller whose database records a migration its release does not know: the refusal names each such migration, and says of each the release holds that its checksum differs, but never shows a checksum. Before it is refused, the start writes those migrations as `schema.migrationUnknown` at error, with `refused` set to `start`, as [Readiness and liveness](#readiness-and-liveness) describes.

---

## The identity provider

The Controller trusts one realm of one identity provider. Its requirements, in Keycloak's terms:

- **Discovery at the issuer.** The discovery document, at the issuer followed by `/.well-known/openid-configuration`, answers 200 without a redirect, since the Controller follows none. It names the issuer exactly as `USHER_IDENTITY_PROVIDER_ISSUER` does, and a `jwks_uri` over https, or over http to a loopback host.
- **Tokens signed with an asymmetric algorithm**: RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384 or ES512. The Controller accepts no symmetric algorithm.
- **Bearer access tokens from every client.** Every client sending tokens to an ushered application or to the Management API, the management UI among them, sends bearer access tokens, never a token bound to a key held by the client (DPoP), since the Controller is handed the token alone and cannot check the client's proof of possession.
- **A subject, an audience and an issue time in every access token.** Every access token sent to an ushered application is a full one carrying a subject (`sub`), an audience (`aud`) naming the application's id as registered with Usher, added as the management UI client's audience is below, and the time it was issued (`iat`), never a reduced form leaving them out (Keycloak's lightweight access token, for one), since the Controller refuses a token missing any of them.
- **Access tokens living no longer than the `signInTokenMaximumLifetimeSeconds` setting.** For every client sending tokens to an ushered application or to the Management API, the access token lifespan, the realm's or the client's own where it sets one, is at most that many seconds, since the Controller refuses a token living longer.
- **The first user.** The `firstUser` setting names either a realm role, carried in each access token's `realm_access.roles` and held by whoever nominates Usher's first administrator, or a person by `subject`, the `sub` claim at the identity provider, who needs no role. Usher keeps its own list of administrators and reads it on every Management API request, so no realm role makes an administrator. Until an administrator has accepted, the Controller refuses every Management API operation with `403` `noAdministratorYet`, but for the first user nominating an administrator through `POST /admin/nominations`, the nominee accepting through `POST /admin/nominations/{id}/acceptance`, and a nominee listing their nominations through `GET /admin/me/nominations`; the health routes and the token exchange answer as usual. The nominee is the first user themself, or a person who has signed in through the realm and reached Usher before. The first user may nominate again while no administrator has accepted, and only the latest nomination may be accepted. Once an administrator has accepted, the first user confers nothing, whoever it is. Until then, where the first user is a realm role, whoever may assign the realm's roles can give it to anyone, themselves included, and so nominate; in Keycloak, `manage-users` is enough. Give the role to one person, or name one person's subject, and have the first administrator accept soon after the Controller first starts.
- **A client for the management UI.** Its access tokens carry the audience in `USHER_MANAGEMENT_AUDIENCE` in their `aud`, which in Keycloak takes an audience mapper. Its client id is listed in `USHER_MANAGEMENT_CLIENTS`, since the Controller checks each management token's `azp` against that list. The management UI signs people in through the authorization code flow with PKCE, as a public client. Every management token carries `sub`, `exp` and `iat`.
- **A client for the API documentation page**, where `USHER_API_DOCS_CLIENT` is set. It is a public client using the authorization code flow with PKCE, Keycloak's standard flow, with every other flow off. Its redirect URI is `/api-docs/oauth2-redirect.html` at the Controller's origin as browsers reach it, such as `https://usher.example.org/api-docs/oauth2-redirect.html`, and that origin is one of its web origins, so the page can fetch its tokens. It carries the same audience mapper as the management UI's client, and its client id is listed in `USHER_MANAGEMENT_CLIENTS`. Its access tokens carry the realm role the `firstUser` setting names, where it names one, so the first user can nominate through the page, which in Keycloak takes that role in the client's scope wherever its full scope is off. The identity provider's discovery document names its authorization and token endpoints at the issuer's origin, with no user name or password in them. The page's contract, at `/api-docs/openapi.json`, is answered `503` while the Controller cannot read these endpoints from the discovery document.
- **Access tokens living 15 minutes or less.** The Controller reads the first-user role from each token, never from a cache, so removing the role takes effect only as the tokens issued before its removal expire.

**The store records the identity provider's identifiers.** The Controller reads six identifiers from its environment: the identity provider's issuer, the management audience and clients, the client of the API documentation page, the service account role and the logout audiences. At each start it compares them with the stored ones. Where any differ, the start records an `identityProvider.configurationChange` naming what changed, at `critical` when the issuer, the management audience, the management clients or the service account role changed and at `warning` otherwise, and then stores the new values. A first recording fills the record with no event. The record says what changed and when, and never who: the start acts as the system. A rolling deploy whose instances read different values records the changes back and forth, one for each start that finds a difference.

---

## Registering resources

**A resource is what a catalogue's records name in their resource field, such as a study's id, and an application reaches only the resources registered as served by it.** A platform administrator registers each through the Management API, with a management token from a client in `USHER_MANAGEMENT_CLIENTS`:

1. **Register the application** with `POST /admin/applications`, sending its `displayName`. The answer holds the application's `id`, which is also its audience, and its first key, whose `value` that answer alone shows. Give both to the application's [Bridge](https://github.com/overture-stack/usher/blob/main/modules/express-bridge/README.md#usage), as its `audience` and its `key`. `POST /admin/applications/{id}/keys` issues another key.
2. **Register each resource** with `POST /admin/resources`, sending its `externalId`, its `displayName`, its `accessLevel`, and in `applications` the id of each application serving it. `accessLevel` is required: `open` for a resource whose unmarked records reach everyone, the anonymous visitor included, `registered` for one whose unmarked records reach every signed-in person, and `grant` for one reached through a grant alone. An application serving it later is added with `PUT /admin/resources/{externalId}/applications/{applicationId}`.
3. **Confirm with an anonymous exchange.** Start the application. Its Bridge's start makes the anonymous visitor's exchange, which the Controller logs as `bio.overture.token.exchange` with `result` `succeeded` and the application's id as `audience`, and which sets the key's `confirmedAt` in `GET /admin/applications/{id}`. `GET /admin/resources/{externalId}` names each application serving a resource in `applications`.

Where `USHER_API_DOCS_CLIENT` is set, these calls can also be made from a browser at `/api-docs`, signed in through that client.

**The externalId is the value carried by the records, matched exactly.** Each catalogue's records name their resource in the field named by its adapter as the catalogue's resource field. A terms aggregation on that field, over the catalogue's index, lists every value to register, given a size larger than the number of values. An externalId holds from 1 to 128 ASCII letters, digits, dots, underscores and hyphens, starting with a letter or a digit, and one externalId names one resource in any letter case, a retired resource included.

---

## Readiness and liveness

**Nothing listens until a start has checked the store and read the application keys**, so both probes fail to connect while an instance starts. Neither endpoint takes a credential, and neither answer carries a body.

| Endpoint            | Answers                                              | Use it for |
| ------------------- | ---------------------------------------------------- | ---------- |
| `GET /health/live`  | 200 until a log write fails, 503 from then on        | Liveness   |
| `GET /health/ready` | 200 while the instance is ready, 503 while it is not | Readiness  |

An instance is ready while all six hold, checked in this order:

1. It has started, and is not stopping.
2. Every line it has written has reached its log stream.
3. Its store answers a probe within `USHER_STORE_TIMEOUT_MILLISECONDS`.
4. Its store records no migration this release does not know, in a record its role may read.
5. Its store holds valid grant rules, as [Settings](#settings) describes.
6. Its store does not answer as read-only, for an instance with a role allowed to write.

- **The store's answer is reused for one second**, so however often readiness is asked, the store is probed at most once a second.
- **Each change of readiness is logged when readiness is next asked.** Becoming unready is `readiness.lost` at warning, with its `cause`: `stopping`, `logUnwritable`, `storeTimeout`, a SQLSTATE, `storeFailed` for a failure carrying no code, `migrationRecordUnreadable`, `migrationUnknown`, `storedSettingsInvalid`, or `readOnly`. Becoming ready again is `readiness.restored` at info.
- **With the cause `migrationRecordUnreadable`, the schema holds no record of applied migrations, or the role may not read it.** Run the schema migration command, which creates the record and grants the runtime role reading it.
- **With the cause `migrationUnknown`, the store records a migration this release does not know**, including one changed since it was applied. The instance writes `schema.migrationUnknown` at error once each time it becomes unready for this cause, however often readiness is asked. Its `migrations` names each such migration by its `name`, with `checksumDiffers` set to `true` for one the release holds under that name with another checksum, and its `refused` is `readiness`. A refused start writes the same line with `refused` set to `start`. A recorded name not in migration form, four digits then lower-case words joined by underscores, is written as `a name not in migration form`. The cure is to deploy a release that knows every applied migration, as [Schema migration before each rollout](#schema-migration-before-each-rollout) describes.
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
- **An event** carries a CloudEvents 1.0 envelope: `id`, `source` from the `eventSource` setting, a `type` starting `bio.overture.`, `time`, `severity`, and `data` naming the actor and, as `instance`, the value of `USHER_INSTANCE_NAME`. Each event is also stored in the database's `audit_log`.

**A single `retention.sweepFailed` line, at error, means the instance's retention sweep, which each second deletes the records of exchanged sessions whose sign-in tokens have expired, the sign-out records more than the Controller's clock tolerance of 30 seconds past their expiry, and the notices past the retention floor, has stopped deleting until one of its runs succeeds**: it is written once as the runs start failing, naming the `cause`, so a fault that persists, such as a missing grant, writes that one line and nothing more.

**Standard error carries a refused start, or any failure ending the process, as one line at level 60, fatal.** The process then ends with exit code 1, except for a stopped schema migration run. The line holds codes and the Controller's own messages only, never a database's or a library's message, either of which could quote a value.

- **A refusal** carries `variables`, naming each variable at fault, and a `message` naming each one with the rule it broke:

    ```json
    {"level":60,"variables":["USHER_PORT"],"message":"the controller refuses to start: USHER_PORT is missing","time":"2026-11-09T15:01:18.421Z"}
    ```

- **Any other failure** carries `error`, the failure's class name, `code`, a SQLSTATE or a system error's code, or both, beside a message naming what failed.

---

## Break-glass access

**This release has no procedure for recovering when no platform administrator can sign in.** Usher's administrators are those its own store holds, read on every Management API request, and an administrator is made only by accepting a nomination.

- **No identity provider role restores an administrator.** The first user confers nothing once an administrator has accepted, whoever it is, and no other realm role makes one.
