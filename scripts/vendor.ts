/**
 * Vendors the data the study guide is built from (spec §3) into `data/`.
 *
 *   tsx scripts/vendor.ts --sections <path to shaar-hayichud-sections> [--refetch-sefaria]
 *
 * Reads the shaar-hayichud-sections checkout (catalog, chapter text, alignments,
 * transcripts, retimed word times, outlines) and Sefaria's text of
 * "The Gate of Unity" (cached under data/raw/sefaria/), and writes
 * data/sources.json, data/chapters/chapter_NN.json, data/transcripts/chapter_NN.json
 * and data/ATTRIBUTION.md. Every output is checked against src/lib/schema.ts
 * before it is written. Deterministic: rerunning on the same inputs rewrites
 * the same bytes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffArrays } from 'diff';
import { HTMLElement, NodeType, parse, type Node as HtmlNode } from 'node-html-parser';
import {
  ChapterFileSchema,
  SourcesFileSchema,
  TranscriptFileSchema,
  type ChapterFile,
  type ChapterSection,
  type Coverage,
  type Footnote,
  type Preamble,
  type Segment,
  type SegmentLine,
  type Sentence,
  type Source,
  type SourcesFile,
  type TranscriptFile,
  type TranscriptSpan,
} from '../src/lib/schema.ts';
import { CHAPTERS, chaptersLabel } from '../src/lib/chapters.ts';

// ------------------------------------------------------------------ constants

// The chapters vendored are CHAPTERS in src/lib/chapters.ts (shared with the site and validator).
/** Leading digits of the Rabbi Markel lecture ids vendored. */
const SOURCE_KEYS = [
  '001', '002', '003', '004', // Part 1: the series introduction, then chapter 10
  '015', '016', '017', '018', '019', '020', '021', '022', '023', // Part 2: chapters 1–4
  '060', '061', '062', '063', // Part 7: chapter 5
] as const;
/**
 * Classes with no aligned lines that introduce a chapter: the whole transcript
 * is vendored as that chapter's first preamble, and the class is listed with it.
 */
const INTRODUCES: Readonly<Record<string, number>> = { '001': 10 };
const SERIES_TITLE = 'Rabbi Markel Series (Advanced)';
const TEACHER = 'Rabbi Markel';
const CDN_BASE = 'https://media.shaarhayichudresources.com';
const SEFARIA_API = 'https://www.sefaria.org/api/v3/texts';
const SEFARIA_BOOK = 'The_Gate_of_Unity';
/** A sentence is cut here even without end punctuation. */
const MAX_SENTENCE_WORDS = 45;

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');

// ------------------------------------------------------------------ args

const { values: args } = parseArgs({
  options: {
    sections: { type: 'string' },
    'refetch-sefaria': { type: 'boolean', default: false },
  },
});
if (!args.sections) fail('usage: tsx scripts/vendor.ts --sections <path to shaar-hayichud-sections> [--refetch-sefaria]');
const SECTIONS = resolve(args.sections);
const SECTIONS_DATA = join(SECTIONS, 'data');
if (!existsSync(join(SECTIONS_DATA, 'classes.txt'))) fail(`not a shaar-hayichud-sections checkout: ${SECTIONS}`);

// ------------------------------------------------------------------ helpers

