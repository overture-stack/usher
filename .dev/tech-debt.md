# Usher: Technical Debt

Issues logged scope-adjacently during development. Not a priority backlog.
`standalone: yes` entries can be picked up freely without broader context.

Open design questions are tracked in `.dev/design/` and the OWASP gap analysis in
`.dev/design/security-threat-model.md`, not here.

---

With a custom `extract`, a host reading credentials from cookies or service headers still answers
with Bearer challenges: the 400 says `Bearer error="invalid_request"`, and its fixed text asks for a
Bearer token in the Authorization header.
fix: the host declares its challenges as a list of `{ scheme, params }`, defaulting to Bearer, which
the Bridge serializes, quoting each value; `error` goes on the Bearer challenge only, and only when
the refused credential was a bearer token (RFC 6750 § 3.1); the 400's text names the host's
credential source.
standalone: no
context: waits on the first host with its own credential source adopting the Bridge.

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

In `apps/controller/src/storeTimeout/storeTimeout.database.test.ts`, three cases failed under load
and passed on every run alone. The suite on the Controller's start failed twice in one PostgreSQL 18
run while a shared Docker daemon was under load, and on CI's two-CPU pod: "refuses a start on a
connection that drops the controller's statement limits, as a pooler dropping startup parameters
does, naming the database URL" and "refuses a start the store will not sign in, naming the password
for a refused password and the database URL for a database the store lacks". On CI's two-CPU pod,
"answers a Management API request 503 storeUnavailable within about the store timeout while the
store is paused, writing nothing, and serves the next once the store answers" failed before its
request, its harness's start refused for not answering within the store timeout. In the same file,
"abandons a transaction the store holds past the store timeout" failed its timing once in a full
run, at 1967 ms. Outside that file, `src/noticeChannel/noticeChannel.database.test.ts` failed one
run in ten under load the same way: "answers 410 on both channels to a cursor below the trim
watermark, and serves one at it", its harness's start taking 5166 ms against the product's default
store timeout of 5000 ms. Three more failed once each in a full chain on PostgreSQL 18 and passed
every run alone: `src/admission/admission.database.test.ts`'s "with one application borrowing the
whole exchange pool, another application's exchange within its share is answered within the
deadline", answered in 42286 ms against its 4 s deadline (three runs of three alone);
`src/store/databaseTls.database.test.ts`'s "takes a reissued CA certificate at the next connection",
past its 10 s wait (two of two alone); and the harness start in
`testing/harness/workerBridge.test.ts`, refused once for a store commit not answered within the
store timeout (passing on its rerun), and its case at line 27, whose Bridge once missed its short
wait for normal mode on the compressed profile (passing alone and on the rerun). The cause they
share is load on the test process: the chain runs every database suite at once, at Node's default
file concurrency, eleven here against six CPUs for Docker and two on CI's pod, and the harness runs
each Controller inside the test process, so a starved event loop fires the Controller's own timers
late, its exchange deadline among them. The exchange's deadline does bound its wait for a pooled
connection, since `withinStoreTimeout` arms it before asking the pool, so admission's 42 s is that
starvation, not an unbounded wait. It must pass deterministically.
fix: every instance in the storeTimeout file now starts within four times the compressed store
timeout, since an instance's whole start runs within its store timeout; bound the database suites'
file concurrency in the chain to what the machine carries, give every other harness start a store
timeout well above a loaded start except where a suite tests the timeout itself, confirm on CI's pod
that each case passes, and establish the cause of any that still fails. For the worker Bridge, wait
on the start's own signal, or bound it like the other loaded harness starts, not a short fixed wait;
prove it across repeated full runs.
standalone: yes

The test run's one Keycloak, which the global setup starts and every Keycloak suite shares, fails
the whole run when it does not start: every suite fails, not only the few that use it. Seen once:
its realm's discovery document did not answer within 180 s in both global setups of one chain and in
the held run after it, while Docker was otherwise healthy, and the next run started it normally.
fix: retry the shared Keycloak's start a bounded number of times, keeping its container's log from
each failed attempt, and when every attempt fails, fail the global setup naming Keycloak and where
its logs are, rather than as an unnamed container timeout.
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

Every setting's first value must have a `settings.seeding` event. When a run's migrations add a
setting to a seeded store, the schema migration command records that event after the migration
commits, in a transaction of its own (`apps/controller/src/migrations/migrate.ts`), so a run stopped
between the two leaves the setting with its change record but no seeding event, and a later run,
comparing names only within itself, does not notice.
fix: on each run, find any setting that no `settings.seeding` event names and record one for it,
marked as recovered.
standalone: yes

A platform administrator's `GET /admin/resources` carries every unrevoked grant of each resource on
the page (`grantsOnResources` in `apps/controller/src/grants/grantListingOperations.ts`), with no
bound on how many, and reads each holder from the directory, eight at a time. The page's `limit`
bounds the resources alone, so one resource holding thousands of grants makes one answer that large
and that many directory lookups.
fix: cap the number of grants carried by each entry, and have an entry over the cap name how many
it left out, pointing at `GET /admin/resources/{externalId}/grants`, which pages them.
standalone: no
context: changes the listing's contract, so it lands before a stable release.

Eight Controller test cases are placeholders with no assertions, named for refusals of tokens and
channel assertions that verify under no live key, of unreadable sign-in tokens, and of a forged
token's subject reaching the audit trail. One is a `test.todo` in
`createChannelAssertionVerifier.test.ts` (one assertion presented in two encodings). Seven are empty
suites marked `todo`: one each in `createChannelAssertionVerifier.test.ts`,
`createTokenVerifier.test.ts`, `test/exchange/issuance/channelAssertion.test.ts` and
`conformanceGaps.test.ts`, and three in `test/audit/tokenExchange.test.ts`. The test runner counts a
todo suite as a suite, so a run's todo total shows one where eight exist.
fix: write each case from its source (the issuance, audit and conformance tests, and the refused-subject ruling),
the forged-subject case first, and decide whether the two-encodings case is written or removed.
Until then, a placeholder stays a `todo`, so it never reads as a passing test.
standalone: no
context: the cases forge tokens and signatures, which the developer writes by hand.
