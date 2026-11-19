/**
 * Lists every reviewNotes entry in content/, per chapter and concept, with each
 * concept's status, so a reviewer can work through the open questions.
 *
 *   npm run review-notes             # all chapters
 *   npm run review-notes -- 3        # chapter 3 only
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const CONTENT = join(resolve(import.meta.dirname, '..'), 'content');
const only = process.argv.slice(2).map(Number);

interface Frontmatter { title?: unknown; segments?: unknown; status?: unknown; reviewNotes?: unknown }

let total = 0;
for (const dir of readdirSync(CONTENT).filter((d) => /^chapter_\d{2}$/.test(d)).sort()) {
  const chapter = Number(dir.slice(-2));
  if (only.length > 0 && !only.includes(chapter)) continue;
  const lines: string[] = [];
  const statuses = new Map<string, number>();
  for (const file of readdirSync(join(CONTENT, dir)).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort()) {
    const path = join(CONTENT, dir, file);
    if (!existsSync(path)) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, 'utf8'));
    const fm = (m ? parseYaml(m[1]!) : {}) as Frontmatter;
    const status = typeof fm.status === 'string' ? fm.status : '?';
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    const notes = Array.isArray(fm.reviewNotes) ? fm.reviewNotes.map(String) : [];
    if (notes.length === 0) continue;
    const range = Array.isArray(fm.segments) ? `§${fm.segments.join('–')}` : '';
    lines.push(`\n  ${dir}/${file}  (${range}, ${status})  ${String(fm.title ?? '')}`);
    for (const n of notes) lines.push(`    - ${n}`);
    total += notes.length;
  }
  const summary = [...statuses].map(([s, n]) => `${n} ${s}`).join(', ');
  console.log(`\nChapter ${chapter}: ${lines.filter((l) => l.startsWith('    - ')).length} review notes; concepts: ${summary || 'none'}`);
  for (const l of lines) console.log(l);
}
console.log(`\n${total} review notes in all.`);
