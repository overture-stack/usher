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

The audit table records no refused back-channel logout token: `identity.signOut` covers an accepted
sign-out only.
fix: record a refused logout token as a refused management credential is recorded, one event for a
token that verifies under the trusted issuer and is refused anyway, and a tally per reason for one
that does not.
standalone: no
context: waits on the controller's back-channel logout endpoint.
