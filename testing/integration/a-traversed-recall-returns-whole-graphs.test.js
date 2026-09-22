/**
 * A budgeted recall WITH TRAVERSE returns whole records carrying whole graphs — or fewer matches.
 *
 * ## Why this is the test that matters now
 *
 * Owner, 2026-09-04, ruling on `P-34`: *"why do we need a cap? Only thing that matters is we only get full
 * records and it warns when anything is truncated"*, and then: *"test on recalls with traverse to make sure
 * only full records with full graph are returned"*.
 *
 * `topK` has no ceiling on either door as of that ruling. What keeps an unbounded request safe is the byte
 * budget, and the budget's promise is not "a smaller answer" — it is that **a match is counted together with
 * its entire `_graph` subtree**, so a match whose subtree does not fit is ABSENT rather than shortened. That
 * promise is what the removed cap was standing in for, and nothing exercised it end to end.
 *
 * `result-spill-both-doors.test.js` proves the budget bites and that paging reaches every record — with
 * `traverse` at its default of 0, where a match has no subtree to lose. `expansion-costs-matches-and-says-so`
 * proves every place that states the guarantee also states its price. Neither one takes a traversed answer
 * apart and checks that the graphs inside it are complete.
 *
 * ## How completeness is decided
 *
 * Against the SAME QUESTION asked without a budget, which is the only honest reference: for every record the
 * tight answer returned, its `_graph` must be identical to that record's `_graph` in the unbudgeted answer.
 * A subtree that was trimmed to make a match fit shows up as a difference; a match dropped whole does not
 * appear at all, which is the documented behaviour rather than a defect.
 *
 * Comparing against a COUNT would not work — the number of nodes one hop away is a fact about the data, and
 * a test asserting it would fail the day somebody adds an edge to the fixture.
 *
 * Run: node --test testing/integration/a-traversed-recall-returns-whole-graphs.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, waitForIndexed } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `traverse-whole-${RUN}`;
const QUERY = 'vault credential rotation service';

/** Hubs, each with spokes pointing at it — so a match has a subtree worth losing. */
const HUBS = 12;
const SPOKES_PER_HUB = 4;

let token;
let hubIds = [];
let tightChars = 0;

/*
 * It carried `includeFreshWrites: true`, and 5.0 removed that parameter — so EVERY recall in this
 * file answered 400 and every case skipped, quietly, for as long as 5.0 has existed. The scan it
 * asked for is unconditional now; what replaces it is `waitForIndexed` in `before`, because this
 * file's subject is the vector path and the scan never covered that.
 */
