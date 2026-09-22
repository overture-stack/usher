# Documentation review patterns

Defect classes found by reading the onboarding artifact aloud against a non-technical audience, and
since extended by classes found the same way in other documents of this corpus. Two uses: a
convention proposal for agentics, and a restructuring pass over this repository's own documents. Open
and appended to as review continues.

**Why these are worth recording rather than just fixing.** Density, affirmative framing and the dash
rules had all been run over this same text, and none of them caught any of what follows. Those
checks are mechanical: a script counts words per sentence, greps a character, matches a phrase. Every
class below needs a reader deciding whether a sentence can be understood, which no grep expresses.
That makes them a different kind of rule rather than more of the same, and it is the reason the
existing conventions passed a document that a first reader found nineteen problems in.

## Two ways a review's own findings go wrong

Both came out of reviewing this corpus rather than reviewing a document, and both are about the
reviewer.

**A correct result produced by an inherited constraint is indistinguishable from a correct method.**
The legibility pass correctly left `AGENTS.md` and `CLAUDE.md` alone, because this project's density
table had already exempted them as agent-facing and condensed on purpose. Nothing in the method
distinguished audience; without that table both files would have been swept and a human-facing rule
applied to deliberately terse ones. A clean outcome reads as evidence the method worked, and the
moment the constraint is absent is the moment nobody is checking. Stated by the agentics owner in
the exchange that produced it, from this instance.

**A relayed measurement loses its caveats, and a number is the worst case.** A count of defects in a
peer's corpus was repeated here as established fact and an argument built on it, before either side
had checked what the measurement was scoped to. It turned out to be scoped to agent-facing files and
the instances were not defects. A number invites this specifically because it looks like a fact
rather than a claim: the sentence carrying it is first-hand while its provenance is not. Both sides
own a half, and the count's author owns the earlier one.

## Ranking back-reference candidates rather than listing them

A bare list of matches gives a reviewer no order to work in. The usable proxy is **how far a match
sits from the start of its paragraph**, since a placeholder near the start has almost nothing
preceding it to refer to.

What the proxy is honestly: a ranking. A match eighty words in can still have no plausible referent,
and one five words in may legitimately point at the paragraph above, so depth does not decide
anything. It orders the queue, which is what a candidate-raiser needs. Measured against the agentics
corpus the distribution spread rather than clustered, six matches within ten words of a paragraph
start against twelve beyond eighty, which is the condition for an ordering being worth printing at
all.

## Re-running this check

No check script exists in this repository, so the passes described here were ad-hoc. Whoever repeats
one needs four things, each of which was got wrong once already:

1. **One extraction, shared.** Two checks over one corpus must consume the same paragraph list, or a
   difference between their outputs is indistinguishable from a difference in what they looked at.
2. **Three states for a block marker**, not two. A bullet ends the preceding paragraph _and_ starts
   one of its own that gets measured. Welding bullets onto neighbouring prose inflates the count;
   discarding them undercounts it, and only inflation invites scrutiny.
3. **Paragraphs before sentences.** Splitting sentences per line returns nothing on hard-wrapped
   prose.
4. **Fenced and indented code both stripped.** A regex covering only fences admitted an indented
   block here and produced a phantom eighty-five-word sentence.

And when a count moves, open an item rather than trusting the total. An aggregate is a single number
with no structure to contradict it, so a wrong one looks exactly like a right one.

## How to read the review itself

Two rules about receiving this feedback, which are separate from the defect classes and matter more,
because getting either wrong wastes the reviewer's effort.

**A comment's anchor is where the defect was noticed, not the scope of the fix.** Developer-stated,
and it inverts the default: assume every comment may describe a class, check whether the class
recurs, and report the scope found rather than the anchor fixed. The check runs over the whole
document and over this repository's own documents, since a defect visible in a general-audience
document is usually present in the design documents that preceded it.

Confirmed by checking, after three comments had been treated as local:

| Reported at one place                      | Actually recurred                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Visibility standing in for the whole scope | Six times across five design and published documents                                       |
| Actors ordered by institutional rank       | The three-management-roles table, ordered Admin, Custodian, Owner                          |
| A term used before introduction            | `categories` first appeared inside the token example, explained only in the table below it |

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

## Which readers a class costs, and why the ratio was structural

Every class here reduces one of two costs, and which one decides whether it applies to a document
written for people or to one written for an agent.

**Effort is a human cost.** A person scans, so resolving a placeholder noun means scrolling back. An
agent reading linearly is already holding the referent and pays nothing.

**Ambiguity costs every reader.** A term never introduced, a demonstrative with two candidates, a
claim whose content is missing: none of those resolve on a second pass by anyone.

So the resolvability and fidelity failures below are universal, while ordering by rank and a
governing qualification presented as an interruption are human-scoped. This project's own density
table had already exempted `AGENTS.md` and `CLAUDE.md` as agent-facing and condensed on purpose,
which is the same judgement reached without the reason stated.

