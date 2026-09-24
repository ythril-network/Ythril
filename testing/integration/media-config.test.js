/**
 * Integration test: media/embedding provider config hot-reload (A6).
 *
 * The media worker used to read its provider config ONCE at worker start, so a
 * change made through PATCH /api/admin/media-config was invisible until the pod
 * restarted. The worker now re-reads the config on every tick and rebuilds its
 * provider bundle when the provider-relevant config actually changes.
 *
 * This asserts the change lands WITHOUT a restart: patch a provider field, then
 * wait for the worker to report that it reloaded its providers.
 *
 * Run: node --test testing/integration/media-config.test.js
 * Pre-requisite: test stack up + testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, patch, post, restoreOrFail, patchableDocumentProcessing } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tokenA;
let originalModel;

/**
 * Poll until the worker reports it is running the saved provider config.
 *
 * We deliberately do NOT scrape the server log ring buffer for this: the media
 * worker retries failing jobs and floods that buffer, so on a slow runner the
 * "providers reloaded" line gets pushed out of the window between polls — which
 * made this test flaky in CI. `providerReloadPending` is a direct read of the
 * worker's live state, so it cannot be raced or evicted.
 */
async function waitForWorkerToApplyConfig(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    if (r.status === 200 && r.body?.providerReloadPending === false) return true;
    await new Promise(res => setTimeout(res, 1000));
  }
  return false;
}

