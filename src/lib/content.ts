/**
 * Build-time loader: reads `data/` (vendored, spec §3) and `content/` (written
 * guide, spec §2.4) and returns typed chapter models for the pages.
 *
 * Errors in the content files throw, so `astro build` fails loudly; the
 * friendlier checks live in `scripts/validate-content.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  ChapterFileSchema,
  SourcesFileSchema,
  TranscriptFileSchema,
  type ChapterFile,
  type Segment,
  type Sentence,
  type Source,
  type TranscriptFile,
  type TranslationInfo,
} from './schema';
import { classNumber, formatTime, parseListenHref, segmentLabel } from './format';

/** Chapters in this booklet. */
export const CHAPTERS = [1, 2, 3, 4, 5] as const;

/** Coverage confidence below which a listen position is flagged as approximate. */
export const LOW_CONFIDENCE = 0.45;

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const CONTENT_DIR = join(ROOT, 'content');

// ---------------------------------------------------------------- content frontmatter

const StatusSchema = z.enum(['ai-draft', 'no-source', 'edited', 'reviewed']);
export type Status = z.infer<typeof StatusSchema> | 'pending';

const ConceptFrontmatterSchema = z.object({
  title: z.string().min(1),
  segments: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  inShort: z.string().optional(),
  status: StatusSchema,
  reviewNotes: z.array(z.string()).optional(),
});

const ChapterFrontmatterSchema = z.object({
  chapter: z.number().int(),
  title: z.string().min(1),
  status: StatusSchema,
});

const TermSchema = z.object({
  term: z.string().min(1),
  he: z.string(),
  gloss: z.string(),
  segment: z.number().int().positive(),
});

// ---------------------------------------------------------------- models

export interface TranscriptBlock {
  source: Source;
  startSeconds: number;
  sentences: Sentence[];
}

export interface UnitModel {
  from: number;
  to: number;
  label: string;
  segments: Segment[];
  /** Rendered explanation, or null when the section is empty. */
  explanationHtml: string | null;
  /** Some line of the unit is covered by a recording. */
  covered: boolean;
  /** Every coverage of the unit is below LOW_CONFIDENCE. */
  approximate: boolean;
  transcript: TranscriptBlock[];
}

export interface ConceptModel {
  /** Anchor id, unique across the booklet: "ch3-bina-and-tevuna". */
  id: string;
  title: string;
  from: number;
  to: number;
  inShortHtml: string | null;
  status: Status;
  reviewNotes: string[];
  units: UnitModel[];
}

export interface TermModel {
  term: string;
  he: string;
  gloss: string;
  segment: number;
  chapter: number;
}

export interface ChapterModel {
  n: number;
  title: string;
  status: Status;
  heRef: string;
  sefariaUrl: string;
  translation: TranslationInfo;
  /** Whether content/chapter_NN exists yet. */
  hasGuide: boolean;
  overviewHtml: string | null;
  reviewQuestionsHtml: string | null;
  terms: TermModel[];
  concepts: ConceptModel[];
  /** Classes on this chapter, in key order. */
  sources: Source[];
  /** Segments with no recording at all. */
  uncovered: number[];
}

export interface Guide {
  chapters: ChapterModel[];
  sources: Source[];
  sectionsCommit: string;
  translation: TranslationInfo | null;
}

// ---------------------------------------------------------------- markdown

interface RenderContext {
  sources: Map<string, Source>;
  approximate: boolean;
}

let ctx: RenderContext = { sources: new Map(), approximate: false };

