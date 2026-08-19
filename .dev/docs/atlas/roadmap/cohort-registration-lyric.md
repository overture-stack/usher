# Cohort registration and Lyric integration

## Approach

MVP uses pre-registration: an admin creates the study or cohort entity in Usher (owner, stewards, category config, field-value identifier) before any data is submitted. Submission of unregistered cohorts is rejected. See `.dev/design/to-discuss.md` (Ownership and stewardship section) for the full description.

Post-MVP: optional submission-time cohort creation shares the same code foundation, making pre-registration "run creation before submission."

## Design items gating Lyric integration

**Service account capability set for Lyric.** What Lyric can create or query on behalf of owner-level submitters. See `.dev/design/permissions-model.md` (Ownership assignment section) and `.dev/design/admin-model.md` (service account model).

**Trust model for the Lyric service account.** How Lyric authenticates with Usher, what it can assert about the submitting user, and what it cannot override.

**Self-grant prevention check.** Must be specified before the grant approval endpoint is built. See `.dev/design/to-discuss.md` (Ownership and stewardship section).
