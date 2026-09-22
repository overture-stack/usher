# Terminology usage rules

Which word to reach for, and how to set it. Companion to
[`.dev/design/glossary.md`](../../../design/glossary.md), which says what each term means and
nothing about how to write with it.

**The split is the point.** These rules accumulated inside the glossary itself, where each one read
as part of a definition, and a reader looking up "category" got a paragraph of writing guidance
before reaching the sentence saying what a category is. A glossary answers "what does this word
mean"; this file answers "which word do I write here". Anything of the second kind that appears in a
design document is misfiled, however true it is.

## The register: Simplified Technical English, partially adopted

Usher's documents follow ASD-STE100, Simplified Technical English, where it serves a reader and not
where it fights one. STE is a controlled English specification from the aerospace and defence
industries, written so that maintenance documentation reads the same way to every reader including
those working in a second language. It pairs a restricted dictionary with writing rules. It is
versioned and proprietary, so check the current issue before citing any specific rule or count.

**Adopted, because these are what this corpus keeps rediscovering the hard way:**

| Rule | Already visible here as |
|---|---|
| one word, one meaning | the whole terminology pass, and the reserved-sense table below |
| no synonyms for variety | the retired list below: requester, caller, privilege, approve |
| consistent terminology, even when repetition reads dull | the same, applied across documents rather than within one |
| active voice, with the actor named | who acts is the thing these documents most often drop |
| noun clusters of at most three words | `user_group_members` became `group_users` for exactly this |
| do not drop words to shorten | a sentence needing typography to parse is rewritten, not marked up |
| short sentences, one idea each | the density limit these documents already carry |

**Not adopted, and the reason matters.** STE's approved dictionary runs to roughly a thousand words
and exists for procedures: do this, then do that, and here is what goes wrong. These documents
mostly record *why* a decision was made, which needs subordinate reasoning and needs terms of art
that no general dictionary contains. So the dictionary rule is replaced by the local rule below: a
term of art is either defined or not used. That serves the same purpose, admitting `predicate` and
`resource field` while still refusing an undefined word.

**And the governing limit, which outranks every rule above.** If applying one makes a passage too
terse or too dry for a person to want to read it, the passage wins. These documents are read by
people deciding things, not by technicians following steps, and a reader who stops reading has been
failed more completely than one who meets a long sentence.

### One word, one part of speech: tested and not adopted

STE separates a word's noun and verb senses because a technician following steps in a second
language can trip on "test the valve" against "the test". This corpus has never had that problem.
Every collision it has actually suffered was one word carrying two **meanings**: catalogue,
permission, principal. Every candidate this rule surfaces is one word with one
meaning in two grammatical roles, and each was tested against the corpus:

| Word | Why no replacement survives |
|---|---|
| grant | deliberately both, with no second word for the act. `approve` was tried and retired |
| record | "store" names the container, "write" names the keystroke, and neither carries making a durable entry |
| filter | "narrowing" and "selection" are already nouns here, 21 and 14 times, so swapping moves the collision |
| access | the verb is better replaced by naming what is done: view, download, query |

So the rule is dropped and **one word, one meaning** carries the weight, which is what has been doing
the work all along.

**`scope` was in that table and has been removed, because the evidence clearing it was wrong.** The
row read that it had five uses in the whole corpus and was precise in all of them. A survey run
against the files found 211 uses in prose across 32 files, in at least eight senses, which is not a
word with one meaning in two grammatical roles. It belongs in the open list below rather than in a
table of words that survived the test. Worth keeping as a lesson about the table itself: every other
row here rests on a count, and this is the one that was checked.

## A term of art is either defined or not used

**Before writing a word that names a concept rather than describing one, check the glossary.** If it
is not there, one of two things is true. Either it will be used repeatedly, and it earns an entry;
or it appears once, in which case say the thing plainly and the word is not needed at all. A word
used once never earns a definition, so the choice is really between defining it and dropping it.

**The reliable tell is that the word is doing the work of a clause.** Each of these was caught by the
developer rather than by any check, and in every case the plain version was shorter than the
definition would have been:

