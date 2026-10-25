/**
 * A shared sync mark may not advance past a transfer that stopped early.
 *
 * ## The defect
 *
 * `lastPosPushed` and `lastPosReceived` are ONE number per member per space (per network row), and each cycle runs SEVEN independent transfers under it —
 * the tombstones and the six record families. Each can stop early on its own: a non-`ok` response, a throw, or the cycle's page cap.
 *
 * Both marks were once set to the **maximum** across them. So a facts push that failed at position 300, in a cycle where entities succeeded to 500, moved the
 * mark to 500 — and the fact at 400 was behind it **for ever**. Nothing errored at the cycle level and every later cycle reported success while never sending it again.
 *
 * ## Why the existing guards do not cover it
 *
 * They are about a different axis. A transfer's `deliveredThrough` says whether THAT transfer finished; only the rule over every transfer says where the shared
 * mark may stand.
 *
 * ## The rule, and the wrong fix it replaces
 *
 * "Never advance when something was truncated" **livelocks**: a transfer that stopped at its page cap has more to give, so the next cycle re-fetches the same
 * pages and stops in the same place for ever, and a space more than one cap behind can never catch up. That trades losing one record for syncing nothing.
 *
 * So (bundle-81, design rev 8 §6): every transfer says where it is COMPLETE (`deliveredThrough`: a transfer that ran to the end says the settled end of the peer's
 * stream it read, one that stopped says the position before the run it stopped inside), and **the mark is the MINIMUM over every transfer** and never below where
 * the cycle started. Nothing is skipped, a write that landed between two families' reads stays above the mark, and a capped transfer still makes a full page-set of
 * progress per cycle. A cycle that moved only tombstones moves the mark (Q-394): they are a transfer of the same stream, not a ceiling beside it.
 *
 * "Complete through" is not "delivered through" (bundle-52, `Q-277`): relayed records of the legacy band share positions, so a transfer that stopped inside a run
 * of equal positions has delivered that position without finishing it, and vouches for the position BEFORE it. `safeWatermark` is the pure half (below); the
 * engine-side cases at the end hold the modules that compute the position — the pull's pager and the push's loop.
 *
 * Run: node --test testing/standalone/one-watermark-every-transfer.test.js
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

const { safeWatermark, stoppedTransfers, completeThrough, stopTransfer, resolveWatermark } = await import('../../server/dist/sync/watermark.js');

/** A transfer that ran to the end and is complete through `n`. */
const done = (n = 0) => ({ deliveredThrough: n, truncated: false });
/** A transfer that stopped after delivering through `n` (by default for a fault). */
const stopped = (n, stoppedBy = 'error') => ({ deliveredThrough: n, truncated: true, stoppedBy });

