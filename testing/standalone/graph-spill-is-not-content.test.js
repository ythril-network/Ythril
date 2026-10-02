/**
 * A spilled read result is OUTPUT, not content — and a traversed answer never spills its graph.
 *
 * A spill once carried the whole graph beside a shortened inline one. Q-126 (owner, 2026-09-28) replaced that:
 * a row carries its WHOLE graph or is named as left out, and the only spill is the remainder of the rows the
 * byte budget cut, written only when the caller sends `remainderDump: true`.
 *
 * What could go wrong quietly, each with an assertion here:
 *
 * 1. **A traverse door walks on its own**, or a graph spill comes back. Every door that accepts `traverse`
 *    answers through `traversedAnswer`, and no source writes a `graph` spill.
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
    // The rule has one spelling, `isSpillJob`, shared with the batched enqueue an arrival takes (5.6.2), so the
    // gate holds both halves: the enqueue returns on it before any write, and it is the spill rule.
    const fn = queue.slice(queue.indexOf('export async function enqueueEmbedJob'));
    assert.match(fn.slice(0, 600), /if \(isSpillJob\(recordType, recordId\)\) return;/,
      'a spill must never reach the embedding queue');
    const rule = queue.slice(queue.indexOf('function isSpillJob('));
    assert.match(rule.slice(0, 300), /return recordType === 'file' && isSpillPath\(recordId\);/,
      'isSpillJob must be the spill rule: a file whose path is in the spill tree');
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

describe('every door that traverses answers through one builder, and none writes a graph spill', () => {
  /**
   * Q-126 reversed the graph spill. A traversing answer carries every row with its WHOLE graph, or names the
   * row as left out; nothing is written unless the caller sends `remainderDump: true`, and then only the rows
   * the byte budget cut (owner, 2026-09-28: *"i only want whole results and the rest gets truncated except if
   * a flag is set that says rest goes to a file"*).
   *
   * The doors are DERIVED from who parses a `traverse` option, never listed: a door that accepts `traverse`
   * and answers through anything but `traversedAnswer` is a second rule about what a whole row is, which is
   * how the shortened graph shipped in the first place. The count is a floor, not a total (`Q-6`).
   */
  const doors = trackedSources('server/src')
    .filter(f => f.endsWith('.ts') && f !== 'server/src/brain/traverse-option.ts')
    .filter(f => /parseTraverseOption\(/.test(read(f)));

  it('both doors are found, or this whole block is about nothing', () => {
    assert.ok(doors.length >= 2,
      `only ${doors.length} door(s) parse a traverse option; REST and MCP are the minimum, so the scan is wrong`);
  });

  for (const door of doors) {
    it(`${door} answers every traverse it accepts through traversedAnswer`, () => {
      const code = read(door);
      const count = (re) => (code.match(re) ?? []).length;
      const accepts = count(/parseTraverseOption\(/g);
      const answers = count(/traversedAnswer\(/g);
      assert.ok(answers >= accepts,
        `${door}: ${accepts} traverse option(s) parsed and ${answers} answered through traversedAnswer — `
        + 'a site that walks on its own decides for itself what a whole row is');
      assert.doesNotMatch(code, /\btraverseFromSeeds\(/,
        `${door} walks the graph itself instead of through the row walker`);
    });
  }

  it('no source builds, reports or writes a graph spill', () => {
    // `graphComplete` was the link to the spilled whole graph beside a SHORTENED `_graph`. Its return would
    // be the shortened row returning with it, whatever the spill carried.
    for (const f of trackedSources('server/src').filter(p => p.endsWith('.ts'))) {
      const code = read(f);
      assert.doesNotMatch(code, /buildGraphWithSpill/, `${f} still builds a graph spill`);
      assert.doesNotMatch(code, /\bgraphComplete\s*:/, `${f} still sends a graphComplete link`);
      assert.doesNotMatch(code, /putSpill\(\{[^}]*kind:\s*'graph'/, `${f} still writes a graph spill`);
    }
  });

  it('a graph spill issued before the change stays readable until it expires', () => {
    // Removing the kind from the store would turn a link a caller already holds into a 404 inside its day.
    assert.match(read('server/src/brain/read-spill-store.ts'), /export type SpillKind = 'results' \| 'graph';/,
      'the store must still know the legacy graph kind');
  });

  it('nothing calls the un-spilled builder any more', () => {
    // `buildRecallGraph` was the pre-spill entry point, and a second way to build a graph is a second way to
    // shorten one silently — so it stays gone.
    assert.ok(!/export async function buildRecallGraph/.test(read('server/src/brain/recall-graph.ts')));
    for (const door of doors) {
      assert.ok(!/buildRecallGraph\(/.test(read(door)), `${door} still calls the un-spilled builder`);
    }
  });
});

describe('the constants say what the ruling said', () => {
  it('one day, per the ruling', () => {
    assert.equal(SPILL_TTL_DAYS, 1);
  });

  it('the spill module holds no size rule of its own', () => {
    // A node cap or a spill threshold here is a second rule about size, below the byte budget, that can
    // shorten a row the budget promised was whole — the defect Q-126 removed.
    assert.equal(SPILL_CEILING_MULTIPLE, undefined, 'the graph spill ceiling is back');
    const spill = read('server/src/brain/graph-spill.ts');
    assert.doesNotMatch(spill, /inlineCap|ceilingHit|MAX_GRAPH_NODES/, 'a size rule lives in the spill module again');
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

  it('the one spill kind goes to the read-spill store, and its expiresAt is its only lifetime', () => {
    /*
     * Q-92 replaced the rule this asserted (`ttlDays: SPILL_TTL_DAYS` on a `<space>_files` record). A record
     * TTL is a WRITE into the space: a blob, a FileMeta, a seq bump that syncs it to every peer, an embed job.
     * A spill now lives in `_read_spills` / `_read_spill_pages`, whose TTL index is its whole lifetime — so a
     * file-record TTL here would mean the space is being written again.
     */
    const spill = read('server/src/brain/graph-spill.ts');
    assert.doesNotMatch(spill, /ttlDays/, 'a file-record TTL means the spill is a record in the space again');
    const kinds = new Set(putSpillCalls().map(a => a.match(/kind:\s*'(\w+)'/)?.[1]));
    assert.deepEqual([...kinds], ['results'],
      'the result remainder is the only spill a search writes (Q-126: no graph spill)');
  });

  it('a spill is addressed to NO space — its member spaces are what its records say — and to its caller', () => {
    /*
     * Q-92 replaced "the file goes to a MEMBER space" — right while a spill was a file, and the reason the
     * write went to a seed's space rather than a proxy. There is no write space any more: `putSpill` derives
     * `memberSpaceIds` from every item's `spaceId`, so a caller that passes its own list can only get it wrong,
     * and `issuedTo` is what makes the spill readable by the token that caused it and nobody else.
     */
    const calls = putSpillCalls();
    assert.ok(calls.length >= 1, `only ${calls.length} putSpill call(s) — the scan is wrong`);
    for (const args of calls) {
      assert.match(args, /\bissuedTo\b/, `a putSpill call names no owner: ${args.trim().slice(0, 120)}`);
      assert.doesNotMatch(args, /\bmemberSpaceIds?\b|\bspaceId\s*:/,
        `a putSpill call names its own space(s) — the store derives them from the items: ${args.trim().slice(0, 120)}`);
    }
    const spill = read('server/src/brain/graph-spill.ts');
    assert.ok(!/writeSpaceId/.test(spill),
      'no caller-supplied write space — the routes had `spaceId` and `callSpace` to hand, and both can be a proxy');

    /*
     * **DERIVED from who calls the spill writer, and the COUNT is a floor.** Every door's call names its
     * owner and no space — an empty scan passes every loop written over it, hence the floor (`Q-6`).
     */
    const doors = trackedSources('server/src', { exclude: ['server/src/brain/graph-spill.ts'] })
      .filter(f => /spillResultSet\(/.test(read(f)));
    assert.ok(doors.length >= 2,
      `only ${doors.length} door(s) write a spill; REST and MCP are the minimum, so the scan is wrong`);

    let checked = 0;
    for (const src of doors) {
      const code = read(src);
      // Bounded by the paren that closes each call, never by a character count.
      const doorCalls = [...code.matchAll(/spillResultSet\(/g)]
        .map(m => balancedFrom(code, m.index, `spillResultSet in ${src}`).slice(1, -1));
      for (const args of doorCalls) {
        checked++;
        assert.match(args, /\bissuedTo\b/, `${src}: a spill write names no owner`);
        assert.doesNotMatch(args, /\bspaceId\s*[:,]|\bmemberSpaceIds?\b/,
          `${src} passes a space to the spill writer again: ${args.trim().slice(0, 120)}`);
      }
    }
    assert.ok(checked >= 2, `only ${checked} spill write(s) examined; the scan found doors but no calls`);
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
