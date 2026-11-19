/**
 * Prints one chapter's vendored data as plain text, for the people (and agents)
 * writing content/chapter_NN/: each Sefaria segment with its Hebrew lines,
 * English and footnotes, followed by the transcript spans of its lines, and
 * each tape's preamble first.
 *
 *   npm run dump -- 3            # whole chapter
 *   npm run dump -- 3 5 9        # segments §5–§9 only
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ChapterFileSchema, SourcesFileSchema, TranscriptFileSchema, type Sentence } from '../src/lib/schema.ts';

const ROOT = resolve(import.meta.dirname, '..');
const [chapterArg, fromArg, toArg] = process.argv.slice(2);
const chapter = Number(chapterArg);
if (!Number.isInteger(chapter) || chapter < 1) {
  console.error('usage: npm run dump -- <chapter> [fromSegment] [toSegment]');
  process.exit(1);
}
const nn = String(chapter).padStart(2, '0');
const read = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8')) as unknown;
const ch = ChapterFileSchema.parse(read(`chapters/chapter_${nn}.json`));
const tr = TranscriptFileSchema.parse(read(`transcripts/chapter_${nn}.json`));
const sources = SourcesFileSchema.parse(read('sources.json')).sources;
const from = fromArg !== undefined ? Number(fromArg) : 1;
const to = toArg !== undefined ? Number(toArg) : fromArg !== undefined ? from : ch.segments.length;

const clock = (s: number): string => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const plain = (html: string): string => html.replace(/<sup data-fn="(\d+)">\d+<\/sup>/g, '[fn$1]').replace(/<\/?i>/g, '*').replace(/<\/?b>/g, '**');
const sentences = (ss: Sentence[]): string => ss.map((s) => `  [${Math.round(s.t)}s ${clock(s.t)}] ${s.text}`).join('\n');

console.log(`# Chapter ${chapter} (${ch.heRef}), ${ch.segments.length} segments`);
console.log(`Sections: ${ch.sections.map((s) => `${s.label} §${s.fromSegment}–${s.toSegment}`).join('; ')}`);
for (const s of sources.filter((x) => x.chapters.includes(chapter))) {
  console.log(`Source ${s.key}: ${s.title}, ${clock(s.durationSeconds)} (${Math.round(s.durationSeconds)}s), times ${s.times}`);
}
if (from === 1) {
  for (const p of tr.preambles) console.log(`\n## Preamble of ${p.source}\n${sentences(p.sentences)}`);
}
for (const seg of ch.segments.filter((s) => s.n >= from && s.n <= to)) {
  console.log(`\n## §${seg.n}${seg.coverage.length === 0 ? '  (NO RECORDING)' : ''}`);
  for (const l of seg.lines) console.log(`HE ${l.id}${l.notInSefaria ? ' (not in Sefaria)' : ''}: ${l.text}`);
  console.log(`EN: ${plain(seg.en)}`);
  for (const f of seg.footnotes) console.log(`  fn${f.n}: ${plain(f.html)}`);
  for (const span of tr.spans.filter((x) => x.segment === seg.n)) {
    console.log(`\n### Transcript ${span.source}, line ${span.lineId}, ${clock(span.startSeconds)}–${clock(span.endSeconds)}, confidence ${span.confidence}`);
    console.log(sentences(span.sentences));
  }
}