| Written | Meant | Now reads |
|---|---|---|
| restrictions compose monotonically | adding one can only ever take access away | the plain clause, and the abstract one deleted as redundant |
| the permissions a grant confers | the permissions it has attached | carries, or gives |
| the token's `exp` is clamped to | set to whichever comes sooner | a token never outlives the first grant on it to expire |
| the quantifier is over the data's requirements | the word "every" applies to what the data requires | the plain sentence |
| this category gates the whole dataset | it is a condition of reaching any of it | the document's own phrase, condition of entry |
| a custodian's authority follows the data | it covers one category across every dataset carrying it | the full statement, which is also more accurate |

**Why it keeps happening.** The word feels like precision and is actually compression: it stands in
for an explanation rather than delivering one, and it reads as confident to whoever already knows it.
In a corpus whose central problem is that terms are contested, a new undefined one is the most
expensive kind of shortcut.

Both unresolved terms are now settled, and both went the same way.
`quantifier` was rewritten in place, since "matches when any element matches rather than requiring
every element" says it without the word, and the sentence carrying it also lost "existential" and
"universal" doing the same job twice. `atomic` kept the one sense `permissions-model.md` defines, an
operation that completes entirely or not at all, and the undefined second sense became the plain
phrase: a resource cannot be divided.

## Marking a term as an identifier

Where a word names a literal field, column or table, set it in code font: the `grants` claim, the
`permissions` column, the `grants` table. Where it names the concept, leave it plain: a
grant names a dataset and a category. Compounds are concepts rather than identifiers, so "grants
token" and "permissions payload" stay plain.

**If a sentence needs the typography to parse, rewrite the sentence.** "Assigning `grants` grants
permission" is legible only to someone looking closely, and not at all to someone hearing it read
aloud. Code font identifies; it does not disambiguate prose, and a sentence that depends on it has a
structural problem the markup is hiding. Recast it so the two senses never meet: "granting a category
to someone creates a `grants` row" says the same thing with nothing to trip over.

**The onboarding document takes no code font in prose**, because its readers are not engineers.
Field names appear there in bold, inside the token discussion, where the worked example supplies the
context that code font would otherwise have to carry.

## Words reserved to one side of a distinction

Each of these has a second, natural-sounding sense that the model needs kept out. The table gives
the reserved sense and the word to use for the other one.

| Word | Reserved for | For the other sense, write |
|---|---|---|
| principal | whoever is asking, at request time | **holder**, where what is meant is whoever a grant is recorded against, which includes groups |
| subject | the `sub` claim and the string it carries | **principal**, wherever the actor is meant rather than one of its identifiers |
| record | one row of data | **grant**, or **approval** in a reader-facing document. "Grant record" is unambiguous and stays |
| permission | the vocabulary entry, at either layer | nothing. There is no separate word for the role-level set |
| approval | the process preceding a grant | **grant**, for the act and its record inside Usher |
| state | a value in a defined set that Usher's own store holds: a grant's `pending` or `active`, a revocation recorded against a principal | **status**, for a condition read or derived when asked, and which can come back unknown: revocation status the bridge cannot confirm, admin status read from the IdP token, an HTTP status code |
| authorization | holding permission, the standing state a grant creates | **access**, for the request-time result. The thing resolved is an **access decision**, and enforcement carries it out |
| holder | uses that name what is held: a **grant holder**, a **token holder**, an account holder | **principal**, **group** or **owner**, wherever the word would stand alone. Bare, it does not say what is being held, and the corpus had it meaning four different things, an owner most often |
| burst | a spike in traffic, and cache behaviour under one | **rate**, wherever what is meant is how many grant operations one actor performs within a window |
| authorization service | other systems that carry the name: EGO, Keycloak Authorization Services, ELIXIR AAI | **access control service** for Usher, and **access control plane** for its place in the architecture |
| dataset | reader-facing prose, where it is the lay term for a resource | **resource**, in every design document. Listing an instance's own word is a different act and stays as it is: dataset sits beside study, project and programme there |
| set | a saved set in Arranger, which is a list of records a person picked and kept | **nothing here.** Do not use it for a segment of Usher's data: a resource, a category, or the records either selects. Those have their own words, and borrowing this one puts an Arranger feature in the reader's mind |
| catalogue | a body of data a service holds, as in Arranger: one schema, and so the scope a resource field name resolves in | **list**, wherever a list of things is what is meant, as the events Usher emits are. **vocabulary**, for the capability vocabulary, which is a defined term. **Arranger catalogue**, written qualified every time, for the `catalogueId` container that can hold more than one catalogue. **listed**, where the verb was meant |

