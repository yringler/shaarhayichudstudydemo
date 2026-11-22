/**
 * The content documents of the EPUB editions (scripts/build-epub.ts), one view
 * at a time, from the same typed models as the site and the PDF
 * (src/lib/content.ts). Unlike the PDF, which prints /book/ and hides the
 * other views with CSS, each EPUB holds only its own view's markup, so a
 * reader's search and read-aloud never meet hidden text.
 *
 * Every edition is a single column. Each passage opens with its § label; the
 * Hebrew follows as its own right-to-left paragraph, then (in the study guide)
 * the translation and its footnotes, then the explanation. Side-by-side columns,
 * as in the 7 × 10 PDF, do not survive reflowable readers: Kindle ignores flex
 * and media queries, and a phone leaves a few words a line (README "EPUB").
 *
 * The front matter repeats book.astro's wording where it fits an ebook; keep
 * the two in step.
 */
import { chaptersTitle } from '../../src/lib/chapters';
import { glossary, type ChapterModel, type ConceptModel, type Guide, type UnitModel } from '../../src/lib/content';
import { classNumber, formatTime, segmentLabel } from '../../src/lib/format';
import { esc, text, toXhtml, xhtmlDocument } from './xhtml';

import type { EpubView } from '../../src/lib/chapters';
export type { EpubView };

/** One content document: its file name (in OEBPS/), title for the nav, and XHTML. */
export interface ContentDoc {
  file: string;
  title: string;
  xhtml: string;
  /** Spine `linear="no"`: reachable by link, skipped when reading straight through. */
  auxiliary?: boolean;
  /** EPUB structural type of the body, for the landmarks. */
  type: 'frontmatter' | 'bodymatter' | 'backmatter';
}

/** One nav entry: a chapter with its concept headings, or a front/back matter page. */
export interface NavEntry {
  label: string;
  href: string;
  children: NavEntry[];
}

export interface EpubBook {
  docs: ContentDoc[];
  nav: NavEntry[];
  /** "Shaar HaYichud: Study Guide · Booklet 1 · Explanation only" and the like. */
  title: string;
  /** One sentence for dc:description. */
  description: string;
}

/** The edition's name, as /pdfs/ names it. */
export const EDITION_NAME: Readonly<Record<EpubView, string>> = {
  guide: 'Study guide',
  explanation: 'Explanation only',
  hebrew: 'Hebrew and explanation',
};

/** The title page's line under "Study Guide": what the edition contains (book.astro). */
const WITH_LINE: Readonly<Record<EpubView, string>> = {
  guide: 'The Hebrew text with the English translation of Rabbi Amiram Markel, and explanations following the classes of Rabbi Markel',
  explanation: 'Explanations following the classes of Rabbi Amiram Markel, quoting his English translation',
  hebrew: 'The Hebrew text with explanations following the classes of Rabbi Amiram Markel, quoting his English translation',
};

const chapterFile = (n: number): string => `chapter-${n}.xhtml`;

/**
 * Where each in-book anchor of the PDF ("ch3-s12", "ch3-some-concept",
 * "chapter-3") is in this edition: its file and the id of the nearest element
 * that the edition renders. A passage the explanation view leaves out points to
 * its concept heading, as the PDF's page references do.
 */
class Anchors {
  private readonly map = new Map<string, string>();

  set(id: string, file: string, target = id): void {
    if (!this.map.has(id)) this.map.set(id, `${file}#${target}`);
  }

  /** "#ch3-s12" → "chapter-3.xhtml#ch3-s12"; external and unknown hrefs unchanged. */
  resolve = (href: string): string => {
    if (!href.startsWith('#')) return href;
    const hit = this.map.get(href.slice(1));
    if (!hit) throw new Error(`EPUB: no target for the in-book link ${href}`);
    return hit;
  };
}

/** Does this view show the unit (and so give it an anchor of its own)? */
function showsUnit(view: EpubView, u: UnitModel): boolean {
  return view === 'explanation' ? u.explanationHtml !== null : true;
}

/** Register every anchor a chapter defines in this view, before any document is written. */
function registerChapter(a: Anchors, view: EpubView, c: ChapterModel): void {
  const file = chapterFile(c.n);
  a.set(`chapter-${c.n}`, file);
  for (const k of c.concepts) {
    a.set(k.id, file);
    for (const u of k.units) {
      const unitId = `ch${c.n}-s${u.from}`;
      for (const s of u.segments) {
        const id = `ch${c.n}-s${s.n}`;
        if (!showsUnit(view, u)) a.set(id, file, k.id);
        // The explanation view gives a unit one label; the others give each § its own.
        else a.set(id, file, view === 'explanation' ? unitId : id);
      }
    }
  }
}

