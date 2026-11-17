# Usher: Technical Debt

Issues logged scope-adjacently during development. Not a priority backlog.
`standalone: yes` entries can be picked up freely without broader context.

Open design questions are tracked in `.dev/design/` and the OWASP gap analysis in
`.dev/design/security-threat-model.md`, not here.

---

The packaging checks the bridge's packaging note requires run by hand only: that the packed
declarations name neither `jose` nor `CryptoKey` and import only names they use, that the
packed JavaScript imports `jose` and `@overture-stack/usher-types` rather than inlining them, and
that the tarballs load through both `require()` and `import()`.
fix: add them to `scripts/check-pack.ts`, which the Jenkins job runs as its `check:pack` stage.
standalone: yes

With a custom `extract`, a host reading credentials from cookies or service headers still answers
with Bearer challenges: the 400 says `Bearer error="invalid_request"`, and its fixed text asks for a
Bearer token in the Authorization header.
fix: the host declares its challenges as a list of `{ scheme, params }`, defaulting to Bearer, which
the bridge serializes, quoting each value; `error` goes on the Bearer challenge only, and only when
the refused credential was a bearer token (RFC 6750 § 3.1); the 400's text names the host's
credential source.
standalone: no
context: waits on the first host with its own credential source adopting the bridge.

The Express layer logs a synchronous throw from `core.resolve`, and a throw while answering, under
`bridge.internalError` stages naming other steps, `extract` or `resolve`.
fix: call `core.resolve` through a promise so its throw reaches the `resolve` handler, and add an
`answer` stage for throws while answering, to `INTERNAL_ERROR_STAGES` and to the event table.
standalone: yes

A throw while signing the channel assertion is reported as a network failure on the exchange and as
a close on the push, but as a defect on the poll.
fix: sign before each request's `try` in `controllerClient.ts` and `push.ts`, as the poll does, and
report the throw as a defect, adding that cause to the exchange's failure causes and to the bridge's
list of events.
standalone: yes

`pnpm-workspace.yaml` overrides the glob archiver-utils resolves to `^14.0.3`, outside the
`glob ^10` range archiver-utils requires, since that range carries GHSA-3g3m-2fjr-6pw4 and, through
its minimatch, GHSA-g3hv-75wg-m249. archiver-utils reaches the workspace only under testcontainers'
archiver, and calls glob's `sync` alone, which glob 14 keeps.
fix: remove the override once testcontainers depends on an archiver whose chain resolves glob 14.0.2
or later and minimatch 11.0.1 or later.
standalone: yes

Two support modules in `apps/controller/test-support/` copy code the packages keep internal:
`sqonEvaluator.ts` copies usher-types' test-only SQON evaluator, and `bridgeWire.ts` reproduces the
bridge's side of the wire from `modules/express-bridge/src/core/` and `modules/types/src/`. Nothing
compares a copy with its source, so a change to the source leaves the controller's suites checking
the old behaviour without failing.
fix: import the evaluator from the private workspace package planned with the bridge refactor, and
give the functions `bridgeWire.ts` reproduces an import the suites can use, in that package or as a
test-only export, so neither copy remains.
standalone: no
context: the evaluator waits on that package.

The controller's dedicated test containers draw their fixed host ports (`HOST_PORTS` in
`apps/controller/test-support/containers.ts`) from 30000 to 32767 alone, the part below the
daemon's assigned ports that the CI Docker host admits today, which leaves fewer ports to draw from
when many test files start their own containers at once.
fix: widen `HOST_PORTS` again to 10000 to 32767, and the range where the module's TSDoc, its tests
and the test-support README name it.
standalone: no
context: waits on the CI Docker host admitting 10000 to 32767.
