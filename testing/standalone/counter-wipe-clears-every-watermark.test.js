/**
 * When the counters are wiped, a counter wipe forgets only the marks that say what was RECEIVED (bundle-81, design rev 8 section 3a).
 *
 * ## The state, and the rule it was written for
 *
 * `forgetWhatWasReceivedAfterCounterWipe` (`util/seq.ts`, once `resetStaleWatermarksIfNeeded`) exists for a real and reachable state:
 * `docker compose down -v` wipes the MongoDB volume while `config.json` survives on a host bind-mount. The records are gone; the marks in the
 * config still say they were received.
 *
 * Until bundle-81 EVERY mark was a seq of this instance's counter, so the counter restarting at 1 made every one of them a lie and the reset had to
 * clear all of them (it once cleared one of four, and the other three failed in different directions: a stale-high `lastSeqPushed` never sent our
 * new records, a stale-high `lastSeqServed` pruned tombstones a peer never took). The marks are positions now, stamped from a clock that is seeded
 * from the store, so:
 *
 * | mark | after a wipe |
 * |---|---|
 * | `lastPosReceived`, `tombstoneRereadAt`, `fileMetaRereadAt` (`RECEIVE_MARKS`) | a lie: the peer must send it all again |
 * | `lastPosPushed`, `lastPosServed`, `lastFileTombstoneAckedAt` (`KEPT_ON_RESTORE`) | true: the next position is above them, and a mark that is too low costs a re-send, never a miss |
 * | `lastSeqReceived`, `lastSeqPushed`, `lastSeqServed` (`ROLLBACK_MARKS`) | not read by 6.0, never touched: a rollback needs them as they were |
 *
 * ## Why this is asserted from the classification and not from a list
 *
 * A gate that checks "the reset handles `lastPosReceived`" passes on exactly the code that forgot the others. So the reset's list is the SAME
 * declared list a restore forgets (`RECEIVE_MARKS`), `receive-marks-and-kept-marks-classify-every-mark` holds that every member mark is in exactly one
 * of the three lists, and this asserts the reset walks the one loop with that list (so a pending member of a join round in flight is visited), says
 * what it forgot, and still fires only when the counters are gone.
 *
 * Run: node --test testing/standalone/counter-wipe-clears-every-watermark.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';

const seqSrc = stripComments(readFileSync('server/src/util/seq.ts', 'utf8'));
const FUNCTION = 'forgetWhatWasReceivedAfterCounterWipe';

describe('the field list this reset is built from', () => {
  it('finds the per-space position maps on NetworkMember', () => {
    // A scan that found none would make every assertion below vacuous.
    const fields = memberWatermarks();
    assert.ok(fields.length >= 6, `expected at least six per-space mark maps on NetworkMember, found ${fields.length}: ${fields}`);
    for (const expected of ['lastPosReceived', 'lastPosPushed', 'lastPosServed', 'lastSeqReceived']) {
      assert.ok(fields.includes(expected), `${expected} is no longer a Record on NetworkMember - re-anchor this`);
    }
  });
});

describe('the wipe recovery forgets what was received, and only that', () => {
  it('walks the one loop over the member marks, for every space, with RECEIVE_MARKS as its list', () => {
    const body = bodyOf(seqSrc, FUNCTION);
    const walk = body.match(/eachMemberMarkOf\(\s*net\s*,\s*null\s*,\s*\(([^)]*)\)\s*=>/);
    assert.ok(walk, 'the reset does not walk every space\'s marks through eachMemberMarkOf - a loop of its own is a second list of carriers');
    // What follows the callback's closing brace: `, RECEIVE_MARKS)` is the list the restore forgets; `)` alone would be every mark.
    let at = body.indexOf('{', body.indexOf(walk[0]) + walk[0].length - 2);
    for (let depth = 0; at < body.length; at++) {
      if (body[at] === '{') depth++;
      else if (body[at] === '}' && --depth === 0) break;
    }
    assert.match(body.slice(at + 1), /^\s*,\s*RECEIVE_MARKS\s*\)/,
      'the reset does not hand eachMemberMarkOf RECEIVE_MARKS: forgetting every mark re-sends our whole history to every peer, and a list of its own is a second list of the same maps');
  });

  it('the reset iterates the list rather than naming fields', () => {
    const body = bodyOf(seqSrc, FUNCTION);
    for (const f of memberWatermarks()) {
      assert.doesNotMatch(body, new RegExp(`member\\.${f}\\s*=`), `${f} is cleared by name inside the reset - that is a second copy of the list`);
    }
  });

  it('forgets the receive marks of a vote round in flight and of the members, and leaves the sent, served and frozen marks as they were', async () => {
    // `pendingMember` is a whole member with its own marks; the one loop reaches it, so the reset does. Walk it with the reset's list.
    const { PER_SPACE_WATERMARKS, RECEIVE_MARKS, ROLLBACK_MARKS } = await import('../../server/dist/config/types-networks.js');
    const { eachMemberMarkOf } = await import('../../server/dist/sync/receive-marks.js');
    const marked = () => Object.fromEntries(PER_SPACE_WATERMARKS.map(k => [k, { s: 1 }]));
    const net = { members: [{ instanceId: 'm', ...marked() }], pendingRounds: [{ roundId: 'r', pendingMember: { instanceId: 'p', ...marked() } }] };
    eachMemberMarkOf(net, null, (marks) => { for (const spaceId of Object.keys(marks)) delete marks[spaceId]; }, RECEIVE_MARKS);
    for (const [who, member] of [['m', net.members[0]], ['pendingMember', net.pendingRounds[0].pendingMember]]) {
      for (const k of PER_SPACE_WATERMARKS) {
        const forgotten = Object.keys(member[k]).length === 0;
        assert.equal(forgotten, RECEIVE_MARKS.includes(k), `${who}.${k} ${forgotten ? 'was forgotten' : 'was kept'}: a counter wipe forgets exactly the receive marks`);
      }
      for (const k of ROLLBACK_MARKS) assert.deepEqual(member[k], { s: 1 }, `${who}.${k}, the frozen 5.6 mark, was touched: a rollback needs it as it was`);
    }
  });

  it('it still only fires when the counters are actually gone', () => {
    // The guard is what makes this safe at every startup. Without it, a normal restart would forget what was received and re-pull the whole history on every boot.
    const body = bodyOf(seqSrc, FUNCTION);
    assert.match(body, /estimatedDocumentCount\(\)/, 'it must check whether the counters exist');
    assert.match(body, /if \(count > 0\) return;/, 'and do nothing when they do');
  });

  it('and says WHICH marks it forgot', () => {
    // A recovery that silently does part of its job is the hardest kind to notice: the warning enumerates what it did, it does not describe it in prose.
    const body = bodyOf(seqSrc, FUNCTION);
    assert.match(body, /cleared\.join\(/, 'the warning must enumerate what it forgot, not describe it in prose');
  });

  it('bootstrap calls the one function by its new name, and nothing calls the old one', () => {
    const boot = stripComments(readFileSync('server/src/bootstrap.ts', 'utf8'));
    assert.match(boot, new RegExp(`\\b${FUNCTION}\\(\\)`), 'bootstrap does not run the counter-wipe recovery');
    assert.doesNotMatch(boot, /resetStaleWatermarksIfNeeded/, 'bootstrap still names the retired function');
    assert.doesNotMatch(seqSrc, /resetStaleWatermarksIfNeeded/, 'util/seq.ts still names the retired function');
  });
});
