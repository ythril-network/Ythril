/**
 * A shared sync watermark may not advance past a transfer that stopped early.
 *
 * ## The defect
 *
 * `lastSeqPushed` and `lastSeqReceived` are ONE number per member per space, and each cycle runs FIVE
 * independent transfers under it — tombstones plus memories, entities, edges and chrono. Each can stop early on
 * its own: a non-`ok` response, a throw, or a page cap.
 *
 * Both watermarks were set to the **maximum** across them. So a memories push that failed at seq 300, in a cycle
 * where entities succeeded to 500, moved the watermark to 500 — and the memory at seq 400 was behind it **for
 * ever**. Nothing errored at the cycle level and every later cycle reported success while never sending it again.
 *
 * ## Why the existing author guards do not cover it
 *
 * They are correct and load-bearing, and they are about a different axis. The pull advances only for docs
 * authored by the peer; the push only for docs authored by us. Neither says anything about whether a transfer
 * FINISHED. `_REFERENCE.md` records the author-axis hypothesis as killed — this is the collection axis, and it
 * was alive.
 *
 * ## The rule, and the wrong fix it replaces
 *
 * "Never advance when something was truncated" **livelocks**: a transfer that stopped at its page cap has more to
 * give, so the next cycle re-fetches the same pages and stops in the same place for ever, and a space more than
 * one cap behind can never catch up. That trades losing one record for syncing nothing.
 *
 * So: a transfer that ran to completion places no ceiling; one that stopped early vouches only up to the seq it is
 * COMPLETE through; the watermark advances to the lowest such ceiling. Nothing is skipped and a capped transfer
 * still makes a full page-set of progress per cycle.
 *
 * "Complete through" is not "delivered through" (bundle-52, `Q-277`): records relayed from several authors share
 * seqs, so a transfer that stopped inside a run of equal seqs has delivered that seq without finishing it, and
 * vouches for the seq BEFORE it. `safeWatermark` is the pure half (below); the engine-side cases at the end hold the
 * two modules that compute the position — the pull's pager and the push's loop.
 *
 * Run: node --test testing/standalone/one-watermark-four-transfers.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom } from './_structural-window.mjs';
// The collection list itself, so the transfer count below is derived rather than typed. Read from `dist`
// the way every other gate that needs a server value does — preflight builds it first for exactly this.
import { BRAIN_COLLECTIONS } from '../../server/dist/config/types.js';

const { safeWatermark, truncatedTransfers, completeThrough } = await import('../../server/dist/sync/watermark.js');

/** A transfer that finished everything above the old watermark. */
const done = () => ({ deliveredThrough: 0, truncated: false });
/** A transfer that stopped after delivering through `n`. */
const stopped = (n) => ({ deliveredThrough: n, truncated: true });