**Why catalogue needed the most work of these.** It had reached four senses. One was a list of
events, which gives the word up to `list`. One was the capability vocabulary, which is a defined term
and keeps its own word. The remaining two are both bodies of data but not the same unit, since one
`catalogueId` can compose a second queryable type backed by an unrelated index, so the bare word
keeps Usher's unit and Arranger's is qualified. That split was already implied by the glossary and
contradicted in `plugin-integration.md`, which asserted in one place that Usher has no such concept
and in another that a body of data is its own. The verb belongs here rather than under the
part-of-speech rule above: `catalogued` meant listed, which is not the noun's meaning in a second
grammatical role but a third sense.

**Why authorization gives way to access in this compound.** Being authorized does not mean reaching
anything; it means holding permission to. So the decision resolved at request time is about access,
and it pairs with enforcement, which is what turns it into a result. The corpus previously carried
`authorization decision` and `access decision` for one concept, and while both existed a sentence
could assert something of one that was false of the other with nothing to catch it. Quoting another
system stays the exception, since Cerbos and the wider literature both say "authorization decision"
and reproducing their term is correct.

**Why the principal and subject lines matter most.** Both are one-to-one today, and both stop being
so under a change the architecture deliberately keeps open. A group never asks, so writing
"principal" where "holder" is meant makes a group into something that asks. A second identity
provider gives one principal two subjects, so writing "subject" where "principal" is meant builds in
an assumption that holds only while there is one IdP.

**Why `membership` was retired rather than reserved.** It was first split by verb, so that a user
belonged to a group and a group had a membership in a resource. That removed the collision without
fixing the word, which named a relation while saying nothing about what the relation entails: a user
with a role and no category grant reaches nothing, and "membership" implied otherwise. Naming both
sides says it plainly, which is what `group_users` and `resource_categories` do. Quoting another system
stays the exception, since Keycloak and EGO both say "group membership" and reproducing their term is
correct.

## The derivational register is barred

**Where it comes from.** Mathematics and theoretical physics, by way of formal linguistics and
analytic philosophy. "The conservation law falls out of the symmetry." "The constraint falls out of
the theory." It is the idiom of a derivation yielding something nobody had to stipulate.

**Why it keeps appearing in documents like these.** It is the register of writing *about*
derivations, and a design document is one: premise, mechanism, consequence. So it sits one step from
what these documents legitimately do, which makes it the easiest register to slip into and the
hardest to notice. Three separate instances were caught here in a single day and each was fixed on
its own, because nothing connected them until the register was named.

**Why it fails harder than ordinary jargon, which is the argument for barring the whole register
rather than listing offenders.** Most jargon is opaque, and a reader who does not know it knows that
they do not know it. This register reads as ordinary English and inverts. "Falls out" gives a reader
without the idiom *falls out of the set*, which is the opposite of what the writer meant. "Buys"
reads as a purchase. "Turns on" reads as activates, which in a document about enforcement is worse
than meaningless. A phrase that silently means the opposite is more dangerous than one that means
nothing, because nothing about it prompts a second look.

| Barred | Write instead |
|---|---|
| falls out of, drops out | follows from, is a consequence of |
| what this buys | what this gives, what this achieves |
| turns on | depends on |
| goes through (of an argument) | holds |
| cashes out as | means |
| obtains (of a relation) | holds, is true |
| for free | at no cost, without extra work |
| reduces to, collapses into | is the same as, becomes |
| modulo, up to | apart from, ignoring |
| trivially, by construction | say why, in words |
| on pain of | otherwise |

**Most of it is greppable**, unlike the plain-word rule above, which needs a glossary lookup. That is
why this one is a check and that one is a judgement.

