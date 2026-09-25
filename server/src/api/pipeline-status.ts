/**
 * Read-only pipeline status — one payload answering "is any of this actually working?".
 *
 *   GET /api/admin/pipeline-status
 *
 * The Models & Pipelines screen draws a health dot on every pipeline step. Those dots must come from
 * ONE request: a poll per step would multiply outbound probes by the number of steps on screen, and
 * the sidecars this probes are the same processes doing the real work.
 *
 * What it reports, and why each one is here rather than inferred from config:
 *
 *   - **sidecars** — reachability of the conversion / page-render / office-render services. Config can
 *     only say what URL was configured; it cannot say whether anything is listening on it.
 *   - **models** — per stage: which model is configured, and whether its endpoint both responds AND
 *     lists that model. "Configured", "reachable" and "serving that model" are three different
 *     failures with one symptom (nothing gets extracted), so they are reported separately.
 *   - **index** — the LIVE `$vectorSearch` index state per space and collection, read from MongoDB
 *     rather than from `space.indexStatus`. That distinction is the entire point: the stored status is
 *     written once when a space is built and never revisited, so an index that later vanishes leaves
 *     `indexStatus: 'ready'` behind it and recall quietly returns nothing. Reading both and reporting
 *     them side by side turns that divergence into something visible instead of something fatal.
 *
 * Nothing here mutates, and nothing here is on a request path a user waits on — so it is cached and
 * single-flighted rather than fast.
 */

import { Router } from 'express';
import { getConfig, getMediaEmbeddingConfig, getEmbeddingConfig, getEmbeddingApiKey, getDocumentProcessingConfig, getDocAssistApiKey, getDocAssistFallbackApiKey, getFaceRecognitionConfig, getRerankApiKey, getNliApiKey } from '../config/loader.js';
import { requireAdmin } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import {
  allowPrivateForSlot, EGRESS_SLOTS, isLocalModelEndpoint, type EgressSlot,
} from '../config/model-egress-policy.js';
import { probeModelEndpoint, type ProbeVerdict } from './media-config.js';
import { resolveVlmEndpoint } from '../files/converters/vlm-endpoint.js';
import { getDb } from '../db/mongo.js';
import { faceRecognitionAllowed } from '../files/converters/media-level.js';
import { VECTOR_INDEXED_COLLECTIONS } from '../spaces/vector-index.js';
import { log } from '../util/log.js';
import { assistBackend, assistBudgetStatus, type AssistBudget } from '../config/assist-backend.js';
import type { ChatWire } from '../util/model-chat.js';

export const pipelineStatusRouter = Router();

/** How long a probe result is served before the next request re-probes. */
const CACHE_TTL_MS = 20_000;
/** Ceiling on a single sidecar health check. Shorter than the model probe: these are local services. */
const SIDECAR_TIMEOUT_MS = 3_000;

// ── Shapes ────────────────────────────────────────────────────────────────────

/** Why a thing is not green. Not a boolean, because "never configured" is not a fault. */
export type HealthState =
  | 'ok'            // the endpoint answered, and nothing establishes that inference will fail
  // Reachable, and something the probe SAW says the configured call will fail anyway — today, an endpoint
  // answering on the other wire. (It used to mean "the model was not listed", which is not a finding at
  // all: routers and gateways deliberately do not enumerate the names they serve.)
  | 'degraded'
  | 'down'          // configured, and either nothing answered or what answered was a real fault
  | 'blocked'       // an external endpoint that fails the SSRF policy — never probed
  | 'off'           // deliberately disabled
  | 'unconfigured'; // nothing set, so nothing to be wrong

export interface SidecarStatus {
  key: string;
  label: string;
  /** The env var that owns this URL, so the UI can name it on an infra-set card. */
  envVar: string;
  url: string;
  state: HealthState;
  latencyMs?: number;
  detail?: string;
}

