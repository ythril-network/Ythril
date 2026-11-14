/**
 * A type's definitions are the classes of the diff's per-type sameness: `F ~T G` (the diff names neither T nor T's kind as `all`, and the
 * pair is classified) is an equivalence, and the grouping the history uses equals the brute-force partition (Q-744, bundle-268 design r2
 * §0 E1/E2, r3 §0, r4 §0 and §10 T1). Pure: no store.
 *
 * ## The contract (written before the code)
 *
 * `groupDefinitions(order, current, compare, opts?)` in `server/dist/spaces/type-history.js`:
 * - `order`: the stamps T's records carry, in keeping order (oldest first), each once; `current`: the anchor (it may or may not be in
 *   `order`); `compare(a, b)`: `'same' | 'differs' | 'unclassified'` for this (kind, type), sync or async.
 * - answers (or resolves to) `{ classes: [{ rep, members }], unclassified: string[], cut: boolean }`: the first class is current's, with
 *   `rep === current`; every other class's `rep` is one of its members; no stamp is in two places; a stamp unclassified against current is
 *   in `unclassified` and never in a class.
 * - The classes are the partition of union-find over every classified pair (E2), found by chaining neighbours then comparing
 *   representatives newest first (r3 §0 step 4). `opts` (`classMax`, `compareMax`) bound the work; this test passes neither.
 *
 * ## Seen red at 327b105e
 *
 * E1 holds at the base (the relation is the shipped diff's). E2 is red: `spaces/type-history.js` does not exist, so there is no grouping
 * export.
 *
 * Run: node --test testing/standalone/a-type-definition-is-a-class-of-the-diffs-sameness.test.js (a prior build of schema/ and server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { samenessCorpus, CORPUS_FLOOR, TRIPLE } from './_schema-sameness-corpus.mjs';
import { need } from './_type-history.mjs';

const KINDS = ['entity', 'edge', 'fact', 'chrono'];
let S, unread, KT, same, unclassifiedPair;

before(async () => {
  const { typesDifferingUnder } = await import('../../server/dist/spaces/schema-diff.js');
  const { versionMetaOf } = await import('../../server/dist/spaces/schema-version-text.js');
  S = await samenessCorpus();
  unread = S.map(({ text }) => { const vm = versionMetaOf(text); return !vm || vm.unread.length > 0; });
  const kt = new Map();
  for (const { text } of S) {
    const vm = versionMetaOf(text);
    if (!vm) continue;
    for (const k of KINDS) for (const ty of Object.keys(vm.meta.typeSchemas[k] ?? {})) kt.set(`${k}\0${ty}`, [k, ty]);
  }
  for (const k of KINDS) kt.set(`${k}\0__untyped_probe`, [k, '__untyped_probe']);
  KT = [...kt.values()];
  const d = S.map((a, i) => S.map((b, j) => (i === j ? null : typesDifferingUnder(a.text, b.text, 'any'))));
  const named = (td, k, ty) => { const x = td.kinds.get(k); return x === 'all' || (x instanceof Set && x.has(ty)); };
  unclassifiedPair = (i, j) => i !== j && d[i][j].unclassified;
  same = (i, j, k, ty) => (i === j ? true : (!d[i][j].unclassified && !named(d[i][j], k, ty)));
});

describe('the corpus', () => {
  it('holds the probe\'s floor of texts and unread texts, and the counterexample triple', () => {
    assert.ok(S.length >= CORPUS_FLOOR.texts, `the corpus shrank to ${S.length} texts`);
    assert.ok(unread.filter(Boolean).length >= CORPUS_FLOOR.unread, `the corpus holds ${unread.filter(Boolean).length} unread texts`);
    const labels = new Set(S.map(s => s.label));
    assert.deepEqual(TRIPLE.filter(l => !labels.has(l)), [], 'the counterexample triple is not in the corpus');
  });
});

describe('E1: ~T is an equivalence on the classifiable texts', () => {
  it('symmetric for every ordered pair and (kind, type); an unread text is never classified', () => {
    const failures = [];
    let checks = 0;
    for (let i = 0; i < S.length; i++) for (let j = 0; j < S.length; j++) {
      if (i === j) continue;
      if (unclassifiedPair(i, j) !== unclassifiedPair(j, i)) failures.push(`unclassified asymmetric: ${S[i].label} / ${S[j].label}`);
      if ((unread[i] || unread[j]) && !unclassifiedPair(i, j)) failures.push(`unread answered classified: ${S[i].label} -> ${S[j].label}`);
      for (const [k, ty] of KT) { checks++; if (same(i, j, k, ty) !== same(j, i, k, ty)) failures.push(`asymmetric ${k}/${ty}: ${S[i].label} / ${S[j].label}`); }
    }
    assert.ok(checks > 10_000, `only ${checks} checks ran`);
    assert.deepEqual(failures.slice(0, 20), []);
  });

  it('transitive for every triple and (kind, type), the counterexample triple included', () => {
    const failures = [];
    let triples = 0;
    for (const [k, ty] of KT) for (let i = 0; i < S.length; i++) for (let j = 0; j < S.length; j++) {
      if (i === j || !same(i, j, k, ty)) continue;
      for (let m = 0; m < S.length; m++) {
        if (m === i || m === j || !same(j, m, k, ty)) continue;
        triples++;
        if (!same(i, m, k, ty)) failures.push(`${k}/${ty}: ${S[i].label} ~ ${S[j].label} ~ ${S[m].label} but not the ends`);
      }
    }
    assert.ok(triples > 100_000, `only ${triples} triples ran`);
    assert.deepEqual(failures.slice(0, 20), []);
    const [a, b, c] = TRIPLE.map(l => S.findIndex(s => s.label === l));
    assert.ok(same(a, b, 'fact', 'Note') && same(b, c, 'fact', 'Note') && same(a, c, 'fact', 'Note'), 'the counterexample triple is not one class for fact/Note');
  });
});

describe('E2: the grouping is the brute-force partition', () => {
  it('for 500 seeded sequences and every (kind, type), groupDefinitions answers union-find\'s classes and puts every unread stamp apart', async () => {
    const { groupDefinitions } = await need('spaces/type-history.js', ['groupDefinitions']);
    let seed = 744;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const idx = [...S.keys()];
    const classified = idx.filter(i => !unread[i]);
    const unreadIdx = idx.filter(i => unread[i]);
    const at = (l) => S.findIndex(s => s.label === l);
    const A = at('identical#A'), B = at('structural: prop type#B'), C = at('lifecycle: suppressEmbeddings#B'), Au = at('wording: type description#B');
    const [t0, t1, t2] = TRIPLE.map(at);
    const seqs = [[A, B, A], [A, B, A, C], [A, B, Au], [A, Au, B, A], [A, B, Au, C], [B, A, C, Au]];
    for (const p of [[t0, t1, t2], [t0, t2, t1], [t1, t0, t2], [t1, t2, t0], [t2, t0, t1], [t2, t1, t0]]) seqs.push(p, [B, ...p], [...p, B], [p[0], B, p[1], C, p[2]]);
    for (const u of unreadIdx) seqs.push([u, A, B], [A, u, B], [A, B, u], [B, u, A, u, B], [Au, u, B, A]);
    while (seqs.length < 500) {
      const len = 2 + Math.floor(rnd() * 11);
      const s = [];
      for (let q = 0; q < len; q++) s.push(rnd() < 0.3 && s.length ? pick(s) : rnd() < 0.08 ? pick(unreadIdx) : pick(classified));
      seqs.push(s);
    }
    const fpOf = (i) => `fp${String(i).padStart(3, '0')}`;
    const iOf = (fp) => Number(fp.slice(2));
    const canon = (parts) => parts.filter(p => p.length).map(p => [...p].sort().join(',')).sort().join(' | ');
    const failures = [];
    let groupings = 0;
    for (const raw of seqs) {
      const seq = [];
      for (const x of raw) if (!seq.includes(x)) seq.push(x);
      const cur = raw[raw.length - 1];
      for (const [k, ty] of KT) {
        groupings++;
        const compare = (a, b) => (unclassifiedPair(iOf(a), iOf(b)) ? 'unclassified' : same(iOf(a), iOf(b), k, ty) ? 'same' : 'differs');
        const got = await groupDefinitions(seq.map(fpOf), fpOf(cur), compare);
        const cls = seq.filter(v => v === cur || !unclassifiedPair(v, cur));
        const par = new Map(cls.map(v => [v, v]));
        const find = (v) => (par.get(v) === v ? v : find(par.get(v)));
        for (const a of cls) for (const b of cls) if (a !== b && !unclassifiedPair(a, b) && same(a, b, k, ty)) par.set(find(a), find(b));
        const groups = new Map();
        for (const v of cls) { const r = find(v); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(fpOf(v)); }
        const want = canon([...groups.values()]);
        const have = canon(got.classes.map(c => c.members));
        const wantUnclassified = seq.filter(v => v !== cur && unclassifiedPair(v, cur)).map(fpOf).sort();
        const where = `${k}/${ty} [${seq.join(',')}] current ${cur}`;
        if (have !== want) failures.push(`${where}: classes ${have}, union-find ${want}`);
        if (got.classes[0]?.rep !== fpOf(cur)) failures.push(`${where}: the first class is not current's`);
        if (got.classes.some(c => !c.members.includes(c.rep))) failures.push(`${where}: a rep is not a member of its class`);
        if ([...got.unclassified].sort().join() !== wantUnclassified.join()) failures.push(`${where}: unclassified ${got.unclassified}, want ${wantUnclassified}`);
        if (got.cut) failures.push(`${where}: cut with no bound passed`);
        if (failures.length > 20) break;
      }
      if (failures.length > 20) break;
    }
    assert.ok(groupings >= 4_000, `only ${groupings} groupings ran`);
    assert.deepEqual(failures, []);
  });
});