export function listenLinkHtml(source: Source | undefined, key: string, seconds: number, approximate = false): string {
  const time = formatTime(seconds);
  if (!source) {
    return `<span class="listen listen-broken" title="Unknown class ${escapeHtml(key)}">(class ${escapeHtml(classNumber(key))}, ${time})</span>`;
  }
  const t = Math.floor(seconds);
  const approx = approximate
    ? '<span class="approx" title="The alignment for this passage is uncertain">approx.</span>'
    : '';
  return (
    `<a class="listen${approximate ? ' is-approx' : ''}" href="${escapeHtml(source.audioUrl)}#t=${t}" ` +
    `data-source="${escapeHtml(source.key)}" data-t="${t}" ` +
    `aria-label="Listen: class ${classNumber(source.key)} at ${time}${approximate ? ' (approximate)' : ''}">` +
    `<span class="listen-screen"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>${time}${approx}</span>` +
    `<span class="listen-print">(class ${classNumber(source.key)}, ${time})</span></a>`
  );
}

const md = new Marked({
  gfm: true,
  renderer: {
    link(token: Tokens.Link): string {
      const ref = parseListenHref(token.href);
      if (ref) return listenLinkHtml(ctx.sources.get(ref.source), ref.source, ref.seconds, ctx.approximate);
      const text = this.parser.parseInline(token.tokens);
      const external = /^https?:/.test(token.href);
      return `<a href="${escapeHtml(token.href)}"${external ? ' rel="noopener" target="_blank"' : ''}>${text}</a>`;
    },
    blockquote(token: Tokens.Blockquote): string {
      const inner = this.parser.parse(token.tokens);
      const m = /^<p><strong>(Key point|Mashal|In short):<\/strong>\s*/.exec(inner);
      if (!m || m[1] === undefined) return `<blockquote>${inner}</blockquote>`;
      const kind = m[1].toLowerCase().replace(' ', '-');
      return (
        `<aside class="callout callout-${kind}"><p><strong class="lead">${m[1]}:</strong> ` +
        `${inner.slice(m[0].length)}</aside>`
      );
    },
  },
});

/** Keep "G-d", "G-dly" from breaking at the hyphen (non-breaking hyphen U+2011). */
export function nb(s: string): string {
  return s.replace(/\bG-d/g, 'G\u2011d');
}

function renderBlock(src: string, context: RenderContext): string {
  ctx = context;
  return nb(md.parse(src, { async: false }));
}

function renderInline(src: string, context: RenderContext): string {
  ctx = context;
  return nb(md.parseInline(src, { async: false }));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------- file helpers

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function splitFrontmatter(raw: string, file: string): { data: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`${file}: missing frontmatter`);
  return { data: parseYaml(m[1]) as unknown, body: m[2] };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Split a body on `## <heading>` lines. */
function splitSections(body: string, re: RegExp): { match: RegExpExecArray; text: string }[] {
  const lines = body.split(/\r?\n/);
  const out: { match: RegExpExecArray; text: string }[] = [];
  let current: { match: RegExpExecArray; lines: string[] } | null = null;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) {
      if (current) out.push({ match: current.match, text: current.lines.join('\n').trim() });
      current = { match: m, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ match: current.match, text: current.lines.join('\n').trim() });
  return out;
}

// ---------------------------------------------------------------- building

function buildUnit(
  chapter: ChapterFile,
  transcript: TranscriptFile | null,
  from: number,
  to: number,
  explanation: string,
  sources: Map<string, Source>,
): UnitModel {
  const segments = chapter.segments.filter((s) => s.n >= from && s.n <= to);
  if (segments.length !== to - from + 1) throw new Error(`Chapter ${chapter.chapter}: no segments ${segmentLabel(from, to)} in data`);
  const coverage = segments.flatMap((s) => s.coverage);
  const approximate = coverage.length > 0 && coverage.every((c) => c.confidence < LOW_CONFIDENCE);

  const blocks: TranscriptBlock[] = [];
  for (const span of transcript?.spans ?? []) {
    if (span.segment < from || span.segment > to) continue;
    const source = sources.get(span.source);
    if (!source) continue;
    const last = blocks.at(-1);
    if (last && last.source.key === span.source) last.sentences.push(...span.sentences);
    else blocks.push({ source, startSeconds: span.startSeconds, sentences: [...span.sentences] });
  }

  return {
    from,
    to,
    label: segmentLabel(from, to),
    segments,
    explanationHtml: explanation.trim() ? renderBlock(explanation, { sources, approximate }) : null,
    covered: coverage.length > 0,
    approximate,
    transcript: blocks,
  };
}

