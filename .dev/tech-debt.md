# Usher: Technical Debt

Issues logged scope-adjacently during development. Not a priority backlog.
`standalone: yes` entries can be picked up freely without broader context.

Open design questions are tracked in `.dev/design/` and the OWASP gap analysis in
`.dev/design/security-threat-model.md`, not here.

---

The packaging checks the Bridge's packaging note requires run by hand only: that the packed
declarations name neither `jose` nor `CryptoKey` and import only names they use, that the
packed JavaScript imports `jose` and `@overture-stack/usher-types` rather than inlining them, and
that the tarballs load through both `require()` and `import()`.
fix: add them to `scripts/check-pack.ts`, which the Jenkins job runs as its `check:pack` stage.
standalone: yes

With a custom `extract`, a host reading credentials from cookies or service headers still answers
with Bearer challenges: the 400 says `Bearer error="invalid_request"`, and its fixed text asks for a
Bearer token in the Authorization header.
fix: the host declares its challenges as a list of `{ scheme, params }`, defaulting to Bearer, which
the Bridge serializes, quoting each value; `error` goes on the Bearer challenge only, and only when
the refused credential was a bearer token (RFC 6750 § 3.1); the 400's text names the host's
credential source.
standalone: no
context: waits on the first host with its own credential source adopting the Bridge.

The Express layer logs a synchronous throw from `core.resolve`, and a throw while answering, under
`bridge.internalError` stages naming other steps, `extract` or `resolve`.
fix: call `core.resolve` through a promise so its throw reaches the `resolve` handler, and add an
`answer` stage for throws while answering, to `INTERNAL_ERROR_STAGES` and to the event table.
standalone: yes

A throw while signing the channel assertion is reported as a network failure on the exchange and as
a close on the push, but as a defect on the poll.
fix: sign before each request's `try` in `controllerClient.ts` and `push.ts`, as the poll does, and
report the throw as a defect, adding that cause to the exchange's failure causes and to the Bridge's
list of events.
standalone: yes

`pnpm-workspace.yaml` overrides the glob archiver-utils resolves to `^14.0.3`, outside the
`glob ^10` range archiver-utils requires, since that range carries GHSA-3g3m-2fjr-6pw4 and, through
its minimatch, GHSA-g3hv-75wg-m249. archiver-utils reaches the workspace only under testcontainers'
archiver, and calls glob's `sync` alone, which glob 14 keeps.
fix: remove the override once testcontainers depends on an archiver whose chain resolves glob 14.0.2
or later and minimatch 11.0.1 or later.
standalone: yes

Two support modules in `apps/controller/testing/peripherals/` copy code the packages keep internal:
`sqonEvaluator.ts` copies usher-types' test-only SQON evaluator, and `bridgeWire.ts` reproduces the
Bridge's side of the wire from `modules/bridge--express/src/core/` and `modules/types/src/`. Nothing
compares a copy with its source, so a change to the source leaves the Controller's suites checking
the old behaviour without failing.
fix: import the evaluator from the private workspace package planned with the Bridge refactor, and
give the functions `bridgeWire.ts` reproduces an import the suites can use, in that package or as a
test-only export, so neither copy remains.
standalone: no
context: the evaluator waits on that package.

The Controller's dedicated test containers draw their fixed host ports (`HOST_PORTS` in
`apps/controller/testing/harness/containers.ts`) from 30000 to 32767 alone, the part below the
daemon's assigned ports that the CI Docker host admits today, which leaves fewer ports to draw from
when many test files start their own containers at once.
fix: widen `HOST_PORTS` again to 10000 to 32767, and the range where the module's TSDoc, its tests
and the testing README name it.
standalone: no
context: waits on the CI Docker host admitting 10000 to 32767.

Prettier 3.9.10's experimental CLI, chosen by `--experimental-cli` or by setting
`PRETTIER_EXPERIMENTAL_CLI`, formats with Prettier's defaults when the configuration fails to load,
and reports nothing: its configuration loading ends in `.catch(noop3)`. The legacy CLI fails on a
configuration it cannot load, so `format`, `format:check` and CI's Format stage must keep to it.
fix: move them to the experimental CLI only once a Prettier release fails on a configuration it
cannot load, as the legacy CLI does.
standalone: no
context: waits on that Prettier release.

In `apps/controller/src/storeTimeout/storeTimeout.database.test.ts`, three cases failed under load and passed
on every run alone. The suite on the Controller's start failed twice in one PostgreSQL 18 run while
a shared Docker daemon was under load, and on CI's two-CPU pod: "refuses a start on a connection
that drops the controller's statement limits, as a pooler dropping startup parameters does, naming
the database URL" and "refuses a start the store will not sign in, naming the password for a
refused password and the database URL for a database the store lacks". On CI's two-CPU pod, "answers
a Management API request 503 storeUnavailable within about the store timeout while the store is
paused, writing nothing, and serves the next once the store answers" failed before its request,
its harness's start refused for not answering within the store timeout. Outside that file,
`src/noticeChannel/noticeChannel.database.test.ts` failed one run in ten under load the same way:
"answers 410 on both channels to a cursor below the trim watermark, and serves one at it", its
harness's start taking 5166 ms against the product's default store timeout of 5000 ms. Each must
pass under load as it does alone.
fix: every instance in the storeTimeout file now starts within four times the compressed store
timeout, since an instance's whole start runs within its store timeout; give every other harness
start a store timeout well above a loaded start, except where a suite tests the timeout itself;
confirm on CI's pod that each case passes, and establish the cause of any that still fails.
standalone: yes

Most files in `apps/controller/testing/fixtures/` hold helpers that start or drive the real system
beside the data they build: `applications.ts`, `audit.ts`, `channel.ts`, `conformance.ts`,
`database.ts`, `grants.ts`, `issuance.ts`, `listings.ts` and `resources.ts`. In the other
direction, `testing/harness/auditEvents.ts` holds the audit-event table's expectations, which are
fixed data, beside its log readers. Each folder must hold only what `DEVELOPMENT.md` defines it to
hold.
fix: move each driving helper into `testing/harness/` and the table's expectations into
`testing/fixtures/`, after the grant operations land, so their suites move onto these paths once.
standalone: no
context: waits on the grant operations.

Two parts of the Controller's tests bound how fast CI runs them. The migrations suite,
`src/migrations/migrations.database.test.ts`, is the longest single suite at about three minutes,
its 16 tests each running the migration command against a new database. Every Keycloak test starts
a Keycloak of its own, three in `testing/harness/containers.test.ts` alone at about 50 s each.
fix: start one Keycloak per run in the global setup, its realm imported with every user the suites
need, and share it; profile the migrations suite for work its tests repeat without observing it, and
cut that, keeping every migration run a test watches.
standalone: no
context: after the grant operations, whose suites add to both.

Every setting's first value must have a `settings.seeding` event. When a run's migrations add a
setting to a seeded store, the schema migration command records that event after the migration
commits, in a transaction of its own (`apps/controller/src/migrations/migrate.ts`), so a run stopped
between the two leaves the setting with its change record but no seeding event, and a later run,
comparing names only within itself, does not notice.
fix: on each run, find any setting that no `settings.seeding` event names and record one for it,
marked as recovered.
standalone: yes