export interface ModelStageStatus {
  key: string;
  label: string;
  model: string | null;
  /** Host only — never the full URL, which may carry a credential in its query. */
  endpoint: string | null;
  external: boolean;
  state: HealthState;
  latencyMs?: number;
  detail?: string;
}

export interface CollectionIndexStatus {
  collection: string;
  indexName: string;
  /** MongoDB's own status string (READY / PENDING / …), or null when the index does not exist. */
  status: string | null;
  /**
   * True for an index the space's SEARCH does not depend on — today, the face gallery.
   *
   * Reported so an operator can still see it, and excluded from `live` so it cannot decide the space's
   * health. See `deriveLiveIndexState`.
   */
  optional?: boolean;
}

export interface SpaceIndexStatus {
  id: string;
  label: string;
  /** What `config.json` believes. Kept beside `live` precisely so the two can disagree visibly. */
  stored: 'building' | 'ready' | 'failed' | 'unknown';
  /** From the live listing: 'ready' only when every expected index reports READY. */
  live: 'ready' | 'building' | 'missing' | 'unknown';
  collections: CollectionIndexStatus[];
  /** True when `stored` claims ready and the live listing disagrees — the silent-loss signature. */
  drifted: boolean;
}

export interface PipelineStatus {
  checkedAt: string;
  sidecars: SidecarStatus[];
  models: ModelStageStatus[];
  index: { spaces: SpaceIndexStatus[]; unavailable?: string };
  faceRecognition: { state: HealthState };
  /** The assist model's budget and who answers each use now (`F-33`); absent with no assist model configured. */
  assist?: { answeredBy: { repair: AssistWhich; conversations: AssistWhich }; spent: number; budget?: AssistBudget; primaryCoolingDown: boolean };
}

type AssistWhich = 'primary' | 'fallback' | null;

// ── Sidecars ──────────────────────────────────────────────────────────────────

/** The HTTP services the document pipeline calls out to, with the health path each one exposes. */
const SIDECARS: Array<{ key: string; label: string; envVar: string; fallback: string; healthPath: string }> = [
  { key: 'unstructured', label: 'Document converter', envVar: 'CONVERSION_SIDECAR_URL', fallback: 'http://localhost:8000', healthPath: '/healthcheck' },
  { key: 'doc-render', label: 'Page renderer', envVar: 'RENDER_SIDECAR_URL', fallback: 'http://localhost:8100', healthPath: '/health' },
  { key: 'doc-office', label: 'Office renderer', envVar: 'RENDER_OFFICE_SIDECAR_URL', fallback: 'http://localhost:8101', healthPath: '/health' },
];

