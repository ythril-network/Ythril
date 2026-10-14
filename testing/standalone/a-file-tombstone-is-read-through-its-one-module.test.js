/**
 * The file-tombstone collection is opened by ONE module, `files/tombstone-store.ts` — so the rule "a tombstone for an act
 * that has not happened is served by nothing" is kept in one place rather than at every reader (bundle-30 I15,
 * preship-3 P3-1).
 *
 * **Q-462 split the module, and the owner moved on purpose.** The collection used to be opened by `files/tombstones.ts`, which
 * also held the move's marker block. The collection primitives are now `tombstone-store.ts`'s (`OWNER` below, changed
 * deliberately and not by a find-and-replace); the lifecycle that serves, publishes and prunes through them stays in
 * `tombstones.ts` (`LIFECYCLE`, where `heldFileTombstones` and its PUBLISHED-only rule are read from), and the marker block is
 * `move-markers.ts`. The two modules that may import the store are therefore `tombstones.ts` and `move-markers.ts` — nothing else
 * names it, so a reader that reached for the store directly would be a reader of the collection outside the lifecycle's rule.
 *
 * ## Why one module
 *
 * A file tombstone is written PENDING before its irreversible step (the unlink, the tree removal, the rename) and
 * confirmed after it. A pending one must never leave this instance: a peer that receives one deletes its copy, stores
 * the tombstone and serves it back, and this instance's pull then deletes the only copy of a file whose delete or
 * move FAILED. The readers that serve or replicate were four, in four files — the `GET /file-tombstones` door, the
 * push in `sync/file-sync.ts`, the prune in `brain/tombstone-prune.ts` and the stray-metadata drain — and a fifth
 * written next year would not know the field exists. So no file but the owner names the collection, and the owner's
 * readers exclude pending ones (`a-file-tombstone-is-published-only-once-its-act-happened-db` exercises each).
 *
 * ## What is derived, and the floor
 *
 * Every tracked server source that names the collection in CODE (comments blanked): the registry key
 * `fileTombstones` or the suffix `file_tombstones`. The set must be the owner plus the declared non-readers, each of
 * which must still be found where it is declared — an exemption whose site moved is a stale exemption, and the owner
 * missing means the derivation looked in the wrong place.
 *
 * Run: node --test testing/standalone/a-file-tombstone-is-read-through-its-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { relativeImports } from './_module-shape.mjs';

/** The one module that names the collection. */
const OWNER = 'server/src/files/tombstone-store.ts';
/** The module the lifecycle lives in: the readers' public door, and where `heldFileTombstones` (published rows only) is defined. */
const LIFECYCLE = 'server/src/files/tombstones.ts';
/** The only two modules allowed to import the store (Q-462, vet T-S8): the lifecycle and the move's marker block. */
const STORE_IMPORTERS = ['server/src/files/move-markers.ts', 'server/src/files/tombstones.ts'];

/**
 * Sources that name the collection and READ none of it, each with the code that shows it. Not readers, so not held
 * to the pending rule: neither can hand a tombstone to anyone.
 */
const NOT_READERS = {
  // The registry: the name, built once. Opens nothing.
  'server/src/db/space-collection.ts': /fileTombstones:\s*'file_tombstones'/,
  // (A files wipe used to be here: it dropped every tombstone from `spaces/lifecycle.ts` by hand. It is the module's now,
  // `forgetFileTombstonesOf`, which marks the wipe so a publish in flight cannot re-create a row — bundle-71, Q-406.)
};

const NAMES_IT = () => /\bfileTombstones\b|file_tombstones/g;

function namers() {
  const out = new Map();
  for (const f of trackedSources('server/src')) {
    const code = blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
    const lines = [];
    for (const m of code.matchAll(NAMES_IT())) lines.push(code.slice(0, m.index).split('\n').length);
    if (lines.length > 0) out.set(f, { code, lines });
  }
  return out;
}

/**
 * The readers outside the module that take the PUBLISHED tombstones only, because what they decide is destructive and waits on
 * acts: the stray drain discards a record on a tombstone's say-so, and a pending tombstone names an act that may not happen.
 * Every OTHER arrival site asks the wider predicate (`decideArrivals`), which also counts a pending tombstone whose act has
 * already removed the path's bytes (bundle-71, Q-348) — so a new site that reaches for `heldFileTombstones` instead is either
 * a new published-only reader, declared here with its reason, or the narrower answer to "is this path deleted".
 */
const PUBLISHED_ONLY_READERS = {
  'server/src/sync/stray-filemeta-drain.ts': 'discards a stray record on a tombstone, and waits on acts (bundle-30 I15)',
  'server/src/files/leaked-rows-repair.ts': 'removes the links of a file THIS instance deleted, proved by its published tombstone: a pending one is a delete still running, whose own cascade takes the links (Q-465)',
};