function fail(message: string): never {
  console.error(`vendor: ${message}`);
  process.exit(1);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Copied from shaar-hayichud-sections data/tools/src/publish.ts. */
function reverentSpelling(text: string): string {
  return text
    .replace(/\bGod(liness|ly)?\b/g, 'G-d$1')
    .replace(/\bGOD(LINESS|LY)?\b/g, 'G-D$1')
    .replace(/\bgod(liness|ly)\b/g, 'g-d$1');
}

/** Copied from shaar-hayichud-sections data/tools/src/catalog.ts: only RFC 3986 unreserved characters stay literal. */
function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildMediaUrl(folder: string, filename: string): string {
  return `${CDN_BASE}/${[...folder.split('/'), filename].map(encodePathSegment).join('/')}`;
}

// ------------------------------------------------------------------ catalog (classes.txt)

interface CatalogLecture {
  id: string;
  filename: string;
  folder: string;
  durationSeconds: number | null;
  ownTitle: string | null;
  seriesTitle: string;
  parentTitle: string;
  /** 1-based position among the parent's lectures. */
  position: number;
  parentLectureCount: number;
}

/** Enough of the classes.txt grammar (data/README.md) to locate each lecture. */
function parseCatalog(text: string): Map<string, CatalogLecture> {
  interface Heading { title: string; lectures: CatalogLecture[] }
  const out = new Map<string, CatalogLecture>();
  let series: Heading | null = null;
  let h2: Heading | null = null;
  let h3: Heading | null = null;
  let folder: string | null = null;
  let pendingTitle: string | null = null;
  let pendingId: string | null = null;
  const all: { lecture: CatalogLecture; parent: Heading }[] = [];
  const headingTitle = (rest: string): string => rest.replace(/:\d+\s*$/, '').trim();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('### ')) { h3 = { title: headingTitle(line.slice(4)), lectures: [] }; continue; }
    if (line === '###') { h3 = null; continue; }
    if (line.startsWith('## ')) { h2 = { title: headingTitle(line.slice(3)), lectures: [] }; h3 = null; continue; }
    if (line === '##') { h2 = null; h3 = null; continue; }
    if (line.startsWith('# ')) { series = { title: headingTitle(line.slice(2)), lectures: [] }; h2 = null; h3 = null; continue; }
    if (line.startsWith('> ')) { folder = line.slice(2).trim(); continue; }
    if (line.startsWith('- ')) { pendingTitle = line.slice(2).trim(); continue; }
    if (line.startsWith('@ ')) { pendingId = line.slice(2).trim(); continue; }
    const m = /^(.+\.(?:mp3|m4a))(?::([\d.]+))?$/i.exec(line);
    if (!m || !series || folder === null) fail(`classes.txt: unexpected line "${line}"`);
    const filename = m[1]!;
    const parent = h3 ?? h2 ?? series;
    const lecture: CatalogLecture = {
      id: pendingId ?? filename,
      filename,
      folder,
      durationSeconds: m[2] !== undefined ? Number(m[2]) : null,
      ownTitle: pendingTitle,
      seriesTitle: series.title,
      parentTitle: parent.title,
      position: 0,
      parentLectureCount: 0,
    };
    parent.lectures.push(lecture);
    all.push({ lecture, parent });
    pendingTitle = null;
    pendingId = null;
  }
  for (const { lecture, parent } of all) {
    lecture.position = parent.lectures.indexOf(lecture) + 1;
    lecture.parentLectureCount = parent.lectures.length;
    out.set(lecture.id, lecture);
  }
  return out;
}

/** "Chapter 3" for a titled lecture; "Chapter 1, part 2" for an untitled one under a heading. */
function lectureTitle(l: CatalogLecture): string {
  if (l.ownTitle !== null) return l.ownTitle;
  return l.parentLectureCount > 1 ? `${l.parentTitle}, part ${l.position}` : l.parentTitle;
}

// ------------------------------------------------------------------ Sefaria

interface SefariaVersion { language: string; versionTitle: string; license: string; versionSource: string; text: string[] }
interface SefariaText { heRef: string; en: SefariaVersion; he: SefariaVersion }

