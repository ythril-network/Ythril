/**
 * A memory's and a file's embedding is built from its OWN content, never from the names of what it links to.
 *
 * ## Measured, not argued
 *
 * `factEmbedText` and `fileEmbedText` prepended the linked entities' names to the content before embedding.
 * On a 199-question benchmark that cost **1.5 points of strict evidence recall** — the same turn scored 0.8528
 * with the names out and 0.8369 with them in. `chronoEmbedText` never did it, so chrono was already the control.
 *
 * The reason it hurts is not subtle. A memory linked to five entities carries five names it does not say, so a
 * query naming any of them matches a record that never mentioned them, and the record's own sentence is diluted
 * by tokens the author did not write. It reads like free recall and behaves like noise.
 *
 * ## Why an EDGE is different, and stays as it is
 *
 * `edgeEmbedText` resolves its endpoints to names and must keep doing so: `ServiceA depends_on ServiceB` IS the
 * edge's content. There is nothing else to embed. A memory's fact stands on its own; an edge without its
 * endpoints is a label.
 *
 * ## What this gate is for
 *
 * The parameter is gone from both builders, so a caller cannot pass names by accident — but a future change
 * could reintroduce the prepend under another name, and the loss would show up only as a slightly worse recall
 * score that nobody attributes to it. So this asserts the SHAPE: the two builders take no names, and neither
 * writer resolves any for them.
 *
 * Run: node --test testing/standalone/entity-names-are-not-in-the-embed-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const BUILDERS = 'server/src/brain/embed-text.ts';

describe('the two builders take no entity names', () => {
  for (const fn of ['factEmbedText', 'fileEmbedText']) {
    it(`${fn} has no entityNames parameter`, () => {
      const s = src(BUILDERS);
      const at = s.indexOf(`export function ${fn}(`);
      assert.ok(at > 0, `${fn} is gone — re-anchor this gate`);
      const params = s.slice(at, s.indexOf('): string', at));
      assert.doesNotMatch(params, /entityNames/,
        `${fn} still accepts entity names, so a caller can put the names of linked records into a record's own `
        + 'embedding — measured at 1.5 points of strict evidence recall');
    });

    it(`${fn} does not join names into its parts`, () => {
      // The parameter going away is not enough on its own: the same prepend could be rebuilt from anything the
      // function receives. This asserts the body, which is where the dilution actually happened.
      assert.doesNotMatch(bodyOf(src(BUILDERS), fn), /entityNames/,
        `${fn} still folds entity names into the text it returns`);
    });
  }

  it('but an EDGE still embeds its endpoint names, because that is its content', () => {
    /*
     * The control. `ServiceA depends_on ServiceB` is the whole of what an edge says — remove the names and the
     * record embeds a bare label. A gate that only forbade names everywhere would take this with it.
     */
    /*
     * Asserted on `parts.push(from, label, to)` rather than on a parameter called `fromName`. The first draft
     * looked for that name and failed on correct code — `edgeEmbedText` takes `from`/`to`, and its CALLERS
     * resolve the ids to names before handing them over. A control that fails on the untouched case cannot
     * tell me the gate is scoped right, which is the whole reason it is here.
     */
    const body = bodyOf(src(BUILDERS), 'edgeEmbedText');
    assert.match(body, /parts\.push\(from, label, to\)/,
      'edgeEmbedText no longer embeds its endpoints, which leaves an edge with nothing but a label');
    /*
     * `resolveEdgeEntityNames` until 3.7, when an endpoint stopped having to be an entity. The name was the
     * whole problem: it described the FIRST kind of endpoint rather than the job, so the three vector-writing
     * paths and the one read path each resolved both ends in the entities collection. The function now takes
     * each endpoint's kind and resolves it where that kind lives.
     */
    assert.match(src('server/src/brain/edges.ts'), /resolveEdgeEndpointNames/,
      'nothing resolves an edge\'s endpoints to names any more, so it embeds raw ids');
  });
});

describe('and no writer resolves names for them', () => {
  it('the memory write path resolves none', () => {
    assert.doesNotMatch(bodyOf(src('server/src/brain/fact.ts'), 'saveFact'), /resolveEntityNames/,
      'the memory writer still resolves linked entity names — a round-trip whose only consumer is gone');
  });

  it('the shared embed-text derivation resolves none for memory or file', () => {
    /*
     * `embed-record.ts` is what the queue and the re-embed job both call, so a name resolved here reaches the
     * stored vector by a different route than the writer does. It had one helper serving exactly these two
     * types, which is why the helper goes rather than just its call sites.
     */
    assert.doesNotMatch(src('server/src/brain/embed-record.ts'), /entityNames/,
      'embed-record still resolves entity names; the two types that used them no longer take them');
  });

  it('the reindex job resolves none for memory or file', () => {
    // The third path to a stored vector, and the one that has drifted from the other two before: it used to
    // embed raw entity IDs for edges and drop properties entirely.
    const s = src('server/src/brain/reindex.ts');
    for (const call of ['factEmbedText', 'fileEmbedText']) {
      const at = s.indexOf(`${call}(`);
      assert.ok(at > 0, `reindex no longer calls ${call} — re-anchor this gate`);
      const args = s.slice(at, s.indexOf(')', at));
      assert.doesNotMatch(args, /entityNames|entityDocs/,
        `reindex still passes entity names to ${call}, so a reindexed record embeds different text from a `
        + 'freshly written one');
    }
  });
});
