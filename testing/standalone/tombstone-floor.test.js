/**
 * The tombstone prune floor — every branch that decides whether a deletion record may be dropped.
 *
 * ## Why this is the test that matters
 *
 * Tombstones had no retention bound at all, and the obvious fix — delete them after N days — is wrong in a way
 * that only shows up weeks later. They are served by `seq > sinceSeq`, so a peer that was offline longer than
 * the window comes back, never learns of the deletion, and pushes its live copy: the retention fix turns into
 * "deleted records keep coming back", with nothing left to point at.
 *
 * So the floor is built from what peers have provably been served, and **every unknown must resolve to "keep"**.
 * That asymmetry is the whole design: keeping a tombstone too long costs a few hundred bytes, dropping one too
 * early resurrects a deleted record. The cases below are that asymmetry, one branch at a time — all pure, so
 * none of them needs a database or a config file.
 *
 * Mutation-checked in both spellings of the defect:
 *   - floor too HIGH (`Math.max` instead of the minimum, or ignoring a member with no record) → a tombstone a
 *     peer still needs is deleted. Caught by "the minimum wins" and "a member that never pulled blocks".
 *   - floor absent (treating "no members" as "no peers") → the whole collection goes on an instance a peer
 *     token can still read. Caught by the peer-token cases.
 *
 * Run: node --test testing/standalone/tombstone-floor.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let tombstoneFloor, tombstoneFloorForSpace, foldServedSeq, peerTokensReaching, membersServing, applyServedSeq;

/** Repo root — vitest-style `import.meta.url` URL building is not portable here, and this file is run by node. */
const ROOT = process.cwd();

before(async () => {
  ({ tombstoneFloor, tombstoneFloorForSpace, foldServedSeq, peerTokensReaching, membersServing, applyServedSeq } =
    await import('../../server/dist/sync/served-watermark.js'));
});

const SPACE = 'kb';

/** A member that has pulled up to `seq`. */
const served = (instanceId, seq, spaceId = SPACE) => ({
  instanceId, label: instanceId, lastSeqServed: { [spaceId]: seq },
});

describe('tombstone floor — when a deletion record may be dropped', () => {
  it('drops everything when there is no peer at all — the single-instance install', () => {
    // The common case and the largest win: nobody can pull tombstones from this space, so not one of them is
    // carrying information for anyone.
    const f = tombstoneFloor([], SPACE, []);
    assert.equal(f.prune, true);
    assert.equal(f.peers, 0);
    assert.ok(f.upTo >= Number.MAX_SAFE_INTEGER, `upTo was ${f.upTo}, so tombstones would survive`);
  });

  it('takes the MINIMUM served position, not the maximum', () => {
    // A `Math.max` here deletes tombstones the slowest peer has never seen. This is the mutation that loses
    // data, and it passes every "does it prune?" test that does not check the number.
    const f = tombstoneFloor([served('a', 900), served('b', 40), served('c', 12_000)], SPACE);
    assert.equal(f.prune, true);
    assert.equal(f.upTo, 40);
  });

  it('order does not decide it', () => {
    const asc = tombstoneFloor([served('a', 5), served('b', 90)], SPACE);
    const desc = tombstoneFloor([served('b', 90), served('a', 5)], SPACE);
    assert.deepEqual(asc, desc);
    assert.equal(asc.upTo, 5);
  });

  it('a member that has never pulled BLOCKS the prune, and is named', () => {
    // Absence of evidence is not evidence of having caught up. This is also every member's state immediately
    // after an upgrade, so a fresh instance prunes nothing until it has earned the right to.
    const f = tombstoneFloor([served('a', 900), { instanceId: 'b', label: 'branch-office' }], SPACE);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'member-never-pulled');
    assert.equal(f.blockedBy, 'branch-office');
  });

  it('a record for a DIFFERENT space does not count as this space', () => {
    const f = tombstoneFloor([{ instanceId: 'a', lastSeqServed: { other: 5_000 } }], SPACE);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'member-never-pulled');
  });

  it('rejects a non-numeric or non-finite record instead of coercing it', () => {
    for (const bad of [undefined, null, NaN, Infinity, '900', {}]) {
      const f = tombstoneFloor([{ instanceId: 'a', lastSeqServed: { [SPACE]: bad } }], SPACE);
      assert.equal(f.prune, false, `${String(bad)} was treated as a position`);
    }
  });

  it('a floor of zero prunes nothing, and says so', () => {
    // `seq <= 0` matches no tombstone, and reporting it as a prune would put a lie in the log.
    const f = tombstoneFloor([served('a', 0)], SPACE);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'floor-at-zero');
  });

  it('one advanced peer cannot carry a peer that has confirmed nothing', () => {
    const f = tombstoneFloor([served('a', 50_000), served('b', 0)], SPACE);
    assert.equal(f.prune, false);
  });

  // ── The peer that has no member entry ────────────────────────────────────────────────────────────
  //
  // `spaceAllowed` authorises a manually provisioned peer token, or an asymmetric network we do not hold the
  // config for, by plain token space-scope — with no member record to write a watermark to. Treating "no
  // members" as "no peers" would drop the whole collection out from under such a peer.

  it('a peer token with no member entry blocks the prune', () => {
    const f = tombstoneFloor([], SPACE, ['ghost-instance']);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'peer-token-scoped');
    assert.equal(f.blockedBy, 'ghost-instance');
  });

  it('blocks even when every KNOWN member is fully caught up', () => {
    const f = tombstoneFloor([served('a', 9_000)], SPACE, ['a', 'ghost-instance']);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'peer-token-scoped');
  });

  it('a peer token that IS a member does not block — it has somewhere to record', () => {
    const f = tombstoneFloor([served('a', 700)], SPACE, ['a']);
    assert.equal(f.prune, true);
    assert.equal(f.upTo, 700);
  });
});

