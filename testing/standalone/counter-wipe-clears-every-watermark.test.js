/**
 * When the seq counters are wiped, EVERY watermark measured against them is cleared — not one of the four.
 *
 * ## The defect
 *
 * `resetStaleWatermarksIfNeeded` exists for a real and reachable state: `docker compose down -v` wipes the
 * MongoDB volume while `config.json` survives on a host bind-mount. The counter restarts at 1; the watermarks in
 * the config still describe a history of numbers that are about to be handed to entirely different records.
 *
 * It cleared `lastSeqReceived` and left the other three, and they fail in different directions:
 *
 * | watermark | stale-high costs |
 * |---|---|
 * | `lastSeqReceived` | we pull `sinceSeq=47` and silently miss the peer's 1..47 — the one it was written for |
 * | `lastSeqPushed` | we push `seq > 47` and NEVER send our own new 1..47 |
 * | `lastSeqServed` | we believe a peer applied deletions it has not, and prune the tombstones |
 * | `lastFileTombstoneAckedAt` | the same for files: prune, and a deleted file comes back from the peer |
 *
 * The second is the same defect pointing the other way, and it is the worse one to diagnose: the sender's cycles
 * complete normally, because `seq > 47` genuinely matches nothing. A healthy idle cycle and a permanent failure
 * to deliver look identical from outside — which is the shape X-20 has been chasing.
 *
 * ## Why this is asserted as ALL-OR-NONE
 *
 * `two-surfaces-one-rule-weaker-version` is the lesson: a gate that checks "the reset handles
 * `lastSeqReceived`" passes on exactly the code that had the bug. So this derives the field list from the member
 * TYPE — every `spaceId -> position` map on a network member — and requires the reset to cover all of them. A
 * fifth watermark added tomorrow fails this test until somebody decides whether it is stale on a wipe.
 *
 * Run: node --test testing/standalone/counter-wipe-clears-every-watermark.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, balancedFrom } from './_structural-window.mjs';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';

const seqSrc = stripComments(readFileSync('server/src/util/seq.ts', 'utf8'));
const typesSrc = stripComments(readFileSync('server/src/config/types-networks.ts', 'utf8'));

/**
 * Every per-space position map declared on `NetworkMember`, read from the type.
 *
 * Derived rather than listed, because a hand-written list is the thing that produced the bug: the reset's author
 * knew about one field and there was nothing to tell them about the others.
 *
 * The derivation itself moved to `testing/_shared/member-watermarks.mjs` when a SECOND gate needed the same
 * question — the rename gate, which asks whether every one of these is carried across. Two copies of one
 * regex over one interface is the defect this repo produces most, one level up from the bug below.
 */
const memberWatermarkFields = () => memberWatermarks();

describe('the field list this reset is built from', () => {
  it('finds the per-space position maps on NetworkMember', () => {
    // A scan that found none would make every assertion below vacuous — the failure this whole suite keeps
    // rediscovering.
    const fields = memberWatermarkFields();
    assert.ok(fields.length >= 4,
      `expected at least four per-space watermark maps on NetworkMember, found ${fields.length}: ${fields}`);
    for (const expected of ['lastSeqReceived', 'lastSeqPushed', 'lastSeqServed']) {
      assert.ok(fields.includes(expected), `${expected} is no longer a Record on NetworkMember — re-anchor this`);
    }
  });
});

describe('the wipe recovery covers every one of them', () => {
  it('names all of them, and names them in ONE place', () => {
    /*
     * ALL-OR-NONE, which is the only assertion that would have failed on the buggy version. "It handles
     * lastSeqReceived" was true the whole time the other three were being ignored.
     */
    const list = balancedFrom(seqSrc, seqSrc.indexOf('STALE_ON_COUNTER_WIPE'), 'the stale-watermark list');
    const missing = memberWatermarkFields().filter(f => !list.includes(`'${f}'`));
    assert.deepEqual(missing, [],
      'these per-space watermarks are measured against the seq counter and are NOT cleared when it is wiped. '
      + 'Each one that survives describes numbers about to be reused by different records. If one genuinely '
      + 'should survive a wipe, exclude it deliberately with the reason beside it.');
  });

  it('the reset iterates the list rather than repeating field names', () => {
    // Four hand-written clears is how the fifth gets forgotten. The loop is what makes the list authoritative.
    const body = bodyOf(seqSrc, 'resetStaleWatermarksIfNeeded');
    assert.match(body, /for \(const field of STALE_ON_COUNTER_WIPE\)/,
      'the reset must walk the declared list');
    for (const f of memberWatermarkFields()) {
      assert.doesNotMatch(body, new RegExp(`member\\.${f}\\s*=`),
        `${f} is cleared by name inside the reset — that is a second copy of the list`);
    }
  });

  it('a vote round in flight is covered too', () => {
    // `pendingMember` is a whole member with its own watermarks, and it was the one place the original DID
    // remember a second site — for one field.
    const body = bodyOf(seqSrc, 'resetStaleWatermarksIfNeeded');
    assert.match(body, /pendingMember/,
      'a pending member carries its own watermarks and is stale for the same reason');
  });

  it('it still only fires when the counters are actually gone', () => {
    // The guard is what makes this safe at every startup. Without it, a normal restart would wipe every
    // watermark and re-push the entire history to every peer on every boot.
    const body = bodyOf(seqSrc, 'resetStaleWatermarksIfNeeded');
    assert.match(body, /estimatedDocumentCount\(\)/, 'it must check whether the counters exist');
    assert.match(body, /if \(count > 0\) return;/, 'and do nothing when they do');
  });

  it('and says WHICH watermarks it cleared', () => {
    /*
     * The original logged "reset all lastSeqReceived to 0" — which was accurate about what it did and wrong
     * about what was needed, and an operator reading it had no way to know three other maps were untouched. A
     * recovery that silently does part of its job is the hardest kind to notice.
     */
    const body = bodyOf(seqSrc, 'resetStaleWatermarksIfNeeded');
    assert.match(body, /cleared\.join\(|peerList\(cleared\b/, 'the warning must enumerate what it reset, not describe it in prose');
    assert.doesNotMatch(body, /reset all lastSeqReceived/,
      'the old message named one field as though it were the whole job');
  });
});
