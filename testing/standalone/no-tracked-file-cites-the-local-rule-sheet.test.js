/**
 * No tracked file cites `CLAUDE.md` as the home of a rule (`Q-653`).
 *
 * ## What it prevents
 *
 * `CLAUDE.md` is the owner's local rule sheet: untracked (Q-632, the repository is public) and read by one agent runtime only.
 * The project's working rules moved out of it into the y-flows graph, where every agent working a ticket meets them at the step
 * they apply to, whatever runtime it is. A comment or doc that says "the defect `CLAUDE.md` names" sends a reader to a file a
 * clone does not have and another agent never reads: the rule it leans on is invisible to exactly the readers it was written for.
 * A citation states the rule itself, or names the flow node or the tracked doc that holds it.
 *
 * Bought by the move of 2026-10-30: the sheet was cut to a pointer and 153 citations in 130 tracked files still named it.
 *
 * ## What is derived
 *
 * - **The files**: every tracked file (`git ls-files` through `trackedSources`, floored), whatever its extension, so a citation in a
 *   kind of file nobody listed is still seen. A file holding a NUL byte is binary and is not read.
 * - **The readers**: a file that calls `localRuleSheets(` reads the sheet where a checkout has one; naming it is its job, not a citation.
 *   Derived from the source, so a new reader needs no entry here.
 * - **The exceptions**: `ALLOWED` below, each with its reason and a review date; an entry past its date, or one that no longer
 *   matches a file, fails.
 *
 * Run: node --test testing/standalone/no-tracked-file-cites-the-local-rule-sheet.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

/** Files that may name the sheet, each with why and when to look again. */
const ALLOWED = [
  { file: '.gitignore', reason: 'ignores the sheet, which is how it stays untracked', review: '2027-04-30' },
  { prefix: 'changelog/', reason: 'release history: what was true when each version shipped', review: '2027-04-30' },
  { file: 'CHANGELOG.md', reason: 'release history: what was true when each version shipped', review: '2027-04-30' },
  { file: 'testing/_shared/local-rule-sheets.mjs', reason: 'the one module that names the sheets a checkout may hold', review: '2027-04-30' },
  { file: 'testing/standalone/no-tracked-file-cites-the-local-rule-sheet.test.js', reason: 'this gate names what it refuses', review: '2027-04-30' },
];

const SHEET = /CLAUDE\.md/;
const NUL = String.fromCharCode(0);
const allowedBy = (file) => ALLOWED.find(a => (a.file ? a.file === file : file.startsWith(a.prefix)));

let scanned;
/** The repository read once for all three cases. */
const scan = () => (scanned ??= scanOnce());

function scanOnce() {
  const files = trackedSources(['.'], { ext: null, floor: 2000 });
  const texts = files.map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') })).filter(({ text }) => !text.includes(NUL));
  const readers = new Set(texts.filter(({ text }) => text.includes('localRuleSheets(')).map(({ file }) => file));
  const citing = [];
  for (const { file, text } of texts) {
    if (allowedBy(file) || readers.has(file)) continue;
    text.split(/\r?\n/).forEach((line, i) => { if (SHEET.test(line)) citing.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`); });
  }
  return { files, texts, readers, citing };
}

describe('no tracked file cites the local rule sheet as the home of a rule', () => {
  it('every tracked text file is read, and the readers of the sheet are found', () => {
    const { texts, readers } = scan();
    assert.ok(texts.length >= 2000, `only ${texts.length} text files read`);
    assert.ok(readers.size >= 4, `only ${readers.size} reader(s) of the sheet found: ${[...readers].join(', ')}; the derivation is broken`);
  });

  it('no file outside the readers and the allowlist names the sheet', () => {
    const { citing } = scan();
    assert.deepEqual(citing, [],
      `${citing.length} line(s) cite CLAUDE.md, an untracked sheet one runtime reads. State the rule, or name the y-flows node or the tracked `
      + 'doc that holds it:\n' + citing.join('\n'));
  });

  it('every allowlist entry has a reason, a review date not past, and matches a tracked file', () => {
    const { files } = scan();
    const today = new Date().toISOString().slice(0, 10);
    const wrong = ALLOWED.filter(a => !a.reason || !/^\d{4}-\d{2}-\d{2}$/.test(a.review ?? '') || a.review < today
      || !files.some(f => (a.file ? f === a.file : f.startsWith(a.prefix))));
    assert.deepEqual(wrong, [], 'an exception without its reason, past its review date, or naming nothing tracked');
    console.log(`# exceptions: ${ALLOWED.length}`);
  });
});
