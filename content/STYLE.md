# Writing the study guide

How the chapter explanations in `content/chapter_NN/` are written and laid
out. It is for whoever drafts or edits them, person or AI. The explanations
follow Rabbi Markel's recorded classes, and only those.

## Inputs

All in this repository:

- `data/chapters/chapter_NN.json`: the chapter's **segments** (one per Sefaria
  paragraph, `§n`, 1-based). Each has its Hebrew lines (`lines`, with the
  line IDs), the English translation (`en`, HTML with `<i>`, `<b>` and
  footnote markers), its `footnotes`, and `coverage` (where each line is read
  in which class; empty means no recording). `sections` gives the Hebrew
  section labels of the source text, as segment ranges; they nest, so ranges
  overlap.
- `data/transcripts/chapter_NN.json`: per line (`spans`, each with its
  `segment`), the time-stamped sentences from the reading of that line up to
  the reading of the next line, so each span holds his explanation of the
  line. Plus each tape's `preambles` (what was said before the first line).
  `t` is the second of the class where the sentence starts.
- `data/sources.json`: the classes, by key (`021`), with titles, durations and
  audio URLs.
- `content/translit.yaml`: term spellings (read-only for chapter writers).
- This file.

`npm run dump -- N` prints a chapter as plain text in reading order: each
segment's Hebrew, English and footnotes, then the transcript of its lines,
each sentence prefixed with its second (`[252s 4:12]`). `npm run dump -- N 5 9`
prints §5–§9 only.

## Structure of a chapter

```
Chapter N
  Overview (100–150 words)
  Key terms (box)
  Concept 1  — bold descriptive heading
    "In short:" callout (1–2 sentences)
    Unit §a        Hebrew | Sefaria English      → Explanation (with ▶ listen chips)
    Unit §b–c      …
  Concept 2 …
  Review questions (4–6)
  Listen to the full classes (generated from data)
```