describe('the watermark stops at what the slowest stopped transfer can vouch for', () => {
  it('THE DEFECT: a truncated transfer caps the advance', () => {
    // The exact case: memories failed at 300, entities finished to 500. The old rule wrote 500 and stranded the
    // memory at 400.
    assert.equal(safeWatermark(100, 500, [stopped(300), done(), done(), done(), done()]), 300,
      'the watermark must not pass a record the peer never served');
  });

  it('all five complete — the candidate stands, unchanged', () => {
    // The common case must cost nothing. If this ever returned less than the candidate, sync would crawl.
    assert.equal(safeWatermark(100, 500, [done(), done(), done(), done(), done()]), 500);
  });

  it('two truncated — the LOWEST ceiling wins', () => {
    assert.equal(safeWatermark(100, 500, [stopped(400), done(), stopped(250), done(), done()]), 250,
      'every transfer must be complete through the result, so the lowest ceiling is the only safe one');
  });

  it('a truncation ABOVE the candidate cannot raise it', () => {
    // A ceiling is a maximum, never a target. A transfer that stopped at 900 in a cycle whose highest relevant
    // seq was 500 must leave the answer at 500 — raising it would invent progress nothing made.
    assert.equal(safeWatermark(100, 500, [stopped(900), done()]), 500);
  });

  it('NEVER goes backwards, even when a transfer stopped before the current watermark', () => {
    /*
     * The livelock guard, and the one that stops this fix being worse than the defect.
     *
     * A transfer that fails on its FIRST page reports `deliveredThrough` at the old watermark, or below it if a
     * cursor was behind. Letting that rewind the watermark would re-send everything since, every cycle, for as
     * long as one peer kept refusing — turning one lost record into unbounded repeated work.
     */
    assert.equal(safeWatermark(400, 500, [stopped(100), done()]), 400, 'a rewind would re-do unbounded work');
    assert.equal(safeWatermark(400, 500, [stopped(0)]), 400);
    assert.equal(safeWatermark(400, 300, [done()]), 400, 'nor may a lower candidate rewind it');
  });

  it('progress is still made when the page cap truncates', () => {
    // The reason "never advance on truncation" was rejected. A capped transfer delivered a full page-set, and
    // the watermark must move to the end of it or the next cycle repeats the same fetch for ever.
    assert.equal(safeWatermark(0, 10_000, [stopped(10_000), done(), done(), done(), done()]), 10_000,
      'a capped transfer must still advance by what it delivered');
    // Two cycles of catching up, each moving forward.
    assert.equal(safeWatermark(10_000, 20_000, [stopped(20_000), done()]), 20_000);
  });

  it('an empty transfer list leaves the candidate alone', () => {
    // Defensive rather than expected: no caller passes none. It must not silently mean "no ceiling is safe".
    assert.equal(safeWatermark(100, 500, []), 500);
  });

  it('truncatedTransfers names them, so a held-back cycle is never silent', () => {
    const names = truncatedTransfers([
      { ...stopped(1), label: 'facts' }, { ...done(), label: 'entities' },
      { ...stopped(2), label: 'tombstones' },
    ]);
    assert.deepEqual(names, ['facts', 'tombstones']);
    assert.deepEqual(truncatedTransfers([{ ...done(), label: 'facts' }]), [],
      'a healthy cycle must produce no message at all');
  });
});

