# Documentation review patterns

Defect classes found by reading the onboarding artifact aloud against a non-technical audience.
Two uses: a convention proposal for agentics, and a restructuring pass over this repository's own
documents. Open and appended to as review continues.

**Why these are worth recording rather than just fixing.** Density, affirmative framing and the dash
rules had all been run over this same text, and none of them caught any of what follows. Those
checks are mechanical: a script counts words per sentence, greps a character, matches a phrase. Every
class below needs a reader deciding whether a sentence can be understood, which no grep expresses.
That makes them a different kind of rule rather than more of the same, and it is the reason the
existing conventions passed a document that a first reader found nineteen problems in.

## How to read the review itself

Two rules about receiving this feedback, which are separate from the defect classes and matter more,
because getting either wrong wastes the reviewer's effort.

**A comment's anchor is where the defect was noticed, not the scope of the fix.** Developer-stated,
and it inverts the default: assume every comment may describe a class, check whether the class
recurs, and report the scope found rather than the anchor fixed. The check runs over the whole
document and over this repository's own documents, since a defect visible in a general-audience
document is usually present in the design documents that preceded it.

Confirmed by checking, after three comments had been treated as local:

| Reported at one place | Actually recurred |
|---|---|
| Visibility standing in for the whole scope | Six times across five design and published documents |
| Actors ordered by institutional rank | The three-management-roles table, ordered Admin, Custodian, Owner |
| A term used before introduction | `categories` first appeared inside the token example, explained only in the table below it |

Two of those three were outside the artifact entirely, which is the half a local fix cannot reach.

**A suggested wording that collides is evidence the existing term is ambiguous there.** Developer-stated,
and it is the better reading: the reviewer reached for a colliding word because the word already in
place was reachable from two directions, so the collision is a finding about the document rather
than a slip by the reviewer. Two instances, and both diagnose real vocabulary problems:

- "were last validated" for a field recording when permissions were computed. "Validated" was
  reachable because the document describes two different check-like operations, verifying a token
  and establishing a grant set, without separating the vocabulary for them.
- "open access only" for an empty category list. Reachable because the tier named **Open** and the
  concept "the unrestricted content of a dataset" sit very close together, and the document uses
  both. An empty list actually means the second, which is wider than the tier.

So the response has three parts rather than one: adopt the diagnosis, check the phrase against the
document's defined terms, and where a third wording is needed, record the collision as a candidate
defect in the term itself. Both instances above are worth checking in the design documents, since
neither ambiguity originated in the artifact.

**A metaphor removed in one place has relatives.** Replacing "seals" with encryption left five
instances of the same envelope-opening figure standing, including "openable by that one alone" and
four variations of "fails to open", all introduced by the same instinct and none caught by the fix
that targeted its headline. Reported by the developer as jargon two edits later. A vocabulary
correction is a sweep over the figure, not a substitution at the reported site.

## The two axes

Every class sorts under one of two failures, and naming the axis is more useful than the list.

**Resolvability.** The sentence asks the reader to supply something they have not been given: a
definition, a referent, a content, an antecedent, a meaning. Classes A, B, C, E and G.

**Fidelity.** The sentence is true but narrower or vaguer than the thing it describes. Classes D and
F.

## Resolvability failures

### A. A term arrives before it is introduced

An identifier or a dependency is used, sometimes repeatedly, before the text says what it is. The
sharper half is that **an introduction owes two things, not one: what the term is, and why it is the
one being used.** A document can gloss a dependency correctly and still leave a reader asking why
that dependency and not another.

Instances: an identity provider carried three sections of argument before being introduced; the
central data object was named after the five steps that describe handling it; an identifier field
did not say which system issues it; capitalized names in an example did not say whether they were
dataset identities or permission labels.

### B. A demonstrative with more than one candidate referent

