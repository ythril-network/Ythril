/**
 * Pipeline status — the decision logic behind the health dots.
 *
 * These test the PRODUCTION functions from `server/dist/api/pipeline-status.js`, not a copy of them.
 * The probing itself is I/O and is not re-implemented here; what is pinned is every judgement the
 * endpoint makes about what a probe result MEANS, because that is where a status screen goes wrong in
 * the way that matters — by reporting green.
 *
 * Two of these exist because of specific ways this feature could quietly become useless:
 *
 *   - the drift check, which is the only thing that would have surfaced a vector index disappearing
 *     while `config.json` still said `ready`;
 *   - the API-key round-trip, because every field on a stage is available to the function that builds
 *     the response and exactly one of them must never reach it.
 *
 * Run: node --test testing/standalone/pipeline-status.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyStage, groupStagesByEndpoint, endpointId, hostOf,
  deriveLiveIndexState, isDrifted,
} = await import('../../server/dist/api/pipeline-status.js');

const stage = (over = {}) => ({ key: 'vision', label: 'Vision', model: 'moondream', baseUrl: 'http://ollama:11434', external: false, ...over });
// Mirrors what `probeModelEndpoint` really returns, `verdict` included — a helper that omits it would
// exercise a shape production never produces.
const up = (models, over = {}) => ({ reachable: true, verdict: 'listed', models, latencyMs: 12, ...over });

describe('classifyStage — the three failures that all look like "nothing was extracted"', () => {
  it('reachable and serving the model is the only ok', () => {
    const r = classifyStage(stage(), up(['moondream:latest']));
    assert.equal(r.state, 'ok');
    assert.equal(r.latencyMs, 12);
  });

  it('reachable but NOT LISTING the model is informational — not degraded', () => {
    // This asserted `degraded`, on the reading that a name the endpoint has never heard of means the
    // extraction will produce nothing. That reading does not hold: aliasing routers (llama-swap roles),
    // gateways and Azure deployments deliberately serve names they keep OUT of their enumerations,
    // precisely so internal role names stay out of user-facing pickers. A reporter's vision endpoint was
    // captioning successfully and permanently yellow because of this rule.
    //
    // Absence from a list is not evidence of absence. Three outcomes exist here and only one is a fault:
    // unreachable (down), listed (good evidence), not listed (NO information). The third now stays `ok`
    // and says what it saw. Whether the model actually answers is a question only a real request can
    // settle — which is what Verify is for.
    const r = classifyStage(stage(), up(['llava:7b', 'qwen2.5:3b']));
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /not enumerated/);
    assert.match(r.detail, /aliasing routers/);
  });

  it('configured but unreachable is down, and carries the reason', () => {
    const r = classifyStage(stage(), { reachable: false, verdict: 'unreachable', detail: 'connect ECONNREFUSED', latencyMs: 5 });
    assert.equal(r.state, 'down');
    assert.equal(r.detail, 'connect ECONNREFUSED');
  });

  // ── B.2: a 404 on a path the slot never calls is not information about the slot ──

  it('THE REPORTED BUG: an endpoint with no model-list route is ok, not down', () => {
    // Their speech-to-text service serves exactly one route, `POST /v1/audio/transcriptions`. The probe
    // asked for an enumeration surface, got a 404, and the card went red — while Verify, which sends
    // generated silence down the real path, was green. The endpoint answered; it just cannot answer THAT.
    const r = classifyStage(stage({ key: 'stt', label: 'Speech-to-text', model: 'faster-whisper-large-v3' }), {
      reachable: true, verdict: 'not-enumerable', status: 404, latencyMs: 9,
      detail: 'endpoint answered HTTP 404 at http://whisper:8000/v1/models — it serves no model list',
    });
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /no model list/, 'green with no explanation is its own kind of dishonest');
  });

  it('a rejected credential is down even though the endpoint answered', () => {
    // The one 4xx that is a real fault: inference presents the same key to the same host.
    const r = classifyStage(stage(), {
      reachable: true, verdict: 'auth-rejected', status: 401, latencyMs: 7,
      detail: 'HTTP 401 at http://ollama:11434/v1/models — the endpoint answered but rejected the credential',
    });
    assert.equal(r.state, 'down');
    assert.match(r.detail, /credential/);
  });

  it('a 5xx is down — that is about the endpoint, not about the path', () => {
    const r = classifyStage(stage(), {
      reachable: false, verdict: 'erroring', status: 503, latencyMs: 11,
      detail: 'HTTP 503 at http://ollama:11434/v1/models — the endpoint is answering but erroring',
    });
    assert.equal(r.state, 'down');
  });

  it('a provider-type mismatch reaches the dot instead of being dropped', () => {
    // The probe already establishes that inference will speak the protocol the endpoint did NOT answer,
    // and it says so in `detail`. That detail was discarded here, so the operator got a plain green dot
    // over a pipeline that cannot work — the same evidence-ranking failure in the opposite direction.
    const r = classifyStage(stage(), up(['moondream:latest'], {
      detail: "endpoint answers Ollama's API at http://ollama:11434/api/tags, but this target is configured "
        + 'as external (OpenAI-compatible) — inference will use the other protocol and fail. Switch the provider type.',
    }));
    assert.equal(r.state, 'degraded', 'reachable AND established to fail is exactly what degraded is for');
    assert.match(r.detail, /Switch the provider type/);
  });

  it('no model configured is `unconfigured` — an empty slot is not a fault', () => {
    // This is the distinction that stops the screen crying wolf. A verify model is optional; showing
    // it red on every instance that has not set one trains the operator to ignore red.
    assert.equal(classifyStage(stage({ model: '' }), undefined).state, 'unconfigured');
    assert.equal(classifyStage(stage({ model: undefined }), undefined).state, 'unconfigured');
  });

  it('a model with no endpoint is the bundled in-process one, which cannot be unreachable', () => {
    const r = classifyStage(stage({ key: 'embedding', model: 'nomic-embed-text', baseUrl: undefined }), undefined);
    assert.equal(r.state, 'ok');
    assert.equal(r.detail, 'in-process');
  });

  it('an SSRF-blocked external endpoint is `blocked` — it was refused, not tried', () => {
    const r = classifyStage(stage({ external: true, baseUrl: 'http://169.254.169.254' }), { blocked: true });
    assert.equal(r.state, 'blocked');
    assert.match(r.detail, /SSRF/);
  });

  it('an endpoint that lists no models at all is not accused of missing one', () => {
    // Some OpenAI-compatible servers answer /v1/models with an empty list. That is not evidence the
    // model is absent, and treating it as such would show `degraded` on a working instance.
    assert.equal(classifyStage(stage(), up([])).state, 'ok');
  });

  it('matches an Ollama `:tag` suffix as well as an exact name', () => {
    assert.equal(classifyStage(stage({ model: 'moondream' }), up(['moondream:v2'])).state, 'ok');
    assert.equal(classifyStage(stage({ model: 'moondream' }), up(['moondream'])).state, 'ok');
    // ...but not a different model that merely starts with the same letters. Still `ok` now — the point
    // is that it is NOT counted as enumerated, which the detail line reports.
    const near = classifyStage(stage({ model: 'llama' }), up(['llama-guard']));
    assert.equal(near.state, 'ok');
    assert.match(near.detail, /not enumerated/);
  });
});

describe('classifyStage — what must never reach the response', () => {
  it('the API key does not survive into the status payload', () => {
    // Every field of the stage is in scope where the response object is built. One spread of `s`
    // instead of the explicit fields would publish the key to any admin loading the page, and nothing
    // else in the system would notice.
    const secret = 'sk-live-DO-NOT-LEAK-9f3a';
    for (const res of [up(['moondream']), { reachable: false, detail: 'x', latencyMs: 1 }, { blocked: true }, undefined]) {
      const out = classifyStage(stage({ apiKey: secret, external: true }), res);
      assert.ok(!JSON.stringify(out).includes(secret), `key leaked with probe result ${JSON.stringify(res)}`);
      assert.equal(out.apiKey, undefined);
    }
  });

  it('reports the endpoint HOST only, never a URL that could carry a credential in its query', () => {
    const out = classifyStage(stage({ baseUrl: 'https://api.example.com/v1?access_token=leaked' }), up(['moondream']));
    assert.equal(out.endpoint, 'api.example.com');
    assert.ok(!JSON.stringify(out).includes('leaked'));
  });

  it('hostOf returns the input unchanged when it will not parse, rather than throwing', () => {
    assert.equal(hostOf('not a url'), 'not a url');
    assert.equal(hostOf(undefined), null);
  });
});

describe('groupStagesByEndpoint — one probe per endpoint, not per stage', () => {
  it('collapses the document stages that share an Ollama into a single probe', () => {
    // vlm / repair / verify normally all resolve to the same endpoint. Probing per stage would put
    // three times the load on the process that is also transcribing pages.
    const stages = [
      stage({ key: 'doc-vlm', model: 'a' }),
      stage({ key: 'doc-repair', model: 'b' }),
      stage({ key: 'doc-verify', model: 'c' }),
    ];
    const groups = groupStagesByEndpoint(stages);
    assert.equal(groups.size, 1);
    assert.deepEqual([...groups.values()][0].map(s => s.key), ['doc-vlm', 'doc-repair', 'doc-verify']);
  });

  it('keeps distinct endpoints, and distinct credentials for one endpoint, apart', () => {
    const groups = groupStagesByEndpoint([
      stage({ key: 'a', baseUrl: 'http://one:1' }),
      stage({ key: 'b', baseUrl: 'http://two:2' }),
      stage({ key: 'c', baseUrl: 'http://one:1', apiKey: 'k' }),
    ]);
    assert.equal(groups.size, 3);
  });

  it('drops stages with nothing to ask — no model or no endpoint', () => {
    const groups = groupStagesByEndpoint([
      stage({ key: 'nomodel', model: '' }),
      stage({ key: 'inprocess', baseUrl: undefined }),
      stage({ key: 'real' }),
    ]);
    assert.equal(groups.size, 1);
    assert.deepEqual([...groups.values()][0].map(s => s.key), ['real']);
  });

  it('the grouping key is the same one classifyStage looks results up by', () => {
    // If these two ever diverge, every stage silently reports `unconfigured` — the probes would run
    // and their results would simply never be found again.
    const s = stage({ apiKey: 'k', external: true });
    const groups = groupStagesByEndpoint([s]);
    assert.ok(groups.has(endpointId(s)));
  });
});

describe('deriveLiveIndexState — what the database actually says', () => {
  const coll = (status) => ({ collection: 'facts', indexName: 'x', status });

  it('every index READY is ready', () => {
    assert.equal(deriveLiveIndexState([coll('READY'), coll('READY')], false), 'ready');
  });

  it('a missing index outranks a building one — absent is worse than not-yet', () => {
    assert.equal(deriveLiveIndexState([coll('READY'), coll(null)], false), 'missing');
    assert.equal(deriveLiveIndexState([coll('PENDING'), coll(null)], false), 'missing');
  });

  it('present but not READY is building', () => {
    assert.equal(deriveLiveIndexState([coll('READY'), coll('PENDING')], false), 'building');
  });

  it('a failed listing is `unknown`, never `missing`', () => {
    // A MongoDB without Atlas Search support throws on every listing. Reporting that as `missing`
    // would paint every space on the instance red when nothing is wrong with any of them.
    assert.equal(deriveLiveIndexState([coll(null), coll(null)], true), 'unknown');
    assert.equal(deriveLiveIndexState([coll('READY')], true), 'unknown');
  });
});

describe('isDrifted — the silent index loss this endpoint exists to catch', () => {
  it('stored ready + live missing is drift', () => {
    // This is the exact shape of the failure that hid behind an empty result set for months:
    // config.json says the space is ready, the index is gone, and recall returns nothing forever.
    assert.equal(isDrifted('ready', 'missing'), true);
  });

  it('stored ready + live building is also drift — ready is a claim that stopped being true', () => {
    assert.equal(isDrifted('ready', 'building'), true);
  });

  it('stored building + live ready is NOT drift — that is the normal creation race', () => {
    // The background finalizer writes `ready` after polling. Flagging the gap would put a warning on
    // every freshly created space and teach the operator to ignore the badge that matters.
    assert.equal(isDrifted('building', 'ready'), false);
  });

  it('never claims drift from an unknown live state', () => {
    assert.equal(isDrifted('ready', 'unknown'), false);
  });

  it('a stored `failed` is not drift — it is already reported honestly', () => {
    assert.equal(isDrifted('failed', 'missing'), false);
  });
});
