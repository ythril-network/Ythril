/**
 * VLM client for document transcription (F11).
 *
 * Sends a rendered page image + a strict verbatim-transcription prompt to an Ollama vision model
 * (`/api/chat` with `images`), mirroring the media vision provider's request shape. Output is bounded
 * (`num_predict`) and temperature 0 for determinism. Throws on unreachable/error so the extractor can
 * fall back to OCR.
 *
 * `repairMarkdown` uses the bundled local Ollama (no egress). `repairMarkdownExternal` (F11-b) is the ONE
 * path that sends document content OFF the instance — to an operator-configured external OpenAI-compatible
 * "assist model" — so it is routed through `ssrfSafeFetch` and is only reached after an explicit egress
 * acknowledgment (enforced at config-save time).
 */
import { ssrfSafeFetch } from '../../util/ssrf.js';
import { modelFetch } from '../../util/model-fetch.js';
import { chatOnce, type ChatWire } from '../../util/model-chat.js';
import { boundedJson, boundedErrorText } from '../../util/bounded-read.js';
import { allowPrivateForSlot, type EgressSlot } from '../../config/model-egress-policy.js';
import { chatUrlFor, type VlmWire } from './vlm-endpoint.js';
import { slotTimeoutMsOr, reasoningEffortBody } from '../../config/model-slots.js';
import { getModelSlots } from '../../config/loader.js';

export interface VlmTranscription {
  text: string;
  /** True when the model hit its output cap (Ollama `done_reason === 'length'`) — signals truncation. */
  truncated: boolean;
  /** The reply's reported token usage, when an OpenAI-wire endpoint sent one — what the assist budget is charged (`F-33`). */
  usage?: Record<string, unknown>;
}

/** A model's HTTP refusal, with the status — what `viaAssist` reads to tell "not now" from "not this" (`F-33`). */
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const MAX_OUTPUT_TOKENS = 4096; // bound per-page output so a hostile page can't drive unbounded generation

/** One chat turn, before it is serialised for a particular wire. `images` are base64, image-only turns. */
interface ChatTurn { role: 'user'; content: string; images?: string[] }

/**
 * POST one non-streamed chat turn, on whichever wire the endpoint speaks.
 *
 * ## Why this branches
 *
 * It used to hardcode Ollama's `/api/chat`, which meant `vlmModel` could not work against **any**
 * OpenAI-compatible server — llama.cpp, llama-swap, vLLM, LocalAI all 404 that route, and no `baseUrl`
 * fixes it because dropping `/v1` merely yields `/api/chat` again. doc-render rasterised pages that were
 * then thrown away.
 *
 * ## Why every non-bundled call is guarded
 *
 * It also used a bare `fetch`. That was written when the VLM was the bundled local Ollama and the file
 * said so — *"repairMarkdown uses the bundled local Ollama (no egress)"*. `visionProvider: external`
 * falsified it, because an empty `vlmBaseUrl` means "reuse the vision endpoint": page images then went to
 * an off-instance host with no SSRF guard and no egress acknowledgement. It failed safe only against
 * OpenAI-compatible targets; a **remote Ollama** answers `/api/chat` with 200, so those deployments were
 * egressing silently while the pipeline reported success.
 *
 * So the guard follows the ENDPOINT, not the wire: an Ollama that is not ours gets the same treatment as
 * an OpenAI one. The bundled local path keeps its plain `fetch` — guarding it would refuse the default
 * deployment, whose model sits on a private cluster address.
 */