**Measured elsewhere, and the measurement narrows the claim.** This rule was offered upstream for
general use and measured against a second corpus there before adoption. Of 23 matches, roughly a
third were the register and the rest were ordinary English that the patterns caught anyway. Two
specific findings are worth keeping, because both weaken arguments made above:

- **`for free` does not invert.** A reader without the idiom gets approximately the right meaning, so
  it fails the criterion this section uses to justify barring the whole register rather than listing
  offenders. It stays in the table as wordiness rather than as a danger.
- **The distinction between raising a question and deciding one is not mechanizable.** A pattern
  cannot tell whether "follows from" is reporting a derivation or performing one, which is the
  distinction that decides whether a given instance is a defect.

The consequence upstream was to ship it as a review tier rather than as a blocking check. Locally it
stays a check, which is defensible only because this corpus is one author's and the false-positive
rate is a cost paid by the person who set the rule. Do not propagate it as a blocking check.

## Reach for the plain word first

Where a plain word is exact, the longer one is a cost with no return. A reader pays for it, and the
word starts collecting senses precisely because it feels weighty enough to reuse: `catalogue` reached
four senses that way, and two of them were doing work that `list` and `listed` do without ceremony.

The test is not word length. It is whether the longer word carries something the plain one drops:

| Longer word | Keep it when | Otherwise write |
|---|---|---|
| vocabulary | the set of permissible names is the point, and it is extensible. **Always a collection, never one word**: a single name is a term, a name or a word | list |
| catalogue | a body of data with its own schema is meant | list |
| utilize, leverage | never, in this corpus | use |
| surface (verb) | bringing something to someone's attention, where "show" would understate the act | show, report, raise |

**The singular slip is the one to watch, because it hides in a comparison.** A clause about one member of a set reads as a claim about the set: "two vocabularies, one retired in July" leaves a reader unable to tell whether a term or a whole set was retired, and both readings were available in the sentence that produced this rule. Where a set and one of its members are both in play, name which is which.

**This rule stops at the glossary door, and that boundary is the whole of it.** It governs words
chosen for how they sound, never words chosen for what they mean. A defined term of art, an industry
standard, a keyword the model has settled on: those are governed by **one word, one meaning**, and
under that rule the term stays put however long it is and however plain a near-synonym looks. Which
rule applies is settled by one question, not by taste: is the word defined? If the glossary or an
external standard defines it, leave it alone.

**Ignoring that boundary produces the mirror defect, and it happened here.** The capability sites were
swept to `list` in the same pass that moved the event ones, which left `permissions-model.md` saying
"the list has two parts" about the object `rabac-alignment.md` calls the capability vocabulary. That
is two words for one thing, which is the *no synonyms for variety* rule broken three sections above
by the fix for a rule broken below it. Plainness taken past a defined term does not simplify the
corpus; it adds a synonym to it.

So this sits beneath **one word, one meaning** rather than beside it, in both directions. A word
reached for because it sounds substantial is the word most likely to be reached for again in a
different sense, which is what plainness prevents. A word that already carries a definition is one
the first rule is holding in place, and plainness has no business touching it.

## camelCase wherever the name is not a database identifier

**Four classes, and only one of them is snake_case.**

| Class | Convention | Why |
|---|---|---|
| JSON and wire names: an Usher token's `generatedAt`, plugin config's `fieldName`, an audit event's `data` properties | camelCase | nothing forces otherwise, so the more readable form wins |
| A multi-word segment inside a dotted name: `grant.rateExceeded` | camelCase | forced: `_` is barred inside a dotted name, since metrics systems fold `.` into `_` and two names then collide |
| PostgreSQL tables and columns: `grant_decisions`, `revoked_at` | snake_case | correctness, not taste. Postgres folds unquoted identifiers to lowercase, so `resourceUsers` becomes `resourceusers` unless every reference is double-quoted forever |
| CloudEvents context attributes: `specversion`, `dataschema` | lowercase, no separator | the spec restricts them to lowercase alphanumerics |