const recall = (body) => post(INSTANCES.a, token, '/api/brain/recall', { space: SPACE, ...body });

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `Traverse whole ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  /*
   * A hub matches the query; its spokes do not, and reach the answer only through the walk. So a hub's
   * `_graph` is the thing the budget has to keep whole or drop entirely.
   */
  for (let h = 0; h < HUBS; h++) {
    const hub = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
      name: `vault-credential-service-${h}-${RUN}`,
      type: 'service',
      description: `Vault credential rotation service number ${h}, scoping authentication tokens`,
      tags: [], properties: {},
    });
    if (hub.status !== 201) break;
    const hubId = hub.body._id ?? hub.body.id;
    hubIds.push(hubId);

    for (let sp = 0; sp < SPOKES_PER_HUB; sp++) {
      const spoke = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, {
        name: `operator-${h}-${sp}-${RUN}`,
        type: 'person',
        description: `An operator who administers something, with enough prose on the record that a subtree `
          + `costs real bytes rather than a handful — ${'detail '.repeat(12)}`,
        tags: [], properties: {},
      });
      if (spoke.status !== 201) continue;
      await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges`, {
        from: hubId, to: spoke.body._id ?? spoke.body.id, label: 'administered_by',
        fromKind: 'entity', toKind: 'entity',
      });
    }
  }

  // The hubs have to be IN THE VECTOR INDEX before anything is measured. Recall's fresh-write scan
  // covers a record whose embedding is still pending, and this file's whole subject is what
  // `$vectorSearch` returns — so the window between the embed job finishing and the index holding
  // the vector is exactly where this fixture used to land.
  if (hubIds.length > 0) await waitForIndexed(INSTANCES.a, token, SPACE, hubIds, ['entity']);

  // Measure the full traversed answer, then take 40% of it — low enough to bite hard, high enough that more
  // than one match still fits.
  const full = await recall({ query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: 5_000_000 });
  /*
   * A REFUSED recall is not a fixture problem, and telling them apart is the point of this line.
   * `ready()` below skips when `tightChars` is 0, which is right for "the writes did not land"
   * and wrong for "the request was rejected" — the 400 that `includeFreshWrites` earned reached
   * exactly here, became a skip, and read as a fixture that could not be built.
   */
  assert.equal(full.status, 200,
    `the measuring recall was refused rather than answered — this is not index lag: `
    + JSON.stringify(full.body).slice(0, 300));
  if (full.body.truncated === false) {
    tightChars = Math.max(1_000, Math.floor(full.body.charsReturned * 0.4));
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

/** The fixture has to be real before anything is concluded from it. */
function ready(t) {
  if (hubIds.length < HUBS) { t.skip(`seeded ${hubIds.length}/${HUBS} hubs — writes unavailable`); return false; }
  if (tightChars === 0) { t.skip('could not measure the full traversed answer'); return false; }
  return true;
}

/** Every match keyed by id, with its graph, from one response. */
const graphsOf = (body) => new Map(
  (body.results ?? []).map(r => [r._id, JSON.stringify(r._graph ?? null)]),
);

describe('a traversed recall keeps every graph whole', () => {
  it('the walk actually reached something, or this proves nothing', async (t) => {
    if (!ready(t)) return;
    const r = await recall({ query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: 5_000_000 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.ok(r.body.graphNodes > 0, `the traversal reached ${r.body.graphNodes} nodes — the fixture has no edges`);
    const withGraph = (r.body.results ?? []).filter(x => Array.isArray(x._graph) && x._graph.length > 0);
    assert.ok(withGraph.length >= 2,
      `only ${withGraph.length} matches carry a subtree, so a budget cannot be shown to preserve one`);
  });

  it('a TIGHT budget drops whole matches and never trims a graph', async (t) => {
    if (!ready(t)) return;

    const reference = await recall({
      query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: 5_000_000,
    });
    assert.equal(reference.body.truncated, false, 'the reference answer must not itself truncate');
    const whole = graphsOf(reference.body);

    const tight = await recall({ query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: tightChars });
    assert.equal(tight.status, 200, JSON.stringify(tight.body).slice(0, 300));
    assert.equal(tight.body.truncated, true, `the budget must bite at ${tightChars} chars or this proves nothing`);
    assert.ok(tight.body.results.length < reference.body.results.length,
      'a truncated answer must hold fewer matches than the full one');

    /*
     * THE ASSERTION THE OWNER ASKED FOR. Every match that survived carries exactly the subtree it has in the
     * unbudgeted answer — not a shortened one. A trimmed `_graph` is the failure this forbids: a caller
     * cannot tell a record with two relationships from one whose other three were dropped to fit.
     */
    for (const [id, graph] of graphsOf(tight.body)) {
      assert.ok(whole.has(id), `the tight answer returned ${id}, which the full answer did not`);
      assert.equal(graph, whole.get(id),
        `the graph on ${id} differs from its unbudgeted form — a subtree was trimmed to make the match fit, `
        + 'and the budget must drop the whole match instead');
    }
  });

  it('and the record bodies are whole too, not only their graphs', async (t) => {
    if (!ready(t)) return;
    const reference = await recall({
      query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: 5_000_000,
    });
    const byId = new Map((reference.body.results ?? []).map(r => [r._id, r]));
    const tight = await recall({ query: QUERY, types: ['entity'], topK: HUBS, traverse: 1, maxChars: tightChars });

    for (const r of tight.body.results ?? []) {
      const full = byId.get(r._id);
      assert.ok(full, `unexpected record ${r._id}`);
      // Compared field by field rather than as one blob: the diagnostics are withheld by default and a
      // whole-object equality would fail on a field neither answer was asked for.
      for (const k of ['name', 'type', 'description', 'tags', 'properties']) {
        assert.deepEqual(r[k], full[k], `${k} on ${r._id} is not the value an unbudgeted call returns`);
      }
    }
  });

  it('an uncapped topK is not clamped, and says so when it truncates', async (t) => {
    if (!ready(t)) return;
    /*
     * `P-34`: neither door caps `topK` now. Asking for far more than exists must not be refused, must not be
     * silently rewritten, and must report what happened — which is the whole basis for having no cap.
     */
    const r = await recall({ query: QUERY, types: ['entity'], topK: 500, traverse: 1, maxChars: 5_000_000 });
    assert.equal(r.status, 200, `topK 500 must not be refused: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(typeof r.body.truncated, 'boolean', '`truncated` must be on every response');
    assert.ok(r.body.count >= r.body.returned, '`count` is the total, `returned` what came back');
    if (r.body.truncated) {
      assert.equal(typeof r.body.nextSkip, 'number', 'a truncated answer must say where to continue');
    }
  });
});
