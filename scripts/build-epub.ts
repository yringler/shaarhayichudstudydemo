/**
 * Builds the EPUB 3 editions of the booklet: the study guide, the explanation
 * only and the Hebrew-and-explanation editions, the same three as the PDFs.
 *
 *   npm run epub                               # the study guide
 *   npm run epub -- --view explanation         # guide | explanation | hebrew
 *   npm run epub:all                           # all three
 *   npm run epub -- --final                    # no draft notices
 *   npm run epub -- --out some/where.epub
 *   npm run epub:check                         # EPUBCheck on the EPUBs in pdf/ (see epubcheck())
 *
 * No site build and no browser: the content documents are written straight
 * from the typed models (src/lib/content.ts) by scripts/epub/book.ts, the
 * fragments turned into XHTML by scripts/epub/xhtml.ts, and zipped here with
 * the package document, the navigation document, the stylesheet
 * (epub/epub.css) and the fonts (epub/fonts/, made by make-print-fonts.py).
 *
 * The zip follows OCF: `mimetype` first and stored, then everything else. Each
 * content document is checked to be well-formed XML (xmllint, if installed)
 * and every in-book link to point at an id that exists, before the file is
 * written. EPUBCheck, the full validator, is run by `npm run epub:check` and in
 * the deploy workflow.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync, type Zippable } from 'fflate';
import { BOOK_EPUBS, EPUB_VIEWS, type EpubView } from '../src/lib/chapters';
import { loadGuide } from '../src/lib/content';
import { buildBook, EDITION_NAME, type EpubBook, type NavEntry } from './epub/book';
import { esc } from './epub/xhtml';

const ROOT = process.cwd();
const ASSETS = join(ROOT, 'epub');
const FONT_DIR = join(ASSETS, 'fonts');
const LICENCES = [
  { family: 'Source Serif 4', file: join(ROOT, 'public/fonts/print/OFL-SourceSerif4.txt') },
  { family: 'Frank Ruhl Libre', file: join(ROOT, 'public/fonts/print/OFL-FrankRuhlLibre.txt') },
];
/** A copyright line for the copyright page; empty until the publisher supplies one (as in book.astro). */
const COPYRIGHT_LINE = '';

// ---------------------------------------------------------------- arguments

interface Job {
  view: EpubView;
  out: string;
}

function fail(message: string): never {
  console.error(`\n✖ build-epub: ${message}`);
  process.exit(1);
}

