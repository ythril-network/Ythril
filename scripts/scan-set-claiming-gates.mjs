/**
 * A DIAGNOSTIC, not a gate: find test cases whose TITLE claims a whole set while their BODY loops over an
 * inline array literal.
 *
 * ## Why it is not a gate, and must not become one without a lot more work
 *
 * It cannot tell the defect from the legitimate case, and the legitimate case is the majority. A loop over
 * enumerated VALUES — cron shorthands, malformed env values, the four `freq` words — is not this defect and
 * never will be. The defect is an array that COPIES a set the source defines: record types, collections,
 * schemas, routers, tool names. Nothing here can distinguish those without knowing what the array means.
 *
 * Wired as a gate it would be ~100 failures on a clean tree, and `CLAUDE.md` already says what happens next:
 * noise is how a check gets deleted. So this prints suspicions for a person to read.
 *
 * ## What it is for
 *
 * `Q-5` found this class four times in one audit and `CLAUDE.md` gained a section for it. Turning that rule
 * into a search rather than waiting to trip over the next instance is what found the two `Q-6` starts from —
 * and one of those had been wrong since long before the audit's scope began.
 *
 * The shape to look for in the output: does the array enumerate something the CODE also enumerates? If yes,
 * the two will disagree eventually and the title is what makes the disagreement invisible.
 *
 * ## The marker, which is what makes this list DRAIN
 *
 * A suspicion that has been read and judged legitimate carries a marker in the case body:
 *
 *     // set-claim: <why this array is VALUES and not a copy of a set the source defines>
 *
 * and stops being reported. Without it the output is a fixed ~90 lines that nobody can act on, so the
 * reading gets done twice or not at all — and a re-read costs exactly as much as the first read.
 *
 * **It is a marker AT THE SITE, deliberately not a list in this file.** An allowlist here would be the
 * defect this whole sweep is about, one level up: a second copy of a judgement, sitting away from the code
 * it judges, going stale the day the case is rewritten. A marker moves with the case, and a case rewritten
 * into the real defect keeps a comment that no longer describes it — which the next reader sees.
 *
 * The reason is required and has to be a sentence, because *"checked, fine"* is what an exemption says when
 * nobody checked. `CLAUDE.md`: a reason that defers is not a reason.
 *
 * Run: node scripts/scan-set-claiming-gates.mjs
 */
import { readFileSync } from 'node:fs';
import { trackedTestFiles } from '../testing/standalone/_sources.mjs';

// The tracked listing rather than a directory walk: a gitignored file is not part of this repo's suite, and
// reading one would report a suspicion nobody can act on. Its floor is inside, so a broken listing throws.
const files = trackedTestFiles({ dirs: ['testing'], floor: 500 });

/** Words that make a title a claim about a whole set rather than about one case. */
const CLAIMS = /\b(every|all|each|no|nothing|never|any)\b/i;

/** `for (const x of ['a', …])` — the loop that makes the body narrower than the title. */
const LITERAL_LOOP = /for\s*\(\s*const\s*(?:\[[^\]]*\]|\w+)\s+of\s*\[\s*['"`]/;

/** The marker a READ suspicion carries, with the reason that says why it is not the defect. */
const MARKER = /\/\/\s*set-claim:\s*(.+)/;

/** A reason short enough to be a shrug is not a reason. Long enough to have said something specific. */
const MIN_REASON = 30;

const hits = [];
const read = [];
const thin = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = /^\s*it\(\s*['"`](.+?)['"`]/.exec(line);
    if (!m || !CLAIMS.test(m[1])) return;
    // The case body, to the next `it(`/`describe(` or a 90-line cap — long enough for the docblocks this
    // repo writes, short enough not to swallow the following case.
    let end = i + 1;
    while (end < lines.length && end < i + 90 && !/^\s{2,4}(it|describe)\(/.test(lines[end])) end++;
    const body = lines.slice(i, end).join('\n');
    const loop = LITERAL_LOOP.exec(body);
    if (!loop) return;

    const where = `${file}:${i + 1}`;
    const marked = MARKER.exec(body);
    if (marked) {
      if (marked[1].trim().length >= MIN_REASON) { read.push(where); return; }
      thin.push(`${where}\n    REASON: ${marked[1].trim()}`);
      return;
    }
    hits.push(`${where}\n    TITLE: ${m[1]}\n    LOOP : ${body.slice(loop.index).split('\n')[0].trim()}`);
  });
}

console.log(hits.join('\n\n') || 'no unread suspicions');

if (thin.length > 0) {
  console.log(`\n${thin.length} marker(s) whose reason is too short to be one — say what the array IS:`);
  console.log(thin.join('\n\n'));
}

console.log(`\n${hits.length} UNREAD suspicion(s), ${read.length} read and marked, over ${files.length} test files.`);
console.log('Read each: an array of VALUES is fine, an array copying a set the source defines is not.');
console.log('Judged legitimate? Put `// set-claim: <why>` in the case body and it stops being reported.');
