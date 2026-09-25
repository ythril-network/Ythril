/**
 * The document VLM speaks the right wire, and never egresses unguarded.
 *
 * ## The two bugs
 *
 * A reporter running self-hosted Kubernetes found both in one PDF upload:
 *
 *     POST /render              -> 200   (rasterisation fine)
 *     POST /v1/api/chat         -> 404   (VLM, user-agent "node")
 *     POST /v1/chat/completions -> 200   (captions, user-agent "undici")
 *
 * **1. `vlmModel` could not work against any OpenAI-compatible server.** `postChat` hardcoded Ollama's
 * `/api/chat`; llama.cpp, llama-swap, vLLM and LocalAI do not serve it, and no `baseUrl` fixes that —
 * dropping `/v1` merely yields `/api/chat` again. doc-render rasterised pages that were then discarded.
 *
 * **2. Two unguarded egress paths**, from one stale assumption ("the document stages are local", true
 * only while the VLM was the bundled Ollama):
 *   - `vlm-client.postChat` used a bare `fetch` — that is the `"node"` user-agent, sending page images;
 *   - `pipeline-status.modelStages()` hardcoded `external: false` on `doc-vlm`/`doc-repair`/`doc-verify`,
 *     whose `baseUrl` falls back to the **vision** endpoint that the line above classifies with
 *     `visionProvider === 'external'`. Same URL, opposite verdicts — so discovery went out unguarded too.
 *
 * Neither carried the SSRF guard nor the egress acknowledgement the assist model demands for the same
 * class of destination. It failed safe only against OpenAI-compatible targets, which 404 `/api/chat`; a
 * **remote Ollama** answers 200, so those deployments were egressing page images silently while the
 * pipeline reported success.
 *
 * The integration guide already promised otherwise — its list of SSRF-guarded model endpoints omits the
 * document VLM, and it states no document content leaves by default. The code was wrong, not the doc.
 *
 * Run: node --test testing/standalone/vlm-endpoint-egress.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { bodyOf, enclosingBlockAround, statementUpTo } from './_structural-window.mjs';

const ENDPOINT_SRC = 'server/src/files/converters/vlm-endpoint.ts';
const CLIENT_SRC = 'server/src/files/converters/vlm-client.ts';
const CHAT_SRC = 'server/src/util/model-chat.ts';
const STATUS_SRC = 'server/src/api/pipeline-status.ts';

const ep = await (async () => {
  const ts = await import('typescript');
  const js = ts.default.transpileModule(readFileSync(ENDPOINT_SRC, 'utf8'), {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText
    // The resolver itself needs config; only the pure URL helpers are exercised here.
    .replace(/^import .*$/m, '');
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
})();

const { normalizeOpenAiBase, chatUrlFor, listUrlFor } = ep;

describe('one base URL works for every OpenAI-compatible caller', () => {
  it('adds /v1 when absent', () => {
    assert.equal(normalizeOpenAiBase('http://host:8080'), 'http://host:8080/v1');
  });

  it('does not double it when present', () => {
    // The reported failure was `/v1/v1/models`. Both spellings must land on the same place.
    assert.equal(normalizeOpenAiBase('http://host:8080/v1'), 'http://host:8080/v1');
  });

  it('tolerates a trailing slash either way', () => {
    assert.equal(normalizeOpenAiBase('http://host:8080/'), 'http://host:8080/v1');
    assert.equal(normalizeOpenAiBase('http://host:8080/v1/'), 'http://host:8080/v1');
  });

  it('THE case that was broken: one identical URL serves both conventions', () => {
    // The reporter had to configure two DIFFERENT base URLs for the same server, because vision appended
    // `/chat/completions` (base with /v1) and assist appended `/v1/chat/completions` (base without). That
    // workaround is what hid the bug. Both spellings must now resolve identically.
    const withV1 = chatUrlFor('openai', 'http://host:8080/v1');
    const without = chatUrlFor('openai', 'http://host:8080');
    assert.equal(withV1, without);
    assert.equal(withV1, 'http://host:8080/v1/chat/completions');
  });
});

describe('each wire gets its own routes', () => {
  it('ollama chat', () => assert.equal(chatUrlFor('ollama', 'http://o:11434'), 'http://o:11434/api/chat'));
  it('openai chat', () => assert.equal(chatUrlFor('openai', 'http://h:8080'), 'http://h:8080/v1/chat/completions'));
  it('ollama list', () => assert.equal(listUrlFor('ollama', 'http://o:11434'), 'http://o:11434/api/tags'));
  it('openai list', () => assert.equal(listUrlFor('openai', 'http://h:8080'), 'http://h:8080/v1/models'));

  it('never produces the reported 404 shapes', () => {
    // set-claim: the two base-URL shapes an operator writes -- with and without the `/v1` suffix -- which
    // is the pair that produced the reported 404s. Inputs, not a set.
    for (const base of ['http://h:8080', 'http://h:8080/v1']) {
      assert.doesNotMatch(chatUrlFor('openai', base), /\/v1\/v1\//);
      assert.doesNotMatch(listUrlFor('openai', base), /\/v1\/v1\//);
      assert.doesNotMatch(chatUrlFor('openai', base), /\/api\/chat/);
      assert.doesNotMatch(listUrlFor('openai', base), /\/api\/tags/);
    }
  });

  it('the probe and the inference call derive from the SAME base', () => {
    // A probe that normalises differently from the thing it probes is the original defect in miniature:
    // `/v1/models` against a base already carrying `/v1` is how the Models page went red over a working
    // pipeline. Both URLs must hang off one resolved base — not merely share a parent directory.
    for (const base of ['http://h:8080', 'http://h:8080/v1', 'http://h:8080/']) {
      const oa = `${normalizeOpenAiBase(base)}/`;
      assert.ok(chatUrlFor('openai', base).startsWith(oa), `openai chat ${base}`);
      assert.ok(listUrlFor('openai', base).startsWith(oa), `openai list ${base}`);

      const ol = `${base.replace(/\/+$/, '')}/`;
      assert.ok(chatUrlFor('ollama', base).startsWith(ol), `ollama chat ${base}`);
      assert.ok(listUrlFor('ollama', base).startsWith(ol), `ollama list ${base}`);
    }
  });
});

// ── The wiring, so neither unguarded path can come back ──────────────────────

const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('egress is guarded whenever the endpoint is not the bundled model', () => {
  const client = strip(readFileSync(CLIENT_SRC, 'utf8'));

  it('postChat routes external through ssrfSafeFetch', () => {
    /*
     * A WINDOW, converted: the subject is what CHOOSES this fetch, so the bound runs from the start of its
     * statement up to the call — the shape `statementUpTo` exists for.
     *
     * The two are a ternary's condition and one of its arms, and 200 characters between them is satisfied by any
     * `endpoint.external` sitting above any guarded fetch, in either order and in unrelated statements. What has
     * to hold is that THIS fetch is the arm the locality test picks.
     */
    const at = client.indexOf('ssrfSafeFetch(url, init');
    assert.ok(at > -1, 'the guarded fetch is gone — re-anchor this gate');
    assert.match(statementUpTo(client, at, 'what chooses the guarded fetch'), /endpoint\.external/,
      'the guarded fetch must be the arm the external test selects');
  });

  it('and passes the private-address opt-in, so a self-hosted model still works', () => {
    // Resolved for the endpoint's own slot. Transcription, repair and the external assist model are three
    // separate egress decisions — the document VLM sitting on the cluster is not a reason to let the assist
    // model, the one path that sends content off-instance, reach a private address.
    assert.match(client, /allowPrivate: allowPrivateForSlot\(endpoint\.slot\)/);
    // The assist path reaches its endpoint through `modelFetch` under the 'assist' slot (F-33), which applies the
    // slot's private-address policy to anything that is not a local sidecar.
    assert.match(client, /modelFetch\(url, \{[^}]*\}, 'assist'\)/);
    assert.match(strip(readFileSync('server/src/util/model-fetch.ts', 'utf8')), /allowPrivate: allowPrivateForSlot\(slot\)/);
  });

  it('each entry point falls back to its own slot when the caller names none', () => {
    /*
     * The slot became settable per call because `docVerify` was a declared slot that nothing resolved: the
     * second-opinion pass runs on its own endpoint and was charged to `docVlm` for its budget, its egress
     * permission and its reasoning effort.
     *
     * What this asserts is the half that keeps that safe — the DEFAULT is unchanged. An existing caller
     * passes no slot and must still resolve exactly what it always did, or making the slot settable silently
     * re-points transcription at a policy nobody chose for it.
     */
    for (const [fn, slot] of [
      ['transcribePageImage', 'docVlm'],
      ['repairMarkdown', 'docRepair'],
      ['reconcileConsensus', 'docVlm'],
    ]) {
      assert.match(bodyOf(client, fn), new RegExp(`opts\\.slot \\?\\? '${slot}'`),
        `${fn} must still fall back to the ${slot} slot`);
    }
  });

  it('the bundled local path keeps its plain fetch', () => {
    // Guarding it unconditionally would refuse the DEFAULT deployment, whose Ollama is on a private
    // cluster address with `allowPrivateModelEndpoints` off.
    assert.match(client, /: await fetch\(url, init\)/);
  });

  it('no call site hardcodes a wire path any more', () => {
    // The request is built in ONE module now (`util/model-chat.ts`, F-33.1), so that is where the derivation lives;
    // the client must not build a wire path of its own beside it.
    const chat = strip(readFileSync(CHAT_SRC, 'utf8'));
    for (const src of [client, chat]) assert.doesNotMatch(src, /\$\{baseUrl[^}]*\}\/api\/chat/);
    assert.match(chat, /chatUrlFor\(endpoint\.wire, endpoint\.baseUrl\)/);
    assert.match(client, /chatOnce\(/, 'the client builds its requests through the one call module');
  });
});

