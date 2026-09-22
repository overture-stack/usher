# Role model: every site, ranked

_Surveyed 2026-09-17 by three independent passes over every markdown file outside `.dev/sessions/`._

> **Sites are named by quotation, not by line number.** The original survey cited lines, and the
> corpus pass of 2026-09-19 moved nearly all of them. A reference keyed to a position stops pointing
> at its subject silently; one keyed to content moves with the text it means. Statuses below were
> re-verified by searching for the quoted words.

**The vocabulary is settled, and it reverses the July rename.** `curator` is reinstated as the
data-plane role carrying create, read, update and delete on **records**. `owner` is the
control-plane role carrying the same four acts on **access** to one resource. The two planes are the
same acts on different objects, which is what the survey below is measuring against. See the
two-planes decision in [../../../design/decisions.md](../../../design/decisions.md).

`rabac-alignment.md` kept `curator` through the July pass and is correct on that point in
retrospect. The July retirement resolved `curator` to "an owner or a viewer, whichever the sentence
means", which is precisely the conflation every tier-1 site below commits.

---

## Tier 1: passages teaching that a control-plane role reaches data

Ranked. These are the ones doing damage.

| Status | File                                   | Quote to search for                                                 | Fault                                                                                                                                                     |
| ------ | -------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| closed | `docs/concepts.md`                     | "Does this user have the 'owner' role in cohort A"                  | The published document's **first** walkthrough of an access decision, composed from owner plus a grant. Rewritten to ask what the grant's role permits    |
| closed | `permissions-model.md`                 | "cannot see `clinical_notes`; an `owner` can"                       | Stated outright that an owner reads more than a viewer. The option now contrasts two data-plane roles and says an owner reads nothing by holding the role |
| closed | `permissions-model.md`                 | "The submitter holds a role in the resource (as Owner or Viewer)"   | Offered a control-plane and a data-plane role as interchangeable, in the worked example a reader copies                                                   |
| closed | `permissions-model.md`, `decisions.md` | "belongs to the data-plane roles"                                   | A plane inversion: granting **is** the control plane. Both sites now say so                                                                               |
| closed | `docs/concepts.md`                     | "roles for coarse permission (owner vs viewer)"                     | Presented the two planes as two points on one scale. Now states that the roles are not a scale and names what each acts on                                |
| closed | `admin-model.md`                       | "Data provenance; viewer access to own data"                        | Asserted as settled what the passage below it calls an open decision and a **rejected** move. The row now defers to that passage                          |
| closed | `admin-model.md`                       | "`role.assign` (optional): assign the submitter as Owner or Viewer" | Same conflation, in a permission set that would have been built literally. Now `grant.create`                                                             |
| closed | `admin-model.md`                       | "restricted to adding users at `viewer` level only"                 | "level" framed the planes as a ladder. Now a restriction on the plane: a service account may write data-plane grants and never a control-plane one        |
| closed | `terminology-usage.md`                 | "implied an owner was not one"                                      | The recorded reason for a rename was itself the plane conflation. That rename is now recorded as reversed, with the two planes stated                     |

---

## Tier 2: definitional sites where the planes are conflated

These set the vocabulary, so a reader builds the wrong model and carries it.

**Not re-verified, and the line numbers no longer point at anything.** These were surveyed by
position and the corpus has moved since. Several were swept in passing by the 2026-09-19 pass, which
rewrote the glossary's Role and Group entries, the two-gate table in `docs/concepts.md`, and the
role-holding language throughout `permissions-model.md`. Re-survey by reading rather than by
following these coordinates.

One from this tier is known open: `management-ui.md` offers **one role dropdown for both planes**,
which is the failure the split exists to prevent.

**The glossary's missing entries are added.** It had Submitter, Custodian, Owner and Admin, and no
`Viewer`, which is the role every other entry is defined against, nor `Curator`. Both now exist, and
the `Curator` entry carries the statement of the two planes.

---

## Tier 3: custodian scope, contradictory across six files

Two axes. The model's position is one category across every resource carrying it; the corpus
occupies three of the four corners. `to-discuss.md:344` says the two axes together decide whether
`custodianship.hold` is one column, one join table, or two, so this has a build consequence.

| Site                                                           | Says                                 |
| -------------------------------------------------------------- | ------------------------------------ |
| `permissions-model.md:846`, `terminology-usage.md:88`          | one category, all resources          |
| `admin-model.md:39`, `glossary.md:418`, `docs/concepts.md:302` | **one or more** categories           |
| `security-threat-model.md:64`, `audit-events.md:130`           | within **authorized resources** only |

`audit-events.md:130` is the sharpest: it carries `resourceId` in the required fields, so
resource-scoped custodianship is encoded in an audit schema rather than only in prose. It also names
an Owner as an actor who may appoint a custodian, which gives a single-resource authority the power
to seat a platform-wide one.

**Deferred deliberately.** `audit-events.md:179` says "nothing assigns a custodian in it [the first
release]", so none of this gates MVP. The cardinality is a governance decision rather than a
modelling one, and the people it concerns should be in the room.

---

## Tier 4: lists now incomplete

- **Missing `curator`**: every data-plane role list except `rabac-alignment.md:128`.
- **Missing `submitter`**: `docs/onboarding.md:113` ("The four participants") and
  `docs/concepts.md:296`. Both published, both omitting the role a data contributor holds. The
  onboarding's count and caption are load-bearing on surrounding prose at `:126` and `:128`.
- **Missing `delete`**: `delete` appears nowhere in the corpus as a capability. Sites that enumerate
  capabilities and are now incomplete: `security-workflow.md:301`, `rabac-alignment.md:130`,
  `permissions-model.md:290`, `glossary.md:174`, `api-keys.md:114` (which reasons about the
  vocabulary as read-only, an argument that changes shape once write capabilities exist).
- **Token examples**: closed. Every one rendered `["view", "download"]`, where `view` is the retired
  name for `read` and `download` became `export`. All now draw from the six: `aggregate`, `read`,
  `export`, `create`, `update`, `delete`.

---

## Stale claims about the token

Three sites describe a token carrying a role name. `decisions.md:1067` says "**No role name and no
ownership travel in the token**", confirmed at `security-workflow.md:296`, `glossary.md:364` and
`docs/concepts.md:700`.

- `plugin-integration.md:42` and `:439`: "resource ID mapped to role and category"
- `decisions.md:566`: "The Usher token already names the resources held and the role held in each"

A sharing check built on the third would look for a field that is not there. A per-resource singular
`role` field also cannot hold a principal who holds one role on each plane.

---

## Verified as already correct. Do not "fix" these.

`permissions-model.md:821` (the clearest statement of the rule in the corpus),
`permissions-model.md:843`, `permissions-model.md:954` ("The shape instance governance takes", which
already has a plane column), `glossary.md:425` (the Owner entry), `docs/onboarding.md:128`,
`README.md:10`, `decisions.md:1302`, `decisions.md:555`, `uac-flows-traceability.md:14` and `:104`.

Two checked and discarded: `docs/why-usher.md:97` describes Zanzibar's model, and
`docs/iam-primer.md:40` is OAuth's "resource owner", which is the data subject. The second is a live
collision for a reader who meets the primer before the glossary, and the Disambiguations section has
no entry for `owner`.
