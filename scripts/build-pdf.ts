/**
 * Builds the print-ready PDF of the booklet for Amazon KDP (paperback, trim
 * 7 × 10 in, no bleed, black and white interior) from the /book/ page.
 *
 *   npm run pdf                                   # npm run build, then print the study guide
 *   npm run pdf -- --view explanation             # guide | explanation | hebrew | text
 *   npm run pdf -- --all                          # the guide, explanation and hebrew PDFs, 7 x 10 and Letter (one build)
 *   npm run pdf -- --trim letter                  # 8.5 x 11 in for printing at home (7x10 | letter; with --all, only that size)
 *   npm run pdf -- --final                        # no draft notices (warns about unreviewed sections)
 *   npm run pdf -- --no-build                     # reuse dist/
 *   npm run pdf -- --out some/where.pdf
 *
 * Steps: build the site, serve dist/ on a local port, open /book/ in
 * Playwright's Chromium, wait for the self-hosted fonts, check that nothing
 * runs into the margins, then print. Chromium does not insert blank pages for
 * `break-before: right` and has no `target-counter()`, so the PDF is made in
 * passes: each pass reads the page of every link target from the PDF's named
 * destinations, puts a blank page before any chapter that fell on a verso,
 * fills in the page numbers of the contents and glossary, pads to an even
 * count, and prints again until nothing changes. The result is checked (trim
 * size of every page, page count, fonts embedded, no colour, printed folios)
 * before it is written.
 *
 * Letter (--trim letter): the same pages on 8.5 × 11 in for printing at home,
 * scaled up as a whole (book.astro, ?trim=letter), with equal side margins.
 * No blank pages are added (a chapter starts on the next page, recto or not)
 * and the KDP rules (gutter by page count, page limits, even count) do not apply.
 *
 * Page numbering: the front matter (title, copyright, contents, About, and any
 * blank page before chapter 1) is numbered i, ii, iii, … from the title page,
 * and chapter 1's first page is 1. book.css prints the folios that way with a
 * `folio` counter of its own (Chromium's page counter cannot be restarted);
 * this script uses the same numbering for the contents and glossary page
 * references (folioLabel), writes it into the PDF as /PageLabels so viewers
 * show it too, and checks the printed folios against it (folioCheck).
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import { chromium, type Browser, type Page } from 'playwright';
import { BOOK_TRIMS, BOOK_VIEWS, bookPdf, type BookTrim, type BookView } from '../src/lib/chapters';
import { loadGuide } from '../src/lib/content';

// ---------------------------------------------------------------- settings

/** A page size: the KDP paperback, or Letter for printing at home. Margins in inches. */
interface TrimSpec {
  name: BookTrim;
  label: string;
  wIn: number;
  hIn: number;
  top: number;
  bottom: number;
  /** The inside margin to start from (7 x 10: KDP may need more, kdpGutter). */
  inside: number;
  outside: number;
  /** How much book.astro scales the 7 x 10 layout up (main.book zoom). */
  zoom: number;
  /** KDP paperback: chapters on a recto (blank pages added), even page count, gutter and page limits. */
  kdp: boolean;
}

const TRIMS: Readonly<Record<BookTrim, TrimSpec>> = {
  // book.css @page: 0.85 in top, 0.95 in bottom, 0.9 in inside, 0.8 in outside.
  '7x10': { name: '7x10', label: '7 × 10 in, no bleed', wIn: 7, hIn: 10, top: 0.85, bottom: 0.95, inside: 0.9, outside: 0.8, zoom: 1, kdp: true },
  // book.astro letterCss: a 6 × 9.3 in text block holding the 5.3 × 8.2 in one zoomed by 6 / 5.3.
  letter: { name: 'letter', label: '8.5 × 11 in (US Letter)', wIn: 8.5, hIn: 11, top: 0.8, bottom: 0.9, inside: 1.25, outside: 1.25, zoom: 6 / 5.3, kdp: false },
};

