/**
 * The chapters in this booklet: the one list that `scripts/vendor.ts`,
 * `scripts/validate-content.ts` and the site (`src/lib/content.ts`) share.
 * Not necessarily consecutive; files are named `chapter_NN` (two digits).
 */
export const CHAPTERS = [1, 2, 3, 4, 5, 10] as const;

/**
 * File name of the print-ready PDF (7 x 10 in, KDP). `npm run pdf` writes it to
 * `pdf/`; the deploy workflow copies it to the site root, where /booklet/ and the
 * cover link to it.
 */
export const BOOK_PDF = 'shaar-hayichud-booklet-1-7x10.pdf';

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
