/**
 * A duplicate key is a record-level problem. It must not abort a member's sync, and it must not be reported as
 * an unreachable peer.
 *
 * ## What one duplicate did
 *
 * `_edges` carries a unique index on its triplet (`spaces/lifecycle.ts`), and `_links` one on a link's endpoints.
 * Sync ingest is keyed on `_id`, so two peers that independently create the same relationship hold two ids for
 * one unique key — and the first of them to cross the wire raises `E11000`.
 *
 * The pull's page write called `bulkWrite` with **no `ordered: false` and no try/catch**, so that error:
 *
 *  1. escaped `pullType` before `deliveredThrough` was written;
 *  2. escaped `pullFromPeer` before the watermark persisted;
 *  3. escaped the unguarded `await` in the space loop, **taking every remaining space with it, including files**;
 *  4. landed in the member-level catch, which logs "Sync failed for member", increments the failure count, and
 *     at threshold prints **`PEER UNREACHABLE`**.
 *
 * One duplicate edge stopped a member syncing **permanently**, and told the operator to go and look at the network.
 *
 * ## Where the rule lives now (`Q-107` part 1)
 *
 * Every door — the push, the pull, the import — stores arriving records through ONE writer, `writeArrivals` in
 * `sync/arrivals.ts`, so the rule is asserted there, once, rather than at the pull alone: the write is unordered;
 * a duplicate is caught where it happens, read back, and reported as a record; a refusal of ONE document (from an
 * allowlist of codes that name the document) refuses only it; and anything else — a fault with no per-operation
 * shape, a code that is not the document's — still throws, so a real fault is never absorbed as a duplicate. The
 * pull catches that throw as a RECORD-WRITE failure and holds its watermark, rather than letting it reach the
 * member-level escalation.
 *
 * ## Why this asserts on source
 *
 * Reproducing it needs two peers, a partition, the same relationship written on both sides, and a reconnect —
 * a fixture substantially larger than the change, and one that pins the symptom rather than the rule. The
 * behaviour half is `a-push-write-failure-keeps-what-it-must-db.test.js` (real validator, view and unique-index
 * faults on the push door) and `a-pulled-page-lands-by-the-receivers-rules-db.test.js` (a non-duplicate fault on
 * the pull door holds the watermark and is not counted against the peer).
 *
 * Re-anchored for `Q-107` part 1 from `sync/engine.ts:batchUpsertBySeq`, and seen red against the new site by
 * mutation, each restored by hand: `ordered: false` removed from the writer's bulk write; the throw for a
 * non-document code replaced by a refusal; the engine's catch of a failed page write made to rethrow.
 *
 * Run: node --test testing/standalone/one-duplicate-key-does-not-wedge-a-member.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround, bodyOf } from './_structural-window.mjs';

const ARRIVALS = 'server/src/sync/arrivals.ts';
const ENGINE = 'server/src/sync/engine.ts';
const writerSrc = stripComments(readFileSync(ARRIVALS, 'utf8'));
const engine = stripComments(readFileSync(ENGINE, 'utf8'));

/** The writer's whole body, closures included — where every arriving page is written. */
function writer() {
  const body = bodyOf(writerSrc, 'writeArrivals');
  assert.ok(body.includes('.bulkWrite('), 'writeArrivals no longer contains the page bulkWrite — re-point this gate');
  return body;
}