const KDP_MIN_PAGES = 24;
const KDP_MAX_PAGES = 828;
const MAX_PASSES = 8;
/** A page that stops more than this short of the text block's foot is reported (pageDepthReport). */
const SHORT_PAGE_IN = 0.6;
/** A passage pair no taller than this (about four lines of translation) is kept whole. */
const SHORT_PAIR_IN = 0.8;
const VIEWS = BOOK_VIEWS;
type View = BookView;
/** The views `--all` prints: those the site publishes (the deploy workflow runs it). */
const ALL_VIEWS: readonly View[] = ['guide', 'explanation', 'hebrew'];
/** Each view and size has its own name (src/lib/chapters.ts), so one never overwrites another. */
const defaultOut = (view: View, trim: BookTrim): string => `pdf/${bookPdf(view, trim)}`;

/** KDP's minimum inside margin (gutter) for a page count, in inches. */
function kdpGutter(pages: number): number {
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  return 0.875;
}

// ---------------------------------------------------------------- folios

/** Lower-case roman numeral (1 → i), for the front-matter folios. */
function roman(n: number): string {
  const digits: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [value, numeral] of digits) {
    for (; n >= value; n -= value) out += numeral;
  }
  return out;
}

/**
 * The folio of a 1-based PDF page, given the number of front-matter pages
 * (those before chapter 1): roman in the front matter, arabic from 1 after it.
 * The same numbering as the printed folios (book.css) and the /PageLabels.
 */
function folioLabel(page: number, frontPages: number): string {
  return page > frontPages ? String(page - frontPages) : roman(page);
}

/** Front-matter pages: those before chapter 1's first page (0 if it has no page). */
function frontPageCount(info: PdfInfo, firstChapter: string): number {
  const p = firstChapter ? info.dests.get(firstChapter) : undefined;
  return p === undefined ? 0 : p - 1;
}

// ---------------------------------------------------------------- arguments

/** One PDF to print: a view, a page size and where to write it. */
interface Job {
  view: View;
  trim: TrimSpec;
  out: string;
}

interface Options {
  jobs: Job[];
  final: boolean;
  build: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      view: { type: 'string' },
      all: { type: 'boolean', default: false },
      final: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      out: { type: 'string' },
      trim: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('Usage: npm run pdf -- [--view guide|explanation|hebrew|text | --all] [--trim 7x10|letter] [--final] [--no-build] [--out file.pdf]');
    process.exit(0);
  }
  const common = { final: values.final, build: !values['no-build'] };
  if (values.trim !== undefined && !(BOOK_TRIMS as readonly string[]).includes(values.trim)) fail(`--trim must be one of ${BOOK_TRIMS.join(', ')} (got "${values.trim}").`);
  const trimArg = values.trim as BookTrim | undefined;
  if (values.all) {
    if (values.view !== undefined || values.out !== undefined) fail('--all prints every published view to its own file; it takes neither --view nor --out.');
    const trims = trimArg ? [trimArg] : BOOK_TRIMS;
    return { ...common, jobs: trims.flatMap((t) => ALL_VIEWS.map((view) => ({ view, trim: TRIMS[t], out: resolve(defaultOut(view, t)) }))) };
  }
  const view = values.view ?? 'guide';
  if (!isView(view)) fail(`--view must be one of ${VIEWS.join(', ')} (got "${view}").`);
  const t = trimArg ?? '7x10';
  return { ...common, jobs: [{ view, trim: TRIMS[t], out: resolve(values.out ?? defaultOut(view, t)) }] };
}

