/**
 * The decisions of the schema snapshot fetch are PURE functions of their arguments, tested here without a store, a peer or a clock
 * (bundle-265, Q-738; design A6, 3.1 `servableTo`, 3.2 `behindVerdict`, 3.3 the owed set, 3.4 `verifySnapshot`).
 *
 * ## The interface these cases fix (the design names the functions, not their argument and answer shapes)
 *
 * All four live in `server/src/spaces/schema-snapshot.ts`:
 *
 * - `servableTo(row, sharedNetworks)`: `row` is a row of `<space>_schema_snapshots` (`origin` own | layer | fetched, `networkId` on a layer row, `links`
 *   `{ own, layers: [{ networkId, fp }], served: [{ networkId, fp }] }` or `null`); `sharedNetworks` is a `Set` of network ids (the networks the asking
 *   peer and this server both hold the space in). Answers `{ ok: true, links }` (the links cut to the shared networks, `null` when the row has none) or
 *   `{ ok: false, code: 'not_shared' }`. It never changes the row it is given.
 * - `verifySnapshot(text, fp)`: answers `{ ok: true }` or `{ ok: false, outcome }` with `outcome` one of `over_cap`, `refused_hash`, `refused_shape` - the
 *   three terminal outcomes of the metric `ythril_schema_snapshot_total`.
 * - `owedFingerprints(carried, held)`: the fingerprints the records carry that no snapshot row holds, each once, in the order they were first carried.
 * - `behindVerdict(mine, sender)`: `mine = { networks: [{ networkId, role, layerFp, heldLayerFps }] }`, one entry per network this space shares with the
 *   sender, `role` being `'upstream'` (the sender is this server's upstream in a directional network), `'closed'` (layers arrive by passed rounds) or
 *   `'downstream'`; `sender = { fp, links, layerOf? }` is what the sender's snapshot answer said. Answers the ids of the networks this variation is
 *   BEHIND on, in `mine.networks` order. A verdict is a hint (S-N3): the caller logs it and counts `behind`, it keeps nothing because of it.
 *
 * ## Seen red
 *
 * At ce37b83a `spaces/schema-snapshot.js` does not exist: every case fails with "exports no <name>" naming the missing module.
 *
 * Run: node --test testing/standalone/a-schema-snapshot-decisions-are-pure-functions.test.js (requires `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const TEN_MIB = 10 * 1024 * 1024;
const fp = (c) => c.repeat(64);

let mod;
before(async () => { mod = await import('../../server/dist/spaces/schema-snapshot.js').catch(err => ({ __missing: err })); });
/** The function, or a failure that says which module or export is missing. */
const need = (name) => {
  assert.ok(!mod.__missing, `server/dist/spaces/schema-snapshot.js does not load (${mod.__missing?.code ?? mod.__missing}): ${name} cannot be asked`);
  assert.equal(typeof mod[name], 'function', `spaces/schema-snapshot.js exports no ${name}`);
  return mod[name];
};

let canonicalJson;
before(async () => { ({ canonicalJson } = await import('../../server/dist/util/canonical-json.js')); });
const textOf = (typeSchemas, rules = {}) => canonicalJson({ format: 1, typeSchemas, rules });
const GOOD = { entity: { project: { propertySchemas: { status: { type: 'string', enum: ['open', 'done'] } } } }, fact: { note: { propertySchemas: { body: { type: 'string' } } } } };