describe('the status board and the extractor cannot disagree', () => {
  const status = strip(readFileSync(STATUS_SRC, 'utf8'));

  it('document stages no longer hardcode external: false', () => {
    // The exact defect: three stages asserting `false` on a URL the line above them classifies.
    /*
     * The stage's own object literal, bounded by the brace that closes it.
     *
     * TWO things were wrong here, and the second is worse. The 200-character gap is an ABSENCE assertion, so a stage
     * that grew a field would have pushed `external: false` out of range and passed on the defect it names.
     *
     * And the pattern matched NOTHING — zero occurrences, in this version and in the one before it. The three stages
     * are built in a `.map`, so the key is a TEMPLATE (`` key: `doc-${slot}` ``) and never the quoted literal the
     * regex looked for. The check has been vacuous since it was written, which is the failure that reads exactly
     * like a passing gate. Hence the floor assertion below: matching nothing must be an error, never a silence.
     */
    const stages = [...status.matchAll(/key: `doc-\$\{slot\}`|key: 'doc-(?:vlm|repair|verify)'/g)];
    assert.ok(stages.length > 0,
      'no document stage found in pipeline-status.ts — this check would pass by examining nothing');
    const hardcoded = stages
      .map(m => enclosingBlockAround(status, m.index, 'a document stage'))
      .filter(stage => /external: false/.test(stage));
    assert.deepEqual(hardcoded, [],
      'a document stage asserts external: false on a URL the resolver classifies — the original defect');
  });

  it('they read the shared resolver instead', () => {
    assert.match(status, /resolveVlmEndpoint\(slot\)/);
    assert.match(status, /external: e\.external/);
  });
});

