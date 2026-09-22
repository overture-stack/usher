#!/usr/bin/env python3
"""Rank back-reference candidates for a human review pass.

This is NOT a check. Every line it prints may be correct prose. It orders a
queue so that a reader sits down to the worst candidates first, and stops when
the hits stop being interesting.

The defect it is looking for is class B in
.dev/docs/atlas/roadmap/doc-review-patterns.md: a demonstrative or pronoun with
more than one candidate referent. Whether a referent is ambiguous is a property
of the sentences before it, not of the word, so no pattern decides it. What a
pattern can do is rank.

The proxy, from that file: how far a match sits from the start of its
paragraph. One near the start has almost nothing preceding it to point at, so
its referent is in a previous paragraph or nowhere. One eighty words in usually
has a clear antecedent a few words back, and occasionally does not, which is
why this ranks rather than filters.

    python3 .dev/rank-references.py            # whole corpus
    python3 .dev/rank-references.py FILE...    # just these
    python3 .dev/rank-references.py -n 40      # show more

Never wire this into anything that blocks. It is a reading aid.
"""

import glob
import os
import re
import sys

WORDS = r"(This|That|These|Those|It|They|Them|Its|Their)"
# a demonstrative followed by a noun is a determiner and unambiguous:
# "this document", "those grants". Only the bare pronoun use is a candidate.
VERB_AFTER = (
    r"(is|are|was|were|means|makes|gives|leaves|applies|follows|holds|explains"
    r"|matters|removes|closes|breaks|does|did|has|have|can|cannot|will|would"
    r"|should|must|needs|comes|goes|sits|stays|reads|carries|names|says)"
)


def paragraphs(path):
    text = re.sub(r"```.*?```", "", open(path).read(), flags=re.S)
    for block in re.split(r"\n\s*\n", text):
        flat = " ".join(block.split())
        if not flat or flat[0] in "|#-><":
            continue
        # a bolded lead is a sentence like any other and often supplies the
        # antecedent, so it is kept. It is reported separately so a match
        # following one is not scored as though nothing preceded it.
        lead = re.match(r"^\*\*[^*]+\*\*", flat)
        yield flat, len(lead.group(0).split()) if lead else 0


def candidates(paths):
    for path in paths:
        for para, lead_words in paragraphs(path):
            body = re.sub(r"^\*\*[^*]+\*\*", "", para).strip()
            for match in re.finditer(r"\b" + WORDS + r"\s+" + VERB_AFTER + r"\b", body):
                depth = len(body[: match.start()].split()) + lead_words
                start = max(0, match.start() - 34)
                yield depth, path, match.group(0), body[start : match.end() + 46]


def main():
    args = sys.argv[1:]
    limit = 25
    if "-n" in args:
        i = args.index("-n")
        limit = int(args[i + 1])
        del args[i : i + 2]

    if args:
        paths = args
    else:
        here = os.path.join(os.path.dirname(__file__), "..")
        os.chdir(here)
        paths = sorted(
            glob.glob(".dev/design/*.md")
            + glob.glob(".dev/docs/*.md")
            + glob.glob(".dev/docs/atlas/roadmap/*.md")
            + glob.glob("docs/*.md")
        )

    found = sorted(candidates(paths), key=lambda row: row[0])
    if not found:
        print("no candidates in %d files" % len(paths))
        return

    shallow = sum(1 for row in found if row[0] <= 10)
    print(
        "%d candidates across %d files, %d of them within ten words of a "
        "paragraph start.\nWorst first. Most will be fine; stop when they stop "
        "being interesting.\n" % (len(found), len(paths), shallow)
    )
    for depth, path, phrase, context in found[:limit]:
        print("%3d  %-30s %s" % (depth, os.path.basename(path), phrase))
        print("     ...%s..." % context.strip())
    if len(found) > limit:
        print("\n%d more, deeper into their paragraphs. Re-run with -n." % (len(found) - limit))


if __name__ == "__main__":
    main()
