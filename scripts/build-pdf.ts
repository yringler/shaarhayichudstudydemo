/**
 * Builds the print-ready PDF of the booklet for Amazon KDP (paperback, trim
 * 7 × 10 in, no bleed, black and white interior) from the /book/ page.
 *
 *   npm run pdf                                   # npm run build, then print
 *   npm run pdf -- --view explanation             # guide | explanation | text
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
 * size of every page, page count, fonts embedded, no colour) before it is
 * written.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import { chromium, type Page } from 'playwright';
import { BOOK_PDF } from '../src/lib/chapters';
import { loadGuide } from '../src/lib/content';

// ---------------------------------------------------------------- settings

const TRIM_W_PT = 7 * 72; // 504
const TRIM_H_PT = 10 * 72; // 720
const KDP_MIN_PAGES = 24;
const KDP_MAX_PAGES = 828;
/** The page's own gutter (book.css); a larger one is passed as ?gutter=. */
const DEFAULT_GUTTER_IN = 0.9;
const OUTSIDE_MARGIN_IN = 0.8;
const MAX_PASSES = 8;
/** Text block height (book.css: 10 in less 0.85 in top and 0.95 in bottom margins). */
const TEXT_HEIGHT_IN = 10 - 0.85 - 0.95;
/** A passage pair taller than this share of the text block may break across pages. */
const TALL_PAIR_SHARE = 0.45;
const DEFAULT_OUT = `pdf/${BOOK_PDF}`;
const VIEWS = ['guide', 'explanation', 'text'] as const;
type View = (typeof VIEWS)[number];

/** KDP's minimum inside margin (gutter) for a page count, in inches. */
function kdpGutter(pages: number): number {
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  return 0.875;
}

// ---------------------------------------------------------------- arguments

interface Options {
  view: View;
  final: boolean;
  build: boolean;
  out: string;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      view: { type: 'string', default: 'guide' },
      final: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      out: { type: 'string', default: DEFAULT_OUT },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('Usage: npm run pdf -- [--view guide|explanation|text] [--final] [--no-build] [--out file.pdf]');
    process.exit(0);
  }
  const view = values.view;
  if (!isView(view)) fail(`--view must be one of ${VIEWS.join(', ')} (got "${view}").`);
  return { view, final: values.final, build: !values['no-build'], out: resolve(values.out) };
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
    return { recto, refs };
  });
}

/**
 * Applies one pass of pagination fixes in the page and reports whether anything
 * changed. Inserting a blank page before an element moves everything after it
 * by exactly one page, so all fixes can be made in one pass.
 */
async function applyPass(page: Page, info: PdfInfo, layout: Layout): Promise<string[]> {
  const pageOf = Object.fromEntries(info.dests);
  return page.evaluate(
    ({ pageOf, recto, pages }) => {
      const changes: string[] = [];
      let shift = 0;
      for (const id of recto) {
        const el = document.getElementById(id);
        const p = pageOf[id];
        if (!el || p === undefined) continue;
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
            blank.className = 'kdp-blank';
            blank.setAttribute('aria-hidden', 'true');
            el.before(blank);
            shift += 1;
            changes.push(`blank page before #${id}`);
          }
        }
      }
      for (const span of document.querySelectorAll<HTMLElement>('[data-pageref]')) {
        const p = pageOf[span.dataset['pageref'] ?? ''];
        const text = p === undefined ? '' : String(p);
        if (span.textContent !== text) {
          span.textContent = text;
          if (changes.length < 50) changes.push(`page ref #${span.dataset['pageref']} → ${text || '(none)'}`);
        }
      }
      const book = document.querySelector('main.book');
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
    { pageOf, recto: layout.recto, pages: info.pages },
  );
}

/**
 * Marks passage pairs taller than about half a page with .kdp-tall, which
 * book.css lets break inside; shorter pairs stay whole. Returns how many.
 */
