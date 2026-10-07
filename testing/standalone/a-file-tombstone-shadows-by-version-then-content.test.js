/**
 * An arriving file is shadowed by a held file tombstone BY VERSION for its metadata and BY CONTENT for its bytes.
 *
 * ## The rule (`shadowDecision` in `files/tombstones.ts`, plan §6, Q-229)
 *
 * A tombstone is a statement about a version of a path, not about the path for ever:
 *
 *   - **metadata** (`{ kind: 'meta', seq }`): shadowed when some held tombstone for the path has `rowSeq >= seq` — the
 *     arriving version is the one the deletion erased, or older. A HIGHER seq is a newer version and passes. A held
 *     tombstone with no `rowSeq` (legacy, from before this release) shadows NO metadata: today's behaviour, and the
 *     stated limit of the release.
 *   - **bytes** (`{ kind: 'bytes', sha256, liveRowNewer }`): shadowed when some held tombstone's own local
 *     `contentHash` equals the arriving hash AND no live row at the path is newer than the tombstone. Identical bytes
 *     re-created as a newer version arrive with their metadata first (`liveRowNewer`) and pass. A tombstone with no
 *     `contentHash` (legacy) shadows no bytes — the path-only discard the stray drain keeps is a separate, named rule.
 *
 * Without the version half a deleted file's path is poisoned for ever (every later upload of it is refused); without
 * the content half a peer's still-live copy of the deleted bytes re-downloads on every cycle (the loop Q-229 fixed).
 *
 * ## Mutation that turns it red
 *
 * Compare `rowSeq` with `>` instead of `>=` (the erased version re-enters), compare against the arrival's seq the
 * wrong way round (every newer version is refused), let a missing `rowSeq` shadow (legacy tombstones swallow new
 * versions), ignore `liveRowNewer` (re-created identical bytes are refused), or match bytes without a hash.
 *
 * Run: node --test testing/standalone/a-file-tombstone-shadows-by-version-then-content.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/files/tombstones.js', import.meta.url); });
const decide = (rule) => needModule(loaded, ['shadowDecision'], rule).shadowDecision;

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

describe('metadata is shadowed by version', () => {
  it('an arrival at or below the held rowSeq is shadowed; one above it is not — every offset around the boundary', () => {
    const shadowed = decide('boundary');
    for (const rowSeq of [1, 7, 4096]) {
      const held = [{ rowSeq }];
      for (const [offset, want] of [[-3, true], [-1, true], [0, true], [1, false], [3, false]]) {
        const seq = rowSeq + offset;
        if (seq < 0) continue;
        assert.equal(shadowed(held, { kind: 'meta', seq }), want, `rowSeq ${rowSeq}, arrival seq ${seq}`);
      }
    }
  });

  it('a legacy tombstone (no rowSeq) shadows no metadata, whatever the seq and whatever its hash', () => {
    const shadowed = decide('legacy');
    for (const held of [{}, { contentHash: HASH }, { rowSeq: undefined, contentHash: HASH }]) {
      for (const seq of [0, 1, 99999]) assert.equal(shadowed([held], { kind: 'meta', seq }), false, `${JSON.stringify(held)} seq ${seq}`);
    }
  });

  it('nothing held shadows nothing', () => {
    assert.equal(decide('empty')([], { kind: 'meta', seq: 1 }), false);
    assert.equal(decide('empty')([], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), false);
  });

  it('with several tombstones held for the path, ANY one that covers the version shadows it — and a legacy one beside does not hide it', () => {
    const shadowed = decide('several');
    const held = [{}, { rowSeq: 3 }, { rowSeq: 9 }];
    assert.equal(shadowed(held, { kind: 'meta', seq: 9 }), true);
    assert.equal(shadowed(held, { kind: 'meta', seq: 10 }), false);
    assert.equal(shadowed([{}, { rowSeq: 3 }], { kind: 'meta', seq: 4 }), false);
  });

  it('a tombstone that carries only a content hash says nothing about versions', () => {
    assert.equal(decide('hash only')([{ contentHash: HASH }], { kind: 'meta', seq: 1 }), false);
  });
});

describe('bytes are shadowed by content', () => {
  it('matching hash, no newer live row: shadowed', () => {
    assert.equal(decide('match')([{ contentHash: HASH }], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), true);
  });

  it('matching hash but a newer live row at the path: identical bytes re-created as a newer version pass', () => {
    assert.equal(decide('re-created')([{ contentHash: HASH, rowSeq: 4 }], { kind: 'bytes', sha256: HASH, liveRowNewer: true }), false);
  });

  it('a different hash passes, newer row or not', () => {
    const shadowed = decide('different');
    for (const liveRowNewer of [true, false]) {
      assert.equal(shadowed([{ contentHash: HASH }], { kind: 'bytes', sha256: OTHER_HASH, liveRowNewer }), false, `liveRowNewer ${liveRowNewer}`);
    }
  });

  it('a legacy tombstone with no contentHash shadows no bytes', () => {
    const shadowed = decide('legacy bytes');
    for (const held of [{}, { rowSeq: 12 }]) {
      assert.equal(shadowed([held], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), false, JSON.stringify(held));
    }
  });

  it('the rowSeq on a tombstone does not decide bytes: the hash does', () => {
    const shadowed = decide('rowSeq irrelevant to bytes');
    assert.equal(shadowed([{ rowSeq: 1, contentHash: HASH }], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), true);
    assert.equal(shadowed([{ rowSeq: 1_000_000, contentHash: OTHER_HASH }], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), false);
  });

  it('with several tombstones held, any one whose hash matches shadows the bytes', () => {
    const shadowed = decide('several bytes');
    assert.equal(shadowed([{ contentHash: OTHER_HASH }, {}, { contentHash: HASH }], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), true);
    assert.equal(shadowed([{ contentHash: OTHER_HASH }, {}], { kind: 'bytes', sha256: HASH, liveRowNewer: false }), false);
  });
});

describe('the two kinds ask different questions', () => {
  it('a held tombstone with a matching hash and a high rowSeq shadows the bytes but not a newer version\'s metadata', () => {
    const shadowed = decide('kinds');
    const held = [{ rowSeq: 5, contentHash: HASH }];
    assert.equal(shadowed(held, { kind: 'bytes', sha256: HASH, liveRowNewer: false }), true);
    assert.equal(shadowed(held, { kind: 'meta', seq: 6 }), false);
    assert.equal(shadowed(held, { kind: 'meta', seq: 5 }), true);
  });
});