describe('one duplicate key does not wedge a member', () => {
  it('the page write is UNORDERED, and it is the only bulk write the writer makes', () => {
    const at = writerSrc.indexOf('.bulkWrite(');
    assert.notEqual(at, -1, `no .bulkWrite( in ${ARRIVALS}`);
    assert.equal(writerSrc.indexOf('.bulkWrite(', at + 1), -1,
      'more than one bulkWrite in the arrival writer: this gate checks the first and would miss the others');
    const stmt = statementAround(writerSrc, at, 'the bulkWrite statement');
    assert.match(stmt, /ordered\s*:\s*false/,
      'bulkWrite defaults to ordered:true, which stops at the first error and leaves every later document in '
      + `the page unapplied. A duplicate key is a property of ONE record.\n\nstatement:\n${stmt}`);
  });

  it('the duplicate is caught where it happens, read back, and reported as a record', () => {
    const body = writer();
    assert.match(body, /try\s*\{[\s\S]*\.bulkWrite\([\s\S]*catch\s*\(\s*err\s*\)/,
      'the bulkWrite is unguarded, so a duplicate key escapes the writer');
    assert.match(body, /code === DUPLICATE_KEY\)\s*dupes\.push\(d\)/,
      'a duplicate is not set apart from the other failures, so it cannot be answered as the record it is');
    assert.match(body, /readStoredById<Doc>\(collName, dupes\.map/,
      'a duplicate is not read back, so a newer stored copy cannot be told from a unique-index collision');
    assert.match(body, /warnArrivalsNotStored\([^;]*out\.duplicates\)/,
      'a duplicate handled silently is the dropped-record defect again: report it with the ids');
  });

  it('an error that is NOT a duplicate or a document\'s own refusal still throws', () => {
    const body = writer();
    // The per-operation path: a code that is neither a duplicate nor a document refusal fails the page.
    assert.match(body, /else if \(isDocumentRefusalCode\(code\)\) retry\.push\(d\);\s*else throw stopped\(err\);/,
      'a per-operation failure whose code is not the document\'s is absorbed instead of failing the page');
    // The no-shape path: nothing says which documents landed, so each is asked — and classified the same way.
    assert.match(body, /if \(!failures \|\|[^\n]*\)\s*\{[\s\S]*?await oneByOne\(chunk, writeOne\)/,
      'a failure with no per-operation shape is treated as if it had one');
    assert.match(body, /else if \(isDocumentRefusal\(err\)\)[^\n]*\n\s*else throw stopped\(err\);/,
      'a single write\'s failure that is not the document\'s own is refused instead of failing the page');

    // `stopped` is the one way the writer gives up on a page: an ArrivalWriteError carrying the outcome so far.
    assert.match(body, /const stopped = \(err: unknown\): ArrivalWriteError => \{[\s\S]*?e\.partial = out;/,
      'the writer stops a page without an ArrivalWriteError that carries what already landed');
    const shared = stripComments(readFileSync('server/src/db/write-errors.ts', 'utf8'));
    assert.match(bodyOf(shared, 'bulkWriteFailures'), /if \(!writeErrors\) return null;/,
      'bulkWriteFailures answers something for an error with no writeErrors, so the no-shape path never runs');
    assert.match(shared, /export const DUPLICATE_KEY = 11000;/, 'the duplicate-key code is not 11000');
    // An ALLOWLIST: a refusal is the document's only when a code or a driver error NAMES it, never by default.
    assert.match(bodyOf(shared, 'isDocumentRefusal'), /DOCUMENT_REFUSAL_CODES\.has\([^)]*\)\) return true;[\s\S]*DOCUMENT_REFUSAL_NAMES\.has/,
      'isDocumentRefusal no longer reads its allowlists');
    assert.doesNotMatch(shared, /DOCUMENT_REFUSAL_CODES = new Set\(\[[^\]]*\b(?:166|11000|91|189|11600)\b/,
      'a code that is the collection\'s, the store\'s or a duplicate is in the document-refusal allowlist');
  });

  it('the writer reads a failure\'s code through the shared reader, never by hand', () => {
    // Dup pass: arrivals.ts carried its own `err.code` reader beside db/write-errors.ts's, and the two shapes a
    // driver reports a code in (on the error, or on its `err`) were known to one of them. Seen red by mutation,
    // restored by hand: the inline `(err as { code?: unknown })?.code` reader put back.
    assert.match(writerSrc, /const codeOf = writeErrorCode;/, 'the writer no longer reads codes through writeErrorCode');
    assert.doesNotMatch(writerSrc, /\?\.code\b|\.code\s*===|as \{ code\?/, 'the writer reads an error code by hand again');
    const shared = stripComments(readFileSync('server/src/db/write-errors.ts', 'utf8'));
    assert.match(shared, /export function writeErrorCode\(/, 'the shared code reader is gone');
  });

  it('the pull holds its watermark on a failed page write instead of escalating it', () => {
    const write = engine.search(/=\s*await writeArrivals\(/);
    assert.ok(write > 0, `${ENGINE} no longer writes a pulled page through writeArrivals — re-point this gate`);
    const after = engine.slice(write, engine.indexOf('deliveredThrough = maxSeq', write));
    assert.match(after, /catch \(err\) \{\s*\n\s*truncated = true;[\s\S]*?log\.warn\([\s\S]*?break;/,
      'a failed page write must be caught in the transfer — logged as a record write, the transfer stopped — and '
      + 'not rethrown into the member-level catch, which counts it toward PEER UNREACHABLE');
    assert.doesNotMatch(after.slice(0, after.indexOf('break;')), /\bthrow\b/, 'the page-write catch rethrows');
  });

  it('the member-level escalation still exists for real failures', () => {
    // Guard against the fix being "stop escalating anything". PEER UNREACHABLE is correct when the peer is
    // actually unreachable; the defect was a record fault reaching it, not the escalation itself.
    assert.match(engine, /PEER UNREACHABLE/,
      'the peer-unreachable escalation must survive — this gate is about what reaches it, not about removing it');
  });
});