**This explains the abstract-back-reference ratio, which had only been an empirical figure.** Of 56
instances found in the design corpus, sixteen were defects and twenty-nine were not, and the split
was made by judgement rather than by rule. The two costs name the rule: a back-reference whose
referent sits one clause away costs effort and only to a scanning reader, while one whose referent
is absent or plural is ambiguity and costs everyone. The twenty-nine were the first kind and the
sixteen were the second.

That is worth more than the precision figure it replaces. A ratio told us to build a check that
raises candidates rather than condemns matches; the distinction tells us what separates a candidate
from a defect, which is what a reviewer needs at the moment of judging one.

## The two axes

Every class sorts under one of two failures, and naming the axis is more useful than the list.

**Resolvability.** The sentence asks the reader to supply something they have not been given: a
definition, a referent, a content, an antecedent, a meaning. Classes A, B, C, E and G.

**Fidelity.** The sentence is true but narrower or vaguer than the thing it describes. Classes D and
F.

**Letters run in the order classes were found, not by axis**, so each section's letters have gaps and
a missing one is defined in another section rather than absent. D was reported twice before being
recognized as a class, which is why it appears in the sequence before the axis that holds it.

## Resolvability failures

### O. The model defined on the stand-in rather than on the term

A document written for a lay audience substitutes a plain word for a model term, which is right. The
defect is where it then puts the definitions. **Definitions belong on the word the system uses; the
stand-in is a pronoun and can only be used once its referent exists.** A document that explains the
mechanism in terms of the stand-in has built the reader's model on a word the system does not have,
and a reader who later meets the real term has two concepts to reconcile where there is one.

**The typography compounds it.** Where bold-on-first-use marks a term being defined, and the document
uses that consistently for real terms, a stand-in in the same typography is indexed as a term by a
reader who has correctly learned the convention. Being right about the convention is what makes them
wrong about the word.

**Found by a reader, and the crux was not the one first proposed.** `docs/onboarding.md` said
"dataset" throughout where the model says `resource`, bolded it on first use beside `enforcement`,
`instance` and `policy`, and disclosed the substitution only in the glossary at the end. A
non-technical reader took `dataset` as a defined thing and needed a long conversation to resolve two
terms into one. The first repair added the disclosure early, which was not enough: the next paragraph
went on to define the whole mechanism on the stand-in, so the document contradicted its own
disclosure within three sentences. The repair that worked was moving the definitions onto the term
and letting the stand-in carry the casual references afterwards.

**The check is two passes and both are cheap.** List every word the document bolds on first use and
ask whether the model has that word; anything it does not is a stand-in. Then read only the passages
that define, name a structure, or state a rule, and confirm each uses the term rather than the
stand-in. The first pass finds the words, the second finds where they do damage.

**A second failure rides along with this one, and it is the more expensive one.** Having taken the
stand-in as a term, the same reader read categories as subdivisions a dataset owns, which is the
natural reading of "a dataset lists the categories it carries". Categories are defined once for the
instance and each resource declares which apply. The containment reading survives contact with
everything except custodianship, which is only coherent because one category is one thing across
every resource, so a reader holding it would have failed later and further from the cause. **A
misreading that survives most of a document is worse than one that breaks immediately**, and where a
stand-in has already blurred what a thing is, the relationships between things are the next place to
check.

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

### E. A contrastive construction whose antecedent was never established

"Even if none of that ever changed" asserts that change has been discussed. Where the preceding
paragraph listed only static conditions, the reader hunts for a discussion of change that is not
there. Counterfactuals, concessives and "unlike" constructions all carry this: they claim their
antecedent as given.

### G. Absence carrying unstated meaning

An empty list, a null, a missing entry. Where emptiness means something specific, the meaning belongs
at the example, not only in prose further down. An empty collection reads as "all" to about as many
readers as it reads as "none".

### J. A negation the following positive makes redundant

"Access is never granted over data directly. It is granted over a dataset." Once the second sentence
lands, the first carried nothing: a reader learns the unit of access from the positive statement and
the negation only delayed it. Reported by the developer, who tried rewriting it as a single sentence
and found the result self-contradictory, which is the tell.

**This is narrower than "opens with a negation", and the difference decides whether a check is
useful.** A sweep for paragraph-opening negations across the corpus returned 29 matches and nearly
all are load-bearing: "Usher is not an authentication service" and "Usher does not know the schema of
the data it protects" are the content, not a delay before it. The test is whether the following
positive statement makes the negation redundant, which no pattern expresses. Grep locates candidates;
only reading separates them.

### K. A qualifier carrying an argument before the argument is made

"The second question deserves a single answer." The word doing the work is _single_, and nothing yet
established why one answer matters rather than several, so a reader either accepts it on trust or
stops. Adjacent to class A but distinct: A is about a term used before it is defined, this is about a
word doing argumentative work before its argument exists. The repair is to state the reason and let
the qualifier follow from it, not to soften the qualifier.

Only one instance was found in either corpus, so this is recorded as a test rather than a sweep.