function loadSefaria(chapter: number): SefariaText {
  const dir = join(DATA, 'raw', 'sefaria');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SEFARIA_BOOK}.${chapter}.json`);
  if (!existsSync(path) || args['refetch-sefaria']) {
    const url = `${SEFARIA_API}/${SEFARIA_BOOK}.${chapter}?version=english&version=hebrew`;
    console.log(`fetching ${url}`);
    // curl, not fetch: Node's fetch does not use the session proxy.
    const body = execFileSync('curl', ['-sS', '--fail', '--max-time', '60', url], { encoding: 'utf8' });
    JSON.parse(body); // refuse to cache a non-JSON response
    writeFileSync(path, body);
  }
  const raw = readJson(path);
  if (!isRecord(raw) || typeof raw['heRef'] !== 'string' || !Array.isArray(raw['versions'])) fail(`${path}: unexpected shape`);
  const versions = raw['versions'] as SefariaVersion[];
  const en = versions.find((v) => v.language === 'en');
  const he = versions.find((v) => v.language === 'he');
  if (!en || !he) fail(`${path}: needs an English and a Hebrew version`);
  if (en.text.length !== he.text.length) fail(`${path}: English has ${en.text.length} paragraphs, Hebrew ${he.text.length}`);
  return { heRef: raw['heRef'], en, he };
}

/** Strip tags, maqaf and word-joining punctuation to spaces, then keep only א–ת and spaces. */
function hebrewWords(text: string): string[] {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[־\-–—/]/g, ' ')
    .replace(/[^א-ת\s]/g, '')
    .split(/\s+/)
    .filter((w) => w !== '');
}

// ------------------------------------------------------------------ English sanitising

const KEEP_TAGS = new Set(['i', 'b']);

/** Serialise a node keeping only <i>/<b> (no attributes); other tags are unwrapped. */
function sanitize(node: HtmlNode): string {
  if (node.nodeType === NodeType.TEXT_NODE) return reverentSpelling(node.rawText);
  if (!(node instanceof HTMLElement)) return '';
  const inner = node.childNodes.map(sanitize).join('');
  const tag = node.rawTagName?.toLowerCase();
  return tag && KEEP_TAGS.has(tag) ? `<${tag}>${inner}</${tag}>` : inner;
}

const isElement = (n: HtmlNode | undefined, tag: string, cls?: string): n is HTMLElement =>
  n instanceof HTMLElement && n.rawTagName?.toLowerCase() === tag && (cls === undefined || n.classList.contains(cls));

/** English paragraph → sanitized HTML with <sup data-fn="n">n</sup> markers, plus its footnotes. */
function englishParagraph(html: string, where: string): { en: string; footnotes: Footnote[] } {
  const root = parse(html);
  const footnotes: Footnote[] = [];
  const walk = (nodes: HtmlNode[]): string => {
    let out = '';
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (isElement(node, 'sup', 'footnote-marker')) {
        const n = Number(node.text.trim());
        if (!Number.isInteger(n)) fail(`${where}: footnote marker "${node.text}" is not a number`);
        // The footnote body is the next element sibling (whitespace text may sit between).
        let j = i + 1;
        while (j < nodes.length && nodes[j]!.nodeType === NodeType.TEXT_NODE && nodes[j]!.rawText.trim() === '') j++;
        const body = nodes[j];
        if (isElement(body, 'i', 'footnote')) {
          footnotes.push({ n, html: body.childNodes.map(sanitize).join('').trim() });
          i = j;
        } else {
          console.warn(`vendor: ${where}: footnote marker ${n} has no footnote body`);
        }
        out += `<sup data-fn="${n}">${n}</sup>`;
      } else if (isElement(node, 'i', 'footnote')) {
        fail(`${where}: footnote body without a marker`);
      } else if (node instanceof HTMLElement) {
        const tag = node.rawTagName?.toLowerCase();
        const inner = walk(node.childNodes);
        out += tag && KEEP_TAGS.has(tag) ? `<${tag}>${inner}</${tag}>` : inner;
      } else if (node.nodeType === NodeType.TEXT_NODE) {
        out += reverentSpelling(node.rawText);
      }
    }
    return out;
  };
  const en = walk(root.childNodes).replace(/\s+/g, ' ').trim();
  return { en, footnotes };
}

// ------------------------------------------------------------------ chapter text

interface RepoLine { id: string; text: string }
interface RepoSection { label: string; lineIds: string[] }

function loadChapterText(chapter: number): { lines: RepoLine[]; sections: RepoSection[] } {
  const path = join(SECTIONS_DATA, 'chapters', `chapter_${pad2(chapter)}.json`);
  const tree = readJson(path);
  const lines: RepoLine[] = [];
  const sections: RepoSection[] = [];
  const visit = (node: unknown): string[] => {
    if (!isRecord(node)) fail(`${path}: unexpected node`);
    if (typeof node['id'] === 'string' && typeof node['text'] === 'string') {
      lines.push({ id: node['id'], text: node['text'] });
      return [node['id']];
    }
    const label = typeof node['label'] === 'string' ? node['label'].trim() : '';
    const section: RepoSection | null = label !== '' ? { label, lineIds: [] } : null;
    if (section) sections.push(section); // pre-order: a parent precedes its children
    const ids = (Array.isArray(node['children']) ? node['children'] : []).flatMap(visit);
    if (section) section.lineIds = ids;
    return ids;
  };
  if (!Array.isArray(tree)) fail(`${path}: expected an array of sections`);
  tree.forEach(visit);
  return { lines, sections: sections.filter((s) => s.lineIds.length > 0) };
}

/** Assigns each repo line the Sefaria paragraph (1-based) most of its matched words fall in (spec §3 rule 3). */
function mapLinesToSegments(lines: RepoLine[], heParagraphs: string[], chapter: number): { segment: number; notInSefaria: boolean }[] {
  const repoWords: string[] = [];
  const repoWordLine: number[] = [];
  lines.forEach((l, li) => {
    for (const w of hebrewWords(l.text)) { repoWords.push(w); repoWordLine.push(li); }
  });
  const sefWords: string[] = [];
  const sefWordPara: number[] = [];
  heParagraphs.forEach((p, pi) => {
    for (const w of hebrewWords(p)) { sefWords.push(w); sefWordPara.push(pi + 1); }
  });

  // votes[line] = segment → matched word count
  const votes = lines.map(() => new Map<number, number>());
  let ri = 0;
  let si = 0;
  for (const part of diffArrays(repoWords, sefWords)) {
    const count = part.count ?? part.value.length;
    if (part.added) { si += count; continue; }
    if (part.removed) { ri += count; continue; }
    for (let k = 0; k < count; k++) {
      const v = votes[repoWordLine[ri + k]!]!;
      const seg = sefWordPara[si + k]!;
      v.set(seg, (v.get(seg) ?? 0) + 1);
    }
    ri += count;
    si += count;
  }
  const matched = repoWords.length === 0 ? 0 : votes.reduce((a, v) => a + [...v.values()].reduce((x, y) => x + y, 0), 0);
  console.log(`chapter ${chapter}: ${matched}/${repoWords.length} repo words matched (${((100 * matched) / repoWords.length).toFixed(1)}%), ${sefWords.length} Sefaria words`);

  votes.forEach((v, i) => {
    if (v.size > 1) console.warn(`vendor: chapter ${chapter}: line ${lines[i]!.id} has matched words in several segments: ${[...v.entries()].map(([s, c]) => `§${s}×${c}`).join(' ')}`);
  });
  const result: { segment: number; notInSefaria: boolean }[] = votes.map((v) => {
    let best = 0;
    let bestCount = 0;
    for (const [seg, c] of [...v.entries()].sort((a, b) => a[0] - b[0])) if (c > bestCount) { best = seg; bestCount = c; }
    return { segment: best, notInSefaria: bestCount === 0 };
  });
  for (let i = 0; i < result.length; i++) {
    if (!result[i]!.notInSefaria) continue;
    const prev = result.slice(0, i).reverse().find((r) => r.segment > 0);
    const next = result.slice(i + 1).find((r) => !r.notInSefaria);
    const seg = prev?.segment ?? next?.segment;
    if (seg === undefined) fail(`chapter ${chapter}: no line matched Sefaria`);
    result[i]!.segment = seg;
  }
  for (let i = 1; i < result.length; i++) {
    if (result[i]!.segment < result[i - 1]!.segment) {
      fail(`chapter ${chapter}: line ${i} (${lines[i]!.id}) maps to §${result[i]!.segment}, after §${result[i - 1]!.segment}`);
    }
  }
  const used = new Set(result.map((r) => r.segment));
  for (let n = 1; n <= heParagraphs.length; n++) if (!used.has(n)) fail(`chapter ${chapter}: Sefaria §${n} gets no line`);
  return result;
}

// ------------------------------------------------------------------ class data

interface AlignmentSegment { startSeconds: number; endSeconds: number; chapter: string; lineId: string; confidence: number; firstWord: number; lastWord: number }
interface TimedWord { word: string; start: number }

interface ClassData {
  source: Source;
  words: TimedWord[];
  segments: AlignmentSegment[];
}

function chapterNumber(key: string): number {
  const m = /^chapter_(\d+)$/.exec(key);
  if (!m) fail(`unexpected chapter key ${key}`);
  return Number(m[1]);
}

function loadClass(key: string, catalog: Map<string, CatalogLecture>): ClassData {
  // Only the Rabbi Markel series: other series (Rabbi Walters) are never sources.
  const matches = [...catalog.values()].filter((l) => l.seriesTitle === SERIES_TITLE && l.id.startsWith(`${key} `));
  if (matches.length !== 1) fail(`${matches.length} lectures in "${SERIES_TITLE}" with key ${key}; expected 1`);
  const lecture = matches[0]!;
  // A lecture with an "@" id has an (edited) file on the same timeline; one without (001 Intro) has only the original.
  if (lecture.id !== lecture.filename && !/\(edited\)\.mp3$/.test(lecture.filename)) console.warn(`vendor: ${lecture.id}: catalog file is not an (edited) mp3: ${lecture.filename}`);
  if (lecture.durationSeconds === null) fail(`${lecture.id}: no duration in classes.txt`);
  const file = `${encodePathSegment(lecture.id)}.json`;

  const transcript = readJson(join(SECTIONS_DATA, 'transcripts', file));
  if (!isRecord(transcript) || !isRecord(transcript['result']) || !Array.isArray(transcript['result']['timestamps'])) fail(`${file}: unexpected transcript shape`);
  const stamps = transcript['result']['timestamps'] as { word: string; start: number }[];

  const retimedPath = join(SECTIONS_DATA, 'retimed', file);
  let starts = stamps.map((w) => w.start);
  const times: Source['times'] = existsSync(retimedPath) ? 'retimed' : 'sofer';
  if (times === 'retimed') {
    const retimed = readJson(retimedPath);
    if (!isRecord(retimed) || !Array.isArray(retimed['words'])) fail(`${retimedPath}: unexpected shape`);
    const rw = retimed['words'] as [number, number, number, number][];
    if (rw.length !== stamps.length) fail(`${retimedPath}: ${rw.length} words, transcript has ${stamps.length}`);
    starts = rw.map((w) => w[0]);
  }
  const words: TimedWord[] = stamps.map((w, i) => ({ word: w.word, start: starts[i]! }));

  // A class that introduces a chapter (INTRODUCES) has no alignment file.
  const alignmentPath = join(SECTIONS_DATA, 'alignments', file);
  let segments: AlignmentSegment[] = [];
  if (existsSync(alignmentPath)) {
    const alignment = readJson(alignmentPath);
    if (!isRecord(alignment) || !Array.isArray(alignment['segments'])) fail(`${file}: unexpected alignment shape`);
    const method = isRecord(alignment['method']) ? alignment['method'] : {};
    const alignedTimes = method['times'] === 'retimed' ? 'retimed' : 'sofer';
    if (alignedTimes !== times) fail(`${file}: alignment used ${alignedTimes} times, lecture now has ${times}`);
    segments = (alignment['segments'] as AlignmentSegment[]).slice().sort((a, b) => a.firstWord - b.firstWord);
  } else if (INTRODUCES[key] === undefined) {
    fail(`${file}: no alignment, and the class is not listed in INTRODUCES`);
  }

  const outlineRaw = readJson(join(SECTIONS_DATA, 'outlines', file));
  const topics = isRecord(outlineRaw) && Array.isArray(outlineRaw['topics']) ? (outlineRaw['topics'] as Record<string, unknown>[]) : [];
  const outline = topics
    .filter((t) => typeof t['start_time_sec'] === 'number' && typeof t['title'] === 'string' && t['title'].trim() !== '')
    // Same filter as the data repo's published outlines: only HIGH and MEDIUM confidence topics.
    .filter((t) => t['confidence'] === 'HIGH' || t['confidence'] === 'MEDIUM')
    .map((t) => ({ title: reverentSpelling((t['title'] as string).trim()), startSeconds: round2(t['start_time_sec'] as number) }))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const title = lectureTitle(lecture);
  const alignedChapters = [...new Set(segments.map((s) => chapterNumber(s.chapter)))].sort((a, b) => a - b);
  const titleChapter = /Chapter (\d+)/.exec(title);
  const introduces = INTRODUCES[key];
  const chapters =
    alignedChapters.length > 0 ? alignedChapters : introduces !== undefined ? [introduces] : titleChapter ? [Number(titleChapter[1])] : [];

  return {
    source: {
      key,
      lectureId: lecture.id,
      teacher: TEACHER,
      series: lecture.seriesTitle,
      title,
      audioUrl: buildMediaUrl(lecture.folder, lecture.filename),
      durationSeconds: lecture.durationSeconds,
      chapters,
      times,
      outline,
    },
    words,
    segments,
  };
}

/** Break after a word ending in . ? ! (closing quotes allowed), and force a break at MAX_SENTENCE_WORDS. */
function sentences(words: TimedWord[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: TimedWord[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    out.push({ t: round2(cur[0]!.start), text: reverentSpelling(cur.map((w) => w.word.trim()).join(' ')) });
    cur = [];
  };
  for (const w of words) {
    const word = w.word.trim();
    if (word === '') continue;
    cur.push(w);
    if (/[.?!]["'”’)\]]*$/.test(word) || cur.length >= MAX_SENTENCE_WORDS) flush();
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ main

function main(): void {
  const sectionsCommit = execFileSync('git', ['-C', SECTIONS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', SECTIONS, 'status', '--porcelain', '--', 'data'], { encoding: 'utf8' }).trim();
  if (dirty !== '') console.warn(`vendor: warning: ${SECTIONS}/data has uncommitted changes; sectionsCommit will not describe them`);

  const catalog = parseCatalog(readFileSync(join(SECTIONS_DATA, 'classes.txt'), 'utf8'));
  const classes = SOURCE_KEYS.map((k) => loadClass(k, catalog));

  // Chapter text + Sefaria → segments.
  const chapterFiles = new Map<number, ChapterFile>();
  const lineInfo = new Map<string, { chapter: number; segment: number }>();
  let translationInfo: { versionTitle: string; license: string; source: string } | null = null;
  let hebrewInfo: { versionTitle: string; license: string; source: string } | null = null;

  for (const chapter of CHAPTERS) {
    const sef = loadSefaria(chapter);
    const { lines, sections } = loadChapterText(chapter);
    const mapping = mapLinesToSegments(lines, sef.he.text, chapter);

    const segments: Segment[] = sef.en.text.map((html, i) => {
      const { en, footnotes } = englishParagraph(html, `chapter ${chapter} §${i + 1}`);
      return { n: i + 1, lines: [], en, footnotes, coverage: [] };
    });
    lines.forEach((l, i) => {
      const m = mapping[i]!;
      const line: SegmentLine = m.notInSefaria ? { id: l.id, text: l.text, notInSefaria: true } : { id: l.id, text: l.text };
      segments[m.segment - 1]!.lines.push(line);
      if (lineInfo.has(l.id)) fail(`duplicate line id ${l.id}`);
      lineInfo.set(l.id, { chapter, segment: m.segment });
    });
    const segOf = (id: string): number => lineInfo.get(id)!.segment;
    const chapterSections: ChapterSection[] = sections.map((s) => ({
      label: s.label,
      fromSegment: Math.min(...s.lineIds.map(segOf)),
      toSegment: Math.max(...s.lineIds.map(segOf)),
    }));

    translationInfo = { versionTitle: sef.en.versionTitle, license: sef.en.license, source: sef.en.versionSource };
    hebrewInfo = { versionTitle: sef.he.versionTitle, license: sef.he.license, source: sef.he.versionSource };
    chapterFiles.set(chapter, {
      schemaVersion: 1,
      chapter,
      heRef: sef.heRef,
      sefariaUrl: `https://www.sefaria.org/${SEFARIA_BOOK}.${chapter}?lang=bi`,
      translation: translationInfo,
      sections: chapterSections,
      segments,
    });
    const notIn = lines.filter((_, i) => mapping[i]!.notInSefaria);
    console.log(`chapter ${chapter}: ${lines.length} lines → ${segments.length} segments; not in Sefaria: ${notIn.map((l) => `${l.id} "${l.text.slice(0, 30)}"`).join(', ') || 'none'}`);
  }

  // Alignments → coverage and transcript spans.
  const transcripts = new Map<number, TranscriptFile>(CHAPTERS.map((c) => [c, { schemaVersion: 1, chapter: c, preambles: [], spans: [] }]));
  for (const { source, words, segments } of classes) {
    const tapeEnd = source.durationSeconds;
    const inScope = (s: AlignmentSegment): boolean => (CHAPTERS as readonly number[]).includes(chapterNumber(s.chapter));
    segments.forEach((seg, i) => {
      const next = segments[i + 1];
      if (!inScope(seg)) return;
      const info = lineInfo.get(seg.lineId);
      if (!info) fail(`${source.lectureId}: aligned line ${seg.lineId} is not in chapters ${chaptersLabel()}`);
      if (info.chapter !== chapterNumber(seg.chapter)) fail(`${source.lectureId}: line ${seg.lineId} is in chapter ${info.chapter}, alignment says ${seg.chapter}`);
      const endSeconds = round2(next ? next.startSeconds : tapeEnd);
      const coverage: Coverage = {
        source: source.key,
        lineId: seg.lineId,
        startSeconds: round2(seg.startSeconds),
        endSeconds,
        confidence: seg.confidence,
      };
      chapterFiles.get(info.chapter)!.segments[info.segment - 1]!.coverage.push(coverage);
      const span: TranscriptSpan = {
        source: source.key,
        lineId: seg.lineId,
        segment: info.segment,
        startSeconds: coverage.startSeconds,
        endSeconds,
        confidence: seg.confidence,
        sentences: sentences(words.slice(seg.firstWord, next ? next.firstWord : words.length)),
      };
      transcripts.get(info.chapter)!.spans.push(span);
    });
    const first = segments[0];
    const introduces = INTRODUCES[source.key];
    if (!first && introduces !== undefined) {
      const preamble: Preamble = { source: source.key, sentences: sentences(words) };
      transcripts.get(introduces)!.preambles.push(preamble);
    } else if (first && inScope(first)) {
      const preamble: Preamble = { source: source.key, sentences: sentences(words.slice(0, first.firstWord)) };
      transcripts.get(chapterNumber(first.chapter))!.preambles.push(preamble);
    } else if (!first) {
      console.log(`${source.lectureId}: no aligned lines; transcript not vendored (outline only)`);
    }
  }

  // Validate and write.
  mkdirSync(join(DATA, 'chapters'), { recursive: true });
  mkdirSync(join(DATA, 'transcripts'), { recursive: true });
  const sourcesFile: SourcesFile = SourcesFileSchema.parse({ schemaVersion: 1, sectionsCommit, sources: classes.map((c) => c.source) });
  writeJson(join(DATA, 'sources.json'), sourcesFile);
  for (const chapter of CHAPTERS) {
    const cf = ChapterFileSchema.parse(chapterFiles.get(chapter));
    for (const seg of cf.segments) seg.coverage.sort((a, b) => a.source.localeCompare(b.source) || a.startSeconds - b.startSeconds);
    writeJson(join(DATA, 'chapters', `chapter_${pad2(chapter)}.json`), cf);
    const tf = TranscriptFileSchema.parse(transcripts.get(chapter));
    writeJson(join(DATA, 'transcripts', `chapter_${pad2(chapter)}.json`), tf);
    const covered = cf.segments.filter((s) => s.coverage.length > 0).length;
    const words = tf.spans.reduce((a, s) => a + s.sentences.reduce((b, x) => b + x.text.split(' ').length, 0), 0);
    console.log(`chapter ${chapter}: ${covered}/${cf.segments.length} segments covered, ${tf.spans.length} spans, ${words} span words, preambles from ${tf.preambles.map((p) => p.source).join(', ') || 'none'}`);
  }
  writeFileSync(join(DATA, 'ATTRIBUTION.md'), attribution(sectionsCommit, sourcesFile.sources, translationInfo!, hebrewInfo!));
  console.log('vendor: done');
}

