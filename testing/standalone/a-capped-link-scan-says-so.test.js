/**
 * A link scan that stopped reading says so, and the caller reports it.
 *
 * ## The claim that was not true
 *
 * The commit that bounded the two link scans said hitting the bound *"is reported through the existing
 * `graphTruncated` / `graphComplete` spill"*, and the docblock repeated it. Neither traversal could report it,
 * so a short graph was presented as a whole one — which is worse than the unbounded scan it replaced, because
 * an incomplete answer that says nothing is indistinguishable from a complete one.
 *
 * ## Why the existing signal cannot see it
 *
 * The cursor limit is spent on documents that are then DISCARDED: `.limit(remaining)` runs before
 * `if (visited.has(doc._id)) continue`. A record already emitted at an earlier hop — an ordinary chrono entry
 * naming both an entity and its neighbour — is re-matched by the next hop, consumes a slot, and contributes
 * nothing. The walk then ends BELOW `limit`, and `traverseGraph`'s only truncation signal is
 * `resultNodes.length >= limit`, so it answers `false`. On the recall path the same shortfall keeps the flat
 * list under the inline cap, so no spill is written either.
 *
 * `entitiesLinkedFromRecords` has a second version of it: `remaining` is `limit - out.length` where `out`
 * counts LINKS EMITTED while `.limit()` bounds RECORDS READ, so a few link-dense seeds drive `remaining` to 0
 * and return before a whole later class is read at all.
 *
 * ## The signal this pins
 *
 * "The scan stopped reading" is not "the result filled up", and only the first one is knowable at the cursor.
 * If a cursor returned exactly as many documents as it was allowed, there may be more; if `remaining` reached
 * zero, a whole class went unread. Either way the answer is short and the caller has to be told.
 *
 * Run: node --test testing/standalone/a-capped-link-scan-says-so.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const read = (p) => stripComments(readFileSync(p, 'utf8'));
const FRONTIER = 'server/src/brain/link-frontier.ts';
const EDGES = 'server/src/brain/edges.ts';
/*
 * The recall walk moved to its own module in A-4 while the standalone `traverseGraph` stayed. Read each from
 * where it lives: a gate left pointing at the old file fails several assertions at once, which reads as broken
 * production code rather than one moved module.
 */
const SEEDS = 'server/src/brain/recall-seed-traversal.ts';
const ROWS = 'server/src/brain/row-graphs.ts';

/*
 * THE READING FUNCTIONS, which is not the same list as the two exported scans.
 *
 * `linkedRecordsAtFrontier` no longer reads: it computes the bound and hands it to the helper that does,
 * one query for the whole hop. There were two helpers while the arrays were a second storage shape, and
 * the batched one is where the measured 3.8× regression on the link path went — see
 * `benchmarks/LINK-READERS.md`.
 *
 * So the property is asserted where the read happens, and separately that the caller still forwards a
 * bound. Checking only the exported name would have gone green on a helper that reads unbounded.
 */
const SCANS = ['linkedRecordsFromRows', 'entitiesLinkedFromRecords'];

/** The two exported scans, which must still compute a bound and report what their helper found. */
const EXPORTED = ['linkedRecordsAtFrontier', 'entitiesLinkedFromRecords'];

describe('a bounded scan reports that it stopped early', () => {
  for (const fn of SCANS) {
    it(`${fn} tells its caller the scan was capped`, () => {
      const body = bodyOf(read(FRONTIER), fn);
      // `capped` OR `scanCapped`: the two helpers report the flag under the shorter name and the exported
      // scans under the longer one. The RULE is that a truncated read is reported at all.
      assert.match(body, /[Cc]apped/,
        `${fn} returns a bare array, so a caller cannot tell a complete answer from a truncated one`);
    });

    it(`${fn} counts a FULL cursor as capped, not only an exhausted budget`, () => {
      /*
       * The half that hides. Returning exactly `remaining` documents means the database stopped handing them
       * over — there may be more behind it — and that is true whether or not any of them survived the
       * visited filter. A rule that only fires when `remaining` reaches zero misses every case where the
       * limit was spent on records that were then discarded, which is the reported failure.
       */
      /*
       * THE PROBE (Q-126). The cursor is asked for ONE row more than the budget, so "more rows than the
       * budget came back" is the test — strictly greater. It replaced `length >= remaining`, which could not
       * tell a read that ended exactly at the budget from one that stopped there, and so called every
       * exactly-full neighbourhood capped. Under the whole-row rule a capped scan LEAVES THE ROW OUT, so that
       * false positive now costs a caller a record rather than a flag.
       *
       * Measured on the LINK ROWS, before they are resolved to records: two rows naming one record would make
       * the record count the smaller number on exactly the dense neighbourhoods the bound exists for.
       */
      const body = bodyOf(read(FRONTIER), fn);
      assert.match(body, /rows\.length\s*>\s*remaining/,
        `${fn} does not notice a cursor that came back over its budget, which is the case the bound actually hits`);
      assert.doesNotMatch(body, /length\s*>=\s*remaining/,
        `${fn} counts an exactly-full read as capped again, and a complete row would be left out`);
    });
  }

  it('each exported scan asks its cursor for the probe row', () => {
    // Without the `+ 1` the strict test above can never fire: a cursor limited to `remaining` returns at
    // most `remaining`, so every capped read would be reported complete.
    const src = read(FRONTIER);
    for (const fn of EXPORTED) {
      assert.match(bodyOf(src, fn), /remaining \+ 1/, `${fn} does not ask for the probe row`);
    }
  });

  it('both scans are covered — neither is left as the weaker copy', () => {
    // One rule, several implementations, the weaker winning silently is this repo's signature defect, and
    // these are the same rule once per storage shape by construction.
    const src = read(FRONTIER);
    for (const fn of SCANS) {
      assert.match(bodyOf(src, fn), /[Cc]apped/, `${fn} was left behind`);
    }
  });

  it('and the exported scan FORWARDS what its helper found, rather than dropping it', () => {
    /*
     * The seam the split created. A helper that reports a capped read into a caller that ignores it is a
     * bound with no signal — the answer comes back short and flagged complete, which is the exact failure
     * this whole file exists for, relocated one function inward.
     */
    const src = read(FRONTIER);
    const body = bodyOf(src, 'linkedRecordsAtFrontier');
    assert.match(body, /\.capped\)\s*scanCapped = true|if \(rows\.capped\)/,
      'linkedRecordsAtFrontier drops its helper\'s capped flag');
    for (const fn of EXPORTED) {
      assert.match(bodyOf(src, fn), /scanCapped/, `${fn} no longer reports truncation at all`);
    }
  });
});