describe('Media config hot-reload (A6)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const cur = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(cur.status, 200, `read media-config: ${JSON.stringify(cur.body)}`);
    originalModel = cur.body?.vision?.model;
  });

  after(async () => {
    // Restore whatever the model was so we don't leak state into other suites.
    if (originalModel) {
      await restoreOrFail('vision.model',
        () => patch(INSTANCES.a, tokenA, '/api/admin/media-config', { vision: { model: originalModel } }),
        async () => (await get(INSTANCES.a, tokenA, '/api/admin/media-config')).body?.vision?.model === originalModel);
    }
  });

  it('a provider change is picked up by the worker without a restart', async () => {
    const probeModel = `hot-reload-probe-${Date.now()}`;
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config',
      { vision: { model: probeModel } });
    assert.equal(r.status, 200, `PATCH media-config failed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.config?.vision?.model, probeModel, 'PATCH should echo the new model');

    // A dedicated refresh timer (not the job loop) applies provider config, so the
    // change is picked up within a couple of seconds even when the worker is busy
    // processing a slow job. Allow generous headroom for a loaded CI runner anyway.
    const applied = await waitForWorkerToApplyConfig(60_000);
    assert.ok(
      applied,
      'The media worker never picked up the media-config change (providerReloadPending stayed true). ' +
      'Provider config is being cached at worker start again — it would now need a restart to take effect (A6 regression).',
    );

    // Re-read the persisted value: the PATCH echo alone is satisfied by a
    // handler that persists nothing (the worker flag only proves a reload ran).
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(reread.status, 200);
    assert.equal(reread.body?.vision?.model, probeModel, 'patched vision.model must round-trip through GET');
  });
});

// ── F11 — documentProcessing extraction config ───────────────────────────────

describe('Media config — documentProcessing (F11)', () => {
  let originalDp;
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    const cur = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    originalDp = cur.body?.documentProcessing;
  });
  after(async () => {
    // Restore to OCR so the (inert in this PR) mode doesn't leak into other suites.
    const want = originalDp ?? { mode: 'ocr' };
    // Filtered, and reports what it saw. This hook had the SAME defect as `vlm-extraction`'s — the GET's block
    // carries seven keys the `.strict()` patch schema refuses, so sending it back verbatim is a 400 and the
    // restore never lands. It was latent here rather than failing, because this suite's last write leaves the
    // mode where the restore wants it often enough. Without a `saw`, its failure would have said only
    // "verify still false".
    await restoreOrFail('documentProcessing',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config',
        { documentProcessing: patchableDocumentProcessing(want) }),
      async () => {
        const r = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
        const mode = r.body?.documentProcessing?.mode;
        return { ok: mode === want.mode, saw: { status: r.status, mode, wanted: want.mode } };
      });
  });

  it('accepts and round-trips a documentProcessing.mode change', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config',
      { documentProcessing: { mode: 'vlm', maxPages: 10, renderDpi: 200 } });
    assert.equal(r.status, 200, `PATCH failed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.config?.documentProcessing?.mode, 'vlm');
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(reread.body?.documentProcessing?.mode, 'vlm');
    assert.equal(reread.body?.documentProcessing?.maxPages, 10);
  });

  it('rejects an invalid mode', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config',
      { documentProcessing: { mode: 'magic' } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('rejects out-of-range knobs', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config',
      { documentProcessing: { renderDpi: 5000 } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

// ── F11-PR5b — test connection ────────────────────────────────────────────────

describe('Media config — test connection (F11-PR5b)', () => {
  before(async () => { tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });

  it('probes the vision endpoint and returns a structured result (up or down)', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/admin/media-config/test-connection', { target: 'vision' });
    // The probe target may be up or down in CI; either way the endpoint answers 200 with the result envelope.
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.target, 'vision');
    assert.equal(typeof r.body?.reachable, 'boolean');
    assert.equal(typeof r.body?.latencyMs, 'number');
  });

  it('rejects an unknown target', async () => {
    const r = await post(INSTANCES.a, tokenA, '/api/admin/media-config/test-connection', { target: 'bogus' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

// ── Text embedding config on the Models surface (SSRF follow-up part 2) ────────

describe('Media config — text embedding', () => {
  before(async () => { tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });
  after(async () => {
    // Restore to the bundled local model so no external/broken endpoint leaks into other suites.
    await restoreOrFail('embedding.provider/baseUrl',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config', { embedding: { provider: 'local', baseUrl: null } }),
      async () => {
        const emb = (await get(INSTANCES.a, tokenA, '/api/admin/media-config')).body?.embedding;
        return emb?.provider === 'local' && !emb?.baseUrl;
      });
  });

  it('GET surfaces the embedding block', async () => {
    const r = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(r.status, 200);
    assert.ok(r.body?.embedding, 'embedding block should be present');
    assert.ok(typeof r.body.embedding.model === 'string');
  });

  it('rejects an external embedding endpoint that is not a public URL (SSRF)', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config',
      { embedding: { provider: 'external', baseUrl: 'http://127.0.0.1:9999' } });
    assert.equal(r.status, 400, `expected SSRF rejection, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a provider-only change (no model/dims change) round-trips without reindex', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', { embedding: { provider: 'local' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.config?.embedding?.provider, 'local');
  });

  it('the embedding API key is masked in GET, never returned plaintext', async () => {
    const set = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', { embedding: { provider: 'local', apiKey: 'sk-emb-secret' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    const key = reread.body?.embedding?.apiKey;
    assert.ok(!key || !key.includes('sk-emb-secret'), `key must be masked, got: ${key}`);
    // A cleared key comes back `undefined` and a set one as a bullet string, so falsiness IS the check.
    await restoreOrFail('embedding.apiKey (cleared)',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config', { embedding: { provider: 'local', apiKey: null } }),
      async () => !(await get(INSTANCES.a, tokenA, '/api/admin/media-config')).body?.embedding?.apiKey);
  });
});

// ── F11-b — external assist model (hosted egress) ─────────────────────────────

describe('Media config — external assist model (F11-b)', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });
  after(async () => {
    // Lower the rung so no external routing leaks into other suites. (`uses` is retired — the extraction
    // rung IS the switch now, so dropping below `repair` is what disables the egress path. We do not try to
    // blank `baseUrl`: the schema requires a valid URL, so an empty string would 400.)
    //
    // This is the site whose own comment named the defect — "the `.catch()` would swallow it, leaving the
    // cleanup silently undone" — and worked around it by not attempting the harder restore. It no longer
    // swallows, so the workaround is a choice about what to restore rather than a hedge against silence.
    await restoreOrFail('documentProcessing.mode (egress rung)',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config', { documentProcessing: { mode: 'ocr' } }),
      async () => (await get(INSTANCES.a, tokenA, '/api/admin/media-config')).body?.documentProcessing?.mode === 'ocr');
  });

  it('making an endpoint REACHABLE without acknowledgment is rejected (egress gate)', async () => {
    // The rung is the switch: mode `repair` is what lets the pipeline call the endpoint, so that is what
    // demands the acknowledgment. (This used to be the `uses: ['repair']` tick, now retired.)
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { mode: 'repair', assistModel: { baseUrl: 'https://assist.example.com', model: 'big' } },
    });
    // Rejected either as unacknowledged egress or (if DNS unavailable) as SSRF-unsafe — both are 400.
    assert.equal(r.status, 400, `expected rejection, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('configuring the endpoint BELOW the repair rung is allowed (not reachable yet) and round-trips', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { mode: 'vlm', assistModel: { baseUrl: 'https://assist.example.com', model: 'big' } },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(reread.body?.documentProcessing?.assistModel?.baseUrl, 'https://assist.example.com');
  });

  it('the CONVERSATIONS consent is its own field: it round-trips, and null withdraws it (F-35)', async () => {
    // A documents acknowledgement never covers conversations — ingest reads this field alone.
    const set = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { mode: 'vlm', assistModel: { baseUrl: 'https://assist.example.com', model: 'big', acknowledgedHostForConversations: 'assist.example.com' } },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    let reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(reread.body?.documentProcessing?.assistModel?.acknowledgedHostForConversations, 'assist.example.com');
    assert.equal(reread.body?.documentProcessing?.assistModel?.acknowledgedHost, undefined, 'granting conversations grants nothing else');
    const withdrawn = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { assistModel: { baseUrl: 'https://assist.example.com', model: 'big', acknowledgedHostForConversations: null } },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal('acknowledgedHostForConversations' in (reread.body?.documentProcessing?.assistModel ?? {}), false,
      'withdrawn means absent, not stored as null');
  });

  it('the retired `uses` key is rejected outright', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { assistModel: { uses: ['repair'] } },
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a mode-only documentProcessing PATCH does not wipe the assist config (deep-merge)', async () => {
    // (endpoint set by the previous test) — change only the mode.
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', { documentProcessing: { mode: 'ocr' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    assert.equal(reread.body?.documentProcessing?.assistModel?.baseUrl, 'https://assist.example.com',
      'assist config must survive a mode-only patch');
  });

  it('the assist API key is never returned in plaintext (masked in GET)', async () => {
    const set = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      documentProcessing: { assistModel: { baseUrl: 'https://assist.example.com', model: 'big', apiKey: 'sk-secret-xyz' } },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const reread = await get(INSTANCES.a, tokenA, '/api/admin/media-config');
    const key = reread.body?.documentProcessing?.assistModel?.apiKey;
    assert.ok(key && !key.includes('sk-secret-xyz'), `key must be masked, got: ${key}`);
    // Clear the stored key.
    await restoreOrFail('documentProcessing.assistModel.apiKey (cleared)',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config',
        { documentProcessing: { assistModel: { apiKey: null } } }),
      async () => !(await get(INSTANCES.a, tokenA, '/api/admin/media-config'))
        .body?.documentProcessing?.assistModel?.apiKey);
  });
});

describe('Media config — the extractors\' decision model (F-31)', () => {
  const read = async () => (await get(INSTANCES.a, tokenA, '/api/admin/media-config')).body?.decisionModel;
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  });
  after(async () => {
    // Withdraw consent and drop the key, so no later suite finds a decision endpoint it did not configure.
    await restoreOrFail('decisionModel (consent withdrawn, key cleared)',
      () => patch(INSTANCES.a, tokenA, '/api/admin/media-config', { decisionModel: { acknowledgedHost: '', apiKey: null } }),
      async () => { const d = await read(); return d?.inUse === false && !d?.apiKey; });
  });

  it('the GET reports the defaults, not in use, before anything is configured', async () => {
    const d = await read();
    assert.equal(d?.model, 'jev-latest');
    assert.equal(d?.inUse, false, 'nothing is sent anywhere until a host is consented to');
  });

  it('setting it up without consent to its host is refused, naming the host', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      decisionModel: { baseUrl: 'https://decide.example.com', apiKey: 'sk-decide-xyz' },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.needsAcknowledgment, 'decide.example.com');
    assert.equal((await read())?.apiKey, undefined, 'a refused patch writes nothing — not even the key');
  });

  it('with consent it is stored, in use, and the key is masked and kept out of the config block', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', {
      decisionModel: { baseUrl: 'https://decide.example.com', acknowledgedHost: 'decide.example.com', apiKey: 'sk-decide-xyz' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = await read();
    assert.equal(d?.baseUrl, 'https://decide.example.com');
    assert.equal(d?.inUse, true);
    assert.ok(d?.apiKey && !d.apiKey.includes('sk-decide-xyz'), `key must be masked, got ${d?.apiKey}`);
  });

  it('withdrawing consent needs no consent', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', { decisionModel: { acknowledgedHost: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await read())?.inUse, false);
  });

  it('an unknown field is refused, not stored', async () => {
    const r = await patch(INSTANCES.a, tokenA, '/api/admin/media-config', { decisionModel: { uses: ['all'] } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});