describe('the stray drain reads only published tombstones; every arrival site asks the wider predicate (Q-348)', () => {
  it('only the module and the declared published-only readers call heldFileTombstones', () => {
    const callers = new Set();
    for (const f of trackedSources('server/src')) {
      if (f === LIFECYCLE) continue;
      if (/\bheldFileTombstones\s*\(/.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8')))) callers.add(f);
    }
    assert.ok(callers.size >= 1, 'no source calls heldFileTombstones — the derivation looks in the wrong place');
    assert.deepEqual([...callers].sort(), Object.keys(PUBLISHED_ONLY_READERS).sort(),
      'a source other than the declared published-only readers asks heldFileTombstones: an ARRIVAL asks decideArrivals / '
      + 'shadowedArrivals / bytesShadowed, which also counts a pending delete whose bytes are already gone');
  });

  it('a published-only reader never asks the wider predicate, and heldFileTombstones reads only PUBLISHED rows', () => {
    for (const f of Object.keys(PUBLISHED_ONLY_READERS)) {
      const code = blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
      assert.doesNotMatch(code, /\b(decideArrivals|shadowedArrivals|bytesShadowed)\b/,
        `${f} is a published-only reader and asks the predicate that counts a pending delete too`);
    }
    const owner = blankComments(readFileSync(join(REPO_ROOT, LIFECYCLE), 'utf8'));
    const body = /export async function heldFileTombstones\b[\s\S]*?\n\}\r?\n/.exec(owner)?.[0];
    assert.ok(body, 'heldFileTombstones is not found in its module — the derivation looks in the wrong place');
    assert.match(body, /\.\.\.PUBLISHED/, 'heldFileTombstones no longer reads PUBLISHED rows only');
  });
});

describe('the file-tombstone collection is opened only by its module', () => {
  const found = namers();

  it('the derivation finds the owner and every declared non-reader where it is declared', () => {
    assert.ok(found.has(OWNER), `${OWNER} does not name the collection — the derivation looks in the wrong place`);
    for (const [f, shows] of Object.entries(NOT_READERS)) {
      assert.ok(found.has(f), `${f} is declared a non-reader but no longer names the collection — drop the stale exemption`);
      assert.match(found.get(f).code, shows, `${f} names the collection, but not as its exemption says — re-read it`);
    }
  });

  it('no other source names the collection: every reader goes through the store module, by way of files/tombstones.ts', () => {
    const strays = [...found.entries()]
      .filter(([f]) => f !== OWNER && !(f in NOT_READERS))
      .map(([f, { lines }]) => `${f}:${lines.join(',')}`);
    assert.deepEqual(strays, [],
      'these name the file-tombstone collection outside files/tombstone-store.ts, so nothing holds them to the rule that '
      + 'a PENDING tombstone (an act not yet done) is never served, pushed, pruned or counted — call the module instead');
  });
});

describe('the store module is imported by the lifecycle and the marker block, and by nothing else (Q-462)', () => {
  const known = () => new Set(trackedSources('server/src'));

  /** Every tracked source that imports (or re-exports from) the store module, by the relative specifier it resolves through. */
  function importersOf(owner) {
    const set = known();
    const out = [];
    for (const f of set) {
      if (f === owner) continue;
      if (relativeImports(f, readFileSync(join(REPO_ROOT, f), 'utf8'), set).some(e => e.to === owner)) out.push(f);
    }
    return out.sort();
  }

  it('the importers are exactly the lifecycle and the marker module', () => {
    assert.ok(known().has(OWNER), `${OWNER} does not exist — the derivation looks in the wrong place`);
    assert.deepEqual(importersOf(OWNER), STORE_IMPORTERS,
      'a source other than tombstones.ts and move-markers.ts imports the store module: it would read the collection around '
      + "the lifecycle's rule that a pending tombstone is never served, and around the marker block's rule that an owed move's marker is never dropped");
  });

  it('the matcher finds an importer, a type-only importer and a re-exporter of a module, and not a mention', () => {
    const set = new Set(['server/src/files/a.ts', 'server/src/files/store.ts', 'server/src/x/b.ts', 'server/src/x/c.ts', 'server/src/x/d.ts', 'server/src/x/e.ts']);
    const one = (file, text) => relativeImports(file, text, set).map(e => e.to);
    assert.deepEqual(one('server/src/files/a.ts', `import { q } from './store.js';`), ['server/src/files/store.ts']);
    assert.deepEqual(one('server/src/x/b.ts', `import type { Q } from '../files/store.js';`), ['server/src/files/store.ts']);
    assert.deepEqual(one('server/src/x/c.ts', `export { q } from '../files/store.js';`), ['server/src/files/store.ts']);
    assert.deepEqual(one('server/src/x/d.ts', `// import { q } from '../files/store.js';
const s = "../files/store.js";`), []);
    assert.deepEqual(one('server/src/x/e.ts', `import { q } from 'node:fs';`), []);
  });
});