describe('an EXHAUSTED budget is reported too, where a whole class goes unread', () => {
  /*
   * Returning early because the budget reached zero means later link classes were never queried at all.
   * Nothing was discarded, so it does not feel like a truncation — and it is the larger one.
   *
   * **`linkedRecordsFromRows` is deliberately not on this list.** It issues ONE query for the whole hop, so
   * there is no later class for a spent budget to skip; the zero check lives in its caller, which is on the
   * list. That is the batching this file's numbers come from — see `benchmarks/LINK-READERS.md`.
   */
  for (const fn of ['linkedRecordsAtFrontier', 'entitiesLinkedFromRecords']) {
    it(`${fn} says so`, () => {
      const body = bodyOf(read(FRONTIER), fn);
      assert.match(body, /(remaining|left) === 0[^\n]*[Cc]apped: true/,
        `${fn} returns on an exhausted budget without saying the answer is short`);
    });
  }
});

describe('and the caller turns that into a truncation the API states', () => {
  it('traverseGraph answers truncated when a scan was capped', () => {
    /*
     * Its own signal is `resultNodes.length >= limit` — the result FILLED UP. A capped scan ends below the
     * limit, so without this the walk falls through to `answer(false)` and calls a short neighbourhood
     * complete.
     */
    const body = bodyOf(read(EDGES), 'traverseGraph');
    /*
     * Asserted on the MECHANISM rather than on the identifier appearing somewhere in the body. The first
     * version of this file checked only that `scanCapped` was mentioned, and six of eight mutants survived
     * it — deleting any one propagation left the others, and the word was still there. A gate whose subject
     * is a string it also writes cannot fail.
     */
    assert.doesNotMatch(body, /return answer\(false\)/,
      'the walk still ends by declaring the neighbourhood complete, whatever the scans reported');
    assert.match(body, /return answer\([A-Za-z]*[Cc]apped\)/,
      'the final answer is not derived from whether a scan stopped reading');
    assert.match(body, /hopScanCapped\)\s*scanCapped = true/,
      'a hop that capped does not raise the walk-level flag, so only the last hop could ever be reported');
  });

  it('the recall path carries it too, so both surfaces agree', () => {
    // Every traversing door answers through the one row walker, so the fix lands where they share it rather
    // than on either door — otherwise a short graph would be reported by one client and not the other.
    // Q-126: a row whose scan stopped reading is not returned short; it is left out and named `link_scan`.
    assert.match(bodyOf(read(ROWS), 'whyRowIsShort'), /walk\.scanCapped\)\s*return 'link_scan'/,
      'the row judgement drops the signal, so a recall returns a short graph as a whole one');
    assert.match(bodyOf(read(ROWS), 'rowGraphWalker'), /const short = whyRowIsShort\(walk,[^;]*;\s*if \(short\) return \{ incomplete: short \}/,
      'the row walker does not act on the judgement, so a short row is returned anyway');

    /*
     * BOTH of the recall walk's scans, and they are separate code paths: a seed pre-pass that follows a
     * matched record's links out to entities, and the per-hop scan. Counting the propagations is what
     * makes deleting either one visible — checking that "capped is set somewhere" passes with one of the two
     * gone, which is the same defect this whole file is about.
     */
    const seeds = bodyOf(read(SEEDS), 'traverseFromSeeds');
    assert.equal((seeds.match(/[Cc]apped\)\s*capped = true/g) ?? []).length, 2,
      'one of the recall walk\'s two scans does not raise the flag — the pre-pass and the per-hop scan both must');
  });
});
