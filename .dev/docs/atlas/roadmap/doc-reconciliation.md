# What the docs still say that is no longer true

Three decisions landed on 2026-08-21: resource-level enforcement, additive rendering, and zero
entitlement as a distinct state. The docs have not caught up. This lists where they still say the
old thing, worst first.

One item is not a documentation fix. Everything after it is.

---

## Resolved: how a catalogue-level denial is expressed

The hook must return a query and is required to be total, so a catalogue-level denial has to be a
filter. Middleware cannot cover it, because the hook is per catalogue and one request can span
catalogues whose answers differ.

Denial is expressed with the query module's `matchNothing(fieldName)` constructor. A filter must
carry at least one leaf clause; an empty combination is not a restriction, and a negation is not a
way to build one. The constructor is verified and already shipped in the module that owns those
semantics.

Recorded in [decisions.md](../../../design/decisions.md). Verification is moving to a shared
live-cluster test asserting that a denied principal sees nothing across every read path, rather than
resting on reported query output.

---

## Would send an implementer the wrong way

Each row is a doc saying something we have decided against. Fixing any one of them in isolation
leaves the others contradicting it, so treat rows 1 and 2 as single edits across all their sites.

**Closures are recorded in place rather than deleted**, so this file stays evidence that the sweep
happened rather than only a list of what is left. Four of the eight are now closed, verified against
the files rather than from memory of having fixed them.

| What a doc says                                                            | Where                                                          | Why it is wrong                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ~~The plugin builds the query filter~~ **CLOSED**                          | `decisions.md`, `architecture.md` (4 sites)                    | The bridge builds it. Both files also say the other thing elsewhere, so they contradict themselves                           |
| The plugin receives a `GrantsPayload`                                      | `plugin-integration.md` (4), `architecture.md` (3)             | It receives the three-way answer. Handing it a payload is what makes plugins build their own filters                         |
| The plugin subtracts held categories from its own config to get exclusions | `glossary.md` (3 entries), `security-workflow.md` (2 passages) | This is the fail-open path. No grants means nothing to subtract, which means no filter, which means everything               |
| ~~Single-valued because the data model guarantees it~~ **CLOSED**          | `decisions.md`                                                 | `permissions-model.md` says records can belong to several cohorts. It is a precondition to check at startup, not a guarantee |
| ~~Deny the request with 401 or 403~~ **CLOSED**                            | `plugin-integration.md`                                        | `decisions.md` says a 403 confirms the resource exists. The plugin picks the response shape                                  |
| Admin bypass skips the filter                                              | `admin-model.md` (3 places)                                    | Skipping is the thing we prohibited. This is what `allow` is for                                                             |
| ~~A catalogue maps to one resource~~ **CLOSED**                            | `glossary.md`                                                  | Then no field predicate would be needed. One catalogue holds many resources                                                  |
| ~~The worked example's outcomes are unchanged~~ **CLOSED**                 | `permissions-model.md`                                         | They change. A member missing one of a resource's categories now sees nothing there, not a filtered subset                   |

---

## The right decision, given for the wrong reason

We keep encrypting the grants token. The reason changed. The old reason was that a user could read
a signed token and probe their own limits. That stopped being true when the bridge moved
server-side, because the user never holds the token now.

Two places still give the old reason. Three are closed, all three in the published docs, which
were the urgent half.

| File                   | Still says                                                                        |
| ---------------------- | --------------------------------------------------------------------------------- |
| ~~`docs/intro.md`~~ **CLOSED**   | Rewritten on audience-separation grounds                                |
| ~~`docs/concepts.md`~~ **CLOSED**| Rewritten, with the retired premise named as retired                    |
| ~~`docs/iam-primer.md`~~ **CLOSED** | Contrast rebuilt on who carries the token                            |
| `security-workflow.md` | The original argument in full                                                     |
| `glossary.md`          | "while preventing the end user from reading their own grants"                     |

`docs/concepts.md` also says audience checking works by reading a claim in the token. Under
per-application keys, a token for the wrong audience simply fails to decrypt. The claim check is a
second layer, not the mechanism.

---

## Published docs describe a model we are not building

`permissions-model.md` got a post-MVP banner for this. `docs/` did not.

