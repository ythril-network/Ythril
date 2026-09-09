/**
 * A hop over link records is ONE query, not one per class — and the same for the scan that refuses a delete.
 *
 * ## The regression this exists to stop coming back
 *
 * The first implementation asked the links collection once per class and then fetched the named records once
 * per class: six link queries plus up to six document reads per hop, where the array walk it replaced does
 * three collection reads.
 *
 * Measured on a corpus of 8 380 links (`scripts/LINK-READERS.md`):
 *
 *     traverse depth 2   37.28 ms per-class   vs   6.92 ms on the arrays it replaced
 *     backlink scan      10.71 ms per-class   vs   3.19 ms
 *
 * **3.8× slower, for an identical answer, on the change whose whole argument was that one indexed lookup
 * beats three scans over arrays.** The lookup was never the cost. The round trips were.
 *
 * ## Why a gate and not just the benchmark
 *
 * Because every functional test passed. The answers were identical throughout — 37, 107 and 179 nodes at the
 * three depths, on all three versions — so nothing in the suite could see it, and nothing will see it if it
 * comes back. A later change that adds a seventh link class, or moves a projection, or "simplifies" the
 * grouping back into a loop, would be correct and three times slower with no test to say so.
 *
 * The benchmark cannot be that test: it needs a database, a corpus and a checkout of a year-old commit.
 *
 * ## What it asserts
 *
 * That the readers call the BATCHED entry points and not the per-class ones. That is a structural property of
 * the code, checkable without a database — and it is the property the measurement turned on.
 *
 * Run: node --test testing/standalone/a-link-hop-is-one-query-not-one-per-class.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const code = (f) => stripComments(readFileSync(f, 'utf8'));

const ADJACENCY = 'server/src/brain/link-adjacency.ts';
const FRONTIER = 'server/src/brain/link-frontier.ts';
const ENTITIES = 'server/src/brain/entities.ts';

/** The body of a named function, brace-matched — never a character window. */
function bodyOf(src, name) {
  const at = src.search(new RegExp(`(?:async )?function ${name}\\s*[(<]`));
  assert.ok(at >= 0, `${name} not found — re-anchor this gate`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('the batched entry points exist', () => {
  it('one query for every link pointing AT a frontier, and one for every link FROM a seed set', () => {
    // The floor: renamed, every assertion below would match a function that no longer exists.
    const src = code(ADJACENCY);
    assert.match(src, /export async function linksPointingAt\(/);
    assert.match(src, /export async function linksStartingFrom\(/);
    assert.match(src, /export async function docsFromCollection\(|export async function docsFromCollection</);
  });

  it('neither batched query narrows by CLASS, which is what makes it one query', () => {
    /*
     * `{to: {$in: frontier}}` and nothing else. Adding `toKind`/`fromKind` to the filter is how this becomes
     * six queries again — it looks like a harmless narrowing and it is the whole regression.
     *
     * The classes are separated from the rows in memory afterwards, which costs nothing by comparison.
     */
    const src = code(ADJACENCY);
    for (const fn of ['linksPointingAt', 'linksStartingFrom']) {
      const body = bodyOf(src, fn);
      assert.doesNotMatch(body, /toKind:\s*cls|fromKind:\s*cls|cls\.toKind|cls\.kind/,
        `${fn} narrows by class, so it is one query PER CLASS again — six per hop where the array walk does `
        + 'three, which measured 3.8× slower for the same answer');
    }
  });

  it('a document read is per COLLECTION, so a file is not fetched once per class it holds', () => {
    // A file has three classes and a chrono entry two. Fetching per class reads the same document two or
    // three times, and that repetition is half of what the round-trip count was.
    const body = bodyOf(code(ADJACENCY), 'docsFromCollection');
    assert.match(body, /\$\{spaceId\}_\$\{collection\}/, 'it must take a COLLECTION, not a class');
    assert.doesNotMatch(body, /cls\./, 'a per-class parameter here is the repetition coming back');
  });
});

describe('every reader uses them', () => {
  it('the traversal scans a hop with the batched query, not the per-class one', () => {
    const src = code(FRONTIER);
    assert.match(src, /linksPointingAt\(/, 'the backward scan');
    assert.match(src, /linksStartingFrom\(/, 'and the forward one, which recall uses on its seeds');
    assert.doesNotMatch(src, /linkedFromIds\(/,
      'the traversal is back on the per-class lookup. It is kept for the single-target delete scan, which '
      + 'gains nothing from a batch — per class, per hop, it is the 3.8× regression.');
  });

  it('and the delete scan does too', () => {
    const src = code(ENTITIES);
    assert.match(src, /linksPointingAt\(/,
      'the scan that refuses a delete asks per class again — six queries plus six document reads for ONE '
      + 'target id, which measured 10.71 ms against the array path\'s 3.19');
    assert.match(src, /docsFromCollection<\{ _id: string \}>\([^)]*\{ _id: 1 \}\)/,
      'the delete scan reports ids and nothing else, so it must ask for `_id` alone — the union projection '
      + 'sends every field of every class to answer a question about membership');
  });

  it('the benchmark that produced these numbers is in the repo', () => {
    /*
     * The claim in the docblock above is a MEASUREMENT, and a measurement whose script is gone is a number
     * somebody has to take on trust. This is the same rule the benchmark protocol states for every other
     * figure the project publishes.
     */
    const doc = readFileSync('scripts/LINK-READERS.md', 'utf8');
    assert.match(doc, /scripts\/bench-link-readers\.mjs/, 'the doc must name the script that produced it');
    assert.match(doc, /6506fb84/, 'and the exact commit it measured 3.x at');
    readFileSync('scripts/bench-link-readers.mjs', 'utf8');
  });
});
