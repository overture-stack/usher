#!/usr/bin/env python3
"""Render docs/onboarding.md into the HTML published as the Usher onboarding artifact.

    python3 .dev/render-onboarding.py [OUTPUT.html]

The page's CSS lives here rather than in the Markdown, so the source file stays
readable prose. Everything else comes from `docs/onboarding.md`.

Markdown support is deliberately the subset that file uses, and no more: ATX
headings, `-` bullets, `**strong**`, and paragraphs. Blocks that open with a
block-level tag pass through verbatim, which is how the tables, the numbered
flow, the token sample, the glossary and the footer survive. A block opening
with an inline tag such as `<b>` is still a paragraph and is wrapped.

**Blocks split on blank lines**, so a raw HTML block containing one is read as
two blocks and the second is wrapped in `<p>`. The source file says this in its
own header comment; it is repeated here because this is where it breaks.

Only `"` is escaped in Markdown-derived text. `<` and `>` are left alone because
the prose uses inline HTML, so this renderer trusts its one input file and would
not be safe pointed at anything else.
"""

import os
import re
import sys

TITLE = "Overture - User Access Control"

BLOCK_TAGS = ("div", "ol", "ul", "pre", "dl", "footer", "table", "p",
              "blockquote", "section", "figure", "h1", "h2", "h3")

CSS = """  :root {
    --ground: #FFFFFF;
    --ink: #1A1A1A;
    --ink-soft: #4A4A4A;
    --ink-faint: #6E6E6E;
    --rule: #D8D8D8;
    --rule-soft: #E8E8E8;
    --shade: #F4F4F4;
    --safe: #1F5C3D;
    --safe-bg: #EAF2ED;
    --risk: #8E2F1E;
    --risk-bg: #F7EAE7;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #14161A;
      --ink: #E6E6E6;
      --ink-soft: #B0B0B0;
      --ink-faint: #8A8A8A;
      --rule: #34383E;
      --rule-soft: #262A2F;
      --shade: #1C1F24;
      --safe: #7FC29F;
      --safe-bg: #17271F;
      --risk: #E08D78;
      --risk-bg: #2A1A16;
    }
  }

  :root[data-theme="dark"] {
    --ground: #14161A;
    --ink: #E6E6E6;
    --ink-soft: #B0B0B0;
    --ink-faint: #8A8A8A;
    --rule: #34383E;
    --rule-soft: #262A2F;
    --shade: #1C1F24;
    --safe: #7FC29F;
    --safe-bg: #17271F;
    --risk: #E08D78;
    --risk-bg: #2A1A16;
  }

  * { box-sizing: border-box; }

  body {
    background: var(--ground);
    color: var(--ink);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 17px;
    line-height: 1.62;
  }

  .doc { max-width: 68ch; margin: 0 auto; padding: 52px 24px 90px; }

  h1 {
    font-size: 27px;
    line-height: 1.25;
    margin: 0 0 4px;
    font-weight: 700;
  }

  .subtitle {
    font-size: 17px;
    color: var(--ink-soft);
    margin: 0 0 20px;
  }

  .status {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    color: var(--ink-soft);
    background: var(--shade);
    border: 1px solid var(--rule-soft);
    padding: 12px 15px;
    margin: 0 0 34px;
  }
  .status b { color: var(--ink); }

  h2 {
    font-size: 21px;
    line-height: 1.3;
    margin: 40px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
    font-weight: 700;
  }

  h3 {
    font-size: 17.5px;
    margin: 26px 0 6px;
    font-weight: 700;
  }

  p { margin: 0 0 14px; }

  ul { margin: 0 0 14px; padding-left: 24px; }
  li { margin-bottom: 7px; }

  strong { font-weight: 700; }

  .scroller { overflow-x: auto; margin: 16px 0 20px; border: 1px solid var(--rule); }
  table { border-collapse: collapse; width: 100%; min-width: 460px; font-size: 15px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  caption {
    text-align: left;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    font-style: italic;
    color: var(--ink-faint);
    padding: 0 0 7px;
  }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  thead th { background: var(--shade); font-weight: 600; border-bottom: 1px solid var(--rule); }
  tbody tr:last-child td { border-bottom: 0; }
  td.o { font-weight: 600; white-space: nowrap; }
  td.bad { color: var(--risk); background: var(--risk-bg); }
  td.good { color: var(--safe); background: var(--safe-bg); }

  dl { margin: 0 0 14px; }
  dt { font-weight: 700; margin-top: 14px; }
  dd { margin: 2px 0 0; color: var(--ink-soft); }

  footer {
    margin-top: 44px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    color: var(--ink-faint);
  }

  .flow { list-style: none; margin: 16px 0 20px; padding: 0; counter-reset: step; }
  .flow li {
    position: relative;
    padding: 0 0 16px 44px;
    margin: 0;
    border-left: 2px solid var(--rule);
  }
  .flow li:last-child { border-left-color: transparent; padding-bottom: 0; }
  .flow li::before {
    counter-increment: step;
    content: counter(step);
    position: absolute;
    left: -13px; top: 0;
    width: 24px; height: 24px;
    border-radius: 50%;
    background: var(--shade);
    border: 1px solid var(--rule);
    color: var(--ink-soft);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 12.5px;
    display: flex; align-items: center; justify-content: center;
  }
  .flow b { display: block; font-weight: 700; }
  .flow span { color: var(--ink-soft); font-size: 15.5px; }

  pre.token {
    overflow-x: auto;
    background: var(--shade);
    border: 1px solid var(--rule);
    padding: 15px 17px;
    margin: 16px 0 8px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--ink);
  }
  pre.token .k { color: var(--risk); }
  pre.token .c { color: var(--ink-faint); }

  a { color: inherit; }
  a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

  @media (max-width: 620px) {
    body { font-size: 16.5px; }
    .doc { padding: 32px 18px 64px; }
  }"""


def inline(text):
    """Markdown-derived text: escape quotes, then apply strong emphasis."""
    text = text.replace('"', "&quot;")
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)


def render_block(block):
    lines = block.split("\n")
    first = lines[0]

    if first.startswith("#"):
        level = len(first) - len(first.lstrip("#"))
        return "<h%d>%s</h%d>" % (level, inline(first.lstrip("#").strip()), level)

    if first.startswith("- "):
        items = "\n".join("<li>%s</li>" % inline(l[2:].strip()) for l in lines)
        return "<ul>\n%s\n</ul>" % items

    opening = re.match(r"<([a-z][a-z0-9]*)", first)
    if opening and opening.group(1) in BLOCK_TAGS:
        return block

    return "<p>%s</p>" % inline(" ".join(l.strip() for l in lines))


def render(markdown):
    # the source opens with a comment addressed to whoever edits it
    markdown = re.sub(r"^<!--.*?-->\s*", "", markdown, flags=re.S)
    blocks = [b for b in re.split(r"\n\s*\n", markdown) if b.strip()]
    body = "\n".join(render_block(b.strip("\n")) for b in blocks)
    return (
        "<!-- Generated from docs/onboarding.md by .dev/render-onboarding.py."
        " Do not edit this file. -->\n"
        "<title>%s</title>\n<style>\n%s\n</style>\n\n"
        '<div class="doc">\n%s\n</div>\n' % (TITLE, CSS, body)
    )


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    source = os.path.join(root, "docs", "onboarding.md")
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "onboarding.html")
    with open(source) as handle:
        html = render(handle.read())
    with open(out, "w") as handle:
        handle.write(html)
    print("%d bytes -> %s" % (len(html), out))


if __name__ == "__main__":
    main()
