/**
 * A space's RDF base is set once and moves only deliberately; every writer of `meta.rdf` asks one function (Q-748, slice A, design r4
 * §4.1). The base is the one rule that cannot change after release without breaking every address already given out.
 *
 * `settleRdf(stored, incoming, source, ctx)` in `server/src/spaces/rdf-settle.ts` answers, per source:
 *
 * | source | rule |
 * |---|---|
 * | `local` | an omission keeps the stored value; the first enable takes `<public url>/ld/<space>/` (400 `rdf_base_needed` with only the fallback URL); a different base is 409 `rdf_base_frozen` naming both, unless `rebase: true`; on a space in no network that raises the epoch; on a networked space it is a proposal (`proposeRebase`), the stored base unchanged |
 * | `settings-round`, `layer` | no `rdf` keeps the stored one; a different base never moves it, at any epoch; a higher epoch with a held, passed, unapplied rebase round is quietly early; otherwise a different base at the same or a higher epoch is a named conflict; nothing stored adopts what arrives |
 * | `rebase-round` | sets base, vocab and epoch, and says what moved |
 *
 * Run: node --test testing/standalone/a-space-rdf-setting-is-settled-by-one-rule.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../server/dist/spaces/rdf-settle.js').catch(() => ({}));
const settle = (...args) => {
  assert.equal(typeof mod.settleRdf, 'function', 'settleRdf is not exported by server/src/spaces/rdf-settle.ts: the base rule has no home');
  return mod.settleRdf(...args);
};

const OLD = 'https://a.example.org/ld/s1/';
const NEW = 'https://b.example.org/ld/s1/';
const STORED = { enabled: true, base: OLD, vocab: `${OLD}vocab/`, baseEpoch: 0 };
const LOCAL = { spaceId: 's1', publicBaseUrl: 'https://a.example.org', networked: false };

describe('local: the door', () => {
  it('the first enable takes <public url>/ld/<space>/, vocab under it, epoch 0', () => {
    const out = settle(undefined, { enabled: true }, 'local', LOCAL);
    assert.equal(out.ok, true);
    assert.deepEqual(out.rdf, { enabled: true, base: 'https://a.example.org/ld/s1/', vocab: 'https://a.example.org/ld/s1/vocab/', baseEpoch: 0 });
  });
  it('the first enable with only the fallback URL is 400 rdf_base_needed, naming both fixes', () => {
    const out = settle(undefined, { enabled: true }, 'local', { ...LOCAL, publicBaseUrl: undefined });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.equal(out.code, 'rdf_base_needed');
    assert.match(out.error, /publicUrl|PUBLIC_BASE_URL/);
    assert.match(out.error, /rdf\.base/);
  });
  it('a base sent at the first enable is taken as it is', () => {
    const out = settle(undefined, { enabled: true, base: NEW }, 'local', { ...LOCAL, publicBaseUrl: undefined });
    assert.deepEqual(out.rdf, { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 0 });
  });
  it('an omission keeps what is stored: switching off keeps the base, and on again reuses it', () => {
    const off = settle(STORED, { enabled: false }, 'local', LOCAL);
    assert.deepEqual(off.rdf, { ...STORED, enabled: false });
    const on = settle(off.rdf, { enabled: true }, 'local', LOCAL);
    assert.deepEqual(on.rdf, STORED);
    assert.deepEqual(settle(STORED, undefined, 'local', LOCAL).rdf, STORED, 'no rdf in the write keeps it');
  });
  it('a sent epoch is overwritten by the stored one at a door', () => {
    assert.equal(settle(STORED, { enabled: true, baseEpoch: 7 }, 'local', LOCAL).rdf.baseEpoch, 0);
  });
  it('a different base without rebase is 409 rdf_base_frozen naming both bases', () => {
    const out = settle(STORED, { enabled: true, base: NEW }, 'local', LOCAL);
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.equal(out.code, 'rdf_base_frozen');
    assert.ok(out.error.includes(OLD) && out.error.includes(NEW), out.error);
  });
  it('a different vocab alone is frozen too: the vocab moves only with the base', () => {
    const out = settle(STORED, { enabled: true, vocab: 'https://x.example.org/v/' }, 'local', LOCAL);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'rdf_base_frozen');
    const rebased = settle(STORED, { enabled: true, vocab: 'https://x.example.org/v/', rebase: true }, 'local', LOCAL);
    assert.equal(rebased.ok, false, 'a rebase that keeps the base is no rebase');
  });
  it('rebase on a space in no network raises the epoch and says what moved; the flag is never stored', () => {
    const out = settle(STORED, { enabled: true, base: NEW, rebase: true }, 'local', LOCAL);
    assert.equal(out.ok, true);
    assert.deepEqual(out.rdf, { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 1 });
    assert.deepEqual(out.rebased, { from: OLD, to: NEW, epoch: 1 });
    assert.equal('rebase' in out.rdf, false);
  });
  it('rebase on a networked space is a proposal: the stored base stays until the round lands', () => {
    const out = settle(STORED, { enabled: true, base: NEW, rebase: true }, 'local', { ...LOCAL, networked: true });
    assert.equal(out.ok, true);
    assert.deepEqual(out.rdf, STORED);
    assert.deepEqual(out.proposeRebase, { base: NEW, vocab: `${NEW}vocab/`, epoch: 1 });
  });
  it('a different base on a networked space without rebase is frozen as on a solo one', () => {
    assert.equal(settle(STORED, { enabled: true, base: NEW }, 'local', { ...LOCAL, networked: true }).code, 'rdf_base_frozen');
  });
});

for (const source of ['settings-round', 'layer']) {
  describe(`${source}: never by accident`, () => {
    it('no rdf keeps the stored one (an older peer\'s wholesale round included)', () => {
      const out = settle(STORED, undefined, source, {});
      assert.deepEqual(out.rdf, STORED);
      assert.equal(out.conflict, undefined);
    });
    it('another base at the same epoch never moves it, and is a named conflict', () => {
      const out = settle(STORED, { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 0 }, source, { networkId: 'n1' });
      assert.deepEqual(out.rdf, STORED);
      assert.deepEqual(out.conflict, { held: { base: OLD, epoch: 0 }, offered: [{ networkId: 'n1', base: NEW, epoch: 0 }] });
    });
    it('another base at a higher epoch never moves it either; with no round held for it, it is a conflict', () => {
      const out = settle(STORED, { enabled: true, base: NEW, baseEpoch: 1 }, source, {});
      assert.deepEqual(out.rdf, STORED);
      assert.ok(out.conflict, 'a conflict');
    });
    it('a higher epoch with a held, passed, unapplied rebase round for it is quietly early', () => {
      const out = settle(STORED, { enabled: true, base: NEW, baseEpoch: 1 }, source, { heldRebaseEpochs: new Set([1]) });
      assert.deepEqual(out.rdf, STORED);
      assert.equal(out.conflict, undefined);
    });
    it('a lower epoch is a stale copy: ignored, no conflict', () => {
      const out = settle({ ...STORED, baseEpoch: 2 }, { enabled: true, base: NEW, baseEpoch: 1 }, source, {});
      assert.deepEqual(out.rdf, { ...STORED, baseEpoch: 2 });
      assert.equal(out.conflict, undefined);
    });
    it('the same base agrees; enabled follows what the network says', () => {
      const out = settle(STORED, { enabled: false, base: OLD, vocab: `${OLD}vocab/`, baseEpoch: 0 }, source, {});
      assert.deepEqual(out.rdf, { ...STORED, enabled: false });
      assert.equal(out.conflict, undefined);
    });
    it('nothing stored adopts what arrives (the first enable of a shared space)', () => {
      const offered = { enabled: true, base: NEW, vocab: `${NEW}vocab/`, baseEpoch: 3 };
      assert.deepEqual(settle(undefined, offered, source, {}).rdf, offered);
    });
  });
}

describe('rebase-round: a passed space_rebase at its deadline', () => {
  it('sets base, vocab and epoch and says what moved', () => {
    const out = settle(STORED, { base: NEW, vocab: `${NEW}v/`, epoch: 1 }, 'rebase-round', {});
    assert.deepEqual(out.rdf, { enabled: true, base: NEW, vocab: `${NEW}v/`, baseEpoch: 1 });
    assert.deepEqual(out.rebased, { from: OLD, to: NEW, epoch: 1 });
  });
  it('an epoch already held is applied once: nothing moves the second time', () => {
    const first = settle(STORED, { base: NEW, vocab: `${NEW}v/`, epoch: 1 }, 'rebase-round', {});
    const again = settle(first.rdf, { base: NEW, vocab: `${NEW}v/`, epoch: 1 }, 'rebase-round', {});
    assert.deepEqual(again.rdf, first.rdf);
    assert.equal(again.rebased, undefined);
  });
});
