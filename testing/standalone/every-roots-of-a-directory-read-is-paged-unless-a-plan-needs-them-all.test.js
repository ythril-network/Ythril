/**
 * Only the move's plan holds every root of a directory in memory; every other caller pages them (Q-412).
 *
 * `rootsOfDirectory` collects every live root under a directory into one list; `rootsOfDirectoryPages` yields them a page at a time. A caller that
 * acts per page (the delete's embed-job retire, the move's re-queue) never needs the list, and a directory of any size must not be held whole by
 * them. The one caller that does need it is the move's plan (`files/move-plan.ts`), which groups the rows by ancestor, sorts them and packs them into
 * batches: it says so beside its call.
 *
 *  1. The modules that call `rootsOfDirectory(` are read out of `server/src`, never listed here; the only one outside `derived-rows.ts` is `move-plan.ts`.
 *  2. That caller states why it holds them all (the sentence names the paged generator and this gate).
 *  3. The paged generator has callers: a gate that finds none has found nothing (floor).
 *
 * Seen red on the base: the delete's retire and the move's re-queue called `rootsOfDirectory`, so the set of callers was three, not one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'server/src';

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') ? [p.replace(/\\/g, '/')] : [];
  });
}

const files = sourceFiles(SRC);
const text = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')]));
const callers = (name) => files.filter(f => !f.endsWith('files/derived-rows.ts') && new RegExp(`\\b${name}\\(`).test(text.get(f)));

describe('a directory\'s roots are held whole only by the move\'s plan', () => {
  it('the source yields the generator and its callers (floor)', () => {
    assert.ok(files.length > 100, 'the source listing is empty or reshaped');
    assert.ok(callers('rootsOfDirectoryPages').length >= 2, 'no module pages the roots: the derivation is broken');
  });

  it('the only caller of rootsOfDirectory outside its module is the move plan (1)', () => {
    assert.deepEqual(callers('rootsOfDirectory'), ['server/src/files/move-plan.ts'],
      'a caller holds every root of a directory in memory: page it through rootsOfDirectoryPages, or state why it must hold them all');
  });

  it('the move plan says why it holds them all (2)', () => {
    const plan = text.get('server/src/files/move-plan.ts');
    assert.match(plan, /THE ONE CALLER THAT HOLDS THEM ALL[\s\S]{0,400}rootsOfDirectoryPages/);
  });
});