function parseOptions(): { jobs: Job[]; final: boolean; check: boolean } {
  const { values } = parseArgs({
    options: {
      view: { type: 'string' },
      all: { type: 'boolean', default: false },
      final: { type: 'boolean', default: false },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('Usage: npm run epub -- [--view guide|explanation|hebrew | --all] [--final] [--out file.epub]\n       npm run epub -- --check');
    process.exit(0);
  }
  if (values.check) return { final: false, check: true, jobs: [] };
  const defaultOut = (v: EpubView): string => resolve('pdf', BOOK_EPUBS[v]);
  if (values.all) {
    if (values.view !== undefined || values.out !== undefined) fail('--all writes every edition to its own file; it takes neither --view nor --out.');
    return { final: values.final, check: false, jobs: EPUB_VIEWS.map((view) => ({ view, out: defaultOut(view) })) };
  }
  const view = values.view ?? 'guide';
  if (!(EPUB_VIEWS as readonly string[]).includes(view)) fail(`--view must be one of ${EPUB_VIEWS.join(', ')} (got "${view}").`);
  const v = view as EpubView;
  return { final: values.final, check: false, jobs: [{ view: v, out: resolve(values.out ?? defaultOut(v)) }] };
}

// ---------------------------------------------------------------- package and navigation documents

/** A stable urn:uuid per edition (name-based, SHA-1, as UUID v5), so a re-upload is the same book. */
function editionUuid(view: EpubView): string {
  const h = createHash('sha1').update(`shaar-hayichud-study-guide/booklet-1/${view}`).digest('hex');
  const variant = ((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Nav labels are plain text: the reader's own UI font, so no U+2011 (most UI fonts lack it too). */
const navText = (s: string): string => esc(s.replace(/‑/g, '-'));

function navList(entries: NavEntry[], indent: string): string {
  return (
    `${indent}<ol>\n` +
    entries
      .map(
        (e) =>
          `${indent}  <li><a href="${esc(e.href)}">${navText(e.label)}</a>` +
          (e.children.length > 0 ? `\n${navList(e.children, `${indent}    `)}${indent}  ` : '') +
          '</li>\n',
      )
      .join('') +
    `${indent}</ol>\n`
  );
}

function navDocument(book: EpubBook): string {
  const firstChapter = book.docs.find((d) => d.type === 'bodymatter');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>Contents</title>
<link rel="stylesheet" type="text/css" href="css/epub.css"/>
</head>
<body>
<nav epub:type="toc" role="doc-toc" id="toc">
<h1 class="section-title">Contents</h1>
${navList(book.nav, '')}</nav>
<nav epub:type="landmarks" hidden="hidden">
<ol>
  <li><a epub:type="toc" href="nav.xhtml#toc">Contents</a></li>
${firstChapter ? `  <li><a epub:type="bodymatter" href="${firstChapter.file}">Start of the text</a></li>\n` : ''}  <li><a epub:type="copyright-page" href="copyright.xhtml">Copyright</a></li>
${book.docs.some((d) => d.file === 'glossary.xhtml') ? '  <li><a epub:type="glossary" href="glossary.xhtml">Glossary</a></li>\n' : ''}</ol>
</nav>
</body>
</html>
`;
}

interface ManifestItem {
  id: string;
  href: string;
  type: string;
  properties?: string;
}

function packageDocument(view: EpubView, book: EpubBook, fonts: string[], final: boolean): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const items: ManifestItem[] = [
    { id: 'nav', href: 'nav.xhtml', type: 'application/xhtml+xml', properties: 'nav' },
    { id: 'css', href: 'css/epub.css', type: 'text/css' },
    ...book.docs.map((d, i) => ({ id: `doc${i + 1}`, href: d.file, type: 'application/xhtml+xml' })),
    ...fonts.map((f, i) => ({ id: `font${i + 1}`, href: `fonts/${f}`, type: 'font/ttf' })),
  ];
  const spineDocs = book.docs.map((d, i) => ({ idref: `doc${i + 1}`, auxiliary: d.auxiliary ?? false }));
  // Title and copyright first, then the contents, then the rest.
  const spine = [
    ...spineDocs.slice(0, 2),
    { idref: 'nav', auxiliary: false },
    ...spineDocs.slice(2),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en"
  prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="pub-id">urn:uuid:${editionUuid(view)}</dc:identifier>
  <dc:title id="title">${esc(book.title)}</dc:title>
  <meta refines="#title" property="title-type">main</meta>
  <dc:creator id="author">Rabbi Dov Ber Schneuri, the Mitteler Rebbe</dc:creator>
  <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
  <dc:contributor id="translator">Rabbi Amiram Markel</dc:contributor>
  <meta refines="#translator" property="role" scheme="marc:relators">trl</meta>
  <dc:language>en</dc:language>
  <dc:language>he</dc:language>
  <dc:subject>Chabad Chassidus</dc:subject>
  <dc:description>${esc(book.description)}${final ? '' : ' Draft for review: not reviewed by Rabbi Markel; do not distribute.'}</dc:description>
  <dc:rights>English translation by Rabbi Amiram Markel, CC BY 4.0. Explanations ${final ? '' : '(draft) '}following his classes.</dc:rights>
  <meta property="dcterms:modified">${modified}</meta>
  <meta property="ibooks:specified-fonts">true</meta>
  <meta property="schema:accessMode">textual</meta>
  <meta property="schema:accessModeSufficient">textual</meta>
  <meta property="schema:accessibilityFeature">structuralNavigation</meta>
  <meta property="schema:accessibilityFeature">tableOfContents</meta>
  <meta property="schema:accessibilityFeature">readingOrder</meta>
  <meta property="schema:accessibilityHazard">none</meta>
  <meta property="schema:accessibilitySummary">Reflowable text in a single column, with a navigable table of contents, headings for every chapter and section, Hebrew marked with its language and direction, and linked footnotes.</meta>
</metadata>
<manifest>
${items.map((m) => `  <item id="${m.id}" href="${esc(m.href)}" media-type="${m.type}"${m.properties ? ` properties="${m.properties}"` : ''}/>`).join('\n')}
</manifest>
<spine page-progression-direction="ltr">
${spine.map((s) => `  <itemref idref="${s.idref}"${s.auxiliary ? ' linear="no"' : ''}/>`).join('\n')}
</spine>
</package>
`;
}

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

// ---------------------------------------------------------------- checks

/** Every href="file#id" between the content documents must name an existing file and id. */
function linkCheck(files: Map<string, string>): string[] {
  const ids = new Map<string, Set<string>>();
  for (const [name, xml] of files) ids.set(name, new Set([...xml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? '')));
  const problems: string[] = [];
  for (const [name, xml] of files) {
    const seen = new Set<string>();
    for (const m of xml.matchAll(/\sid="([^"]+)"/g)) {
      const id = m[1] ?? '';
      if (seen.has(id)) problems.push(`${name}: duplicate id "${id}"`);
      seen.add(id);
    }
    for (const m of xml.matchAll(/\shref="([^"]+)"/g)) {
      const href = (m[1] ?? '').replace(/&amp;/g, '&');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('css/')) continue;
      const [file = '', frag] = href.split('#');
      const target = file === '' ? name : file;
      const targetIds = ids.get(target);
      if (!targetIds) problems.push(`${name}: link to missing file ${href}`);
      else if (frag !== undefined && !targetIds.has(frag)) problems.push(`${name}: link to missing id ${href}`);
    }
  }
  return problems;
}

/** Well-formed XML (xmllint --noout), if xmllint is installed. */
function xmlCheck(files: Map<string, string>): string[] {
  if (spawnSync('xmllint', ['--version'], { stdio: 'ignore' }).error !== undefined) {
    console.warn('⚠ xmllint (libxml2-utils) not found: the XHTML is not checked for well-formedness here (EPUBCheck still does).');
    return [];
  }
  const problems: string[] = [];
  for (const [name, xml] of files) {
    const r = spawnSync('xmllint', ['--noout', '--nonet', '-'], { input: xml, encoding: 'utf8' });
    if (r.status !== 0) problems.push(`${name} is not well-formed XML:\n    ${r.stderr.trim().split('\n').slice(0, 6).join('\n    ')}`);
  }
  return problems;
}

/** Characters the embedded fonts lack would make a reader fall back to another font. */
function glyphCheck(files: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, xml] of files) {
    if (xml.includes('‑')) problems.push(`${name}: a non-breaking hyphen (U+2011) is left; the fonts have no glyph for it`);
  }
  return problems;
}

