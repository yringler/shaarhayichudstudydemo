/**
 * Typographic clean-up applied at render time, for the site and the print book alike.
 * None of it changes wording: the files in content/ and data/ keep their ASCII
 * quotes, and scripts/validate-content.ts checks them as written.
 *
 *  - Hebrew geresh and gershayim: ASCII ' and '' or " typed inside Hebrew words
 *    ("כו'", "הנו''ן", "חב"ד") become ׳ (U+05F3) and ״ (U+05F4).
 *  - Smart quotes for English: " and ' become “ ” ‘ ’, and apostrophes (one's,
 *    sheb'bina, ma'amik) become ’. Markup, attribute values and <code>/<pre> are
 *    left alone.
 *  - Reversed square brackets in the translation (]like this[, inherited from the
 *    Sefaria source) are turned the right way round.
 *  - Stray footnote digits glued to Hebrew words in the source text (מושכל15) are
 *    dropped (the data has no notes for them), and „ standing for an alef in the
 *    Yiddish glosses (פ„ר, „ליין) becomes א.
 *
 * Run `npx tsx scripts/test-typography.ts` after changing anything here.
 */

/** A Hebrew letter or a point/cantillation mark that sits on one. */
const HEB = '[\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7\\u05D0-\\u05EA\\uFB1D-\\uFB4F]';
const HEB_RE = new RegExp(HEB);
const GERESH = '׳';
const GERSHAYIM = '״';

function isHebrew(c: string): boolean {
  return HEB_RE.test(c);
}

function isWordChar(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

/** Characters after which a quote opens rather than closes. */
function opensAfter(c: string): boolean {
  return /[\s([{—–/‘“-]/.test(c);
}

/**
 * Geresh and gershayim in a run of Hebrew (the source text, a term's Hebrew).
 * Every ' after a Hebrew letter is a geresh here: the Hebrew text in data/ does
 * not use single quotation marks.
 */
export function hebrewMarks(s: string): string {
  return s
    .replace(new RegExp(`(${HEB})(?:''|")(?=${HEB})`, 'g'), `$1${GERSHAYIM}`)
    .replace(new RegExp(`(${HEB})''`, 'g'), `$1${GERSHAYIM}`)
    .replace(new RegExp(`(${HEB})'`, 'g'), `$1${GERESH}`);
}

/**
 * The Hebrew source text: geresh and gershayim, plus two repairs to characters the
 * Sefaria import mangled. Footnote numbers set as plain digits against a Hebrew
 * word (עס3, מושכל15, וד"ל16) point at notes the data does not carry, so they go.
 * In the Yiddish glosses „ was typed for an alef (פ„ר = פאר, „ז = אז).
 */
export function hebrewSource(s: string): string {
  return hebrewMarks(
    s
      .replace(new RegExp(`(${HEB}['"]?)\\d{1,2}(?!\\d)`, 'g'), '$1')
      .replace(new RegExp(`„(?=${HEB})|(?<=${HEB})„`, 'g'), 'א'),
  );
}

/** A reversed bracket that is still left after {@link fixBrackets}. */
export const REVERSED_BRACKET = /\](?:<[^>]+>)*[A-Za-z]/;

/**
 * Square brackets the wrong way round in the translation: "]This contemplation
 * continues[ until ]he reaches[" and, with only the opener reversed, "]the verse],".
 * A bracket in normal text is never followed directly by a letter (or by a tag
 * and a letter: "]<i>Tvunah</i> is["), so such a "]" always opens.
 */
export function fixBrackets(html: string): string {
  return html
    .replace(/\](?=(?:<[^>]+>)*[A-Za-z])([^[\]]{1,200})\[/g, '[$1]')
    .replace(/\](?=(?:<[^>]+>)*[A-Za-z])([^[\]]{1,200})\](?!(?:<[^>]+>)*[A-Za-z])/g, '[$1]');
}

// ---------------------------------------------------------------- mixed English text

interface CharAtom {
  kind: 'char';
  /** The character as read (entities for quotes decoded). */
  ch: string;
  /** What to write back; replaced when a quote is converted. */
  out: string;
  /** Inside <code>/<pre>, or an entity other than a quote: never changed. */
  locked: boolean;
}

interface TagAtom {
  kind: 'tag';
  out: string;
  /** A block boundary: counts as a space and closes any open single quote. */
  block: boolean;
}

type Atom = CharAtom | TagAtom;

/** Tags that do not break the run of text: a quote can open before <em> and close after </em>. */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var']);
const QUOTE_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&#x22;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
};

function atomize(html: string): Atom[] {
  const atoms: Atom[] = [];
  let code = 0;
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>|<!--[\s\S]*?-->|&#?\w+;|[^<&]+|[<&]/g)) {
    const raw = m[0];
    if (raw.startsWith('<') && raw.length > 1) {
      const name = (m[1] ?? '').toLowerCase();
      if (name === 'code' || name === 'pre') code += raw.startsWith('</') ? -1 : 1;
      atoms.push({ kind: 'tag', out: raw, block: name !== '' && !INLINE_TAGS.has(name) });
    } else if (raw.startsWith('&') && raw.length > 1) {
      const quote = QUOTE_ENTITIES[raw.toLowerCase()];
      atoms.push({ kind: 'char', ch: quote ?? '&', out: raw, locked: code > 0 || quote === undefined });
    } else {
      for (const ch of raw) atoms.push({ kind: 'char', ch, out: ch, locked: code > 0 });
    }
  }
  return atoms;
}