- Four passages in `docs/concepts.md` say categories mark subsets of records or fields inside a
  resource. For MVP they mark whole resources.
- `docs/intro.md` says categories map to records or fields in plugin config. Only the resource key
  is mapped.
- `docs/concepts.md` presents overlapping cohorts as a live feature, with one record in two cohorts
  at once. MVP cannot express that.
- Field-level control is stated flatly in one place and hedged as planned in another, in the same
  doc set.

---

## One phrase, twelve places, and it undoes a decision

The audience-separation argument only works if each application has its own key. Twelve or more
places say "the JWE key" as though there is one. One says it outright: the decryption key is "a
shared secret provisioned to each bridge instance".

If that is true, any bridge can decrypt any application's token and audience separation is just a
string comparison.

Affected: `architecture.md`, `security-workflow.md`, `security-threat-model.md`,
`plugin-integration.md`, `.dev/design/README.md`.

The same phrasing also contradicts the threat model, which prescribes asymmetric key wrap. Fixing
it toward per-application asymmetric keys settles both. The controller then holds only public keys,
so compromising it yields no ability to decrypt anything.

This is a find-and-replace over known phrases. The design question was already settled.

---

## Things with no home

Five items live only in documents that close, or in no document at all.

**`phase-1.md` cannot be found.** It is untracked in git, absent from `atlas/index.md`, and linked
from nowhere. It holds the design lock, the Nov 15 requirements, and the corpus design.

**Three risks have no entry anywhere.** Not in `roadmap.md`, not in `tech-debt.md`, not in the
atlas:

- The query library treats an empty combination as match-all. Two related hazards are recorded but
  unverified: an optimizer that removes empty combinations, and a builder that flips AND and OR
  when merging exclusions on one field.
- The shared SQON module is at `0.0.0-dev` on an `rc` tag. Nobody has decided how to pin it.
- A dependency pull request has to land before submission-path work starts.

**Every read path must inherit enforcement, and one of ours has no owner.** Nov 15 depends on four
things and this is one of them: the filter has to be composed at a boundary every read path passes
through, so no path can be added or changed without inheriting it. Composing it per path leaves the
next path to be written unprotected by default.

The adopter is tracking the specific work on their side and is building a shared test asserting a
denied principal sees nothing across every read path. What is unresolved here is ownership: either
this becomes a numbered blocker with a name against it, or it moves to the adopter's roadmap and we
cite it. Leaving it as an unowned requirement is worse than either.

**The conformance corpus has no roadmap entry**, despite an approved location and a dependency that
is now unblocked.

**The audit log cannot record what the enforcement layer decides.** No event exists for deny,
narrow, or allow. The plugin-side table uses a `filter_applied` boolean, which cannot tell `allow`
from `narrow`. Telling those apart is the only reason `allow` exists.

**Two audit schemas describe one log stream.** `admin-model.md` and `audit-events.md` disagree on
event naming, timestamp type, and required fields. `audit-events.md` is also missing the self-grant
and service-account events that `admin-model.md` promises.

---

## Stale, and the long tail

| Item                                                 | Where                                     | What to do                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Blocker 3 is marked resolved and open in four places | `phase-1.md`                              | Split it. The payload half is done; `schemaVersion` and the JWE algorithm become their own item                        |
| Blocker 6 is blocked on 3 and 5                      | `phase-1.md`                              | Only 5 remains                                                                                                         |
| Blocker 7 asks for EGO's token TTL                   | `phase-1.md`                              | EGO is going away. Ask for the IdP's access token TTL                                                                  |
| Blocker 1's heading claims highest risk              | `phase-1.md`                              | It is resolved, and its premise was wrong. Collapse the 130 lines above the conclusion                                 |
| The plugin is called middleware                      | `roadmap.md`, `technology-stack.md`       | It is a callback factory. Arranger retracted "middleware" after reading the router code, in a decision we took part in |
| The plugin runs in the search server                 | `phase-1.md`                              | It runs in `graphql-router`                                                                                            |
| Two different grants-token TTL defaults              | `docs/concepts.md`, `phase-1.md`          | Pick one; derive the other                                                                                             |
| HTTP framework listed as open                        | `atlas/index.md`, `roadmap.md`            | Fastify, decided                                                                                                       |
| Logging library listed as unconfirmed                | `technology-stack.md`                     | Pino, and the same file says so                                                                                        |
| Two of seven permissions gaps still gate MVP         | `roadmap.md`, `permissions-model-gaps.md` | Field-level restrictions are out of scope. Overlapping cohorts cannot occur                                            |
| Two roadmap entries, one capability                  | `roadmap.md`                              | Record-level tagging and SQON-scoped grants are the same thing. One of them also sits under pre-implementation design  |

