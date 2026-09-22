/**
 * Integration: `traverse` follows an edge whose endpoint is NOT an entity.
 *
 * ## The defect, and why it is a dead record rather than a refusal
 *
 * An edge may declare `fromKind`/`toKind` of `entity`, `fact`, `chrono` or `file`. The product documents
 * that — `edgeEndpointKindSchema` says *"Set it to link a fact, a chrono entry or a file"* — and since
 * `#1126` a kind that does not match the record is REFUSED at the write. So a fact→fact `supersedes` edge
 * is accepted, validated, stored, hashed and replicated.
 *
 * **And nothing reads it.** The walk resolves every neighbour id against the `entities` collection alone
 * (`entityMap.get(neighborId)`, then `if (!entity) continue`), so a neighbour that is a fact resolves to
 * nothing and is dropped without a word. Measured 2026-09-18 against a live instance while settling `B-5`:
 * the edge came back `201` with `fromKind: fact, toKind: fact`, and the walk did not return it. Controlled
 * against an entity→entity edge in the same space, which it did.
 *
 * That is report `#695`'s *"a link that is stored, returned, and points at nothing traversable"* arriving
 * by a different route, and it is why `api/contradictions.ts` still refuses to draw a `supersedes` edge for
 * a non-entity pair — a refusal written in `#713`, a month before endpoint kinds existed, whose stated
 * reason is obsolete and whose EFFECT was still correct.
 *
 * ## Why an explicit edge is followed unconditionally
 *
 * `includeMemories` and `includeFiles` default OFF because a fact-heavy space would fill the answer with
 * facts nobody traversed for — that is an argument about IMPLICIT links, of which a hub entity has
 * thousands. An edge document exists only because somebody drew it, so there are exactly as many as were
 * meant, and gating them behind a flag would leave the same capability inert for anyone who does not
 * already know the answer.
 *
 * ## What the control is for
 *
 * Four earlier probe iterations of this question all read as "not traversable" and were, in turn: a missing
 * `includeMemories`, a parameter named `depth` instead of `maxDepth`, a fixture write that never happened,
 * and a boolean over a serialised blob. A failed call and a negative answer are the same shape at the end
 * of a script. Every fixture here is asserted, and every case has a positive control in the same space.
 *
 * ## BOTH walks, because there are two
 *
 * `traverseGraph` and `recall`'s seed expansion are separate BFS implementations and each held the same
 * `entityMap.get(id)` line. `recall-seed-traversal.ts` already carries the scar of the last divergence:
 * *"One rule, two implementations, and the one reachable from a search had the weaker."* A test covering
 * only the standalone tool would have had a title claiming the walk and a body checking one of them, which
 * is this repo's most-repeated gate failure.
 *
 * It also keeps `graph_traverse`'s own description true — it tells a caller that *"the difference between
 * the two tools is the default, not the capability."*
 *
 * Run: node --test testing/integration/traverse-follows-an-edge-it-accepted.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `traverse-edge-kinds-${RUN}`;

let tokenA;
const ids = {};
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);
const traverse = (body) => P(`/api/brain/spaces/${SPACE}/traverse`, body);

/** Every fixture write is asserted — a failed setup and a negative result look identical otherwise. */
function must(label, res, pick = (b) => b?._id) {
  const id = pick(res.body);
  assert.ok(res.status < 400 && id, `fixture '${label}' failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

/** The ids a walk returned, so an assertion names the identity rather than testing a substring of a blob. */
const nodeIds = (res) => (res.body?.nodes ?? []).map(n => n._id);
const nodeFor = (res, id) => (res.body?.nodes ?? []).find(n => n._id === id);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Traverse edge kinds ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  ids.person = must('person', await P(`/api/brain/spaces/${SPACE}/entities`,
    { name: `Ada ${RUN}`, type: 'person' }));

  // The knowledge-updates shape: a claim that replaced an earlier one, both about the same person.
  /*
   * `linkEntities`, and the note it replaces is worth keeping because the failure was invisible.
   *
   * While a link had two shapes, this had to be `entityIds`: on a space created since the last boot
   * `linkEntities` wrote a link RECORD, readers read the ARRAY, and the link was accepted with a `201`
   * and seen by nothing — so the fixture passed its own assertion and failed the transitive case for a
   * reason that had nothing to do with traversal. 5.0 removed the arrays, so there is one shape and one
   * spelling, and the old one is refused.
   */
  ids.older = must('older fact', await P(`/api/brain/spaces/${SPACE}/facts`,
    { fact: `Ada works at Acme ${RUN}`, linkEntities: [ids.person] }));
  ids.newer = must('newer fact', await P(`/api/brain/spaces/${SPACE}/facts`,
    { fact: `Ada works at Beta ${RUN}`, linkEntities: [ids.person] }));
  ids.supersedes = must('fact->fact supersedes edge', await P(`/api/brain/spaces/${SPACE}/edges`,
    { from: ids.newer, to: ids.older, label: 'supersedes', fromKind: 'fact', toKind: 'fact' }));

  // A chrono endpoint too, so the rule under test is "a non-entity endpoint" and not "a fact".
  ids.chrono = must('chrono', await P(`/api/brain/spaces/${SPACE}/chrono`,
    { title: `Left Acme ${RUN}`, type: 'event', startsAt: '2026-08-01T09:00:00.000Z' }));
  ids.caused = must('fact->chrono edge', await P(`/api/brain/spaces/${SPACE}/edges`,
    { from: ids.newer, to: ids.chrono, label: 'relates_to', fromKind: 'fact', toKind: 'chrono' }));

  // THE CONTROL: an ordinary entity→entity edge in the same space, walked by the same call.
  ids.company = must('company', await P(`/api/brain/spaces/${SPACE}/entities`,
    { name: `Beta ${RUN}`, type: 'company' }));
  ids.worksAt = must('entity->entity edge', await P(`/api/brain/spaces/${SPACE}/edges`,
    { from: ids.person, to: ids.company, label: 'works_at' }));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('an edge the write accepted is an edge the walk follows', () => {
  it('the control walks: an entity→entity edge is returned', async () => {
    // First, so a failure below cannot be read as "the walk is broken" or "the space is empty".
    const res = await traverse({ startId: ids.person, maxDepth: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(nodeIds(res).includes(ids.company),
      `the control edge was not walked either — the fixture or the walk is broken, not the feature. `
      + `nodes: ${JSON.stringify(nodeIds(res))}`);
  });

  it('a fact→fact edge is walked, and the node says which collection it is in', async () => {
    const res = await traverse({ startId: ids.newer, maxDepth: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(nodeIds(res).includes(ids.older),
      `the superseded fact was not reached through an edge the write ACCEPTED, so the edge is stored and `
      + `read by nothing. nodes: ${JSON.stringify(nodeIds(res))}`);
    // `kind` is not decoration: a caller holding an `_id` needs to know which collection to look in, and
    // guessing from `type` does not work — a fact's `type` is optional entirely.
    assert.equal(nodeFor(res, ids.older)?.kind, 'fact',
      'a non-entity node must name its collection');
  });

  it('a fact→chrono edge is walked too, so the rule is the KIND and not the fact', async () => {
    // Asserting the rule rather than the site: a case naming one kind survives nobody adding the next.
    const res = await traverse({ startId: ids.newer, maxDepth: 1 });
    assert.ok(nodeIds(res).includes(ids.chrono),
      `a chrono endpoint is accepted by the same writer and must be walked by the same walk. `
      + `nodes: ${JSON.stringify(nodeIds(res))}`);
    assert.equal(nodeFor(res, ids.chrono)?.kind, 'chrono');
  });

  it('the edge itself comes back, so a caller can see WHY the node is there', async () => {
    const res = await traverse({ startId: ids.newer, maxDepth: 1 });
    const labels = (res.body?.edges ?? []).filter(e => e.to === ids.older).map(e => e.label);
    assert.deepEqual(labels, ['supersedes'],
      `the walk must report the edge it followed, not just the node it landed on: `
      + `${JSON.stringify(res.body?.edges)}`);
  });

  it('it is reachable TRANSITIVELY, which is the case the benchmark needs', async () => {
    // Entity → (link) → the newer fact → (explicit edge) → the older one. This is what "a memory that can
    // retire a fact" costs a caller today: the two claims are equally live and nothing joins them.
    const res = await traverse({ startId: ids.person, maxDepth: 3, includeMemories: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const got = nodeIds(res);
    assert.ok(got.includes(ids.newer), `the linked fact must be reached first: ${JSON.stringify(got)}`);
    assert.ok(got.includes(ids.older),
      `the superseded claim must be reachable from the person through the newer claim — this is the whole `
      + `knowledge-updates path. nodes: ${JSON.stringify(got)}`);
  });

  it('the RECALL expansion follows it too, which is the second implementation', async () => {
    // The tool description promises the two walks differ in their DEFAULTS and not in what they can reach.
    // Fixing one and not the other would make that sentence false and leave the weaker one on the path a
    // search reaches, which is how this file's sibling defect was introduced in the first place.
    /*
     * `topK: 1`, AND THAT IS NOT A PERFORMANCE CHOICE.
     *
     * A walk skips an edge whose BOTH ends are already in the frontier — a same-level connection
     * introduces no new node. Every seed is in the frontier, so in a small space where the query matches
     * both claims, the superseded one arrives as its own MATCH and is never reached as a neighbour. The
     * first version of this case asked for ten and read the empty graph as "recall does not follow the
     * edge", which cost a diagnosis against three probes before the control gave it away.
     *
     * A FILTER pins which record that one seed is. `topK: 1` alone takes whatever ranked first, which is
     * a property of the embedding model and not of this test — the superseded claim and the person both
     * matched a query about either of them. Pinning the seed by id makes the case about the walk.
     */
    const r = await post(INSTANCES.a, tokenA, '/api/brain/recall', {
      space: SPACE, query: `Ada works at Beta ${RUN}`, traverse: 2, topK: 1,
      filter: { _id: ids.newer },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const hits = r.body?.results ?? [];

    /*
     * THE SEED IS ASSERTED BY IDENTITY, not taken on trust from the ranking.
     *
     * The first version walked every hit's graph and passed judgement on the union. The top hit was the
     * COMPANY entity, whose name is a substring of the fact, so the walk under test never ran and the
     * failure read as "recall does not follow the edge". A search result is not a fixture.
     */
    const seed = hits.find(h => (h.record?._id ?? h._id) === ids.newer);
    assert.ok(seed, `the newer fact must be among the matches or this case measures nothing. `
      + `got: ${JSON.stringify(hits.map(h => h.record?._id ?? h._id))}`);

    const flat = [];
    const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n._graph); } };
    walk(seed._graph);
    const reached = flat.map(n => n.node?._id);
    assert.ok(reached.includes(ids.older),
      `recall's expansion dropped the superseded claim that the standalone walk returns — one rule, two `
      + `implementations. reached: ${JSON.stringify(reached)}`);
    const node = flat.find(n => n.node?._id === ids.older)?.node;
    assert.equal(node?.kind, 'fact', 'and it must say which collection it lives in, as the other walk does');
  });

  it('an explicit edge needs no include flag, unlike an implicit link', async () => {
    // `includeMemories` governs the fact-to-entity LINK scan, whose cost argument is thousands of implicit
    // mentions. An edge document exists only because somebody drew it, so there are exactly as many as
    // were meant — gating it would leave the capability inert for anyone who does not know the flag.
    const res = await traverse({ startId: ids.newer, maxDepth: 1, includeMemories: false });
    assert.ok(nodeIds(res).includes(ids.older),
      `an explicit edge must be followed with every include flag off: ${JSON.stringify(nodeIds(res))}`);
  });
});