**Values are open**, and they are not obviously a database question: a category name travels as a JSON
key inside an Usher token, so `indigenous_data` sits on the wire beside `generatedAt`, while a state
like `pending` is only ever stored. Deployment-chosen category names may not be ours to
constrain at all.

**Prefer the more descriptive name now that multi-word segments are available.** A name shortened to
fit a one-word-per-segment rule was shortened for the wrong reason. Add the qualifying word where it
disambiguates and stop where it only adds length: `grant.rateExceeded` names what was observed, and
`grant.rateThresholdExceeded` adds a word that repeats it.

## Ushered is the word, and the noun after it varies

**`ushered` is the term; `application` and `service` are both valid nouns after it and are not
interchangeable.** An ushered service serves requests, which is what Arranger and Lyric are. An
ushered application is the wider word, for a program that may or may not be one. Choosing between
them is a question about the thing being described, not about which is the approved phrase.

`client` is not available for either, being reserved for a machine principal. `adopter` is retired.

**The qualifier is not decoration, and dropping it changes what the sentence denotes.** A platform runs applications that Usher does not govern: Elasticsearch, Postgres and Keycloak are all applications by any ordinary reading, and none of them carries a plugin. So a bare `application` names a set that includes them, and every claim made about what an application does, holds in configuration, or enforces is then false of most of that set. **Carrying a plugin is what makes one ushered**, and it is the property every such claim actually depends on. Where a sentence is about the thing that enforces, `ushered` is load-bearing and its absence is a defect rather than brevity.

**And where a sentence needs a role rather than the thing, the role extends the term rather than
replacing it.** An ushered service acting as the requester in a token exchange or as a plugin's
target is still an ushered service; `requesting application` and `target service` describe what it is
doing in that sentence. They stop being descriptions and become synonyms the moment one of them
appears where the thing itself is being named.

**`data service` is the exception, and it graduated.** It was listed above as a role description
under exactly that warning. DCAT defines `dcat:DataService` as a collection of operations accessible
through an interface that provide access to one or more datasets, which is what Arranger, Lyric,
Score and Song each are, so the phrase now names a kind of thing rather than a thing's current job.
**ushered data service** is therefore available as a third noun, and it is the most precise of the
three: an ushered application may be anything, an ushered service serves requests of any kind, and an
ushered data service is one that serves data, which is the only class Usher exists to put a decision
in front of.

**It also draws the plane boundary for free.** Usher is a service and is not a data service, so the
term separates the two sides without a sentence explaining the separation. The controller, bridge and
plugin are not data services either.

**Use it where the precision earns its place, not everywhere.** Most sentences do not turn on which
kind of thing is meant, and a sweep would trade a readable word for a longer one in every passage
that never needed it, which is the plain-word rule below applied to a term of art that does have a
definition. Reach for it at the plane boundary, in the plugin contract, and wherever a reader could
otherwise think Usher were one of them.

## Field against field name, and how to tell which

**The same ambiguity cost Arranger a painful migration, so it is checked here rather than trusted.**
A field is the whole key-and-value unit a record carries; the field name is the key; the value is what
that record holds there.

**The tell is what the sentence is doing with it.**

| The sentence is about | Write | Because |
|---|---|---|
| configuring, matching, identifying, passing, storing | **field name** | a name is what identifies the same field across every record, which is why configuration holds names |
| cardinality, depth, values, or which thing in the data plays a role | **field** | those are properties of the field, not of its name |

So a plugin's configuration holds a resource **field name**; the resource **field** is what must be
single-valued. `usher-arranger` maps to fieldNames and fieldValues, and Usher never learns either
field name.

**Only two identifiers are legitimate: `fieldName` and `fieldValue`.** An identifier ending in
`field` names neither the key nor the value, so a reader has to guess which it holds, and that guess
is the whole defect. `check-prose.sh` fails on one, and on a field being configured, stored or passed,
which only a name can be.

## A definition is one sentence, and the rest is detail

**An entry opens with a sentence that says what the term is, and nothing else, then a blank line.**
Everything after that is elaboration a reader may or may not need. "A collection of principals." is a
complete entry for Group; the two-gate model is not part of what a role is, and the `entity.action`
convention is not part of what a capability is.