describe('the mark stops at what the slowest transfer is complete through', () => {
  it('THE DEFECT: a transfer that stopped caps the advance below what a finished one reached', () => {
    // The exact case: facts failed at 300, entities finished to 500. The old rule wrote 500 and stranded the fact at 400.
    assert.equal(safeWatermark(100, [stopped(300), done(500), done(500), done(500), done(500)]), 300,
      'the mark must not pass a record the peer never served');
  });

  it('every transfer complete — the mark is the lowest of what they reached, and it moves there', () => {
    // The common case must cost nothing: a cycle in which each transfer read to the end of the stream moves the mark to where the earliest read ended.
    assert.equal(safeWatermark(100, [done(500), done(500), done(480), done(500)]), 480);
    assert.equal(safeWatermark(100, [done(500), done(500)]), 500);
  });

  it('two stopped — the LOWEST position wins', () => {
    assert.equal(safeWatermark(100, [stopped(400), done(900), stopped(250), done(900)]), 250,
      'every transfer must be complete through the result, so the lowest is the only safe one');
  });

  it('the MINIMUM, not the maximum: a write that landed between two reads stays above the mark', () => {
    assert.equal(safeWatermark(0, [done(300), done(500)]), 300);
  });

  it('NEVER goes backwards, even when a transfer stopped before the current mark', () => {
    /*
     * The livelock guard, and the one that stops this fix being worse than the defect.
     *
     * A transfer that fails on its FIRST page reports `deliveredThrough` at the old mark, or below it if a cursor was behind. Letting that rewind the mark
     * would re-send everything since, every cycle, for as long as one peer kept refusing — turning one lost record into unbounded repeated work. (The one rewind
     * is the `head` guard's: the puller forgets the mark itself, `a-puller-ahead-of-its-peers-head-re-reads-db`.)
     */
    assert.equal(safeWatermark(400, [stopped(100), done(500)]), 400, 'a rewind would re-do unbounded work');
    assert.equal(safeWatermark(400, [stopped(0)]), 400);
    assert.equal(safeWatermark(400, [done(300)]), 400, 'nor may a lower position rewind it');
  });

  it('progress is still made when the page cap truncates', () => {
    // The reason "never advance on truncation" was rejected. A capped transfer delivered a full page-set, and the mark must move to the end of it or the next
    // cycle repeats the same fetch for ever.
    assert.equal(safeWatermark(0, [stopped(10_000, 'cap'), done(20_000), done(20_000), done(20_000)]), 10_000,
      'a capped transfer must still advance by what it delivered');
    assert.equal(safeWatermark(10_000, [stopped(20_000, 'cap'), done(30_000)]), 20_000, 'and the next cycle moves on from there');
  });

  it('an empty transfer list leaves the mark where it was', () => {
    // A turn that was stopped before any transfer ran: nothing is vouched for, so nothing moves — and it must never mean "no ceiling".
    assert.equal(safeWatermark(100, []), 100);
  });

  it('stoppedTransfers names them by kind, so a held-back cycle is never silent and a cap is told from a fault', () => {
    const all = [
      { ...stopped(1), label: 'facts' }, { ...done(5), label: 'entities' },
      { ...stopped(2, 'cap'), label: 'tombstones' }, { ...stopped(3), label: 'links' },
    ];
    assert.deepEqual(stoppedTransfers(all, 'error'), ['facts', 'links']);
    assert.deepEqual(stoppedTransfers(all, 'cap'), ['tombstones']);
    assert.deepEqual(stoppedTransfers([{ ...done(5), label: 'facts' }], 'error'), [], 'a healthy cycle must produce no message at all');
    assert.deepEqual(stoppedTransfers([{ deliveredThrough: 1, truncated: true, label: 'x' }], 'error'), ['x'], 'a truncated transfer that says nothing is read as a fault');
  });
});

/*
 * Q-624 (design rev 4 section 5.4, re-anchor table): a family a peer HOLDS (the receiver is building its edge identity index) is a third stop reason beside the
 * page cap and a fault. `stopTransfer(outcome, stopped, why, 'held')` is the one call that sets it, on the push and the pull side. It stops the family at its
 * last landed position and moves the shared mark no further (it is a transfer like any other under `safeWatermark`), but it is NOT a fault: a transfer that
 * stops with a stop string and no reason is filed as a failure, and a failure of the member approaches `PEER UNREACHABLE` for a hold that lasts one owed-job tick.
 * `resolveWatermark` therefore reports it apart, in a `held` list, and says so in its warning.
 */
