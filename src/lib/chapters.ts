/**
 * The chapters in this booklet: the one list that `scripts/vendor.ts`,
 * `scripts/validate-content.ts` and the site (`src/lib/content.ts`) share.
 * Not necessarily consecutive; files are named `chapter_NN` (two digits).
 */
export const CHAPTERS = [1, 2, 3, 4, 5, 10] as const;

/**
 * The content views of the print book (/book/?view=…). `hebrew` is the explanation
 * edition with the whole Hebrew text of each passage in place of its opening words
 * (book only; the site's view switch has the other three).
 */
export const BOOK_VIEWS = ['guide', 'explanation', 'hebrew', 'text'] as const;
export type BookView = (typeof BOOK_VIEWS)[number];

/**
 * File names of the print-ready PDFs (7 x 10 in, KDP), one per view. `npm run pdf`
 * writes them to `pdf/`; the deploy workflow builds the guide, the explanation and
 * the Hebrew-and-explanation PDFs and copies them to the site root, where /booklet/ and the cover link to
 * them. The guide's name is the original one and stays as it is (links to it exist).
 */
export const BOOK_PDFS: Readonly<Record<BookView, string>> = {
  guide: 'shaar-hayichud-booklet-1-7x10.pdf',
  explanation: 'shaar-hayichud-booklet-1-explanation-7x10.pdf',
  hebrew: 'shaar-hayichud-booklet-1-hebrew-explanation-7x10.pdf',
  text: 'shaar-hayichud-booklet-1-text-7x10.pdf',
};

/**
 * The page sizes the book is printed at: `7x10` is the KDP paperback; `letter`
 * (8.5 x 11 in) is for printing at home, the same pages scaled up 1.13x with
 * even margins and no blank pages (scripts/build-pdf.ts, book.astro `?trim=letter`).
 */
export const BOOK_TRIMS = ['7x10', 'letter'] as const;
export type BookTrim = (typeof BOOK_TRIMS)[number];

/** File names of the Letter-size PDFs, one per view. */
export const BOOK_PDFS_LETTER: Readonly<Record<BookView, string>> = {
  guide: 'shaar-hayichud-booklet-1-letter.pdf',
  explanation: 'shaar-hayichud-booklet-1-explanation-letter.pdf',
  hebrew: 'shaar-hayichud-booklet-1-hebrew-explanation-letter.pdf',
  text: 'shaar-hayichud-booklet-1-text-letter.pdf',
};

/** The PDF file name of a view at a page size. */
export function bookPdf(view: BookView, trim: BookTrim = '7x10'): string {
  return trim === 'letter' ? BOOK_PDFS_LETTER[view] : BOOK_PDFS[view];
}

/** The full study guide PDF (Hebrew, translation and explanations). */
export const BOOK_PDF = BOOK_PDFS.guide;
/** The explanation-only PDF. */
export const BOOK_PDF_EXPLANATION = BOOK_PDFS.explanation;
/** The explanations with the whole Hebrew text (no translation). */
export const BOOK_PDF_HEBREW = BOOK_PDFS.hebrew;

/** The editions published as EPUB (reflowable, single column; scripts/build-epub.ts). */
export const EPUB_VIEWS = ['guide', 'explanation', 'hebrew'] as const;
export type EpubView = (typeof EPUB_VIEWS)[number];

/**
 * File names of the EPUBs, one per published edition. `npm run epub` writes them
 * to `pdf/` beside the PDFs, and the deploy workflow copies them to the site root.
 */
export const BOOK_EPUBS: Readonly<Record<EpubView, string>> = {
  guide: 'shaar-hayichud-booklet-1.epub',
  explanation: 'shaar-hayichud-booklet-1-explanation.epub',
  hebrew: 'shaar-hayichud-booklet-1-hebrew-explanation.epub',
};

export type ChapterNumber = (typeof CHAPTERS)[number];

/** [1, 2, 3, 4, 5, 10] → "1–5 and 10"; [3] → "3". Consecutive runs become ranges. */
export function chaptersLabel(chapters: readonly number[] = CHAPTERS): string {
  const sorted = [...chapters].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  const close = (): void => {
    if (start === undefined || prev === undefined) return;
    runs.push(start === prev ? String(start) : `${start}–${prev}`);
  };
  for (const n of sorted) {
    if (prev !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    close();
    start = n;
    prev = n;
  }
  close();
  if (runs.length <= 1) return runs[0] ?? '';
  return `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}`;
}

/** "Chapters 1–5 and 10" (or "Chapter 3" for one). */
export function chaptersTitle(chapters: readonly number[] = CHAPTERS): string {
  return `${chapters.length === 1 ? 'Chapter' : 'Chapters'} ${chaptersLabel(chapters)}`;
}