function loadConcepts(
  n: number,
  dir: string,
  chapter: ChapterFile,
  transcript: TranscriptFile | null,
  sources: Map<string, Source>,
): ConceptModel[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d+-.+\.md$/.test(f))
    .sort();
  const concepts: ConceptModel[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const { data, body } = splitFrontmatter(readFileSync(path, 'utf8'), path);
    const fm = parseOrThrow(ConceptFrontmatterSchema, data, path);
    const [from, to] = fm.segments;
    const sections = splitSections(body, /^## §(\d+)(?:–(\d+))?$/);
    let expected = from;
    const units: UnitModel[] = [];
    for (const { match, text } of sections) {
      const a = Number(match[1]);
      const b = match[2] === undefined ? a : Number(match[2]);
      if (a !== expected || b < a) throw new Error(`${path}: section ${segmentLabel(a, b)} does not follow §${expected - 1}`);
      units.push(buildUnit(chapter, transcript, a, b, text, sources));
      expected = b + 1;
    }
    if (expected !== to + 1) throw new Error(`${path}: sections end at §${expected - 1}, frontmatter says §${to}`);
    const slug = file.replace(/^\d+-/, '').replace(/\.md$/, '');
    concepts.push({
      id: `ch${n}-${slug}`,
      title: nb(fm.title),
      from,
      to,
      inShortHtml: fm.inShort ? renderInline(fm.inShort, { sources, approximate: false }) : null,
      status: fm.status,
      reviewNotes: fm.reviewNotes ?? [],
      units,
    });
  }
  return concepts;
}

/**
 * Fill every segment no concept file covers yet (a chapter not written, or written
 * only in part) with placeholder concepts: the data's own section labels, one unit
 * per segment. Returns all concepts in segment order.
 */
function withPlaceholders(
  n: number,
  written: ConceptModel[],
  chapter: ChapterFile,
  transcript: TranscriptFile | null,
  sources: Map<string, Source>,
): ConceptModel[] {
  const covered = new Set<number>();
  for (const c of written) for (let i = c.from; i <= c.to; i++) covered.add(i);
  const sectionOf = (seg: number): string =>
    chapter.sections.find((s) => seg >= s.fromSegment && seg <= s.toSegment)?.label ?? `Chapter ${n}`;
  const out = [...written];
  let run: Segment[] = [];
  const flush = (): void => {
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) return;
    out.push({
      id: `ch${n}-pending-${first.n}`,
      title: sectionOf(first.n),
      from: first.n,
      to: last.n,
      inShortHtml: null,
      status: 'pending',
      reviewNotes: [],
      units: run.map((s) => buildUnit(chapter, transcript, s.n, s.n, '', sources)),
    });
    run = [];
  };
  for (const seg of chapter.segments) {
    const prev = run.at(-1);
    if (covered.has(seg.n)) flush();
    else {
      if (prev && sectionOf(prev.n) !== sectionOf(seg.n)) flush();
      run.push(seg);
    }
  }
  flush();
  return out.sort((x, y) => x.from - y.from);
}

/** Turn a trailing "(§n)" in review questions into a link to that passage. */
function linkSegmentRefs(html: string, n: number): string {
  return html.replace(/\(§(\d+)(?:–(\d+))?\)/g, (all, a: string) => `<a class="seg-ref" href="#ch${n}-s${a}">${all}</a>`);
}

