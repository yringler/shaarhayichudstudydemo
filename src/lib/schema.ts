/**
 * The data contract (spec §3): Zod schemas for everything `scripts/vendor.ts`
 * writes under `data/`, with TypeScript types inferred from them. The vendor
 * script, the content validator and the site all import from here.
 *
 * Owned by Agent A. Change it only together with `scripts/vendor.ts`.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- shared

/** A time-stamped sentence of a class transcript; `t` = start second. */
export const SentenceSchema = z.object({
  t: z.number(),
  text: z.string(),
});
export type Sentence = z.infer<typeof SentenceSchema>;

// ---------------------------------------------------------------- data/sources.json

export const OutlineTopicSchema = z.object({
  title: z.string(),
  startSeconds: z.number(),
});
export type OutlineTopic = z.infer<typeof OutlineTopicSchema>;

export const SourceSchema = z.object({
  /** Leading digits of the lecture id: "021". */
  key: z.string(),
  /** Catalog lecture id: "021 Tape004-Side1-Ch3.mp3". */
  lectureId: z.string(),
  teacher: z.literal('Rabbi Markel'),
  /** "Rabbi Markel Series (Advanced)". */
  series: z.string(),
  /** "Chapter 3" / "Chapter 1, part 2" (heading + position). */
  title: z.string(),
  /** Catalog URL of the (edited) mp3, already encoded. */
  audioUrl: z.string(),
  durationSeconds: z.number(),
  chapters: z.array(z.number().int()),
  times: z.enum(['retimed', 'sofer']),
  /** From data/outlines, G-d spelling applied. */
  outline: z.array(OutlineTopicSchema),
});
export type Source = z.infer<typeof SourceSchema>;

export const SourcesFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Git sha of the shaar-hayichud-sections checkout. */
  sectionsCommit: z.string(),
  sources: z.array(SourceSchema),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

// ---------------------------------------------------------------- data/chapters/chapter_NN.json

/** One (source, line) alignment segment. */
export const CoverageSchema = z.object({
  /** Source.key */
  source: z.string(),
  lineId: z.string(),
  /** Reading of the line starts. */
  startSeconds: z.number(),
  /** Discussion ends = next aligned line's start in that source (or tape end). */
  endSeconds: z.number(),
  /** Raw alignment confidence; no floor applied, UI may flag < 0.45. */
  confidence: z.number(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const SegmentLineSchema = z.object({
  id: z.string(),
  text: z.string(),
  notInSefaria: z.literal(true).optional(),
});
export type SegmentLine = z.infer<typeof SegmentLineSchema>;

export const FootnoteSchema = z.object({
  n: z.number().int(),
  html: z.string(),
});
export type Footnote = z.infer<typeof FootnoteSchema>;

export const SegmentSchema = z.object({
  /** Sefaria paragraph number, 1-based. */
  n: z.number().int().positive(),
  /** Repo lines, in order. */
  lines: z.array(SegmentLineSchema),
  /** Sanitized HTML: only <i>, <b>, <sup data-fn="n">. */
  en: z.string(),
  footnotes: z.array(FootnoteSchema),
  /** Empty = no recording. */
  coverage: z.array(CoverageSchema),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const ChapterSectionSchema = z.object({
  label: z.string(),
  fromSegment: z.number().int(),
  toSegment: z.number().int(),
});
export type ChapterSection = z.infer<typeof ChapterSectionSchema>;

export const TranslationInfoSchema = z.object({
  versionTitle: z.string(),
  license: z.string(),
  source: z.string(),
});
export type TranslationInfo = z.infer<typeof TranslationInfoSchema>;

export const ChapterFileSchema = z.object({
  schemaVersion: z.literal(1),
  chapter: z.number().int(),
  /** From Sefaria heRef. */
  heRef: z.string(),
  /** https://www.sefaria.org/The_Gate_of_Unity.3?lang=bi */
  sefariaUrl: z.string(),
  translation: TranslationInfoSchema,
  /** Repo's Hebrew section labels. */
  sections: z.array(ChapterSectionSchema),
  segments: z.array(SegmentSchema),
});
export type ChapterFile = z.infer<typeof ChapterFileSchema>;

// ---------------------------------------------------------------- data/transcripts/chapter_NN.json

export const PreambleSchema = z.object({
  source: z.string(),
  sentences: z.array(SentenceSchema),
});
export type Preamble = z.infer<typeof PreambleSchema>;

export const TranscriptSpanSchema = z.object({
  source: z.string(),
  lineId: z.string(),
  segment: z.number().int(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  confidence: z.number(),
  sentences: z.array(SentenceSchema),
});
export type TranscriptSpan = z.infer<typeof TranscriptSpanSchema>;

export const TranscriptFileSchema = z.object({
  schemaVersion: z.literal(1),
  chapter: z.number().int(),
  /** Words before a tape's first aligned line. */
  preambles: z.array(PreambleSchema),
  /** Ordered by source, then time. */
  spans: z.array(TranscriptSpanSchema),
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;
