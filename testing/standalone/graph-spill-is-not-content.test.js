/**
 * A spilled read result is OUTPUT, not content — and every traverse site spills.
 *
 * The spill exists because a truncated traversal was indistinguishable from a complete one: `graphNodes: 7`
 * might be the whole neighbourhood or the first 7 of 40. The owner ruled that a flag is not the answer — write
 * the whole thing to the space's `_tmp/` and hand back an authenticated download link with a one-day TTL.
 *
 * Three things about that fix could go wrong quietly, and each has an assertion here:
 *
 * 1. **A new traverse site forgets to spill.** There are four (`/recall`, `/find-similar`, and the two MCP
 *    tools), they must agree, and the way they agree is by going through one builder.
 * 2. **The spill gets embedded.** `upsertFileMeta` enqueues an embedding unconditionally, which is correct for
 *    every other file in the store. Embedding this one would turn recall results into recall-searchable
 *    content, so the next recall could match the JSON dump of an earlier one.
 * 3. **The spill shows up in the file manager**, as `_converted/`/`_extracted/` did before a customer
 *    reported it.
 *
 * Run: node --test testing/standalone/graph-spill-is-not-content.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

const { isSpillPath, SPILL_DIR } = await import('../../server/dist/brain/spill-path.js');
const { SPILL_TTL_DAYS, SPILL_CEILING_MULTIPLE } = await import('../../server/dist/brain/graph-spill.js');

const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const read = p => strip(readFileSync(p, 'utf8'));

describe('the spill directory is recognised at the root and nowhere else', () => {
  it('recognises the tree and its contents', () => {
    assert.equal(isSpillPath(`${SPILL_DIR}/graph-abc.json`), true);
    assert.equal(isSpillPath(SPILL_DIR), true);
    assert.equal(isSpillPath(`/${SPILL_DIR}/graph-abc.json`), true, 'a leading slash is the same path');
  });

  it("leaves a user's own directory of the same name alone", () => {
    // `hideDerivedTrees` only hides these at the ROOT for the same reason: a folder called `_tmp` deeper in
    // someone's tree is theirs, and their files in it are content like any other.
    assert.equal(isSpillPath(`notes/${SPILL_DIR}/mine.json`), false);
    assert.equal(isSpillPath(`${SPILL_DIR}-mine/x.json`), false, 'a prefix is not a directory');
    assert.equal(isSpillPath('graph-abc.json'), false);
  });
});

describe('the queue declines to embed a spill', () => {
  const queue = read('server/src/brain/embed-queue.ts');

  it('the guard is in enqueueEmbedJob, before any write', () => {
    // At the enqueue rather than the call site: `upsertFileMeta` enqueues unconditionally and that is right,
    // because every other file in the store is content.
    const fn = queue.slice(queue.indexOf('export async function enqueueEmbedJob'));
    assert.match(fn.slice(0, 600), /if \(recordType === 'file' && isSpillPath\(recordId\)\) return;/,
      'a spill must never reach the embedding queue');
  });

  it('and the guard is reachable — the enqueue is what file writes call', () => {
    // Without this the assertion above could pass against a function nothing calls.
    const meta = read('server/src/files/file-meta.ts');
    assert.match(meta, /await enqueueEmbedJob\(spaceId, 'file', normalised\)/);
  });
});

describe('the spill tree is hidden from browsing', () => {
  it('is a member of DERIVED_TREES, by the shared constant', () => {
    // The set moved out of `api/files.ts` when adding `_tmp` pushed that file past its god-file freeze — the
    // ratchet's own instruction being to put new behaviour beside a large file rather than inside it.
    const trees = read('server/src/files/derived-trees.ts');
    assert.match(trees, /export const DERIVED_TREES = new Set\(\['_converted', '_extracted', SPILL_DIR\]\)/,
      'a second literal would drift from the one the writer uses');
    assert.match(trees, /import \{ SPILL_DIR \} from '\.\.\/brain\/spill-path\.js'/);
    // And the route still applies it, or the set would be a fact nothing acts on.
    assert.match(read('server/src/api/files.ts'), /hideDerivedTrees\(/);
  });
});

describe('every traverse site spills, and every site that spills reports it', () => {
  /**
   * The doors, DERIVED — and the count is gone from both the title and the body.
   *
   * It read *"there are four and they must agree"* over two named files, each asserted to hold exactly two
   * calls. Three copies of a number the code already holds: a third door is invisible to it, a door that
   * legitimately gains or loses a site fails on the arithmetic rather than on the rule, and the title
   * commits to a total nobody re-counts (`Q-6`, 2026-09-07).
   *
   * What replaces it is the property the number was standing in for: **within each door, the number of
   * spill builds, the number that report `graphComplete`, and the number that report `graphTruncated` are
   * the same.** A site added without its reporting is what that catches, at any total.
   */
  const doors = trackedSources('server/src')
    .filter(f => f.endsWith('.ts') && f !== 'server/src/brain/graph-spill.ts')
    .filter(f => /buildGraphWithSpill/.test(read(f)));

  it('both doors are found, or this whole block is about nothing', () => {
    assert.ok(doors.length >= 2,
      `only ${doors.length} door(s) build a spill; REST and MCP are the minimum, so the scan is wrong`);
  });

  for (const door of doors) {
    it(`${door} reports a spill at every site that builds one`, () => {
      const code = read(door);
      const count = (re) => (code.match(re) ?? []).length;
      const builds = count(/buildGraphWithSpill\(/g);
      assert.ok(builds >= 1, `${door} imports the builder and never calls it`);

      // Computing a spill and dropping it would leave the caller exactly where they started.
      assert.equal(count(/graphComplete: spill/g), builds,
        `${door}: ${builds} spill build(s) and ${count(/graphComplete: spill/g)} report the download link`);

      /*
       * The truncation flag has its OWN source, and that is the point of asserting it separately. The two
       * were one expression — `graphTruncated: true, graphComplete: spill` — because a spill was the only
       * way a graph could be short. It is not: a bounded link scan that stops reading leaves a short graph
       * with no complete copy to write, since the records missing from it are exactly the ones never read.
       */
      assert.equal(count(/graphTruncated \? \{ graphTruncated: true \}/g), builds,
        `${door}: a site still derives truncation from the spill file, so a scan that stopped reading is `
        + 'reported as a complete graph');
      assert.doesNotMatch(code, /graphTruncated: true, graphComplete: spill/,
        `${door} still couples the two`);
    });
  }

  it('nothing calls the un-spilled builder any more', () => {
    // `buildRecallGraph` was the pre-spill entry point. Leaving it exported would let a new site silently opt
    // out of the whole mechanism — so it is gone, not deprecated.
    const graph = read('server/src/brain/recall-graph.ts');
    assert.ok(!/export async function buildRecallGraph/.test(graph),
      'a second way to build a graph is a second way to truncate one silently');
    for (const door of doors) {
      assert.ok(!/buildRecallGraph\(/.test(read(door)), `${door} still calls the un-spilled builder`);
    }
  });
});

