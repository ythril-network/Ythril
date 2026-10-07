/**
 * The file-tombstone collection is opened by ONE module, `files/tombstones.ts` — so the rule "a tombstone for an act
 * that has not happened is served by nothing" is kept in one place rather than at every reader (bundle-30 I15,
 * preship-3 P3-1).
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

const OWNER = 'server/src/files/tombstones.ts';

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
};

describe('the stray drain reads only published tombstones; every arrival site asks the wider predicate (Q-348)', () => {
  it('only the module and the declared published-only readers call heldFileTombstones', () => {
    const callers = new Set();
    for (const f of trackedSources('server/src')) {
      if (f === OWNER) continue;
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
    const owner = blankComments(readFileSync(join(REPO_ROOT, OWNER), 'utf8'));
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

  it('no other source names the collection: every reader goes through files/tombstones.ts', () => {
    const strays = [...found.entries()]
      .filter(([f]) => f !== OWNER && !(f in NOT_READERS))
      .map(([f, { lines }]) => `${f}:${lines.join(',')}`);
    assert.deepEqual(strays, [],
      'these name the file-tombstone collection outside files/tombstones.ts, so nothing holds them to the rule that '
      + 'a PENDING tombstone (an act not yet done) is never served, pushed, pruned or counted — call the module instead');
  });
});
