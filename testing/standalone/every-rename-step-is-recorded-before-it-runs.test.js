/**
 * Every step of a space rename is put in the ledger BEFORE the call that moves, so a refused rename moves back what the step did even when
 * the step stopped half-way (Q-978).
 *
 * ## What it prevents
 *
 * The ledger (`spaces/rename-ledger.ts`) is what a refused rename undoes. A step recorded AFTER its call is not in it when the call wrote and
 * then threw (a collection moved whose answer was lost, a counter copied whose delete failed): that document stood under both names with the
 * marker cleared and the answer "whole". The review of the first fix found it for six of the eleven steps, and the spec seeded five steps
 * it never read back. A step added later is in or out of the ledger by the line that adds it, and nothing said so.
 *
 * ## What it holds
 *
 * In `moveSpaceData` (`spaces/rename.ts`), read as source with its comments blanked:
 *
 *  - every call that moves something (`.rename(`, `rename*(`, `move*(`, `repair*(`) is immediately preceded, in the order of the source, by a
 *    `ledger.did(` of its own, and every `ledger.did(` is followed by its call before the next one: a step is never recorded without being
 *    run, and never run without being recorded first;
 *  - the scan finds the steps at all (a floor), and it fails on a copy of the function whose call comes first (a positive control).
 *
 * ## Seen red
 *
 * At 89df72c5c the collection rename is followed by its `ledger.did(`, and so is every other step: the first case fails naming the
 * call (`.rename(` at the first collection step), and the positive control fails on a copy with the order swapped.
 *
 * Run: node --test testing/standalone/every-rename-step-is-recorded-before-it-runs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const FILE = 'server/src/spaces/rename.ts';
const FLOOR = 10;
const CALL = /\.rename\(|\b(?:rename|move|repair)[A-Z]\w*\(/g;

/** The body of `moveSpaceData`, comments blanked, lines ended as `\n`. */
function bodyOf(source) {
  const text = blankComments(source).replace(/\r\n/g, '\n');
  const header = text.indexOf('export async function moveSpaceData(');
  assert.ok(header >= 0, `${FILE} has no moveSpaceData`);
  // The body starts after the signature, which names `moveSpaceData` and a default `new RenameLedger()`.
  const open = text.indexOf('): Promise<string[]> {', header);
  assert.ok(open > header, 'the signature of moveSpaceData was not found');
  const start = open + '): Promise<string[]> {'.length;
  const end = text.indexOf('\n}\n', start);
  assert.ok(end > start, 'the end of moveSpaceData was not found');
  return text.slice(start, end);
}

/** The text with every `ledger.did(...)` replaced by spaces, and the start of each one. */
function maskLedgerCalls(body) {
  const dids = [];
  let masked = body;
  for (let at = body.indexOf('ledger.did('); at >= 0; at = body.indexOf('ledger.did(', at + 1)) {
    let depth = 0;
    let i = at + 'ledger.did'.length;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) break;
    }
    dids.push(at);
    masked = masked.slice(0, at) + ' '.repeat(i + 1 - at) + masked.slice(i + 1);
  }
  return { masked, dids };
}

/** What is wrong with the order of the steps in `body`, as sentences; empty when every call follows its own `ledger.did(`. */
export function orderProblems(body) {
  const { masked, dids } = maskLedgerCalls(body);
  const events = [...dids.map(at => ({ at, kind: 'did' })), ...[...masked.matchAll(CALL)].map(m => ({ at: m.index, kind: 'call', name: m[0] }))]
    .sort((a, b) => a.at - b.at);
  const problems = [];
  let previous = 'start';
  for (const e of events) {
    if (e.kind === 'call' && previous !== 'did') problems.push(`the call ${e.name} (line ${body.slice(0, e.at).split('\n').length} of moveSpaceData) is not preceded by its ledger.did`);
    if (e.kind === 'did' && previous === 'did') problems.push(`the ledger.did at line ${body.slice(0, e.at).split('\n').length} of moveSpaceData is followed by another ledger.did, not by its call`);
    previous = e.kind;
  }
  if (previous === 'did') problems.push('the last ledger.did of moveSpaceData is followed by no call');
  return { problems, steps: events.filter(e => e.kind === 'call').length };
}

describe('every rename step is recorded before it runs', () => {
  it('each call that moves something in moveSpaceData follows its own ledger.did', () => {
    const { problems, steps } = orderProblems(bodyOf(readFileSync(join(REPO_ROOT, FILE), 'utf8')));
    assert.ok(steps >= FLOOR, `the scan found ${steps} steps in moveSpaceData, below the floor ${FLOOR}: it reads the wrong text`);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('the scan fails on a step whose call comes before its ledger.did, and on a ledger.did with no call', () => {
    const wrong = [
      '  await moveCounterDoc(a, b);',
      '  ledger.did(`counter`, async () => { await moveCounterDoc(b, a); });',
    ].join('\n');
    const { problems } = orderProblems(wrong);
    assert.ok(problems.some(p => /moveCounterDoc.*not preceded/.test(p)), `a call before its ledger.did was not found: ${JSON.stringify(problems)}`);
    const unused = '  ledger.did(`x`, async () => {});\n  ledger.did(`y`, async () => {});\n  await moveCounterDoc(a, b);\n';
    assert.ok(orderProblems(unused).problems.some(p => /followed by another ledger.did/.test(p)), 'a ledger.did with no call was not found');
  });
});
