# Subagent delegation: an experiment and its findings

_Started 2026-09-17. Running log. Nothing here is a convention yet, and it should not be proposed
to agentics until there are enough entries to say something that is not an anecdote._

## What is being tried

Spawning subagents for parts of the work rather than doing all of it in one long-running session,
then evaluating what comes back. The occasion was a question about whether a long session degrades
output, which this does not test. It does something more useful: it gives a task to a reader with no
history, whose answer can be checked against the files.

**The interesting property is the one that makes it awkward.** A subagent starts with no context, so
the prompt has to carry everything the task needs. Writing that prompt is most of the cost, and it
is also most of the value, because a task that cannot be specified without the conversation is a
task whose specification was never written down.

## Criteria, fixed before the first result arrived

Written in advance deliberately. Grading after reading tends to produce criteria the result already
meets.

| Criterion           | What counts as passing                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verifiable accuracy | Counts, quotes and `file:line` references match the files. An invented path, quote or count is disqualifying rather than a deduction, because it makes everything else unusable |
| Scope fidelity      | It answered the question asked rather than an adjacent, easier one                                                                                                              |
| Stated gaps         | Where it could not determine something, it said so. Both prompts asked for this explicitly, so silence on a gap is a failure against an instruction rather than an oversight    |
| Judgement           | The sense classification is defensible and the recommendation follows from the evidence rather than from the prompt's framing                                                   |
| Net cost            | Time to write the prompt, plus time to verify the answer, against time to do it directly. Delegation is not free and this is the criterion most likely to be flattered          |

**What would make this a bad idea**, recorded now so it is not explained away later: verification
costing as much as doing the work; a confident answer that spot-checking shows to be wrong, since
that is worse than no answer; or prompts so long that the specification is the work and the agent is
ceremony.

## Log

### 1. Two surveys of overloaded terms, launched 2026-09-17

Two read-only agents, one given `payload` and `plane`, the other `corpus` and `scope`. Each asked
for per-file counts with the command used, senses with verbatim quotes and line references, glossary
coverage, compounds, and a judgement on whether the word is genuinely overloaded.

Chosen because the same survey was done by hand earlier today for two other words, so the shape of a
good answer is known, and because every claim in it is cheap to check with a grep.

One of the two carries a planted test. The `scope` prompt asks it to check a claim this corpus makes
about itself, that the word has five uses and is precise in all of them, which is stale. An agent
that repeats the claim rather than testing it has failed scope fidelity in a way that is visible
without knowing the right answer.

#### Result 1: `payload` and `plane`. Graded against the criteria above.

| Criterion           | Verdict                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verifiable accuracy | **Pass.** Four load-bearing claims spot-checked and all four held: which files are untracked, a contradiction quoted from two specific lines, a section heading, and a one-occurrence compound. No invented path, quote or count. Its totals reconcile exactly against the scope it stated |
| Scope fidelity      | **Pass.** It answered the specific question put to it and reported that the documents do not settle it, with evidence of the contradiction, rather than resolving it for them                                                                                                              |
| Stated gaps         | **Pass, and best here.** It flagged unprompted that five files fall outside the scope it was given, said plainly it could not tell whether one compound is a synonym or a third division, and said it could not reproduce the existing counts rather than explaining the difference away   |
| Judgement           | **Pass.** Its verdict is better reasoned than the one it replaced. It separated the generic JWT sense, which belongs to an external standard and must not be renamed, from the genuine collision                                                                                           |
| Net cost            | **Favourable.** A few minutes to write the prompt, two commands to verify. It found three defects that a hand survey had missed and one error in the hand survey's method                                                                                                                  |

**Four corrections it produced, listed because they are the return on the exercise rather than
decoration.**

1. **The method was wrong, so every count published today was low.** The hand survey enumerated files
   with `git ls-files`, which omits untracked ones. Five markdown files are untracked, including the
   file that holds the overload table itself. `payload` is 122 rather than 101 and `plane` is 70
   rather than 58. The prose checker was never affected, since it enumerates untracked files too.
