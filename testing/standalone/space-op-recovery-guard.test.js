/**
 * Crash recovery stands aside while the operation it would recover is still running.
 *
 * ## The failure this comes from
 *
 * CI went red once on `space-rename` with `MongoServerError: Source collection ythril.<old>_edges does not
 * exist` for three collections — on a rename that had otherwise worked, and with `_facts` renamed fine.
 *
 * `moveSpaceData` only renames collections that `listCollections()` just returned, so "does not exist" cannot
 * mean "was never created". It means the collection was moved by **someone else** between the listing and the
 * rename. There is exactly one other caller: `reconcilePendingSpaceOp`.
 *
 * And that reconciler runs on the config-RELOAD path (`app.ts`), while `renameSpace` persists its
 * `pendingSpaceOp` marker BEFORE doing the collection work. So the marker a live rename writes is precisely
 * what the reconciler acts on — in the same process, against the same collections, while the original is
 * still going. The watcher's mtime guard makes that rare rather than impossible, and its own comment notes
 * that bind-mount mtimes are unreliable, which is where CI lives.
 *
 * ## What the guard is
 *
 * A live operation in this process is not an interrupted one. It needs to be left alone, not recovered.
 * Nothing is lost by standing aside: if the running op dies, its marker survives and the next boot recovers
 * it — the only situation the marker exists for.
 *
 * These tests pin the counter and the two call sites, since the failure mode of getting this wrong is a
 * recovery path that silently never runs.
 *
 * Run: node --test testing/standalone/space-op-recovery-guard.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enclosingBlockFrom } from './_structural-window.mjs';

let beginSpaceOp, endSpaceOp, spaceOpInFlight;
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n\r]/g, ' '))
  .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);

describe('the in-flight guard', () => {
  before(async () => {
    ({ beginSpaceOp, endSpaceOp, spaceOpInFlight } = await import('../../server/dist/spaces/_shared.js'));
  });

  it('is off by default, so recovery runs at boot as it always did', () => {
    assert.equal(spaceOpInFlight(), false);
  });

  it('reports in-flight between begin and end', () => {
    beginSpaceOp();
    assert.equal(spaceOpInFlight(), true);
    endSpaceOp();
    assert.equal(spaceOpInFlight(), false);
  });

  it('nests, so a delete inside a rename does not clear the outer guard', () => {
    beginSpaceOp();
    beginSpaceOp();
    endSpaceOp();
    assert.equal(spaceOpInFlight(), true, 'the outer operation is still running');
    endSpaceOp();
    assert.equal(spaceOpInFlight(), false);
  });

  it('CANNOT be driven negative by an unbalanced end', () => {
    // The consequence of getting this wrong is the worst available: a permanently negative counter would
    // read as "never in flight", and crash recovery would be disabled for the life of the process while
    // looking fine.
    endSpaceOp();
    endSpaceOp();
    assert.equal(spaceOpInFlight(), false);
    beginSpaceOp();
    assert.equal(spaceOpInFlight(), true, 'a later real operation must still register');
    endSpaceOp();
  });
});

describe('both space operations claim the guard, and recovery reads it', () => {
  it('renameSpace wraps its work and releases in a finally', () => {
    const src = strip(readFileSync('server/src/spaces/rename.ts', 'utf8'));
    assert.match(src, /beginSpaceOp\(\);/);
    // `finally`, not a trailing call: a rename that throws (the "incomplete" path does) must not leave the
    // guard set, or every later recovery in this process is skipped.
    assert.match(src, /finally\s*\{\s*endSpaceOp\(\);/);
  });

  it('removeSpace does too — it writes the same kind of marker', () => {
    const src = strip(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));
    /*
     * The rest of the FUNCTION the marker is opened in, bounded by the brace that closes it.
     *
     * `blockAfter` on the `try` was the obvious choice and is wrong: a `finally` is a SIBLING of the try block,
     * not inside it, so bounding at the try's own brace excludes the very thing being looked for. The enclosing
     * function is the smallest bound that contains both halves, and it still refuses an `endSpaceOp()` that
     * belongs to some other function further down the file — which is what the 200-character cap could not.
     */
    const at = src.indexOf('beginSpaceOp();');
    assert.ok(at > -1, 'beginSpaceOp is no longer called here — re-anchor this gate');
    const rest = enclosingBlockFrom(src, at, 'the removeSpace body');
    assert.match(rest, /finally\s*\{[\s\S]*?endSpaceOp\(\);/,
      'the marker must be cleared in a finally of the function it was opened in');
  });

  it('reconcilePendingSpaceOp checks it BEFORE doing any work', () => {
    const src = strip(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));
    const fn = src.slice(src.indexOf('export async function reconcilePendingSpaceOp'));
    const guardAt = fn.indexOf('spaceOpInFlight()');
    const workAt = fn.indexOf('moveSpaceData(');
    assert.ok(guardAt > 0, 'the reconciler must consult the guard');
    assert.ok(workAt > 0 && guardAt < workAt, 'and it must do so before moving any data');
  });
});