The defect this prevents is a defining sentence that keeps going, so a reader arrives at a clause
about examples or mechanism before they have the meaning. It also makes the entries comparable: four
words against six lines is visible at a glance where two run-on paragraphs are not.

A tell that a definition has stopped and detail has started: the sentence begins naming Usher's
behaviour, an example, or a consequence, rather than the term itself.

## Put the person first, and the mechanism after

**A sentence about an effect on someone reads backwards when the mechanism is its subject.** "A grant
ending removes what its holder had" makes the reader hold an abstraction, apply it to a second
abstraction, and only then work out who it happened to. "A principal or group loses permissions when
the grant ends" says the same thing in the order a reader needs it.

The tell is a gerund or an event as the grammatical subject with a person as its object: a grant
ending, adding a category, removing the owner, the absence of a rule. Those are all fine as
*when*-clauses and wrong as actors.

This is not a ban on the passive or on abstract subjects. "Expiry cannot be the mechanism by which
data becomes visible" has no person in it and needs none. The rule applies where somebody is affected:
name them, then say what happened.

## Which subject a sentence about Usher takes

**Four subjects, narrowing.** Picking the wrong one asserts something the design does not say.

| Subject | When | Example |
|---|---|---|
| **Usher** | the software behaves this way everywhere | Usher never learns the field name |
| **the controller**, **the bridge**, **the plugin** | the component matters | the controller defines it, the bridge receives it, the plugin enforces it |
| **an instance** | the point is that installs differ | roles are defined per instance's configuration, not by Usher itself |
| **a controller instance** | the point is a running process | a controller instance going down takes its bridges' push connections with it |

**The third line is the one that goes wrong.** Writing "Usher defines its own roles" says the
software ships them, which is the opposite of what the sentence means. Where a per-install choice is
meant, the cleanest repair often drops the agent: "the baseline can be set to grant nothing"
beats naming anyone at all.

**`deployment` is retired as a noun.** It named an act that happens before Usher runs, which is
DevOps and out of scope here, and the corpus used it for a configured Usher in all 281 places. The
word survives only where the deployed artifact is genuinely meant, as in a deployment's own Helm
values.

## Naming Usher and its parts

**Usher** is the whole: controller, bridge and plugin. **The controller** is the deployed service,
and the only one of the three that a network address reaches, since the bridge and the plugin are
libraries running inside an ushered service's own process. So a bare "the service" resolves to the
controller where a process is meant and to Usher where the thing Overture offers is meant, which is
why it should not stand alone in a sentence that could be either. Name the controller when a
component is meant and Usher when the system is.

**The control plane is a third scope, and wider than Usher**, holding Keycloak as well: an identity
provider governs identity rather than serving records, and the data plane is the only other side to
be on. So a sentence about the control plane is not a sentence about Usher. Where Usher alone is
meant, the phrase is **the access control plane**: the part of the control plane that access control
runs in.

## Name the container, not just the slot

**A word that names a position takes its container with it.** `item`, `entry`, `section`, `note`,
`decision`, `question`: each exists in several places at once here, so a bare one makes the reader
work out which collection is meant, and they can only do that if they already know.

    the item              which of four collections?
    the roadmap item      resolved
    the to-discuss item   resolved

    the entry             a log entry, a glossary entry, a grant entry?
    the glossary entry    resolved

**The tell is that the word names a slot rather than a thing.** A slot belongs to something, and the
something is the half a reader cannot recover. This applies to speech as much as to documents: in
conversation the container is usually obvious to whoever is writing and invisible to whoever is
reading, which is what makes it easy to leave out.

## Naming who receives access

**"Grant access" needs a recipient, and is ambiguous without one.** Granting is authoring a grant;
reaching data is exercising one. The phrase reads correctly when a person follows it and wrongly when
a mechanism does:

    grant access to a collaborator      authoring. Clear.
    self-grants access to a resource    authoring. Clear.
    grant access through a category     no recipient, so it reads as
                                        someone using a path to data

