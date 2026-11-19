/**
 * Checks content/ against data/ (spec §2.4 and §3).
 *
 *   npm run validate                 # every chapter that has a content folder
 *   npm run validate -- --chapter 3  # one chapter (repeatable)
 *   npm run validate -- --strict     # warnings fail too
 *   npm run validate -- --content <dir>  # check another content folder
 *
 * Errors fail the run (and `npm run build`); warnings are printed only.
 * Every message names the file and line, says what is wrong and how to fix it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ChapterFileSchema, SourcesFileSchema, type ChapterFile, type Segment, type Source } from '../src/lib/schema.ts';
import { CHAPTERS } from '../src/lib/chapters.ts';

const ROOT = resolve(import.meta.dirname, '..');

const { values: args } = parseArgs({
  options: {
    chapter: { type: 'string', multiple: true },
    strict: { type: 'boolean', default: false },
    content: { type: 'string' },
  },
});
const onlyChapters = args.chapter?.map(Number);
/** --content <dir> checks another content folder (used to test this script). */
const CONTENT = args.content !== undefined ? resolve(args.content) : join(ROOT, 'content');
const DATA = join(ROOT, 'data');
/** A listen link this far outside its unit's coverage in that class is flagged. */
const COVERAGE_SLACK_SECONDS = 120;

// ------------------------------------------------------------------ reporting

interface Problem { level: 'error' | 'warning'; file: string; line: number | null; message: string }
const problems: Problem[] = [];
const rel = (path: string): string => relative(ROOT, path);
const error = (file: string, line: number | null, message: string): void => {
  problems.push({ level: 'error', file: rel(file), line, message });
};
const warn = (file: string, line: number | null, message: string): void => {
  problems.push({ level: 'warning', file: rel(file), line, message });
};

// ------------------------------------------------------------------ schemas for content/

const StatusSchema = z.enum(['ai-draft', 'no-source', 'edited', 'reviewed']);

const ConceptFrontmatterSchema = z.strictObject({
  title: z.string().trim().min(1),
  segments: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  inShort: z.string().trim().min(1),
  status: StatusSchema,
  reviewNotes: z.array(z.string().trim().min(1)).optional(),
});
type ConceptFrontmatter = z.infer<typeof ConceptFrontmatterSchema>;

const ChapterFrontmatterSchema = z.strictObject({
  chapter: z.number().int(),
  title: z.string().trim().min(1),
  status: StatusSchema,
});

const TermsSchema = z.array(
  z.strictObject({
    term: z.string().trim().min(1),
    he: z.string().trim().min(1),
    gloss: z.string().trim().min(1),
    segment: z.number().int().positive(),
  }),
);

const TranslitSchema = z.array(
  z.strictObject({
    he: z.string().trim().min(1),
    term: z.string().trim().min(1),
    gloss: z.string(),
  }),
);

