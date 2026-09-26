/**
 * The file-tombstone retention floor — built from acknowledgement, because there is no seq to build it from.
 *
 * ## Why this is a different mechanism, not a copy
 *
 * Record tombstones are bounded by the `sinceSeq` a peer pulls from (`tombstone-floor.test.js`). File
 * tombstones have **no seq at all** — they are keyed by `deletedAt` — so the confirmation has to come from the
 * PUSH: `POST /api/sync/file-tombstones` upserts what it receives and re-propagates it onward, so a 200 proves
 * that peer now holds it and will keep passing it on.
 *
 * That makes three failure modes this file exists for, all of which delete a tombstone no peer has seen:
 *
 *   1. **Acking a push that was refused.** A 403 (direction-blocked) or a timeout proves nothing. Advancing on
 *      anything but a 200 is how a deleted file comes back on the next manifest sync.
 *   2. **Acking a position from a fresh query** rather than the array that was sent. A file deleted between
 *      building the body and reading the response was never in the payload.
 *   3. **Comparing timestamps that do not sort.** ISO8601 UTC compares lexically; an offset form
 *      (`+02:00`) does not, and would move the floor forward wrongly rather than fail.
 *
 * The stake is higher here than for records: `FileTombstoneDoc.path` is often personal in itself, so this is
 * the half that decides whether a deleted file's NAME is retained forever.
 *
 * Run: node --test testing/standalone/file-tombstone-ack.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SPACE = 'kb';

let fileTombstoneFloor, fileTombstoneFloorForSpace, ackedPositionFrom, foldAckedAt, isComparableIso,
  applyFileTombstoneAck;

before(async () => {
  ({ fileTombstoneFloor, fileTombstoneFloorForSpace, ackedPositionFrom, foldAckedAt, isComparableIso,
    applyFileTombstoneAck } = await import('../../server/dist/sync/file-tombstone-ack.js'));
});

const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const acked = (instanceId, day, spaceId = SPACE) => ({
  instanceId, label: instanceId, lastFileTombstoneAckedAt: { [spaceId]: iso(day) },
});

describe('file tombstone floor', () => {
  it('drops everything when there is no peer to propagate to', () => {
    // A file tombstone exists only to tell peers the file is gone. With no peers it carries the path and
    // nothing else — which is the privacy finding in one sentence.
    const f = fileTombstoneFloor([], SPACE, []);
    assert.equal(f.prune, true);
    assert.equal(f.peers, 0);
    assert.ok(f.upTo > iso(31), `upTo was ${f.upTo}, so nothing would match`);
  });

  it('takes the EARLIEST acknowledged position, not the latest', () => {
    const f = fileTombstoneFloor([acked('a', 20), acked('b', 3), acked('c', 28)], SPACE);
    assert.equal(f.prune, true);
    assert.equal(f.upTo, iso(3));
  });

  it('order does not decide it', () => {
    assert.deepEqual(
      fileTombstoneFloor([acked('a', 5), acked('b', 9)], SPACE),
      fileTombstoneFloor([acked('b', 9), acked('a', 5)], SPACE),
    );
  });

  it('a member that has never acked BLOCKS the prune, and is named', () => {
    const f = fileTombstoneFloor([acked('a', 20), { instanceId: 'b', label: 'branch-office' }], SPACE);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'member-never-acked');
    assert.equal(f.blockedBy, 'branch-office');
  });

  it('an ack for a different space does not count', () => {
    const f = fileTombstoneFloor([{ instanceId: 'a', lastFileTombstoneAckedAt: { other: iso(20) } }], SPACE);
    assert.equal(f.prune, false);
  });

  it('a peer token with no member entry blocks the prune', () => {
    const f = fileTombstoneFloor([acked('a', 20)], SPACE, ['a', 'ghost']);
    assert.equal(f.prune, false);
    assert.equal(f.reason, 'peer-token-scoped');
    assert.equal(f.blockedBy, 'ghost');
  });

  it('refuses a timestamp that does not sort lexically', () => {
    // `2026-08-02T00:00:00+02:00` is EARLIER than `2026-08-02T00:00:00.000Z` in real time but sorts LATER as a
    // string. Comparing it would move the floor past tombstones nobody has acknowledged.
    for (const bad of ['2026-08-02T00:00:00+02:00', '2026-08-02', '2026-08-02T00:00:00Z', 1_754_000_000_000, null, '']) {
      const f = fileTombstoneFloor([{ instanceId: 'a', lastFileTombstoneAckedAt: { [SPACE]: bad } }], SPACE);
      assert.equal(f.prune, false, `${String(bad)} was accepted as a position`);
    }
    assert.equal(isComparableIso(iso(2)), true);
  });

  it('reads the config: members from every network carrying the space, plus peer tokens', () => {
    const cfg = {
      instanceId: 'self', instanceLabel: 'self', spaces: [{ id: SPACE }], tokens: [],
      networks: [
        { id: 'n1', spaces: [SPACE], members: [acked('a', 10)] },
        { id: 'n2', spaces: [SPACE], members: [acked('b', 4)] },
      ],
    };
    assert.equal(fileTombstoneFloorForSpace(cfg, SPACE).upTo, iso(4));

    /*
     * The peer token carries a rights MATRIX now, not a legacy `spaces` allowlist.
     *
     * This is the one place where 4.0's fail-closed change has a data consequence rather than an access one:
     * a peer token that does not reach the space no longer holds the tombstone floor, so tombstones for a
     * space it cannot see are prunable. That is correct — the floor exists so a peer that will still ask for
     * a tombstone gets it — but it means a record with NO matrix would stop holding the floor, and the
     * symptom would be pruning ahead of a peer rather than a 403 someone reports.
     *
     * It cannot happen to a real token: `createToken` writes a matrix and the boot backfill derives one in
     * memory for anything older, so every stored token has one by the time this function reads the config.
     * The record here is built the way a real one looks, which is the point — a fixture that cannot occur
     * was what made the old allowlist arm look load-bearing.
     */
    cfg.tokens = [{ id: 't', peerInstanceId: 'unlisted',
      rights: { instanceAdmin: false, createSpaces: false, floor: null,
        perSpace: { [SPACE]: { knowledge: 'read' } } } }];
    assert.equal(fileTombstoneFloorForSpace(cfg, SPACE).prune, false);
  });
});

