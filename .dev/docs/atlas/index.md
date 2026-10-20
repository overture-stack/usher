# Atlas index

One line per topic file. Cross-linked from `.dev/roadmap.md` or `.dev/tech-debt.md` entries.

**Keeping this complete needs a count, not a read.** A file linked only from a roadmap entry is
reachable until that entry is completed and removed, at which point it becomes unreachable and
nothing registers the loss, because the index it should have been in never listed it. Compare files
on disk against entries here; a sweep starting from either list cannot find what neither list holds.

## Phase documents

- [BRD traceability](../brd-traceability.md): each iMS UAC requirement mapped to what satisfies it, with no open conflicts, the aggregation requirement settled, and one withdrawn requirement
- [Phase 1: design blockers and implementation gate](../phase-1.md): the blocker set, the Nov 15 requirements, and the conformance corpus design
- [UAC user flows traceability](../uac-flows-traceability.md): what the portal flow specifications settle, what they contradict, and where they contradict themselves

## Roadmap detail

- [Admin model: open questions](roadmap/admin-model-open-questions.md): three v1 blockers and lower-priority follow-ups for the admin API
- [API keys](roadmap/api-keys.md): why they stay opaque, and the narrowing worth building later
- [Arranger integration blockers](roadmap/arranger-integration-blockers.md): eleven items from the first adapter integration, grouped by what blocks each; two are fail-open defects
- [Bounded surveyor](roadmap/bounded-surveyor.md): post-MVP; a surveyor who views a bounded number of records and counts nothing, what serving it takes, and why granting it early serves a full viewer
- [Categories that select](roadmap/categories-that-select.md): research on top of the decided overlay category; using overlays to define synthetic resources, what that solves for multi-category records, and the three rules it needs
- [Cohort registration and Lyric integration](roadmap/cohort-registration-lyric.md): pre-registration approach and three design items gating Lyric integration
- [Conditions beyond the data](roadmap/conditions-beyond-the-data.md): research; which rules about the person to offer beyond signing in, and embargo as a local category with a deadline, what it meets and why it is not in the first release
- [Count-only principal](roadmap/count-only-principal.md): research; what a principal holding `count` without `view` gets, the routes that test every rule, and rules recommended and not adopted
- [Approval service](roadmap/approval-service.md): future scope, research; the approval service, tentatively named Audition, as an ushered application, the two flows it serves, resource types and why DCAT's word is type, and the service-assigned ownership threat
- [Documentation review patterns](roadmap/doc-review-patterns.md): the defect classes from reading the onboarding artifact with real readers, the two axes they sort under, and the information order to propagate
- [Local categories](roadmap/local-categories.md): future scope; categories created by an owner within one resource, the add-only rule, the scope prefix that ships first, and where a local category's mapping lives
- [Onboarding audit](roadmap/onboarding-audit.md): what three independent reading passes over the published onboarding document left open
- [Permissions model: open items](roadmap/permissions-model-gaps.md): seven open design items before the core service can be implemented
- [RABAC alignment](roadmap/rabac-alignment.md): the role-check stage of the adopted pattern was never built, which is why the model has no verbs; the correction and what it closes
- [Researcher experience design](roadmap/researcher-experience.md): three UX decisions gating researcher-facing documentation
- [Role model sweep](roadmap/role-model-sweep.md): every site where the two planes are conflated, ranked, with each one's status
- [SQON-scoped grants](roadmap/sqon-scoped-grants.md): optional per-grant SQON filter enabling community-specific and subset access
- [Technology stack decisions](roadmap/technology-stack.md): confirmed choices, including the resolved HTTP framework decision
- [Terminology usage rules](roadmap/terminology-usage.md): Simplified Technical English as the adopted register and what it does not cover, then which word to write where, the reserved senses, scope naming, and the retired list

## Bridge

- [Bridge core and Express layer](bridge/core-and-express-layer.md): research; the framework-free core, its state machine, bounded stores, coalescing and in-flight bound, and the thin Express layer
- [jose for the Usher token](bridge/jose-usher-token.md): research; how the bridge decrypts and validates the Usher token with jose, every option pinned, and how the controller mock mints tokens
- [Packaging the bridge](bridge/packaging-and-toolchain.md): research; ESM-only packages built by tsdown, declarations across TypeScript versions, the Express Locals declaration and the test toolchain
- [Revocation notice stream](bridge/revocation-notice-stream.md): research; push over SSE read with fetch, a poll that always runs, two positions, and both liveness rules
- [Sign-in signature precheck](bridge/signin-signature-precheck.md): research; why the bridge does not check a sign-in token's signature before the exchange, and the flood that leaves open

## Practice

- [Subagent delegation](subagent-delegation.md): a running log of what delegating to subagents has and has not been good for. Not a convention
