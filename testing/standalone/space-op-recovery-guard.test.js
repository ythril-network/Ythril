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
 * Since bundle-106 the guard is the space-act runner's (`spaces/space-act-runner.ts`): every rename and deletion is a runner act,
 * the runner counts a body while it runs and releases it in a `finally`, and recovery asks by KEY — is the marker's OWN op running
 * (`spaceActRunning(op.spaceId)`) — where it used to compare an instance-wide depth counter, which made a long wipe of an unrelated
 * space look like the marker's op.
 *
 * These tests pin the counter and the call sites, since the failure mode of getting this wrong is a recovery path that silently
 * never runs.
 *
 * Run: node --test testing/standalone/space-op-recovery-guard.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let runner;
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n\r]/g, ' '))
  .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);

describe('the in-flight guard', () => {
  before(async () => {
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });

  it('is off by default, so recovery runs at boot as it always did', () => {
    assert.equal(runner.spaceActsRunning(), 0);
    assert.equal(runner.spaceActRunning('any-space'), false);
  });

  it('counts a body only while it runs, released in a finally, and never below zero', () => {
    const src = strip(readFileSync('server/src/spaces/space-act-runner.ts', 'utf8'));
    const body = src.slice(src.indexOf('async function runBody'), src.indexOf('function complete('));
    assert.match(body, /runningCount\+\+/, 'the runner does not count a body it runs');
    // `finally`, not a trailing statement: a body that throws must not leave the space counted, or every later recovery of its marker
    // in this process is skipped. Floored, so an unbalanced release cannot read as "never running" for good.
    assert.match(body, /finally\s*\{[\s\S]*?runningCount\s*=\s*Math\.max\(0,/, 'the count is not released, floored, in a finally');
  });
});

describe('both space operations claim the guard, and recovery reads it', () => {
  it('renameSpace and removeSpace run through the runner, which writes their marker inside its counted body', () => {
    for (const [file, name] of [['server/src/spaces/rename.ts', 'renameSpace'], ['server/src/spaces/lifecycle.ts', 'removeSpace']]) {
      const src = strip(readFileSync(file, 'utf8'));
      const at = src.indexOf(`export async function ${name}(`);
      assert.ok(at > -1, `${name} is gone — re-anchor this gate`);
      assert.match(src.slice(at, at + 400), /return\s+runSpaceAct\(/, `${name} does not hand its act to the runner`);
    }
  });

  it('reconcilePendingSpaceOp checks it BEFORE doing any work, by the marker\'s own space', () => {
    const src = strip(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));
    // The work lives in `resumePendingSpaceOp`, which both the boot/reload reconciler and the op that meets a pending marker call.
    const fn = src.slice(src.indexOf('async function resumePendingSpaceOp'));
    const guardAt = fn.indexOf('spaceActRunning(op.spaceId)');
    const workAt = fn.indexOf('moveSpaceData(');
    assert.ok(guardAt > 0, 'the reconciler must consult the guard, by the marker\'s own space');
    assert.ok(workAt > 0 && guardAt < workAt, 'and it must do so before moving any data');
  });
});
