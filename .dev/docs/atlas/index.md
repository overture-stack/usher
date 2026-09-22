# Atlas index

One line per topic file. Cross-linked from `.dev/roadmap.md` or `.dev/tech-debt.md` entries.

**Keeping this complete needs a count, not a read.** A file linked only from a roadmap entry is
reachable until that entry is completed and removed, at which point it becomes unreachable and
nothing registers the loss, because the index it should have been in never listed it. Compare files
on disk against entries here; a sweep starting from either list cannot find what neither list holds.

## Phase documents

- [BRD traceability](../brd-traceability.md): each iMS UAC requirement mapped to what satisfies it, with no open conflicts, the aggregation requirement settled, and one withdrawn requirement
- [Phase 1: design blockers and implementation gate](../phase-1.md): the blocker set, the design lock, the Nov 15 requirements, and the conformance corpus design
- [UAC user flows traceability](../uac-flows-traceability.md): what the portal flow specifications settle, what they contradict, and where they contradict themselves

## Roadmap detail

- [Admin model: open questions](roadmap/admin-model-open-questions.md): three v1 blockers and lower-priority follow-ups for the admin API
- [Arranger integration blockers](roadmap/arranger-integration-blockers.md): eleven items from the first plugin integration, grouped by what blocks each; two are fail-open defects
- [Cohort registration and Lyric integration](roadmap/cohort-registration-lyric.md): pre-registration approach and three design items gating Lyric integration
- [Design doc reconciliation](roadmap/doc-reconciliation.md): **superseded.** Written against the resource-level enforcement decision that has since been reversed; kept for how it located contradictions, not for what it found
- [Documentation review patterns](roadmap/doc-review-patterns.md): the defect classes from reading the onboarding artifact with real readers, the two axes they sort under, and the information order to propagate
- [Permissions model: open items](roadmap/permissions-model-gaps.md): seven open design items before the core service can be implemented
- [RABAC alignment](roadmap/rabac-alignment.md): the role-check stage of the adopted pattern was never built, which is why the model has no verbs; the correction and what it closes
- [API keys](roadmap/api-keys.md): why they stay opaque, and the narrowing worth building later
- [Researcher experience design](roadmap/researcher-experience.md): three UX decisions gating researcher-facing documentation
- [SQON-scoped grants](roadmap/sqon-scoped-grants.md): optional per-grant SQON filter enabling community-specific and subset access
- [Technology stack decisions](roadmap/technology-stack.md): confirmed choices, including the resolved HTTP framework decision
- [Terminology usage rules](roadmap/terminology-usage.md): Simplified Technical English as the adopted register and what it does not cover, then which word to write where, the reserved senses, scope naming, and the retired list
- [Onboarding audit](roadmap/onboarding-audit.md): what three independent reading passes over the published onboarding document left open
- [Role model sweep](roadmap/role-model-sweep.md): every site where the two planes are conflated, ranked, with each one's status

## Practice

- [Subagent delegation](subagent-delegation.md): a running log of what delegating to subagents has and has not been good for. Not a convention