function isView(v: string): v is View {
  return (VIEWS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- output helpers

/** A failure inside main(): thrown so the finally block closes the browser and server. */
class BuildError extends Error {}

function fail(message: string): never {
  console.error(`\n✖ build-pdf: ${message}`);
  process.exit(1);
}

function warn(message: string): void {
  console.warn(`⚠ ${message}`);
}

function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error === undefined;
}

// ---------------------------------------------------------------- the unreviewed-content warning

function warnUnreviewed(): void {
  const guide = loadGuide();
  const open: string[] = [];
  for (const c of guide.chapters) {
    if (c.concepts.length === 0) open.push(`  Chapter ${c.n}: no guide written (${c.status})`);
    for (const k of c.concepts) {
      if (k.status !== 'edited' && k.status !== 'reviewed') open.push(`  Chapter ${c.n}, ${k.title} [${k.status}]`);
    }
  }
  if (open.length === 0) return;
  const bar = '!'.repeat(78);
  console.warn(`\n${bar}`);
  console.warn(`!! --final: the draft notices are OFF, but ${open.length} section(s) are not edited or reviewed:`);
  console.warn(bar);
  for (const line of open) console.warn(line);
  console.warn(`${bar}\n!! Do not publish this PDF until these are reviewed (set status: edited/reviewed).\n${bar}\n`);
}

// ---------------------------------------------------------------- static server for dist/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function serve(root: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((ok, ko) => {
    server.once('error', ko);
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

// ---------------------------------------------------------------- reading the PDF

interface PdfInfo {
  pages: number;
  sizes: { w: number; h: number }[];
  /** Link target id → 1-based page number, from the named destinations. */
  dests: Map<string, number>;
}

async function readPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const pageNumberByRef = new Map<string, number>();
  pages.forEach((p, i) => pageNumberByRef.set(p.ref.toString(), i + 1));

  const dests = new Map<string, number>();
  const add = (name: string, value: unknown): void => {
    let v = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (v instanceof PDFDict) v = v.get(PDFName.of('D'));
    if (v instanceof PDFRef) v = doc.context.lookup(v);
    if (!(v instanceof PDFArray)) return;
    const pageRef = v.get(0);
    if (!(pageRef instanceof PDFRef)) return;
    const n = pageNumberByRef.get(pageRef.toString());
    if (n !== undefined) dests.set(name, n);
  };

  // Chromium writes a /Dests dictionary in the catalog (PDF 1.1 style).
  const destsDict = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (destsDict) {
    for (const [key, value] of destsDict.entries()) add(key.decodeText(), value);
  }
  // A /Names /Dests name tree, in case a future Chromium switches to it.
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const walk = (node: PDFDict): void => {
    const leaf = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (leaf) {
      for (let i = 0; i + 1 < leaf.size(); i += 2) {
        const k = leaf.lookup(i);
        if (k instanceof PDFString || k instanceof PDFHexString) add(k.decodeText(), leaf.get(i + 1));
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  };
  if (tree) walk(tree);

  return { pages: pages.length, sizes: pages.map((p) => p.getSize()).map(({ width, height }) => ({ w: width, h: height })), dests };
}

// ---------------------------------------------------------------- in-page steps

interface Layout {
  /** Ids of the elements that must start on a recto, in document order. */
  recto: string[];
  /** Ids whose page numbers the page shows. */
  refs: string[];
  /** Id of chapter 1 (the first article.chapter), whose first page is folio 1; '' if none. */
  firstChapter: string;
}

async function layoutTargets(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    // A page reference whose target is not rendered in this view (an explanation-less
    // passage in "Explanation only"), or is an empty anchor (Chromium gives those no
    // destination), points at the nearest rendered unit, concept or chapter instead.
    for (const ref of document.querySelectorAll<HTMLElement>('[data-pageref]')) {
      const id = ref.dataset['pageref'] ?? '';
      let target = document.getElementById(id);
      // (No named helper functions in here: tsx would wrap them in a __name() the page lacks.)
      while (target && !(target.getClientRects().length > 0 && target.getBoundingClientRect().height > 0)) target = target.parentElement?.closest<HTMLElement>('.unit[id], .concept[id], .chapter[id]') ?? null;
      if (!target || target.id === id) continue;
      ref.dataset['pageref'] = target.id;
      const link = ref.closest('a');
      if (link?.getAttribute('href') === `#${id}`) link.setAttribute('href', `#${target.id}`);
    }
    const recto = [...document.querySelectorAll<HTMLElement>('[data-recto], article.chapter')].map((el) => el.id);
    const refs = [...new Set([...document.querySelectorAll<HTMLElement>('[data-pageref]')].map((el) => el.dataset['pageref'] ?? ''))];
    const firstChapter = document.querySelector<HTMLElement>('article.chapter[id]')?.id ?? '';
    return { recto, refs, firstChapter };
  });
}

/**
 * Applies one pass of pagination fixes in the page and reports whether anything
 * changed. Inserting a blank page before an element moves everything after it
 * by exactly one page, so all fixes can be made in one pass. The page
 * references are filled in from this pass's PDF (roman or arabic, folioLabel);
 * if a blank page moved them, the next pass corrects them.
 */
