# Shaar HaYichud Study Guide — demo design spec

Target repo: `yringler/shaarhayichudstudydemo` (empty, cloned at `/home/user/shaarhayichudstudydemo`).
Data source: `/home/user/yringler/shaar-hayichud-sections` at commit `53b16fb` (read-only; nothing is changed there).
Purpose: a proof of concept to discuss with Markel Son. Not a product.

## 0. Findings that shape the design (verified)

- **Sefaria is reachable** from this environment. `GET https://www.sefaria.org/api/v3/texts/The_Gate_of_Unity.<N>?version=english&version=hebrew` returns two versions with parallel paragraph arrays (same length):
  - English: `versionTitle` "Translated by Rabbi Amiram Markel, 2023", **license CC-BY**, `versionSource` `http://neirot.com/the-gate-of-unity-with-hebrew/`.
  - Hebrew: "Neirot, 2023", license **unknown** on Sefaria.
  - English contains `<i>` and footnotes as `<sup class="footnote-marker">n</sup><i class="footnote">…</i>` (the footnote `<i>` contains nested `<i>`, so it needs a real HTML parser, not a regex).
  - It transliterates Sephardi-style (*Hitbonenut*, *Tvunah*, *Da'at*) and spells "God" nowhere in ch. 1–5 that needs changing.
- **Segment mapping.** Sefaria paragraphs and the repo's chapter lines do not have the same boundaries, but a word-level diff of the two Hebrew texts (99%+ words match) shows **every repo line falls inside exactly one Sefaria paragraph**. The repo's lines are a refinement: ch.1 53 lines / 48 paragraphs, ch.2 37/34, ch.3 26/23, ch.4 51/48, ch.5 49/45. Three repo lines have no Sefaria counterpart (ch.2: a `(ב)` marker word and one Yiddish line; ch.5: two lines). So the bilingual unit is the **Sefaria paragraph ("segment")**, which owns 1..n whole repo lines.
- **Rabbi Markel coverage** (series heading 37; lecture ids are the `@` ids, audio is the `(edited).mp3` on the same timeline):

  | Chapter | Classes (source key) | Lines covered | Mean alignment confidence |
  |---|---|---|---|
  | 1 | 015, 016, 017 | lines 20–52 of 53 (**lines 0–19 have no recording**: tape 015 opens "we're at the end of the first page in chapter one") | 0.84 / 0.76 / 0.83 |
  | 2 | 018, 019, 020 | all 37 | 0.90 / 0.88 / 0.84 (020 uses Sofer times, no retimed file) |
  | 3 | 021 | all 26 | 0.83 |
  | 4 | 022, 023 | all 51 | 0.83 / 0.89 |
  | 5 | 060, 061 (+062: 2 lines at 0.53; 063: no aligned lines, free discussion) | all 49 | 0.93 / 0.91 |

- **Transcript quality is good enough to write from.** English with Hebrew-script terms inline ("the עיון, meaning בינה שבבינה, is a כלי for the השגה"). Pattern: a student reads a line of Hebrew, Rabbi Markel translates and explains, the student says "Right." or asks a question. No speaker labels (`num_speakers: 1`). There is banter and call logistics ("Hello, Shimon? my microphone was off").
- **An alignment segment covers the reading of a line, not the explanation.** The explanation sits between one line's segment and the next. So the transcript span that belongs to a line is `[this segment's firstWord, next segment's firstWord − 1]`.
- Audio: `https://media.shaarhayichudresources.com/<encoded folder>/<encoded filename>` returns 200 with `accept-ranges: bytes`, so seeking works in a plain `<audio>` element.
- Toolchain here: Node 22.23, npm 10.9.

## 1. Chapters

**Chapters 1–5.** The course starts at the beginning, all five have Rabbi Markel transcripts, and chapters 2–5 are fully aligned. Chapter 1's first 20 lines (Sefaria paragraphs 1–20) have no recording; the demo shows them as text and translation with a "No class recording covers this passage yet" note. That gap is useful for the discussion: it shows what merging in other shiurim would fill (Markel Son's point 4).

## 2. The study guide: content and how it is written

### 2.1 Recommendation: interleave, written so the fallback falls out

Interleave the explanation with the text (Lessons in Tanya style), organised under concept headings (the halacha-sefer photo). Reasons:

