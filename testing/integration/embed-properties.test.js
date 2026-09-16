/**
 * Integration tests: property KEYS are embedded for semantic recall (B4).
 *
 * Previously the embedded text either dropped property keys (memory/entity) or omitted
 * properties entirely (edge/chrono), so recall couldn't match on a property name and
 * values lost their field context. All builders now fold `key value` pairs into the
 * embedded text via the shared propsEmbedText helper.
 *
 * These tests assert the stored embedding text (`matchedText`, read back from the RECORD — see the helper
 * below for why not from recall) contains the property KEY for a memory, an entity, an edge, and a chrono
 * entry — the edge
 * and chrono cases embedded no property data at all before the original fix, and the REST
 * memory-create path had *regressed* to values-only (it inlined its own embed-text derivation
 * instead of calling the shared `saveFact()` — fixed by routing it through the shared function).
 *
 * Run: node --test testing/integration/embed-properties.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `b4-embed-props-${RUN}`;

let token;
let embeddingAvailable = false;

/**
 * Poll the RECORD by id until its `matchedText` is populated, then return it.
 *
 * ## Why this does not use recall, having previously used it
 *
 * These tests assert one thing: that a property KEY reaches the stored embed text. `matchedText` lives on the
 * document, written by the embed job moments after the write. Recall was never necessary to see it — it was
 * incidental, and it was the only reason this suite was flaky.
 *
 * The old helper polled `POST /recall` for **30 seconds** waiting for the record to become findable. Recall
 * reads the **eventually-consistent vector index**, and the worst case for that lag was MEASURED by an
 * operator at **150 seconds** (tracked separately: `recall` cannot see a record written two minutes ago). So
 * the deadline was five times too short and the suite failed whenever the index was slow — four times in one
 * evening, twice on `main` where no PR was in flight, each time reading like a mysterious infrastructure
 * flake on a diff that could not touch it.
 *
 * **Raising the timeout was the tempting fix and the wrong one:** it would trade a flaky test for a
 * two-and-a-half-minute one, and it would still be measuring index latency rather than the thing under test.
 * Reading the document waits only for the embed job — about a second — and it cannot be affected by index lag
 * at all.
 *
 * The `matchedText != null` condition matters: an immediate read can arrive before the embed job has run, and
 * asserting on an absent value would turn this back into a race with a different clock.
 */
