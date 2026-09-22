/**
 * A link scan is bounded by the walk's own cap, and the field it scans is indexed.
 *
 * ## Two defects that compound, which is why one file covers both
 *
 * **Unbounded.** `link-frontier.ts` issued `.find().toArray()` with no `.limit()` — in
 * `linkedRecordsAtFrontier` and again in `entitiesLinkedFromRecords` — once per link class, per member space,
 * per hop. The node cap does not help: it counts HYDRATED records, after the read has already returned
 * everything.
 *
 * **Unindexed.** `spaces/lifecycle.ts` created `entityIds: 1` on **memories only**. Chrono and files, whose
 * `entityIds` the same scans read, had none. So the unbounded reads were also collection scans.
 *
 * ## Why it went from latent to urgent
 *
 * Before 3.6 those scans ran on the standalone `traverse` tool. Recall's expansion learned to follow links,
 * so they now run on the RECALL path — up to 3N more unbounded reads for a depth-N call with all three flags
 * on, against exactly the two collections with no index. And M-2 turns every mention into a record, which
 * multiplies the row count by orders of magnitude against a read bounded by nothing.
 *
 * ## The cap is the walk's own, by the owner's decision
 *
 * 2026-08-30, option A: bound each scan by the number already derived from `topK` and the byte budget, and
 * report hitting it through the existing `graphTruncated` / `graphComplete` spill rather than inventing a
 * second signal. A separate cap would be one rule with two numbers, which is the defect this repo produces
 * most.
 *
 * The accepted cost, stated so it is not re-opened as a surprise: link scans and edge scans share one budget,
 * so a hub with thousands of mentions can crowd out its edge neighbours. If that bites, the fix is a split
 * budget rather than a second cap.
 *
 * Run: node --test testing/standalone/the-link-scans-are-bounded-and-indexed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { LINK_INDEXES } = await import('../../server/dist/brain/link-adjacency.js');
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('every link scan is bounded', () => {
  /*
   * THE READING FUNCTIONS, which is no longer the same list as the two exported scans.
   *
   * `linkedRecordsAtFrontier` does not read any more: it computes the bound and hands it to the helper
   * that does, one query for the whole hop. That batching took a measured 3.8× regression off the link
   * path — `benchmarks/LINK-READERS.md`.
   *
   * So the bound is asserted where the read happens. Checking only the exported name would go green on a
   * helper that reads unbounded, which is the whole point of the check.
   */
  /*
   * Named with the FILE that issues the read, because the batched path's bound moved modules.
   *
   * `linkedRecordsFromRows` is handed rows that were already fetched — the `.limit()` for the whole hop is in
   * `linksPointingAt`, in the adjacency module. Asserting it here would fail on code that is bounded, which
   * is worse than not asserting it: the way to quieten that is to put a bound where one already exists.
   */
  /*
   * `entitiesLinkedFromRecords` is in the forwarding case below, not this one, for the same reason: since
   * 5.0 it asks ONE query for the whole seed set and the `.limit()` is inside `linksStartingFrom`.
   * Asserting a cursor bound in its body would fail on code that is bounded, and the way to quieten that
   * is to add a second bound where one already exists.
   */
  const READERS = [
    ['server/src/brain/link-adjacency.ts', 'linksPointingAt'],
    ['server/src/brain/link-adjacency.ts', 'linksStartingFrom'],
  ];
  for (const [file, fn] of READERS) {
    it(`${fn} passes a limit to Mongo`, () => {
      /*
       * `.limit()` on the CURSOR, not a slice afterwards. Reading everything and discarding the tail costs the
       * same scan and the same network transfer — the point is that the database stops early.
       */
      const body = bodyOf(src(file), fn);
      assert.match(body, /\.limit\(/,
        `${fn} reads without a bound, so one hub entity returns its whole mention set per class per space per hop`);
      // Structural, not a guessed gap: the bound must appear BEFORE the cursor is drained, which is what
      // makes it reach Mongo. A `.slice()` after `.toArray()` costs the same scan and the same transfer.
      assert.ok(body.indexOf('.limit(') < body.indexOf('.toArray()'),
        'the bound is applied after the cursor is drained, so the database still returns everything');
    });
  }

  it('and the batching scans FORWARD their bound to the query that reads', () => {
    /*
     * The seam the batching created. A scan that computes `remaining` and then calls an unbounded query is
     * a bound with no effect — and it reads exactly like the bounded version in a diff.
     */
    const s = src('server/src/brain/link-frontier.ts');
    for (const [fn, query] of [
      ['entitiesLinkedFromRecords', 'linksStartingFrom'],
      ['linkedRecordsFromRows', 'linksPointingAt'],
    ]) {
      const body = bodyOf(s, fn);
      const at = body.indexOf(query + '(');
      if (at === -1) continue;   // the one that is handed its rows — its caller is covered below
      assert.match(body.slice(at, body.indexOf(')', at) + 1), /remaining|left|limit/,
        `${fn} calls ${query} without its bound, so the whole hop is read and then trimmed`);
    }
  });

  it('the bound is the caller\'s, not a constant chosen here', () => {
    /*
     * The owner's decision. A literal in this module would be a second cap with no relationship to the answer
     * size, and nobody would ever tune it — which is how a short graph comes to read as "few relationships".
     */
    const s = src('server/src/brain/link-frontier.ts');
    assert.match(s, /limit\??\s*:\s*number/,
      'the scan must take its bound from the caller, which is the walk that owns the budget');
    const bodies = ['linkedRecordsAtFrontier', 'entitiesLinkedFromRecords'].map(f => bodyOf(s, f)).join('\n');
    assert.doesNotMatch(bodies, /\.limit\(\s*\d+\s*\)/,
      'a numeric literal here is a second cap, unrelated to topK and the byte budget');
  });

  it('and both traversals pass theirs', () => {
    // A bound the callers do not supply is a default nobody chose. Both walks already know their cap.
    // Both traversals, since A-4 put the recall walk in its own module and this asks whether EACH passes its
    // own bound. Joined rather than read separately: the subject is the pair.
    const edges = src('server/src/brain/edges.ts') + src('server/src/brain/recall-seed-traversal.ts');
    for (const fn of ['traverseGraph', 'traverseFromSeeds']) {
      const body = bodyOf(edges, fn);
      const at = body.indexOf('linkedRecordsAtFrontier(');
      assert.ok(at > 0, `${fn} no longer calls the shared scan — re-point this gate`);
      assert.match(body.slice(at, body.indexOf(')', at) + 1), /limit/,
        `${fn} calls the scan without passing its own cap`);
    }
  });
});

