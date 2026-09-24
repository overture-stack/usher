#!/usr/bin/env python3
"""Fixture for check-prose.sh: what each pattern must catch, and must not.

Run: python3 .dev/check-prose-test.py

Why this exists rather than reading the patterns. Every defect found in the
checker so far was found by a probe and none by reading a regex, including two
introduced by the edit that fixed the previous one. A pattern that cannot fire
and a pattern that fires on everything look identical at the terminal: one
prints nothing, the other prints plausible lines, and neither announces that it
is not testing what it claims.

Two properties this fixture exists to hold, both learned the hard way:

  Single file as well as corpus. A hook hands over one file, and `grep` omits
  the filename prefix when given exactly one, so a path-based exclusion that
  works over the corpus silently stops working in the case a hook uses. Every
  case here runs single-file for that reason, and one case asserts an exclusion
  by path.

  Case is a per-pattern decision, not a global flag. The deciding question is
  whether capitalization carries meaning in what the pattern matches. For every
  pattern here it does not, so a sentence-initial instance must behave exactly
  like a mid-sentence one, and each block below includes one. A pattern that
  discriminated on a proper noun would need the opposite test and must not be
  folded, since a character class folds under the ignore-case flag and the
  discriminator disappears while the pattern goes on matching.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

CHECK = Path(__file__).parent / "check-prose.sh"

# (pattern name fragment, text, expected, note)
#   expected: True = must fire, False = must stay silent,
#   "known"  = fires, is not a real instance, and the pattern cannot tell.
#   "keep"   = fires, IS a real instance, and the text stays anyway.
#
# The last two are operationally identical and differ only in what the reader
# concludes, which is why both are cases rather than comments: each asserts
# that the pattern must go on firing and that nobody may narrow it to make the
# flag go away. They are kept apart because a reader who finds an unavoidable
# false positive filed as a keeper will think someone mislabelled it, and one
# was: the first "keep" case here was filed as "known", asserting it was not a
# real instance in the same breath as a note calling it load-bearing.
#
# For a candidate-raising family, False is nearly unreachable. Only a face of
# the defect with a fixed word can ever be refused correctly, so a check whose
# cases are honest collapses toward these two. Where False does carry weight,
# as in the dash check, a hit is a violation by definition and the family is
# not candidate-raising at all.
CASES = [
    ("class L", "An earlier version of this document said otherwise.", True,
     "sentence-initial: this form never matched until the flag was set"),
    ("class L", "The wording previously recorded here was dropped.", True, ""),
    ("class L", "Two corrections to earlier versions of this table.", True,
     "a table, not a file: missed for as long as the noun list held only file, document and section"),
    ("class L", "An earlier version ended it on Sep 1.", True,
     "a verb outside the original reporting list: each missing verb was a miss, not a judgment"),
    ("class L", "An earlier version of Keycloak required a restart.", False,
     "a software version, not this document: the name between keeps the widened verbs safe"),
    ("class L", "The earlier release shipped in June.", False,
     "earlier, but not a self-reference"),

    ("compression template", "The category semantics are defined per instance.", True,
     "sentence-initial"),
    ("compression template", "The rule for a category is defined per instance.", False,
     "says which, so nothing is compressed away"),

    ("the derivational register", "Buys audience isolation for free.", True,
     "two hits in one line: sentence-initial, and the register word this check exists for"),
    ("the derivational register", "Audience isolation follows from the per-application key.", False,
     "the consequence stated plainly"),

    ("mixed separators", "The metric is `grant.rate_exceeded` in the dashboard.", True, ""),
    ("mixed separators", "The metric is `grant.rateExceeded` in the dashboard.", False,
     "one word per segment, so nothing folds into a collision"),

    ("an identifier ending in field", "Enforcement reads `resourceField` on every document.", True,
     "names neither the key nor the value"),
    ("an identifier ending in field", "Enforcement reads `resourceFieldName` on every document.", False,
     "fieldName is the legitimate form the pattern must not flag"),

    ("retired terms", "Requester identity is read from the token.", True, "sentence-initial"),
    ("retired terms", "Principal identity is read from the token.", False,
     "the term that replaced it"),

    ("retired capability names", "A viewer holds `record.read` on open records.", True,
     "the dotted id"),
    ("retired capability names", 'The entry is { "open": { "record": ["view", "aggregate"] } }.', True,
     "an action in a payload example, not first in its list"),
    ("retired capability names", "export type RevisionAction = 'read' | 'export';", True,
     "a member of a type union"),
    ("retired capability names", "A viewer holds `record.view`, and `read` names the group.", False,
     "the new id, and the group, which is a real name"),
    ("retired capability names", 'The wrong one: "read" for computed collides with reading.', False,
     "a quoted word in prose is not an action"),

    ("self-speak", "Worth stating because the column otherwise looks misplaced.", True,
     "sentence-initial"),
    ("self-speak", "That is recorded here because the mistake is easy to repeat.", True, ""),
    ("self-speak", "The property is only worth having if the key has the same blast radius.", False,
     "worth having means the property is, not that the document is worth saying it. "
     "Including the word cost four false positives for one real hit, which is why "
     "the pattern lists the other verbs and not this one"),
        ("self-speak", "Which replica served a request still belongs in the event.", False,
     "a system recording something, not a document justifying itself"),
        ("self-speak", "That exemption is stated here rather than left to the path list.", "keep",
     "a real self-reference and load-bearing: it constrains a future editor from "
     "relocating the rule into the checker, which unwrapping would lose"),
    ("self-speak",
     "They are recorded here rather than in the integration's own repository.", "keep",
     "the placement face, and the only one of the four this pattern's verb list can "
     "reach. Load-bearing: it stops a future editor moving the content across repos. "
     "Nearly unwrapped during the first sweep, and survived by a rewording done for "
     "rhythm rather than because the boundary had been seen"),

    ("a field where only its name can be meant",
     "The field is configured in the adapter.", True, "sentence-initial"),
    ("a field where only its name can be meant",
     "The field name is configured in the adapter.", False,
     "naming the name is the correct form"),

    ("catalogue in a sense", "Config is per Usher catalogue.", True, ""),
    ("catalogue in a sense", "The capability catalogue ships with defaults.", True, ""),
    ("catalogue in a sense", "Its events are catalogued in audit-events.md.", True,
     "the verb is a third sense"),
    ("catalogue in a sense",
     "An Arranger catalogue can hold more than one catalogue.", False,
     "both surviving senses, correctly written"),
    ("catalogue in a sense", "Config granularity is per catalogue.", False, ""),

    ("who confirmed it", "Confirmed by the Arranger owner, this holds.", True,
     "sentence-initial: missed until the flag was set"),
    ("who confirmed it", "Per the Arranger owner it stands.", True, ""),
    ("who confirmed it",
     "The default owner is the person who created it, per the ownership cascade.", False,
     "owner inside ownership: needs the word boundary"),

    ("a count with no noun", "Two of three remain open.", True, "sentence-initial"),
    ("a count with no noun", "Option 1 of 4.1 is open.", "known",
     "a section reference reads as a bare count; accepted rather than narrowed"),

    ("em dash", "A sentence with an em dash — here.", True, ""),

    ("a verb standing in for a phrase stated elsewhere",
     "A flat clause never reaches depth 2; an OR of ANDs, which does.", True,
     "the reader fetches 'reaches depth 2' from the previous clause"),
    ("a verb standing in for a phrase stated elsewhere",
     "The filter, which is the enforcement half, composes with and.", False,
     "a relative clause that continues is not an elision"),
]

# A file whose path carries an exclusion must stay excluded when it is the only
# file passed. This is the case `grep -H` exists for, and it passed over the
# corpus while failing here.
PATH_EXCLUSION = ("terminology-usage-probe.md",
                  "Config is per Usher catalogue.",
                  "catalogue in a sense")


def run(text, filename="probe.md"):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / filename
        p.write_text(text + "\n")
        r = subprocess.run(["bash", str(CHECK), str(p)],
                           capture_output=True, text=True)
        return r.stdout + r.stderr


def main():
    failures, known, keepers = [], [], []
    for name, text, expected, note in CASES:
        fired = ("== " + name) in run(text) or name in run(text)
        if expected in ("known", "keep"):
            bucket = known if expected == "known" else keepers
            (bucket if fired else failures).append(
                "%s :: %s%s" % (name, text, "" if fired else "  (no longer fires)"))
            continue
        if fired != expected:
            failures.append("%s\n    text:     %s\n    expected: %s, got: %s%s" % (
                name, text, "fire" if expected else "silent",
                "fire" if fired else "silent",
                "\n    note:     " + note if note else ""))

    # A pattern shipped with no case is tested against nothing while being
    # enforced against every file, and a fixture with a gap prints exactly what
    # a complete one prints. Shelling out to the real script stops the pattern
    # and its test drifting apart; it does nothing about a pattern that has no
    # test at all, which is the other half and the quieter one.
    shipped = re.findall(r'^\s{4}\("([^"]+)"', CHECK.read_text(), re.M)
    shipped += re.findall(r'^report "([^"]+)"', CHECK.read_text(), re.M)
    covered = {name for name, _, _, _ in CASES}
    for s in shipped:
        if not any(frag in s for frag in covered):
            failures.append("pattern shipped with no case: %s\n"
                            "    it is enforced against every file and asserted by nothing" % s)
    # A fragment matching two pattern names reports both covered while only one
    # is. No fragment aliases today, which is a fact about the current names and
    # not about this check, so it is asserted rather than left to hold by luck:
    # a pattern added later as a variant of an existing one would inherit its
    # fragment and arrive already reading as tested.
    for frag in covered:
        if len([s for s in shipped if frag in s]) > 1:
            failures.append("case name %r matches more than one shipped pattern\n"
                            "    so a pattern with no case of its own reads as covered" % frag)

    fname, text, name = PATH_EXCLUSION
    if name in run(text, fname):
        failures.append("%s\n    fired on %s, where the path excludes it.\n"
                        "    grep omits the filename prefix for a single file, so the\n"
                        "    exclusion never sees a path to match. Needs grep -H." % (name, fname))

    corpus = subprocess.run(["bash", str(CHECK)], capture_output=True, text=True)
    if corpus.returncode not in (0, 1):
        failures.append("corpus run returned %d, which is neither clean nor found"
                        % corpus.returncode)
    verdict = "No matches." in corpus.stdout or "SOMETHING WAS FOUND" in corpus.stdout
    if not verdict:
        failures.append("the summary line states no verdict, so reading only the tail\n"
                        "    hides every finding printed above it")
    last = corpus.stdout.rstrip().splitlines()[-1] if corpus.stdout.strip() else ""
    if "No matches." not in last and "SOMETHING WAS FOUND" not in last:
        failures.append("the verdict is not on the last line: %r\n"
                        "    anything showing only the final line reports whatever sits there,\n"
                        "    and the disclaimer once ended with the words 'the corpus is clean'" % last)
    if "corpus is clean" in corpus.stdout:
        failures.append("the summary contains 'corpus is clean', which reads as a pass when truncated")

    print("%d cases, %d path-exclusion case, corpus exit %d"
          % (len(CASES), 1, corpus.returncode))
    for k in known:
        print("  unavoidable false positive: %s" % k)
    for k in keepers:
        print("  fires and is a keeper:      %s" % k)
    if failures:
        print("\nFAILED:\n")
        for f in failures:
            print("  " + f + "\n")
        sys.exit(1)
    print("all pass")


if __name__ == "__main__":
    main()
