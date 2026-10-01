/**
 * A duplicate key is a record-level problem. It must not abort a member's sync, and it must not be reported as
 * an unreachable peer.
 *
 * ## What one duplicate does today
 *
 * `_edges` carries a unique index on `(from, to, label)` (`spaces/lifecycle.ts:90`) with no partial or sparse
 * option, and new edges get `_id: uuidv4()`. Sync ingest is keyed on `_id` alone and never consults the
 * triplet, so two peers that independently create the same relationship hold two ids for one unique key — and
 * the first of them to cross the wire raises `E11000`.
 *
 * `batchUpsertBySeq` calls `bulkWrite` with **no `ordered: false` and no try/catch**, so that error:
 *
 *  1. escapes `pullType` before `deliveredThrough` is written;
 *  2. escapes `pullFromPeer` before the watermark persists;
 *  3. escapes the unguarded `await` in the space loop, **taking every remaining space with it, including files**;
 *  4. lands in the member-level catch, which logs "Sync failed for member", increments the failure count, and
 *     at threshold prints **`PEER UNREACHABLE`**.
 *
 * `lastSyncAt` is never written, so the next cycle pulls the identical page and throws identically. One
 * duplicate edge stops a member syncing **permanently**, and tells the operator to go and look at the network.
 *
 * ## Why this asserts on source
 *
 * Reproducing it needs two peers, a partition, the same relationship written on both sides, and a reconnect —
 * a fixture substantially larger than the change, and one that pins the symptom rather than the rule. The rule
 * is small and checkable: the write is unordered, the duplicate is caught where it happens, and it is reported
 * as a record rather than escalated as a peer failure. Same reasoning, and the same shape, as
 * `sync-dropped-record-is-not-silent.test.js` beside it.
 *
 * Run: node --test testing/standalone/one-duplicate-key-does-not-wedge-a-member.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround, bodyOf } from './_structural-window.mjs';

const SRC = 'server/src/sync/engine.ts';
const engine = stripComments(readFileSync(SRC, 'utf8'));

/** The one `bulkWrite` the pull path applies a page with. */
function bulkWriteAt() {
  const at = engine.indexOf('.bulkWrite(');
  assert.notEqual(at, -1, `no .bulkWrite( in ${SRC} — re-point this gate at the pull apply path`);
  assert.equal(
    engine.indexOf('.bulkWrite(', at + 1), -1,
    'more than one bulkWrite in the engine: this gate checks the first and would miss the others',
  );
  return at;
}

/**
 * The WHOLE apply function, not the innermost block around the write.
 *
 * `enclosingBlockFrom` was used here first and it was wrong in a way worth recording: once the fix wraps the
 * write in `try { … }`, the innermost enclosing block IS that try body, which contains the bulkWrite and
 * neither the `catch` nor its reporting. The gate went green on `ordered: false` and stayed red on the other
 * two for a reason that had nothing to do with the code under test.
 */
function applyFn() {
  const body = bodyOf(engine, 'batchUpsertBySeq');
  assert.ok(body.includes('.bulkWrite('), 'batchUpsertBySeq no longer contains the bulkWrite — re-point this gate');
  return body;
}

