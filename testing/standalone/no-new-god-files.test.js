/**
 * No file grows past the largest we already have, measured in CODE lines.
 *
 * ## Why not raw lines
 *
 * This codebase comments heavily and deliberately. Ranked by raw line count, its two best-documented modules
 * come second and fourth — `config/types.ts` at 1,986 lines is **62% comment**, `brain/recall.ts` at 1,299 is
 * **36%**. A gate built on raw lines would call those the worst files in the repo and the remedy it invited
 * would be deleting the explanations. That is the opposite of what this project wants, and a gate whose fix
 * makes the code worse is one people are right to ignore.
 *
 * Stripping comments and blanks changes the ranking, which is the measurement worth having: `types.ts` falls
 * from 2nd to 11th, `recall.ts` from 4th to 9th, and what rises is a handful of Angular components carrying
 * 6–12% comments and over a thousand lines of code each.
 *
 * ## Why a ratchet rather than a refactor
 *
 * "This component is large" is not a defect. It works, it is covered, and splitting it is a change with real
 * regression risk that nobody asked for. What IS worth guaranteeing is that it stops growing — the failure
 * mode of a god-file is not its size on any given day, it is that every change lands in the same place
 * because that is where the code already is.
 *
 * So: the files already over the line are frozen at their current size, everything else has a ceiling, and
 * both numbers are visible. Reducing one is welcome and only requires lowering its entry.
 *
 * Run: node --test testing/standalone/no-new-god-files.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, CEILING, FROZEN, sourceFiles, codeLines, oversizeFiles } from './_oversize-files.mjs';

describe('no file grows past what we already carry', () => {
  const files = sourceFiles();
  const sized = files.map(f => ({ f: f.replaceAll('\\', '/'), code: codeLines(readFileSync(join(ROOT, f), 'utf8')) }));

  it('walked a real tree', () => {
    // Floors the enumeration — an empty walk would make every check below pass over nothing.
    assert.ok(files.length >= 200, `only found ${files.length} source files`);
    assert.ok(sized.some(s => s.code > 500), 'no large file found at all — the counter is probably broken');
  });

  it('a file over its limit is REPORTED for decomposition, never failed', () => {
    // Owner, 2026-09-28: "It should not block current work. It should flag the file for decomposition, which is a
    // workitem." Until then this failed the build, and the way out was a raise with a paragraph excusing it. Now
    // the list is printed here, and the project's ticket check (`{project.oversize-report}`) fails until each
    // file has an open Work-Item with `decomposes: <path>` — the growth ships, and it becomes queued work.
    const over = oversizeFiles(sized.map(s => ({ file: s.f, code: s.code })));
    if (over.length > 0) {
      console.log('  decompose — over their limit (file a Work-Item with decomposes: <path> for each):\n    '
        + over.map(o => `${o.file}: ${o.code} code lines, limit ${o.limit}`).join('\n    '));
    }
    // The report is only worth having if it measures the limits it names: a file planted over CEILING is found.
    assert.equal(oversizeFiles([{ file: 'x/planted.ts', code: CEILING + 1 }]).length, 1,
      'a file over the ceiling was not reported — the measurement is blind');
    const frozen = Object.entries(FROZEN)[0];
    assert.equal(oversizeFiles([{ file: frozen[0], code: frozen[1] }]).length, 0,
      'a frozen file at its frozen size was reported — the limit is read wrong');
    assert.equal(oversizeFiles([{ file: frozen[0], code: frozen[1] + 1 }]).length, 1,
      'a frozen file that grew was not reported');
  });

  it('reports frozen entries that have shrunk, so the list cannot drift upward silently', () => {
    // A frozen number that is far above reality stops being a ratchet and becomes headroom.
    const slack = [];
    for (const [f, max] of Object.entries(FROZEN)) {
      const found = sized.find(s => s.f === f);
      if (found && found.code < max - 50) slack.push(`${f}: now ${found.code}, frozen at ${max}`);
    }
    if (slack.length > 0) console.log(`  note: lower these entries —\n    ${slack.join('\n    ')}`);
    // Not an assertion: shrinking a file should never fail a build. It is reported so the list stays honest.
    assert.ok(true);
  });

  it('the measurement ignores comments — or it would punish the documented files', () => {
    // The property that makes this gate safe to have. `config/types.ts` is 1,986 raw lines and 62% comment;
    // if this counted raw lines it would be the second-largest file in the repo and the fix would be
    // deleting the documentation that makes it usable.
    const types = sized.find(s => s.f === 'server/src/config/types.ts');
    assert.ok(types, 'config/types.ts not found — update this test');
    const raw = readFileSync(join(ROOT, 'server/src/config/types.ts'), 'utf8').split('\n').length;
    assert.ok(types.code < raw * 0.5,
      `expected config/types.ts to be mostly comment (${types.code} code of ${raw} lines); if that is no longer `
      + 'true this assertion is measuring the wrong thing and should be re-aimed at whatever is');
  });
});

describe('a raise owes a decomposition task', () => {
  /*
   * Owner's rule, 2026-08-30: *"raising is okay but raising means you also have to queue a task to decompose
   * and modularize."*
   *
   * The ratchet already made growth visible; it did not make anybody answer for it. A raise with a good
   * reason and no follow-up is how a file reaches 1 618 lines one defensible increment at a time — every step
   * justified, the total justified by nobody.
   *
   * `server/src/api/spaces.ts` is the shape this asks for and the proof it is affordable: raised four times,
   * then PAID from 851 to 656 by moving two route bodies into `spaces-reembed.ts` and `spaces-activity.ts`,
   * leaving only their mount points. The discipline existed; it was optional.
   *
   * ## The marker, and why a reason is allowed
   *
   * Every `RAISED a -> b` must be answered in its own comment block by one of:
   *
   *   - `DECOMPOSE: <ID>` — a queued task. `todo:check` verifies that id is actually open in the ordered
   *     queue; this gate cannot, because `todo/` is gitignored and absent in CI.
   *   - `NO DECOMPOSITION: <reason>` — for a file where splitting is not the answer. A type file grows with
   *     the domain and a `.strict()` schema grows with its own contract; demanding a refactor task there
   *     would be make-work, and make-work in a queue is what stops a queue being read.
   *   - `DECOMPOSED: <what left>` — the raise is PAID: the split happened and the frozen number is back at or
   *     below where the file stood before the raise. This is the state the first two could not express, and
   *     writing `NO DECOMPOSITION` here instead would record the opposite of what happened.
   *
   * **The third one is CHECKED, which the other two cannot be.** `DECOMPOSED` names a number, so the gate
   * verifies it against the frozen size rather than believing the word — claimed while the file is still
   * above its pre-raise size, it is a raise wearing the marker that retires raises, and that is the one way
   * this convention could be used to launder a permanent increase.
   *
   * The reason costs something: it lands in a diff a person reads, next to the number it excuses.
   */
  // The limits and their raise history live in the measurement module since the size stopped blocking a build.
  const SRC = readFileSync('testing/standalone/_oversize-files.mjs', 'utf8');

  it('every raise is answered by a task or a reason', () => {
    const lines = SRC.split(/\r?\n/);
    const unanswered = [];
    let block = [];
    for (const line of lines) {
      if (/^\s*\/\//.test(line)) { block.push(line); continue; }
      const entry = /^\s*'([^']+)':\s*(\d+),/.exec(line);
      if (entry) {
        const text = block.join('\n');
        const raises = [...text.matchAll(/RAISED\s+(\d+)\s*->\s*\d+/g)].map((m) => Number(m[1]));
        const paid = /DECOMPOSED:\s*\S/.test(text);
        if (raises.length > 0 && !paid && !/DECOMPOSE:\s*\S|NO DECOMPOSITION:\s*\S/.test(text)) {
          unanswered.push(`${entry[1]} — ${raises.length} raise(s), no DECOMPOSE, DECOMPOSED or NO DECOMPOSITION marker`);
        }
        // A paid raise is the only marker with a number behind it, so it is the only one that can be false.
        if (paid && raises.length > 0) {
          const before = Math.min(...raises);
          if (Number(entry[2]) > before) {
            unanswered.push(`${entry[1]} — DECOMPOSED claimed, but it is frozen at ${entry[2]}, above the `
              + `${before} it stood at before the raise. The split did not pay the raise back.`);
          }
        }
      }
      block = [];
    }
    assert.deepEqual(unanswered, [],
      'these files were raised and nothing was queued to shrink them. A raise with a good reason and no '
      + 'follow-up is how a file reaches four figures one defensible increment at a time:\n  '
      + unanswered.join('\n  '));
  });

  it('the check can see the raises at all', () => {
    // Without this the parser could silently match nothing and report every file as answered — the vacuity
    // every coverage gate in this repo has had at least once.
    assert.ok((SRC.match(/RAISED\s+\d+\s*->\s*\d+/g) ?? []).length >= 5,
      'no raises found — the comment convention changed and this gate is measuring nothing');
  });
});