describe('reading the config — who can reach this space', () => {
  /** Minimal config shaped like the real one. */
  const cfg = (over = {}) => ({
    instanceId: 'self', instanceLabel: 'self', tokens: [], spaces: [{ id: SPACE }], networks: [], ...over,
  });

  /*
   * These fixtures carry a rights MATRIX, not a legacy `spaces` allowlist, because that is what a real
   * token looks like: `createToken` writes one and the boot backfill derives one in memory for anything
   * older. The properties below are unchanged — what changed in 4.0 is which field expresses them.
   */
  const scoped = (id) => ({ instanceAdmin: false, createSpaces: false, floor: null,
    perSpace: { [id]: { knowledge: 'read' } } });
  const unscoped = () => ({ instanceAdmin: false, createSpaces: false,
    floor: { knowledge: 'read' }, perSpace: {} });

  it('counts a peer token scoped to the space', () => {
    const c = cfg({ tokens: [{ id: 't1', peerInstanceId: 'p1', rights: scoped(SPACE) }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), ['p1']);
  });

  it('an UNSCOPED peer token still reaches every space, now via its FLOOR', () => {
    /*
     * The property this protects is about data, not access: one token that reaches everywhere makes every
     * space unprunable, because we cannot prove where it has been. It used to be expressed as an omitted
     * `spaces` allowlist — and the trap was that `spaces: undefined` reads as "no spaces" if you only check
     * `includes`, when it means the opposite.
     *
     * An unscoped token is a FLOOR now. `migrateToken` turns an absent allowlist into a floor granting every
     * area, including in spaces created later, so the same token gives the same answer through the matrix
     * and the trap has no field left to spring on.
     */
    const c = cfg({ tokens: [{ id: 't1', peerInstanceId: 'p1', rights: unscoped() }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), ['p1']);
    assert.deepEqual(peerTokensReaching(c, 'some-other-space'), ['p1']);
    assert.equal(tombstoneFloorForSpace(c, SPACE).prune, false);
  });

  it('and a token with NO matrix reaches nothing — which is why it must never be one', () => {
    /*
     * 4.0 made the reach rule fail closed: no matrix, no spaces. Here that has a DATA consequence rather
     * than an access one — such a token holds no tombstone floor, so tombstones become prunable ahead of a
     * peer that has not acked, and the symptom is missing data rather than a 403 someone reports.
     *
     * It cannot be a real token, and that is asserted a level up in
     * `a-token-without-a-matrix-reaches-nothing.test.js`: one attachment point, one resolver, and both of
     * its branches produce a matrix. This case exists so the consequence is written down where a future
     * change to that guarantee would be read.
     */
    const c = cfg({ tokens: [{ id: 't1', peerInstanceId: 'p1' }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), []);
  });

  it('ignores an ordinary token — only a peer token can pull sync', () => {
    const c = cfg({ tokens: [{ id: 't1', spaces: [SPACE] }, { id: 't2', admin: true }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), []);
    assert.equal(tombstoneFloorForSpace(c, SPACE).prune, true);
  });

  it('ignores a peer token scoped to other spaces only', () => {
    const c = cfg({ tokens: [{ id: 't1', peerInstanceId: 'p1', spaces: ['elsewhere'] }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), []);
  });

  it('ignores an empty-string peerInstanceId rather than blocking on a blank', () => {
    const c = cfg({ tokens: [{ id: 't1', peerInstanceId: '', spaces: [SPACE] }] });
    assert.deepEqual(peerTokensReaching(c, SPACE), []);
  });

  it('collects members from every network carrying the space, deduplicated', () => {
    const c = cfg({
      networks: [
        { id: 'n1', spaces: [SPACE], members: [served('a', 10), served('b', 20)] },
        { id: 'n2', spaces: [SPACE], members: [served('b', 20), served('c', 30)] },
        { id: 'n3', spaces: ['elsewhere'], members: [served('z', 1)] },
      ],
    });
    assert.deepEqual(membersServing(c, SPACE).map(m => m.instanceId), ['a', 'b', 'c']);
  });

  it('takes the min ACROSS networks — a space in two networks answers to both', () => {
    const c = cfg({
      networks: [
        { id: 'n1', spaces: [SPACE], members: [served('a', 5_000)] },
        { id: 'n2', spaces: [SPACE], members: [served('b', 7)] },
      ],
    });
    const f = tombstoneFloorForSpace(c, SPACE);
    assert.equal(f.prune, true);
    assert.equal(f.upTo, 7);
  });

  it('a member in an unrelated network cannot hold this space back', () => {
    const c = cfg({
      networks: [
        { id: 'n1', spaces: [SPACE], members: [served('a', 300)] },
        { id: 'n2', spaces: ['elsewhere'], members: [{ instanceId: 'never-pulled' }] },
      ],
    });
    const f = tombstoneFloorForSpace(c, SPACE);
    assert.equal(f.prune, true);
    assert.equal(f.upTo, 300);
  });

  it('survives a config with no networks and no tokens key', () => {
    const f = tombstoneFloorForSpace({ spaces: [], tokens: [], networks: [] }, SPACE);
    assert.equal(f.prune, true);
  });
});

describe('recording where a peer has been served', () => {
  const cfg = () => ({
    instanceId: 'self', instanceLabel: 'self', tokens: [], spaces: [{ id: SPACE }],
    networks: [{ id: 'n1', spaces: [SPACE], members: [{ instanceId: 'p1', label: 'p1' }] }],
  });

  it('records the position for the member that pulled', () => {
    const c = cfg();
    assert.equal(applyServedSeq(c, 'p1', SPACE, 400), true);
    assert.equal(c.networks[0].members[0].lastSeqServed[SPACE], 400);
  });

  it('records nothing for a caller with no peer identity', () => {
    // An admin token, the UI, a manual curl. Treating a local read as a peer having caught up is exactly how a
    // tombstone a real peer still needs would get dropped.
    const c = cfg();
    assert.equal(applyServedSeq(c, undefined, SPACE, 400), false);
    assert.equal(c.networks[0].members[0].lastSeqServed, undefined);
  });

  it('records nothing for a peer we do not list as a member', () => {
    const c = cfg();
    assert.equal(applyServedSeq(c, 'stranger', SPACE, 400), false);
  });

  it('records nothing for a space the network does not carry', () => {
    const c = cfg();
    assert.equal(applyServedSeq(c, 'p1', 'elsewhere', 400), false);
    assert.equal(c.networks[0].members[0].lastSeqServed, undefined);
  });

  it('reports no change when the value would not move — so the config is not rewritten per request', () => {
    // This runs on the sync hot path. A write on every pull would rewrite config.json for nothing.
    const c = cfg();
    applyServedSeq(c, 'p1', SPACE, 400);
    assert.equal(applyServedSeq(c, 'p1', SPACE, 400), false);
    assert.equal(applyServedSeq(c, 'p1', SPACE, 399), false);
    assert.equal(c.networks[0].members[0].lastSeqServed[SPACE], 400);
  });

  it('records the same member in every network that carries the space', () => {
    const c = cfg();
    c.networks.push({ id: 'n2', spaces: [SPACE], members: [{ instanceId: 'p1', label: 'p1' }] });
    assert.equal(applyServedSeq(c, 'p1', SPACE, 12), true);
    assert.equal(c.networks[1].members[0].lastSeqServed[SPACE], 12);
  });

  it('keeps other spaces\' positions when one advances', () => {
    const c = cfg();
    c.networks[0].spaces.push('second');
    applyServedSeq(c, 'p1', SPACE, 10);
    applyServedSeq(c, 'p1', 'second', 99);
    assert.deepEqual(c.networks[0].members[0].lastSeqServed, { [SPACE]: 10, second: 99 });
  });
});

describe('the pull handler is actually wired to record it', () => {
  // Reading a NAMED file, not an enumeration: if it moves, this throws. The decision above is worthless if
  // nothing calls it, and "the feature quietly stopped recording" looks identical to "no peer has pulled yet" —
  // which this design deliberately treats as a reason NOT to prune, so the failure would be silent forever.
  const src = readFileSync(join(ROOT, 'server/src/api/sync/tombstones.ts'), 'utf8');

  it('the tombstone GET records the served position, keyed by the authenticated peer', () => {
    assert.match(src, /recordServedSeq\(\s*peerBoundTo\(/,
      'GET /api/sync/tombstones no longer records lastSeqServed, so the prune floor can never rise');
  });

  it('records AFTER the tombstones are read', () => {
    // Ordering is the claim that a bookkeeping failure cannot cost the peer its tombstones.
    const read = src.indexOf('listTombstones(spaceId');
    const record = src.indexOf('recordServedSeq(');
    assert.ok(read > 0 && record > read, `listTombstones at ${read}, recordServedSeq at ${record}`);
  });

  it('the space rename carries this watermark, because it carries every one of them', () => {
    /*
     * This named three, and there are four — the third copy of one rule across three gates, each written by
     * somebody adding the watermark they had just built. `lastFileTombstoneAckedAt` was outside all of them.
     *
     * A rename that misses one resets that floor to "unknown" silently: the prune simply stops until every
     * member has pulled again, which is SAFE and invisible, so nothing would ever report it.
     *
     * The source loops `PER_SPACE_WATERMARKS` now, and the derivation of what belongs on that list — every
     * per-space map on the member interface — is shared, so this asks the same question the other two ask.
     */
    // The rename carries the marks through `moveReceiveMarks` (bundle-106), which loops the list beside the wipe's forget.
    const rename = readFileSync(join(ROOT, 'server/src/spaces/rename.ts'), 'utf8');
    assert.match(rename, /\bmoveReceiveMarks\s*\(/, 'the rename no longer carries its watermarks through the one loop');
    assert.match(readFileSync(join(ROOT, 'server/src/sync/member-space-mark.ts'), 'utf8'), /for \(const key of PER_SPACE_WATERMARKS\)/,
      'the rename carries its watermarks by name again, so the next one added is carried by nobody');
    assert.ok(memberWatermarks().includes('lastSeqServed'),
      'lastSeqServed is no longer a per-space map on NetworkMember — this floor has moved, re-anchor here');
  });
});

describe('the served watermark only ever moves forward', () => {
  it('accepts a higher position', () => {
    assert.equal(foldServedSeq(10, 40), 40);
    assert.equal(foldServedSeq(undefined, 1), 1);
  });

  it('refuses to go BACKWARDS', () => {
    // A peer legitimately re-requests from an older position — a retry, a restarted pull, a peer that lost its
    // own watermark. Taking that at face value drops the floor and re-serves tombstones we already dropped.
    assert.equal(foldServedSeq(500, 20), null);
    assert.equal(foldServedSeq(500, 500), null, 'an unchanged value must not trigger a config write');
  });

  it('refuses a malformed value instead of poisoning the record', () => {
    // `sinceSeq` is a query-string integer from a remote caller. `parseInt('abc')` is NaN, which compares false
    // against everything — stored, it would make the member look permanently un-advanceable.
    for (const bad of [NaN, Infinity, -1, 0, 1.5]) {
      assert.equal(foldServedSeq(10, bad), null, `${String(bad)} was accepted`);
    }
  });
});
