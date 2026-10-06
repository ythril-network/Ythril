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
 * ## Where the rule lives now (5.6.2, `Q-218`; main's `Q-107` part 1)
 *
 * Every door — the push, the pull, the import — stores arriving records through ONE writer, `writeArrivals` in
 * `sync/arrivals.ts`, so the rule is asserted there, once, rather than at the pull alone: the write is unordered;
 * a duplicate is caught where it happens, read back, and reported as a record; a refusal of ONE document (from an
 * allowlist of codes that name the document) is kept apart from the rest (`storeRefused`, which each door answers
 * as 5.6.1 answered that fault — cut `C3`); and anything else — a fault with no per-operation shape, a code that is
 * not the document's — still throws, so a real fault is never absorbed as a duplicate. The pull catches that throw,
 * and a store refusal, as a RECORD-WRITE failure and holds its watermark, rather than letting it reach the
 * member-level escalation.
 *
 * ## Why this asserts on source
 *
 * Reproducing it needs two peers, a partition, the same relationship written on both sides, and a reconnect —
 * a fixture substantially larger than the change, and one that pins the symptom rather than the rule. The
 * behaviour half is `a-push-write-failure-keeps-what-it-must-db.test.js` (real validator, view and unique-index
 * faults on the push door) and `a-pulled-page-lands-by-the-receivers-rules-db.test.js` (a non-duplicate fault and
 * a store refusal on the pull door hold the watermark and are not counted against the peer).
 *
 * Re-anchored for 5.6.2 from `sync/engine.ts:batchUpsertBySeq`, and seen red against the new site by mutation,
 * each restored by hand: `ordered: false` removed from the writer's bulk write; the throw for a non-document code
 * replaced by a refusal; the engine's catch of a failed page write made to rethrow.
 *
 * Run: node --test testing/standalone/one-duplicate-key-does-not-wedge-a-member.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround, statementFrom, bodyOf } from './_structural-window.mjs';

const ARRIVALS = 'server/src/sync/arrivals.ts';
const ENGINE = 'server/src/sync/engine.ts';
/** Where a pulled family's page is accepted and its failure caught (bundle-52: out of the engine, into the per-family pull). */
const PULL = 'server/src/sync/pull-family.ts';
const PAGER = 'server/src/sync/seq-run-pager.ts';
const writerSrc = stripComments(readFileSync(ARRIVALS, 'utf8'));
const engine = stripComments(readFileSync(ENGINE, 'utf8'));
const pull = stripComments(readFileSync(PULL, 'utf8'));
const pager = stripComments(readFileSync(PAGER, 'utf8'));

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
    assert.match(writerSrc, /writeErrorCode\(err\) === DUPLICATE_KEY/, 'the writer no longer reads codes through writeErrorCode');
    assert.doesNotMatch(writerSrc, /\?\.code\b|\.code\s*===|as \{ code\?/, 'the writer reads an error code by hand again');
    const shared = stripComments(readFileSync('server/src/db/write-errors.ts', 'utf8'));
    assert.match(shared, /export function writeErrorCode\(/, 'the shared code reader is gone');
  });

  it('the pull holds its watermark on a failed page write — and on a store refusal — instead of escalating it', () => {
    // Re-pointed for bundle-52: the page write is in `pullFamily` (`sync/pull-family.ts`), which hands the pager a reason
    // instead of breaking, and the pager (`sync/seq-run-pager.ts`) stops the transfer as truncated on any reason it is
    // handed. Both halves, each anchor found first.
    const write = pull.search(/=\s*await writeArrivals\(/);
    assert.ok(write > 0, `${PULL} no longer writes a pulled page through writeArrivals — re-point this gate`);
    const end = pull.indexOf('const seen = settlePulledPage(', write);
    assert.ok(end > write, `${PULL}: the settle after the page write is gone — re-point this gate`);
    const after = pull.slice(write, end);
    assert.match(after, /catch \(err\) \{\s*\n\s*return `sync pull[\s\S]*?record write failed/,
      'a failed page write must be caught in the transfer — and handed back as a record-write failure that stops it, '
      + 'not rethrown into the member-level catch, which counts it toward PEER UNREACHABLE');
    assert.doesNotMatch(after, /\bthrow\b/, 'the page-write catch rethrows');
    // Cut `C3`: a document the store refused is never counted as delivered — the transfer holds the same way.
    assert.match(after, /if \(written\.storeRefused\.length > 0\) \{[\s\S]*?return `/,
      'a store refusal on a pulled page lets the watermark pass the refused record, which is then never offered again');
    const refusal = pager.search(/const refusal = await o\.deliver\(fresh\);/);
    assert.notEqual(refusal, -1, `${PAGER} no longer asks \`deliver\` for a refusal — re-point this gate`);
    const refusalAt = pager.indexOf('if (refusal !== null)', refusal);
    assert.notEqual(refusalAt, -1, `${PAGER} no longer checks what \`deliver\` handed back — re-point this gate`);
    assert.match(statementFrom(pager, refusalAt, 'the refusal branch'), /stop\(refusal\); return;/,
      'a reason handed back by the page write must stop the transfer');
    assert.match(pager, /const stop = \(why: string\): void => \{ outcome\.truncated = true;/, 'a stop must mark the transfer truncated');
  });

  it('the member-level escalation still exists for real failures', () => {
    // Guard against the fix being "stop escalating anything". PEER UNREACHABLE is correct when the peer is
    // actually unreachable; the defect was a record fault reaching it, not the escalation itself.
    assert.match(engine, /PEER UNREACHABLE/,
      'the peer-unreachable escalation must survive — this gate is about what reaches it, not about removing it');
  });
});