describe('servableTo: may this row go to a peer that shares these networks', () => {
  const own = (layers, served = [], ownFp = fp('e')) => ({ _id: fp('1'), origin: 'own', links: { own: ownFp, layers, served } });
  const L = (networkId, c = 'a') => ({ networkId, fp: fp(c) });

  it('refuses a two-layer variation to a peer that shares one of the layers\' networks: it names the other network\'s definitions', () => {
    const r = need('servableTo')(own([L('n1'), L('n2', 'b')]), new Set(['n1']));
    assert.deepEqual(r, { ok: false, code: 'not_shared' });
  });

  it('serves the same row to a peer that shares both', () => {
    const row = own([L('n1'), L('n2', 'b')], [L('n1', 'c'), L('n2', 'd')]);
    const r = need('servableTo')(row, new Set(['n1', 'n2']));
    assert.equal(r.ok, true);
    assert.deepEqual(r.links, row.links);
  });

  it('serves a one-layer row with its links cut to the shared networks: no entry of a network the peer is not in', () => {
    const r = need('servableTo')(own([L('n1')], [L('n1', 'c'), L('n3', 'd')]), new Set(['n1']));
    assert.equal(r.ok, true);
    assert.deepEqual(r.links.layers, [L('n1')]);
    assert.deepEqual(r.links.served, [L('n1', 'c')]);
    assert.equal(r.links.own, fp('e'));
  });

  it('refuses the layer row of a network the peer does not share, and serves the layer row of one it does', () => {
    const f = need('servableTo');
    assert.deepEqual(f({ _id: fp('2'), origin: 'layer', networkId: 'n2', links: null }, new Set(['n1'])), { ok: false, code: 'not_shared' });
    assert.equal(f({ _id: fp('2'), origin: 'layer', networkId: 'n1', links: null }, new Set(['n1'])).ok, true);
  });

  it('serves an own row with no layers at all: nothing is mixed into it', () => {
    const r = need('servableTo')(own([], []), new Set(['n1']));
    assert.equal(r.ok, true);
    assert.deepEqual(r.links.layers, []);
  });

  it('refuses a fetched row of unknown provenance (no links, no layer) to everyone, even a peer sharing every network', () => {
    const r = need('servableTo')({ _id: fp('3'), origin: 'fetched', from: 'x', links: null }, new Set(['n1', 'n2']));
    assert.deepEqual(r, { ok: false, code: 'not_shared' });
  });

  it('judges a fetched row by its sender\'s links: refused when they name a network the peer does not share', () => {
    const f = need('servableTo');
    const row = { _id: fp('4'), origin: 'fetched', from: 'x', links: { own: fp('e'), layers: [L('n1'), L('n2', 'b')], served: [] } };
    assert.equal(f(row, new Set(['n1'])).ok, false);
    assert.equal(f(row, new Set(['n1', 'n2'])).ok, true);
  });

  it('never changes the row it is given', () => {
    const row = own([L('n1')], [L('n1', 'c'), L('n3', 'd')]);
    const before = structuredClone(row);
    need('servableTo')(row, new Set(['n1']));
    assert.deepEqual(row, before);
  });
});

describe('verifySnapshot: a fetched text is kept only when it is the canonical text its fingerprint names', () => {
  const verify = (text, name = sha(text)) => need('verifySnapshot')(text, name);

  it('accepts the canonical text of a schema, and the empty schema', () => {
    assert.equal(verify(textOf(GOOD)).ok, true);
    assert.equal(verify(textOf({})).ok, true);
  });

  it('refuses a text its fingerprint does not name: refused_hash', () => {
    assert.deepEqual(verify(textOf(GOOD), fp('0')), { ok: false, outcome: 'refused_hash' });
  });

  it('refuses the same content pretty-printed and named by its own hash: it is not the canonical text (refused_shape)', () => {
    const pretty = JSON.stringify(JSON.parse(textOf(GOOD)), null, 2);
    assert.deepEqual(verify(pretty), { ok: false, outcome: 'refused_shape' });
  });

  it('refuses an extra top-level key, a format other than 1, a bad property type and non-JSON: refused_shape', () => {
    const extra = canonicalJson({ ...JSON.parse(textOf(GOOD)), x: 1 });
    const format2 = canonicalJson({ ...JSON.parse(textOf(GOOD)), format: 2 });
    const bogus = textOf({ entity: { x: { propertySchemas: { a: { type: 'bogus' } } } } });
    for (const [what, text] of [['an extra key', extra], ['format 2', format2], ['a bad property type', bogus], ['non-JSON', 'x'.repeat(100)]]) {
      assert.deepEqual(verify(text), { ok: false, outcome: 'refused_shape' }, what);
    }
  });

  it('measures the cap in bytes, never in characters: 6 Mi of a two-byte letter is over the cap with a length under it', () => {
    const text = 'Ü'.repeat(6 * 1024 * 1024);
    assert.ok(text.length < TEN_MIB && Buffer.byteLength(text, 'utf8') > TEN_MIB, 'the fixture is not the case it is meant to be');
    assert.deepEqual(verify(text), { ok: false, outcome: 'over_cap' });
  });

  it('draws the cap at exactly 10 MiB of bytes: that many is judged on its content, one more is over_cap', () => {
    assert.deepEqual(verify('x'.repeat(TEN_MIB)), { ok: false, outcome: 'refused_shape' });
    assert.deepEqual(verify('x'.repeat(TEN_MIB + 1)), { ok: false, outcome: 'over_cap' });
  });

  it('asks the cap before the hash, and the hash before the shape', () => {
    assert.equal(verify('x'.repeat(TEN_MIB + 1), fp('0')).outcome, 'over_cap');
    assert.equal(verify('not json', fp('0')).outcome, 'refused_hash');
  });
});

