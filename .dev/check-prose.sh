#!/usr/bin/env bash
# Mechanical checks for the defect classes recorded in
# .dev/docs/atlas/roadmap/doc-review-patterns.md and terminology-usage.md.
#
# Run before prose leaves your hands, the way the dash check already is.
# Knowing a rule does not fire while composing; running a command does.
#
#   bash .dev/check-prose.sh            # whole corpus
#   bash .dev/check-prose.sh FILE...    # just these
#
# Covers only the greppable classes. The ones needing a reader deciding
# whether a sentence can be understood are not here and cannot be.
#
# Class B is the worked example of that boundary, and was tried here rather
# than assumed impossible. A demonstrative followed by a noun resolves itself
# ("This is the hybrid pattern"); one followed by a bare adjective does not.
# That shape is greppable and it matched six times, of which one was a real
# defect: whether a referent is ambiguous depends on the preceding sentence
# offering more than one candidate, which no pattern can see. Five false
# alarms per run teaches people to skip the output, so the check was removed
# and the class stays a reading one.
#
# A file that documents a defect quotes it, so the files describing these
# rules are excluded from the rules they describe.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FILES=()
if [ $# -gt 0 ]; then
  FILES=("$@")
else
  # bash 3.2 on macOS has no mapfile
  while IFS= read -r f; do FILES+=("$f"); done < <(
    { git ls-files '*.md'; git ls-files --others --exclude-standard '*.md'; } \
      | grep -v '^.dev/sessions/' | sort -u
  )
fi

found=0
report() { # name, regex, note, [exclude-path-substring ...]
  local hits name="$1" re="$2" note="$3"; shift 3
  hits=$(grep -HnEI "$re" "${FILES[@]}" 2>/dev/null) || return 0
  local ex
  for ex in "$@"; do hits=$(printf '%s\n' "$hits" | grep -v -- "$ex" || true); done
  [ -z "$hits" ] && return 0
  found=1
  printf '\n== %s ==\n%s\n   -> %s\n' "$name" "$hits" "$note"
}

report "em dash or spaced double dash" \
  '—| -- ' \
  "no dashes as prose punctuation in persisted content"

# A bare auxiliary standing in for a verb phrase stated in an earlier clause.
# "an OR of ANDs, which does." leaves the reader to fetch "reaches depth 2"
# from across a semicolon and a change of subject, and reads as fluent English
# while doing it, so nothing prompts the re-read it needs. Caught by a reader
# rather than by this file, which is why it is here now.
report "a verb standing in for a phrase stated elsewhere" \
  ', which (does|did|is|was|has|had|can|could|will|would)[.;,]' \
  "say the verb phrase again rather than pointing back at it"

# Multi-word patterns cannot be line-based. The corpus hard-wraps at 98
# characters, so any phrase longer than a few words is routinely split across
# two lines and a line-based grep reports nothing. Found by a class L instance
# sitting in the corpus while this script called the file clean.
#
# Single newlines become spaces so a phrase can match across the wrap. Blank
# lines are kept, so a match cannot span a paragraph break. The substitution is
# one character for one character, so offsets still map back to line numbers.
#
# The pattern count in the summary is derived rather than maintained. It read
# 13 while the file held 14, because a hand-kept number drifts the moment
# anyone adds a check and looks authoritative the whole time.
PATTERN_COUNT_FILE=$(mktemp)
export PATTERN_COUNT_FILE
trap 'rm -f "$PATTERN_COUNT_FILE"' EXIT

python3 - "${FILES[@]}" <<'ENDPY'
import re, sys

CHECKS = [
    ("class L: correction pointing at a draft",
     # the phrasing varies more than a fixed list of nouns captures: two
     # instances were missed for saying "earlier text here" and "previously
     # recorded" where the pattern expected "an earlier version of this file".
     # Matched instead on the shape: a self-reference near a reporting verb.
     r"[Ee]arlier (version|draft|form|note|text|wording|copy)s? (of (this|the) "
     r"(file|document|section|design|model|note)|here|above|in this)"
     r"|[Ee]arlier (version|draft|form|note|text|wording)s? \w{0,12} ?"
     r"(said|had|asserted|used|called|recorded|described|stated|implied|proposed|computed)"
     r"|[Pp]reviously (recorded|stated|said|asserted|described|read|implied)"
     r"|was (recorded|described|stated) as|used to (say|read|be|assert)"
     r"|[Tt]his (document|file|section) previously",
     "reject the option, not the draft: 'Rejected: X' rather than 'this used to say X'",
     ()),
    ("compression template: <noun> semantics",
     r"[a-z] semantics\b",
     "almost always means 'the rule for X' or 'how X behaves'. Say which",
     ("terminology-usage",)),
    ("a field where only its name can be meant",
     r"\b(the|that|this|a|each|its|their) fields? (is|are) ([a-z][a-z-]* ){0,2}"
     r"(config|configuration|configured|stored|passed|sent|set)\b"
     r"|\b(configured|stored|passed|supplied) field\b(?! (name|condition))",
     "configuration stores names, since a name is what identifies the same field across every record",
     ("terminology-usage", "doc-review-patterns")),
    # Four senses had accumulated. Catalogue keeps the one it has in Arranger,
    # a body of data a service holds, where bare is Usher's unit and Arranger's
    # `catalogueId` container is qualified. Where it had come to mean a list of
    # events, the plain word replaces it. The capability vocabulary is a defined
    # term and keeps its own word, which is why plainness stops at the glossary
    # door: sweeping it there too produced two words for one thing. Lives here
    # rather than with the retired terms because every phrasing below can wrap.
    ("catalogue in a sense it no longer carries",
     r"[Uu]sher'?s? catalogue"
     r"|catalogue of (capabilit|auditable|event)"
     r"|(capability|event|permission|capabilities) catalogue"
     r"|catalogue (rather than|, not) policy"
     r"|catalogu(ed|ing)\b",
     "catalogue is a body of data; where a list is meant, write list",
     ("terminology-usage",)),
    # The no-names rule is about people, so agent attribution slips past it while
    # being the same defect and a worse one: it dates the document to a
    # conversation, it reads as stronger evidence than the verifiable claim it
    # displaced, and the agent it cites is not a stable referent. Recording a
    # limit on the evidence is not attribution and must keep passing.
    ("who confirmed it, where what was established belongs",
     r"(confirmed|acknowledged|answered|agreed|verified|reviewed) by (the |a |an )?"
     r"[A-Za-z-]{0,14} ?(owner|agent|session|peer|maintainer)\b"
     r"|[Pp]er the [A-Za-z-]{0,14} ?owner\b"
     r"|taken second-hand"
     r"|(the )?honest limit, (theirs|mine|ours)",
     "record what was established and how to check it, not who agreed: 'established against the code'",
     ("terminology-usage", "doc-review-patterns")),
    # Mathematics and theoretical physics, via formal linguistics. It reads as
    # ordinary English and inverts: "falls out" gives a reader without the idiom
    # "falls out of the set", the opposite of the intent, and "turns on" reads as
    # "activates" in a document about enforcement. Opaque jargon announces
    # itself; this does not, which is why the register is barred wholesale
    # rather than one phrase at a time. Three instances were fixed separately in
    # one day before anything connected them.
    ("the derivational register, which reads as English and inverts",
     r"falls out of|\bfalls out\b|drops out of"
     r"|\bbuys\b"
     r"|turns on (whether|what|how)"
     r"|cashes out"
     r"|for free\b"
     r"|(reduces|collapses) (to|into)"
     r"|\bmodulo\b|on pain of"
     r"|(trivially|by construction)\b",
     "say the consequence plainly: follows from, depends on, gives, holds",
     ("terminology-usage",)),
    # "Option 1 of 4.1" matches and is the known false positive.
    ("a count with no noun after it",
     r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]+) of (the )?"
     r"(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]+)\b[ ]*"
     r"([.,;:]|(is|are|was|were|have|has|had|remain|stay|do|does|did)\b)",
     "name what is being counted, in the same clause",
     ("uac-flows-traceability", "sentences over")),
]

