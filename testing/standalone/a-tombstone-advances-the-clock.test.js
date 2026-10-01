/**
 * Everything received from a peer advances the local seq counter — tombstones included.
 *
 * ## The invariant, in `bumpSeq`'s own words
 *
 * *"Bump the local seq counter so future local writes always get a seq higher than any document received from
 * this peer."* Both ingest paths honoured that for the four record families and skipped it for tombstones,
 * which are received from the same peer, in the same cycle, carrying the deleting instance's seq.
 *
 * ## What that cost
 *
 * ```text
 * a busy peer   (counter 5001) deletes a record      ->  tombstone, seq 5001
 * a quiet peer  (counter  300) receives it           ->  counter stays 300
 * the quiet peer re-creates it with the same id      ->  local seq 301
 * it pushes back                                     ->  tombstone.seq >= incoming.seq
 *                                                        refused as `tombstoned`, with a 200
 * ```
 *
 * The sender reads only `resp.ok`, so it advances past the record and never offers it again: silent,
 * permanent, one-directional. **Reachable today** wherever a caller supplies the id — memories, entities and
 * chrono all accept one — and it is what would make a derived edge id (P-23) unsafe, since a re-created edge
 * would then land on its own tombstone by construction rather than by coincidence.
 *
 * ## Why the fix is the counter and not a second comparison
 *
 * The alternative was comparing the incoming `createdAt` against the tombstone's `deletedAt`. That introduces
 * a SECOND clock beside the seq one, and this project's own board protocol has a rule about exactly that —
 * two clocks, never compared. The counter is the clock the whole protocol already runs on; it was simply not
 * being wound forward by one of the five things that arrive.
 *
 * Run: node --test testing/standalone/a-tombstone-advances-the-clock.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementAround } from './_structural-window.mjs';

const ENGINE = stripComments(readFileSync('server/src/sync/engine.ts', 'utf8'));
const ROUTE = stripComments(readFileSync('server/src/api/sync/tombstones.ts', 'utf8'));
const TRANSFER = stripComments(readFileSync('server/src/sync/tombstone-transfer.ts', 'utf8'));

describe('both tombstone ingest paths wind the clock forward', () => {
  it('the PULL folds the tombstone seq into the counter bump', () => {
    /*
     * The FAMILIES are no longer named here: the bump reads the same `pulled` object the watermark does,
     * because it was a third hand-written list and it omitted file metadata — so a file-meta record with
     * a high seq left this counter beneath it, and the next local write could take a number below a
     * record already received. Tombstones stay named, because they are not in that object.
     */
    const at = ENGINE.indexOf('overallMaxSeq = Math.max(');
    assert.notEqual(at, -1, 'the counter bump input is gone — re-point this gate');
    const stmt = statementAround(ENGINE, at, 'the overallMaxSeq assignment');
    assert.match(stmt, /Object\.values\(pulled\)/,
      'the bump must read the shared transfer set, not a list of its own — that list omitted a family');
    assert.match(
      stmt, /tombstones\.maxSeq/,
      'the tombstone transfer is excluded from the counter bump, so a peer\'s deletions leave this instance\'s '
      + 'clock behind — and a record re-created here is then refused by every peer holding the tombstone.',
    );
    /*
     * The per-family assertions that were here are subsumed by the `Object.values(pulled)` check above: the
     * set is one object now, and `one-watermark-every-transfer` holds that object to every replicated
     * collection. Naming them again here would be the hand-written list this change removed.
     */
  });

  it('the PUSH-side route bumps on what it received', () => {
    // The other direction, and it is a separate code path with the same invariant — one of the two being
    // fixed would leave the bug alive for whichever way the deletion happened to travel.
    assert.match(ROUTE, /bumpSeq\(/, 'the tombstone ingest route never advances the counter');
    const at = ROUTE.indexOf('bumpSeq(');
    const stmt = statementAround(ROUTE, at, 'the route bump');
    assert.match(stmt, /maxTombstoneSeq/, 'it must bump to the highest tombstone seq received');
  });

  it('the max is taken over what ARRIVED, not over what was accepted', () => {
    /*
     * `applyRemoteTombstone` refuses a tombstone whose issuer the caller may not act for. That refusal is
     * about authority, not about time: the tombstone still tells us where that peer's clock is.
     *
     * The two errors are not symmetric, which is what settles it — advancing too far only skips some seq
     * numbers, while not advancing far enough loses a record permanently.
     */
    const at = ROUTE.indexOf('const maxTombstoneSeq');
    assert.notEqual(at, -1, 'the route no longer computes a max — re-point this gate');
    const stmt = statementAround(ROUTE, at, 'the route max');
    /*
     * Re-anchored for `Q-107` part 1: a tombstone whose seq no counter can carry (inside the protocol's ceiling
     * reserve) is refused first — it would refuse every later copy of its record and drag the counter into the
     * reserve. Everything ELSE that was parsed counts, before authorisation filters anything. Seen red by
     * mutation, restored by hand: the max taken over the tombstones `applyRemoteTombstone` accepted.
     */
    assert.match(stmt, /\bplausible\.reduce\(/, 'the max must come from the tombstones received, not a filtered subset');
    const def = statementAround(ROUTE, ROUTE.indexOf('const plausible'), 'the plausible set');
    assert.match(def, /parsed\.data\.filter\(t => !isSeqImplausible\(t\.seq\)/,
      'the max must come from everything parsed — less only a seq no counter can carry — before authorisation filters it');
    assert.doesNotMatch(def, /applyRemoteTombstone|peerInstanceId|trustedRelay/,
      'the max is filtered by authority, which is about who may delete, not about where the peer\'s clock is');
    assert.match(ROUTE, /await bumpSeq\(spaceId, maxTombstoneSeq\)/,
      'the bump is not awaited before the answer, so the sender is told the page landed while the counter is behind');
  });

  it('the transfer reports a seq at all, and starts from zero', () => {
    // `maxSeq: 0` when nothing arrived, so an empty pull cannot drag the counter anywhere.
    assert.match(TRANSFER, /maxSeq: 0/, 'the outcome must start at zero');
    const body = bodyOf(TRANSFER, 'pullTombstones');
    assert.match(body, /outcome\.maxSeq = /, 'the pull must record the highest tombstone seq it saw');
    assert.match(
      body, /all\.reduce/,
      'over ALL tombstones received across the four families, not one of them — a max over a single family '
      + 'is the same omission one level down',
    );
  });

  it('the tombstone transfer still reaches the WATERMARK too', () => {
    // Pre-existing and load-bearing: the watermark comment says an omitted transfer places no ceiling, which
    // makes it the one that gets skipped. This change adds a second consumer; it must not cost the first.
    const at = ENGINE.indexOf('direction: \'receive\'');
    assert.notEqual(at, -1, 'the receive watermark call is gone — re-point this gate');
    assert.match(statementAround(ENGINE, at, 'the receive watermark'), /alsoCheck: \{ tombstones \}/,
      'the tombstone transfer must still bound the receive watermark. It is `alsoCheck` now rather than a\n'
      + 'member of `transfers`: it holds the advance back when it stops early and cannot raise it, which\n'
      + 'is what it always did.');
  });
});
