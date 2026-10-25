/**
 * The families a sync cycle carries are DERIVED, not listed — five places said five when there are six.
 *
 * ## One defect wearing several ids
 *
 * `files` became a replicated record family in 4.0. Nothing derived the number, so every hand-written five
 * stayed five, and the audit filed them separately before it noticed they are one thing:
 *
 * | where | said | actual |
 * |---|---|---|
 * | the push watermark candidate | 5 families | 6 — a file-metadata-only cycle never advances |
 * | the `batch-upsert` response | 5 counter objects | 6 pushed — the sender is told nothing about its files |
 * | `resolveWatermark`'s own docblock | "names all five on one line" | both call sites pass 7 |
 * | the wipe comment | "all five" collections | 6 destroyed, `links` omitted |
 * | `docs/sync-protocol.md` | 5 families | corrected separately, in `Q-4` |
 *
 * ## Why the watermark half is an EXTRACTION and not a gate
 *
 * Both call sites already build a `transfers` record naming every family. Each then computed `candidate` as a
 * SECOND hand-written list beside it — pull's had six entries, push's had five. And the comment directly above
 * push's read *"Same rule as the pull, same function — see `sync/watermark.ts` for why it is not two
 * implementations."* The FUNCTION is shared; the LIST was not, and the sentence denying that is what let the
 * two drift.
 *
 * So `candidate` is gone as a parameter: `resolveWatermark` computes it from the transfers it is given. One
 * list, and a seventh family cannot reproduce this.
 *
 * **Two real differences had to survive, and neither is incidental.** Pull reads `highSeq` while push reads
 * `maxSeq`, so the caller supplies a selector rather than the number. And `tombstones` is in `transfers` for
 * the truncation check but deliberately OUT of the pull candidate — so it is its own parameter now, not a name
 * on an exclusion list. An exclusion list is the shape this whole file is about.
 *
 * ## Re-derived for bundle-81 (design rev 8 §6)
 *
 * The rule is one list still, and a simpler one: the mark is the MINIMUM of what every transfer is complete through (`deliveredThrough`), so no family is
 * "outside the candidate" and there is no selector, no author guard and no `alsoCheck` (tombstones are a transfer of the same stream, passed with the
 * families). The two differences the old rule had to carry (`highSeq` against `maxSeq`; tombstones counted for truncation only) are gone with the seq paging.
 * `resolveWatermark` answers `{ at, errored, capped }`: where the mark may move, the transfers a fault stopped and the ones the cycle's cap did.
 *
 * Run: node --test testing/standalone/the-sixth-replicated-family-is-derived.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { resolveWatermark } = await import('../../server/dist/sync/watermark.js');
const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js');

const ENGINE = 'server/src/sync/engine.ts';
const FILE_SYNC = 'server/src/sync/file-sync.ts';   // the file pull moved out of the engine
const DOCS = 'server/src/api/sync/docs.ts';
const WIPE = 'server/src/spaces/wipe-vote.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

const outcome = (through, truncated = false, stoppedBy) => ({ deliveredThrough: through, truncated, ...(stoppedBy ? { stoppedBy } : {}) });
const resolve = (from, transfers, direction = 'push') => {
  const warned = [];
  const resolution = resolveWatermark({ direction, peerLabel: 'peer', spaceId: 's', from, transfers, warn: (m) => warned.push(m) });
  return { ...resolution, warned };
};

describe('the mark is computed from the transfers, not from a second list', () => {
  it('every family in `transfers` is a transfer the mark answers to: a file-metadata-only cycle advances it', () => {
    /*
     * The defect, stated as a test: file metadata was in `transfers` and absent from the candidate, so its seq could HOLD THE WATERMARK BACK and never advance
     * it. A cycle whose only change was file metadata re-pushed the same page for ever. With the minimum over the transfers there is no candidate to forget a
     * family from: every transfer that ran says where it is complete, a family with nothing new says the settled end of the stream it read, and the mark moves
     * to the lowest of them.
     */
    const r = resolve(100, {
      tombstones: outcome(400), facts: outcome(400), entities: outcome(400), edges: outcome(400),
      chrono: outcome(400), links: outcome(400), filemeta: outcome(400),
    });
    assert.equal(r.at, 400, 'a cycle in which every transfer is complete through 400 must move the mark there');
    assert.deepEqual(r.warned, [], 'nothing stopped early, so nothing should be reported as held back');
    assert.deepEqual([r.errored, r.capped], [[], []]);
  });

  it('a transfer that stopped early still holds it back, and says so naming the transfer', () => {
    // The property the function exists for. Deriving the mark from the transfers must not lose it.
    const r = resolve(0, { facts: outcome(500), filemeta: outcome(120, true, 'error') });
    assert.equal(r.at, 120, 'a truncated transfer bounds the advance to what it delivered');
    assert.equal(r.warned.length, 1, 'and it says so, naming the transfer');
    assert.match(r.warned[0], /filemeta/);
    assert.deepEqual([r.errored, r.capped], [['filemeta'], []]);
  });

  it('the mark is the MINIMUM across the transfers, never the maximum (a write that landed between two families\' reads stays above it)', () => {
    // A facts transfer read at 300 and an entities transfer read later at 500: the mark is 300, so a record at 400 that landed on the peer after facts was
    // read is read next cycle. A maximum would claim 500 and lose it for good. This is the defect P2 names (`a-cross-family-cycle-loses-no-mid-cycle-write-db`).
    assert.equal(resolve(0, { facts: outcome(300), entities: outcome(500) }).at, 300);
    assert.equal(resolve(0, { entities: outcome(500), facts: outcome(300) }).at, 300, 'the order of the transfers does not decide it');
  });

  it('a mark never goes backwards: the result is not below where the cycle started', () => {
    assert.equal(resolve(900, { facts: outcome(300) }).at, 900);
    assert.equal(resolve(900, {}).at, 900, 'no transfer ran (the turn was stopped first): the mark stays');
  });

  it('tombstones are a transfer of the same stream: counted for the mark like a family, and a stopped one holds it back', () => {
    /*
     * 5.6 passed tombstones as `alsoCheck`, which could only LOWER the mark: a cycle whose only content was a deletion moved nothing (Q-394). They are an ordinary
     * transfer now, in the same position stream, so a cycle that moved only tombstones moves the mark — and one whose tombstone transfer stopped holds it.
     */
    assert.equal(resolve(0, { tombstones: outcome(900), facts: outcome(900) }, 'receive').at, 900, 'a tombstone-only cycle moves the mark');
    const held = resolve(0, { tombstones: outcome(50, true, 'error'), facts: outcome(200) }, 'receive');
    assert.equal(held.at, 50);
    assert.match(held.warned[0], /tombstones/);
  });

  it('a stop at the cycle\'s page cap is told from a fault: `capped`, not `errored`', () => {
    const r = resolve(0, { facts: outcome(120, true, 'cap'), entities: outcome(400), links: outcome(60, true, 'error') });
    assert.equal(r.at, 60);
    assert.deepEqual([r.errored, r.capped], [['links'], ['facts']]);
    const capOnly = resolve(0, { facts: outcome(120, true, 'cap'), entities: outcome(400) });
    assert.deepEqual([capOnly.errored, capOnly.capped], [[], ['facts']], 'a pull that only hit the cap is partial: nothing failed');
  });

  it('neither call site keeps a hand-written candidate list', () => {
    const src = code(ENGINE);
    assert.doesNotMatch(src, /candidate:\s*Math\.max\(/,
      'a second list of the families is back beside the `transfers` record it duplicates');
  });

  it('and the FAMILY LIST names every brain collection', () => {
    /*
     * Derived from `BRAIN_COLLECTIONS` rather than counted, because a count is what rotted. `filemeta` is
     * the URL spelling of the `files` collection — one word apart, deliberately, and the reason this
     * mapping is asserted rather than assumed.
     *
     * Read from `sync/replicated-families.ts` since `A-12`: the engine's two enumerations became one
     * table, and each direction fills its transfers record by iterating it. So the list is where a
     * missing family would be, and it is the only place — which is what that row was for.
     */
    const src = code('server/src/sync/replicated-families.ts');
    const urlName = (c) => (c === 'files' ? 'filemeta' : c);
    for (const c of BRAIN_COLLECTIONS) {
      assert.ok(src.includes(`payloadKey: '${urlName(c)}'`),
        `the family list does not carry ${c} — neither direction would move it`);
    }
  });
});