found = False
for name, pattern, note, excludes in CHECKS:
    hits = []
    for path in sys.argv[1:]:
        if any(x in path for x in excludes):
            continue
        raw = open(path).read()
        lines = raw.split("\n")
        flat = re.sub(r"\n(?!\s*\n)", " ", raw)
        # A quotation is not an instance: documenting a defect means quoting it,
        # while committing one almost never happens inside quotation marks. Blank
        # the span rather than skipping the file, so a rule's own file is still
        # scanned for real instances. Same width, or offsets stop mapping to raw.
        flat = re.sub(r'"[^"\n]*"',
                      lambda m: '"' + " " * (len(m.group(0)) - 2) + '"', flat)
        # backticks quote too, and a rules file quotes its own greps that way.
        # Safe here because every check in this block is prose; the identifier
        # checks are greps outside it and still see backtick contents.
        flat = re.sub(r"`[^`\n]*`",
                      lambda m: "`" + " " * (len(m.group(0)) - 2) + "`", flat)
        # Case-sensitivity has produced three silent misses in this file:
        # a sentence-initial "An earlier version", "Per the owner" and
        # "Confirmed by". Each pattern was fixed in place and the next one
        # repeated it, so the flag is set here once for all of them.
        for m in re.finditer(pattern, flat, re.IGNORECASE):
            # the substitution is length-preserving, so the offset indexes
            # the raw text too, where the newlines still are
            line = raw[: m.start()].count("\n") + 1
            # an exclusion names either a path or a phrase in the matched text,
            # and a wrapped match can start a line before its give-away word
            context = " ".join(lines[max(0, line - 1) : line + 1])
            if any(x in context for x in excludes):
                continue
            hits.append("%s:%d:%s" % (path, line, " ".join(m.group(0).split())))
    if hits:
        found = True
        print("\n== %s ==" % name)
        print("\n".join(hits))
        print("   -> %s" % note)
