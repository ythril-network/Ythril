/**
 * The model-endpoint probe agrees with the thing it probes.
 *
 * ## What was wrong
 *
 * The probe tried `${base}/v1/models` and then `${base}/api/tags` — blindly, for every target and every
 * provider. `external` was computed per target but only ever chose the fetch implementation, never the
 * endpoint. Reported against 2.1.1, same pod, minutes apart:
 *
 *     POST /v1/chat/completions  -> 200  (inference, working)
 *     GET  /v1/v1/models         -> 404  (probe)
 *     GET  /v1/api/tags          -> 404  (probe, second attempt)
 *
 * Vision-external is the one target whose base already contains `/v1` (the OpenAI convention). So the
 * Models page showed vision red while captions were being generated successfully — and removing the
 * `/v1` to satisfy the probe made it **green while inference 404'd**, which is the worse direction and
 * the reason this is not cosmetic.
 *
 * The URL now comes from `listUrlFor`, the same helper the inference path uses.
 *
 * ## And what "model not listed" is allowed to mean
 *
 * Nothing. Aliasing routers (llama-swap roles), gateways and Azure deployments deliberately serve names
 * they do not enumerate, so absence from the list is not evidence of anything. The field is
 * `modelEnumerated` — named for what it measured — and `false` is never a fault.
 *
 * Run: node --test testing/standalone/probe-endpoint.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

// ── Mock model endpoint ───────────────────────────────────────────────────────
const state = { v1: 200, tags: 200, v1Body: null, tagsBody: null };
const seen = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  seen.push(url);
  if (url.startsWith('/v1/models')) {
    res.writeHead(state.v1, { 'content-type': 'application/json' });
    res.end(state.v1Body ?? JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3' }] }));
    return;
  }
  if (url.startsWith('/api/tags')) {
    res.writeHead(state.tags, { 'content-type': 'application/json' });
    res.end(state.tagsBody ?? JSON.stringify({ models: [{ name: 'moondream:latest' }, { name: 'llava:13b' }] }));
    return;
  }
  res.writeHead(404); res.end();
});

let local;
let base;
let probeModelEndpoint;
before(async () => {
  local = await listenOnLoopback(server);
  base = local.url;
  ({ probeModelEndpoint } = await import('../../server/dist/api/media-config.js'));
});
after(() => local.close());

describe('probeModelEndpoint', () => {
  it('reaches an OpenAI-compatible endpoint via /v1/models and finds the model', async () => {
    state.v1 = 200; state.v1Body = null;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'gpt-4o', external: false });
    assert.equal(r.ok, true);
    assert.equal(r.reachable, true);
    assert.match(r.endpoint, /\/v1\/models$/);
    assert.equal(r.modelEnumerated, true);
    assert.ok(r.models.includes('gpt-4o'));
  });

  it('THE REPORTED BUG: a base that already carries /v1 is not doubled', async () => {
    // `…:8080/v1` produced `…:8080/v1/v1/models` → 404, then `/v1/api/tags` → 404, and the operator was
    // shown a red dot over a pipeline that was captioning successfully.
    state.v1 = 200; state.v1Body = null;
    seen.length = 0;
    const r = await probeModelEndpoint({ baseUrl: `${base}/v1`, model: 'gpt-4o', external: false });
    assert.equal(r.reachable, true, 'must reach the endpoint with /v1 already in the base');
    assert.match(r.endpoint, /\/v1\/models$/);
    assert.ok(!seen.some(u => u.includes('/v1/v1/')), `never request /v1/v1/: ${seen.join(', ')}`);
  });

  it('and a base WITHOUT /v1 lands on the same place', async () => {
    // One URL has to serve every OpenAI-compatible caller — a reporter was running two different base
    // URLs for the same server to satisfy two conventions, and that workaround hid the bug.
    state.v1 = 200; state.v1Body = null;
    const withV1 = await probeModelEndpoint({ baseUrl: `${base}/v1`, external: false });
    const without = await probeModelEndpoint({ baseUrl: base, external: false });
    assert.equal(withV1.endpoint, without.endpoint);
  });

  it('a local Ollama target is probed on ITS wire, not the OpenAI one', async () => {
    state.tags = 200; state.tagsBody = null;
    seen.length = 0;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'moondream', external: false, wire: 'ollama' });
    assert.equal(r.reachable, true);
    assert.match(r.endpoint, /\/api\/tags$/);
    assert.equal(r.modelEnumerated, true, 'moondream should match moondream:latest');
    assert.equal(seen[0], '/api/tags', 'the configured wire is tried FIRST, not as a fallback');
  });

  it('answering on the other wire is reported as a provider-type mismatch, not a plain success', async () => {
    // Reachable, but inference will use the other protocol and fail. A bare "reachable" here would be a
    // green dot over a pipeline that cannot work.
    state.v1 = 404; state.tags = 200; state.tagsBody = null;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'moondream', external: false });
    assert.equal(r.reachable, true);
    assert.equal(r.ok, false, 'a wire mismatch is not an OK result');
    assert.match(r.detail, /Ollama/);
    assert.match(r.detail, /Switch the provider type/);
    state.v1 = 200;
  });

  it('modelEnumerated is undefined when no model is given (reachability only)', async () => {
    state.v1 = 200; state.v1Body = null;
    const r = await probeModelEndpoint({ baseUrl: base, external: false });
    assert.equal(r.reachable, true);
    assert.equal(r.modelEnumerated, undefined);
  });

  it('reports modelEnumerated=false when the name is not listed — informational, still ok', async () => {
    state.v1 = 200; state.v1Body = null;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'a-router-alias', external: false });
    assert.equal(r.reachable, true);
    assert.equal(r.modelEnumerated, false);
    assert.equal(r.ok, true, 'not listing a name is not a failure — routers do it deliberately');
  });

  // ── What a non-200 is allowed to mean (B.2) ────────────────────────────────
  //
  // Every status that was not `ok` became `reachable: false`, so a 404 on the list path read exactly like
  // a refused connection. The reporting deployment's speech-to-text endpoint serves exactly one route,
  // `POST /v1/audio/transcriptions`: the probe asked for an enumeration surface, got a 404, and the card
  // went red over a pipeline whose Verify was green. A 404 on a path the slot never calls is not
  // information about the slot.

  it('THE REPORTED BUG: an endpoint with no model-list route is reachable, not down', async () => {
    state.v1 = 404; state.tags = 404;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'Systran/faster-whisper-large-v3', external: false });
    assert.equal(r.verdict, 'not-enumerable');
    assert.equal(r.reachable, true, 'the endpoint ANSWERED — twice');
    assert.equal(r.ok, true, 'having no listing surface is not a fault');
    assert.equal(r.status, 404);
    assert.match(r.detail, /no model list/i, 'and it has to say why, or the operator sees a bare green dot');
    state.v1 = 200; state.tags = 200;
  });

  it('a rejected credential stays a fault, and says so', async () => {
    // Inference presents the same key, so this one really is broken — but "unreachable" would send the
    // operator to the network when the fix is the API key field two rows above.
    state.v1 = 401; state.tags = 401;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'gpt-4o', apiKey: 'wrong', external: false });
    assert.equal(r.verdict, 'auth-rejected');
    assert.equal(r.ok, false);
    assert.match(r.detail, /credential/i);
    state.v1 = 200; state.tags = 200;
  });

  it('a 5xx stays a fault — that is about the endpoint, not about the path', async () => {
    state.v1 = 503; state.tags = 503;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'gpt-4o', external: false });
    assert.equal(r.verdict, 'erroring');
    assert.equal(r.reachable, false, 'answering with 503 is not being usable');
    assert.equal(r.ok, false);
    state.v1 = 200; state.tags = 200;
  });

  it('a 404 on one wire does not mask a real fault on the other', async () => {
    // The ladder is ordered by what each status proves, and a rejected credential outranks a missing
    // route: one of them will break inference and the other will not.
    state.v1 = 404; state.tags = 403;
    const r = await probeModelEndpoint({ baseUrl: base, model: 'x', external: false });
    assert.equal(r.verdict, 'auth-rejected');
    state.v1 = 200; state.tags = 200;
  });

  it('reports unreachable when nothing responds, and names the URL it tried', async () => {
    const r = await probeModelEndpoint({ baseUrl: 'http://127.0.0.1:1', model: 'x', external: false });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, false);
    assert.ok(typeof r.latencyMs === 'number');
    // A bare "unreachable" cannot distinguish a wrong base path from a dead endpoint, and the two need
    // opposite fixes.
    assert.match(r.detail, /127\.0\.0\.1:1/);
  });
});