function loadChapter(n: number, sources: Source[]): ChapterModel | null {
  const dataPath = join(DATA_DIR, 'chapters', `chapter_${pad(n)}.json`);
  if (!existsSync(dataPath)) return null;
  const chapter = parseOrThrow(ChapterFileSchema, readJson(dataPath), dataPath);
  const trPath = join(DATA_DIR, 'transcripts', `chapter_${pad(n)}.json`);
  const transcript = existsSync(trPath) ? parseOrThrow(TranscriptFileSchema, readJson(trPath), trPath) : null;
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const rctx: RenderContext = { sources: byKey, approximate: false };

  const dir = join(CONTENT_DIR, `chapter_${pad(n)}`);
  const hasGuide = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.md'));
  let title = `Chapter ${n}`;
  let status: Status = 'pending';
  let overviewHtml: string | null = null;
  let reviewQuestionsHtml: string | null = null;
  let terms: TermModel[] = [];
  let concepts: ConceptModel[] = [];

  const chPath = join(dir, '_chapter.md');
  if (existsSync(chPath)) {
    const { data, body } = splitFrontmatter(readFileSync(chPath, 'utf8'), chPath);
    const fm = parseOrThrow(ChapterFrontmatterSchema, data, chPath);
    title = nb(fm.title);
    status = fm.status;
    for (const { match, text } of splitSections(body, /^## (.+)$/)) {
      const heading = (match[1] ?? '').trim().toLowerCase();
      if (heading === 'overview') overviewHtml = renderBlock(text, rctx);
      else if (heading === 'review questions') reviewQuestionsHtml = linkSegmentRefs(renderBlock(text, rctx), n);
    }
  }
  const termsPath = join(dir, '_terms.yaml');
  if (existsSync(termsPath)) {
    const parsed = parseOrThrow(z.array(TermSchema), parseYaml(readFileSync(termsPath, 'utf8')) ?? [], termsPath);
    terms = parsed.map((t) => ({ ...t, gloss: nb(t.gloss), chapter: n }));
  }
  if (hasGuide) concepts = loadConcepts(n, dir, chapter, transcript, byKey);
  concepts = withPlaceholders(n, concepts, chapter, transcript, byKey);
  if (status === 'pending' && concepts.some((c) => c.status !== 'pending')) status = 'ai-draft';

  return {
    n,
    title,
    status,
    heRef: chapter.heRef,
    sefariaUrl: chapter.sefariaUrl,
    translation: chapter.translation,
    hasGuide,
    overviewHtml,
    reviewQuestionsHtml,
    terms,
    concepts,
    sources: sources.filter((s) => s.chapters.includes(n)).sort((a, b) => a.key.localeCompare(b.key)),
    uncovered: chapter.segments.filter((s) => s.coverage.length === 0).map((s) => s.n),
  };
}

let cached: Guide | null = null;

/** Load everything. Cached for a production build; re-read on every call in dev. */
export function loadGuide(): Guide {
  if (cached) return cached;
  const sourcesPath = join(DATA_DIR, 'sources.json');
  const sourcesFile = existsSync(sourcesPath)
    ? parseOrThrow(SourcesFileSchema, readJson(sourcesPath), sourcesPath)
    : { schemaVersion: 1 as const, sectionsCommit: '', sources: [] };
  const chapters = CHAPTERS.map((n) => loadChapter(n, sourcesFile.sources)).filter((c): c is ChapterModel => c !== null);
  const guide: Guide = {
    chapters,
    sources: sourcesFile.sources,
    sectionsCommit: sourcesFile.sectionsCommit,
    translation: chapters[0]?.translation ?? null,
  };
  if (import.meta.env.PROD) cached = guide;
  return guide;
}

/** All key terms, alphabetical, each at the chapter where it first appears. */
export function glossary(guide: Guide): TermModel[] {
  const first = new Map<string, TermModel>();
  for (const ch of guide.chapters) {
    for (const t of ch.terms) {
      const key = t.term.toLowerCase();
      if (!first.has(key)) first.set(key, t);
    }
  }
  return [...first.values()].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));
}

/** Data for the client player: key → title and URL. */
export function playerSources(guide: Guide): Record<string, { title: string; url: string; duration: number }> {
  const out: Record<string, { title: string; url: string; duration: number }> = {};
  for (const s of guide.sources) {
    out[s.key] = { title: `Class ${classNumber(s.key)} · ${s.title}`, url: s.audioUrl, duration: s.durationSeconds };
  }
  return out;
}