### L. A correction whose referent is a conversation, not the document

A sentence tells the reader that something "was recorded as" or "was described as" a claim, or that
"an earlier note implied" one, and the document never made that claim. The referent is a turn in a
conversation with the developer: the error was made there, corrected there, and the correction then
written into a file as though the file had held it. No reader can resolve it, because the superseded
claim exists nowhere in the corpus or in its history.

**Three instances, all surfaced by the developer asking what one of them pointed at.** A roadmap line
correcting "an earlier note here" that the same uncommitted edit had replaced, where the committed
text it displaced was correct; a traceability file correcting "an earlier reading" of virtual-cohort
sharing, in the commit that created that file; and a decision correcting a record of owner permission
no document ever carried, the documents recording owner _notification_ instead, which is a
compensating control rather than a grant gate.

**Unlike most classes here, the check is mechanical.** Grep for `was recorded as`, `was described
as`, `an earlier note`, `earlier reading`, `previously stated`. For each hit, grep the corpus for the
claim being corrected and run `git log -S` on it. A hit with no referent in either is a defect. Note
that a file's own history often cannot supply one: two of the three instances sat in files whose
creating commit already carried the correction.

**Where the correction records a rejected alternative, reframe rather than delete.** Deleting loses
something a decisions file exists to keep: what was considered and why it lost. The fix is to move
the referent from the draft to the option. "An earlier version of this document computed exclusions
from the configured category set" becomes "**Rejected: computing exclusions from the configured
category set**", which carries the same information and points at something a reader can evaluate
instead of at a version they never saw. Eight instances in this corpus took that repair.

**The repair is to state the fact positively and delete the correction.** Where the superseded claim
is worth recording, name where it lives, as FR-09 in `brd-traceability.md` does for notification. A
correction only serves a reader who could have held the wrong belief, and a belief that existed only
in a chat log has no such reader.

The cause generalizes past documentation: a correction arrives in conversation, and the document is
what gets edited in response, so the document is where the correction reads as belonging.

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
introduced _by_ an attempt at plainness. A metaphor chosen to avoid jargon ("sealed" for encrypted)
gains nothing when the audience can carry the real word, and costs a reader who now wonders whether
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

## Content addressed to the wrong reader

Both classes here were found in the glossary, both were written by the agent maintaining it, and both
share class L's mechanism: something arrives in conversation, and the document is what gets edited in
response. L covers corrections. These cover rules.

### M. A definition whose substance is what the term is not

A glossary entry leads with the misreading it exists to prevent, and the reader has to get past a
negation before reaching what the word means. Instances: `Deployment` opening "per deployment is the
scope reached for by default, and it is often the wrong one"; `Catalogue` opening "a catalogue is not
a governance boundary"; `Subject` and `Record` each carrying a parenthetical of the
form _(reserved for X, never for Y)_; a borrowed-terms table whose Usher column began "**not** an
Usher group", "**not** an Usher role".

**The negation is usually a true and useful fact wearing the wrong clothes.** A catalogue really is
not a governance boundary. Stated positively the same fact lands harder and reads as knowledge rather
than as a scolding: one catalogue's records belong to many resources, so governance runs per
resource. The repair is to find the positive fact the negation was standing in for, and where the
negation carries no positive fact at all, it was a usage rule rather than a definition, which is
class N.

**The check is per entry, not per document.** Split each entry into sentences and look at the first
one: a definition that has not said what the term denotes by the end of its opening sentence is a
candidate. A whole-document ratio hides this, because a long entry with one positive sentence and
three negative ones scores the same as three short clean entries.

### N. A rule for the writer inside a reference for the reader

A file whose job is to answer "what does this mean" accumulates entries answering "which word should
I write here". They arrive one at a time, each next to the term it protects, each individually
defensible, and the drift is invisible until someone looks up a term and gets a paragraph of writing
guidance first. Instances in one glossary: an identifier-typography convention in the preamble,
"reserve the word for this relation", "resist naming the role-level set separately", "before writing
per deployment, check whether one of those three is meant", "say clause when the shape matters", and
a retired-terms list.

**The tell is the mood of the verb.** A definition is indicative and describes the system; a usage
rule is imperative and directs the writer. Grep for imperatives at the start of a bolded lead:
`reserve`, `resist`, `avoid`, `prefer`, `say`, `write`, `check whether`, `before writing`.

**Why the agent writes these specifically.** Each rule was the residue of an error the agent had just
made, and the term's own entry is where the fix reads as belonging. But the agent is not the
document's reader. A rule about how to write belongs in the agent-facing working space, which in this
repository is the atlas, and the reference keeps only what a person looking up a word came for.

## Recorded as unresolved rather than as a pattern

**Lay word against domain word.** Whether a lay-facing document should say "dataset" or the
instance's own term ("cohort") is a live tension, not a defect. The generic word is consistent and
readable and carries less meaning; the domain word is precise and commits a general-audience document
to one instance's vocabulary. Currently resolved toward the lay word, with the glossary carrying
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
