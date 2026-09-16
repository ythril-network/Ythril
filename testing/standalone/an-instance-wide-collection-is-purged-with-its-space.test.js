/**
 * A collection keyed by space but NOT named after one must be purged when that space is deleted.
 *
 * ## The shape, and why a prefix drop is not enough
 *
 * `dropSpaceData` clears a space's data by NAME PREFIX — every collection called `<spaceId>_something`.
 * That reaches the six brain collections, the tombstones, the conflicts and the rest, and it is safe because
 * a space id cannot contain `_`.
 *
 * It reaches nothing that is instance-wide. `space_activity` is one document per space per hour in one
 * shared collection, and it needed its own line (`2b`) in that function for exactly this reason. The notes
 * behind the conversion pre-flight are the same shape and needed another (`2c`) — found by sweeping the
 * guidelines over the change that added them, before it was tagged, and not by the prefix drop failing,
 * because a prefix drop that reaches nothing does not fail.
 *
 * **The cost is a WRONG answer rather than a missing one.** Rows outlive their space for the whole retention
 * window, and a space recreated with the same id inherits them: usage it never served, or writers that wrote
 * to its predecessor. An operator reads that and decides something on it.
 *
 * ## Derived, because a list of two is a list that will be wrong at three
 *
 * The set is every server module that owns a shared collection whose documents carry a `spaceId`. That is
 * read out of the source, not written here — the two known instances were both added by somebody who did
 * not know about the other one.
 *
 * Run: node --test testing/standalone/an-instance-wide-collection-is-purged-with-its-space.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/**
 * A module owning a collection whose NAME is a constant (so it is instance-wide) and whose documents are
 * filtered by `spaceId` (so it is keyed by space).
 *
 * A per-space collection is excluded by construction: its name is built with the id in it
 * (`${spaceId}_facts`), so it never matches a constant-name declaration.
 */
function instanceWideSpaceKeyed() {
  const out = [];
  for (const f of trackedSources(['server/src'])) {
    const s = src(f);
    // A collection name held as a bare string constant — `const COLLECTION = '_x'`, `= 'space_activity'`.
    const named = /^\s*(?:export\s+)?const\s+\w*COLLECTION\w*\s*(?::\s*string\s*)?=\s*'([^']+)'/m.exec(s);
    if (!named) continue;
    // Interpolating the id anywhere means it is per-space after all, and the prefix drop reaches it.
    if (/collection[<(][^)]*\$\{spaceId\}/.test(s) || named[1].includes('${')) continue;
    if (!/\bspaceId\b|\bspace:\s/.test(s)) continue;
    out.push({ file: f, collection: named[1] });
  }
  return out;
}

/**
 * Collections this rule deliberately does NOT govern, and the reason for each.
 *
 * The damage the rule prevents is a WRONG ANSWER read back by space: rows that outlive their space and are
 * then served as if they belonged to the one recreated in its place. A collection that is never read by
 * space cannot produce one, and a collection whose whole purpose is to outlive the space must not be purged.
 *
 * A reason is required, and asserted below, because the trap here is the same one `NOT_AREA_SCOPED` was
 * written for: an exemption with no `why` is indistinguishable from an omission, and the next reader adds a
 * third one by copying the shape.
 */
const EXEMPT = {
  audit_log:
    'the audit log is the record of what HAPPENED, including the deletion itself. Purging the entries of a '
    + 'deleted space would destroy the evidence that it ever existed -- the opposite of what this collection '
    + 'is for, and the more serious defect of the two.',
  _webhook_retry_queue:
    'a drain queue, never read BY SPACE: each job is deleted as it is attempted and abandoned after '
    + 'MAX_ATTEMPTS, so nothing outlives the space long enough to be served as another one answer. Its rows '
    + 'carry a spaceId to address the delivery, not to be queried on.',
};

describe('an instance-wide collection keyed by space is purged with that space', () => {
  const owners = instanceWideSpaceKeyed().filter(o => !(o.collection in EXEMPT));
  const dropSpaceData = src('server/src/spaces/lifecycle.ts');

  it('every exemption says why, and still names a real collection', () => {
    // An exemption for a collection that no longer exists is a row nobody will ever revisit, and it hides
    // the next one that gets added with the same name.
    const all = instanceWideSpaceKeyed().map(o => o.collection);
    for (const [name, why] of Object.entries(EXEMPT)) {
      assert.ok(all.includes(name), `${name} is exempted here and the derivation no longer finds it`);
      assert.ok(why.length > 60, `${name}'s exemption has no real reason on it`);
    }
  });

  it('found the collections to check', () => {
    // A floor. An empty derivation passes the loop below without looking at anything, which is the vacuity
    // this repository writes gates about. Two are known; the derivation must see at least those.
    assert.ok(owners.length >= 2,
      `only ${owners.length} instance-wide space-keyed collection(s) found — the derivation is wrong, not the code`);
  });

  it('every one of them has a purge that `dropSpaceData` calls', () => {
    /*
     * The purge is looked for BY IMPORT into `dropSpaceData`'s file, not by the existence of an exported
     * function somewhere. A module can export `purgeX` and have nobody call it, which is the same leak with
     * a more convincing name — and that is the exact failure a source gate is worth writing for, because
     * nothing at runtime distinguishes "purged" from "never had rows".
     */
    const missing = owners.filter(o => {
      const mod = o.file.replace(/^server\/src\//, '').replace(/\.ts$/, '');
      return !new RegExp(`import\\([^)]*${mod.split('/').pop()}\\.js`).test(dropSpaceData);
    });
    assert.deepEqual(missing.map(m => `${m.file} (${m.collection})`), [],
      'these own a shared collection keyed by spaceId that `dropSpaceData` never purges, so its rows outlive '
      + 'the space and a space recreated with the same id inherits them');
  });

  it('and indexes the two fields every one of them filters on', () => {
    // Not a performance nicety: the purge itself filters by `spaceId`, and it runs inside a space deletion
    // that already holds a write-ahead marker. An unindexed scan there is a delete that gets slower as the
    // instance gets busier, at the moment it must not fail.
    const unindexed = owners.filter(o => !/createIndex/.test(src(o.file)));
    assert.deepEqual(unindexed.map(m => `${m.file} (${m.collection})`), [],
      'these filter a shared collection by spaceId and declare no index for it');
  });
});