describe('the constants say what the ruling said', () => {
  it('one day, per the ruling', () => {
    assert.equal(SPILL_TTL_DAYS, 1);
  });

  it('the spill walk is bounded, so the fix cannot make a read unbounded', () => {
    // "Write the whole thing" without a ceiling turns one dense hub into an unbounded read. The bound is
    // reported (`ceilingHit`) rather than silent, which is the defect this module exists to remove.
    assert.ok(SPILL_CEILING_MULTIPLE > 1, 'a ceiling at the cap would spill nothing');
    assert.ok(SPILL_CEILING_MULTIPLE <= 50, 'an effectively unbounded ceiling is not a ceiling');
    const spill = read('server/src/brain/graph-spill.ts');
    assert.match(spill, /ceilingHit/, 'hitting the ceiling must be reported');
  });

  it('the spill boundary is the inline cap itself, not a second number', () => {
    // The E2E pins the boundary from both sides — a 30-leaf hub must produce a link, a 3-neighbour chain must
    // not — so "always spills" and "never spills" are both already excluded by those two passing together.
    // What they cannot pin is an off-by-one, hence this: the comparison is against the cap the caller's own
    // `topK` and `traverse` produced, so the old truncation point IS the new spill point.
    const spill = read('server/src/brain/graph-spill.ts');
    assert.match(spill, /if \(flat\.length <= inlineCap\) \{/,
      'a threshold of its own would drift from the cap the route computes');
    assert.match(spill, /const ceiling = inlineCap \* SPILL_CEILING_MULTIPLE;/);
    assert.match(spill, /nestNeighbours\(flat\.slice\(0, inlineCap\), seedIds\)/,
      'the inline tree must still be capped exactly as before');
  });

  /**
   * Every `putSpill(...)` call in the builder, as its argument text. Q-92: the builder hands a spill to the
   * instance store and never to a space's file store, so this is where the rule is applied.
   */
  const putSpillCalls = () => {
    const spill = read('server/src/brain/graph-spill.ts');
    return [...spill.matchAll(/\bputSpill\(/g)]
      .map(m => balancedFrom(spill, m.index, 'putSpill in graph-spill.ts').slice(1, -1));
  };

  it('both spill kinds go to the read-spill store, and its expiresAt is their only lifetime', () => {
    /*
     * Q-92 replaced the rule this asserted (`ttlDays: SPILL_TTL_DAYS` on a `<space>_files` record). A record
     * TTL is a WRITE into the space: a blob, a FileMeta, a seq bump that syncs it to every peer, an embed job.
     * A spill now lives in `_read_spills` / `_read_spill_pages`, whose TTL index is its whole lifetime — so a
     * file-record TTL here would mean the space is being written again.
     */
    const spill = read('server/src/brain/graph-spill.ts');
    assert.doesNotMatch(spill, /ttlDays/, 'a file-record TTL means the spill is a record in the space again');
    const kinds = new Set(putSpillCalls().map(a => a.match(/kind:\s*'(\w+)'/)?.[1]));
    assert.deepEqual([...kinds].sort(), ['graph', 'results'],
      'both the graph spill and the result remainder must be handed to the store');
  });

  it('a spill is addressed to NO space — its member spaces are what its records say — and to its caller', () => {
    /*
     * Q-92 replaced "the file goes to a MEMBER space" — right while a spill was a file, and the reason the
     * write went to a seed's space rather than a proxy. There is no write space any more: `putSpill` derives
     * `memberSpaceIds` from every item's `spaceId`, so a caller that passes its own list can only get it wrong,
     * and `issuedTo` is what makes the spill readable by the token that caused it and nobody else.
     */
    const calls = putSpillCalls();
    assert.ok(calls.length >= 2, `only ${calls.length} putSpill call(s) — the scan is wrong or a kind is missing`);
    for (const args of calls) {
      assert.match(args, /\bissuedTo\b/, `a putSpill call names no owner: ${args.trim().slice(0, 120)}`);
      assert.doesNotMatch(args, /\bmemberSpaceIds?\b|\bspaceId\s*:/,
        `a putSpill call names its own space(s) — the store derives them from the items: ${args.trim().slice(0, 120)}`);
    }
    const spill = read('server/src/brain/graph-spill.ts');
    assert.ok(!/writeSpaceId/.test(spill),
      'no caller-supplied write space — the routes had `spaceId` and `callSpace` to hand, and both can be a proxy');

    /*
     * **DERIVED from who imports the builder, and the COUNT is gone.** It named the two doors and asserted
     * exactly two calls in each — two facts the code already holds, and both the kind that rot: a third door
     * would be outside the list, and a door that legitimately gains or loses a call fails on the number
     * rather than on the rule (`Q-6`, 2026-09-07).
     *
     * What remains is a FLOOR on what was found — an empty scan passes every loop written over it — and the
     * rule applied to every call there is.
     */
    // The module that DEFINES the thing under test is excluded: it builds the spill, so it would match the
    // search and then fail the rule it exists to implement.
    const doors = trackedSources('server/src', { exclude: ['server/src/brain/graph-spill.ts'] })
      .filter(f => /buildGraphWithSpill/.test(read(f)));
    assert.ok(doors.length >= 2,
      `only ${doors.length} door(s) build a spill; REST and MCP are the minimum, so the scan is wrong`);

    let checked = 0;
    for (const src of doors) {
      const code = read(src);
      // A WINDOW, converted: the subject is each call's ARGUMENT LIST, and its bound is the paren that closes
      // it. At 320 characters a call that gained an argument would have stopped matching.
      const calls = [...code.matchAll(/buildGraphWithSpill\(/g)]
        // Outer parens stripped so the assertion below sees exactly what the capture group used to give it —
        // this is a re-bounding, not a change of what is checked.
        .map(m => balancedFrom(code, m.index, `buildGraphWithSpill in ${src}`).slice(1, -1));
      assert.ok(calls.length >= 1, `${src} imports the builder and never calls it`);
      for (const args of calls) {
        checked++;
        assert.ok(!/spaceId,\s*\)?\s*$/.test(args.trim()),
          `${src} passes a space id to the builder again: ${args.trim().slice(-60)}`);
      }
    }
    assert.ok(checked >= 2, `only ${checked} spill build(s) examined; the scan found doors but no calls`);
  });

  it('the download link is the spill route, never the space\'s file route', () => {
    /*
     * Q-92 replaced "the link is the authenticated file route". That route is `files: read` on the space — a
     * knowledge-only token got a link it could not fetch, and any files-read token could read every spill in
     * the space. The spill route checks the ISSUER and knowledge read on every member space instead.
     */
    const spill = read('server/src/brain/graph-spill.ts');
    const store = existsSync('server/src/brain/read-spill-store.ts') ? read('server/src/brain/read-spill-store.ts') : '';
    assert.match(spill + store, /\/api\/brain\/spills\/\$\{encodeURIComponent\(/,
      'the download must be `GET /api/brain/spills/:id`, the door that checks who the spill belongs to');
    assert.doesNotMatch(spill, /\/api\/files\//, 'a spill is not a file in a space, so it has no file-route link');
  });
});