describe('one duplicate key does not wedge a member', () => {
  it('the page write is UNORDERED, so one bad document does not abandon the rest', () => {
    const stmt = statementAround(engine, bulkWriteAt(), 'the bulkWrite statement');
    assert.match(
      stmt, /ordered\s*:\s*false/,
      'bulkWrite defaults to ordered:true, which stops at the first error and leaves every later document in '
      + 'the page unapplied. A duplicate key is a property of ONE record and must not decide the fate of the '
      + `others.\n\nstatement:\n${stmt}`,
    );
  });

  it('the duplicate is caught where it happens, not at member level', () => {
    // The enclosing function must handle it itself. If the only handler is the member-level catch, a
    // record-level fault has already destroyed the rest of the cycle by the time anything sees it.
    const block = applyFn();
    assert.match(
      block, /try\s*\{/,
      'the bulkWrite is unguarded, so a duplicate key escapes to the member-level catch — aborting every '
      + 'remaining space in the loop, including files, and never writing lastSyncAt. Catch it here.',
    );
    assert.match(
      block, /11000|duplicate|writeErrors/i,
      'the handler must distinguish a duplicate key from a real failure. Swallowing every bulkWrite error '
      + 'would hide genuine write faults, which is the opposite defect.',
    );
  });

  it('an error that is NOT a duplicate key still throws', () => {
    /*
     * Pinned as two statements rather than as vocabulary, because the vocabulary version survived its own
     * mutant: neutering the guard to `if (false) throw err` left the words `writeErrors` and `duplicate`
     * sitting in the function, so a check for those passed while the behaviour it was meant to protect —
     * a genuine write fault reaching the caller — had been removed.
     */
    /*
     * Since Q-99 part 3 the two questions are answered by the shared reader of a bulk write's failures
     * (`db/write-errors.ts`) rather than spelled inline, so the rule is pinned in two halves: the catch rethrows
     * on either answer, and the shared functions answer them the way the rule needs.
     */
    const block = applyFn();
    const catchAt = block.search(/catch\s*\(\s*err\s*\)/);
    assert.notEqual(catchAt, -1, 'batchUpsertBySeq no longer catches the page write — re-point this gate');
    const guardAt = block.indexOf('if (', catchAt);
    assert.notEqual(guardAt, -1, 'no guard in the catch: the caught error is never examined');
    const guard = statementAround(block, guardAt, 'the catch guard');
    assert.match(guard, /^\s*if\s*\(([^)]|\([^)]*\))*!bulkWriteFailures\(err\)([^)]|\([^)]*\))*\)\s*throw err\s*;/,
      'no shape guard on the caught error: a fault carrying no writeErrors must rethrow, not fall through into '
      + `code that assumes it is a bulk write result.\n\nguard:\n${guard}`);
    assert.match(guard, /^\s*if\s*\(([^)]|\([^)]*\))*\|\|\s*!isDuplicateKeyOnly\(err\)\s*\)\s*throw err\s*;/,
      'a page containing a NON-duplicate write error must still fail loudly — absorbing every bulkWrite error '
      + `would turn real corruption into a warning nobody reads.\n\nguard:\n${guard}`);

    const shared = stripComments(readFileSync('server/src/db/write-errors.ts', 'utf8'));
    const failures = bodyOf(shared, 'bulkWriteFailures');
    assert.match(failures, /if \(!writeErrors\) return null;/,
      'bulkWriteFailures answers something for an error with no writeErrors, so the shape guard above never fires');
    assert.match(bodyOf(shared, 'isDuplicateKeyOnly'), /failures\.every\(f => f\.code === DUPLICATE_KEY\)/,
      'isDuplicateKeyOnly no longer requires EVERY failure to be a duplicate, so one real fault rides along');
    assert.match(shared, /export const DUPLICATE_KEY = 11000;/, 'the duplicate-key code is not 11000');
  });

  it('a duplicate is REPORTED as a record, naming it', () => {
    const block = applyFn();
    assert.match(
      block, /log\.(warn|error)/,
      'a duplicate that is handled silently is the sync-dropped-record defect again: the record does not '
      + 'arrive, the watermark advances, and nothing says so. Report it with enough to find the record.',
    );
  });

  it('the member-level escalation still exists for real failures', () => {
    // Guard against the fix being "stop escalating anything". PEER UNREACHABLE is correct when the peer is
    // actually unreachable; the defect was a record fault reaching it, not the escalation itself.
    assert.match(
      engine, /PEER UNREACHABLE/,
      'the peer-unreachable escalation must survive — this gate is about what reaches it, not about removing it',
    );
  });
});