- **Segment** = one Sefaria paragraph, `§n`.
- **Unit** = one or more consecutive segments explained together.
- **Concept** = 1–6 consecutive units under one heading. Aim for 4–9 concepts
  per chapter. Headings are descriptive labels ("Girsa: understanding at first
  glance"), not "Part 3".

The site shows three views of the same files: Study guide (text and
explanation interleaved), Explanation only (the explanations read as
continuous prose under the concept headings) and Text only. So write each
explanation block to stand on its own, quoting the words it explains.
Nothing is written twice.

## Procedure

1. Read the whole chapter's text and translation, then all its transcript
   spans in order.
2. Decide concept boundaries from where Rabbi Markel himself marks a turn
   ("now he's getting to…", "so that's the ענין of…") and from the source's own
   section labels (`sections`). Every segment belongs to exactly one concept
   and exactly one unit.
3. For each unit, write the explanation from that unit's transcript spans
   only (plus a later recap of the same passage if he gives one; cite it).
4. Write `inShort`, then the chapter overview, key terms and review questions
   last, from what was written.

## Explanation blocks

- **Voice:** impersonal, expository, present tense, like *Lessons in Tanya*.
  Do not write "Rabbi Markel says" in every block; the page states once that
  the explanation follows his classes. Name him only for a personal aside or
  where he disagrees with a reading.
- **Shape:** quote the words being explained from the English translation in
  **bold**, with his explanation in plain text around them. Parenthetical
  clarifications are welcome.
  - A bold quote is a verbatim substring of the unit's English, after footnote
    markers and tags are removed: keep its brackets, its spelling (*Binah*,
    *Hitbonenut*) and its curly quotes. `…` inside a bold run may join two
    substrings. Italics inside the quote may be kept as Markdown emphasis
    (`**contemplation (*Hitbonenut*)**`). The translation already spells
    G-d, G-dly, G-dliness.
  - Bold is for quotes only, apart from the `**Key point:**` and
    `**Mashal:**` lead-ins below.
- **Terms:** the transcripts carry terms in Hebrew script. Write them as
  *italic transliterations*, translating only where it reads naturally:
  "עומק of חכמה" → "depth of *chachma*". Spellings come from
  `content/translit.yaml` (Chabad/Ashkenazi colloquial: *chachma*, *bina*,
  *tevuna*, *daas*, *hisbonenus*, *iyun*, *girsa*, *hasaga*, *Elokus*,
  *memalei kol almin*, *middos*, *hispaalus*, *kli*). A term's first use in a
  chapter may carry a short gloss in parentheses; after that, bare. A term not
  in the table: add it to the chapter's `_terms.yaml` and use that spelling
  consistently. Do not respell the bold quotes from the translation.
- Write G-d, G-dly, G-dliness.
- **Faithfulness.** Every claim must be traceable to the cited transcript
  span. Use his analogies and examples, not new ones. No outside sources,
  cross-references or Torah content he did not say; if he cites a source
  (Zohar, a sicha), report it as he gave it. A student's question may be kept
  ("One might ask…") only if he answers it. Leave out logistics, banter and
  off-topic digressions. If a stretch is garbled or you are not sure what he
  meant, leave it out and add a `reviewNotes` entry; never guess.
- Literal word meanings ("lit. understanding") are allowed in glosses; they
  are not Torah content.
- **Length:** in proportion to what he said, roughly 60–220 words per unit.
  If he only reads and translates a line, the block is one or two sentences,
  or the unit is merged with its neighbour. No padding.
- **Citations:** every explanation block has at least one listen link, placed
  where the thought starts: `[▶ 4:12](listen:021#252)` means class `021`,
  second 252. Take the second from the `t` of the transcript sentence where
  that explanation begins. A block may cite several classes (`listen:061#…`
  and `listen:062#…`). The label is `▶ m:ss` (or `▶ h:mm:ss`) of that second.
- **Callouts** inside a block: a Markdown blockquote starting
  `> **Key point:**` or `> **Mashal:**` (his analogy). At most one per unit.
- **No recording** (chapter 1 §1–20): no explanation. One concept file per
  natural group, with a heading taken from the text's own subject,
  `status: no-source`, and its unit sections left empty. Exception: where a
  tape's opening recap restates the earlier material, a short block may be
  written from it, opening "From the recap at the start of the next class:"
  and citing it.

## Other parts of a chapter

- Overview: 100–150 words.
- Key terms: 6–12 per chapter, glossed as he explains the term in these
  classes (or a bare literal meaning).
- Review questions: 4–6, each answerable from the guide, each ending with its
  `(§n)`.
- "In short" per concept: one or two sentences.
- Not written by hand: the class list with its auto-generated topics, and the
  per-unit "Source transcript" panels; the site builds both from `data/`.

## Files

```
content/
  STYLE.md                      # this file
  translit.yaml                 # term spellings
  chapter_03/
    _chapter.md                 # overview + review questions
    _terms.yaml                 # key terms for this chapter
    01-binah-and-tevuna.md      # one file per concept; NN- prefix sets order
    02-….md
```

Concept file:

```markdown
---
title: "Bina and tevuna: grasping the idea, then drawing it out"
segments: [1, 4]            # inclusive range of Sefaria paragraph numbers
inShort: "…one or two sentences…"
status: ai-draft            # ai-draft | no-source | edited | reviewed
reviewNotes:
  - "§3: he and the student differ on the reading שם אדם / שם אד׳; I followed the printed text."
---

## §1

**All this will be understood** … explanation … [▶ 0:11](listen:021#11)

## §2–3

…

> **Key point:** …
```

- The body is split on headings matching `^## §(\d+)(?:–(\d+))?$` (an en
  dash, `–`, between the numbers). The sections must cover `segments`
  exactly, in order. An empty section is allowed only with
  `status: no-source` or when a `reviewNotes` entry names that `§`.
- `reviewNotes` is optional; each entry should start with the `§` it is
  about.
- `_chapter.md`: frontmatter `chapter: 3`, `title` (English working title),
  `status`; the body has exactly two `##` sections, `## Overview` and
  `## Review questions` (a Markdown list, each item ending `(§n)`).
- `_terms.yaml`: a list of `{ term: "tevuna", he: "תבונה", gloss: "…", segment: 1 }`
  (`segment` = where the term first appears in the chapter).
- `translit.yaml`: a list of `{ he: "חכמה", term: "chachma", gloss: "…" }`.

## Checking

`npm run validate` checks the content files: frontmatter, that unit sections
and concepts tile the chapter's segments with no gap or overlap, that every
non-empty unit has a listen link naming a known class and a second inside it
(a warning when the second is more than 120 s outside that unit's coverage),
that bold runs are substrings of the unit's translation (warning), and that
`_terms.yaml` does not contradict `translit.yaml`. Errors fail the build;
warnings point at things to look at (Hebrew script left in the prose, link
text that does not match its second, word counts). `npm run validate --
--chapter 3` checks one chapter. `npm run check` runs the validator together
with the site's type check.