`this`, `that` and `it` opening a sentence must resolve against exactly one thing in the preceding
clause. **Forward references are the worst case**, because a reader resolves backward by default:
"This is the mechanism that carries a decision" at the head of a section points forward, and reads as
a claim about the section just finished.

The pile-up matters as much as the single case. Two sentences beginning `It` in succession, both
correct, still make a reader stop and check.

### C. A sentence that asserts a property without naming its content

The reader is told something is complicated, or common, or misunderstood, and left to supply what.
Includes appeals to unspecified third parties: "almost every misunderstanding comes from", "people
often think". Those name no one and can be neither checked nor disagreed with.

The test that works: if a sentence's job is to say something matters, it has to say what the thing
is in the same breath.

### D. Scope stated narrower than the system

Covered under fidelity below; listed here because it was reported twice before being recognized as a
class.

### E. A contrastive construction whose antecedent was never established

"Even if none of that ever changed" asserts that change has been discussed. Where the preceding
paragraph listed only static conditions, the reader hunts for a discussion of change that is not
there. Counterfactuals, concessives and "unlike" constructions all carry this: they claim their
antecedent as given.

### G. Absence carrying unstated meaning

An empty list, a null, a missing entry. Where emptiness means something specific, the meaning belongs
at the example, not only in prose further down. An empty collection reads as "all" to about as many
readers as it reads as "none".

## Fidelity failures

### D. Scope stated narrower than the system

Where a document states what the system governs, the statement must cover the whole of it. Repeated
description of an authorization system in terms of visibility alone understates it, since actions are
governed too.

**The reporting pattern is itself the rule.** The second instance was reported as "second time I
point this out, so seems likely there may be other instances". A second occurrence of one narrowing
is evidence of a class rather than a second defect, and the response is a pass over every instance
rather than a second local fix.

### F. Softened vocabulary where a precise term is clearer

Plain language and vague language are not the same thing, and this is the class most likely to be
introduced *by* an attempt at plainness. A metaphor chosen to avoid jargon ("sealed" for encrypted)
buys nothing when the audience can carry the real word, and costs a reader who now wonders whether
something other than encryption is meant.

Two related cases. A word with a common technical meaning elsewhere in the same document invites the
wrong one: "read" for computed collides with reading from a data layer. And where a precise term
exists but collides with another concept in the same document, neither the vague word nor the
colliding one is right: a third word is.

## Presentation, neither axis

### H. Ordering by institutional rank rather than reader relevance

Listing a platform administrator before a community custodian framed community governance as the
exception to central control, when the design makes it the point. Order actors by which one the
reader will meet or care about.

### I. A governing qualification presented as an interruption

A paragraph that qualifies everything after it needs a connective to what precedes it. Labelling it
("Note:") makes it read as parenthetical when it is actually governing, which is the opposite of the
intent.

## Recorded as unresolved rather than as a pattern

**Lay word against domain word.** Whether a lay-facing document should say "dataset" or the
deployment's own term ("cohort") is a live tension, not a defect. The generic word is consistent and
readable and carries less meaning; the domain word is precise and commits a general-audience document
to one deployment's vocabulary. Currently resolved toward the lay word, with the glossary carrying
the mapping.

## The information-delivery order this establishes

The artifact's order is the one to propagate, because it was arrived at by a reader rather than by an
author:

1. What the system is, and the question it answers
2. The problem it exists for
3. The two questions and which software answers each, since that distinction gates the rest
4. The access tiers, as the organizing idea
5. The mechanism, and the shape of the decision it carries
6. The decisions, each with its reasoning
7. What the system is not
8. Current status
9. Vocabulary, last, as a reference rather than a prerequisite

**Vocabulary last is the load-bearing part.** `docs/concepts.md` currently opens with theory and
definitions and reaches the access tiers sixth, which asks a reader to hold abstractions before
being given anything to attach them to. `docs/intro.md` orders itself problem-first and does not
present the tiers as the organizing idea at all.

Restructuring against this order is tracked in `.dev/roadmap.md`.