describe('owedFingerprints: what the records carry and no snapshot holds', () => {
  it('names each carried fingerprint no row holds, once, in the order it was first carried', () => {
    const r = need('owedFingerprints')([fp('a'), fp('b'), fp('a'), fp('c'), fp('b')], new Set([fp('b')]));
    assert.deepEqual(r, [fp('a'), fp('c')]);
  });

  it('answers nothing when every carried fingerprint is held, and nothing for nothing carried', () => {
    const f = need('owedFingerprints');
    assert.deepEqual(f([fp('a')], new Set([fp('a')])), []);
    assert.deepEqual(f([], new Set()), []);
  });

  it('takes the carried fingerprints from any iterable and never changes the held set', () => {
    const held = new Set([fp('a')]);
    const r = need('owedFingerprints')(new Set([fp('a'), fp('z')]), held);
    assert.deepEqual(r, [fp('z')]);
    assert.deepEqual([...held], [fp('a')]);
  });
});

describe('behindVerdict: is this variation behind the sender\'s on a network they share', () => {
  const net = (networkId, role, layerFp, heldLayerFps = [layerFp]) => ({ networkId, role, layerFp, heldLayerFps });
  const links = (layers, served) => ({ own: fp('e'), layers, served });
  const at = (networkId, c) => ({ networkId, fp: fp(c) });
  const verdict = (mine, sender) => need('behindVerdict')({ networks: mine }, sender);

  it('upstream: behind when what the sender serves for the network is a layer this server never held', () => {
    assert.deepEqual(verdict([net('n1', 'upstream', fp('a'))], { fp: fp('s'), links: links([at('n1', 'a')], [at('n1', 'b')]) }), ['n1']);
  });

  it('upstream: not behind when the sender serves the layer this server holds', () => {
    assert.deepEqual(verdict([net('n1', 'upstream', fp('a'))], { fp: fp('s'), links: links([at('n1', 'x')], [at('n1', 'a')]) }), []);
  });

  it('upstream: not behind when the sender serves a layer this server held before (the SENDER is the one behind)', () => {
    assert.deepEqual(verdict([net('n1', 'upstream', fp('a'), [fp('a'), fp('old')])], { fp: fp('s'), links: links([], [at('n1', 'old')]) }), []);
  });

  it('upstream: a sender whose snapshot IS the network\'s layer is compared by its own fingerprint', () => {
    assert.deepEqual(verdict([net('n1', 'upstream', fp('a'))], { fp: fp('b'), layerOf: 'n1', links: null }), ['n1']);
    assert.deepEqual(verdict([net('n1', 'upstream', fp('a'))], { fp: fp('a'), layerOf: 'n1', links: null }), []);
  });

  it('closed network: compares the layer the sender HOLDS, not what it serves', () => {
    assert.deepEqual(verdict([net('n1', 'closed', fp('a'))], { fp: fp('s'), links: links([at('n1', 'b')], [at('n1', 'a')]) }), ['n1']);
    assert.deepEqual(verdict([net('n1', 'closed', fp('a'))], { fp: fp('s'), links: links([at('n1', 'a')], [at('n1', 'b')]) }), []);
  });

  it('downstream: never behind - nobody takes schema from below', () => {
    assert.deepEqual(verdict([net('n1', 'downstream', fp('a'))], { fp: fp('s'), links: links([at('n1', 'b')], [at('n1', 'c')]) }), []);
  });

  it('names only the networks it is behind on, in the order of the networks it was given; a network the sender\'s links omit is not judged', () => {
    const mine = [net('n1', 'upstream', fp('a')), net('n2', 'upstream', fp('b')), net('n3', 'upstream', fp('c'))];
    const sender = { fp: fp('s'), links: links([], [at('n1', 'x'), at('n2', 'b')]) };
    assert.deepEqual(verdict(mine, sender), ['n1']);
  });
});