describe('what a push actually proves', () => {
  it('takes the newest deletedAt from the array that was SENT', () => {
    const pushed = [{ deletedAt: iso(1) }, { deletedAt: iso(9) }, { deletedAt: iso(4) }];
    assert.equal(ackedPositionFrom(pushed), iso(9));
  });

  it('proves nothing from an empty push', () => {
    assert.equal(ackedPositionFrom([]), null);
  });

  it('skips a malformed row instead of letting it vouch for the rest', () => {
    assert.equal(ackedPositionFrom([{ deletedAt: 'yesterday' }, { deletedAt: iso(2) }]), iso(2));
    assert.equal(ackedPositionFrom([{ deletedAt: 'yesterday' }, {}]), null);
  });

  it('records an ack, monotonically', () => {
    const cfg = {
      spaces: [{ id: SPACE }], tokens: [],
      networks: [{ id: 'n1', spaces: [SPACE], members: [{ instanceId: 'p1', label: 'p1' }] }],
    };
    assert.equal(applyFileTombstoneAck(cfg, 'p1', SPACE, iso(5)), true);
    assert.equal(cfg.networks[0].members[0].lastFileTombstoneAckedAt[SPACE], iso(5));

    // A later push carrying only OLDER tombstones must not walk the position backwards.
    assert.equal(applyFileTombstoneAck(cfg, 'p1', SPACE, iso(2)), false);
    assert.equal(cfg.networks[0].members[0].lastFileTombstoneAckedAt[SPACE], iso(5));
    assert.equal(applyFileTombstoneAck(cfg, 'p1', SPACE, iso(5)), false, 'no-op must not trigger a config write');
  });

  it('records nothing without a position — a refused push must leave it unknown', () => {
    const cfg = {
      spaces: [{ id: SPACE }], tokens: [],
      networks: [{ id: 'n1', spaces: [SPACE], members: [{ instanceId: 'p1' }] }],
    };
    assert.equal(applyFileTombstoneAck(cfg, 'p1', SPACE, null), false);
    assert.equal(applyFileTombstoneAck(cfg, undefined, SPACE, iso(5)), false);
    assert.equal(applyFileTombstoneAck(cfg, 'stranger', SPACE, iso(5)), false);
    assert.equal(cfg.networks[0].members[0].lastFileTombstoneAckedAt, undefined);
  });

  it('foldAckedAt refuses an incomparable value rather than storing it', () => {
    assert.equal(foldAckedAt(undefined, '2026-08-02T00:00:00+02:00'), null);
    assert.equal(foldAckedAt(undefined, null), null);
    assert.equal(foldAckedAt('garbage', iso(3)), iso(3), 'a poisoned existing value must be recoverable');
  });
});

