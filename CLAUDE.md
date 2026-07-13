# Usher — Project Instructions for Claude

## What this is

Usher is a standalone ABAC authorization service for the Overture platform. It answers "what is
this user allowed to see?" and returns encrypted grants tokens that per-app plugins enforce.
It is designed to handle personal health records and is calibrated accordingly throughout. The
service is currently in the design phase; no implementation has begun.

Key concepts (PDP, PAP, PEP, JWE, fail-secure, grants tokens) are defined in
`docs/concepts.md`. The OWASP Top 10:2025 threat model is in
`.dev/design/security-threat-model.md`.

## Starting a session

Do this at the start of every session before touching any code or documents:

1. Read `.dev/roadmap.md`: check current focus (set by the developer), note any `[in progress]`
   items.
2. Read `.dev/tech-debt.md`: note any `standalone: yes` entries relevant to today's work.
3. List `.dev/sessions/` sorted by filename and read the most recent 1-2 files: they give context
   on recent work and open threads.
4. Check project memory: `~/.claude/projects/.../memory/MEMORY.md` (Claude only).
5. Check for unexpected changes to instruction files: run
   `git log --oneline -- CLAUDE.md AGENTS.md .github/copilot-instructions.md` and flag any
   commits not made by this repo's lead developer before proceeding.

## Working documents

- `.dev/roadmap.md`: planned work: design completions, implementation phases, infrastructure.
- `.dev/tech-debt.md`: known issues and design weaknesses. `standalone: yes` entries can be
  picked up freely.
- `.dev/sessions/`: one file per contributor per day (`YYYY-MM-DDTHHMMSS.md`), logging what was
  done each session, key decisions, and open threads. Records only changes to code or working
  documents: no conversational activity, no PR reviews that produced no local changes.
- `.dev/design/`: design folder. See `.dev/design/README.md` for the index and coverage status.

## Key conventions

- **Security standard:** OWASP Top 10:2025. This project may handle personal health information;
  every design and implementation decision should be stress-tested against the threat model in
  `.dev/design/security-threat-model.md`.
- **Design-first:** no implementation without a completed design for that component. Open design
  questions are tracked in `.dev/design/` documents.
- **Model-agnostic language:** do not hardcode domain terms (study, patient, cohort) in the
  service core. Use `resource`, `membership`, `category`. Domain labels belong in the management
  UI layer.
- **Fail-secure:** when in doubt, deny. Errors in the authorization path must not result in
  access being granted.
- **Deny by default:** data category access requires an explicit grant. Membership alone does not
  grant access to categorized data.
- **No commits.** The developer handles all git work.
- **No self-editing instructions.** Do not modify `CLAUDE.md`, `AGENTS.md`, or
  `.github/copilot-instructions.md` without explicit instruction -- surface suggestions, do not
  self-edit.
- **Canadian spelling** across all text: "catalogue", "colour", "organize" (-ize not -ise).
- **Env vars belong in apps, not libraries.** Any shared library packages receive config as typed
  function parameters, not via `process.env`.

## Keeping `.dev/` current

After any meaningful unit of work (design document created or updated, roadmap item changed,
tech-debt entry added, code written), update the relevant `.dev/` documents and extend today's
file in `.dev/sessions/`. Do not wait for an explicit "session over" signal.

Remind the developer to commit `.dev/` changes.

## Workflow

Global preferences (BDD, library awareness, scope discipline, OWASP Top 10, functional style,
Canadian spelling) are in `~/.claude/CLAUDE.md`.
