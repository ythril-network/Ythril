/**
 * What publishing a slice of pending file tombstones comes to is decided by a pure function (Q-415 item 2).
 *
 * `publishSlice` (`files/tombstones.ts`) read the stored rows, decided per path, handed markers over, wrote and deleted in one body, and
 * asked the disk whether a move was still owed from the middle of its loop. The decision is now `decideSlice`
 * (`files/tombstone-publish-rules.ts`), over rows already read and a set of owed moves read before it; the module writes it
 * (`writeSlice`). This file holds the decision on rows alone — no store — so the rule can be changed with a test that says what it does:
 *
 *  1. **one winner per path**: the latest written; every older pending row of the path goes with it, a newer one stays;
 *  2. **a published row of the same id settles its candidate**: it is neither published again nor removed as a loser;
 *  3. **an own publication made after the candidate was written covers it** — and by version (`covers`, every row of its table) — and the
 *     candidate's move marker is handed to the covering row, once, when it has none;
 *  4. **a marker travels with the winner**; a different move's row that is still owed is KEPT, one that is not goes;
 *  5. **nothing is changed**: the inputs are frozen, and a rule that wrote into a row it was handed would throw;
 *  6. **what is asked about owed moves is a superset of what is used** (`movesToAskAbout`): rows only where a path names two moves.
 *
 * Run: node --test testing/standalone/a-slice-of-pending-tombstones-is-decided-over-rows-already-read.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { decideSlice, covers, movesToAskAbout } = await import('../../server/dist/files/tombstone-publish-rules.js');

const ME = 'instance-a';
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const T = (n) => `2026-10-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const pending = (id, path, at, extra = {}) => ({ _id: id, path, deletedAt: T(at), writtenAt: T(at), pending: true, ...extra });
const published = (id, path, at, extra = {}) => ({ _id: id, path, deletedAt: T(at), positionAt: T(at), origin: 'own', ...extra });
const byPathOf = (...docs) => { const m = new Map(); for (const d of docs) m.set(d.path, [...(m.get(d.path) ?? []), d]); return m; };
const decide = (stored, docs, owed = []) => {
  const byPath = byPathOf(...docs);
  return decideSlice(deepFreeze([...stored]), [...byPath.keys()], deepFreeze(byPath), { thisInstance: ME, owed: new Set(owed) });
};
const move = (from, to) => ({ from, to });
const key = (m) => `${m.from}\u0000${m.to}`;

describe('covers: an own publication after the candidate was written, by version', () => {
  const c = (extra) => pending('c', 'a.txt', 10, extra);
  const p = (extra) => published('p', 'a.txt', 20, extra);
  const rows = [
    ['its version read failed, any publication', c({ versionUnknown: true }), p({ rowSeq: 5 }), false],
    ['versioned, versioned not below', c({ rowSeq: 4 }), p({ rowSeq: 4 }), true],
    ['versioned, versioned below', c({ rowSeq: 4 }), p({ rowSeq: 3 }), false],
    ['versioned, none', c({ rowSeq: 4 }), p({}), false],
    ['none, none', c({}), p({}), true],
    ['none, versioned', c({}), p({ rowSeq: 9 }), true],
  ];
  for (const [name, cand, pub, expected] of rows) it(name, () => assert.equal(covers(deepFreeze(pub), deepFreeze(cand), ME), expected));

  it('a publication made BEFORE the candidate was written does not cover it', () => {
    assert.equal(covers(published('p', 'a.txt', 5), pending('c', 'a.txt', 10), ME), false);
  });
  it('a relayed row, and a pending one, never cover', () => {
    assert.equal(covers(published('p', 'a.txt', 20, { origin: 'relayed' }), pending('c', 'a.txt', 10), ME), false);
    assert.equal(covers(published('p', 'a.txt', 20, { storedVia: 'peer', origin: undefined }), pending('c', 'a.txt', 10), ME), false);
    assert.equal(covers({ ...published('p', 'a.txt', 20), pending: true }, pending('c', 'a.txt', 10), ME), false);
  });
  it('a row published before origin existed covers only when this instance is its issuer', () => {
    const old = (issuer) => ({ _id: 'p', path: 'a.txt', deletedAt: T(20), positionAt: T(20), ...(issuer ? { issuer } : {}) });
    assert.equal(covers(old(ME), pending('c', 'a.txt', 10), ME), true);
    assert.equal(covers(old('instance-b'), pending('c', 'a.txt', 10), ME), false);
    assert.equal(covers(old(undefined), pending('c', 'a.txt', 10), ME), false);
  });
});

describe('one winner per path', () => {
  it('the latest written wins; older pending rows go with it; a newer one stays', () => {
    const [older, latest, newer] = [pending('o', 'a.txt', 10), pending('l', 'a.txt', 20), pending('n', 'a.txt', 30)];
    // The act publishes `older` and `latest`; `newer` is another act's, stored but not among its candidates.
    const d = decide([older, latest, newer], [older, latest]);
    assert.deepEqual(d.winners.map(w => w._id), ['l']);
    assert.deepEqual(d.after, [{ kind: 'remove-pending', path: 'a.txt', winnerId: 'l', writtenAt: T(20), deletedAt: T(20), keep: [] }]);
    assert.equal(d.dropped, 1);
    assert.deepEqual(d.superseded, []);
  });

  it('a candidate whose id is already published is neither a winner nor a loser', () => {
    const cand = pending('x', 'a.txt', 10);
    const d = decide([published('x', 'a.txt', 15)], [cand]);
    assert.deepEqual([d.winners, d.after, d.superseded, d.dropped], [[], [], [], 0]);
  });

  it('a row written before writtenAt existed goes with a winner that has one; with none, only older deletedAt does', () => {
    const legacy = { _id: 'g', path: 'a.txt', deletedAt: T(5), pending: true };
    const win = pending('w', 'a.txt', 20);
    assert.deepEqual(decide([legacy, win], [win]).after.map(s => s.winnerId), ['w']);
    const legacyWinner = { _id: 'lw', path: 'b.txt', deletedAt: T(20), pending: true };
    const d = decide([legacyWinner], [legacyWinner]);
    assert.deepEqual(d.after, [{ kind: 'remove-pending', path: 'b.txt', winnerId: 'lw', writtenAt: undefined, deletedAt: T(20), keep: [] }]);
  });
});

describe('a covered candidate is superseded, and its marker is handed on once', () => {
  it('covered: superseded, nothing published, the cover takes the marker when it has none', () => {
    const m = move('x', 'a.txt');
    const cand = pending('c', 'a.txt', 10, { move: m });
    const cover = published('p', 'a.txt', 20);
    const d = decide([cover, cand], [cand]);
    assert.deepEqual(d.winners, []);
    assert.deepEqual(d.superseded, ['c']);
    assert.deepEqual(d.after, [{ kind: 'hand-over-marker', rowId: 'p', move: m }]);
    assert.equal(d.dropped, 1);
  });

  it('a cover that already carries a marker keeps it; two covered candidates hand one marker, not two', () => {
    const m1 = move('x', 'a.txt');
    const cover = published('p', 'a.txt', 30, { move: move('y', 'a.txt') });
    assert.deepEqual(decide([cover], [pending('c', 'a.txt', 10, { move: m1 })]).after, []);
    const bare = published('p', 'a.txt', 30);
    const d = decide([bare], [pending('c1', 'a.txt', 10, { move: m1 }), pending('c2', 'a.txt', 11, { move: move('z', 'a.txt') })]);
    assert.equal(d.after.filter(s => s.kind === 'hand-over-marker').length, 1);
    assert.deepEqual(d.superseded.sort(), ['c1', 'c2']);
  });
});

describe('a marker travels with the winner, and a different move still owed is kept', () => {
  const mine = move('a', 'b');
  const other = move('c', 'd');
  const win = pending('w', 'a.txt', 20, { move: mine });
  const goes = pending('g', 'a.txt', 10, { move: other });

  it('the winner carries the marker of a row that goes when it has none', () => {
    const bare = pending('w', 'a.txt', 20);
    const d = decide([bare, goes], [bare, goes]);
    assert.deepEqual(d.winners[0].move, other);
    assert.deepEqual(d.after, [{ kind: 'remove-pending', path: 'a.txt', winnerId: 'w', writtenAt: T(20), deletedAt: T(20), keep: [] }]);
  });

  it('a different move that is still owed is kept, one that is not owed goes', () => {
    assert.deepEqual(decide([win, goes], [win], [key(other)]).after.at(-1).keep, ['g']);
    assert.deepEqual(decide([win, goes], [win], []).after.at(-1).keep, []);
  });

  it('the winner\'s own marker is never asked about, and never kept as "elsewhere"', () => {
    const twin = pending('t', 'a.txt', 10, { move: mine });
    assert.deepEqual(decide([win, twin], [win], [key(mine)]).after.at(-1).keep, []);
  });
});

describe('what is asked about owed moves', () => {
  const mine = move('a', 'b');
  const other = move('c', 'd');
  const ask = (stored, docs) => { const byPath = byPathOf(...docs); return movesToAskAbout(stored, [...byPath.keys()], byPath); };

  it('nothing where a path names one move (a directory move\'s files cost no look at the disk)', () => {
    assert.deepEqual(ask([pending('s', 'a.txt', 5, { move: mine })], [pending('w', 'a.txt', 20, { move: mine })]), []);
  });
  it('every row that names a move, where a path names two', () => {
    const asked = ask([pending('s', 'a.txt', 5, { move: other })], [pending('w', 'a.txt', 20, { move: mine })]);
    assert.deepEqual(asked.map(r => r.move).sort((x, y) => key(x).localeCompare(key(y))), [mine, other]);
  });
  it('every move the decision keeps is among the moves it asked about', () => {
    const win = pending('w', 'a.txt', 20, { move: mine });
    const goes = pending('g', 'a.txt', 10, { move: other });
    const asked = new Set(ask([goes], [win]).map(r => key(r.move)));
    assert.ok(asked.has(key(other)), 'the move a kept row could name was not asked about');
  });
});