/*
 * snapshotSweepPlan (bundle-266, Q-739, design r2 D2 as r3 S-2 amends it): `snapshotSweepPlan(rows, carried, keep, now, grace)`.
 *
 * - `rows`: the space's snapshot rows as the sweep reads them, `{ _id, origin, links, orphanSince? }` (never `text`); `orphanSince` an ISO time.
 * - `carried`: a `Set` of the fingerprints a stored record of the space carries; `keep`: a `Set` of the current variation's own and layer
 *   fingerprints (`owedOf`); `now` and `grace` in ms.
 * - Answers `{ mark, clear, remove }`, each the ids (fingerprints) of rows: `mark` a candidate with no mark, `clear` a marked row that is no
 *   candidate, `remove` a candidate marked at most `now - grace` ago. A candidate: origin own or fetched, not carried, not kept, and linked
 *   (links.own, links.layers[].fp, links.served[].fp) by no row that stays this pass, recomputed until nothing changes. At most 256 removals,
 *   and a group a staying row links is never cut.
 *
 * Seen red at 82208a6b: `spaces/schema-snapshot.js` exports no snapshotSweepPlan, so every case fails at `need`.
 */
describe('snapshotSweepPlan: which snapshot rows the sweep marks, clears and removes', () => {
  const GRACE = 24 * 3_600_000;
  const NOW = Date.parse('2026-11-13T12:00:00.000Z');
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const row = (id, over = {}) => ({ _id: id, origin: 'own', links: null, ...over });
  const linksTo = (...fps) => ({ own: fps[0], layers: fps.slice(1).map(f => ({ networkId: 'n1', fp: f })), served: [] });
  /** The ids of an answer list, whether it holds ids or rows. */
  const idsOf = (xs) => (xs ?? []).map(x => (typeof x === 'string' ? x : x._id)).sort();
  const plan = (rows, { carried = [], keep = [], now = NOW, grace = GRACE } = {}) => {
    const out = need('snapshotSweepPlan')(rows, new Set(carried), new Set(keep), now, grace);
    return { mark: idsOf(out.mark), clear: idsOf(out.clear), remove: idsOf(out.remove) };
  };
  const A = fp('a'); const B = fp('b'); const C = fp('c'); const D = fp('d');

  it('an own or fetched row nothing carries, keeps or links is marked on its first pass, and nothing is removed', () => {
    assert.deepEqual(plan([row(A), row(B, { origin: 'fetched' })]), { mark: [A, B], clear: [], remove: [] });
  });

  it('a layer row is never a candidate, whatever carries it: it is not marked, and an old mark on it is cleared', () => {
    assert.deepEqual(plan([row(A, { origin: 'layer' }), row(B, { origin: 'layer', orphanSince: ago(GRACE * 3) })]), { mark: [], clear: [B], remove: [] });
  });

  it('a carried row and a kept row are no candidates; a mark on either is cleared, never acted on', () => {
    const rows = [row(A), row(B), row(C, { orphanSince: ago(GRACE * 2) }), row(D, { orphanSince: ago(GRACE * 2) })];
    assert.deepEqual(plan(rows, { carried: [A, C], keep: [B, D] }), { mark: [], clear: [C, D], remove: [] });
  });

  it('the grace boundary: a mark grace-1 ms old stays, one exactly grace old and one grace+1 ms old are removed', () => {
    const rows = [row(A, { orphanSince: ago(GRACE - 1) }), row(B, { orphanSince: ago(GRACE) }), row(C, { orphanSince: ago(GRACE + 1) })];
    assert.deepEqual(plan(rows), { mark: [], clear: [], remove: [B, C] });
  });

  it('a row a kept row links is kept, through every link field and transitively', () => {
    const old = { orphanSince: ago(GRACE * 2) };
    // A is carried; it links B by links.own and C by a layer link; C links D by links.served.
    const rows = [row(A, { links: linksTo(B, C) }), row(B, old), row(C, { ...old, links: { own: fp('9'), layers: [], served: [{ networkId: 'n2', fp: D }] } }), row(D, old)];
    const got = plan(rows, { carried: [A] });
    assert.deepEqual(got.remove, [], 'a row a kept row links (directly or through another) was removed');
    assert.deepEqual(got.clear, [B, C, D], 'a linked row keeps an old mark');
  });

  it('"kept" means not removed THIS pass: a row a candidate inside its grace links is not removed, and rows removed together may link each other', () => {
    // A is a candidate seen for the first time (marked now, so it stays this pass) and links B, whose mark is past the grace.
    const staying = plan([row(A, { links: linksTo(B) }), row(B, { orphanSince: ago(GRACE * 2) })]);
    assert.ok(staying.mark.includes(A), 'the fixture is wrong: A should be marked');
    assert.equal(staying.remove.includes(B), false, 'B was removed while A, which stays this pass, links it');
    // Both past the grace, linking each other in a cycle: both go, and the cycle ends.
    const both = plan([row(A, { links: linksTo(B), orphanSince: ago(GRACE * 2) }), row(B, { links: linksTo(A), orphanSince: ago(GRACE * 2) })]);
    assert.deepEqual(both.remove, [A, B]);
  });

  it('a row whose own link names itself is not kept by that link: an own variation with no layer is marked, then removed', () => {
    const self = (id, over = {}) => row(id, { links: { own: id, layers: [], served: [] }, ...over });
    assert.deepEqual(plan([self(A)]), { mark: [A], clear: [], remove: [] });
    assert.deepEqual(plan([self(A, { orphanSince: ago(GRACE * 2) })]), { mark: [], clear: [], remove: [A] });
  });

  it('a marked row that is carried again is cleared and not removed, however old its mark', () => {
    assert.deepEqual(plan([row(A, { orphanSince: ago(GRACE * 10) })], { carried: [A] }), { mark: [], clear: [A], remove: [] });
  });

  it('at most 256 removals a pass, never part of a linked group, and the bound limits removals only, never marks', () => {
    const old = ago(GRACE * 2);
    const rows = [];
    // 150 pairs, P links Q, all past the grace: 300 removable rows. Plus 20 unmarked candidates. Ids are fingerprints (64 hex),
    // or a link is not one; every Q row comes before every P row, so a bound that takes the first 256 rows cuts 106 pairs.
    const p = (i) => `a${String(i).padStart(63, '0')}`; const q = (i) => `b${String(i).padStart(63, '0')}`;
    for (let i = 0; i < 150; i++) rows.push(row(q(i), { orphanSince: old }));
    for (let i = 0; i < 150; i++) rows.push(row(p(i), { links: linksTo(q(i)), orphanSince: old }));
    for (let i = 0; i < 20; i++) rows.push(row(`c${String(i).padStart(63, '0')}`));
    const got = plan(rows);
    assert.ok(got.remove.length > 0 && got.remove.length <= 256, `${got.remove.length} removals in one pass`);
    const removed = new Set(got.remove);
    const cut = [];
    for (let i = 0; i < 150; i++) if (!removed.has(p(i)) && removed.has(q(i))) cut.push(i);
    assert.deepEqual(cut, [], 'the bound removed a row whose linking row stays');
    assert.equal(got.mark.length, 20, 'the bound held back marks: it counts removals only');
  });

  it('it changes nothing it is given', () => {
    const rows = [row(A, { links: linksTo(B), orphanSince: ago(GRACE * 2) }), row(B, { orphanSince: ago(GRACE * 2) })];
    const frozen = structuredClone(rows);
    const carried = new Set([C]); const keep = new Set([D]);
    need('snapshotSweepPlan')(rows, carried, keep, NOW, GRACE);
    assert.deepEqual(rows, frozen);
    assert.deepEqual([[...carried], [...keep]], [[C], [D]]);
  });
});
