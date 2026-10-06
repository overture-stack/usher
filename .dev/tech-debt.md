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
declarations name neither `jose` nor `CryptoKey`, that the packed JavaScript imports `jose` and
`@overture-stack/usher-types` rather than inlining them, and that the tarballs load through both
`require()` and `import()`.
fix: add them as steps in the repository's first CI pipeline, beside `pnpm format:check`.
standalone: no
context: waits on Usher having a CI pipeline, which the deployment runs through Jenkins.