- The alignments already give, for every line, where in the class it is read and explained. The hard part of interleaving is done.
- Each explanation block is written as self-standing prose that quotes the translated words in bold. With the text blocks hidden, the explanation blocks under a concept heading read as continuous prose, which is the fallback layout. The site offers three views of the same content: **Study guide** (interleaved, default), **Explanation only** (the booklet model), **Text only** (Hebrew + straight translation). Nothing is written twice.

### 2.2 Structure of a chapter

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
  Listen to the full classes (class list with outline topics as timestamp links)
```

- **Segment** = one Sefaria paragraph, referred to as `§n` (1-based, Sefaria's paragraph number).
- **Unit** = one or more consecutive segments explained together.
- **Concept** = 1–6 consecutive units under one heading. Aim for 4–9 concepts per chapter. Headings are descriptive sentences-as-labels in the photo's style ("Girsa: understanding at first glance"), not "Part 3".

### 2.3 Content-writing method (for the Claude content agents)

**Inputs per chapter** (all in the demo repo after Agent A runs): `data/chapters/chapter_NN.json` (segments: Hebrew lines, Sefaria English, footnotes, coverage) and `data/transcripts/chapter_NN.json` (per line: the time-stamped sentences from that line's reading up to the next line's reading; plus each tape's preamble), `content/translit.yaml` (term spellings), `content/STYLE.md` (this section, copied in by Agent A).

**Procedure**
1. Read the whole chapter's text and translation, then all its transcript spans in order.
2. Decide concept boundaries from where Rabbi Markel himself marks a turn ("now he's getting to…", "so that's the ענין of…") and from the repo's own section labels (`sections` in the chapter JSON). Every segment belongs to exactly one concept and exactly one unit.
3. For each unit, write the explanation from that unit's transcript spans only (plus a later recap of the same passage if he gives one; cite it).
4. Write `inShort`, then the chapter overview, key terms and review questions last, from what was written.

**Explanation block rules**
- Voice: impersonal, expository, present tense, like Lessons in Tanya. Do not write "Rabbi Markel says" in every block; the page states once that the explanation follows his classes. Use it only where he gives a personal aside or disagrees with a reading.
- Shape: quote the words being explained from the Sefaria English in **bold** (verbatim substrings of that segment's translation, footnotes and tags stripped; `…` may join two substrings), with his explanation in plain text around them. Parenthetical clarifications are welcome, as in the photo.
- **Terms (Markel Son's rule):** the transcripts carry terms in Hebrew script. Write them as *italic transliterations*, translating only where it reads naturally: "עומק of חכמה" → "depth of *chachma*". Spellings come from `content/translit.yaml` (Chabad/Ashkenazi colloquial: *chachma*, *bina*, *tevuna*, *daas*, *hisbonenus*, *iyun*, *girsa*, *hasaga*, *Elokus*, *memalei kol almin*, *middos*, *hispaalus*, *kli*). A term's first use in a chapter may carry a short gloss in parentheses; after that, bare. A term not in the table: add it to the chapter's `_terms.yaml` and use that spelling consistently. Do not respell the bolded Sefaria quotes (they keep *Binah*, *Hitbonenut*).
- Write G-d, G-dly, G-dliness.
- **Faithfulness.** Every claim must be traceable to the cited transcript span. Use his analogies and examples, not new ones. No outside sources, cross-references or Torah content he did not say; if he cites a source (Zohar, a sicha), report it as he gave it. A student's question may be kept ("One might ask…") only if he answers it. Leave out logistics, banter and off-topic digressions. If a stretch is garbled or you are not sure what he meant, leave it out and add a `reviewNotes` entry; never guess.
- Literal word meanings ("lit. understanding") are allowed in glosses; they are not Torah content.
- **Length:** in proportion to what he said. Roughly 60–220 words per unit. If he only reads and translates a line, the block is one or two sentences, or the unit is merged with its neighbour. No padding.
- **Citations:** every explanation block has at least one listen link, placed where the thought starts: `[▶ 4:12](listen:021#252)`, meaning source key `021`, second 252. Take the second from the `t` of the transcript sentence where that explanation begins. A block may cite several classes (`listen:061#…` and `listen:062#…`). Label text is `▶ m:ss` (or `▶ h:mm:ss`).
- Callouts inside a block: a Markdown blockquote starting `> **Key point:**` or `> **Mashal:**` (his analogy). At most one per unit.
- Segments with no coverage (ch.1 §1–20): no explanation. One concept file per natural group, with a heading taken from the text's own subject, `status: no-source`, and unit sections left empty. Exception: where tape 015's opening recap restates the earlier material, a short block may be written from it, opening "From the recap at the start of the next class:" and citing it.

**Other formats included** (cheap, derived from the same reading)
- Chapter overview, 100–150 words.
- Key terms: 6–12 per chapter, gloss as he explains the term in these classes (or a bare literal meaning).
- Review questions: 4–6, each answerable from the guide, each ending with its `§`.
- "In short" per concept.
- Class list with Sofer outline topics as timestamp links (generated from data, labelled "auto-generated topics"; no agent writing). This is where 062 and 063 (free discussion of ch.5) appear.
- Per unit, a collapsed "Source transcript (auto-generated, unedited)" so the reviewer can check the draft against what was said. Screen only.

Not included: summaries of 062/063, cross-chapter index, search, per-word audio following.

### 2.4 Content file format (committed, hand-editable)

```
content/
  STYLE.md                      # §2.3, for future editors
  translit.yaml                 # seeded by Agent A; read-only for content agents
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

- Body is split on headings matching `^## §(\d+)(?:–(\d+))?$` (en dash). The sections must tile `segments` exactly, in order. An empty section is allowed only with `status: no-source` or when a `reviewNotes` entry names that `§`.
- `_chapter.md`: frontmatter `chapter: 3`, `title` (English working title), `status`; body has exactly two `##` sections, `## Overview` and `## Review questions` (a Markdown list, each item ending `(§n)`).
- `_terms.yaml`: list of `{ term: "tevuna", he: "תבונה", gloss: "…", segment: 1 }`.
- `translit.yaml`: list of `{ he: "חכמה", term: "chachma", gloss: "wisdom; the first flash of an idea" }`.

## 3. Vendored data (the interface contract)

Written by `scripts/vendor.ts`, committed under `data/`. TypeScript types live in `src/lib/schema.ts` (Zod schemas, types inferred); the script and the site both import them. Agent A owns that file; its shape is fixed here so Agent B can start at once.

```ts
// data/sources.json
interface SourcesFile {
  schemaVersion: 1;
  sectionsCommit: string;            // git sha of the shaar-hayichud-sections checkout
  sources: Source[];
}
interface Source {
  key: string;                       // leading digits of the lecture id: "021"
  lectureId: string;                 // "021 Tape004-Side1-Ch3.mp3"
  teacher: "Rabbi Markel";
  series: string;                    // "Rabbi Markel Series (Advanced)"
  title: string;                     // "Chapter 3" / "Chapter 1, part 2" (heading + position)
  audioUrl: string;                  // catalog url of the (edited) mp3, already encoded
  durationSeconds: number;
  chapters: number[];                // [3]
  times: "retimed" | "sofer";
  outline: { title: string; startSeconds: number }[];   // from data/outlines, G-d spelling applied
}

// data/chapters/chapter_NN.json
interface ChapterFile {
  schemaVersion: 1;
  chapter: number;                   // 3
  heRef: string;                     // from Sefaria heRef
  sefariaUrl: string;                // https://www.sefaria.org/The_Gate_of_Unity.3?lang=bi
  translation: { versionTitle: string; license: string; source: string };
  sections: { label: string; fromSegment: number; toSegment: number }[]; // repo's Hebrew section labels
  segments: Segment[];
}
interface Segment {
  n: number;                         // Sefaria paragraph number, 1-based
  lines: { id: string; text: string; notInSefaria?: true }[];   // repo lines, in order
  en: string;                        // sanitized HTML: only <i>, <b>, <sup data-fn="n">
  footnotes: { n: number; html: string }[];
  coverage: Coverage[];              // empty = no recording
}
interface Coverage {                 // one per (source, line) alignment segment
  source: string;                    // Source.key
  lineId: string;
  startSeconds: number;              // reading of the line starts
  endSeconds: number;                // discussion ends = next aligned line's start in that source (or tape end)
  confidence: number;                // raw alignment confidence; no floor applied, UI may flag < 0.45
}

// data/transcripts/chapter_NN.json   (working input for writers; also shown collapsed on the site)
interface TranscriptFile {
  schemaVersion: 1;
  chapter: number;
  preambles: { source: string; sentences: Sentence[] }[];       // words before a tape's first aligned line
  spans: { source: string; lineId: string; segment: number; startSeconds: number; endSeconds: number;
           confidence: number; sentences: Sentence[] }[];       // ordered by source, then time
}
interface Sentence { t: number; text: string }                  // t = start second of the sentence
```

Extraction rules (`scripts/vendor.ts --sections <path to checkout> [--refetch-sefaria]`):

1. Chapters 1–5 and the source list are constants at the top of the script: 015–023, 060–063.
2. Sefaria: raw API responses are saved to `data/raw/sefaria/The_Gate_of_Unity.N.json` and committed; the script reads them and only hits the network when a file is missing or `--refetch-sefaria` is passed. Fetch by shelling out to `curl -sS` (Node's `fetch` does not use the session proxy).
3. Line → segment: normalise both Hebrew texts (strip tags, turn maqaf into a space, keep only א–ת and spaces), split into words, diff the two word lists (LCS; `diff` package), give each line the segment that most of its matched words fall in. A line with no matched word takes the previous line's segment (the next line's if it is first) and `notInSefaria: true`. Fail the script if segment numbers are not non-decreasing across lines or a segment gets no line.
4. English: parse with `node-html-parser`; pull each `sup.footnote-marker` + following `i.footnote` into `footnotes`, leaving `<sup data-fn>`; keep `<i>`/`<b>`, drop every other tag and attribute.
5. Coverage and spans: from `data/alignments/<encoded lecture id>.json`, sort segments by `firstWord`; span for segment *i* is words `firstWord_i … firstWord_{i+1} − 1` (last: to the final word). Word start times come from `data/retimed/<id>.json` `words[i][0]` when that file exists, else the Sofer `timestamps[i].start`; `startSeconds` is the alignment's own. Words before the first segment are the preamble. Sentences: break after a word ending in `.`, `?` or `!`, and force a break at 45 words.
6. Apply the data repo's `reverentSpelling` (copy the three regexes from `data/tools/src/publish.ts`) to transcript text and outline titles.
7. `audioUrl`: parse `classes.txt` enough to find each lecture's folder and `(edited)` filename, then encode every path segment so only RFC 3986 unreserved characters stay literal (same as `buildMediaUrl` in `data/tools/src/catalog.ts`), on base `https://media.shaarhayichudresources.com`.
8. Nothing else is copied: no raw Sofer JSON, retimed arrays, edits or other chapters.

`scripts/validate-content.ts` (run by `npm run check` and before `astro build`): frontmatter schema; unit sections tile each concept's range; concepts tile the chapter's segments with no gap or overlap; every `listen:` link names a known source and a second within its duration, and warns when the second is outside that unit's coverage ±120 s; warns when a bold run is not a substring of the unit's translation; every non-empty unit has a listen link; terms in `_terms.yaml` do not contradict `translit.yaml`.

## 4. The site

**Stack:** Astro 5, static output, TypeScript `strict` (extend `astro/tsconfigs/strictest`), no UI framework, hand-written CSS, one small client script for audio and view switching. Markdown rendered with `marked` (or Astro's built-in processor) inside a loader in `src/lib/content.ts` that reads `content/` and `data/` at build time and returns typed chapter models. Builders should check current Astro docs (Context7 if available) rather than rely on memory.

**Pages**
- `/` — booklet cover: "Shaar HaYichud — Study Guide, Booklet 1: Chapters 1–5", what this is, the draft notice in full, table of contents with each chapter's concept headings, credits.
- `/chapter/1/` … `/chapter/5/` — the chapter (structure in §2.2), with previous/next links.
- `/booklet/` — all five chapters on one page for printing in one go.
- `/glossary/` — all key terms, alphabetical, with the chapter where each first appears.
- `/about/` — how the guide was made, what is and is not reviewed, attribution and licences.

**Draft banner:** on every page, not dismissible: "Draft for review. The explanations were drafted by AI from recordings of Rabbi Markel's classes and have not yet been reviewed by him. Do not rely on them or distribute them." Repeated in the print footer of every page.

**Unit layout**
- Text block: Hebrew (`dir="rtl" lang="he"`, a Hebrew serif such as Frank Ruhl Libre from Google Fonts, ~1.25× the English size) beside the English. CSS grid, two columns from 720 px up with Hebrew on the right; stacked (Hebrew first) below that. Each Hebrew line is a `<span id="{lineId}">`. Footnotes of the translation appear as small notes under the English.
- Explanation block under the text block, full width, with a thin rule and the label "Explanation". Listen links render as small buttons.
- No coverage: the text block plus a muted note. Coverage confidence under 0.45 on every line of a unit: a small "audio position approximate" mark on its listen buttons.
- "For the reviewer" box (from `reviewNotes`) at the foot of a concept, dashed border; "Source transcript" `<details>` per unit. Both hidden in print.
- "In short:" and "Key point:"/"Mashal:" as tinted callout boxes with a bold lead-in, after the photo's "The halacha is:".
- Italic transliterations are just Markdown emphasis.

**View switch:** segmented control at the top of a chapter: Study guide / Explanation only / Text only. Sets `data-view` on the chapter root; CSS hides the other blocks. Kept in `localStorage` (in try/catch) and readable from `?view=`. Printing uses the current view.

**Audio:** one `<audio preload="none">` in a bar fixed to the bottom of the screen, hidden until first used. A listen button sets `src` to the source's `audioUrl` if it differs, seeks to the second and plays; the bar shows the class title, current time, play/pause and ±15 s. No autoplay on load. In print a listen button becomes plain text, "(class 21, 4:12)".

**Print (booklet look)**
- `@page { size: A5 or Letter (see open questions; default Letter); margin: 18mm 16mm 20mm }`.
- Running headers through page margin boxes (Chrome/Edge 131+; other browsers simply print without them): `@top-left` "Shaar HaYichud — Study Guide", `@top-right` "Chapter N" using a named page per chapter (`.chapter-3 { page: ch3 }`, `@page ch3 { @top-right { content: "Chapter 3" } }`), `@bottom-center` `counter(page)`, `@bottom-left` "Draft — not reviewed".
- Each chapter starts on a new page; `break-inside: avoid` on text blocks and callouts; `break-after: avoid` on concept headings.
- In "Explanation only" view the prose is set in two columns (`columns: 2`) with concept headings spanning within the column, as in the photo. In the interleaved view the Hebrew/English pair is the two columns and explanations run full width.
- Hide the banner bar, view switch, audio bar, navigation, transcripts and reviewer boxes. Black on white, serif body, 10.5–11 pt.
- A "Print this chapter" button calls `window.print()`.

**Mobile:** single column, 16 px gutters, no horizontal scroll, buttons at least 40 px tall, audio bar does not cover the last line (bottom padding on `main`).

**Cloudflare Pages:** build command `npm run build` (runs `validate-content` then `astro build`), output directory `dist`, `NODE_VERSION=22` (also `.node-version`). No functions, no environment secrets. Project name `shaarhayichudstudydemo`; connect the GitHub repo in the Pages dashboard, or deploy by hand with `npx wrangler pages deploy dist --project-name shaarhayichudstudydemo`. Add `public/robots.txt` disallowing all and a `noindex` meta tag, since this is an unreviewed draft.

## 5. Repo layout

```
shaarhayichudstudydemo/
  README.md                 # what it is, how to run, how to re-vendor, how to edit content, licences
  package.json  tsconfig.json  astro.config.ts  .node-version  .gitignore
  scripts/
    vendor.ts               # extraction (§3); run with tsx
    validate-content.ts
  data/                     # generated by vendor.ts, committed, never hand-edited
    sources.json
    chapters/chapter_0[1-5].json
    transcripts/chapter_0[1-5].json
    raw/sefaria/The_Gate_of_Unity.[1-5].json
    ATTRIBUTION.md          # where each file came from, licences, sections commit
  content/                  # written by agents, edited by people (§2.4)
  src/
    lib/schema.ts           # Zod schemas + types (the contract)
    lib/content.ts          # loads data/ + content/ into typed models
    lib/format.ts           # time formatting, listen-link parsing
    layouts/  components/  pages/  styles/  scripts/player.ts
  public/robots.txt
```

npm scripts: `dev`, `build`, `preview`, `check` (`astro check` + `validate-content`), `vendor` (`tsx scripts/vendor.ts --sections ../yringler/shaar-hayichud-sections`).

## 6. Build split (5 Opus agents)

| Agent | Owns (writes only here) | Work |
|---|---|---|
| **A — data and contract** | `package.json`, `tsconfig.json`, `.node-version`, `.gitignore`, `scripts/`, `data/`, `src/lib/schema.ts`, `content/STYLE.md`, `content/translit.yaml`, `README.md` | Scaffold the repo, write `schema.ts` exactly as §3, write and run `vendor.ts`, commit `data/`. Seed `translit.yaml` with the ~50 most frequent Hebrew-script terms in the five chapters' transcripts. Then write `validate-content.ts`. At the end: run validation over everything, reconcile term spellings across chapters, write README. |
| **B — site** | `astro.config.ts`, `src/` except `src/lib/schema.ts`, `public/` | Everything in §4. Starts at once against §3 and §2.4; until real files land, works from a fixture it keeps under `src/fixtures/` (one concept of chapter 3) and deletes before finishing. Checks screen at 375 px and 1280 px and print preview in Chromium (Playwright is installed). |
| **C — chapter 1** | `content/chapter_01/` | 3 tapes, ~15k transcript words, plus the no-source handling for §1–20. |
| **D — chapters 2 and 3** | `content/chapter_02/`, `content/chapter_03/` | ~14.5k words. Chapter 3 is his own summary of 1–2; do it second. |
| **E — chapters 4 and 5** | `content/chapter_04/`, `content/chapter_05/` | ~14k words. Chapter 5 §42–43 area is covered by both 061 and 062: cite both where 062 adds something. |

Order: A scaffolds and lands `schema.ts` + `data/` first (B starts in parallel from the spec). C, D, E start when `data/` and `translit.yaml` are committed. Nobody edits another agent's paths; a needed schema change goes to A. Agent A adds `astro` and other site dependencies to `package.json` on B's request, or B is allowed to edit only the `dependencies` block. C/D/E run `npm run check` before finishing and fix their own errors. Done when `npm run build` passes, all five chapters render, a listen button plays the right moment for a spot check of three units per chapter, and the print preview of one chapter shows running headers and page numbers.

## 7. Open questions (none blocks the build)

1. **Whose translation is on Sefaria?** It is credited to Rabbi Amiram Markel (CC-BY, neirot.com). Is that the cousin's translation Markel Son meant, or is there another one he would rather use? CC-BY allows reuse with credit; the demo credits it and links to Sefaria.
2. **Hebrew text rights.** Sefaria lists the Hebrew version's licence as "unknown" (source: neirot.com). The demo uses the Hebrew already held in shaar-hayichud-sections. Fine for a private demo; needs a clear answer before distributing booklets.
3. **Transliteration style.** The guide uses Ashkenazi/Chabad spellings (*chachma*, *hisbonenus*) per Markel Son's example, while the translation uses *Chochmah*/*Hitbonenut*. Leave the mismatch, respell the translation (CC-BY permits changes, marked as such), or have him supply a spelling list?
4. **Chapter 1, first 20 lines have no recording** in this series. Does Rabbi Markel have another shiur on the opening? More generally (his point 4): which other shiurim exist, in what form, and may they be transcribed? The content format already lets one passage cite several classes; future work is a `teacher/series` field per source in the UI, a merge policy when two classes explain a line differently, and transcription cost (Sofer.ai per audio hour).
5. **Voice.** Should the explanation speak impersonally (as drafted) or attribute to "Rabbi Markel" throughout? Should students' questions from the recordings appear?
6. **Publishing the recordings and raw transcripts** alongside the guide: is Rabbi Markel comfortable with listen links and the "source transcript" panel in what students see, or should those be reviewer-only?
7. **Review workflow.** How do he and his father want to edit: Markdown files in GitHub, a Google Doc export, or comments on a printed draft? This decides whether a simple editing UI is worth building.
8. **Pace and packaging.** One-year course, weekly two-hour shiur, 54 chapters: how many chapters per week and per booklet? Print size (Letter or A5 booklet)? Does Lemaan Yilmedu have a house style or need its name on the cover?
9. **Depth.** The classes are an "advanced" series with long digressions. How much of that belongs in a preparation guide: only what explains the line, or also the wider discussions (e.g. chapter 5's two extra tapes)?
10. **Privacy/indexing.** The demo is set to noindex on a public pages.dev URL. Should it sit behind Cloudflare Access instead?
