/**
 * What `embed()` hands the inference host, and what it keeps of the answer.
 *
 * ## What is pinned (Q-99 part 1)
 *
 * `embed()` used to load the model and run it. It now asks a host running another process, and three decisions
 * that used to be implicit in one function have to stay true across the boundary:
 *
 *  - **The string embedded is the PREPARED one**, prefixed on the main side, once (`embedding-prefix.test.js`
 *    keeps the source-level half; this is the behavioural half). A child that applied the prefix itself would make
 *    the same text embed differently depending on where it ran.
 *  - **A vector is stamped with the model its child ECHOED**, never the `cfg.model` read before the request. The
 *    config can change while a request is queued, and `embed-record.ts` uses the stamp as its "unchanged"
 *    fingerprint: a vector computed by model A and stamped B is one the system will never recompute.
 *  - **`ythril_embedding_duration_seconds` means one embedding**, fed from the child's own `inferenceMs`. Measured
 *    around the round trip it would absorb the wait behind other requests, and a busy queue would read as a slow
 *    model. The wait is its own metric.
 *
 * Also: the query lane for a query, the long-input warning staying on the main side, and `warmEmbeddingModel`
 * going through the host.
 *
 * Run: node --test testing/standalone/embed-calls-the-inference-host.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScriptedHost, gate } from './_scripted-inference-host.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-embed-host-'));
process.env.CONFIG_PATH = path.join(tmp, 'config.json');
const saved = {};
for (const k of ['EMBEDDING_MODEL', 'EMBEDDING_URL', 'EMBEDDING_PROVIDER', 'EMBEDDING_PREFIX_SCHEME']) saved[k] = process.env[k];
for (const k of Object.keys(saved)) delete process.env[k];

let embedding, local, loader, register, getLogLines;
let host;

before(async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ spaces: [], networks: [], tokens: [] }));
  loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  embedding = await import('../../server/dist/brain/embedding.js');
  local = await import('../../server/dist/brain/local-inference.js');
  ({ register } = await import('../../server/dist/metrics/registry.js'));
  ({ getLogLines } = await import('../../server/dist/util/log.js'));
});

after(() => {
  local?._setLocalInferenceForTests?.(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  host = createScriptedHost();
  local._setLocalInferenceForTests(host);
});

async function histogramSum() {
  const { values } = await register.getSingleMetric('ythril_embedding_duration_seconds').get();
  return values.find(v => v.metricName === 'ythril_embedding_duration_seconds_sum')?.value ?? 0;
}

describe('embed() over the inference host', () => {
  it('sends the PREPARED input: the task prefix is applied here, once, before the child sees the text', async () => {
    await embedding.embed('hello', 'document');
    await embedding.embed('hello', 'query');
    assert.deepEqual(host.calls.map(c => c.input), ['search_document: hello', 'search_query: hello']);
  });

  it('puts a query on the query lane and everything else on the document lane', async () => {
    await embedding.embed('a', 'query');
    await embedding.embed('b', 'document');
    await embedding.embed('c');
    assert.deepEqual(host.calls.map(c => c.lane), ['query', 'document', 'document']);
  });

  it('names the configured model in the request', async () => {
    await embedding.embed('a');
    assert.equal(host.calls[0].modelId, loader.getEmbeddingConfig().model);
  });

  it('stamps the vector with the model the child ECHOED, not the one it was asked for', async () => {
    host.behaviour = async () => ({ vector: [0.1, 0.2, 0.3], modelId: 'echoed/actual-model', inferenceMs: 3 });
    const r = await embedding.embed('a');
    assert.equal(r.model, 'echoed/actual-model',
      'a vector must carry the model that computed it; embed-record.ts treats the stamp as the fingerprint');
    assert.notEqual(r.model, loader.getEmbeddingConfig().model);
    assert.deepEqual(r.vector, [0.1, 0.2, 0.3]);
    assert.equal(r.dimensions, 3, 'the dimension is the vector\'s own, as before');
  });

  it('records the histogram from the child\'s inferenceMs, not from how long the caller waited', async () => {
    host.behaviour = async () => {
      await new Promise(r => setTimeout(r, 200));      // the caller waits 200 ms...
      return { vector: [0.5, 0.5], modelId: 'm', inferenceMs: 7 };   // ...for an inference the child timed at 7
    };
    const before = await histogramSum();
    await embedding.embed('a');
    const added = (await histogramSum()) - before;
    assert.ok(Math.abs(added - 0.007) < 0.0005,
      `the duration histogram grew by ${added} s; it must grow by the child's 0.007 s, not by the 0.2 s round trip`);
  });

  it('warns about a long input on the main side, before the request leaves', async () => {
    const order = [];
    host.behaviour = async () => { order.push('request'); return { vector: [1], modelId: 'm', inferenceMs: 1 }; };
    await embedding.embed('x'.repeat(9_000));
    const warned = getLogLines(200).some(l => /Embedding input is \d+ chars/.test(l));
    assert.ok(warned, 'the long-input warning is part of embed(), wherever the model runs');
    assert.deepEqual(order, ['request']);
  });

  it('passes a failure from the host through with its message intact', async () => {
    host.behaviour = async () => { throw new Error('the model says no'); };
    await assert.rejects(embedding.embed('a'), /the model says no/);
  });

  it('warmEmbeddingModel warms the configured model through the host', async () => {
    await embedding.warmEmbeddingModel();
    assert.deepEqual(host.warms, [{ modelId: loader.getEmbeddingConfig().model }]);
  });

  it('keeps the queue-depth gauge balanced however the request ends', async () => {
    const depth = async () => (await register.getSingleMetric('ythril_embedding_queue_depth').get()).values[0].value;
    const before = await depth();
    const g = gate();
    host.behaviour = async () => { await g.promise; throw new Error('late failure'); };
    const p = embedding.embed('a').catch(() => {});
    await new Promise(r => setImmediate(r));
    assert.equal(await depth(), before + 1, 'counted while it is waiting');
    g.open();
    await p;
    assert.equal(await depth(), before);
  });
});

describe('an external endpoint does not touch the inference host', () => {
  it('embed() over HTTP never calls it, and warmEmbeddingModel is a no-op', async () => {
    const { getConfig } = loader;
    const before = getConfig().embedding;
    getConfig().embedding = { ...(before ?? {}), baseUrl: 'http://127.0.0.1:9/' };
    try {
      await embedding.warmEmbeddingModel();
      await assert.rejects(embedding.embed('a'), /Could not reach embedding endpoint/);
      assert.deepEqual(host.calls, []);
      assert.deepEqual(host.warms, []);
    } finally {
      getConfig().embedding = before;
    }
  });
});
