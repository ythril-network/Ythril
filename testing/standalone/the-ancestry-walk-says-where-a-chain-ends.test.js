/**
 * The one walk UP a derived row's `parentFileId` chain says where each chain ends, and reads one level for all of them at a time
 * (bundle-113, Q-465; `files/ancestry.ts`).
 *
 * ## The rule
 *
 * Following `parentFileId` from a set of rows, at most `MAX_ANCESTRY` levels, each chain ends as exactly one of:
 *  - `top`: a row with no parent;
 *  - `gone`: a parent id the reader has no row for (the caller's reader decides whether a flagged row is one that exists);
 *  - `too-deep`: `MAX_ANCESTRY` rows were read and the chain goes on — the walk cannot say, and `at` is the id it would have read next;
 *  - `stopped`: the caller's `stopWhen` held for an ancestor, and nothing above that ancestor was read.
 * The reader is asked ONCE per level for every chain still going, with each id once, so a page of rows costs `MAX_ANCESTRY` reads at most.
 *
 * It is held here against an in-memory reader (so the rule is the walk's own, and no database stands between the case and the answer);
 * the repair, the move plan and the embed path are held to the walk by `the-ancestry-walk-up-parentfileid-is-one-module-and-the-repair-uses-it`
 * and, against rows, by the repair's and the embed path's own suites.
 *
 * Run: node --test testing/standalone/the-ancestry-walk-says-where-a-chain-ends.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { walkUpParentChains, MAX_ANCESTRY } = await import('../../server/dist/files/ancestry.js');

/** A reader over `rows` (id -> row) that records every call it was given. */
function readerOver(rows) {
  const calls = [];
  const read = async (ids) => { calls.push([...ids]); return new Map(ids.filter(id => rows.has(id)).map(id => [id, rows.get(id)])); };
  return { read, calls };
}
const row = (id, parentFileId) => ({ _id: id, ...(parentFileId === undefined ? {} : { parentFileId }) });
const table = (...rs) => new Map(rs.map(r => [r._id, r]));

describe('the walk up parentFileId says where each chain ends', () => {
  it('a chain that reaches a row with no parent ends at `top`, with the ancestors read nearest first', async () => {
    const { read } = readerOver(table(row('img', 'doc'), row('doc')));
    const chains = await walkUpParentChains(new Map([['chunk', 'img']]), read);
    assert.deepEqual(chains.get('chunk').result, { end: 'top', at: 'doc' });
    assert.deepEqual(chains.get('chunk').ancestors.map(a => a._id), ['img', 'doc']);
  });

  it('a parent the reader has no row for ends the chain as `gone`, naming it', async () => {
    const { read } = readerOver(table(row('img', 'doc')));
    const chains = await walkUpParentChains(new Map([['chunk', 'img'], ['orphan', 'nobody']]), read);
    assert.deepEqual(chains.get('chunk').result, { end: 'gone', at: 'doc' });
    assert.deepEqual(chains.get('orphan').result, { end: 'gone', at: 'nobody' });
    assert.deepEqual(chains.get('orphan').ancestors, []);
  });

  it('a chain that is still going after MAX_ANCESTRY rows ends as `too-deep`, naming the id it would read next', async () => {
    const ids = Array.from({ length: MAX_ANCESTRY + 2 }, (_, i) => `n${i}`);
    const rows = table(...ids.map((id, i) => row(id, i + 1 < ids.length ? ids[i + 1] : undefined)));
    const { read } = readerOver(rows);
    const chains = await walkUpParentChains(new Map([['start', ids[0]]]), read);
    assert.deepEqual(chains.get('start').result, { end: 'too-deep', at: ids[MAX_ANCESTRY] });
    assert.equal(chains.get('start').ancestors.length, MAX_ANCESTRY);
  });

  it('a chain that ends exactly at the last level it may read is answered, not `too-deep`', async () => {
    const ids = Array.from({ length: MAX_ANCESTRY }, (_, i) => `n${i}`);
    const rows = table(...ids.map((id, i) => row(id, i + 1 < ids.length ? ids[i + 1] : undefined)));
    const { read } = readerOver(rows);
    const chains = await walkUpParentChains(new Map([['start', ids[0]]]), read);
    assert.equal(chains.get('start').result.end, 'top');
  });

  it('`stopWhen` ends a chain at the first ancestor it holds for, and nothing above it is read', async () => {
    const { read, calls } = readerOver(table(row('img', 'doc'), row('doc')));
    const chains = await walkUpParentChains(new Map([['chunk', 'img']]), read, a => a._id === 'img');
    assert.deepEqual(chains.get('chunk').result, { end: 'stopped', at: 'img' });
    assert.deepEqual(calls, [['img']], 'the walk read past the ancestor the caller stopped at');
  });

  it('asks the reader once per level for every chain, each id once, so a page costs one read per level', async () => {
    const { read, calls } = readerOver(table(row('p1', 'top'), row('p2', 'top'), row('top')));
    const starts = new Map([['a', 'p1'], ['b', 'p1'], ['c', 'p2'], ['d', 'top']]);
    const chains = await walkUpParentChains(starts, read);
    assert.deepEqual(calls, [['p1', 'p2', 'top'], ['top']], 'the reader was asked per chain, or an id twice in one read');
    assert.deepEqual([...chains.values()].map(c => c.result.end), ['top', 'top', 'top', 'top']);
  });

  it('answers for every chain it was given, and for none it was not', async () => {
    const { read } = readerOver(table(row('top')));
    const starts = new Map([['a', 'top'], ['b', 'missing']]);
    const chains = await walkUpParentChains(starts, read);
    assert.deepEqual([...chains.keys()].sort(), ['a', 'b']);
  });
});