describe('the collection every link scan reads is indexed', () => {
  it('a NEW space gets every link index, from the one declaration', () => {
    /*
     * It was on memories alone. Chrono got startsAt/status/seq/type and files got
     * tags/updatedAt/parentFileId — neither had the field the link scans actually queried, so those reads
     * were collection scans on top of being unbounded.
     *
     * Then it was three hand-placed `{ entityIds: 1 }` calls, which is the same defect one level down: a
     * link was a (collection, FIELD) pair, and `M-2` gave a chrono entry `memoryIds` and a file
     * `memoryIds` and `chronoIds`. Three classes had no index at all while the case reported all three
     * collections covered, because an unindexed scan returns the right answer slowly.
     *
     * 5.0 moved the reads onto the `links` collection, so the indexes are its own — and the rule is the
     * same one: they are DECLARED once and asked for by everything that creates them.
     */
    const life = src('server/src/spaces/lifecycle.ts');
    assert.match(life, /LINK_INDEXES/,
      'lifecycle writes its link indexes out instead of taking the declared set, so the backfill and the '
      + 'creation can ask for different things');
    // The floor: a loop over an empty declaration satisfies the assertion above and indexes nothing.
    assert.ok(LINK_INDEXES.length >= 3,
      `only ${LINK_INDEXES.length} link index(es) declared — the import is stale, and the loop is over nothing`);
    /*
     * BOTH directions, and the uniqueness. From a record: what does this concern. From an entity: what
     * concerns this — the backlink scan that blocks a delete, once per candidate. Each is a separate
     * index because each is separately asked.
     */
    const keysOf = (ix) => Object.keys(ix.keys).join(',');
    const declared = LINK_INDEXES.map(keysOf);
    assert.ok(declared.some(k => k.startsWith('from')), 'no index serves "what does this record concern"');
    assert.ok(declared.some(k => k.startsWith('to')), 'no index serves "what concerns this record"');
    assert.ok(declared.includes('seq'), 'no index serves the sync page, so every peer page sorts the collection');
    assert.ok(LINK_INDEXES.some(ix => ix.unique && keysOf(ix).startsWith('from')),
      'the identity index is not unique, so two peers noticing the same connection can fork it');
  });

  it('and EXISTING spaces get them too, not just new ones', () => {
    /*
     * The half that bites twice, and 5.0 made it worse before it made it better. `initSpace` runs for a
     * space NEW to the config, so an index added there reaches nobody who already runs the product — and
     * an upgraded space got its links collection from the CONVERSION's first insert, which creates a
     * collection and no indexes at all. The spaces with the most links to read are the ones that would
     * have had none.
     */
    const ensure = src('server/src/spaces/ensure-query-indexes.ts');
    assert.match(ensure, /LINK_INDEXES/,
      'the backfill writes its own index list, so a link index added at creation reaches every NEW space '
      + 'and no existing one — which is the failure this case exists for');
    assert.match(ensure, /spaceCollection\(space\.id, 'links'\)\)\.createIndex\(ix\.keys/,
      'the backfill must create each declared index on the links collection itself');
  });
  it('the backfill still reports how many calls it issued', () => {
    // A boot step that returns nothing cannot be asserted to have run, and a silent no-op looks identical to
    // a successful pass. This is why the function returns a count at all.
    const body = bodyOf(src('server/src/spaces/ensure-query-indexes.ts'), 'ensureQueryIndexes');
    assert.match(body, /issued\+\+/, 'the count must include the new indexes, or it under-reports');
    assert.match(body, /return issued/, 'the caller cannot tell the loop ran');
  });
});