**The tell is the preposition.** `to` someone is authoring. `through`, `via` or `on` something is a
mechanism, and the sentence has stopped saying who is being given anything. Recast it to name the
recipient, or use a verb that cannot be misread: create a grant, issue a grant.

## One word per action

**Grant is the verb, and there is deliberately no second one.** X grants permissions to Y in Z, and
the record of that act is the grant. A separate noun made a rare separation look structural when it
needs a clause instead: an approval made outside Usher, as under a GA4GH Passport, is still recorded
here as a grant, with a clause saying Usher did not itself decide it.

**Permission is the effect, not a synonym for the grant.** "Uncertainty is not permission" uses the
word in its ordinary sense, the state of being allowed, and that use stays.

## Naming a scope

**"Per instance" is the scope reached for by default, and it is often the wrong one.** Three
narrower units carry most configuration, and naming the wrong one has produced errors in these
documents twice. All four are correct statements about different things, so the wrong one reads as
fluent and no mechanical check catches it.

| Thing | Its actual scope | Because |
|---|---|---|
| resource field name | per catalogue | a field name only resolves inside one schema |
| Usher token | per application | it is wrapped to that application's key |
| category | per Usher instance | it is a row in Usher's own database |
| the baseline's grants | per instance | nothing narrower owns it |

## Choosing among filter, predicate and clause

They coincide only where a principal holds exactly one grant, which is why they blur in examples: the
filter is then a single clause expressing one predicate, so any of the three reads correctly. Say
**clause** when the shape matters, **predicate** when the meaning matters, and **filter** when what
matters is that it is attached to a query.

## Retired terms

Each meant something already named. A document still using one is a finding for the terminology
pass, not a second concept.

| Retired | Meant | Retired because |
|---|---|---|
| requester | principal | reads as neutral but adds nothing principal does not carry |
| caller | principal | suggests a machine, which is the assumption the vocabulary exists to avoid |
| approve, approval (as the act) | grant | a second noun for one act made a rare separation look structural |
| member (as a role name) | a viewer, the base role carrying read access and no authority over other people's | named belonging rather than an act, so calling the base role `member` implied an owner was not one. `reader` was rejected: this corpus uses "a reader" forty times for whoever is reading the document |
| membership, memberships | a principal or group holding a role in a resource | named a relation without saying what it entails; `group_users` and `resource_categories` name both sides, and a role is what the row carries |
| privilege | permission | proposed as a role-level counterpart to permission; the two layers share one vocabulary |
| record-level category tagging | record-level narrowing | named the mechanism as writing labels onto records, which this design does not do |
**`curator` was retired on 2026-07-13 and reinstated in September.** It is not in the table above,
and the retirement is recorded here because the reversal is the part worth knowing. The July pass
resolved it to "an owner or a viewer, whichever the sentence means", which the model then showed to
be exactly the conflation the plane split exists to prevent: an owner is not a wider viewer.

**The two roles both carry create, read, update and delete, over different objects.** `curator` is
the data-plane role: CRUD on records. `owner` is the control-plane role: CRUD on access to one
resource. Neither is a rung above the other, and no role is a point on a scale running from viewer to
owner. That is why the term came back: with only `viewer` and `owner` available, a document reaching
for the data-plane write role has nothing to name it with, and reaches for `owner`.

`rabac-alignment.md` kept `curator` through the July pass and is correct on this point in
retrospect. The full site list is in [role-model-sweep.md](role-model-sweep.md).

## Borrowed terms

A term arriving from another system keeps that system's meaning there and does not automatically
carry it here. The mapping table in the glossary is the reference; the rule for writing is that a
borrowed term whose Usher column reads "nothing" has no counterpart, so reaching for it introduces a
concept the model does not have.

## Open overloads, tracked

Surveyed 2026-09-17 by qualifier spread rather than by raw count, since raw counts drown in ordinary
English. A word earns a place here by carrying more than one meaning, or by being a settled concept
with no definition anywhere. Counts cover every markdown file except those under `.dev/sessions/`,
**including untracked ones**. The first pass used `git ls-files` alone and so missed five files,
among them this one, which is why the numbers below were revised upward.