describe('a whole file body gets the transfer budget it is passed', () => {
  it('the download does not also carry the control-plane signal', () => {
    /*
     * `peerSafeFetch` resolves `init.signal ?? AbortSignal.timeout(opts.timeoutMs)`, so passing BOTH means
     * the caller's signal wins and the transfer budget is dead code. `opts()` carries a ten-second signal,
     * which made the effective ceiling ten seconds against a ten-MINUTE budget — so any file whose body
     * took longer aborted, logged, and was retried identically every cycle. Large files never replicated.
     *
     * Asserted on the SHAPE rather than on the numbers: the defect is passing two budgets, and it returns
     * the moment somebody hands `opts()` straight to a transfer call again.
     */
    const src = code(FILE_SYNC);
    // Anchored on the DOWNLOAD's shape (a file route asking for the peer's path), not on a variable name.
    const at = src.search(/\/api\/files\/\$\{encodeURIComponent\(\w+\)\}\?path=\$\{encodeURIComponent\(remote\.path\)\}/);
    assert.ok(at > 0, 'the file download call moved — this gate is looking in the wrong place');
    const call = src.slice(Math.max(0, src.lastIndexOf('peerSafeFetch', at)), at + 400);
    assert.match(call, /timeoutMs: PEER_TRANSFER_TIMEOUT_MS/, 'the transfer budget is no longer requested');
    /*
     * THE RULE, NOT THE SPELLING — and the first version of this assertion got that wrong.
     *
     * It read `doesNotMatch(call, /\bopts\(\)/)`, which described the fix I happened to write first: an
     * inline destructure of `opts()` at the call site. Moving that rule into `peer-fetch.ts` as
     * `transferInit` — where the file that owns each budget's meaning can hold it — made the call read
     * `transferInit(opts())`, and my own gate refused it.
     *
     * What must hold is that the init reaching a whole-file fetch carries no control-plane deadline. So a
     * bare `opts()` is refused and a wrapped one is fine, which is the same rule stated about the value
     * rather than about the characters.
     */
    assert.doesNotMatch(call, /(?<!transferInit\()\bopts\(\)/,
      'the download passes a request init that still carries the control-plane signal, which overrides the '
      + 'transfer budget beside it — wrap it in `transferInit`');
  });
});

describe('the ingest response reports every family it accepted', () => {
  it('batch-upsert returns counters for all six, not five', () => {
    // Six arrays in and five sets of counters out: a sender had no way to tell whether its file metadata
    // landed, and the receiver counted it internally and only logged it.
    const src = code(DOCS);
    assert.match(src, /filemeta:\s*(?:\{\s*\.\.\.)?fileMetaStats/,
      'the response omits the file-metadata counters, so a push of them reports nothing');
  });
});

describe('a wipe vote is signed like every other own cast', () => {
  it('uses the shared signing helper', () => {
    /*
     * It pushed a bare `{instanceId, vote, castAt}` while every other own-cast site used
     * `makeSignedOwnCast`. On a network with `requireSignedVotes` the peers refuse it, so a proposed wipe or
     * space deletion carried locally and nowhere else.
     */
    // Since bundle-106 the wipe opens its round through the one open path, which signs the proposer's yes for every opener.
    assert.match(code(WIPE), /proposeRound\(/, 'the wipe round is not opened through the open path that signs the own yes');
    assert.match(code('server/src/networks/propose-round.ts'), /makeSignedOwnCast\(/,
      'the open path casts the proposer\'s yes unsigned, which a strict network refuses');
  });

  it('and its comment counts the collections a wipe actually empties', () => {
    // A number in prose about an IRREVERSIBLE operation. It said five; `WIPE_COLLECTION_TYPES` is
    // `BRAIN_COLLECTIONS`, which is six — `links` was the one it left out.
    const raw = readFileSync(WIPE, 'utf8');
    assert.doesNotMatch(raw, /all\s+five/i,
      `a wipe empties ${BRAIN_COLLECTIONS.length} collections and the comment says five`);
  });
});