describe('every transfer under a shared watermark is passed to the rule', () => {
  const src = stripComments(readFileSync('server/src/sync/engine.ts', 'utf8'));

  it('both watermarks go through safeWatermark rather than a bare Math.max', () => {
    /*
     * THE OMISSION IS THE REGRESSION, and it looks like nothing.
     *
     * `Math.max(memR.highSeq, entR.highSeq, edgeR.highSeq, chronoR.highSeq)` reads as obviously right — four
     * numbers, take the biggest. It is still there, as the CANDIDATE; what must not come back is assigning it
     * straight to the watermark.
     */
    assert.match(src, /highestSeq = resolveWatermark\(\{/, 'the receive watermark must go through the rule');
    assert.match(src, /maxSeqPushed = resolveWatermark\(\{/, 'and so must the push watermark');
    assert.doesNotMatch(src, /highestSeq = Math\.max\(/,
      'the receive watermark is assigned a bare max again — that is the defect verbatim');
    assert.doesNotMatch(src, /maxSeqPushed = Math\.max\(/,
      'the push watermark is assigned a bare max again — that is the defect verbatim');
  });

  it('EVERY transfer on each side, tombstones included — and the list is derived', () => {
    /*
     * Counted, because an omitted transfer places NO ceiling and is therefore exactly the one that gets
     * skipped. Tombstones are the one most likely to be left out: they are fetched and sent in their own block,
     * before the loop over the document collections, and they do not look like "a type".
     *
     * They are also the transfer where the loss is worst — a deletion that never propagates, on a pull whose
     * `!resp.ok` branch used to be completely silent.
     *
     * ## The count is DERIVED now, and this test is the argument for it
     *
     * It asserted `keys.length === 5` against a hand-written list of five names, and the FILE was called
     * `one-watermark-four-transfers` while the test said FIVE — so the number had already gone stale once, in
     * the name, where nothing checks it. `M-2` added a sixth and it went stale again.
     *
     * A count somebody typed can only be right about the day it was typed, so this reads
     * `BRAIN_COLLECTIONS`. A new collection now makes this gate DEMAND its transfer instead of quietly
     * accepting its absence.
     *
     * **`files` used to be filtered out of this list, and the reason it gave stopped being true.** It read
     * *"a file crosses the wire as a blob plus a manifest entry, not as a document in this loop"* — correct
     * until `P-32` made a file's METADATA replicate like every other record. A filter with a stale reason
     * beside it is the shape that survives review, because the sentence still reads well.
     *
     * The transfer KEY is `filemeta` where the collection is `files`, one word apart on purpose: the route
     * serves metadata and `/api/files` serves bytes.
     */
    /*
     * ## The SET moved, and this gate had to move with it — which is the point rather than a chore
     *
     * Each call site used to inline `transfers: { … }` and then compute `candidate` as a SECOND
     * hand-written list beside it. Pull's named six families, push's five, and `filemeta` was the one
     * missing — so it could hold that watermark back and never advance it. `Q-2` removed the second list
     * by deriving the candidate from the transfers, and the set is now a named object each side builds
     * once and passes to both consumers.
     *
     * So this reads the object rather than the argument. Tombstones are asserted separately, because they
     * are now `alsoCheck` — bounding the advance without raising it, which is what they always did and
     * what an exclusion list said less clearly.
     */
    /*
     * READ FROM THE FAMILY LIST, not from two object literals. `A-12` replaced the inline
     * `const pulled = { … }` / `const pushed = { … }` with a loop over `REPLICATED_FAMILIES`, so each
     * direction's transfer set is now the list BY CONSTRUCTION — which is strictly stronger than two
     * literals that happened to agree, and is why this reads the list instead.
     *
     * The pair of literals is what this used to check, and it is exactly the shape it existed to
     * prevent: two hand-written lists of one thing.
     */
    const expected = BRAIN_COLLECTIONS.map(c => (c === 'files' ? 'filemeta' : c));
    assert.ok(expected.length >= 5, `only ${expected.length} expected transfers — BRAIN_COLLECTIONS did not load`);
    const families = readFileSync('server/src/sync/replicated-families.ts', 'utf8');
    const table = families.slice(families.indexOf('REPLICATED_FAMILIES'), families.indexOf('] as const'));
    const keys = [...table.matchAll(/payloadKey: '([a-z]+)'/g)].map(m => m[1]);
    {
      assert.deepEqual([...keys].sort(), [...expected].sort(),
        `the replicated-family list is not every replicated collection: ${keys.join(', ')}`);
    }
    assert.equal([...src.matchAll(/alsoCheck: \{ tombstones \}/g)].length, 2,
      'tombstones must bound BOTH directions — an omitted transfer places no ceiling, which makes it the '
      + 'one that gets skipped');
    assert.doesNotMatch(src, /candidate: Math\.max\(/,
      'a second hand-written list of the families is back beside the set it duplicates');
  });

  /*
   * ## "Complete through", restated (bundle-52, `Q-277`)
   *
   * `deliveredThrough` is the last seq a transfer is COMPLETE through — not "the last seq delivered", which is what these
   * cases used to read. The two differ at exactly one place, and it is the place that loses records: a stop inside a run of
   * records that share a seq (several authors' records keep their author's seq) has delivered the seq without finishing it.
   * The rule is held in two modules, once each — `pageSeqRuns` for a pull, `pushSeqRuns` for a push — and the cases below
   * hold what the engine's side of it still owns: every transfer is passed, and the per-family transfers hand the position
   * the rule computed to `resolveWatermark` unchanged. Their behaviour is `a-seq-run-pager-never-skips-a-tie` and the -db
   * suites over the real engine.
   */
  const pager = stripComments(readFileSync('server/src/sync/seq-run-pager.ts', 'utf8'));
  const pushLoop = stripComments(readFileSync('server/src/sync/push-seq-runs.ts', 'utf8'));
  const pullFamily = stripComments(readFileSync('server/src/sync/pull-family.ts', 'utf8'));
  const pushFamily = stripComments(readFileSync('server/src/sync/push-family.ts', 'utf8'));

  it('the pull records its position only AFTER the page is applied', () => {
    // Vouching before the write would promise records that a throw between the two would have lost — the same class of
    // mistake one layer down. The page is written in `deliver` by the arrival writer (`writeArrivals`, 5.6.2 `Q-218`); the
    // pager moves `deliveredThrough` only after `deliver` has returned null, and a reason it hands back — a failed write, a
    // counter that could not be moved, a store refusal (cut `C3`) — stops the transfer before any advance.
    const accept = pullFamily.search(/=\s*await writeArrivals\(/);
    assert.ok(accept > 0, 'the pull no longer writes its page through the arrival writer — re-anchor this gate');
    const deliver = pager.search(/const refusal = await o\.deliver\(fresh\);/);
    assert.notEqual(deliver, -1, 'the pager no longer hands a page to `deliver` — re-anchor this gate');
    const advances = [...pager.matchAll(/outcome\.deliveredThrough = /g)].map(m => m.index);
    assert.ok(advances.length >= 3, `the pager advances deliveredThrough at ${advances.length} place(s) — re-anchor this gate`);
    assert.ok(advances.every(i => i > deliver), 'deliveredThrough is advanced before the page was handed on, not after');
    const refusalAt = pager.indexOf('if (refusal !== null)', deliver);
    assert.notEqual(refusalAt, -1, 'the pager no longer checks what `deliver` handed back — re-anchor this gate');
    assert.match(statementFrom(pager, refusalAt, 'the refusal branch'), /stop\(refusal\); return;/,
      'a page whose write failed must stop the transfer as truncated, before the advance');
    const settle = pullFamily.indexOf('const seen = settlePulledPage(', accept);
    assert.ok(settle > accept, 'the pull no longer settles its page after the write — re-anchor this gate');
    assert.match(pullFamily.slice(accept, settle), /catch \(err\) \{\s*\n\s*return `sync pull/,
      'a failed page write must be handed back as a reason, not rethrown past the pager');
    assert.match(pullFamily.slice(accept, settle), /if \(written\.storeRefused\.length > 0\) \{[\s\S]*?return `/,
      'a page the store refused a document of must stop the transfer as truncated, before the advance');
  });

  it('the page cap counts as a truncation', () => {
    // Easy to miss, because nothing failed. The loop reaches its bound with the peer still having more to give.
    // Both loops stop at the bound through the ONE helper (`stopAtPageBound`), which stops through the ONE stop
    // (`stopTransfer`), which is where `truncated` is set — each link is held, so the chain cannot be cut unseen.
    assert.match(pager, /if \(stopAtPageBound\(outcome, o\.stopped, pages, maxPages\)\) return;/,
      'a pager at its page bound must stop (and so set truncated), or the watermark passes what was not fetched');
    assert.match(pushLoop, /if \(stopAtPageBound\(outcome, o\.stopped, pages, o\.maxPages\)\) return;/,
      'a push at its page bound must stop (and so set truncated)');
    assert.match(pager, /const stop = \(why: string\): void => stopTransfer\(outcome, o\.stopped, why\);/, 'a stop must go through stopTransfer');
    const wm = stripComments(readFileSync('server/src/sync/watermark.ts', 'utf8'));
    assert.match(wm, /function stopTransfer\([^)]*\): void \{\s*outcome\.truncated = true;/, 'stopTransfer no longer marks the transfer truncated');
    assert.match(wm, /function stopAtPageBound\([\s\S]*?stopTransfer\(outcome, stopped,/, 'stopAtPageBound no longer stops through stopTransfer');
  });

  it('a stop inside a run reports the seq before it, in both directions', () => {
    // The rule, as one sentence each, spelled once in `completeThrough`. Pull: a pair cursor sitting inside the highest
    // admitted seq's run holds that seq minus one. Push: a FULL page may continue at its last seq, a short one cannot.
    assert.match(pager, /completeThrough\(pageHighest, pageHighest >= pair\.seq\)/,
      'the pull no longer reports a seq it is still inside as incomplete');
    assert.match(pushLoop, /completeThrough\(last\.seq, full\)/, 'the push no longer reports a seq it is still inside as incomplete');
    assert.equal(completeThrough(7, true), 6, 'a run that may continue is complete through the seq before it');
    assert.equal(completeThrough(7, false), 7, 'a run that cannot continue is complete through its own seq');
    assert.equal(completeThrough(0, true), 0, 'there is nothing before seq 0 to be complete through');
    for (const [name, src] of [['pull', pager], ['push', pushLoop], ['pull-family', pullFamily], ['push-family', pushFamily]]) {
      assert.doesNotMatch(src, /\b(?:[a-z]*[sS]eq|fullLast|pageHighest|highestAdmitted)\s*-\s*1\b/, `${name} subtracts one from a seq by hand again: that is \`completeThrough\``);
    }
  });

  it('the push caps with the ACCEPTED position, not the author-guarded one', () => {
    // `localMaxSeq` answers "how far did our own records reach"; the outcome's `deliveredThrough` answers "how far is the
    // peer complete". On pubsub and braintree networks `owned` is empty and we relay foreign docs, so capping with the
    // author-guarded number would advance past a relayed doc the peer never accepted. (Moved with `pushCollection` to
    // `pushFamily`: the outcome is the one `pushSeqRuns` fills, spread into the result.)
    assert.match(pushFamily, /return \{ pushed, maxSeq: localMaxSeq, refused, \.\.\.outcome \};/,
      'the push ceiling must be the position `pushSeqRuns` reports, which is the last accepted seq');
    assert.doesNotMatch(pushFamily, /deliveredThrough[:=]\s*localMaxSeq/,
      'the author-guarded max answers a different question and would leave relayed docs strandable');
    assert.match(pushFamily, /await pushSeqRuns</, 'the family push no longer goes through the push loop that owns the position');
  });

  it('a pull tombstone fetch that failed is no longer silent, and both halves live together', () => {
    /*
     * The pull had no `else` at all: a non-ok response applied nothing, logged nothing, and the watermark
     * advanced past the deletions anyway. The push side had a warn for the identical case — one protocol phase,
     * two implementations, twenty lines apart in a thousand-line file, and the weaker one silently won.
     *
     * Both halves now live in `sync/tombstone-transfer.ts` so they cannot be read separately again, which is why
     * this assertion reads that file rather than the engine.
     */
    const ts = stripComments(readFileSync('server/src/sync/tombstone-transfer.ts', 'utf8'));
    assert.match(ts, /export async function pullTombstones/, 'the pull half must live here');
    assert.match(ts, /export async function pushTombstones/, 'and so must the push half');
    /*
     * The COUNT of `outcome.truncated = true` that stood here is gone (bundle-46 plan row 10): it counted spellings,
     * and the tie-safe pager adds stops (a page of one seq, the page bound) that are truncations by behaviour. What
     * it stood for is held by `a-tombstone-transfer-delivers-all-or-holds-db`: a stop for any reason answers
     * truncated, warns, and caps the record watermark.
     */
    // And the engine must not have grown its own copy back.
    assert.doesNotMatch(src, /api\/sync\/tombstones\?spaceId=/,
      'the engine is building a tombstone URL again — that is the second implementation coming back');
  });
});