function zodMessage(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

// ------------------------------------------------------------------ helpers

const pad2 = (n: number): string => String(n).padStart(2, '0');

function clock(seconds: number): string {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${pad2(m)}:${s}` : `${m}:${s}`;
}

const rangeLabel = (a: number, b: number): string => (a === b ? `§${a}` : `§${a}–${b}`);

/** Normalise Hebrew for comparing spellings: drop nikud, geresh/gershayim and quote marks. */
const normHe = (s: string): string => s.replace(/[֑-ׇ"'״׳]/g, '').replace(/\s+/g, ' ').trim();

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Text used for the bold-quote check: quotes, dashes and spaces normalised, lower case. */
function normQuote(s: string): string {
  return s
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A segment's English with footnote markers and tags removed. */
function plainEnglish(seg: Segment): string {
  return decodeEntities(seg.en.replace(/<sup data-fn="\d+">[^<]*<\/sup>/g, '').replace(/<[^>]+>/g, ''));
}

/** Split a file into YAML frontmatter and body, with the body's first line number. */
function splitFrontmatter(text: string): { yaml: string; body: string; bodyLine: number } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  return { yaml: m[1]!, body: text.slice(m[0].length), bodyLine: m[0].split('\n').length };
}

function parseYamlAt(file: string, text: string, line: number | null): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch (e) {
    error(file, line, `YAML does not parse: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

// ------------------------------------------------------------------ data

const sources = new Map<string, Source>(
  SourcesFileSchema.parse(JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8'))).sources.map((s) => [s.key, s]),
);

function loadChapter(n: number): ChapterFile {
  return ChapterFileSchema.parse(JSON.parse(readFileSync(join(DATA, 'chapters', `chapter_${pad2(n)}.json`), 'utf8')));
}

const translitPath = join(CONTENT, 'translit.yaml');
const translit = new Map<string, { term: string; he: string }>();
{
  const parsed = TranslitSchema.safeParse(parseYamlAt(translitPath, readFileSync(translitPath, 'utf8'), null));
  if (!parsed.success) {
    error(translitPath, null, `does not match [{ he, term, gloss }]: ${zodMessage(parsed.error)}`);
  } else {
    for (const t of parsed.data) {
      const key = normHe(t.he);
      const prev = translit.get(key);
      if (prev && prev.term !== t.term) error(translitPath, null, `"${t.he}" is spelled both "${prev.term}" and "${t.term}"; keep one`);
      translit.set(key, { term: t.term, he: t.he });
    }
  }
}
/** Terms from every chapter's _terms.yaml, to compare spellings across chapters. */
const chapterTerms = new Map<string, { term: string; file: string }[]>();

// ------------------------------------------------------------------ concept files

interface Unit { from: number; to: number; line: number; text: string; bodyStartLine: number }

const HEADING = /^## §(\d+)(?:–(\d+))?$/;
const LISTEN = /\[([^\]]*)\]\(listen:([^)#\s]*)#([^)\s]*)\)/g;
const BOLD = /\*\*([\s\S]+?)\*\*/g;
const LEADINS = new Set(['key point:', 'mashal:']);

function parseUnits(file: string, body: string, bodyLine: number): Unit[] {
  const units: Unit[] = [];
  let current: Unit | null = null;
  let buf: string[] = [];
  const close = (): void => {
    if (current) current.text = buf.join('\n');
    buf = [];
  };
  body.split(/\r?\n/).forEach((text, i) => {
    const lineNo = bodyLine + i;
    const m = HEADING.exec(text.trimEnd());
    if (m) {
      close();
      const from = Number(m[1]);
      current = { from, to: m[2] !== undefined ? Number(m[2]) : from, line: lineNo, text: '', bodyStartLine: lineNo + 1 };
      units.push(current);
      return;
    }
    if (/^##\s*§/.test(text)) {
      error(file, lineNo, `unit heading "${text.trim()}" is malformed; write "## §5" or "## §5–7" (en dash "–", no spaces)`);
    } else if (/^#{1,6}\s/.test(text)) {
      error(file, lineNo, `heading "${text.trim()}" is not allowed in a concept file; use only "## §n" / "## §n–m" unit headings (the concept title goes in the frontmatter)`);
    } else if (!current && text.trim() !== '') {
      error(file, lineNo, 'text before the first "## §n" heading; every paragraph must sit under a unit heading');
    }
    buf.push(text);
  });
  close();
  return units;
}

/** Prose checks: spelling of the Name and untransliterated Hebrew. */
function checkProse(file: string, text: string, lineOf: (index: number) => number): void {
  for (const m of text.matchAll(/\b(God|Godly|Godliness|God's)\b/g)) {
    error(file, lineOf(m.index), `write "${m[1]!.replace('God', 'G-d')}", not "${m[1]}"`);
  }
  const withoutBold = text.replace(BOLD, (s) => ' '.repeat(s.length));
  const hebrewRun = /[א-ת][א-ת֑-ׇ"'״׳]*(?:\s+[א-ת][א-ת֑-ׇ"'״׳]*)*/g;
  for (const m of withoutBold.matchAll(hebrewRun)) {
    const t = translit.get(normHe(m[0]));
    const hint = t ? `; translit.yaml spells it *${t.term}*` : "; if it is a term, add it to the chapter's _terms.yaml";
    warn(file, lineOf(m.index), `Hebrew script "${m[0]}" in the prose; write terms as italic transliterations${hint}`);
  }
}

function checkUnit(file: string, fm: ConceptFrontmatter, unit: Unit, chapter: ChapterFile): void {
  const label = rangeLabel(unit.from, unit.to);
  const segs = chapter.segments.filter((s) => s.n >= unit.from && s.n <= unit.to);
  const text = unit.text;
  const lineOf = (index: number): number => unit.bodyStartLine + text.slice(0, index).split('\n').length - 1;

  if (text.trim() === '') {
    const named = (fm.reviewNotes ?? []).some((n) => new RegExp(`§${unit.from}(?!\\d)`).test(n));
    if (fm.status !== 'no-source' && !named) {
      error(file, unit.line, `${label} is empty; write its explanation, or, if nothing usable was said, add a reviewNotes entry starting "${label}:" saying why`);
    }
    return;
  }

  // Listen links.
  const links = [...text.matchAll(LISTEN)];
  if (links.length === 0) {
    error(file, unit.line, `${label} has no listen link; cite where the explanation starts, e.g. [▶ 4:12](listen:021#252) (class key, then the "t" second of the transcript sentence)`);
  }
  for (const m of links) {
    const linkLabel = m[1]!;
    const key = m[2]!;
    const secText = m[3]!;
    const line = lineOf(m.index);
    const source = sources.get(key);
    if (!source) {
      error(file, line, `listen:${key}#${secText}: unknown class "${key}"; use a key from data/sources.json (${[...sources.keys()].join(', ')})`);
      continue;
    }
    if (!/^\d+(\.\d+)?$/.test(secText)) {
      error(file, line, `listen:${key}#${secText}: the part after # must be a number of seconds, e.g. listen:${key}#252`);
      continue;
    }
    const sec = Number(secText);
    if (sec > source.durationSeconds) {
      error(file, line, `listen:${key}#${secText}: class ${key} is only ${Math.floor(source.durationSeconds)} s (${clock(source.durationSeconds)}) long`);
      continue;
    }
    const expected = `▶ ${clock(sec)}`;
    if (linkLabel.trim() !== expected) warn(file, line, `listen:${key}#${secText}: link text "${linkLabel}" should be "${expected}"`);
    if (!source.chapters.includes(chapter.chapter)) warn(file, line, `listen:${key}: class ${key} (${source.title}) is not a class on chapter ${chapter.chapter}`);
    const cov = segs.flatMap((s) => s.coverage).filter((c) => c.source === key);
    if (cov.length === 0) {
      warn(file, line, `listen:${key}#${secText}: class ${key} has no aligned line in ${label}; check the class key (fine for a recap cited on purpose)`);
    } else {
      const lo = Math.min(...cov.map((c) => c.startSeconds));
      const hi = Math.max(...cov.map((c) => c.endSeconds));
      if (sec < lo - COVERAGE_SLACK_SECONDS || sec > hi + COVERAGE_SLACK_SECONDS) {
        warn(file, line, `listen:${key}#${secText} (${clock(sec)}) is outside ${label}'s coverage in class ${key} (${clock(lo)}–${clock(hi)}, ±${COVERAGE_SLACK_SECONDS} s); check the second (fine for a later recap cited on purpose)`);
      }
    }
  }
  for (const m of text.matchAll(/\]\(listen:[^)]*\)/g)) {
    if (!/^\]\(listen:[^)#\s]+#[^)\s]+\)$/.test(m[0])) error(file, lineOf(m.index), `malformed listen link "${m[0].slice(2)}"; write (listen:021#252)`);
  }

  // Bold runs must quote the unit's translation.
  const english = normQuote(segs.map(plainEnglish).join(' '));
  for (const m of text.matchAll(BOLD)) {
    const inner = m[1]!;
    if (LEADINS.has(inner.trim().toLowerCase())) continue;
    const pieces = inner
      .replace(/(?<![*\w])[*_]|[*_](?![*\w])/g, '') // Markdown emphasis inside the quote
      .split(/…|\.\.\./)
      .map((p) => normQuote(p).replace(/^[\s,.;:!?"'()]+|[\s,.;:!?"'()]+$/g, ''))
      .filter((p) => p !== '');
    const missing = pieces.find((p) => !english.includes(p));
    if (missing !== undefined) {
      const shown = inner.length > 70 ? `${inner.slice(0, 70)}…` : inner;
      warn(file, lineOf(m.index), `bold "${shown}" is not a verbatim quote of ${label}'s translation (not found: "${missing.slice(0, 60)}"); copy the words exactly, or don't bold them`);
    }
  }

  // Callouts.
  const callouts = [...text.matchAll(/^>\s*\*\*(Key point|Mashal):\*\*/gm)];
  if (callouts.length > 1) warn(file, lineOf(callouts[1]!.index), `${label} has ${callouts.length} callouts; at most one "> **Key point:**" or "> **Mashal:**" per unit`);
  for (const m of text.matchAll(/^>\s*\*\*([^*]+)\*\*/gm)) {
    if (!LEADINS.has(m[1]!.trim().toLowerCase())) warn(file, lineOf(m.index), `callout "${m[1]}" should start "> **Key point:**" or "> **Mashal:**"`);
  }

  checkProse(file, text, lineOf);
}

function checkConcept(file: string, chapter: ChapterFile): { from: number; to: number } | null {
  const split = splitFrontmatter(readFileSync(file, 'utf8'));
  if (!split) {
    error(file, 1, 'no YAML frontmatter; start the file with a "---" line, then title, segments, inShort, status (and optional reviewNotes), then "---"');
    return null;
  }
  const parsed = ConceptFrontmatterSchema.safeParse(parseYamlAt(file, split.yaml, 2));
  if (!parsed.success) {
    error(file, 2, `frontmatter: ${zodMessage(parsed.error)} (expected title: string, segments: [from, to], inShort: string, status: ai-draft | no-source | edited | reviewed, reviewNotes?: string[])`);
    return null;
  }
  const fm = parsed.data;
  const [from, to] = fm.segments;
  const max = chapter.segments.length;
  if (from > to) {
    error(file, 2, `segments: [${from}, ${to}] runs backwards`);
    return null;
  }
  if (to > max) {
    error(file, 2, `segments: [${from}, ${to}] goes past §${max}, the last segment of chapter ${chapter.chapter}`);
    return null;
  }

  const units = parseUnits(file, split.body, split.bodyLine);
  if (units.length === 0) {
    error(file, split.bodyLine, `no unit sections; add "## §n" headings covering ${rangeLabel(from, to)}`);
    return { from, to };
  }
  let expect = from;
  for (const u of units) {
    const label = rangeLabel(u.from, u.to);
    if (u.from > u.to) {
      error(file, u.line, `"## ${label}" runs backwards`);
    } else if (u.from > expect) {
      error(file, u.line, `"## ${label}" leaves out ${rangeLabel(expect, u.from - 1)}; units must cover ${rangeLabel(from, to)} in order with no gap`);
    } else if (u.from < expect) {
      error(file, u.line, `"## ${label}" overlaps segments already covered (up to §${expect - 1}); units must cover ${rangeLabel(from, to)} in order with no overlap`);
    }
    if (u.to > to) error(file, u.line, `"## ${label}" goes past the concept's last segment §${to} (frontmatter segments: [${from}, ${to}])`);
    expect = Math.max(expect, u.to + 1);
    checkUnit(file, fm, u, chapter);
  }
  if (expect <= to) {
    error(file, units[units.length - 1]!.line, `units stop at §${expect - 1}, but frontmatter segments: [${from}, ${to}] goes on; add a section for ${rangeLabel(expect, to)} or shrink the range`);
  }

  if (fm.status === 'no-source') {
    const covered = chapter.segments.filter((s) => s.n >= from && s.n <= to && s.coverage.length > 0).map((s) => `§${s.n}`);
    if (covered.length > 0) warn(file, 2, `status is no-source, but ${covered.join(', ')} ${covered.length > 1 ? 'have' : 'has'} a recording`);
  }
  checkProse(file, `${fm.title}\n${fm.inShort}`, () => 2);
  return { from, to };
}

// ------------------------------------------------------------------ _chapter.md and _terms.yaml

const LIST_ITEM = /^([-*]|\d+\.)\s/;

function checkChapterFile(file: string, chapter: ChapterFile): void {
  if (!existsSync(file)) {
    error(file, null, 'missing; add it with frontmatter (chapter, title, status) and the sections "## Overview" and "## Review questions"');
    return;
  }
  const split = splitFrontmatter(readFileSync(file, 'utf8'));
  if (!split) {
    error(file, 1, 'no YAML frontmatter (chapter, title, status between "---" lines)');
    return;
  }
  const parsed = ChapterFrontmatterSchema.safeParse(parseYamlAt(file, split.yaml, 2));
  if (!parsed.success) {
    error(file, 2, `frontmatter: ${zodMessage(parsed.error)} (expected chapter: number, title: string, status: ai-draft | no-source | edited | reviewed)`);
  } else if (parsed.data.chapter !== chapter.chapter) {
    error(file, 2, `chapter: ${parsed.data.chapter}, but this is chapter ${chapter.chapter}'s folder`);
  }

  const lines = split.body.split(/\r?\n/);
  const headings = lines.map((t, i) => ({ t: t.trim(), line: split.bodyLine + i })).filter((h) => /^#{1,6}\s/.test(h.t));
  const names = headings.map((h) => h.t);
  if (names.length !== 2 || names[0] !== '## Overview' || names[1] !== '## Review questions') {
    const found = names.length > 0 ? names.map((n) => `"${n}"`).join(', ') : 'none';
    error(file, headings[0]?.line ?? split.bodyLine, `the body must have exactly two headings, "## Overview" then "## Review questions" (found: ${found})`);
    return;
  }
  const ov = headings[0]!;
  const rq = headings[1]!;
  const overview = lines.slice(ov.line - split.bodyLine + 1, rq.line - split.bodyLine).join('\n');
  const words = overview.split(/\s+/).filter(Boolean).length;
  if (words === 0) error(file, ov.line, 'Overview is empty');
  else if (words < 100 || words > 150) warn(file, ov.line, `Overview is ${words} words; aim for 100–150`);
  checkProse(file, overview, (i) => ov.line + 1 + overview.slice(0, i).split('\n').length - 1);

  const items = lines
    .slice(rq.line - split.bodyLine + 1)
    .map((t, i) => ({ t, line: rq.line + 1 + i }))
    .filter((x) => x.t.trim() !== '');
  const questions = items.filter((x) => LIST_ITEM.test(x.t));
  for (const x of items) {
    if (!LIST_ITEM.test(x.t) && !/^\s/.test(x.t)) warn(file, x.line, 'Review questions should be a Markdown list ("- …"), one question per item');
  }
  if (questions.length < 4 || questions.length > 6) warn(file, rq.line, `${questions.length} review questions; aim for 4–6`);
  for (const q of questions) {
    const m = /\(§(\d+)(?:–(\d+))?\)\s*$/.exec(q.t);
    if (!m) error(file, q.line, 'a review question must end with the segment that answers it, e.g. "(§12)"');
    else if (Number(m[2] ?? m[1]) > chapter.segments.length) error(file, q.line, `(${m[0].trim().slice(1, -1)}) is past §${chapter.segments.length}, the last segment of chapter ${chapter.chapter}`);
  }
}

function checkTerms(file: string, chapter: ChapterFile): void {
  if (!existsSync(file)) {
    error(file, null, "missing; add the chapter's 6–12 key terms as a YAML list of { term, he, gloss, segment }");
    return;
  }
  const parsed = TermsSchema.safeParse(parseYamlAt(file, readFileSync(file, 'utf8'), null));
  if (!parsed.success) {
    error(file, null, `does not match [{ term, he, gloss, segment }]: ${zodMessage(parsed.error)}`);
    return;
  }
  const terms = parsed.data;
  if (terms.length < 6 || terms.length > 12) warn(file, null, `${terms.length} key terms; aim for 6–12`);
  for (const t of terms) {
    if (t.segment > chapter.segments.length) {
      error(file, null, `"${t.term}": segment ${t.segment} is past §${chapter.segments.length}, the last segment of chapter ${chapter.chapter}`);
    }
    const key = normHe(t.he);
    const known = translit.get(key);
    if (known && known.term !== t.term) {
      error(file, null, `"${t.he}" is spelled "${t.term}" here but "${known.term}" in content/translit.yaml; use "${known.term}"`);
    }
    const list = chapterTerms.get(key) ?? [];
    list.push({ term: t.term, file: rel(file) });
    chapterTerms.set(key, list);
  }
}

// ------------------------------------------------------------------ chapter

function checkChapter(n: number): boolean {
  const dir = join(CONTENT, `chapter_${pad2(n)}`);
  // A missing or still-empty folder is a chapter nobody has started.
  if (!existsSync(dir) || readdirSync(dir).length === 0) return false;
  const chapter = loadChapter(n);
  const concepts: { file: string; prefix: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (f === '_chapter.md' || f === '_terms.yaml') continue;
    const m = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(f);
    if (m) concepts.push({ file: join(dir, f), prefix: m[1]! });
    else error(join(dir, f), null, 'unexpected file name; concept files are "NN-lower-case-slug.md" (e.g. "03-bina-and-tevuna.md"); the only other files are _chapter.md and _terms.yaml');
  }
  checkChapterFile(join(dir, '_chapter.md'), chapter);
  checkTerms(join(dir, '_terms.yaml'), chapter);

  const seen = new Map<string, string>();
  for (const c of concepts) {
    const prev = seen.get(c.prefix);
    if (prev) error(c.file, null, `prefix ${c.prefix}- is also used by ${prev}; give each concept its own number`);
    seen.set(c.prefix, rel(c.file));
  }

  // Concepts must tile the chapter, in file order.
  const max = chapter.segments.length;
  let expect = 1;
  for (const c of concepts) {
    const r = checkConcept(c.file, chapter);
    if (!r) continue;
    if (r.from > expect) {
      error(c.file, 2, `segments: [${r.from}, ${r.to}] leaves ${rangeLabel(expect, r.from - 1)} in no concept; concepts must cover §1–${max} in file order with no gap`);
    } else if (r.from < expect) {
      error(c.file, 2, `segments: [${r.from}, ${r.to}] overlaps the previous concept, which ends at §${expect - 1}; concepts must cover §1–${max} in file order with no overlap`);
    }
    expect = Math.max(expect, r.to + 1);
  }
  if (concepts.length === 0) error(dir, null, `no concept files; add NN-slug.md files covering §1–${max}`);
  else if (expect <= max) error(dir, null, `${rangeLabel(expect, max)} ${expect === max ? 'is' : 'are'} in no concept file; concepts must cover §1–${max}`);
  return true;
}

// ------------------------------------------------------------------ main

const checked: number[] = [];
const skipped: number[] = [];
for (const n of CHAPTERS) {
  if (onlyChapters && !onlyChapters.includes(n)) continue;
  (checkChapter(n) ? checked : skipped).push(n);
}
for (const [he, list] of chapterTerms) {
  if (new Set(list.map((x) => x.term)).size > 1) {
    warn(list[0]!.file, null, `"${he}" is spelled differently across chapters: ${list.map((x) => `"${x.term}" (${x.file})`).join(', ')}`);
  }
}

problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
for (const p of problems) {
  console.log(`${p.level === 'error' ? 'error  ' : 'warning'} ${p.file}${p.line !== null ? `:${p.line}` : ''}: ${p.message}`);
}
const errors = problems.filter((p) => p.level === 'error').length;
const warnings = problems.length - errors;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
console.log(
  `validate-content: checked chapter(s) ${checked.join(', ') || 'none'}` +
    `${skipped.length > 0 ? ` (no content yet: ${skipped.join(', ')})` : ''}; ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`,
);
if (errors > 0 || (args.strict && warnings > 0)) process.exit(1);