**Duplicated, and it will drift.** The failure-direction table is in three files. The
`not(not-in)` idiom is in two. The resource-key checks are in two. The
establish-by-execution rule is in three. The user-ID-not-email rule is in three. Pick one home each
and link to it.

**Broken references.** A cross-reference to a roadmap entry that does not exist. A wrong path to
Arranger's plugin design doc. A line-number citation off by fifty lines. A bypass-path count that
predates a larger audit. A "next step" that already happened.

**Copyedit.** Two identical empty headings in `permissions-model.md`. Alphabetization broken in four
of six `glossary.md` groups. Banned dash forms in several files, worst in
`security-threat-model.md`, which has twenty em dashes and has not been read in weeks.
`glossary.md` has no entry for `Enforcement`, for deny, narrow or allow, or for the resource key.

**Published docs assume knowledge they were written to avoid assuming.** `docs/` uses SQON, bridge,
controller, SSE, WebSocket, 503, PI, ELIXIR and GHGA without introducing any of them. REMS is
expanded forty lines after first use. Database table names appear in conceptual prose. Capabilities
that do not exist yet are described in the present tense with no status line. Readers are routed
into `.dev/design/`, which is written for agents.

---

## Deployment detail that should not be here

please

The `audit-events.md` case is the worst of them. It makes a plugin's field name and field value
required fields on a Usher audit event. Usher has no way to know either, so the event cannot be
emitted as specified.

---

## Density: which docs are hardest to read, measured

Counted 2026-08-23 against the density convention. Sentences over 30 words, with code fences,
tables and headings stripped. Bullet lists still merge into single runs, so treat these as
directional: the ranking is sound, the absolute numbers are high.

Rewrite in this order. Human-facing first, weighted by how many people read the file.

| File                                             | Over 30 words | Why this position                                                                 |
| ------------------------------------------------ | ------------- | --------------------------------------------------------------------------------- |
| `docs/concepts.md`                               | 58            | Published, written for readers without auth expertise, and the flagship explainer |
| `.dev/design/decisions.md`                       | 75            | Highest count in the repository, and it is read to make decisions                 |
| `.dev/docs/phase-1.md`                           | 48            | Holds the design lock and the Nov 15 requirements                                 |
| `.dev/design/permissions-model.md`               | 63            | The model everything else refers back to                                          |
| `.dev/design/plugin-integration.md`              | 44            | The contract an implementer works from                                            |
| `.dev/design/admin-model.md`                     | 41            | Also the largest cluster of deployment detail to relocate                         |
| `.dev/design/to-discuss.md`                      | 37            | Its whole purpose is being scannable                                              |
| `.dev/design/security-workflow.md`               | 34            | Also carries the superseded JWE rationale                                         |
| `docs/intro.md`, `why-usher.md`, `iam-primer.md` | 14, 17, 13    | Low counts, but these are the entry points                                        |
| `.dev/design/glossary.md`                        | 18            | Also the most out-of-date file in the set                                         |

Exempt as agent-facing: `AGENTS.md` (32) and `CLAUDE.md` (2). Condensed on purpose.

**The recent edits are denser than what they were added to.** In `decisions.md`, 56% of the prose
sentences added this week run over 30 words, against 39% in the committed baseline. The sections
written while proposing the density convention are worse than the file they went into. That is the
convention's own warning arriving in practice: density reads as precision while you are writing it.

## About this document

The first version of this file had 24 sentences over 30 words, one of 150 and one of 74. It is what
prompted the density convention now in `agentics`. Rewritten under that convention on 2026-08-23:
same findings, headings that state the problem instead of naming its category, and tables wherever
the prose was a list in disguise.