function attribution(
  commit: string,
  sources: Source[],
  en: { versionTitle: string; license: string; source: string },
  he: { versionTitle: string; license: string; source: string },
): string {
  const classes = sources.map((s) => `| ${s.key} | ${s.title} | \`${s.lectureId}\` | ${s.times} |`).join('\n');
  return `# Where the files in \`data/\` come from

Generated by \`scripts/vendor.ts\` (\`npm run vendor\`). Do not edit these files
by hand; change the script or its inputs and rerun it.

## shaar-hayichud-sections

[yringler/shaar-hayichud-sections](https://github.com/yringler/shaar-hayichud-sections)
at commit \`${commit}\` (its \`data/\` directory):

- \`chapters/chapter_NN.json\` (chapters ${chaptersLabel()}): the Hebrew text, its
  line IDs and the section labels. Copied into \`data/chapters/\`
  (\`segments[].lines\`, \`sections\`).
- \`classes.txt\`: lecture titles, durations and the CDN location of each
  class's mp3, the \`(edited)\` file where there is one (\`data/sources.json\`).
- \`alignments/\`, \`transcripts/\` (Sofer.ai), \`retimed/\` and \`outlines/\` (Sofer.ai,
  HIGH and MEDIUM confidence topics only) for the classes below. Reduced to
  per-line coverage (\`data/chapters/\`), per-line transcript spans and tape
  preambles (\`data/transcripts/\`), and class outlines (\`data/sources.json\`).
  Class 001, the series introduction, has no aligned lines; its whole
  transcript is the first preamble of chapter 10, where the series begins.
  Transcript text and outline titles are auto-generated and unedited, except
  that the Name is spelled G-d (the data repo's \`reverentSpelling\`).

Nothing else from that repository is copied (no raw Sofer JSON, word-time
arrays, audio edits or other chapters).

The recordings are Rabbi Markel's classes in the series "${SERIES_TITLE}",
served from \`${CDN_BASE}\`; this repository only links to them.

| Key | Title | Lecture ID | Word times |
|-----|-------|------------|------------|
${classes}

## Sefaria

"The Gate of Unity" (Shaar HaYichud), chapters ${chaptersLabel()}, from the Sefaria API
(\`${SEFARIA_API}/${SEFARIA_BOOK}.N?version=english&version=hebrew\`). The raw
responses are kept in \`raw/sefaria/\`.

- English: "${en.versionTitle}", licence **${en.license}**, source
  ${en.source}. Used in \`data/chapters/\` (\`segments[].en\`, \`footnotes\`).
  Changes: HTML reduced to \`<i>\`, \`<b>\` and footnote markers
  (\`<sup data-fn>\`), footnotes moved to \`footnotes\`, and "God"/"Godliness"
  spelled "G-d"/"G-dliness".
- Hebrew: "${he.versionTitle}", licence **${he.license}** on Sefaria, source
  ${he.source}. Used only to find which Sefaria paragraph each of the
  repository's Hebrew lines belongs to; the Hebrew shown on the site is the
  text from shaar-hayichud-sections.
`;
}

main();
