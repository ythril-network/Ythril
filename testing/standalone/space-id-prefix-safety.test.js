/**
 * The space-id charset is load-bearing for three prefix operations, one of which drops collections.
 *
 * Per-space collections are named `{spaceId}_{suffix}`, and three places select them with a bare
 * `name.startsWith(`${spaceId}_`)` — no boundary check:
 *
 *   spaces/rename.ts    renames every match          (moves data)
 *   spaces/lifecycle.ts DROPS every match            (destroys data)
 *   spaces/_shared.ts   lists them to repair spaceId  (rewrites a field)
 *
 * They are correct today for one reason: a space id is validated `^[a-z0-9-]+$`, so `_` cannot appear
 * inside an id and is an unambiguous separator. A sibling space `work-archive` owns
 * `work-archive_facts`, which does not start with `work_`.
 *
 * Nothing states that dependency at the validation site, and it is the kind of rule that gets relaxed for
 * a good-sounding reason — readability, or accepting an id from an external system. If `_` were ever
 * permitted, deleting space `work` would silently drop `work_archive`'s collections: another space's data,
 * no confirmation, recoverable only from a backup. This test is the tripwire.
 *
 * It reads the pattern out of the SOURCE rather than re-declaring it, so relaxing the real rule fails here
 * instead of quietly diverging from a copy.
 *
 * Run: node --test testing/standalone/space-id-prefix-safety.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** Every place a caller-supplied space id is validated. */
const VALIDATION_SITES = [
  { file: 'server/src/spaces/body-schemas.ts', what: 'create + rename' },
  { file: 'server/src/networks/join-remote-act.ts', what: 'peer space map' },
  { file: 'server/src/spaces/lifecycle.ts', what: 'wipe guard' },
];

/** The prefix operations that depend on the charset. */
const PREFIX_SITES = [
  { file: 'server/src/spaces/rename.ts', why: 'renames every matching collection' },
  { file: 'server/src/spaces/lifecycle.ts', why: 'DROPS every matching collection' },
  { file: 'server/src/spaces/_shared.ts', why: 'walks them to repair stale spaceId fields' },
];

/** Pull every space-id character class actually written in a file, e.g. `[a-z0-9-]`. */
function charClassesIn(src) {
  return [...src.matchAll(/\/\^\[([^\]]+)\]\+\$\//g)].map(m => m[1]);
}

describe('space id charset — the prefix operations depend on it', () => {
  it('never permits an underscore at any validation site', () => {
    for (const { file, what } of VALIDATION_SITES) {
      const classes = charClassesIn(read(file));
      assert.ok(classes.length > 0, `${file} (${what}) should validate the space id with an anchored pattern`);
      for (const cls of classes) {
        assert.ok(!cls.includes('_'),
          `${file} (${what}) allows "_" in a space id — that makes the "{id}_" prefix ambiguous, and ` +
          `deleting space "work" would drop "work_archive"'s collections`);
      }
    }
  });

  it('keeps every prefix site pointing at this test, so the dependency is discoverable', () => {
    // A future reader relaxing the charset needs a way to find out why they must not. Each prefix site
    // names this file; if one loses the reference, the tripwire is invisible from the dangerous code.
    for (const { file, why } of PREFIX_SITES) {
      assert.match(read(file), /space-id-prefix-safety/,
        `${file} (${why}) should reference this test so the charset dependency is not silently inherited`);
    }
  });
});

describe('wipe → review findings', () => {
  let candidateTypesForWipe, WIPE_COLLECTION_TYPES;
  before(async () => {
    ({ candidateTypesForWipe, WIPE_COLLECTION_TYPES } = await import('../../server/dist/spaces/lifecycle.js'));
  });

  it('every wipeable collection either maps to a finding type or has none by construction', () => {
    /*
     * The collection plural ("facts") and the finding type ("fact") are different vocabularies. A
     * missing entry does not fail; it just leaves findings pointing at records that no longer exist.
     *
     * ## This asserted a COUNT, and the count stopped being the question
     *
     * It required `mapped.length === WIPE_COLLECTION_TYPES.length` — every wipeable collection mapped —
     * which was right while all five had findings. `M-2`'s links have none by construction: a link record is
     * two ids and their kinds, so there is nothing to find a duplicate of and nothing to contradict.
     *
     * A count cannot tell that apart from the omission this test exists to catch, so the map behind
     * `candidateTypesForWipe` is TOTAL now, with an explicit `null` where a collection has no findings — and
     * what is asserted here is that every mapped value is a real finding type, and that the ones with
     * findings are still all there. A new collection is then a compiler error at the map, where its author
     * has to decide which of the two it is, rather than a silent gap here.
     */
    const mapped = candidateTypesForWipe(new Set(WIPE_COLLECTION_TYPES));
    assert.ok(mapped.every(t => typeof t === 'string' && t.length > 0),
      `a mapped finding type is empty or not a string: ${JSON.stringify(mapped)}`);
    assert.deepEqual([...mapped].sort(), ['chrono', 'edge', 'entity', 'fact', 'file'],
      `the collections that DO have findings must all still map; got ${JSON.stringify(mapped)}`);
    assert.ok(WIPE_COLLECTION_TYPES.length > mapped.length,
      'if every wipeable collection has findings again, this expectation is the thing to update');
  });

  it('clears only the wiped type', () => {
    assert.deepEqual(candidateTypesForWipe(new Set(['facts'])), ['fact']);
    assert.deepEqual(candidateTypesForWipe(new Set(['entities', 'chrono'])).sort(), ['chrono', 'entity']);
  });

  it('asks for nothing when nothing is targeted, rather than deleting everything', () => {
    // An empty `$in` would be a no-op, but the caller skips the query entirely on an empty list — and a
    // truthy-but-empty result here would be the kind of mistake that wipes an unrelated type.
    assert.deepEqual(candidateTypesForWipe(new Set()), []);
  });
});

describe('space id charset — the collision it prevents', () => {
  // Demonstrates the actual failure, so the rule is not an article of faith.
  const startsWithPrefix = (collection, spaceId) => collection.startsWith(`${spaceId}_`);

  it('does not let a sibling space be caught by another space\'s prefix', () => {
    // Legal sibling ids under the current charset. Hyphen, not underscore, is what keeps them apart.
    assert.equal(startsWithPrefix('work-archive_facts', 'work'), false);
    assert.equal(startsWithPrefix('work2_facts', 'work'), false);
    assert.equal(startsWithPrefix('workspace_facts', 'work'), false);
  });

  it('still matches the space\'s own collections', () => {
    assert.equal(startsWithPrefix('work_facts', 'work'), true);
    assert.equal(startsWithPrefix('work_contradiction_candidates', 'work'), true);
  });

  it('WOULD collide if underscores were ever allowed — the thing being guarded', () => {
    // If `work_archive` were a legal id, this is what dropping `work` would take with it.
    assert.equal(startsWithPrefix('work_archive_facts', 'work'), true);
  });
});