describe('a held family stops like a capped one, is told from a fault and from a cap, and is named', () => {
  it('stopTransfer(…, held) marks the transfer truncated and says it was held', () => {
    const outcome = { deliveredThrough: 40, truncated: false };
    const said = [];
    stopTransfer(outcome, (why, heldAt) => said.push([why, heldAt]), 'the receiver is building its edge identity index', 'held');
    assert.deepEqual([outcome.truncated, outcome.stoppedBy], [true, 'held']);
    assert.deepEqual(said, [['the receiver is building its edge identity index', 40]], 'the stop says why, at the position it is held at');
    const capped = { deliveredThrough: 1, truncated: false };
    stopTransfer(capped, () => {}, 'bound', 'cap');
    assert.equal(capped.stoppedBy, 'cap', 'the cap is unchanged');
    const faulted = { deliveredThrough: 1, truncated: false };
    stopTransfer(faulted, () => {}, 'refused');
    assert.equal(faulted.stoppedBy, 'error', 'the default stays a fault');
  });

  it('the third reason is part of the type, not only of what the JavaScript happens to accept', () => {
    // The two functions above take any string at run time, so the cases pass on a build that never declared the reason: the declaration is what makes
    // `held` something a caller may write, and what the member-exchange types (`MemberExchange.held`) are read from.
    const wm = stripComments(readFileSync('server/src/sync/watermark.ts', 'utf8'));
    assert.match(wm, /stoppedBy\?:\s*'cap'\s*\|\s*'held'\s*\|\s*'error'/, 'TransferOutcome.stoppedBy does not declare the held reason');
    assert.match(wm, /function stopTransfer\([^)]*by:\s*'cap'\s*\|\s*'held'\s*\|\s*'error'/, 'stopTransfer does not take the held reason');
    assert.match(wm, /function stoppedTransfers\([^)]*by:\s*'cap'\s*\|\s*'held'\s*\|\s*'error'/s, 'stoppedTransfers cannot list the held families');
  });

  it('stoppedTransfers names the held families, and a held one is neither an error nor a cap', () => {
    const all = [
      { ...stopped(1, 'held'), label: 'edges' }, { ...done(5), label: 'facts' },
      { ...stopped(2, 'cap'), label: 'tombstones' }, { ...stopped(3), label: 'links' },
    ];
    assert.deepEqual(stoppedTransfers(all, 'held'), ['edges']);
    assert.deepEqual(stoppedTransfers(all, 'error'), ['links'], 'a held family is not counted a fault: the member would approach PEER UNREACHABLE');
    assert.deepEqual(stoppedTransfers(all, 'cap'), ['tombstones']);
  });

  it('the mark stops at the held family\'s position, exactly as it stops at a capped one', () => {
    assert.equal(safeWatermark(100, [stopped(300, 'held'), done(500), done(500)]), 300);
    assert.equal(safeWatermark(100, [stopped(300, 'held')]), safeWatermark(100, [stopped(300, 'cap')]), 'held is treated as cap by the mark');
    assert.equal(safeWatermark(400, [stopped(100, 'held'), done(500)]), 400, 'and never goes backwards');
  });

  it('resolveWatermark returns a held list apart from errored and capped, and its warning names the held family', () => {
    const warnings = [];
    const r = resolveWatermark({
      direction: 'receive', peerLabel: 'peer', spaceId: 's', from: 100, warn: m => warnings.push(m),
      transfers: { facts: done(500), edges: stopped(300, 'held'), links: stopped(400, 'cap'), chrono: stopped(450) },
    });
    assert.equal(r.at, 300, 'the mark stops at the lowest position: the held family\'s');
    assert.deepEqual(r.held, ['edges'], 'resolveWatermark does not report the held families');
    assert.deepEqual(r.capped, ['links']);
    assert.deepEqual(r.errored, ['chrono']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /edges/, 'the warning does not name the held family');
    const quiet = resolveWatermark({ direction: 'push', peerLabel: 'peer', spaceId: 's', from: 0, warn: m => warnings.push(m), transfers: { facts: done(5) } });
    assert.deepEqual(quiet.held, [], 'a healthy cycle holds nothing');
  });
});