2. **A whole sense was missed.** `audit-events.md` uses `payload` for the CloudEvents `data` object,
   which shares no field, lifecycle or consumer with a token's claim set. That is the clearest
   unrelated-referent collision in the word and the hand survey did not see it.
3. **The corpus contradicts itself** on whether a permissions payload is the token or a field inside
   it, in `security-workflow.md` and `glossary.md` respectively. Neither passage acknowledges the
   other.
4. **A stray compound was introduced today while fixing a different overload.** `policy-plane`
   appears once, in a line edited this session, and is defined nowhere.

`payload` moves to first on the list as a result.

**The finding about delegation, separate from the findings about words.** The most valuable output
was not the survey. It was the scope caveat, which a reader with no history had to state because it
had no way to know what was assumed, and stating it exposed an error in the method that had been
invisible to the person using it. **A fresh reader is useful precisely where a long session is
confident.**

**One caution, and it is mine rather than the agent's.** Verifying a claim needs the same care as
making one. My own check of the single-occurrence compound returned nothing and I nearly recorded the
agent as wrong; the command was case-sensitive, which is the defect this corpus spent the day
removing from its checker. A verification step that carries the bug it is verifying against is worse
than no verification, because it converts a correct answer into a recorded error.

#### Result 2: `corpus` and `scope`, including the planted test

**It passed the planted test decisively.** Asked to check a claim this corpus makes about itself,
it tested the claim rather than repeating it, found it false by a factor of roughly forty, and went
further than the question: it noticed that the same file contradicts itself, since a table added
later already records the claim as stale while the original row still states it. That
self-contradiction was introduced in this session and neither reading it nor running the prose
checker had surfaced it.

| Criterion           | Verdict                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verifiable accuracy | **Pass.** Four claims checked against the files, all four exact                                                                                                                                                               |
| Scope fidelity      | **Pass, and beyond.** The planted test was answered as a test rather than as a lookup                                                                                                                                         |
| Stated gaps         | **Pass.** It said which counts it could not reproduce, and said plainly that it had classified one word's uses exhaustively and the other's only in kind, so the sense list is complete while the per-sense totals are absent |
| Judgement           | **Pass.** It distinguished an overload from a general word correctly applied, and found that the corpus already warns about this exact word in a passage nobody had connected to it                                           |
| Net cost            | **Favourable**, on the same terms as the first                                                                                                                                                                                |

**The finding that pays for the exercise on its own.** Twelve of the `scope` occurrences are
`scope="col"` in an HTML table, which is an accessibility attribute and not the English word. Every
count of that word taken here had included them. A reader with the files and no assumptions caught
what someone who knew what the word meant did not think to exclude.

**A second one, cheaper but sharper.** The corpus already carries a warning that this specific word
names unrelated concepts across services, and that conflating two of them yields a filter that is
syntactically valid and semantically wrong. That sentence sat in an adapter document while the word
went unexamined in the terminology rules. Nobody had connected them, and connecting them is the kind
of link a fresh reader makes because both passages are equally new to it.

### Interim findings on delegation itself

Two results, both passing, so this is early. What has shown up twice is below.

**The reliable value is not the answer, it is the assumption the agent cannot make.** Both agents
produced a scope caveat unprompted, and both caveats exposed a defect: one that file enumeration
had silently omitted untracked files, the other that a count had included markup. Neither is a hard
question. Both were invisible from inside because they sit in what was taken for granted.

**Specifying the task is most of the work, and that is a feature.** Each prompt took several minutes
and consisted largely of writing down what this session had made implicit: which files count, what a
glossary entry looks like, that a count must come from a command rather than an impression. A task
that cannot be specified without the conversation is a task whose specification was never written.

**Verification has to be held to the same standard as the work.** A check of one claim returned
nothing and nearly recorded a correct answer as wrong, because the command was case-sensitive. The
rule that follows: verify with a command built for the check, not with the first grep to hand.