**Two measurement defects, both of the same kind, are worth stating once here.** The `git ls-files`
miss above, and a path exclusion that never matched. The second needs its cause stated precisely,
because the obvious reading of it is wrong: `grep` on the interactive path is a shell function
wrapping **ugrep**, and ugrep given `.` prints `sub/a.md` where BSD `/usr/bin/grep` prints
`./sub/a.md`. So `grep -v "^./.dev/sessions/"` is correct against system grep and silently excludes
nothing against the wrapper, which counted session files in and inflated an earlier `plane` figure.
The corrected 87 replaces it.

Two consequences. Anchor a path exclusion on a substring (`grep -v "sessions/"`) rather than on a
leading `./`, and check the file list rather than only the total, since a failed exclusion prints no
error and returns a plausible number. And **`check-prose.sh` is not affected**: its file list comes
from `git ls-files`, which emits repo-relative paths with no prefix, so its `grep -v '^.dev/sessions/'`
does what it says. Verified rather than assumed, because the two paths disagreeing was the whole
defect.

| Term | Uses | Entry | What is wrong | Order |
|---|---|---|---|---|
| artifact | 51 | none | two live senses, and one is security-relevant: a derived artifact is what enforcement fails open on, while the onboarding artifact is a published document | 2 |
| ceiling | 32 across 9 files | none | the central term of the two-stage structure, load-bearing on the token calculation, and defined nowhere. It reaches published `docs/concepts.md`. Added to this list because a reader asked what "the ceiling clause" meant and nothing in the corpus answers. A second sense is already present: `roadmap.md:376` has a `bridge-per-instance ceiling`, a numeric capacity limit rather than a permission maximum | 3 |
| payload | 122 | none | **two unrelated referents**: an Usher token's claim set, and the CloudEvents `data` object of an audit event, which share no field, lifecycle or consumer. Separately, the corpus contradicts itself on whether a permissions payload is the token or a field inside it, and `enforcement payload` is a third label related to neither in writing | 1 |
| corpus | 40 | none | two unrelated referents: 24 uses are a set of executable conformance cases living in another repository, 15 are these documents. Bare `the corpus` appears 14 times and resolves only from context, and only 7 of those 24 carry the qualifier `conformance`. Neither sense is data, so the word is also unavailable for the data sense it reads as | 4 |
| plane | 87 | none | one meaning and no defect, but a settled concept carrying no definition, which the term-of-art rule forbids. Its definition sits in an `architecture.md` disambiguation note while the word reaches `README.md` and the onboarding document. One stray compound, `policy-plane`, appears once and is never defined | 5 |
| scope | 211 in prose, plus 12 that are an HTML table attribute rather than the word | none | at least eight senses: the boundary of the work, a section's applicability, the breadth a grant reaches, OAuth's token string, two different named data fields, the region a field name resolves in, the extent of a revocation, and the verb. `plugin-integration.md` already warns that this word names unrelated concepts across services and that conflating two yields a filter that is syntactically valid and semantically wrong | 6 |

**`schema` was surveyed and cleared.** Seven compounds, entity, database, payload, token, event,
config and JSON Schema, all carrying one meaning applied to different subjects. A general word
correctly applied is not an overload, and renaming any of them would move a collision rather than
remove one.

**`dataset` is resolved and has left the list.** It went to the register rule above rather than to a
rename: design documents say `resource`, reader-facing prose keeps `dataset`, and the glossary entry
carries the mapping and names where the simplification's edge is. The external standard turned out
not to help, which is worth keeping since it looked as though it would: `dcat:Dataset` is true of a
study and of a catalogue, so it legitimizes both senses and adjudicates neither.

**The rest are ordered by damage rather than by count.** `payload` leads now. It names the central
object the system produces, it is used 45 times in one compound, and the corpus disagrees with itself
about whether that compound means the token or a field in the token. `artifact` follows because it is
the clearest, and because confusing a governance object with a published document is not harmless. `ceiling` sits third and is
the cheapest of the six: it needs a definition rather than a rename, and the definition is already
written in `token-calculation.md` waiting for one open question to settle which of two forms it takes.
`scope` is last because it is a re-test of a recorded claim rather than a terminology pass.
