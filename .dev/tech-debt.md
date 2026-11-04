# Usher: Technical Debt

Issues logged scope-adjacently during development. Not a priority backlog.
`standalone: yes` entries can be picked up freely without broader context.

**Note:** Usher is currently in the design phase. Open design questions (incomplete permissions
model, undesigned adapter API contract, unspecified JWE algorithms, etc.) are tracked in
`.dev/design/` documents and the OWASP gap analysis in
`.dev/design/security-threat-model.md`, not here. Tech-debt entries are added as implementation
proceeds and specific shortcuts or weaknesses are introduced.

---

Design documents formatted with Prettier 3.8.3 differ from the repository's 3.9.9 in table alignment
and list markers, so `format:check` fails on eighteen files under `.dev/` and `docs/`.
fix: once the bridge branch, which adds Prettier, is on main, run `pnpm format` over them with the
repository's own copy, and add `.dev/design/conformance/principals.json` to `.prettierignore`, since
the corpus keeps its own layout there, one value per line, which Prettier would rewrite.
standalone: no
context: waits on the bridge branch merging into main.

tsdown 0.23.0's toolchain pulls in 24 platform bindings of `@yuku-codegen` and `@yuku-parser` 0.10.2
that their publisher has deprecated, and pnpm warns on every install.
fix: move tsdown to the first release that drops or replaces them, checking its declaration output
against the packed tarballs as the packaging note's CI checks do.
standalone: yes

The packaging checks the bridge's packaging note requires run by hand only: that the packed
declarations name neither `jose` nor `CryptoKey` and import only names they use, that the
packed JavaScript imports `jose` and `@overture-stack/usher-types` rather than inlining them, and
that the tarballs load through both `require()` and `import()`.
fix: add them as steps in the repository's first CI pipeline, beside `pnpm format:check`.
standalone: no
context: waits on Usher having a CI pipeline, which the deployment runs through Jenkins.

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

The audit table records no refused back-channel logout token: `identity.signOut` covers an accepted
sign-out only.
fix: record a refused logout token as a refused management credential is recorded, one event for a
token that verifies under the trusted issuer and is refused anyway, and a tally per reason for one
that does not.
standalone: no
context: waits on the controller's back-channel logout endpoint.
