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

import subprocess
import sys
import tempfile
from pathlib import Path

CHECK = Path(__file__).parent / "check-prose.sh"

# (pattern name fragment, text, expected, note)
#   expected: True = must fire, False = must stay silent,
#   "known"  = fires, is a false positive, and is accepted. Kept as a case
#   so that it is counted and visible rather than living in a comment that
#   nothing re-reads. If one of these ever stops firing, the pattern moved.
CASES = [
    ("class L", "An earlier version of this document said otherwise.", True,
     "sentence-initial: this form never matched until the flag was set"),
    ("class L", "The wording previously recorded here was dropped.", True, ""),
    ("class L", "The earlier release shipped in June.", False,
     "earlier, but not a self-reference"),

    ("a field where only its name can be meant",
     "The field is configured in the plugin.", True, "sentence-initial"),
    ("a field where only its name can be meant",
     "The field name is configured in the plugin.", False,
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
    failures, known = [], []
    for name, text, expected, note in CASES:
        fired = ("== " + name) in run(text) or name in run(text)
        if expected == "known":
            (known if fired else failures).append(
                "%s :: %s%s" % (name, text, "" if fired else "  (no longer fires)"))
            continue
        if fired != expected:
            failures.append("%s\n    text:     %s\n    expected: %s, got: %s%s" % (
                name, text, "fire" if expected else "silent",
                "fire" if fired else "silent",
                "\n    note:     " + note if note else ""))

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

    print("%d cases, %d path-exclusion case, corpus exit %d"
          % (len(CASES), 1, corpus.returncode))
    for k in known:
        print("  accepted false positive: %s" % k)
    if failures:
        print("\nFAILED:\n")
        for f in failures:
            print("  " + f + "\n")
        sys.exit(1)
    print("all pass")


if __name__ == "__main__":
    main()
