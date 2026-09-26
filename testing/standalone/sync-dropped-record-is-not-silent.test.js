/**
 * A record the peer DROPS is reported. A record the peer already has is not.
 *
 * ## The conflation this pins apart
 *
 * `POST /api/sync/batch-upsert` counted two outcomes in one integer:
 *
 * | outcome | meaning | lossy? |
 * |---|---|---|
 * | `existing.seq >= incoming.seq` | the peer is already current | **no** — the common case, by far |
 * | `depth >= MAX_FORK_DEPTH` | divergent content at the same seq, fork chain at its cap, record discarded | **YES** |
 *
 * Sharing `skipped` made the lossy one unobservable — and `sync/engine.ts` read only `resp.ok`, so the sender
 * advanced `lastSeqPushed` past the dropped record and never offered it again. A permanent loss, reported by
 * the same number as "nothing to do".
 *
 * **The watermark still advances, deliberately.** The peer would refuse the identical record on every future
 * cycle, so holding it back would stall the space's sync to no benefit. The defect was the silence, not the
 * advance — the same conclusion the media-worker swallow reached: *the fix is visibility, not severity*.
 *
 * ## Why this asserts on source rather than driving two instances
 *
 * Producing a real fork chain at `MAX_FORK_DEPTH` needs two peers, divergent content at an identical seq, and
 * repeated conflict — a fixture larger than the change. What can be pinned cheaply and precisely is that the
 * two outcomes no longer share a counter, that the lossy one is logged on BOTH sides, and that the benign one
 * stayed quiet. A test that made the common case noisy would be worse than the defect.
 *
 * Run: node --test testing/standalone/sync-dropped-record-is-not-silent.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { enclosingBlockFrom, balancedFrom, blockAfter } from './_structural-window.mjs';

const receiver = stripComments(readFileSync('server/src/api/sync/docs.ts', 'utf8'));
const sender = stripComments(readFileSync('server/src/sync/engine.ts', 'utf8'));
/*
 * The reporting lives BESIDE the engine, not in it. `no-new-god-files.test.js` freezes `sync/engine.ts` at its
 * size and refused this change inside it — *"put the new behaviour beside it rather than inside it"* — so the
 * engine delegates and this reads both halves.
 */
const refusals = stripComments(readFileSync('server/src/sync/push-refusals.ts', 'utf8'));

describe('the receiver separates a drop from an already-current skip', () => {
  it('counts them apart', () => {
    assert.match(receiver, /forkDepthRefused: 0/,
      'the lossy outcome needs its own counter, or it is invisible inside `skipped`');
    assert.match(receiver, /memStats\.forkDepthRefused\+\+/,
      'and the MAX_FORK_DEPTH path must increment it');
  });

  it('no longer counts a dropped record as `skipped`', () => {
    // The exact line this replaced. If it comes back, the two outcomes are conflated again.
    assert.doesNotMatch(receiver, /MAX_FORK_DEPTH\s*\)\s*\{\s*memStats\.skipped\+\+/,
      'a fork-depth refusal must never be counted as an already-current skip');
  });

  it('logs the drop, naming the record and saying it will not be retried', () => {
    const at = receiver.indexOf('forkDepthRefused++');
    assert.ok(at > -1, 'anchor missing — re-point this gate');
    // The rest of the branch the counter sits in, bounded by the brace that closes it.
    const block = enclosingBlockFrom(receiver, at, 'the fork-depth refusal branch');
    assert.match(block, /log\.warn\(/, 'the side that knows WHY must say so');
    assert.match(block, /DROPPED/, 'and say what happened in a word an operator can grep for');
    assert.match(block, /\$\{incoming\._id\}/, 'naming the record — a count alone cannot be investigated');
    assert.match(block, /not offer it again|will not be offered again|not offered again/i,
      'and stating the consequence, which is the part that makes it urgent rather than curious');
  });

  it('leaves the BENIGN skip silent', () => {
    /*
     * The common path is `existing.seq >= incoming.seq` — the peer is already current. Logging that would
     * produce a warn per record per cycle and train an operator to ignore the log entirely, which is how you
     * lose the DROP message this change exists to make visible.
     *
     * The window is LINES around the statement, not a character count. The first version took 900 characters
     * after `const entStats` and the `skipped++` it was looking for sits further than that — so the anchor
     * assertion failed and the real check never ran. A character window spans different amounts of code
     * depending on comment length and line endings; a structural one does not.
     */
    const lines = receiver.split(/\r?\n/);
    const benign = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /(entStats|edgeStats|chronoStats)\.skipped\+\+/.test(l));
    assert.ok(benign.length >= 3,
      `expected the already-current skip on entities, edges and chrono; found ${benign.length}`);
    for (const { l, i } of benign) {
      const around = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
      assert.doesNotMatch(around, /log\.warn/,
        `an already-current skip is correct behaviour and must stay quiet, near: ${l.trim()}`);
    }
  });
});

