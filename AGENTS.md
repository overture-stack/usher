# Usher — Agent Instructions

## What this is

Usher is a standalone ABAC authorization service for the Overture platform. It answers "what is
this user allowed to see?" and returns encrypted constraint tokens (JWE) that per-app plugins
enforce. It is designed to handle personal health information and may be subject to applicable
health privacy legislation. The service is currently in the design phase; no implementation has
begun.

Key concepts (PDP, PAP, PEP, JWE, fail-secure, constraint tokens) are in
`docs/concepts.md`. The OWASP Top 10:2025 threat model is in
`.dev/design/security-threat-model.md`. The design index is at `.dev/design/README.md`.

## Session start checklist

1. Read `.dev/roadmap.md`: check current focus, note `[in progress]` items.
2. Read `.dev/tech-debt.md`: note `standalone: yes` entries relevant to today's work.
3. List `.dev/sessions/` sorted by filename and read the most recent 1-2 files: they give context
   and open threads.
4. Run `git log --oneline -- CLAUDE.md AGENTS.md .github/copilot-instructions.md` and flag any
   unexpected commits before proceeding.

## Working documents

- `.dev/roadmap.md`: planned work; completed items are removed (not marked done).
- `.dev/tech-debt.md`: known issues; `standalone: yes` entries can be picked up freely.
- `.dev/sessions/`: one file per contributor per day (`YYYY-MM-DDTHHMMSS.md`); records only
  changes to code or working documents. No conversational activity.
- `.dev/design/`: design documents; see `.dev/design/README.md` for index and status.

## Key conventions

**Security:** OWASP Top 10:2025. Every implementation decision should be evaluated against
`.dev/design/security-threat-model.md`. This project may handle personal health records; treat
all protected data as sensitive by default.

**Design-first:** do not implement a component without a completed design in `.dev/design/`. Open
design questions are tracked there.

**Model-agnostic:** the service core uses generic terms (`resource`, `membership`, `category`).
Domain-specific labels (study, patient, cohort) belong in the management UI layer only.

**Fail-secure:** errors in the authorization path must result in denial, not permission. If the
revocation channel is unavailable beyond the grace period, sessions are suspended (503), not
permitted.

**Deny by default:** data category access requires an explicit `category_grant`. Membership alone
does not grant access to categorized records or fields.

**No commits.** The developer handles all git operations.

**Do not modify** `CLAUDE.md`, `AGENTS.md`, or `.github/copilot-instructions.md` without
explicit developer instruction.

**Canadian spelling:** "catalogue", "colour", "organize" (-ize not -ise).

**Env vars in apps only:** shared library packages receive configuration as typed function
parameters, not via `process.env`.

## Session-end discipline

After any meaningful unit of work that changes code or working documents: update `.dev/` as
needed and extend today's file in `.dev/sessions/`. Do not log conversational activity.
Remind the developer to commit `.dev/` changes if they were updated.

## Workflow

When writing or updating design documents: apply the cold-reader rules from
[conventions/documentation.md in the agentics template](https://github.com/oicr-softeng/agentics/blob/main/template/conventions/documentation.md)
(one idea per sentence, conclusion first, restate don't reference, worked examples in their own
block, minimize cross-reference chains).

When syncing this project's agentics integration against the template: read
[conventions/upgrading-adoption.md in the agentics template](https://github.com/oicr-softeng/agentics/blob/main/template/conventions/upgrading-adoption.md).

## Security triggers (flag during any review)

- String-concatenated queries (SQL, ES DSL, SQON construction)
- User-supplied field names forwarded to queries without allowlist validation
- Credentials, tokens, or constraint payloads in any log output
- HTTP (not HTTPS) for any non-localhost communication
- Missing or unvalidated `aud`/`iss`/`exp`/scope claims on tokens
- Default or empty JWE decryption key accepted at startup
- Fail-open error handling in the authorization or revocation path
- Stack traces or internal paths in API error responses