**Not yet known**, and not to be guessed at from two results: whether this holds for tasks needing
judgement rather than survey, whether it holds where the answer cannot be checked cheaply, and what
happens when an agent is confidently wrong rather than carefully uncertain. The second of those is
the one that decides whether this generalizes, since both tasks here were chosen for being verifiable.

### 2. Three readers over the onboarding document, launched 2026-09-17

Three agents, **identical prompts**, asked to audit `docs/onboarding.md` as its non-technical
audience and return their ten most consequential findings with verbatim quotes, line numbers and
replacement sentences. Identical rather than varied deliberately: with one task, a difference between
two reports is variance, and agreement is a measurement. With three different lenses it would be
neither.

**What convergence does and does not prove, written before the results arrived.** Three instances of
one model given one prompt share their priors, so agreement measures what the model finds salient
rather than what is true. A defect all three name is a strong candidate and not a verified finding.
So the rule for this round: **convergence selects, verification decides**, and nothing gets applied
because three agents agreed.

**Ground truth is available and was withheld from them.** A previous pass over this document with a
real non-technical reader produced fourteen findings and nine defect classes, recorded in
`doc-review-patterns.md`. The agents were not given those classes. Two outcomes are informative:
rediscovering a class means it was never fixed, and finding something outside the nine means the
classes are incomplete.

**Predictions, committed now so that agreeing with the result later costs something.** I expect all
three to flag the `dataset` word, since the document uses it for the unit a grant names while a
section heading uses it for a body of data. I expect at least two to flag density in the section
explaining how a decision reaches the data, which is the most mechanical part of the document. I
expect the tier names to be flagged by at most one, because they are explained where they are
introduced. I expect nobody to flag the passive constructions I would flag, because they read as
fluent.

#### Results

All three returned ten ranked findings with quotes, line numbers and replacement sentences.

**Found by all three, and every one verified true against the file:**

| Finding                                                                                                                                                                                                                                                                | Ranks       | Verified      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- |
| A sovereignty promise the document has already voided. One line states that platform administrators cannot override a community representative; another, 137 lines earlier, says an instance can switch on a setting letting an administrator query data with no grant | 1, 1, 1     | Yes           |
| The permissive-failure admission has no actor, no size and no way to check it, and its euphemism undoes the fail-secure argument built over three sections                                                                                                             | 3, 4, 9     | Yes           |
| Eleven unexplained product names in the second paragraph, before the problem has been stated                                                                                                                                                                           | 8, 3, 6     | Yes           |
| A glossary entry describing the document's own vocabulary backwards. It claims the prose says approval and the token says grant; the body has 3 of the first and 63 of the second                                                                                      | 4, 10, low  | Yes, by count |
| The document describes its own earlier section wrongly, naming two roles that section does not name                                                                                                                                                                    | low, low, 5 | Yes           |

**Found by two of three**, and also verified: the word `portion` used for exactly the thing a sentence six lines earlier says a category is not, which both ranked second.

#### Evaluation

All three pass accuracy, scope fidelity, stated gaps and judgement. All three separated what they
could not determine from what they found, and all three volunteered a section on where the document
is right where it looks wrong, which was asked for and is the part that makes a padded list visible
by its absence.

**The predictions were wrong twice, and both are worth more than the confirmations.**

Predicted that all three would flag the lay word used for two granularities. **None did.** Either the
substitution is working for its audience or three readers of that audience did not see it, and those
are different conclusions. The person who has been inside this decision all day could not tell them
apart, which is the reason to ask someone outside it.

Predicted that none would flag the actorless constructions, on the theory that they read as fluent to
the thing that writes them. **All three flagged them**, one as a numbered finding covering every
configuration sentence in the document: software does not define a category or switch on
administrator access, people do, and the reader never learns which people. So this technique does not
share that blind spot, which was the open question that mattered most.