describe('every transfer under a shared mark is passed to the rule', () => {
  // The cycle is the engine plus the per-space turn it hands each space to (`sync/space-exchange.ts`, bundle-106 §3.4).
  const src = ['server/src/sync/engine.ts', 'server/src/sync/space-exchange.ts'].map(f => stripComments(readFileSync(f, 'utf8'))).join('\n');

  it('both marks go through the rule rather than a bare Math.max', () => {
    /*
     * THE OMISSION IS THE REGRESSION, and it looks like nothing. `Math.max(facts.at, entities.at, …)` reads as obviously right — take the biggest — and is the
     * defect verbatim. What must not come back is assigning a maximum straight to the mark.
     */
    assert.equal([...src.matchAll(/resolveWatermark\(\{/g)].length, 2, 'both the receive mark and the push mark must go through the rule, once each');
    assert.match(src, /direction: 'receive'/, 'the receive mark must go through the rule');
    assert.match(src, /direction: 'push'/, 'and so must the push mark');
    assert.doesNotMatch(src, /Math\.max\([^)]*(?:highSeq|maxSeq|at\b)/, 'a mark is assigned a bare max again — that is the defect verbatim');
  });

  it('EVERY transfer on each side, tombstones included — and the list is derived', () => {
    /*
     * Counted, because an omitted transfer places NO ceiling and is therefore exactly the one that gets skipped. Tombstones are the one most likely to be left out:
     * they are fetched and sent in their own block, before the loop over the families, and they do not look like "a type".
     *
     * ## The count is DERIVED, and this test is the argument for it
     *
     * A count somebody typed can only be right about the day it was typed, so this reads `BRAIN_COLLECTIONS`: a new collection makes this gate DEMAND its transfer
     * instead of quietly accepting its absence. The transfer KEY is `filemeta` where the collection is `files`, one word apart on purpose: the route serves
     * metadata and `/api/files` serves bytes. Each direction's transfer set is the family list by construction (a loop over `REPLICATED_FAMILIES`), which is
     * strictly stronger than two literals that happened to agree.
     *
     * bundle-81: tombstones are IN the set (`{ tombstones, ...pulled }`, `{ tombstones, ...pushed }`), a transfer of the same stream like every family, where
     * 5.6 passed them as `alsoCheck` (a ceiling that could lower the mark and never raise it: a tombstone-only cycle moved nothing, Q-394).
     */
    const expected = BRAIN_COLLECTIONS.map(c => (c === 'files' ? 'filemeta' : c));
    assert.ok(expected.length >= 5, `only ${expected.length} expected transfers — BRAIN_COLLECTIONS did not load`);
    const families = readFileSync('server/src/sync/replicated-families.ts', 'utf8');
    const table = families.slice(families.indexOf('REPLICATED_FAMILIES'), families.indexOf('] as const'));
    const keys = [...table.matchAll(/payloadKey: '([a-z]+)'/g)].map(m => m[1]);
    assert.deepEqual([...keys].sort(), [...expected].sort(), `the replicated-family list is not every replicated collection: ${keys.join(', ')}`);
    assert.equal([...src.matchAll(/transfers: \{ tombstones, \.\.\.(?:pulled|pushed) \}/g)].length, 2,
      'tombstones must be a transfer under BOTH marks — an omitted transfer places no ceiling, which makes it the one that gets skipped, and a cycle of only deletions must move the mark');
    assert.doesNotMatch(src, /alsoCheck/, 'tombstones are a ceiling beside the transfers again: a tombstone-only cycle moves nothing');
  });

  /*
   * ## "Complete through", restated (bundle-52, `Q-277`; bundle-81)
   *
   * `deliveredThrough` is the last POSITION a transfer is COMPLETE through — not "the last position delivered". The two differ at exactly one place, and it is the
   * place that loses records: a stop inside a run of records that share a position (the legacy band) has delivered the position without finishing it. The rule is held
   * in two modules, once each — `pagePositionRuns` for a pull and `pushPositionRuns` for a push — and the cases below hold what the engine's side of it still owns:
   * every transfer is passed, and the per-family transfers hand the position the rule computed to `resolveWatermark` unchanged. Their behaviour is
   * `a-position-run-pager-never-skips-a-tie` and the -db suites over the real engine.
   */
  const pager = stripComments(readFileSync('server/src/sync/position-run-pager.ts', 'utf8'));
  const pushLoop = stripComments(readFileSync('server/src/sync/push-position-runs.ts', 'utf8'));
  const pullFamily = stripComments(readFileSync('server/src/sync/pull-family.ts', 'utf8'));
  const pushFamily = stripComments(readFileSync('server/src/sync/push-family.ts', 'utf8'));
  const answer = stripComments(readFileSync('server/src/sync/wire-answer.ts', 'utf8'));

  it('the pull records its position only AFTER the page is applied', () => {
    // Vouching before the write would promise records that a throw between the two would have lost — the same class of mistake one layer down. The page is accepted
    // in `deliver`; the pager moves `deliveredThrough` only after `deliver` has returned null, and a reason it hands back stops the transfer before any advance.
    const accept = pullFamily.search(/=\s*\(?await acceptArrivingPage\(/);
    assert.ok(accept > 0, 'the pull no longer writes its page through the page accept — re-anchor this gate');
    const deliver = pager.search(/const refusal = await o\.deliver\(page\.items\);/);
    assert.notEqual(deliver, -1, 'the pager no longer hands a page to `deliver` — re-anchor this gate');
    const advances = [...pager.matchAll(/outcome\.deliveredThrough = (?!0;)/g)].map(m => m.index);
    assert.ok(advances.length >= 1, `the pager advances deliveredThrough at ${advances.length} place(s) — re-anchor this gate`);
    assert.ok(advances.every(i => i > deliver), 'deliveredThrough is advanced before the page was handed on, not after');
    const refusalAt = pager.indexOf('if (refusal !== null)', deliver);
    assert.notEqual(refusalAt, -1, 'the pager no longer checks what `deliver` handed back — re-anchor this gate');
    assert.match(statementFrom(pager, refusalAt, 'the refusal branch'), /stop\(refusal\); return;/,
      'a page whose write failed must stop the transfer as truncated, before the advance');
  });

  it('the page cap counts as a truncation, and as a CAP', () => {
    // Easy to miss, because nothing failed. The loop reaches its bound with the peer still having more to give. Both loops stop at the bound through the ONE helper
    // (`stopAtPageBound`), which stops through the ONE stop (`stopTransfer`), which is where `truncated` is set and says why — each link is held, so the chain
    // cannot be cut unseen.
    assert.match(pager, /if \(stopAtPageBound\(outcome, o\.stopped, pages, maxPages\)\) return;/,
      'a pager at its page bound must stop (and so set truncated), or the mark passes what was not fetched');
    assert.match(pushLoop, /if \(stopAtPageBound\(outcome, o\.stopped, pages, o\.maxPages\)\) return;/,
      'a push at its page bound must stop (and so set truncated)');
    assert.match(pager, /const stop = \(why: string\): void => stopTransfer\(outcome, o\.stopped, why\);/, 'a stop must go through stopTransfer');
    const wm = stripComments(readFileSync('server/src/sync/watermark.ts', 'utf8'));
    assert.match(wm, /function stopTransfer\([^)]*\): void \{\s*outcome\.truncated = true;/, 'stopTransfer no longer marks the transfer truncated');
    assert.match(wm, /function stopAtPageBound\([\s\S]*?stopTransfer\(outcome, stopped, [^)]*'cap'\)/, 'stopAtPageBound no longer stops through stopTransfer as a cap');
  });

  it('a stop inside a run reports the position before it, in both directions', () => {
    // The rule, as one sentence each, spelled once in `completeThrough`. Pull: the peer's page says `through` itself (the position before the last item's when more
    // follows), and the pager never derives a position from an item (a record carries none on the wire). Push: a FULL page may continue at its last position, a short one cannot.
    assert.match(answer, /completeThrough\(last\.pos, true\)/, 'a page that is cut no longer reports the position before its last item');
    assert.doesNotMatch(pager, /page\.items[^;]*\.(?:pos|seq)\b|\b(?:item|raw|element)\.(?:pos|seq)\b/, 'the pager reads a position or a seq off an element: a record carries neither on the wire');
    assert.match(pushLoop, /completeThrough\(last\.pos, true\)/, 'the push no longer reports a position it is still inside as incomplete');
    assert.equal(completeThrough(7, true), 6, 'a run that may continue is complete through the position before it');
    assert.equal(completeThrough(7, false), 7, 'a run that cannot continue is complete through its own position');
    assert.equal(completeThrough(0, true), 0, 'there is nothing before position 0 to be complete through');
    for (const [name, src] of [['pull', pager], ['push', pushLoop], ['pull-family', pullFamily], ['push-family', pushFamily]]) {
      assert.doesNotMatch(src, /\b(?:[a-z]*[pP]os|[a-z]*[sS]eq|through|pageHighest)\s*-\s*1\b/, `${name} subtracts one from a position by hand again: that is \`completeThrough\``);
    }
  });

  it('the push caps with the ACCEPTED position, not an author-guarded one', () => {
    // The outcome's `deliveredThrough` answers "how far is the peer complete" in OUR stream. There is no author guard any more: what a push offers is the network's
    // selection (`sync/push-selection.ts`), and the mark is a position of this instance's own stream. (The outcome is the one `pushPositionRuns` fills, spread into the result.)
    assert.match(pushFamily, /return \{ pushed, refused, \.\.\.outcome \};/,
      'the push ceiling must be the position `pushPositionRuns` reports, which is where the peer is complete');
    assert.doesNotMatch(pushFamily, /localMaxSeq|deliveredThrough[:=]\s*[a-z]*Max/, 'an author-guarded maximum is back beside the accepted position');
    assert.match(pushFamily, /await pushPositionRuns</, 'the family push no longer goes through the push loop that owns the position');
  });

  it('a pull tombstone fetch that failed is no longer silent, and both halves live together', () => {
    /*
     * The pull had no `else` at all: a non-ok response applied nothing, logged nothing, and the mark advanced past the deletions anyway. The push side had a warn for
     * the identical case — one protocol phase, two implementations, twenty lines apart in a thousand-line file, and the weaker one silently won. Both halves now
     * live in `sync/tombstone-transfer.ts` so they cannot be read separately again, which is why this assertion reads that file rather than the engine.
     */
    const ts = stripComments(readFileSync('server/src/sync/tombstone-transfer.ts', 'utf8'));
    assert.match(ts, /export async function pullTombstones/, 'the pull half must live here');
    assert.match(ts, /export async function pushTombstones/, 'and so must the push half');
    assert.match(ts, /await pagePositionRuns\(/, 'the tombstone pull no longer goes through the position pager');
    assert.match(ts, /await pushPositionRuns\(/, 'the tombstone push no longer goes through the position push loop');
    /*
     * The COUNT of `outcome.truncated = true` that stood here is gone (bundle-46 plan row 10): it counted spellings, and the pagers add stops that are truncations by
     * behaviour. What it stood for is held by `a-tombstone-transfer-delivers-all-or-holds-db`: a stop for any reason answers truncated, warns, and caps the record mark.
     */
    assert.doesNotMatch(src, /api\/sync\/tombstones\?spaceId=/, 'the engine is building a tombstone URL again — that is the second implementation coming back');
  });
});
