/**
 * The helpers every consumer of "a move" shares in `files/moved-paths.ts`: what is at or under a path, which ids a move re-keys and to
 * what, and the one key of a move (bundle-44, S3, S7, S11).
 *
 * ## What they prevent
 *
 * Four sites turned a set of ids into `{ from, to }` pairs by `movedId`, dropping the ones that do not belong (the cascade's links, the
 * settle's take-back of an abandoned move's links, the job re-key, the plan's rows), the move-flight check restated "at or under" by
 * hand, and two modules spelled the key of a move. Each was right where it stood; the next one to be written would differ in a corner.
 *
 * Run: node --test testing/standalone/moved-paths-one-spelling-of-a-move.test.js   (requires a prior build of server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mp;
before(async () => { mp = await import('../../server/dist/files/moved-paths.js'); });

describe('isAtOrUnder', () => {
  it('is the path itself or a path under it, on whole segments', () => {
    assert.equal(mp.isAtOrUnder('a', 'a'), true);
    assert.equal(mp.isAtOrUnder('a/b/c', 'a'), true);
    assert.equal(mp.isAtOrUnder('ab', 'a'), false, '`a` must not take `ab`');
    assert.equal(mp.isAtOrUnder('a#chunk', 'a'), false, 'a chunk is movedId\'s rule, not the segment rule');
    assert.equal(mp.isAtOrUnder('b/a', 'a'), false);
  });

  it('is the rule movedId applies to a path and to the same path under either sidecar root', () => {
    for (const root of ['', '_converted/', '_extracted/']) {
      assert.equal(mp.movedId(`${root}d/x.txt`, 'd', 'e'), `${root}e/x.txt`, root);
      assert.equal(mp.movedId(`${root}d`, 'd', 'e'), `${root}e`, root);
      assert.equal(mp.movedId(`${root}dd/x.txt`, 'd', 'e'), null, `${root} a name that merely starts alike`);
    }
  });
});

describe('movedPairs', () => {
  it('lists the ids that change with the id they take, in the order given, and no other', () => {
    const ids = ['d/a.txt', 'other.txt', 'd/sub/b.txt', 'dd/c.txt', '_converted/d/a.txt.md'];
    assert.deepEqual(mp.movedPairs(ids, 'd', 'e'), [
      { from: 'd/a.txt', to: 'e/a.txt' },
      { from: 'd/sub/b.txt', to: 'e/sub/b.txt' },
      { from: '_converted/d/a.txt.md', to: '_converted/e/a.txt.md' },
    ]);
  });

  it('leaves out an id a move onto itself would keep, and answers nothing for an empty root', () => {
    assert.deepEqual(mp.movedPairs(['d/a.txt'], 'd', 'd'), []);
    assert.deepEqual(mp.movedPairs(['d/a.txt'], '', 'e'), []);
  });

  it('is what idAfterMove says for every id it lists, and idAfterMove keeps an id that does not belong', () => {
    for (const { from, to } of mp.movedPairs(['d/a.txt', 'd#chunk-0', 'd'], 'd', 'e')) assert.equal(mp.idAfterMove(from, 'd', 'e'), to);
    assert.equal(mp.idAfterMove('elsewhere/x', 'd', 'e'), 'elsewhere/x');
  });
});

describe('moveKey', () => {
  it('names a move by its two paths, and a move of a space by the space as well', () => {
    assert.equal(mp.moveKey({ from: 'a', to: 'b' }), 'a\u0000b');
    assert.equal(mp.moveKey({ from: 'a', to: 'b' }, 's'), 's\u0000a\u0000b');
    assert.notEqual(mp.moveKey({ from: 'a', to: 'b' }), mp.moveKey({ from: 'b', to: 'a' }));
  });
});

describe('jobIdClausesOf', () => {
  it('selects the path and every sidecar a path owns, by kind, and nothing for an empty path', () => {
    assert.equal(mp.jobIdClausesOf('', 'file').length, 0);
    const file = mp.jobIdClausesOf('d/x.txt', 'file');
    const dir = mp.jobIdClausesOf('d', 'directory');
    assert.ok(file.length >= 2 && dir.length >= 3, `file ${file.length}, directory ${dir.length}`);
  });
});
