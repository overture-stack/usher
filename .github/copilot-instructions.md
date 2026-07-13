# Usher — Copilot Instructions

Usher is a standalone ABAC authorization service for the Overture platform. It issues encrypted
constraint tokens (JWE) that per-app plugins enforce. It is designed for personal health records
and may be subject to health privacy legislation. Currently in the design phase.

## Key references

- `.dev/design/concepts.md`: vocabulary: ABAC, PDP/PAP/PEP, JWE, fail-secure, constraint tokens
- `.dev/design/security-threat-model.md`: OWASP Top 10:2025 mapping; addressed vs. open gaps
- `.dev/design/README.md`: design index with coverage status (specced / in progress / not started)
- `.dev/roadmap.md`: planned work
- `.dev/sessions/`: recent session log (list sorted by filename, read the most recent 1-2 files)

## Non-negotiable conventions

- **Fail-secure:** errors in authorization must deny, not permit
- **Deny by default:** data category access requires explicit grant; membership alone is not sufficient
- **Model-agnostic:** use `resource`, `membership`, `category` in core code; no domain-specific terms
- **No commits:** developer handles git
- **No edits to** `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`
- **Canadian spelling:** "catalogue", "colour", "organize"
- **Env vars in apps only:** libraries receive config as typed parameters

## Security triggers

Flag these immediately:
- String-concatenated queries of any kind
- User-supplied values forwarded to queries without allowlist validation
- Credentials, tokens, or constraint payloads in log output
- HTTP (not HTTPS) for any non-localhost URL
- Missing `aud`/`iss`/`exp` validation on tokens
- Default or empty decryption key accepted at startup
- Fail-open error handling anywhere in the auth path
