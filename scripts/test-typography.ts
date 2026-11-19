/**
 * Checks for src/lib/typography.ts (smart quotes, Hebrew geresh and gershayim,
 * bound class references, lemma ellipses).
 *
 *   npm run test:typography
 */
import {
  bindListenLinks,
  ellipsizeLemmata,
  fixBrackets,
  hebrewMarks,
  hebrewSource,
  tagHebrew,
  typographyHtml,
  typographyText,
} from '../src/lib/typography.ts';

const cases: [name: string, actual: string, expected: string][] = [
  // Hebrew marks in the source text.
  ['geresh', hebrewMarks("לפי סדר ה' מדריגות כו'."), 'לפי סדר ה׳ מדריגות כו׳.'],
  ['gershayim "', hebrewMarks('חב"ד כנ"ל'), 'חב״ד כנ״ל'],
  ["gershayim ''", hebrewMarks("הנו''ן דאבי''ע"), 'הנו״ן דאבי״ע'],
  ['pointed letter', hebrewMarks("הָ'"), 'הָ׳'],
  ['latin untouched', hebrewMarks("one's \"word\""), "one's \"word\""],

  // Repairs to the Hebrew source text.
  ['footnote digits', hebrewSource('ביז עס3 איז, מושכל15 וד"ל16: בכתבי\'12)'), 'ביז עס איז, מושכל וד״ל: בכתבי׳)'],
  ['yiddish alef', hebrewSource('ניט „ז דער „ליין פ„ר זיך'), 'ניט אז דער אליין פאר זיך'],
  ['digits kept apart', hebrewSource('פרק 3'), 'פרק 3'],

  // Reversed brackets in the translation.
  ['brackets', fixBrackets('etc. ]This continues[ until ]he reaches[ the [of x]'), 'etc. [This continues] until [he reaches] the [of x]'],
  ['bracket opener', fixBrackets('as in ]the verse],<sup>2</sup> and ]Now, <i>x</i>] that'), 'as in [the verse],<sup>2</sup> and [Now, <i>x</i>] that'],
  ['bracket before tag', fixBrackets('and <i>Tvunah.</i>” ]<i>Tvunah</i> is[ called'), 'and <i>Tvunah.</i>” [<i>Tvunah</i> is] called'],
  ['brackets kept', fixBrackets('The sign for [this] deep'), 'The sign for [this] deep'],

  // English quotes, as marked renders them (entities) and as typed.
  ['double pair', typographyHtml('<p>he said, &quot;That there is a G-d.&quot;</p>'), '<p>he said, “That there is a G-d.”</p>'],
  ['across em', typographyHtml('<p>why &quot;<em>chachma</em>&quot; means</p>'), '<p>why “<em>chachma</em>” means</p>'],
  ['apostrophes', typographyHtml('<p>one&#39;s <em>sheb&#39;bina</em> and <em>ma&#39;amik</em>, A&#39;s</p>'), '<p>one’s <em>sheb’bina</em> and <em>ma’amik</em>, A’s</p>'],
  ['single pair', typographyHtml("<p>the 'nothing of the something' is</p>"), '<p>the ‘nothing of the something’ is</p>'],
  ['plural possessive', typographyText("the students' books"), 'the students’ books'],
  ['decade', typographyText("in the '90s"), 'in the ’90s'],
  ['open after paren', typographyText('("quoted")'), '(“quoted”)'],

  // Hebrew inside English.
  ['quoted hebrew', typographyHtml('<p>&quot;עומק of חכמה&quot; is</p>'), '<p>“עומק of חכמה” is</p>'],
  ['single-quoted hebrew', typographyText("transcript's 'עד דסלק' is"), 'transcript’s ‘עד דסלק’ is'],
  ['geresh in english', typographyText("the words כו' here"), 'the words כו׳ here'],
  ['gershayim in english', typographyText('the חב"ד and הנו\'\'ן'), 'the חב״ד and הנו״ן'],
  ['geresh inside quote', typographyText("'ה' אחד' says"), '‘ה׳ אחד’ says'],

  // Left alone.
  ['attributes', typographyHtml('<a href="x" title="it&#39;s">go</a>'), '<a href="x" title="it&#39;s">go</a>'],
  ['code', typographyHtml("<p><code>a 'b' &quot;c&quot;</code> 'd'</p>"), "<p><code>a 'b' &quot;c&quot;</code> ‘d’</p>"],
  ['other entities', typographyHtml('<p>&amp;&quot;x&quot;</p>'), '<p>&amp;”x”</p>'],
  ['block resets', typographyHtml("<p>'open</p><p>A's</p>"), '<p>‘open</p><p>A’s</p>'],

  // Hebrew in English.
  ['tag hebrew', tagHebrew('<p>“<i>HaShem</i>-יהו״ה founded” and עומק המושג here</p>'), '<p>“<i>HaShem</i>-<span class="he" lang="he">יהו״ה</span> founded” and <span class="he" lang="he">עומק המושג</span> here</p>'],
  ['tag hebrew attrs', tagHebrew('<a title="כו׳">x</a>'), '<a title="כו׳">x</a>'],

  // Class references and lemmata.
  ['bind ref', bindListenLinks('innocent. <a class="listen" href="#">x</a>'), 'innocent. <a class="listen" href="#">x</a>'],
  ['two refs', bindListenLinks('a <a class="listen">1</a> <a class="listen">2</a>'), 'a <a class="listen">1</a> <a class="listen">2</a>'],
  ['lemma', ellipsizeLemmata('<p><strong>is what is called</strong>: x</p>'), '<p><strong>…is what is called</strong>: x</p>'],
  ['lemma em', ellipsizeLemmata('<p><strong><em>bina</em> is</strong></p>'), '<p><strong>…<em>bina</em> is</strong></p>'],
  ['capital lemma', ellipsizeLemmata('<p><strong>Now, it</strong></p>'), '<p><strong>Now, it</strong></p>'],
];

let failed = 0;
for (const [name, actual, expected] of cases) {
  if (actual === expected) continue;
  failed++;
  console.error(`FAIL ${name}\n  expected: ${expected}\n  actual:   ${actual}`);
}
console.log(`test-typography: ${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