describe('file sync is wired to ack only a 200', () => {
  // Named file, so a move throws rather than passing. Two claims are asserted, and both are the difference
  // between safe and lossy — a source read is the cheapest place to pin them.
  const src = readFileSync(join(ROOT, 'server/src/sync/file-sync.ts'), 'utf8'); // file sync left the engine (Q-68)

  it('records the ack from the pushed array, guarded by response.ok', () => {
    assert.match(src, /if \(ackResp\.ok\)\s*\{\s*\n\s*recordFileTombstoneAck\(member\.instanceId, spaceId, ackedPositionFrom\(ourTombstones\)\)/,
      'the file-tombstone push no longer acks only on a 200 from the array it sent');
  });

  it('does not re-query the collection to decide what was acknowledged', () => {
    // The trap: `find()` again after the push, catching a tombstone created in between and marking it delivered.
    const block = src.slice(src.indexOf('1b. Push our file tombstones'), src.indexOf('2. Fetch peer manifest'));
    assert.ok(block.length > 200, 'the push block was not located');
    assert.equal((block.match(/\.find\(/g) ?? []).length, 1, 'more than one query in the push block');
  });

  it('the rename carries EVERY per-space watermark, and the type has not grown one it misses', async () => {
    /*
     * This named the four and looked for four `if` blocks, which is the shape it was checking rather than
     * the rule — and the rule matters because the failure is silent: a watermark that is not carried resets
     * to "unknown", which is SAFE. The pull re-reads from 0, idempotent by seq; the retention floors just
     * stop pruning. Nothing errors, nothing is lost, and nobody reports it.
     *
     * So: the list is `PER_SPACE_WATERMARKS`, beside the interface where a fifth one gets added, and the
     * INTERFACE'S OWN SOURCE is read to check that a field keyed by space id has not been added to it and
     * left out of the list. That is the direction a list rots in.
     */
    const { PER_SPACE_WATERMARKS } = await import('../../server/dist/config/types-networks.js');
    assert.ok(PER_SPACE_WATERMARKS.length >= 4,
      `only ${PER_SPACE_WATERMARKS.length} watermark(s) declared — the import is stale`);

    const rename = readFileSync(join(ROOT, 'server/src/spaces/rename.ts'), 'utf8');
    assert.match(rename, /for \(const key of PER_SPACE_WATERMARKS\)/,
      'the rename carries its watermarks by name instead of looping the declared list, so a fifth one is '
      + 'carried by nobody and resets to "unknown" without a word');

    // The member interface, as source: every `lastX?: Record<string, …>` on it is keyed by space id. Through
    // the shared derivation, because `counter-wipe-clears-every-watermark` asks the same question about the
    // same interface, and one regex written twice is what this whole sweep is about.
    const perSpace = memberWatermarks();
    assert.deepEqual([...perSpace].sort(), [...PER_SPACE_WATERMARKS].sort(),
      'a member field keyed by space id is missing from PER_SPACE_WATERMARKS (or the list names one that is '
      + 'gone). The rename loops that list, so a field outside it is silently reset on every space rename');
  });

  it('the pull is deliberately NOT filtered by `since`, and says why', () => {
    // A `deletedAt > since` filter would skip an old deletion relayed onward later — the tombstone is older
    // than our watermark, so we never see it and the file stays. This asserts the reasoning survives, because
    // the "optimisation" is the obvious next edit somebody makes.
    const ack = readFileSync(join(ROOT, 'server/src/sync/file-tombstone-ack.ts'), 'utf8');
    assert.match(ack, /Why the PULL is deliberately left unfiltered/);
    assert.doesNotMatch(src, /file-tombstones\?spaceId=[^\n]*&since=/,
      'the file-tombstone pull now sends `since`, which can skip a relayed older deletion');
  });
});