// ---------------------------------------------------------------- passages

/** "§21" or "§21–23" over a passage, or over each paragraph of one. */
function refLabel(label: string, id?: string): string {
  return `<p class="seg-label"${id ? ` id="${id}"` : ''}>${esc(label)}</p>`;
}

function hebrewPara(textHe: string, cls: string): string {
  return `<p class="${cls}" lang="he" xml:lang="he" dir="rtl">${text(textHe)}</p>`;
}

function unitXhtml(view: EpubView, c: ChapterModel, u: UnitModel, a: Anchors): string {
  if (!showsUnit(view, u)) return '';
  const parts: string[] = [];
  const id = (n: number): string => `ch${c.n}-s${n}`;

  if (view === 'guide') {
    for (const s of u.segments) {
      const fnId = (n: number): string => `fn-${id(s.n)}-${n}`;
      const refId = (n: number): string => `fnref-${id(s.n)}-${n}`;
      const en = toXhtml(s.en, {
        resolveHref: a.resolve,
        noteref: (n) =>
          s.footnotes.some((f) => f.n === n)
            ? `<sup><a epub:type="noteref" role="doc-noteref" class="noteref" id="${refId(n)}" href="#${fnId(n)}">${n}</a></sup>`
            : `<sup>${n}</sup>`,
      });
      const notes = s.footnotes
        .map(
          (f) =>
            `<aside epub:type="footnote" role="doc-footnote" class="footnote" id="${fnId(f.n)}">` +
            `<p><a class="fn-back" href="#${refId(f.n)}">${f.n}</a> ${toXhtml(f.html, { resolveHref: a.resolve })}</p></aside>`,
        )
        .join('\n');
      parts.push(
        `<div class="seg">\n${refLabel(`§${s.n}`, id(s.n))}\n` +
          hebrewPara(s.lines.map((l) => l.text).join(' '), 'seg-he') +
          `\n<p class="seg-en">${en}</p>${notes ? `\n${notes}` : ''}\n</div>`,
      );
    }
    if (u.explanationHtml !== null) {
      parts.push(
        `<div class="explanation">\n<p class="explanation-label">Explanation <span class="unit-ref">${esc(u.label)}</span></p>\n` +
          `${toXhtml(u.explanationHtml, { resolveHref: a.resolve })}\n</div>`,
      );
    }
  } else if (view === 'hebrew') {
    for (const s of u.segments) {
      parts.push(`${refLabel(`§${s.n}`, id(s.n))}\n${hebrewPara(s.lines.map((l) => l.text).join(' '), 'he-full')}`);
    }
    if (u.explanationHtml !== null) parts.push(`<div class="explanation">\n${toXhtml(u.explanationHtml, { resolveHref: a.resolve })}\n</div>`);
  } else {
    parts.push(`${refLabel(u.label, id(u.from))}\n${hebrewPara(u.incipit, 'incipit')}`);
    parts.push(`<div class="explanation">\n${toXhtml(u.explanationHtml ?? '', { resolveHref: a.resolve })}\n</div>`);
  }
  return `<div class="unit">\n${parts.join('\n')}\n</div>`;
}

function conceptXhtml(view: EpubView, c: ChapterModel, k: ConceptModel, a: Anchors): string {
  const out: string[] = [
    `<section class="concept" id="${k.id}">`,
    `<h2 class="concept-title"><span class="concept-title-text">${text(k.title)}</span> <span class="concept-range">${esc(segmentLabel(k.from, k.to))}</span></h2>`,
  ];
  if (view === 'guide' && k.status === 'pending') {
    out.push('<p class="concept-note">The explanation of this passage has not been written yet. The heading is the book’s own section label.</p>');
  }
  if (view === 'guide' && k.status === 'no-source') {
    out.push('<p class="concept-note">The classes in this series begin after this passage. The text and translation are given without explanation.</p>');
  }
  if (k.inShortHtml) {
    out.push(`<aside class="callout callout-in-short"><p><strong class="lead">In short:</strong> ${toXhtml(k.inShortHtml, { resolveHref: a.resolve })}</p></aside>`);
  }
  for (const u of k.units) {
    const x = unitXhtml(view, c, u, a);
    if (x) out.push(x);
  }
  out.push('</section>');
  return out.join('\n');
}

