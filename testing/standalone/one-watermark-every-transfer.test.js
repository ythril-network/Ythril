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
 * So: a transfer that ran to completion places no ceiling; one that stopped early vouches only up to what it
 * delivered; the watermark advances to the lowest such ceiling. Nothing is skipped and a capped transfer still
 * makes a full page-set of progress per cycle.
 *
 * Run: node --test testing/standalone/one-watermark-four-transfers.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
// The collection list itself, so the transfer count below is derived rather than typed. Read from `dist`
// the way every other gate that needs a server value does — preflight builds it first for exactly this.
import { BRAIN_COLLECTIONS } from '../../server/dist/config/types.js';

const { safeWatermark, truncatedTransfers } = await import('../../server/dist/sync/watermark.js');

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

  it('the pull records its position only AFTER the page is applied', () => {
    // Vouching before the upsert would promise records that a throw between the two would have lost — the same
    // class of mistake one layer down.
    assert.match(src, /await batchUpsertBySeq<T>\([^\n]*\);\s*\n\s*if \(maxSeq > deliveredThrough\) deliveredThrough = maxSeq;/,
      'deliveredThrough must be advanced after the batch upsert, not before');
  });

  it('the page cap counts as a truncation', () => {
    // Easy to miss, because nothing failed. The loop exits with a live cursor and the transfer has more to give.
    assert.match(src, /if \(cur\) \{\s*\n\s*truncated = true;/,
      'a live cursor at the page cap must set truncated, or the watermark passes what was not fetched');
  });

  it('the push caps with the ACCEPTED position, not the author-guarded one', () => {
    // `localMaxSeq` answers "how far did our own records reach"; `seqCursor` answers "how far did this transfer
    // get at all". On pubsub and braintree networks `ownedFilter` is empty and we relay foreign docs, so
    // capping with the author-guarded number would advance past a relayed doc the peer never accepted.
    assert.match(src, /deliveredThrough: seqCursor, truncated \}/,
      'the push ceiling must be the last accepted seq');
    assert.doesNotMatch(src, /deliveredThrough: localMaxSeq/,
      'the author-guarded max answers a different question and would leave relayed docs strandable');
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
    assert.equal((ts.match(/outcome\.truncated = true;/g) ?? []).length, 3,
      'expected three truncation points: the pull non-ok, the pull throw, and the push non-ok');
    // And the engine must not have grown its own copy back.
    assert.doesNotMatch(src, /api\/sync\/tombstones\?spaceId=/,
      'the engine is building a tombstone URL again — that is the second implementation coming back');
  });
});