/** The character next to atoms[i] in direction `step`, across inline tags; ' ' at a block edge. */
function neighbour(atoms: Atom[], i: number, step: 1 | -1): string {
  for (let j = i + step; j >= 0 && j < atoms.length; j += step) {
    const a = atoms[j];
    if (a === undefined) break;
    if (a.kind === 'char') return a.ch;
    if (a.block) return ' ';
  }
  return ' ';
}

/**
 * Whether a later ' in the same block could close the open quotation instead of
 * the one at atoms[i] ('ה' אחד': the first is a geresh). Stops at a ' that opens.
 */
function laterCloser(atoms: Atom[], i: number): boolean {
  for (let j = i + 1; j < atoms.length; j++) {
    const a = atoms[j];
    if (a === undefined || (a.kind === 'tag' && a.block)) break;
    if (a.kind !== 'char' || a.locked || a.ch !== "'") continue;
    const prev = neighbour(atoms, j, -1);
    if (opensAfter(prev)) return false;
    if (isHebrew(prev) && !isHebrew(neighbour(atoms, j, 1))) return true;
  }
  return false;
}

function convert(atoms: Atom[]): string {
  let singleOpen = false;
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a === undefined) continue;
    if (a.kind === 'tag') {
      if (a.block) singleOpen = false;
      continue;
    }
    if (a.locked || (a.ch !== '"' && a.ch !== "'")) continue;
    const prev = neighbour(atoms, i, -1);
    const next = neighbour(atoms, i, 1);
    if (a.ch === '"') {
      if (isHebrew(prev) && isHebrew(next)) a.out = GERSHAYIM;
      else a.out = opensAfter(prev) ? '“' : '”';
      continue;
    }
    // A single quote.
    const following = atoms[i + 1];
    if (isHebrew(prev) && following?.kind === 'char' && following.ch === "'" && !following.locked) {
      a.out = GERSHAYIM; // הנו''ן
      following.out = '';
      i++;
    } else if (isHebrew(prev)) {
      // Closes a quotation opened before the Hebrew ('עד דסלק'), else a geresh (כו').
      if (singleOpen && !isHebrew(next) && !laterCloser(atoms, i)) {
        a.out = '’';
        singleOpen = false;
      } else a.out = GERESH;
    } else if (isWordChar(prev) && isWordChar(next)) {
      a.out = '’'; // one's, sheb'bina, ma'amik
    } else if (opensAfter(prev) && next !== ' ' && !/^\d/.test(next)) {
      a.out = '‘';
      singleOpen = true;
    } else {
      a.out = '’'; // a closing quote, or a plural possessive (students')
      singleOpen = false;
    }
  }
  return atoms.map((a) => a.out).join('');
}

/** Smart quotes and Hebrew marks in rendered HTML. */
export function typographyHtml(html: string): string {
  return convert(atomize(html));
}

/** Smart quotes and Hebrew marks in plain text (a title or gloss Astro escapes itself). */
export function typographyText(text: string): string {
  return convert([...text].map((ch): Atom => ({ kind: 'char', ch, out: ch, locked: false })));
}

// ---------------------------------------------------------------- explanation helpers

/** A run of Hebrew words (with geresh, gershayim and maqaf) inside English text. */
const HEB_RUN = new RegExp(`${HEB}(?:[׳״\u05BE]|${HEB}|[ \u00A0](?=${HEB}))*`, 'g');

/**
 * Tag Hebrew quoted in English text (“HaShem-יהו״ה”, “עומק of חכמה”) as
 * <span class="he" lang="he">, so print can set it larger than the English
 * around it. Markup and attribute values are left alone.
 */
export function tagHebrew(html: string): string {
  return html.replace(/(<[^>]*>)|[^<]+/g, (text, tag: string | undefined) =>
    tag ?? text.replace(HEB_RUN, '<span class="he" lang="he">$&</span>'),
  );
}

/**
 * Keep a class reference with the word before it, so "(class 18, 22:26)" never
 * starts a line on its own. Spaces between two references stay breakable.
 */
export function bindListenLinks(html: string): string {
  return html.replace(/(<\/a>)?\s+(?=<a class="listen)/g, (all, close: string | undefined) => (close ? all : ' '));
}

/**
 * A paragraph that opens on a bold lemma quoted from mid-sentence ("**is what is
 * called delving**") starts with a lower-case letter, which reads as a mistake at
 * the head of a page. Lead such a lemma with an ellipsis, as quotations do.
 */
export function ellipsizeLemmata(html: string): string {
  return html.replace(/<p><strong>(?=(?:<em>|<i>)?\p{Ll})/gu, '<p><strong>…');
}