function chapterXhtml(view: EpubView, c: ChapterModel, a: Anchors, draft: boolean): string {
  const out: string[] = [
    `<section epub:type="chapter" role="doc-chapter" class="chapter" id="chapter-${c.n}">`,
    '<header class="chapter-head">',
    `<p class="eyebrow">Chapter ${c.n}</p>`,
    `<h1 class="chapter-title">${text(c.title)}</h1>`,
    `<p class="eyebrow-he" lang="he" xml:lang="he" dir="rtl">${text(c.heRef)}</p>`,
    '</header>',
  ];
  if (draft) out.push('<p class="draft-line">Draft — not reviewed. Do not distribute.</p>');
  if (!c.hasGuide) {
    out.push('<p class="notice">The study guide for this chapter has not been written yet. The Hebrew text and translation are shown under the book’s own section labels.</p>');
  }
  if (c.overviewHtml) {
    out.push(`<section class="overview">\n<h2 class="sub-head">Overview</h2>\n${toXhtml(c.overviewHtml, { resolveHref: a.resolve })}\n</section>`);
  }
  if (c.terms.length > 0) {
    out.push(
      '<section class="key-terms">\n<h2 class="sub-head">Key terms</h2>\n<dl>\n' +
        c.terms
          .map(
            (t) =>
              `<dt><em>${text(t.term)}</em> <span class="term-he" lang="he" xml:lang="he" dir="rtl">${text(t.he)}</span></dt>\n<dd>${text(t.gloss)}</dd>`,
          )
          .join('\n') +
        '\n</dl>\n</section>',
    );
  }
  for (const k of c.concepts) out.push(conceptXhtml(view, c, k, a));
  if (c.reviewQuestionsHtml) {
    out.push(`<section class="review">\n<h2 class="sub-head">Review questions</h2>\n${toXhtml(c.reviewQuestionsHtml, { resolveHref: a.resolve })}\n</section>`);
  }
  if (c.sources.length > 0) {
    out.push(
      '<section class="class-list">\n<h2 class="sub-head">Classes on this chapter</h2>\n' +
        `<p class="class-series">Rabbi Markel, ${text(c.sources[0]?.series ?? '')}. Each links to its recording.</p>\n<ol class="classes">\n` +
        c.sources
          .map((s) => `<li><a href="${esc(s.audioUrl)}">Class ${classNumber(s.key)}</a> · ${text(s.title)} <span class="class-dur">(${formatTime(s.durationSeconds)})</span></li>`)
          .join('\n') +
        '\n</ol>\n</section>',
    );
  }
  out.push('</section>');
  return out.join('\n');
}

// ---------------------------------------------------------------- front and back matter

/** Section counts by status, for the copyright page. */
function statusCounts(guide: Guide): { reviewed: number; edited: number; ai: number; none: number; sections: number } {
  const n = { reviewed: 0, edited: 0, ai: 0, none: 0, sections: 0 };
  for (const c of guide.chapters) {
    for (const k of c.concepts) {
      n.sections++;
      if (k.status === 'reviewed') n.reviewed++;
      else if (k.status === 'edited') n.edited++;
      else if (k.status === 'ai-draft') n.ai++;
      else n.none++;
    }
  }
  return n;
}