async function markTallPairs(page: Page, maxPx: number): Promise<number> {
  return page.evaluate((max) => {
    let n = 0;
    for (const pair of document.querySelectorAll<HTMLElement>('.seg-pair')) {
      const tall = pair.getBoundingClientRect().height > max;
      pair.classList.toggle('kdp-tall', tall);
      if (tall) n++;
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

// ---------------------------------------------------------------- checks on the finished PDF

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
    let gutter = DEFAULT_GUTTER_IN;
    let pdf: Uint8Array | undefined;
    let info: PdfInfo | undefined;

    // Up to two layouts: the default gutter, then KDP's gutter for the page count if that is larger.
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await browser.newPage();
      const query = new URLSearchParams({ view: opts.view });
      if (opts.final) query.set('final', '1');
      if (gutter !== DEFAULT_GUTTER_IN) query.set('gutter', String(gutter));
      const url = `http://127.0.0.1:${port}/book/?${query}`;
      console.log(`› ${url}`);

      // Lay out at the text width in print media, wait for the fonts, check the margins.
      const textWidthPx = Math.floor((7 - gutter - OUTSIDE_MARGIN_IN) * 96);
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
      const tall = await markTallPairs(page, TEXT_HEIGHT_IN * 96 * TALL_PAIR_SHARE);
      if (tall > 0) console.log(`  ${tall} passage pair(s) taller than ${Math.round(TALL_PAIR_SHARE * 100)}% of a page may break across pages`);

      const layout = await layoutTargets(page);
      let stable = false;
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
        info = await readPdf(pdf);
        const changes = await applyPass(page, info, layout);
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
      const verso = layout.recto.filter((id) => (info?.dests.get(id) ?? 1) % 2 === 0);
      if (verso.length > 0) throw new BuildError(`these start on a left-hand page: ${verso.join(', ')}`);

      const needed = kdpGutter(info.pages);
      if (needed <= gutter) break;
      if (attempt === 1) throw new BuildError(`${info.pages} pages need a ${needed} in gutter; the layout with it still did not fit.`);
      console.log(`  ${info.pages} pages need KDP's ${needed} in gutter; laying out again.`);
      gutter = needed;
    }
    if (!pdf || !info) throw new BuildError('no PDF was produced.');

    // ---- checks
    const problems: string[] = [];
    info.sizes.forEach((s, i) => {
      if (Math.abs(s.w - TRIM_W_PT) > 0.5 || Math.abs(s.h - TRIM_H_PT) > 0.5) problems.push(`page ${i + 1} is ${s.w} × ${s.h} pt, not ${TRIM_W_PT} × ${TRIM_H_PT}`);
    });
    if (info.pages % 2 !== 0) problems.push(`odd page count (${info.pages})`);
    if (info.pages > KDP_MAX_PAGES) problems.push(`${info.pages} pages is over KDP's paperback maximum of ${KDP_MAX_PAGES}`);

    // Written under a temporary name and moved into place only once it passes, so a
    // PDF that failed the checks never sits at the name of a good one.
    mkdirSync(dirname(opts.out), { recursive: true });
    const tmp = `${opts.out}.tmp`;
    const failedOut = opts.out.replace(/(\.pdf)?$/i, '.failed.pdf');
    writeFileSync(tmp, pdf);
    const checkedFonts = hasCommand('pdffonts');
    const checkedColour = hasCommand('pdftoppm');
    problems.push(...pdffontsCheck(tmp), ...colourCheck(tmp));
    if (problems.length > 0) {
      rmSync(opts.out, { force: true });
      renameSync(tmp, failedOut);
      throw new BuildError(`the PDF fails the KDP checks (kept for inspection as ${failedOut}; do not upload it):\n  ${problems.join('\n  ')}`);
    }
    rmSync(failedOut, { force: true });
    renameSync(tmp, opts.out);
    if (info.pages < KDP_MIN_PAGES) warn(`${info.pages} pages is under KDP's paperback minimum of ${KDP_MIN_PAGES}.`);

    const rel = opts.out.startsWith(cwd + sep) ? opts.out.slice(cwd.length + 1) : opts.out;
    console.log(`
✔ ${rel}
  ${info.pages} pages, ${TRIM_W_PT} × ${TRIM_H_PT} pt (7 × 10 in, no bleed), view: ${opts.view}${opts.final ? ', final (no draft notices)' : ', draft notices on'}
  margins: inside ${gutter} in (KDP minimum for ${info.pages} pages: ${kdpGutter(info.pages)} in), outside ${OUTSIDE_MARGIN_IN} in
  ${checkedFonts ? 'all fonts embedded (pdffonts)' : 'fonts NOT checked (no pdffonts)'}; ${checkedColour ? 'no colour (pdftoppm)' : 'colour NOT checked (no pdftoppm)'}
  KDP: paperback, 7 x 10 in, no bleed, black & white interior, cream or white paper; upload the cover separately.`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err: unknown) => fail(err instanceof BuildError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)));