const COLLECTION_PATH = { fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono' };

async function embedTextOf(kind, id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let polls = 0;
  while (Date.now() < deadline) {
    const r = await get(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/${COLLECTION_PATH[kind]}/${id}`);
    polls++;
    last = r;
    if (r.status === 200 && r.body?.matchedText != null) return r.body;
    await new Promise(res => setTimeout(res, 250));
  }
  // Carry the reason out with the failure. A bare `null` cannot tell "the record was never written" from
  // "the record is there and the embed job never ran" from "the read itself was failing" — and those have
  // three different causes. This timed out once on 2026-08-08 (edge only, three siblings green in ~0.5 s)
  // and the log said nothing beyond the assertion message, so the diagnosis had to be reconstructed from
  // the outside. Whatever the next occurrence is, it should be readable from the failure itself.
  lastProbe = `after ${polls} polls over ${timeoutMs}ms: HTTP ${last?.status}, `
    + `record ${last?.status === 200 ? 'EXISTS' : 'NOT READABLE'}, `
    + `matchedText ${last?.body?.matchedText === undefined ? 'absent' : JSON.stringify(last?.body?.matchedText)}`;
  return null;
}

/** Set by the last `embedTextOf` that timed out, so the assertion can say why rather than just "falsy". */
let lastProbe = '(no probe recorded)';

describe('Property keys are embedded (B4)', () => {
  before(async () => {
    token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const c = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: 'B4 Embed Props', meta: { strictLinkage: false } });
    assert.ok([201, 409].includes(c.status), `create space: ${JSON.stringify(c.body)}`);
    // Probe whether embeddings are available in this stack.
    const probe = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`,
      { name: `__probe-${RUN}__`, type: 'probe', properties: { probe: 'yes' } });
    embeddingAvailable = probe.status === 201;
  });

  after(async () => {
    await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  it('memory embedding text includes the property key (REST create, via shared saveFact())', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/facts`,
      { fact: `MemPropKey-${RUN}`, properties: { occupation: 'pilot' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // saveFact() stores matchedText on the doc, so the create response now exposes it directly —
    // before the fix the REST create set no matchedText and embedded values only ("pilot").
    assert.match(r.body.matchedText ?? '', /occupation pilot/,
      `memory create must fold "key value" into matchedText: ${r.body.matchedText}`);
    const hit = await embedTextOf('fact', r.body._id);
    assert.ok(hit, `memory should have its embed text stored — ${lastProbe}`);
    assert.match(hit.matchedText ?? '', /occupation/,
      `memory embed text must include the property key: ${hit.matchedText}`);
  });

  it('entity embedding text includes the property key', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`,
      { name: `EntPropKey-${RUN}`, type: 'concept', properties: { occupation: 'engineer' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const hit = await embedTextOf('entity', r.body._id);
    assert.ok(hit, `entity should have its embed text stored — ${lastProbe}`);
    assert.match(hit.matchedText ?? '', /occupation/,
      `entity embed text must include the property key: ${hit.matchedText}`);
  });

  it('chrono embedding text includes the property key (previously omitted entirely)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/chrono`, {
      title: `ChronoPropKey-${RUN}`, type: 'event', startsAt: new Date(RUN).toISOString(),
      properties: { venue: 'stadium' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const hit = await embedTextOf('chrono', r.body._id);
    assert.ok(hit, `chrono should have its embed text stored — ${lastProbe}`);
    assert.match(hit.matchedText ?? '', /venue/,
      `chrono embed text must include the property key: ${hit.matchedText}`);
  });

  /**
   * ## Why this one drains its prerequisites first, and the two occurrences that led here
   *
   * This is the only case in the file that must CREATE records before its own. An edge needs two entities, so
   * by the time it is enqueued there are two entity embed jobs ahead of it — plus everything the three earlier
   * cases left in the queue. `workerConcurrency` defaults to 2, so the edge is structurally the last job behind
   * the most work, every run.
   *
   * That made it the only case whose 30 s budget was mostly spent on OTHER records' embeddings. It timed out on
   * 2026-08-08 with its three siblings green in ~0.5 s, and again on 2026-08-28 — same shape both times, and the
   * instrumentation added after the first occurrence is what identified it:
   *
   *     after 118 polls over 30000ms: HTTP 200, record EXISTS, matchedText absent
   *
   * `record EXISTS` with `matchedText absent` is the queue not having reached it — not a write that failed and
   * not a read that failed. The enqueue path is symmetric with `entities.ts`, so there is nothing edge-specific
   * about the product here; what is edge-specific is the position in the queue.
   *
   * **So the prerequisites are awaited on their OWN budget, and the edge gets its full 30 s for its own job.**
   * That is a smaller and more honest change than raising the timeout: a bigger number would have hidden the
   * same pile-up until the runner was slower still, and it would have made every future failure here ambiguous
   * between "slow queue" and "broken edge embedding". The subject of this test is the edge's embed TEXT, not the
   * queue's throughput.
   */
  it('edge embedding text includes the property key (previously omitted entirely)', async (t) => {
    if (!embeddingAvailable) return t.skip('Embedding not available');
    const from = `EdgeFrom-${RUN}`;
    const to = `EdgeTo-${RUN}`;
    const a = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: from, type: 'concept' });
    const b = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`, { name: to, type: 'concept' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));

    // Drain the two endpoint embeds on their own budget, so the edge's window covers the edge's job alone.
    // Asserted rather than awaited-and-ignored: if an ENTITY embed is what is broken, this says so here instead
    // of surfacing as a mysterious edge timeout thirty seconds later.
    for (const [label, created] of [['from', a], ['to', b]]) {
      assert.ok(await embedTextOf('entity', created.body._id),
        `the edge's ${label} endpoint never embedded, so the edge could not be reached — ${lastProbe}`);
    }

    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/edges`, {
      from, to, label: `edgePropKey${RUN}`, properties: { medium: 'email' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const hit = await embedTextOf('edge', r.body._id);
    assert.ok(hit, `edge should have its embed text stored — ${lastProbe}`);
    assert.match(hit.matchedText ?? '', /medium/,
      `edge embed text must include the property key: ${hit.matchedText}`);
  });
});