async function probeSidecar(s: (typeof SIDECARS)[number]): Promise<SidecarStatus> {
  const url = (process.env[s.envVar] ?? s.fallback).replace(/\/$/, '');
  const base = { key: s.key, label: s.label, envVar: s.envVar, url };
  const started = Date.now();
  try {
    // Plain fetch, deliberately: the SSRF policy governs operator-supplied model endpoints, not
    // infrastructure the deployment defines for itself. These URLs come from env, not from a user.
    const res = await fetch(`${url}${s.healthPath}`, { method: 'GET', signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    if (res.ok) return { ...base, state: 'ok', latencyMs };
    return { ...base, state: 'down', latencyMs, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ...base, state: 'down', latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Model stages ──────────────────────────────────────────────────────────────

export interface StageSpec {
  key: string;
  label: string;
  /**
   * Which protocol this endpoint speaks, so the probe derives the same URL inference will.
   *
   * Only a *local* vision provider speaks Ollama's; everything else is OpenAI-compatible. Absent means
   * `openai`, which is the safe default — it is what self-hosted inference servers overwhelmingly serve.
   */
  wire?: ChatWire;
  model?: string;
  baseUrl?: string;
  /** Never appears in the response — it exists only to authenticate the probe. */
  apiKey?: string;
  external: boolean;
}

/**
 * What a probe of one endpoint concluded. `blocked` is a refusal to probe, not a failed probe.
 *
 * `verdict` is the field to branch on — see `ProbeVerdict`. `reachable` cannot express the distinction
 * that matters here, because "answered with a 404 on the list path" and "did not answer" were both false.
 */
export type ProbeOutcome =
  | { blocked: true }
  | { reachable: boolean; verdict: ProbeVerdict; status?: number; models?: string[]; detail?: string; latencyMs: number };

/**
 * Every model-backed stage there is. The canonical enumeration.
 *
 * Declared rather than inferred because the Models screen has now under-reported the pipeline three
 * times: #549 added the office renderer and the contradiction judge after a customer noticed, and a
 * later report enumerated **nine** endpoints from that screen and missed `vlmModel` — which has no card,
 * while the Pipelines tab deep-links its step to the *vision* card showing a different value. Each time
 * the fix was another card; nothing ever proved the list complete.
 *
 * A grep cannot do it either: the document stages build their keys as `doc-${slot}`, so the literals do
 * not exist in the source. So the set is written down here, `modelStages()` is checked against it, and a
 * test asserts every entry has somewhere to appear in the UI. Adding a stage without a card now fails.
 */
export const MODEL_STAGE_KEYS = [
  'embedding', 'vision', 'stt',
  'doc-vlm', 'doc-repair', 'doc-verify',
  'assist', 'rerank', 'nli',
] as const;

export type ModelStageKey = (typeof MODEL_STAGE_KEYS)[number];

/** Every model-backed stage, resolved from config. Stages sharing an endpoint are probed once. */
function modelStages(): StageSpec[] {
  const media = getMediaEmbeddingConfig();
  const emb = getEmbeddingConfig();
  const doc = getDocumentProcessingConfig();
  return [
    // A blank embedding baseUrl means the bundled in-process ONNX model — no endpoint to reach.
    { key: 'embedding', label: 'Text embedding', model: emb.model, baseUrl: emb.baseUrl ?? undefined, apiKey: getEmbeddingApiKey(), external: emb.provider === 'external' },
    // The only Ollama-protocol target: a LOCAL vision provider. Its base is a bare host and its routes
    // live under `/api/`; every other target here is OpenAI-compatible.
    //
    // (Written without a star after that slash on purpose: several checks strip block comments with a
    // non-greedy `/*…*/` match, and a `/*` inside a line comment swallows everything to the next `*/`.
    // That is not hypothetical — it is what turned this file's own egress test red.)
    { key: 'vision', label: 'Vision', model: media.vision?.model, baseUrl: media.vision?.baseUrl, apiKey: media.vision?.apiKey, external: media.visionProvider === 'external', wire: media.visionProvider === 'external' ? 'openai' : 'ollama' },
    { key: 'stt', label: 'Speech-to-text', model: media.stt?.model, baseUrl: media.stt?.baseUrl, apiKey: media.stt?.apiKey, external: media.sttProvider === 'external' },
    // The document stages fall back to the vision endpoint exactly as the pipeline itself does, so the
    // dot reports the endpoint that would really be called rather than the one nominally configured.
    //
    // `external` comes from the SAME resolver the extractor uses. It used to be hardcoded `false` on all
    // three — on a `baseUrl` that falls back to the vision endpoint, which the line above classifies with
    // `visionProvider === 'external'`. Same URL, opposite verdicts, and since `probeModelEndpoint`
    // branches `external ? ssrfSafeFetch : fetch`, three stages probed an off-instance host over an
    // unguarded fetch (and skipped the route's `isSsrfSafeUrl` pre-check with it).
    ...(['vlm', 'repair', 'verify'] as const).map(slot => {
      const e = resolveVlmEndpoint(slot);
      return {
        key: `doc-${slot}` as const,
        label: slot === 'vlm' ? 'Document VLM' : slot === 'repair' ? 'Document repair' : 'Document verify',
        model: e.model || undefined,
        baseUrl: e.baseUrl || undefined,
        apiKey: e.apiKey,
        external: e.external,
        wire: e.wire,
      };
    }),
    // The assist model is external by definition — it is the one path that sends content off-instance.
    { key: 'assist', label: 'Assist model', model: doc.assistModel?.model, baseUrl: doc.assistModel?.baseUrl, apiKey: getDocAssistApiKey(), external: true,
      wire: doc.assistModel?.api ?? 'openai' },
    // Its fallback (`F-33`), on the board for the reason the primary is: when it is down, a spent budget or a
    // failing primary has nowhere to go, and the calls fail back to whatever ran before there was an assist model.
    { key: 'assist-fallback', label: 'Assist model fallback', model: doc.assistModel?.fallback?.model, baseUrl: doc.assistModel?.fallback?.baseUrl,
      apiKey: getDocAssistFallbackApiKey(), external: !!doc.assistModel?.fallback?.baseUrl && !isLocalModelEndpoint(doc.assistModel.fallback.baseUrl),
      wire: doc.assistModel?.fallback?.api ?? 'openai' },
    // The reranker is a RETRIEVAL stage, not an ingestion one, but it belongs on the same board: it is
    // model-backed, optional, and when it is unreachable searches quietly get worse rather than fail —
    // which is precisely the condition this endpoint exists to make visible.
    { key: 'rerank', label: 'Reranker', model: media.rerank?.model, baseUrl: media.rerank?.baseUrl, apiKey: getRerankApiKey(), external: !!media.rerank?.baseUrl && !isLocalModelEndpoint(media.rerank.baseUrl) },
    // The contradiction judge, on the board for exactly the reranker's reason and one more: it is the
    // only model here whose absence produces a view that looks FINISHED. An unreachable reranker gives
    // worse ordering; an unreachable judge gives an empty Contradictions list, which is indistinguishable
    // from "nothing contradicts". It was configurable from the first release and never probed, so there
    // was no way to tell those two apart from inside the app.
    { key: 'nli', label: 'Contradiction judge', model: media.nli?.model, baseUrl: media.nli?.baseUrl, apiKey: getNliApiKey(), external: !!media.nli?.baseUrl && !isLocalModelEndpoint(media.nli.baseUrl) },
  ];
}

/** Host of a URL, or the URL itself when it will not parse. Never the path or query. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return url; }
}

/**
 * The egress slot a stage's calls belong to — what decides whether that endpoint may resolve privately.
 *
 * The document stages spell their keys `doc-vlm`/`doc-repair`/`doc-verify` (built as `doc-${slot}`), so
 * this is the one place the kebab key and the camelCase policy slot are reconciled.
 */
export function slotForStage(key: string): EgressSlot {
  const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return (EGRESS_SLOTS as readonly string[]).includes(camel) ? camel as EgressSlot : 'assist';
}

/**
 * The key identifying one endpoint+credential pair. Stages sharing it share a single probe.
 *
 * The resolved egress permission is part of the identity, not an afterthought. Two stages can point at the
 * same base URL and still disagree about whether it may resolve to a private address — that is precisely
 * the per-slot setting doing its job — and collapsing them into one probe would report the strict stage's
 * verdict using the permissive stage's policy (or the reverse). Identical policy, which is the normal case,
 * still yields one probe.
 */
export function endpointId(s: StageSpec): string {
  return `${s.baseUrl} ${s.external} ${s.apiKey ?? ''} ${allowPrivateForSlot(slotForStage(s.key))}`;
}

/**
 * Group the stages that need probing by DISTINCT endpoint.
 *
 * The document VLM, repair and verify stages normally point at the same Ollama, so probing per stage
 * would triple the load on the very process that is also transcribing pages. Stages with no model or
 * no endpoint are dropped — there is nothing to ask.
 */
export function groupStagesByEndpoint(stages: StageSpec[]): Map<string, StageSpec[]> {
  const byEndpoint = new Map<string, StageSpec[]>();
  for (const s of stages) {
    if (!s.model || !s.baseUrl) continue;
    const id = endpointId(s);
    const group = byEndpoint.get(id);
    if (group) group.push(s); else byEndpoint.set(id, [s]);
  }
  return byEndpoint;
}

/**
 * Turn one stage plus its endpoint's probe outcome into a reportable status.
 *
 * Pure, and deliberately the only place a `HealthState` is chosen. The distinction between "nothing
 * configured", "configured but unreachable" and "reachable but not serving that model" is the whole
 * value of the screen, and three symptoms that all look like "extraction produced nothing" collapse
 * back into one the moment this logic is spread across call sites.
 *
 * The result is built field by field rather than by spreading `s`, because `s` carries the API key.
 * A spread here would leak it into the response, so there is a test pinning exactly that.
 */
export function classifyStage(s: StageSpec, res: ProbeOutcome | undefined): ModelStageStatus {
  const base = { key: s.key, label: s.label, model: s.model || null, endpoint: hostOf(s.baseUrl), external: s.external };
  if (!s.model) return { ...base, state: 'unconfigured' };
  // No endpoint + a model name = the bundled in-process model. There is nothing to reach, and
  // reporting it as `down` would put a red dot on the one component that cannot fail that way.
  if (!s.baseUrl) return { ...base, state: 'ok', detail: 'in-process' };
  if (!res) return { ...base, state: 'unconfigured' };
  if ('blocked' in res) return { ...base, state: 'blocked', detail: 'endpoint is not a public http(s) URL (SSRF-blocked)' };

  // Nothing usable answered — down, whatever else the outcome carries. (`erroring`, a 5xx, sets this: the
  // server is present and broken, which is about the endpoint rather than about the path.)
  if (!res.reachable) return { ...base, state: 'down', latencyMs: res.latencyMs, detail: res.detail };

  // It answered. From here the dot depends on WHAT it answered — the probe ranks that (see `ProbeVerdict`)
  // and this reads the ranking rather than re-deriving it from a boolean.

  // A rejected credential is red even though the endpoint answered: inference presents the same one.
  if (res.verdict === 'auth-rejected') {
    return { ...base, state: 'down', latencyMs: res.latencyMs, detail: res.detail };
  }

  // No model-list route. This used to be `down` and should never have been: a 404 on the enumeration path
  // says nothing about the route this stage actually calls, and it pinned a red dot on a transcription
  // service that was working — a slot whose endpoint serves exactly one path can never satisfy a list probe.
  if (res.verdict === 'not-enumerable') {
    return { ...base, state: 'ok', latencyMs: res.latencyMs, detail: res.detail };
  }

  // Answered on the OTHER wire. The probe knows inference will use the protocol this one did NOT answer,
  // and it said so — but that verdict was dropped here, so a stage whose provider type is set wrong showed
  // a plain green dot with the explanation discarded. It is the one case where the endpoint answered and a
  // failure is nonetheless established, which is what `degraded` is for.
  if (res.verdict === 'listed' && res.detail) {
    return { ...base, state: 'degraded', latencyMs: res.latencyMs, detail: res.detail };
  }

  // The endpoint answered — but does it serve the model this stage names? Ollama tags carry a `:tag`
  // suffix, so an exact match or a `<model>:` prefix both count. An endpoint that lists nothing is not
  // evidence either way, so it stays `ok` rather than being accused of a missing model.
  const models = res.models ?? [];
  const enumerated = models.length === 0 ? undefined : models.some(m => m === s.model || m.startsWith(`${s.model}:`));

  /**
   * Absence from a model list is NOT evidence of a missing model.
   *
   * This used to return `degraded`, and the field it read was called `modelPresent` — a name asserting
   * something the check never established. Aliasing routers (llama-swap roles), gateways, LiteLLM,
   * Azure deployment names: all routinely serve names they deliberately do not enumerate, precisely so
   * that internal role names stay out of user-facing pickers. A reporter's vision endpoint was fully
   * working and permanently yellow for exactly that reason, and their assist model still is.
   *
   * Three outcomes are distinguishable here and only one of them is a fault:
   *   - unreachable            → genuinely down (handled above)
   *   - reachable, listed      → good evidence, though still not proof it will load
   *   - reachable, NOT listed  → *no information at all*
   *
   * Reporting the third as degraded manufactures a warning out of an absence of evidence — the same
   * dishonesty `health-summary.ts` already refuses one file over, where a component nobody configured
   * is explicitly not a problem. So it stays `ok`, and says what it saw.
   *
   * The honest way to answer "does my configured model actually work" is one real request against it,
   * which is what the Verify action is for.
   */
  if (enumerated === false) {
    return {
      ...base, state: 'ok', latencyMs: res.latencyMs,
      detail: `endpoint reachable; "${s.model}" is not enumerated by this endpoint (normal for aliasing routers and gateways) — use Verify to check it actually answers`,
    };
  }
  return { ...base, state: 'ok', latencyMs: res.latencyMs };
}

async function probeModelStages(): Promise<ModelStageStatus[]> {
  const stages = modelStages();
  const byEndpoint = groupStagesByEndpoint(stages);

  const results = new Map<string, ProbeOutcome>();
  await Promise.all([...byEndpoint.entries()].map(async ([id, group]) => {
    const { baseUrl, external, apiKey } = group[0];
    // Every stage in the group resolved to the same permission — it is part of `endpointId`.
    const slot = slotForStage(group[0].key);
    if (external && !isSsrfSafeUrl(baseUrl!, allowPrivateForSlot(slot))) {
      results.set(id, { blocked: true });
      return;
    }
    // No `model` is passed: one probe serves several stages, so the per-stage match happens in
    // classifyStage against the returned list.
    //
    // `wire` is what makes the probe agree with inference. Without it every endpoint was tried as
    // `/v1/models` first, which is right for four targets and wrong for the one whose base already
    // carries `/v1` — producing `/v1/v1/models` and a red dot over a working vision pipeline.
    const res = await probeModelEndpoint({ baseUrl: baseUrl!, apiKey, external, wire: group[0].wire, slot })
      .catch(err => ({ reachable: false, verdict: 'unreachable' as const, detail: err instanceof Error ? err.message : String(err), latencyMs: 0 }));
    results.set(id, res);
  }));

  return stages.map(s => classifyStage(s, results.get(endpointId(s))));
}

// ── Vector index ──────────────────────────────────────────────────────────────

/**
 * Collapse a space's per-collection listing into one live state.
 *
 * `unknown` outranks everything: a deployment whose MongoDB has no Atlas Search support throws on
 * every listing, and calling that `missing` would paint every space red on an instance where nothing
 * is wrong. Absence of evidence is reported as absence of evidence.
 */
export function deriveLiveIndexState(collections: CollectionIndexStatus[], listingFailed: boolean): SpaceIndexStatus['live'] {
  if (listingFailed) return 'unknown';
  /*
   * OPTIONAL INDEXES DO NOT DECIDE THIS, and that is the third view of one failure.
   *
   * `missing` drives a red pill per space, sets the whole Tools tab to `down`, and — because `stored` is
   * `ready` — trips `isDrifted`, which this file calls "the silent-loss signature". The canary operator ran
   * `FACE_RECOGNITION_ENABLED=true` fleet-wide with nothing able to write a face vector, so all three fired on
   * fourteen working spaces at once, permanently.
   *
   * A space with every search index READY and no face gallery is a healthy space. Its optional index is still
   * in `collections` with its own status, so nothing is hidden — it just does not get a vote.
   */
  const deciding = collections.filter(c => !c.optional);
  if (deciding.some(c => c.status === null)) return 'missing';
  return deciding.every(c => c.status === 'READY') ? 'ready' : 'building';
}

/**
 * The silent-loss signature: config says the space is ready, the database says otherwise.
 *
 * Only flagged in that direction. `stored: 'building'` with a live `ready` is the normal race right
 * after a space is created — the background finalizer simply has not written its result yet — and
 * flagging it would train the operator to ignore the badge that matters.
 */
export function isDrifted(stored: SpaceIndexStatus['stored'], live: SpaceIndexStatus['live']): boolean {
  return stored === 'ready' && (live === 'missing' || live === 'building');
}

async function indexStatus(): Promise<{ spaces: SpaceIndexStatus[]; unavailable?: string }> {
  let spaces;
  try { spaces = getConfig().spaces; } catch { return { spaces: [], unavailable: 'configuration is not loaded' }; }

  // Face recognition is gated per space by the image ladder (its `recognition` rung) under the instance
  // ceiling, with `enabled` surviving only as the infra pin — so whether a space should HAVE a face index
  // is a per-space question now, not one instance-wide flag.
  const faceInfraPin = getFaceRecognitionConfig().enabled;
  const db = (() => { try { return getDb(); } catch { return null; } })();
  if (!db) return { spaces: [], unavailable: 'database is not connected' };

  const out = await Promise.all(spaces
    // Proxy spaces aggregate other spaces' reads and own no collections, so they have no indexes to
    // be missing. Listing them would pin a permanent red dot on a space that is working correctly.
    .filter(s => !s.proxyFor)
    .map(async (space): Promise<SpaceIndexStatus> => {
      const expected: Array<{ collection: string; indexName: string; optional?: boolean }>
        = VECTOR_INDEXED_COLLECTIONS.map(suffix => ({
          collection: suffix, indexName: `${space.id}_${suffix}_embedding`,
        }));
      if (faceInfraPin && faceRecognitionAllowed(space.id)) {
        // `optional`, so its absence is reported without condemning the space — see `deriveLiveIndexState`.
        expected.push({ collection: 'files', indexName: `${space.id}_files_faceEmbedding`, optional: true });
      }

      const collections: CollectionIndexStatus[] = [];
      let listingFailed = false;
      // List each collection ONCE, unfiltered, and match by name — the same correction made in
      // `pollVectorIndexReady`. The name-filtered overload returned nothing on the reporting
      // deployment, so `found[0]?.status` was always null, and `deriveLiveIndexState` turns a null
      // status into **missing** — meaning this panel declared every index absent on an instance whose
      // indexes were fine. Unfiltered listing is what `ensureVectorIndex` uses and it works.
      //
      // Once per collection rather than once per expected index: `files` carries two (embedding and
      // faceEmbedding), and listing it twice doubled the mongot round-trips for no benefit.
      const byCollection = new Map<string, typeof expected>();
      for (const e of expected) {
        const list = byCollection.get(e.collection) ?? [];
        list.push(e);
        byCollection.set(e.collection, list);
      }
      await Promise.all([...byCollection.entries()].map(async ([collection, entries]) => {
        try {
          const all = await db.collection(`${space.id}_${collection}`).listSearchIndexes().toArray() as Array<{ name?: string; status?: string }>;
          for (const e of entries) {
            collections.push({ ...e, status: all.find(i => i.name === e.indexName)?.status ?? null });
          }
        } catch (err) {
          listingFailed = true;
          log.debug(`pipeline-status: could not list search indexes for ${space.id}_${collection}: ${err instanceof Error ? err.message : String(err)}`);
          for (const e of entries) collections.push({ ...e, status: null });
        }
      }));

      const stored = space.indexStatus ?? 'unknown';
      const live = deriveLiveIndexState(collections, listingFailed);
      return { id: space.id, label: space.label, stored, live, collections, drifted: isDrifted(stored, live) };
    }));

  /*
   * AN INSTANCE THAT ANSWERS NOTHING IS NOT AN INSTANCE WITH NOTHING.
   *
   * `listSearchIndexes` is the Atlas Search API. On a self-hosted replica set running `$vectorSearch`
   * natively there is no `mongot` behind it, so the call SUCCEEDS and returns an empty list — no error to
   * catch, `listingFailed` stays false, every status is null, and `deriveLiveIndexState` reads null as
   * `missing`. Every space then drifts, the tab turns red, and each row offers a Rebuild.
   *
   * Reported by the canary operator 2026-09-06: fifteen spaces declared missing while recall against those
   * exact spaces returned correctly ranked results with real cosine scores, and `find_similar` — pure
   * vector, no lexical channel — worked too. The vectors existed and were being searched.
   *
   * **The severity was the button.** They measured a 79-file re-ingest on that host: embedding went from
   * 80 ms to 2–9 seconds and stayed there for forty minutes, starving the reranker. Fifteen spaces would be
   * hours of degradation, on a false positive, one click per row.
   *
   * So: if not one search index is found ANYWHERE — no space, no collection — the probe did not answer.
   * That is indistinguishable from an instance where the API is unsupported, and `missing` claims knowledge
   * this code does not have. It reports `unknown` instead, which `isDrifted` does not flag and the tab does
   * not offer to rebuild.
   *
   * **Why "anywhere" and not per space.** One space with no indexes among many that have them is a real
   * missing index and still reports as one. It is the total silence that means the question was not
   * answered — a working instance that has ever embedded anything has at least one.
   */
  const anyIndexSeen = out.some(s => s.collections.some(c => c.status !== null));
  if (out.length > 0 && !anyIndexSeen) {
    return {
      spaces: out.map(s => ({ ...s, live: 'unknown' as const, drifted: false })),
      unavailable: 'this deployment does not report search indexes — `listSearchIndexes` returned nothing '
        + 'for every collection, which a native `$vectorSearch` server does. Recall is unaffected and is the '
        + 'thing to check: if it returns ranked results, the vectors are there.',
    };
  }

  return { spaces: out };
}

// ── Assembly, cached and single-flighted ──────────────────────────────────────

let cached: { at: number; value: PipelineStatus } | null = null;
let inFlight: Promise<PipelineStatus> | null = null;

async function collect(): Promise<PipelineStatus> {
  const face = getFaceRecognitionConfig();
  const [sidecars, models, index] = await Promise.all([
    Promise.all(SIDECARS.map(probeSidecar)),
    probeModelStages(),
    indexStatus(),
  ]);
  const assistConfigured = !!getDocumentProcessingConfig().assistModel?.baseUrl;
  return {
    checkedAt: new Date().toISOString(),
    sidecars,
    models,
    index,
    ...(assistConfigured ? { assist: {
      answeredBy: { repair: assistBackend('repair')?.which ?? null, conversations: assistBackend('conversations')?.which ?? null },
      ...assistBudgetStatus(),
    } } : {}),
    // Face recognition runs in-process (BlazeFace + FaceRes), so there is no endpoint to probe —
    // enabled or not is the whole of its health.
    // 'ok' only when the infra pin allows it AND at least one space actually sits at the recognition rung
    // — reporting 'ok' off a flag no operator can see any more would be a health light for nothing.
    faceRecognition: {
      state: face.enabled && (() => {
        try { return getConfig().spaces.some(s => faceRecognitionAllowed(s.id)); } catch { return false; }
      })() ? 'ok' : 'off',
    },
  };
}

/** Cached + single-flighted: several admins on this screen must not multiply the outbound probes. */
export async function getPipelineStatus(): Promise<PipelineStatus> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = collect()
    .then(value => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

pipelineStatusRouter.use(globalRateLimit);

// requireAdmin, not requireAdminMfa: this reads status and mutates nothing. It does disclose which
// models and hosts are configured, which is admin-only information — so not anonymous either.
pipelineStatusRouter.get('/', requireAdmin, async (_req, res) => {
  try {
    res.json(await getPipelineStatus());
  } catch (err) {
    log.warn(`pipeline-status failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Failed to collect pipeline status' });
  }
});
