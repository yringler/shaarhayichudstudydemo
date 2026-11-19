/**
 * The chapters in this booklet: the one list that `scripts/vendor.ts`,
 * `scripts/validate-content.ts` and the site (`src/lib/content.ts`) share.
 * Not necessarily consecutive; files are named `chapter_NN` (two digits).
 */
export const CHAPTERS = [1, 2, 3, 4, 5, 10] as const;

/** The content views of the print book (/book/?view=…), as in /booklet/'s view switch. */
export const BOOK_VIEWS = ['guide', 'explanation', 'text'] as const;
export type BookView = (typeof BOOK_VIEWS)[number];

/**
 * File names of the print-ready PDFs (7 x 10 in, KDP), one per view. `npm run pdf`
 * writes them to `pdf/`; the deploy workflow builds the guide and the explanation
 * PDFs and copies them to the site root, where /booklet/ and the cover link to
 * them. The guide's name is the original one and stays as it is (links to it exist).
 */
export const BOOK_PDFS: Readonly<Record<BookView, string>> = {
  guide: 'shaar-hayichud-booklet-1-7x10.pdf',
  explanation: 'shaar-hayichud-booklet-1-explanation-7x10.pdf',
  text: 'shaar-hayichud-booklet-1-text-7x10.pdf',
};

/** The full study guide PDF (Hebrew, translation and explanations). */
export const BOOK_PDF = BOOK_PDFS.guide;
/** The explanation-only PDF. */
export const BOOK_PDF_EXPLANATION = BOOK_PDFS.explanation;

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