async function postChat(
  endpoint: { baseUrl: string; model: string; wire: ChatWire; external: boolean; apiKey?: string; slot: EgressSlot },
  turns: ChatTurn[],
  timeoutMs: number,
): Promise<VlmTranscription> {
  // Guard on for an endpoint that is not ours: DNS-resolve, IP-pin, redirect re-validation, crown-jewel ranges
  // blocked. `allowPrivate` only lifts the private-address rejection, so a self-hosted model on a cluster address
  // still works. Resolved for THIS slot: transcription and repair can sit on different hosts, and the document VLM
  // being on-cluster is no reason to let the assist model reach a private address. The request and the reply are
  // `util/model-chat.ts`'s, the same for every wire — the Claude API included (`F-33.1`).
  const post = async (url: string, request: RequestInit) => {
    const init = { ...request, signal: AbortSignal.timeout(timeoutMs) };
    return endpoint.external
      ? await ssrfSafeFetch(url, init, { allowPrivate: allowPrivateForSlot(endpoint.slot) })
      : await fetch(url, init);
  };
  const r = await chatOnce(
    { wire: endpoint.wire, baseUrl: endpoint.baseUrl, model: endpoint.model, ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}) },
    {
      turns: turns.map(t => ({ role: t.role, content: t.content, ...(t.images ? { images: t.images } : {}) })),
      maxTokens: MAX_OUTPUT_TOKENS,
      // Only when the operator set one for this slot: absent sends no field at all, because a model never trained
      // for it ignores the parameter at best and fails the request at worst.
      openAiExtras: reasoningEffortBody(endpoint.slot, getModelSlots()),
    },
    { post },
    (message, status) => (status !== undefined ? httpError(`VLM ${message}`, status) : new Error(`VLM ${message}`)),
  );
  return { text: r.text, truncated: r.truncated, ...(r.usage ? { usage: r.usage } : {}) };
}

/**
 * How an endpoint is described to this module.
 *
 * `wire` and `external` default to the bundled-Ollama shape, so a caller that passes only
 * `baseUrl`/`model` gets byte-for-byte the pre-unification behaviour. That is deliberate: it keeps the
 * local path's existing tests meaningful as a regression net rather than something rewritten to fit.
 */
export interface VlmTarget {
  baseUrl: string;
  model: string;
  wire?: ChatWire;
  external?: boolean;
  apiKey?: string;
  /**
   * The budget to use when the OPERATOR has not set one for this slot — never an override of one.
   *
   * It replaced a plain `timeoutMs`, and the rename is the fix rather than a tidy-up. The document
   * pipeline passed its per-page control here and the clients resolved `opts.timeoutMs ?? slotTimeoutMs(…)`,
   * so the caller's number won every time and `modelSlots.docVlm|docRepair|docVerify|assist` were inert
   * while being documented, patchable and pinnable. Both defaults are 60 s, so nothing ever disagreed.
   *
   * `pageTimeoutMs` keeps its meaning as exactly this: what a document page call costs when nobody chose
   * per-slot. A caller that genuinely owns its deadline says `hardTimeoutMs` instead, out loud.
   */
  defaultTimeoutMs?: number;
  /**
   * A deadline the CALLER owns, whatever the operator set for the slot.
   *
   * Two callers have one and both have a reason the slot cannot express. The Verify button must answer in
   * seconds while a slot budget may legally be half an hour. `describeTimeoutMs` is a deliberately tight
   * budget for one short call on the ingest path, settable through config, env and the admin API in its own
   * right — folding it into `docRepair` would hand a document description the repair pass's budget, which
   * exists for a much longer job.
   *
   * A separate name so the shadowing defect cannot come back by accident: `budgetFor` is the only place a
   * caller value may precede the resolver, and a gate refuses any other identifier in that position.
   */
  hardTimeoutMs?: number;
  /**
   * Which model slot this call belongs to. Defaults to `docVlm`, which is what every caller got before.
   *
   * It exists because `docVerify` did not. That slot is declared in `MODEL_SLOTS`, carries a default budget,
   * is accepted by the admin PATCH, is pinnable through `YTHRIL_PINNED_FIELDS` and is documented in the
   * field table — and no code resolved it. The second-opinion pass runs against its OWN endpoint, a
   * deliberately different model, and then charged everything to `docVlm`: its budget, its egress
   * permission, and now its reasoning effort. An operator who set `modelSlots.docVerify` got no effect and
   * no warning, which is the failure shape this repository keeps paying for — a control that looks applied
   * and never was.
   */
  slot?: EgressSlot;
}