describe('the sender reads the body instead of trusting the status', () => {
  it('the engine calls the reporter on every accepted batch', () => {
    assert.match(sender, /await reportPushRefusals\(resp, payloadKey,/,
      'the push loop must ask what the peer actually applied, rather than trusting the status');
  });

  it('the reporter reads the body, BOUNDED, and reports the lossy counter', () => {
    assert.match(refusals, /boundedJson</,
      'a peer body must be read with a ceiling — `resp.json()` bounds nothing, and a timeout bounds duration '
      + 'not size, which is what `upstream-reads-are-bounded.test.js` refuses');
    assert.doesNotMatch(refusals, /await resp\.json\(\)/, 'and never the unbounded form');
    assert.match(refusals, /forkDepthRefused/, 'the field it must read');
    assert.match(refusals, /log\.warn\(/, 'reported from this side too, since either log may be the only one');
    assert.match(refusals, /DROPPED/, 'in a word an operator can grep for');
  });

  it('tolerates a peer that does not send the field, and a body that will not parse', () => {
    // A peer on an older build returns no such key, and an unparseable body from a push the peer ACCEPTED
    // must not be turned into a push failure. This is the one place swallowing is right: the delivery already
    // succeeded, so the cost of being wrong here is a missing log line.
    assert.match(refusals, /\?\?\s*0/, 'a missing field must read as zero, not as undefined arithmetic');
    assert.match(refusals, /catch\s*\{/, 'and a parse failure must not fail the push');
    // It returns the refused count since Q-59, so the sender can stop counting refused records as pushed. A
    // failure to read answers 0, so the diagnostic can only ever lower `pushed` by what the peer itself claimed.
    assert.match(refusals, /Promise<number>/, 'it returns the refused count for the caller to subtract');
    assert.match(refusals, /catch \{ return 0;/, 'and a body that will not parse counts nothing refused');
  });

  it('still advances the watermark — the fix is visibility, not delivery', () => {
    // Holding `lastSeqPushed` back would re-offer a record the peer refuses identically every cycle, stalling
    // the space. This asserts the advance is unconditional on the refusal, so nobody "fixes" it into a stall.
    const at = sender.indexOf('maxSeqPushed > lastSeqPushed');
    assert.ok(at > -1, 'anchor missing — re-point this gate');
    /*
     * The condition AND the branch, each bounded by its own closing bracket. The version this replaces read 400
     * characters either side, which is the worst combination in this file: the assertion is that something is
     * ABSENT, so a window that falls short passes by looking at less — and the backwards half is written
     * `at - 400`, a form the magic-window ratchet's pattern does not match.
     */
    const block = balancedFrom(sender, sender.lastIndexOf('if (', at), 'the watermark-advance condition')
      + blockAfter(sender, at, 'the watermark-advance branch');
    assert.doesNotMatch(block, /forkDepthRefused/,
      'the watermark must not be made conditional on a refusal — that trades a visible drop for a dead space');
  });
});
