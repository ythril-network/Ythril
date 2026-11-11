/**
 * A member's file leg is evidence for the absent-bytes sweep only when it left NOTHING undone, and every way `syncFiles` can leave a file
 * undone feeds the one accumulator that decides it (bundle-70, Q-337, slice S4).
 *
 * ## What it prevents
 *
 * The sweep removes the record of a file whose bytes this instance lost only after every member we pull the space from has shown us its
 * whole manifest and we took everything it offered (`sync/file-legs.ts`): a member holding the bytes would have delivered them. A leg that
 * refused or deferred anything (a quota refusal, a failed fetch, a path left alone, an entry outside the space, a turn stopped part way, a
 * shadowed arrival, a repair past the budget) proves nothing about the paths it did not reach. Counted as evidence, it lets the sweep remove
 * the record of a file a peer still holds, and the leg's next cycle restores only the bytes, never the tags or links a person wrote here.
 *
 * ## What is held
 *
 *  - the accumulator, per exit class: any one class alone records nothing; none records; a leg whose manifest was never read records
 *    nothing; the record says whether the peer's manifest carried `unreadable` at all (an older peer's does not), and what it named;
 *  - the source of `syncFiles` feeds every class of `LEG_EXITS` (a new class nobody feeds is a gap, an exit that forgot to feed the class
 *    it belongs to is the defect), and closes the leg in a `finally`, so an exit by `return` or by a throw cannot skip the close.
 *
 * Red on f423dd6e: `sync/file-legs.ts` does not exist.
 *
 * Run: node --test testing/standalone/the-file-leg-record-is-fed-by-every-exit.test.js (requires a prior `npm run build -w @ythril/server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

let mod;
try { mod = await import('../../server/dist/sync/file-legs.js'); } catch (err) { mod = { importFailure: err }; }
const need = () => assert.equal(typeof mod.FileLegAccumulator, 'function',
  `sync/file-legs.ts exports no FileLegAccumulator (the one accumulator every exit of a file leg feeds): ${mod.importFailure?.message ?? 'not exported'}`);
const NAMED = { paths: { covers: (k) => k === 'named.txt' }, truncated: false };

describe('the file leg record: evidence only when nothing was left undone', () => {
  it('names the exit classes (a list of none would make every leg evidence)', () => {
    need();
    assert.ok(Array.isArray(mod.LEG_EXITS) && mod.LEG_EXITS.length >= 8, `LEG_EXITS: ${JSON.stringify(mod.LEG_EXITS)}`);
  });

  it('a leg that left nothing undone and read the manifest is recorded, with what the manifest carried', () => {
    need();
    mod.forgetFileLegs();
    const leg = new mod.FileLegAccumulator('s1', 'm1');
    leg.manifestRead(1234, { unreadable: [] }, NAMED);
    assert.equal(leg.end(), true);
    const ev = mod.lastCompleteFileLeg('s1', 'm1');
    assert.equal(ev?.manifestReadAt, 1234);
    assert.equal(ev?.carriesUnreadable, true);
    assert.equal(ev?.unreadable.paths.covers('named.txt'), true);
  });

  it('an older peer\'s manifest (no `unreadable` field) is recorded as carrying none, which the due rule reads as no evidence', () => {
    need();
    mod.forgetFileLegs();
    const leg = new mod.FileLegAccumulator('s1', 'm1');
    leg.manifestRead(1, {}, NAMED);
    leg.end();
    assert.equal(mod.lastCompleteFileLeg('s1', 'm1')?.carriesUnreadable, false);
  });

  it('a leg whose manifest was never read records nothing', () => {
    need();
    mod.forgetFileLegs();
    assert.equal(new mod.FileLegAccumulator('s1', 'm1').end(), false);
    assert.equal(mod.lastCompleteFileLeg('s1', 'm1'), undefined);
  });

  it('each exit class alone keeps the leg from being evidence, and leaves an earlier complete leg as it was', () => {
    need();
    for (const exit of mod.LEG_EXITS) {
      mod.forgetFileLegs();
      const earlier = new mod.FileLegAccumulator('s1', 'm1');
      earlier.manifestRead(10, { unreadable: [] }, NAMED);
      earlier.end();
      const leg = new mod.FileLegAccumulator('s1', 'm1');
      leg.manifestRead(20, { unreadable: [] }, NAMED);
      leg.refused(exit);
      assert.equal(leg.end(), false, `a leg that left something undone (${exit}) was recorded as evidence`);
      assert.equal(mod.lastCompleteFileLeg('s1', 'm1')?.manifestReadAt, 10, `${exit}: the incomplete leg replaced the last complete one`);
    }
  });

  it('a record is per space and member', () => {
    need();
    mod.forgetFileLegs();
    const leg = new mod.FileLegAccumulator('s1', 'm1');
    leg.manifestRead(1, { unreadable: [] }, NAMED);
    leg.end();
    assert.equal(mod.lastCompleteFileLeg('s1', 'm2'), undefined);
    assert.equal(mod.lastCompleteFileLeg('s2', 'm1'), undefined);
  });
});

describe('syncFiles feeds every exit class and closes the leg however it ends (source gate)', () => {
  const src = blankComments(readFileSync(join(REPO_ROOT, 'server/src/sync/file-sync.ts'), 'utf8'));
  const body = src.slice(src.indexOf('export async function syncFiles'));
  const fn = body.slice(0, body.indexOf('\nexport ', 1) === -1 ? undefined : body.indexOf('\nexport ', 1));

  it('every class of LEG_EXITS is fed somewhere in syncFiles', () => {
    need();
    const missing = mod.LEG_EXITS.filter(exit => !new RegExp(String.raw`leg\.refused\(\s*(?:[^)]*\?\s*)?'${exit}'`).test(fn) && !fn.includes(`'${exit}'`));
    assert.deepEqual(missing, [], `syncFiles never feeds these exit classes to the leg: ${missing.join(', ')}`);
  });

  it('every `continue` and `return` of the pull loop is preceded by a feed, or is one of the named non-exits', () => {
    // The pull loop runs from the arrivals loop to the push section. A skip of a file that is not "left undone" is named here with its reason.
    const start = fn.indexOf('for (const { remote, key } of arriving)');
    const end = fn.indexOf('// ── 3.', start) === -1 ? fn.indexOf('if (doPush) {', start) : fn.indexOf('// ── 3.', start);
    assert.ok(start > 0 && end > start, 'fixture: the pull loop of syncFiles was not found — re-anchor this gate');
    const loop = fn.slice(start, end);
    const NOT_EXITS = [
      /isInstanceLocalFile\(key\)\)\s*continue/,      // a peer's conflict copy or schema snapshot: the peer's own, never ours to take
      /removeUnrecordedBytes\(spaceId, \{ held: local\.diskPath \}, null\)\)[^;]*;\s*continue/, // bytes held with no row, taken back for the next cycle's arrival
      /continue;\s*\n\s*\}\s*\n\s*if \(notNow\.has\(key\)\)/, // the skip branch's own end: the bytes are here (the same hash on both sides)
    ];
    const lines = loop.split('\n');
    const unfed = [];
    lines.forEach((line, i) => {
      if (!/\bcontinue\b|\breturn\b|\bbreak\b/.test(line)) return;
      if (/leg\.refused\(/.test(lines.slice(Math.max(0, i - 5), i + 1).join('\n'))) return;
      if (NOT_EXITS.some(re => re.test(lines.slice(Math.max(0, i - 1), i + 3).join('\n')))) return;
      unfed.push(line.trim());
    });
    assert.deepEqual(unfed, [], 'an exit of the pull loop feeds no class to the leg accumulator: a leg that left a file undone would be evidence');
  });

  it('the leg is closed in a finally (an exit by return or throw cannot skip it)', () => {
    assert.match(fn, /finally\s*\{\s*leg\.end\(\);?\s*\}/, 'syncFiles does not close the leg in a finally');
  });
});
