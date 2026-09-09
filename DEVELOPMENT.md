# Usher: Developer Guide

Internal guide for contributors. For community contribution guidelines, see `CONTRIBUTING.md`
(to be added when the project is ready for external contribution).

## What Usher is

Usher is a standalone ABAC (Attribute-Based Access Control) authorization service for the
Overture platform. It answers "what is this user allowed to see?" for any Overture application
and returns encrypted grants tokens that per-app plugins enforce at the query layer.

Usher is not an authentication service. Authentication is delegated to the configured identity
provider (Keycloak, Azure Entra ID, or any OIDC-compatible provider).

## Current status

**Design phase.** No implementation has begun. The design documents in `.dev/design/` are the
primary working artefacts right now. See `.dev/design/README.md` for coverage status (what is
specced, what is in progress, what has not yet been started).

## Repository structure

```
usher/
  .dev/
    design/          (design documents; see design/README.md for the index)
    roadmap.md       (planned work)
    tech-debt.md     (known issues)
    sessions/        (session log, one file per contributor per day)
    docs/            (phase and traceability documents, and the atlas)
  AGENTS.md          (instructions for Codex and general AI agents)
  CLAUDE.md          (instructions for Claude)
  DEVELOPMENT.md     (this file)
```

## Working documents

The `.dev/` directory is the shared working memory for this project across sessions and
contributors, human and AI.

- **`roadmap.md`**: planned features and architectural work. Items are open unless marked
  `[in progress]`. Completed items are removed; `sessions/` is the historical record.
- **`tech-debt.md`**: issues logged scope-adjacently. `standalone: yes` entries can be picked
  up without broader context.
- **`sessions/`**: one file per contributor per day, named `YYYY-MM-DDTHHMMSS.md`, logging what
  was done: design decisions made, documents changed, tech-debt entries added. No conversational
  activity. ISO names sort chronologically, so no index is needed.
- **`docs/`**: documents that outlive a session. The phase-1 blocker set and implementation gate,
  requirement and user-flow traceability, and the atlas of longer-form roadmap detail.
- **`design/`**: design documents covering security workflow, permissions model, plugin
  integration, and the management UI. Start at `design/README.md`.

## AI tooling

This project uses Claude and Codex as development partners, with `CLAUDE.md` and `AGENTS.md` at
the repo root. `AGENTS.md` carries the substance and `CLAUDE.md` defers to it, so conventions,
session checklists and security triggers are stated once. Agents that read neither by default are
pointed at `AGENTS.md` rather than given a third copy to drift from, which is why the earlier
Copilot-specific file is gone. Do not modify either without explicit agreement from the lead
developer.

## Security

Usher may handle personal health information. The design is calibrated to OWASP Top 10:2025 and
documented in `.dev/design/security-threat-model.md`. Security concerns are treated as first-class
design requirements, not afterthoughts.

Key principles:

- Fail-secure: errors in the authorization path must deny, not permit
- Deny by default: data category access requires explicit grants
- Fail-open is never acceptable in the authorization or revocation path