**The finding that argues against the method as stated.** The single most consequential defect was
found by **one** agent of three. One line tells the reader that anonymous requests pass through the
access control service, which contradicts two later statements that it never touches the data and is
only asked a question. A privacy reviewer reading it would conclude the service holds a query log
over health data. It is a material false claim about where health data flows, it was a singleton, and
a rule of applying only what converges would have shipped it.

So the rule stands corrected: **convergence ranks, it does not filter.** A singleton from a careful
reader is a finding to verify, not noise to discard, and the reason is structural. Three instances of
one model agree on what is salient, and a defect that is consequential without being salient is
exactly the one that survives a vote.

**Verification failed twice, and the agents did not.** A claim was nearly recorded as fabricated
because the verifying command truncated the line at 210 characters and the quoted sentence sat at 212. Earlier the same day another check missed because it was case-sensitive. Both times the agent
was right and the check was wrong. Across five agent runs today the pattern is consistent: the
reports have been accurate, and the weak link has been the person checking them.

#### What was applied, and the finding the agents could not have reached

Two fixes went in. Neither is the fix any of the three proposed.

**The sovereignty contradiction was resolved in the other direction.** All three read the two
passages and concluded the absolute claim was the false one, so all three proposed weakening it. The
answer was the reverse: the administrator bypass is not in the first release at all, so the absolute
claim is true and the passage describing a configurable bypass in the present tense is what was
wrong. That passage now says the first release has no way around a grant, and records what is already
settled about a later one: off unless deliberately enabled, bounded rather than total, and not built
before the question of community-governed data is answered.

**No agent could have reached that**, and all three said so in the right way. Each of them listed the
truth of the factual claims as something it could not judge from the file, and each flagged the
contradiction without asserting which side was correct. That is the behaviour to want: the finding
was real, the diagnosis was as far as the evidence went, and the resolution needed someone who knows
what is being built.

**The clearest success is the one that is easy to undersell.** The replacement sentences were usable.
Several of the document's most convoluted passages are now readable because three readers with no
stake in the phrasing rewrote them, and a person who has been inside the wording cannot do that for
the same passage twice. Surfacing convoluted phrasing, and supplying the plain version rather than a
note asking for one, is the concrete thing this technique did well.

#### The single rule behind every result above

**Delegate the reading, never the framing.** Every result above sorts cleanly under it.

What delegation is genuinely good at is coverage of text: which line says what, where two passages
contradict each other, which sentence a first-time reader cannot parse, and the plain replacement for
it. All of that is reading, all of it is checkable against the file, and three readers do it better
and faster than one because they have no stake in the existing wording.

What it cannot do is decide what is true, because the answer is not in the file. The sovereignty
contradiction is the case: all three located it correctly, all three proposed the wrong resolution,
and each of them said, correctly, that it could not judge the factual claim from the file alone. A
contradiction is a reading result. Which side of it is false is a framing question, and it needed
someone who knows what is being built.

Two operational corollaries, both earned rather than assumed:

- **Convergence ranks, it does not filter.** The most consequential defect of the round was a
  singleton. Three instances of one model agree on what is salient, so a defect that is consequential
  without being salient is precisely the one a vote discards.
- **Verify the report, and expect the verification to be the weak link.** Across the runs logged
  here, the reports were accurate and two of my own checks were wrong: one case-sensitive, one
  truncating at 210 characters where the quoted text sat at 212. A failed check looks exactly like a
  refuted claim.
- **Verification has a blind spot that another reader does not.** "Check before asserting" catches a
  claim nobody looked up. It does nothing for a claim where the right source was fetched and the
  wrong conclusion drawn from it, because the checking already happened. One instance is recorded on
  a peer's side: they fetched the sentence "a source may include multiple producers" and wrote in the
  same message that a source identifies an instance rather than a class. The premise was in hand and
  the conclusion inverted it. What caught it was a second party reading the same spec against the
  same claim, which is the one defence that works on this class and the reason an adversarial pass is
  worth asking for rather than waiting to be offered.