import os
with open(os.environ["PATTERN_COUNT_FILE"], "w") as fh:
    fh.write("%d" % len(CHECKS))
if found:
    sys.exit(3)
ENDPY
[ $? -eq 3 ] && found=1

# The exclusion anchors on the quoted example, not on a line number. It was
# 'audit-events.md:5' and stopped matching the moment an edit above that line
# pushed the rule text to line 76, so the file stating the rule started failing
# it. An exclusion keyed to a position silently stops excluding; one keyed to
# content moves with the text it means.
report "mixed separators inside one identifier" \
  '`[a-z]+\.[a-z]+_[a-z]+`' \
  "metrics systems fold . into _, so two names collide. One word per segment" \
  'collides with one written'

# The field ambiguity cost Arranger a painful migration, so it is checked
# before it can start rather than after. Only `fieldName` and `fieldValue`
# are legitimate: an identifier ending in `field` names neither the key nor
# the value, and a reader has to guess which it holds.
#
# The pattern requires a prefix, so bare `field` passes. It stopped being
# ambiguous when it became a defined entity in the capability vocabulary,
# where `field.read` reads a field's value and nothing else it could mean.
# A term in heavy use is disambiguated by defining it or by banning it, and
# this one is now defined; the ban would have forced a worse entity name.
report "an identifier ending in field, naming neither key nor value" \
  '`[a-zA-Z_.]+[Ff]ield`' \
  "a key is a fieldName and the pair is a fieldValue; a bare field identifier is the ambiguity" \
  'an object holding the pair' 'names neither the key nor the value'

report "retired terms" \
  '\b(requester|caller|adopter|resource key|data categor)' \
  "see terminology-usage.md for what each became" \
  'terminology-usage' 'AGENTS.md'

# Class M is about definitions, not argument leads, so only glossary entries
# are checked, and only the first sentence of each entry body. "rather than"
# is excluded deliberately: it appears in positive definitions far more often
# than in negations, so including it reports noise rather than defects.
python3 - "${FILES[@]}" <<'ENDPY'
import re, sys
hits = []
for f in (x for x in sys.argv[1:] if x.endswith('glossary.md')):
    lines = open(f).read().split('\n')
    for i, line in enumerate(lines[:-1]):
        if not re.match(r'^\*\*[A-Z`][^*]*\*\*(\s+_[^_]*_)?\s*$', line):
            continue
        first = re.split(r'(?<=[.!?])\s', lines[i + 1])[0]
        if re.match(r'^\s*(It |This |That )?(is |are )?(not|never|no longer)\b', first):
            hits.append("%s:%d:%s" % (f, i + 2, first[:100]))
if hits:
    print("\n== class M: a definition led by what it is not ==")
    print("\n".join(hits))
    print("   -> lead with what the term is; a collision note goes below it, labelled")
ENDPY

echo
if [ "$found" -eq 0 ]; then verdict="No matches."; else verdict="SOMETHING WAS FOUND: scroll up, the findings print above this."; fi
patterns=$(( $(grep -c '^report "' "$0") + $(cat "$PATTERN_COUNT_FILE" 2>/dev/null || echo 0) ))
echo "Checked ${#FILES[@]} files against $patterns patterns. $verdict A defect no pattern looks for is"
echo "indistinguishable from its absence, so this says what was searched, not that"
echo "the corpus is clean. Counts locate candidates and do not rank them."
exit "$found"