/**
 * The budget for one call: the caller's own deadline if it claimed one, else the operator's slot setting,
 * else the caller's default, else the built-in.
 *
 * The ONE place in this module where a caller value may sit in front of the resolver, and it exists so that
 * there is one. Written at each entry point instead, `opts.timeoutMs ?? slotTimeoutMs(...)` is what four
 * slots shipped as — documented, patchable, pinnable and inert, because `??` takes the left side whenever it
 * is present and the document pipeline always supplied one.
 */
const budgetFor = (slot: EgressSlot, opts: { hardTimeoutMs?: number; defaultTimeoutMs?: number }): number =>
  opts.hardTimeoutMs ?? slotTimeoutMsOr(slot, getModelSlots(), opts.defaultTimeoutMs);

const asEndpoint = (t: VlmTarget, slot: EgressSlot) => ({
  baseUrl: t.baseUrl,
  model: t.model,
  wire: t.wire ?? 'ollama' as ChatWire,
  external: t.external ?? false,
  apiKey: t.apiKey,
  slot,
});

/** Transcribe one page image to Markdown. Throws on unreachable/HTTP error so the caller falls back. */
export async function transcribePageImage(
  imageBytes: Buffer,
  opts: VlmTarget & { prompt: string },
): Promise<VlmTranscription> {
  const b64 = imageBytes.toString('base64');
  // The caller's slot, or the one every caller had before. `transcribePageImage` serves both the primary
  // transcription and the verify pass, on different endpoints and different models.
  const slot = opts.slot ?? 'docVlm';
  return postChat(
    asEndpoint(opts, slot),
    [{ role: 'user', content: opts.prompt, images: [b64] }],
    budgetFor(slot, opts),
  );
}

const REPAIR_PROMPT =
  'You are correcting a Markdown transcription of a document page. You are given the DRAFT transcription ' +
  'and the OCR TEXT of the same page. The draft may have dropped or garbled content that the OCR captured. ' +
  'Produce a corrected GitHub-Flavored Markdown that keeps the draft\'s structure and formatting but ' +
  'restores any content present in the OCR that the draft is missing. Do NOT summarize, translate, ' +
  'reorder, or invent content, and do not add commentary. Output only the corrected Markdown.';

/** Reconcile a draft VLM transcription against the OCR evidence in one text-only pass (max-mode repair).
 *  Throws on unreachable/HTTP error so the caller can fall back to OCR. */
export async function repairMarkdown(
  opts: VlmTarget & { draft: string; evidence: string; issues?: string[] },
): Promise<VlmTranscription> {
  // Its own slot, honoured the same way the other entry points honour theirs — three call sites resolving a
  // slot two different ways is how one of them ends up wrong.
  const slot = opts.slot ?? 'docRepair';
  return postChat(
    asEndpoint(opts, slot),
    [{ role: 'user', content: repairContent(opts.draft, opts.evidence, opts.issues) }], // text-only — no page image
    budgetFor(slot, opts),
  );
}

const CONSENSUS_PROMPT =
  'You are reconciling TWO independent Markdown transcriptions (DRAFT A and DRAFT B) of the SAME document ' +
  'page, with the OCR TEXT of that page as ground truth. Produce a single best GitHub-Flavored Markdown ' +
  'transcription: keep content both drafts agree on; where they differ, prefer the reading supported by the ' +
  'OCR TEXT; include content that either draft captured and the OCR confirms. Do NOT summarize, translate, ' +
  'reorder, or invent content, and do not add commentary. Output only the reconciled Markdown.';

/** Reconcile two independent transcriptions of the same document against the OCR evidence (F11-d consensus).
 *  Text-only, temperature 0, via the local model. Throws on unreachable/HTTP error so the caller can keep the
 *  primary draft. */
export async function reconcileConsensus(
  opts: VlmTarget & { draftA: string; draftB: string; evidence: string },
): Promise<VlmTranscription> {
  const content =
    `${CONSENSUS_PROMPT}\n\n--- DRAFT A ---\n${opts.draftA}\n\n--- DRAFT B ---\n${opts.draftB}\n\n--- OCR TEXT ---\n${opts.evidence}`;
  // Consensus runs on whichever endpoint its caller passed, so it takes that caller's slot for the same
  // reason transcription does — the comment here used to say "the same VLM endpoint as transcription", which
  // was true of the primary path and not of the one that reconciles against the verify model.
  const slot = opts.slot ?? 'docVlm';
  return postChat(
    asEndpoint(opts, slot),
    [{ role: 'user', content }], // text-only — no page image
    budgetFor(slot, opts),
  );
}