async function applyPass(page: Page, info: PdfInfo, layout: Layout, blanks: boolean): Promise<string[]> {
  const pageOf = Object.fromEntries(info.dests);
  const front = frontPageCount(info, layout.firstChapter);
  const labelOf = Object.fromEntries([...info.dests].map(([id, p]) => [id, folioLabel(p, front)]));
  return page.evaluate(
    ({ pageOf, labelOf, recto, pages, firstChapter, blanks }) => {
      const changes: string[] = [];
      let shift = 0;
      const first = firstChapter ? document.getElementById(firstChapter) : null;
      for (const id of recto) {
        const el = document.getElementById(id);
        const p = pageOf[id];
        if (!el || p === undefined) continue;
        // A blank page before chapter 1 or anything ahead of it is front matter
        // (.kdp-front: no folio, not counted in the arabic numbering, book.css).
        const inFront = first !== null && (el === first || (el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
        const prev = el.previousElementSibling;
        const hasBlank = prev?.classList.contains('kdp-blank') ?? false;
        const at = p + shift;
        if (at % 2 === 0) {
          if (hasBlank) {
            prev?.remove();
            shift -= 1;
            changes.push(`removed blank before #${id}`);
          } else {
            const blank = document.createElement('div');
            blank.className = inFront ? 'kdp-blank kdp-front' : 'kdp-blank';
            blank.setAttribute('aria-hidden', 'true');
            el.before(blank);
            shift += 1;
            changes.push(`blank page before #${id}`);
          }
        }
      }
      for (const span of document.querySelectorAll<HTMLElement>('[data-pageref]')) {
        const text = labelOf[span.dataset['pageref'] ?? ''] ?? '';
        if (span.textContent !== text) {
          span.textContent = text;
          if (changes.length < 50) changes.push(`page ref #${span.dataset['pageref']} → ${text || '(none)'}`);
        }
      }
      const book = blanks ? document.querySelector('main.book') : null;
      const tail = book?.lastElementChild;
      const hasTail = tail?.classList.contains('kdp-tail') ?? false;
      const content = pages + shift - (hasTail ? 1 : 0);
      if (content % 2 === 1 && !hasTail && book) {
        const blank = document.createElement('div');
        blank.className = 'kdp-blank kdp-tail';
        blank.setAttribute('aria-hidden', 'true');
        book.append(blank);
        changes.push('blank page at the end (even page count)');
      } else if (content % 2 === 0 && hasTail) {
        tail?.remove();
        changes.push('removed the blank page at the end');
      }
      return changes;
    },
    // Without blank pages (Letter), only the page references are filled in.
    { pageOf, labelOf, recto: blanks ? layout.recto : [], pages: info.pages, firstChapter: layout.firstChapter, blanks },
  );
}

/**
 * Marks passage pairs of about four lines or fewer with .kdp-short, which
 * book.css keeps whole: split, they leave a line or two of Hebrew (or a lone
 * footnote) at the head of a page. Longer pairs break between lines, so pages
 * fill to the foot. Returns how many were marked.
 */
async function markShortPairs(page: Page, maxPx: number): Promise<number> {
  return page.evaluate((max) => {
    let n = 0;
    for (const pair of document.querySelectorAll<HTMLElement>('.seg-pair')) {
      // A pair the view hides (all of them in "Explanation only" and "hebrew") has no height and is not counted.
      const h = pair.getBoundingClientRect().height;
      const short = h > 0 && h <= max;
      pair.classList.toggle('kdp-short', short);
      if (short) n++;
    }
    return n;
  }, maxPx);
}

/** Elements that stick out of the text block, measured at the text width in print media. */
async function overflowCheck(page: Page, contentWidthPx: number): Promise<string[]> {
  return page.evaluate((width) => {
    const out: string[] = [];
    const root = document.querySelector('main.book');
    if (!root) return ['main.book not found'];
    const box = root.getBoundingClientRect();
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      out.push(`the page is ${document.documentElement.scrollWidth}px wide, more than the ${width}px text width`);
    }
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < box.left - 0.5 || r.right > box.left + width + 0.5) {
        const name = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`;
        out.push(`${name} spans ${Math.round(r.left - box.left)}–${Math.round(r.right - box.left)}px: "${(el.textContent ?? '').trim().slice(0, 60)}"`);
        if (out.length >= 20) break;
      }
    }
    return out;
  }, contentWidthPx);
}

// ---------------------------------------------------------------- page labels

/**
 * Writes the folio numbering into the PDF's /PageLabels, so viewers (and the
 * page box of a PDF reader) show i, ii, … for the front matter and 1, 2, …
 * from chapter 1, as printed. Everything else in the PDF is kept as it is.
 */
async function withPageLabels(bytes: Uint8Array, frontPages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const nums: (PDFNumber | PDFDict)[] = [];
  if (frontPages > 0) nums.push(PDFNumber.of(0), ctx.obj({ S: PDFName.of('r') }));
  nums.push(PDFNumber.of(frontPages), ctx.obj({ S: PDFName.of('D') }));
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: nums }));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// ---------------------------------------------------------------- checks on the finished PDF

/**
 * Checks that the folios printed by book.css's counters match folioLabel (and
 * so the page references and /PageLabels): in each window of pages, at least
 * one page with text must show its expected folio at the outside edge of its
 * first or last two lines (the first word on a verso, the last on a recto), so
 * a heading such as "Chapter 1" is not taken for one. A window catches an offset or a drift (a page type that does
 * not count) without failing on pages that print no folio, such as chapter
 * openers or blank pages.
 */
function folioCheck(file: string, windows: { what: string; pages: number[] }[], frontPages: number): string[] {
  if (!hasCommand('pdftotext')) {
    warn('pdftotext (poppler-utils) not found: printed folios not checked.');
    return [];
  }
  const problems: string[] = [];
  for (const { what, pages } of windows) {
    const seen: string[] = [];
    let ok = false;
    for (const p of pages) {
      const r = spawnSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', file, '-'], { encoding: 'utf8' });
      if (r.status !== 0) return [`pdftotext failed: ${r.stderr}`];
      const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      if (lines.length === 0) continue;
      const label = folioLabel(p, frontPages);
      const outside = [...lines.slice(0, 2), ...lines.slice(-2)].map((l) => {
        const words = l.split(/\s+/);
        return p % 2 === 0 ? words[0] : words.at(-1);
      });
      if (outside.includes(label)) {
        ok = true;
        break;
      }
      seen.push(`page ${p} (folio ${label}): "${lines.at(-1)?.replace(/\s+/g, ' ').slice(0, 60) ?? ''}"`);
    }
    if (!ok && seen.length > 0) problems.push(`the printed folios in the ${what} do not match the page labels (book.css folio counters?):\n    ${seen.join('\n    ')}`);
  }
  return problems;
}

/**
 * Body pages whose text stops more than SHORT_PAGE_IN short of the foot of the
 * text block. Not counted: the front matter, pages that start a recto section
 * (chapter openers, whose key terms are kept whole on the next page), the last
 * page before one (a chapter's end), a page before a blank one, and blank pages.
 * Reported, not failed: a heading kept with its text can leave a short page that
 * only an editor can mend.
 */
function pageDepthReport(file: string, trim: TrimSpec, pages: number, frontPages: number, skip: Set<number>): string[] {
  if (!hasCommand('pdftotext')) return [];
  const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const footPt = (trim.hIn - trim.bottom) * 72;
  const topPt = trim.top * 72;
  // The lowest word of each page inside the text block (not the head or folio).
  const lowest = r.stdout
    .split('<page ')
    .slice(1)
    .map((pg) => {
      let low = -1;
      for (const m of pg.matchAll(/yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)"/g)) {
        const y0 = Number(m[1]);
        const y1 = Number(m[2]);
        if (y0 < footPt + 2 && y1 > topPt - 2) low = Math.max(low, y1);
      }
      return low;
    });
  const short: string[] = [];
  for (let p = frontPages + 1; p < pages; p++) {
    const low = lowest[p - 1] ?? -1;
    if (low < 0 || skip.has(p) || (lowest[p] ?? -1) < 0) continue;
    const gap = (footPt - low) / 72;
    if (gap > SHORT_PAGE_IN * trim.zoom) short.push(`${p} (${gap.toFixed(2)} in)`);
  }
  return short;
}

function pdffontsCheck(file: string): string[] {
  if (!hasCommand('pdffonts')) {
    warn('pdffonts (poppler-utils) not found: font embedding not checked.');
    return [];
  }
  const r = spawnSync('pdffonts', [file], { encoding: 'utf8' });
  if (r.status !== 0) return [`pdffonts failed: ${r.stderr}`];
  const problems: string[] = [];
  const lines = r.stdout.split('\n').slice(2).filter((l) => l.trim() !== '');
  for (const line of lines) {
    // name type encoding emb sub uni object ID; the name has no spaces, type may.
    const cols = line.trim().split(/\s+/);
    const name = cols[0] ?? '';
    const emb = cols.at(-5);
    if (emb !== 'yes') problems.push(`font not embedded: ${line.trim()}`);
    const family = name.replace(/^[A-Z]{6}\+/, '');
    if (!/^(SourceSerif4|SourceSans3|FrankRuhlLibre)/i.test(family)) problems.push(`system fallback font ${family}: some character is missing from the book's fonts`);
  }
  if (lines.length === 0) problems.push('pdffonts lists no fonts');
  return problems;
}

/** Renders the PDF small and looks for any coloured pixel (KDP black and white interior). */
function colourCheck(file: string): string[] {
  if (!hasCommand('pdftoppm')) {
    warn('pdftoppm (poppler-utils) not found: colour not checked.');
    return [];
  }
  const dir = mkdtempSync(join(tmpdir(), 'kdp-colour-'));
  try {
    const r = spawnSync('pdftoppm', ['-r', '20', file, join(dir, 'p')], { encoding: 'utf8' });
    if (r.status !== 0) return [`pdftoppm failed: ${r.stderr}`];
    const problems: string[] = [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.ppm')).sort();
    for (const f of files) {
      const buf = readPpm(join(dir, f));
      for (let i = 0; i + 2 < buf.length; i += 3) {
        const [r0, g0, b0] = [buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0];
        if (Math.max(r0, g0, b0) - Math.min(r0, g0, b0) > 24) {
          problems.push(`colour on ${f.replace(/\D/g, '').replace(/^0+/, '')}: rgb(${r0}, ${g0}, ${b0})`);
          break;
        }
      }
    }
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readPpm(file: string): Uint8Array {
  const data = new Uint8Array(readFileSync(file));
  // P6\n<w> <h>\n<max>\n then pixels; skip three whitespace-terminated header tokens after the magic.
  let pos = 0;
  let tokens = 0;
  while (tokens < 4 && pos < data.length) {
    while (pos < data.length && /\s/.test(String.fromCharCode(data[pos] ?? 0))) pos++;
    while (pos < data.length && !/\s/.test(String.fromCharCode(data[pos] ?? 0))) pos++;
    tokens++;
  }
  return data.subarray(pos + 1);
}

// ---------------------------------------------------------------- printing one view

/** A path relative to the working directory, for messages. */
function relPath(file: string, cwd: string): string {
  return file.startsWith(cwd + sep) ? file.slice(cwd.length + 1) : file;
}

/**
 * Lays out and prints one view of /book/ (served on `port`) to `job.out`, in
 * passes until the pagination settles, checks the result, and returns its page
 * count. Throws BuildError if a check fails.
 */
async function printBook(browser: Browser, port: number, job: Job, final: boolean, cwd: string): Promise<number> {
  const trim = job.trim;
  const trimWPt = trim.wIn * 72;
  const trimHPt = trim.hIn * 72;
  let gutter = trim.inside;
  let pdf: Uint8Array | undefined;
  let info: PdfInfo | undefined;
  let firstChapter = '';
  let rectoIds: string[] = [];

  // Up to two layouts: the default gutter, then KDP's gutter for the page count if that is larger.
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await browser.newPage();
    const query = new URLSearchParams({ view: job.view });
    if (final) query.set('final', '1');
    if (gutter !== trim.inside) query.set('gutter', String(gutter));
    if (!trim.kdp) query.set('trim', trim.name);
    const url = `http://127.0.0.1:${port}/book/?${query}`;
    console.log(`› ${url}`);

    // Lay out at the text width in print media, wait for the fonts, check the margins.
    const textWidthPx = Math.floor((trim.wIn - gutter - trim.outside) * 96);
    await page.setViewportSize({ width: textWidthPx, height: 960 });
    await page.emulateMedia({ media: 'print' });
    const failed: string[] = [];
    page.on('requestfailed', (req) => failed.push(req.url()));
    page.on('response', (res) => {
      if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const fontsLoaded = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight} ${f.style}`),
    );
    if (failed.length > 0) throw new BuildError(`requests failed while loading the book:\n  ${failed.join('\n  ')}`);
    // The book is set in the serifs only (book.css); Source Sans 3 is declared but no longer used.
    for (const fam of ['Source Serif 4', 'Frank Ruhl Libre']) {
      if (!fontsLoaded.some((f) => f.startsWith(fam))) throw new BuildError(`font ${fam} did not load (loaded: ${fontsLoaded.join(', ') || 'none'}).`);
    }
    const overflow = await overflowCheck(page, textWidthPx);
    if (overflow.length > 0) throw new BuildError(`content runs into the margins:\n  ${overflow.join('\n  ')}`);
    const short = await markShortPairs(page, SHORT_PAIR_IN * 96 * trim.zoom);
    console.log(`  ${short} short passage pair(s) kept whole; longer ones may break across pages`);

    const layout = await layoutTargets(page);
    firstChapter = layout.firstChapter;
    rectoIds = layout.recto;
    let stable = false;
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
      info = await readPdf(pdf);
      const changes = await applyPass(page, info, layout, trim.kdp);
      console.log(`  pass ${pass}: ${info.pages} pages${changes.length ? `; ${changes.length} change(s): ${changes.slice(0, 4).join('; ')}${changes.length > 4 ? '; …' : ''}` : '; stable'}`);
      if (changes.length === 0) {
        stable = true;
        break;
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
    }
    await page.close();
    if (!stable || !info || !pdf) throw new BuildError(`the pagination did not settle after ${MAX_PASSES} passes.`);

    const missing = [...layout.recto, ...layout.refs].filter((id) => !info?.dests.has(id));
    if (missing.length > 0) throw new BuildError(`no page found for: ${missing.join(', ')} (are they link targets?)`);
    const verso = trim.kdp ? layout.recto.filter((id) => (info?.dests.get(id) ?? 1) % 2 === 0) : [];
    if (verso.length > 0) throw new BuildError(`these start on a left-hand page: ${verso.join(', ')}`);

    const needed = kdpGutter(info.pages);
    if (!trim.kdp || needed <= gutter) break;
    if (attempt === 1) throw new BuildError(`${info.pages} pages need a ${needed} in gutter; the layout with it still did not fit.`);
    console.log(`  ${info.pages} pages need KDP's ${needed} in gutter; laying out again.`);
    gutter = needed;
  }
  if (!pdf || !info) throw new BuildError('no PDF was produced.');

  // ---- page numbering: roman front matter, arabic from chapter 1 (see the header comment)
  const front = frontPageCount(info, firstChapter);
  if (trim.kdp && front % 2 !== 0) throw new BuildError(`the front matter has ${front} pages, so chapter 1 is not on a right-hand page.`);
  pdf = await withPageLabels(pdf, front);

  // ---- checks
  const problems: string[] = [];
  info.sizes.forEach((s, i) => {
    if (Math.abs(s.w - trimWPt) > 0.5 || Math.abs(s.h - trimHPt) > 0.5) problems.push(`page ${i + 1} is ${s.w} × ${s.h} pt, not ${trimWPt} × ${trimHPt}`);
  });
  if (trim.kdp && info.pages % 2 !== 0) problems.push(`odd page count (${info.pages})`);
  if (trim.kdp && info.pages > KDP_MAX_PAGES) problems.push(`${info.pages} pages is over KDP's paperback maximum of ${KDP_MAX_PAGES}`);

  // Written under a temporary name and moved into place only once it passes, so a
  // PDF that failed the checks never sits at the name of a good one.
  mkdirSync(dirname(job.out), { recursive: true });
  const tmp = `${job.out}.tmp`;
  const failedOut = job.out.replace(/(\.pdf)?$/i, '.failed.pdf');
  writeFileSync(tmp, pdf);
  const checkedFonts = hasCommand('pdffonts');
  const checkedColour = hasCommand('pdftoppm');
  const checkedFolios = hasCommand('pdftotext');
  const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, Math.min(to, info?.pages ?? 0) - from + 1) }, (_, i) => from + i);
  problems.push(
    ...pdffontsCheck(tmp),
    ...colourCheck(tmp),
    ...folioCheck(
      tmp,
      [
        { what: 'front matter', pages: range(3, front) },
        { what: 'first pages of chapter 1', pages: range(front + 1, front + 4) },
        { what: 'last pages', pages: range(Math.max(front + 1, info.pages - 5), info.pages) },
      ],
      front,
    ),
  );
  if (problems.length > 0) {
    rmSync(job.out, { force: true });
    renameSync(tmp, failedOut);
    throw new BuildError(`the PDF fails the ${trim.kdp ? 'KDP ' : ''}checks (kept for inspection as ${failedOut}; do not upload it):\n  ${problems.join('\n  ')}`);
  }
  rmSync(failedOut, { force: true });
  renameSync(tmp, job.out);
  const rectoPages = rectoIds.map((id) => info?.dests.get(id) ?? 0);
  const short = pageDepthReport(job.out, trim, info.pages, front, new Set([...rectoPages, ...rectoPages.map((p) => p - 1)]));
  if (short.length > 0) warn(`${short.length} page(s) stop more than ${SHORT_PAGE_IN} in short of the foot (PDF page numbers): ${short.join(', ')}`);
  if (trim.kdp && info.pages < KDP_MIN_PAGES) warn(`${info.pages} pages is under KDP's paperback minimum of ${KDP_MIN_PAGES}.`);

  const rel = relPath(job.out, cwd);
  console.log(`
✔ ${rel}
  ${info.pages} pages, ${trimWPt} × ${trimHPt} pt (${trim.label}), view: ${job.view}${final ? ', final (no draft notices)' : ', draft notices on'}
  folios: ${front > 0 ? `i–${roman(front)} (front matter), ` : ''}1–${info.pages - front} from chapter 1 (also as /PageLabels)
  margins: ${trim.kdp ? `inside ${gutter} in (KDP minimum for ${info.pages} pages: ${kdpGutter(info.pages)} in), outside ${trim.outside} in` : `${trim.outside} in each side, the 7 × 10 layout scaled ${trim.zoom.toFixed(3)}×; no blank pages`}
  ${checkedFonts ? 'all fonts embedded (pdffonts)' : 'fonts NOT checked (no pdffonts)'}; ${checkedColour ? 'no colour (pdftoppm)' : 'colour NOT checked (no pdftoppm)'}; ${checkedFolios ? 'folios match (pdftotext)' : 'folios NOT checked (no pdftotext)'}
  ${trim.kdp ? 'KDP: paperback, 7 x 10 in, no bleed, black & white interior, cream or white paper; upload the cover separately.' : 'For printing at home: Letter paper, single- or double-sided, at 100% (no "fit to page").'}`);
  return info.pages;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const opts = parseOptions();
  const cwd = process.cwd();
  const dist = join(cwd, 'dist');

  if (opts.final) warnUnreviewed();

  if (opts.build) {
    console.log('› npm run build (validate content, astro build)');
    const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', cwd });
    if (r.status !== 0) throw new BuildError('the site build failed.');
  }
  if (!existsSync(join(dist, 'book', 'index.html'))) throw new BuildError('dist/book/index.html is missing: run without --no-build.');

  const server = await serve(dist);
  const { port } = server.address() as AddressInfo;
  const browser = await chromium.launch();
  try {
    const pages: string[] = [];
    for (const job of opts.jobs) {
      if (opts.jobs.length > 1) console.log(`\n› view: ${job.view}, ${job.trim.name}`);
      const n = await printBook(browser, port, job, opts.final, cwd);
      pages.push(`${relPath(job.out, cwd)}: ${n} pages (${job.view}, ${job.trim.name})`);
    }
    if (opts.jobs.length > 1) console.log(`\n✔ ${opts.jobs.length} PDFs:\n  ${pages.join('\n  ')}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err: unknown) => fail(err instanceof BuildError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)));