describe('no operator-configurable URL is fetched without the guard', () => {
  /**
   * The inverted audit.
   *
   * #546 audited `ssrfSafeFetch` CALL SITES and pronounced all 13 correct. That set cannot, by
   * construction, contain an egress that should have been guarded and is not — which is exactly how both
   * VLM paths survived it. This asks the opposite question: which files reach the network at all, and is
   * each one either guarded or a declared piece of infrastructure?
   */
  const files = trackedSources('server/src');

  /**
   * Files whose URLs are NOT operator-configurable model endpoints, and may fetch freely.
   *
   * Sidecars are declared infrastructure: their URLs come from env the deployment sets for itself, they
   * are expected to be private, and the integration guide documents them as outside the egress guard.
   * The local agent is loopback-only unless `YTHRIL_LOCAL_AGENT_ALLOW_REMOTE` is set, and demands HTTPS
   * in remote mode — its own gate, deliberately separate from the model-egress one.
   *
   * The document VLM was never in this category: its endpoint follows an admin-settable model provider.
   */
  const NOT_A_MODEL_ENDPOINT = new Map([
    ['server/src/files/converters/renderer.ts', 'render sidecars (RENDER_SIDECAR_URL) — declared infrastructure'],
    ['server/src/files/converters/unstructured.ts', 'conversion sidecar (CONVERSION_SIDECAR_URL) — declared infrastructure'],
    ['server/src/extractor/conversation/nlp-client.ts', 'NLP sidecar (NLP_SIDECAR_URL) — declared infrastructure'],
    ['server/src/util/sidecar-health.ts', 'the shared sidecar /health probe — the sidecars above, never a model endpoint'],
    ['server/src/api/pipeline-status.ts', 'sidecar /health probes; model endpoints go through probeModelEndpoint'],
    ['server/src/api/local-agent.ts', 'loopback-only by default; its own remote opt-in + HTTPS requirement'],
    ['server/src/util/ssrf.ts', 'the guard itself'],
    // KNOWN GAP, deliberately listed rather than hidden. `OllamaVisionProvider` (and `WhisperProvider`
    // via `egressFetch(this.external)`) select the guard from the PROVIDER TYPE, and the integration
    // guide itself notes that `local`/`external` is a wire protocol, not a trust level — so
    // `visionProvider: local` aimed at a REMOTE Ollama egresses unguarded, exactly as the document VLM
    // did. Closing it refuses configurations that work today, so the rule is an owner decision:
    // `_PARKED-DECISIONS.md` D3. Removing this entry is the fix.
    ['server/src/files/media/providers.ts', 'PARKED D3 — guard chosen by provider type, not by where the URL points'],
  ]);

  /** A bare `fetch` is fine when the line choosing it tested where the endpoint lives. */
  const GUARD_PREDICATES = /isLocalEndpoint\(|isLocalModelEndpoint\(|\.external\b|external\s*\?|egressFetch\(/;

  it('every bare fetch of a model endpoint is chosen by a locality test', () => {
    // The inverted audit. #546 audited ssrfSafeFetch CALL SITES and pronounced all 13 correct — a set
    // that cannot, by construction, contain an egress that should have been guarded and is not. That is
    // exactly how the VLM's bare fetch survived it. This asks the opposite question.
    const offenders = [];
    for (const f of files) {
      if (NOT_A_MODEL_ENDPOINT.has(f)) continue;
      const src = strip(readFileSync(f, 'utf8'));
      // `fetch(` but not `ssrfSafeFetch(` / `peerSafeFetch(` / `egressFetch(` / `.fetch(`.
      for (const m of src.matchAll(/(?<![A-Za-z.])fetch\(/g)) {
        // The statement this fetch is chosen inside, bounded by where that statement begins. At 220 characters
        // backwards the window could start mid-way through the previous statement and miss the ternary that picks
        // the client — which would report a correctly-guarded fetch as an offender.
        const window = statementUpTo(src, m.index, `the fetch in ${f}`);
        if (!GUARD_PREDICATES.test(window)) {
          offenders.push(`${f} (line ${src.slice(0, m.index).split('\n').length})`);
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      'An unconditional bare fetch on what may be an operator-configurable model endpoint. Choose the\n'
      + 'client from where the endpoint lives — plain fetch for the bundled local model, ssrfSafeFetch\n'
      + 'otherwise — or add the file to NOT_A_MODEL_ENDPOINT with the reason:\n  '
      + offenders.join('\n  '),
    );
  });

  it('the exemption list is not stale', () => {
    // A file that stops fetching should leave the list, or the list stops meaning anything.
    const dead = [...NOT_A_MODEL_ENDPOINT.keys()].filter(f => !files.includes(f));
    assert.deepEqual(dead, [], `listed but no longer tracked: ${dead.join(', ')}`);
  });

  it('the scan actually reads the tree', () => {
    assert.ok(files.length > 100, `expected the server sources, got ${files.length}`);
  });
});
