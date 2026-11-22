/**
 * HTML → XHTML for the EPUB (scripts/build-epub.ts). The content models
 * (src/lib/content.ts) hold HTML made for the site: marked's output, HTML
 * entities such as &nbsp;, void tags without a slash, and site-only markup
 * (the ▶ button's SVG, the screen half of a listen link). EPUB content
 * documents are XML, so every fragment goes through {@link toXhtml}, which
 * parses it, rewrites what the book does not want, and serializes it as
 * well-formed XHTML.
 */
import { HTMLElement, NodeType, TextNode, parse, type Node as HtmlNode } from 'node-html-parser';

const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col', 'area', 'source']);

/** Text and attribute escaping for XML (the five predefined entities only). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * The fonts have no non-breaking hyphen (U+2011, in "G‑d"): set a plain hyphen
 * in a no-wrap span, as book.astro does for the PDF, so a reader does not fall
 * back to another font for one glyph. Takes escaped text.
 */
function nobrHyphens(escaped: string): string {
  return escaped.replace(/\S*‑\S*/g, (w) => `<span class="nobr">${w.replace(/‑/g, '-')}</span>`);
}

/** Options for {@link toXhtml}. */
export interface XhtmlOptions {
  /** Rewrites an in-book href ("#ch3-s12") to its file and anchor ("chapter-3.xhtml#ch3-s12"). */
  resolveHref?: (href: string) => string;
  /** Makes a footnote reference out of `<sup data-fn="n">`; left as a plain superscript without it. */
  noteref?: (n: number) => string;
}

/**
 * Serializes an HTML fragment as XHTML:
 *  - entities are decoded and re-escaped, so &nbsp; becomes U+00A0;
 *  - void elements are self-closed;
 *  - `lang` is mirrored to `xml:lang`, and Hebrew spans get `dir="rtl"`;
 *  - listen links keep only their printed "(class 21, 4:12)", linking to the recording;
 *  - SVG icons, `target` and `rel` are dropped (readers open links their own way);
 *  - `<sup data-fn>` becomes a footnote reference if `noteref` is given.
 */
export function toXhtml(html: string, opts: XhtmlOptions = {}): string {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, pre: true } });
  return serializeChildren(root, opts);
}

function serializeChildren(node: HtmlNode, opts: XhtmlOptions): string {
  return node.childNodes.map((c) => serializeNode(c, opts)).join('');
}

function serializeNode(node: HtmlNode, opts: XhtmlOptions): string {
  if (node.nodeType === NodeType.TEXT_NODE) return nobrHyphens(esc((node as TextNode).text));
  if (node.nodeType !== NodeType.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase() ?? '';
  if (!tag) return serializeChildren(el, opts);
  const cls = el.classList;

  if (tag === 'svg' || cls.contains('listen-screen') || cls.contains('approx')) return '';

  if (tag === 'a' && cls.contains('listen')) {
    const printed = el.querySelector('.listen-print')?.text ?? el.text;
    const href = el.getAttribute('href');
    return href
      ? `<a class="listen" href="${esc(href)}">${nobrHyphens(esc(printed))}</a>`
      : `<span class="listen">${esc(printed)}</span>`;
  }

  if (tag === 'sup' && el.getAttribute('data-fn') !== undefined) {
    const n = Number(el.getAttribute('data-fn'));
    if (opts.noteref && Number.isFinite(n)) return opts.noteref(n);
    return `<sup>${esc(el.text)}</sup>`;
  }

  const attrs: [string, string][] = [];
  for (const [name, value] of Object.entries(el.attributes)) {
    const k = name.toLowerCase();
    if (k === 'target' || k === 'rel' || k.startsWith('data-') || k === 'title' || k === 'aria-label') continue;
    if (k === 'href' && opts.resolveHref) attrs.push([k, opts.resolveHref(value)]);
    else attrs.push([k, value]);
  }
  const lang = el.getAttribute('lang');
  if (lang && !el.getAttribute('xml:lang')) attrs.push(['xml:lang', lang]);
  if (lang === 'he' && !el.getAttribute('dir')) attrs.push(['dir', 'rtl']);

  const open = `<${tag}${attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}`;
  if (VOID.has(tag)) return `${open}/>`;
  return `${open}>${serializeChildren(el, opts)}</${tag}>`;
}

/** Plain text (a title, a gloss, a Hebrew line) as XHTML text. */
export function text(s: string): string {
  return nobrHyphens(esc(s));
}

/**
 * A whole XHTML content document. `epub:type` on the body names the part of
 * the book (frontmatter, bodymatter, backmatter) for readers that use it.
 */
export function xhtmlDocument(title: string, body: string, opts: { bodyType?: string; bodyClass?: string } = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title.replace(/\u2011/g, '-'))}</title>
<link rel="stylesheet" type="text/css" href="css/epub.css"/>
</head>
<body${opts.bodyType ? ` epub:type="${opts.bodyType}"` : ''}${opts.bodyClass ? ` class="${opts.bodyClass}"` : ''}>
${body}
</body>
</html>
`;
}