// ---------------------------------------------------------------- main

function buildOne(job: Job, final: boolean, made: string): void {
  const guide = loadGuide();
  const licences = LICENCES.map((l) => ({ family: l.family, text: readFileSync(l.file, 'utf8') }));
  const book = buildBook(guide, { view: job.view, draft: !final, made, copyrightLine: COPYRIGHT_LINE, licences });
  if (!existsSync(FONT_DIR)) fail('epub/fonts/ is missing: run python3 scripts/make-print-fonts.py --epub');
  const fonts = readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).sort();

  const xhtml = new Map<string, string>([['nav.xhtml', navDocument(book)], ...book.docs.map((d): [string, string] => [d.file, d.xhtml])]);
  const problems = [...xmlCheck(xhtml), ...linkCheck(xhtml), ...glyphCheck(xhtml)];
  // Every font the stylesheet names must be in epub/fonts/ (and so in the manifest).
  const css = readFileSync(join(ASSETS, 'epub.css'), 'utf8');
  for (const m of css.matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)) if (!fonts.includes(m[1] ?? '')) problems.push(`epub.css names fonts/${m[1]}, which is not in epub/fonts/`);
  if (problems.length > 0) fail(`the ${job.view} EPUB fails its checks:\n  ${problems.join('\n  ')}`);

  const enc = new TextEncoder();
  const files: Zippable = {
    // OCF: the first entry, stored uncompressed, no extra field.
    mimetype: [enc.encode('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': enc.encode(CONTAINER),
    'OEBPS/content.opf': enc.encode(packageDocument(job.view, book, fonts, final)),
    'OEBPS/css/epub.css': enc.encode(css),
  };
  for (const [name, xml] of xhtml) files[`OEBPS/${name}`] = enc.encode(xml);
  for (const f of fonts) files[`OEBPS/fonts/${f}`] = new Uint8Array(readFileSync(join(FONT_DIR, f)));
  const zip = zipSync(files, { level: 9 });

  mkdirSync(dirname(job.out), { recursive: true });
  writeFileSync(job.out, zip);
  const rel = job.out.startsWith(ROOT) ? job.out.slice(ROOT.length + 1) : job.out;
  const chapters = book.docs.filter((d) => d.type === 'bodymatter').length;
  console.log(`✔ ${rel}  (${EDITION_NAME[job.view]}: ${chapters} chapters, ${fonts.length} fonts, ${(zip.length / 1024).toFixed(0)} KB${final ? ', final' : ', draft notices on'})`);
}

/**
 * Runs EPUBCheck (github.com/w3c/epubcheck, Java 11+) on each edition in pdf/:
 * the jar named by EPUBCHECK_JAR, or an `epubcheck` command on the PATH. Fails
 * on any error or warning; the deploy workflow downloads the jar and runs this.
 */
function epubcheck(): void {
  const jar = process.env['EPUBCHECK_JAR'];
  const books = EPUB_VIEWS.map((v) => resolve('pdf', BOOK_EPUBS[v])).filter((f) => existsSync(f));
  if (books.length === 0) fail('no EPUBs in pdf/: run npm run epub:all first.');
  let failed = 0;
  for (const book of books) {
    const [cmd, args] = jar ? ['java', ['-jar', jar, '--failonwarnings', book]] : ['epubcheck', ['--failonwarnings', book]];
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.error) fail(`could not run ${cmd}: set EPUBCHECK_JAR to epubcheck.jar (github.com/w3c/epubcheck/releases), or put epubcheck on the PATH.`);
    if (r.status !== 0) failed++;
  }
  if (failed > 0) fail(`EPUBCheck found problems in ${failed} of ${books.length} EPUB(s).`);
  console.log(`✔ EPUBCheck: ${books.length} EPUB(s) valid`);
}

function main(): void {
  const { jobs, final, check } = parseOptions();
  if (check) return epubcheck();
  const made = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  for (const job of jobs) buildOne(job, final, made);
}

main();