const DESCRIBE_PROMPT =
  'You are writing a one-paragraph description of a document, for a file listing. Say what KIND of ' +
  'document it is, who it is between or from, its date if one is stated, and what it concerns. Two ' +
  'sentences at most, plain prose, no Markdown, no heading, no preamble, no bullet points. Use ONLY facts ' +
  'stated in the text below: if something is not there, leave it out — do not guess and do not describe ' +
  'what the document might be. Answer with the description only.';

/**
 * Describe a document in one short paragraph — text-only, and the same call for either target.
 *
 * The slot is the caller's to choose because that is what decides the egress policy: the local document
 * model (`docRepair`, the text-only document slot) or the operator's acknowledged assist model (`assist`).
 * Both already receive document text on the repair path, so this adds no new egress surface — which is the
 * reason it is one function taking a target rather than a local/external pair like `repairMarkdown*`.
 *
 * Throws on unreachable/HTTP error, like every other call here, so the caller falls back.
 */
export async function describeDocumentText(
  opts: VlmTarget & { text: string; slot?: EgressSlot },
): Promise<VlmTranscription> {
  return postChat(
    asEndpoint(opts, opts.slot ?? 'docRepair'),
    [{ role: 'user', content: `${DESCRIBE_PROMPT}\n\n--- DOCUMENT ---\n${opts.text}` }],
    budgetFor(opts.slot ?? 'docRepair', opts),
  );
}

/** Build the shared repair user-message content (draft + OCR evidence + flagged issues). */
function repairContent(draft: string, evidence: string, issues?: string[]): string {
  const flagged = issues?.length ? `\n\nValidation flagged: ${issues.join('; ')}.` : '';
  return `${REPAIR_PROMPT}${flagged}\n\n--- DRAFT ---\n${draft}\n\n--- OCR TEXT ---\n${evidence}`;
}

/**
 * F11-b — reconcile a draft against OCR evidence via an **external** OpenAI-compatible chat endpoint (the
 * operator-configured "assist model"). Routed through `ssrfSafeFetch` — this is the one path that sends
 * document content (draft + OCR text) off the instance — and Bearer-authenticated when an `apiKey` is given.
 * Throws on unreachable/HTTP error so the caller falls back to the local repair, then OCR.
 */
export async function repairMarkdownExternal(
  opts: { baseUrl: string; model: string; apiKey?: string; api?: 'openai' | 'anthropic'; draft: string; evidence: string; issues?: string[];
    /** See `VlmTarget.defaultTimeoutMs` — used only when the operator set no `assist` budget. */
    defaultTimeoutMs?: number;
    /** See `VlmTarget.hardTimeoutMs` — a deadline this caller owns whatever the operator set. */
    hardTimeoutMs?: number },
): Promise<VlmTranscription> {
  // An external endpoint gets the assist slot's private-address policy under the SSRF guard; a local one — the assist
  // model's fallback on a sidecar, typically (`F-33`) — is reached directly (`util/model-fetch.ts`). The request and
  // the reply are `util/model-chat.ts`'s, so the assist model can be a Claude model (`F-33.1`).
  const r = await chatOnce(
    { wire: opts.api ?? 'openai', baseUrl: opts.baseUrl, model: opts.model, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) },
    {
      turns: [{ role: 'user', content: repairContent(opts.draft, opts.evidence, opts.issues) }],
      maxTokens: MAX_OUTPUT_TOKENS,
      openAiExtras: reasoningEffortBody('assist', getModelSlots()),
    },
    { post: (url, init) => modelFetch(url, { ...init, signal: AbortSignal.timeout(budgetFor('assist', opts)) }, 'assist') },
    (message, status) => (status !== undefined ? httpError(`assist model ${message}`, status) : new Error(`assist model ${message}`)),
  );
  return { text: r.text, truncated: r.truncated, ...(r.usage ? { usage: r.usage } : {}) };
}