function titlePage(view: EpubView, draft: boolean): string {
  return [
    '<section epub:type="titlepage" class="titlepage">',
    '<p class="title-he" lang="he" xml:lang="he" dir="rtl">שער היחוד</p>',
    '<h1 class="title-main">Shaar HaYichud</h1>',
    '<p class="title-en">The Gate of Unity</p>',
    '<p class="title-author">by the Mitteler Rebbe</p>',
    '<hr class="title-rule"/>',
    '<p class="title-guide">Study Guide</p>',
    `<p class="title-booklet">Booklet 1 · ${esc(chaptersTitle())}</p>`,
    `<p class="title-edition">${esc(EDITION_NAME[view])}</p>`,
    `<p class="title-with">${esc(WITH_LINE[view])}</p>`,
    draft ? '<p class="title-draft">Draft for review · not for distribution</p>' : '',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function copyrightPage(view: EpubView, guide: Guide, draft: boolean, printed: string, copyrightLine: string): string {
  const t = guide.translation;
  const n = statusCounts(guide);
  const source = t ? t.source.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'neirot.com';
  return [
    '<section epub:type="copyright-page" class="copyright">',
    `<p><strong>Shaar HaYichud: Study Guide.</strong> Booklet 1, ${esc(chaptersTitle())}. ${esc(EDITION_NAME[view])} edition (ebook).</p>`,
    copyrightLine ? `<p>${esc(copyrightLine)}</p>` : '',
    draft
      ? '<aside class="draft-box"><p class="draft-head">Draft for review</p><p>The explanations were drafted by AI from recordings of Rabbi Markel’s classes and have not yet been reviewed by him. Do not rely on them or distribute them. ' +
        `Made ${esc(printed)}.</p></aside>`
      : '',
    `<p><strong>English translation:</strong> “${esc(t?.versionTitle ?? 'Translated by Rabbi Amiram Markel, 2023')}”, licensed under Creative Commons Attribution (CC BY 4.0, creativecommons.org/licenses/by/4.0), from ${esc(source)}, ` +
      'via Sefaria (sefaria.org, “The Gate of Unity”). Changes: formatting reduced to italics, bold and footnotes, and the Name spelled G-d. The footnotes are the translator’s.</p>',
    view !== 'explanation'
      ? `<p><strong>Hebrew text:</strong> from the Shaar HaYichud class archive (shaar-hayichud-sections${guide.sectionsCommit ? `, commit ${esc(guide.sectionsCommit.slice(0, 7))}` : ''}).</p>`
      : '',
    '<p><strong>Classes:</strong> the explanations follow Rabbi Markel’s recorded classes, the “Rabbi Markel Series (Advanced)”. References such as “(class 21, 4:12)” give the class and the time in its recording where the point is made, and link to the recording.</p>',
    `<p><strong>How the explanations were written:</strong> each was drafted with AI from a machine transcript (Sofer.ai) of the class on that passage, and is meant to say only what was said in the class. Of the ${n.sections} sections in this booklet, ` +
      `${n.reviewed} ${n.reviewed === 1 ? 'has' : 'have'} been reviewed, ${n.edited} edited and ${n.ai} ${n.ai === 1 ? 'is an AI draft' : 'are AI drafts'}${n.none > 0 ? `; ${n.none} have no explanation` : ''}.</p>`,
    '<p><strong>Fonts:</strong> Source Serif 4 and Frank Ruhl Libre, under the SIL Open Font License (<a href="licences.xhtml">licences</a>).</p>',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function aboutPage(view: EpubView, draft: boolean): string {
  const edition: Record<EpubView, string> = {
    guide:
      'Each passage gives the Hebrew text, then Rabbi Amiram Markel’s English translation, numbered by paragraph (§) as on Sefaria, with the translator’s footnotes under the English. The explanation after it is drawn from Rabbi Markel’s recorded class on that passage.',
    explanation:
      'This edition gives the explanations only, as continuous prose. They are drawn from Rabbi Markel’s recorded classes and follow the text paragraph by paragraph; the paragraph numbers (§) are those of the English translation on Sefaria. Each explanation is headed by its paragraph numbers and the opening words of its passage in Hebrew, so that it can be found in the text.',
    hebrew:
      'This edition gives the whole Hebrew text, without the translation, and after each passage the explanation drawn from Rabbi Markel’s recorded class on it; passages the classes do not explain are given in Hebrew alone. The paragraph numbers (§) over the Hebrew are those of the English translation on Sefaria, which the explanations quote.',
  };
  return [
    '<section epub:type="preface" class="about" id="about-this-guide">',
    '<h1 class="section-title">About this guide</h1>',
    '<p>This is a preparation guide for the weekly class on the Mitteler Rebbe’s <em>Shaar HaYichud</em>. Each chapter is organised under headings that name the idea being taught, each with a one-line “In short”.</p>',
    `<p>${esc(edition[view])}</p>`,
    '<p>Words quoted from the translation are in <strong>bold</strong>; Hebrew and Aramaic terms are in <em>italics</em>, in the spelling of the glossary at the back. References such as “(class 21, 4:12)” give the class in Rabbi Markel’s advanced series and the time in its recording where the point is made, and link to the recording, so anything here can be checked against what was actually said. Each chapter ends with review questions and a list of the classes on it.</p>',
    draft
      ? '<p class="draft-line"><strong>This is a draft.</strong> The explanations were drafted by AI from machine transcripts of the classes and have not yet been reviewed by Rabbi Markel.</p>'
      : '',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function glossaryPage(guide: Guide, a: Anchors): string {
  const terms = glossary(guide);
  return [
    '<section epub:type="glossary" role="doc-glossary" class="glossary" id="glossary">',
    '<h1 class="section-title">Glossary</h1>',
    '<p class="glossary-lede">The key terms of each chapter, in the transliteration this guide uses, with the passage where each first appears.</p>',
    '<dl>',
    ...terms.map(
      (t) =>
        `<dt><em>${text(t.term)}</em> <span class="term-he" lang="he" xml:lang="he" dir="rtl">${text(t.he)}</span></dt>\n` +
        `<dd>${text(t.gloss)} <a class="gloss-where" href="${esc(a.resolve(`#ch${t.chapter}-s${t.segment}`))}">Chapter ${t.chapter}, §${t.segment}</a></dd>`,
    ),
    '</dl>',
    '</section>',
  ].join('\n');
}

function licencesPage(licences: { family: string; text: string }[]): string {
  return [
    '<section epub:type="appendix" class="licences" id="licences">',
    '<h1 class="section-title">Font licences</h1>',
    ...licences.map((l) => `<h2 class="sub-head">${esc(l.family)}</h2>\n<pre class="licence">${esc(l.text.trim())}</pre>`),
    '</section>',
  ].join('\n');
}

// ---------------------------------------------------------------- the book

export interface BookOptions {
  view: EpubView;
  draft: boolean;
  /** "20 November 2026", for the draft notice. */
  made: string;
  copyrightLine: string;
  licences: { family: string; text: string }[];
}

export function buildBook(guide: Guide, opts: BookOptions): EpubBook {
  const { view, draft } = opts;
  const a = new Anchors();
  for (const c of guide.chapters) registerChapter(a, view, c);
  a.set('about-this-guide', 'about.xhtml');
  a.set('glossary', 'glossary.xhtml');

  const docs: ContentDoc[] = [
    { file: 'title.xhtml', title: 'Title page', type: 'frontmatter', xhtml: xhtmlDocument('Shaar HaYichud', titlePage(view, draft), { bodyClass: 'front' }) },
    {
      file: 'copyright.xhtml',
      title: 'Copyright and credits',
      type: 'frontmatter',
      xhtml: xhtmlDocument('Copyright and credits', copyrightPage(view, guide, draft, opts.made, opts.copyrightLine), { bodyClass: 'front' }),
    },
    { file: 'about.xhtml', title: 'About this guide', type: 'frontmatter', xhtml: xhtmlDocument('About this guide', aboutPage(view, draft)) },
    ...guide.chapters.map(
      (c): ContentDoc => ({
        file: chapterFile(c.n),
        title: `Chapter ${c.n}: ${c.title}`,
        type: 'bodymatter',
        xhtml: xhtmlDocument(`Chapter ${c.n}: ${c.title}`, chapterXhtml(view, c, a, draft), { bodyType: 'bodymatter' }),
      }),
    ),
  ];
  const terms = glossary(guide);
  if (terms.length > 0) {
    docs.push({ file: 'glossary.xhtml', title: 'Glossary', type: 'backmatter', xhtml: xhtmlDocument('Glossary', glossaryPage(guide, a), { bodyType: 'backmatter' }) });
  }
  docs.push({ file: 'licences.xhtml', title: 'Font licences', type: 'backmatter', auxiliary: true, xhtml: xhtmlDocument('Font licences', licencesPage(opts.licences), { bodyType: 'backmatter' }) });

  const nav: NavEntry[] = [
    { label: 'About this guide', href: 'about.xhtml', children: [] },
    ...guide.chapters.map(
      (c): NavEntry => ({
        label: `Chapter ${c.n}: ${c.title}`,
        href: `${chapterFile(c.n)}#chapter-${c.n}`,
        children: c.concepts.map((k) => ({ label: `${k.title} ${segmentLabel(k.from, k.to)}`, href: `${chapterFile(c.n)}#${k.id}`, children: [] })),
      }),
    ),
    ...(terms.length > 0 ? [{ label: 'Glossary', href: 'glossary.xhtml', children: [] }] : []),
  ];

  return {
    docs,
    nav,
    title: `Shaar HaYichud: Study Guide, Booklet 1${view === 'guide' ? '' : ` (${EDITION_NAME[view]})`}`,
    description: `${WITH_LINE[view]}. ${chaptersTitle()}.`,
  };
}
