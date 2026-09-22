# Onboarding document: what the audit left open

_Three independent reading passes over `docs/onboarding.md` on 2026-09-17, each briefed only to read
as the document's intended audience: a non-technical reader who governs data and has never seen the
system. Everything the three converged on has been applied and is not repeated here. What follows is
what remains, with a content anchor beside each line number, because the document has been
republished repeatedly and the numbers move._

**What the method was worth, stated once.** Convergence ranked the findings; it did not filter them.
Every item three passes agreed on was worth fixing, and the single most valuable finding came from
one pass alone: an unprompted caveat that its file list might be incomplete, which is what exposed
`git ls-files` missing five untracked files and invalidated a published count. The rule that came out
of it is in [subagent-delegation.md](../subagent-delegation.md): delegate the reading, never the
framing. The passes also surfaced the convoluted sentences faster than any of my own re-reads did,
which is the one thing to keep doing.

---

## Open items, ranked

| Where | Anchor | The finding |
|---|---|---|
| `:95` | "the first instance defines exactly one category" | The sentence carries a load-bearing qualifier at the end of a long paragraph about a trade. A reader reaches "exactly one category" and cannot tell whether that is a design limit or a fact about a deployment. It is the second, and the sentence does not say so until after the point it is making |
| `:18` | the Status paragraph | A wall of product names (iMS, Arranger, Lyric, SONG, Score, Muse, Singularity) inside the second paragraph a reader meets, none of them introduced. The information is right and the placement is wrong: it is a reader's first impression of the document, and it reads as internal roadmap rather than orientation |
| `:178` | "standard JWT claims, defined by the same specification every OIDC system uses" | `JWT`, `OIDC`, `sub`, `iss`, `aud`, `exp` in one sentence, in a document written for someone who governs data rather than builds systems. The sentence is doing the right work (most of the object is not Usher's invention) and could do it without requiring the acronyms |
| `:115` | the `Reach` column header | `Reach` is Usher's own word, used as a table header without ever being introduced, and the table is where a reader learns the roles. Two passes read the column as being about network access |
| `:38` | "each holding data under different schema shapes" | `schema shapes` is not a term this document defines or needs. It is standing in for "each application holds different kinds of data", which is what the sentence means |

---

## Two whole-document passes not yet run

Both are single-word sweeps over the published document, and both exist because the word is doing
more than one job in a document whose whole purpose is to be unambiguous to a first-time reader.

**`instance`, 19 uses across 18 lines.** The word carries the design's meaning (one deployment of the
control plane, with its own configuration) and ordinary English's meaning (an example, an occurrence)
in the same document. A reader who meets the ordinary sense first will carry it. This is the word that
produced "an 'instance' of what? the very opener is already needing context that isn't given", and
the fix that paragraph needed was not a rewording but the recognition that a modular platform does
not make system-wide decisions, so a sentence attributing one to "the platform" was wrong rather than
unclear. The sweep is to find every other place the same collapse happens.

**`application`, 60 uses across 39 lines.** The rule is settled and recorded in
[terminology-usage.md](terminology-usage.md) § Ushered is the word, and the noun after it varies
plugin is an **ushered** application, and bare `application` may imply any other dependency a service
happens to have, such as Elasticsearch, Postgres or Keycloak. 60 uses is too many for every one to be
correct, and the ones that are wrong are wrong in the direction of overstating what Usher governs.

---

## Applied, recorded so it is not re-litigated

- **The sovereignty contradiction** was resolved by a decision rather than by editing: nothing is
  reachable unless a category is granted, and an administrator gets no data visibility without an
  explicit self-grant. Two passes proposed softening the claim; a third proposed deleting it. The
  decision went in a direction none of them proposed, which is the case for keeping the framing.
- **`open` as a counter-category** came out of a finding about the word "portion". The finding was
  real and its target was wrong: the problem was not the word but that `open` is abstract where every
  other category is a field value. That is now a decision in `decisions.md`.
- **"partition", "set" and the derivational register** are all removed from this document. `set` is
  barred here specifically because an Arranger Set is a real object a reader may already know.
