/**
 * The converted document's description — generated prose, with the document's own words as the fallback.
 *
 * ## What was wrong
 *
 * `summariseMarkdown` (which this wraps) is **extractive**: it takes the head of the converted text. That
 * was the right first move — it made the parent record findable, where before its `matchedText` was
 * literally the filename — but on a real invoice the head of the text is a payment reference cut
 * mid-identifier, and the release note called the field *generated*. The images the same document produced
 * DO get generated captions, so the parent read as unfinished sitting beside its own children.
 *
 * ## What changed, and what deliberately did not
 *
 * `summariseMarkdown`'s own doc comment argues against generation, and the argument still holds: a
 * generated description can assert something the document does not say, and search will match it while a
 * reader believes it. So the extractive text does not go away — it is kept as the record's `excerpt`, which
 * is what feeds the embedding. The two fields want different things:
 *
 *   - `description`   — one short generated paragraph answering *what is this file?*
 *   - `excerpt`       — the document's own opening prose, never invented, always present
 *   - `matchedText`   — built from both, so recall matches a remembered phrase AND the semantics
 *
 * And because "generated" is a claim about provenance, the record says which one it got:
 * `descriptionSource: 'generated' | 'extracted'`. An instance with no model configured produces the
 * extractive text — which beats nothing — and must not call it generated.
 *
 * ## Egress
 *
 * Text goes to the local document model, or to the operator's assist model **only when its egress host is
 * acknowledged** — the same gate `vlm-extract` re-checks before routing a repair, re-checked here rather
 * than trusted, so a description can never become the thing that leaks a document. Both slots already
 * receive document text on the repair path; this adds no new egress surface.
 */

import { getDocumentProcessingConfig } from '../../config/loader.js';
import { log } from '../../util/log.js';
import { assistBackend, viaAssist, type AssistEndpoint } from '../../config/assist-backend.js';
import { isLocalModelEndpoint } from '../../config/model-egress-policy.js';
import { describeDocumentText } from './vlm-client.js';
import { resolveVlmEndpoint, vlmSlotUsable } from './vlm-endpoint.js';
import { summariseMarkdown } from './summarise.js';
import type { Chunk } from './types.js';

/** Where a description came from. `extracted` is the document's own opening text, taken verbatim. */
export type DescriptionSource = 'generated' | 'extracted';

export interface DocumentDescription {
  /** Absent when the document yielded nothing worth saying — better than a misleading sentence. */
  text?: string;
  source?: DescriptionSource;
  /** The document's own opening prose. Present whenever the text yielded any, whatever `source` says. */
  excerpt?: string;
}

/**
 * How much of the document the model is shown.
 *
 * The head, because that is where identity lives — letterhead, title, parties, date, subject line. Sending
 * the whole document would cost tokens on every upload to answer a question the first page answers, and on
 * a metered assist model it would cost money per page nobody reads.
 */
const MAX_INPUT_CHARS = 6_000;

/** Long enough for two real sentences, short enough that a rambling model cannot fill the card. */
const MAX_DESCRIPTION_CHARS = 400;

/**
 * A tight budget by default: this is on the ingest path, and the extractive fallback is always available.
 *
 * Configurable because "tight" depends on the backend, not on us. A single-GPU host that swaps models per
 * request has to UNLOAD the vision model this job was just using and load a chat model before it can answer,
 * and that load can be most of a minute — so at 30 s every document times out, keeps extractive text, and
 * logs one warning that reads like a broken model rather than a budget that is too small for this host.
 */
const DESCRIBE_TIMEOUT_DEFAULT_MS = 30_000;

/** The configured describe budget, clamped to the range the admin API accepts. */
export function describeTimeoutMs(cfg: { describeTimeoutMs?: number } = {}): number {
  const v = cfg.describeTimeoutMs;
  if (typeof v !== 'number' || !Number.isFinite(v)) return DESCRIBE_TIMEOUT_DEFAULT_MS;
  return Math.max(1_000, Math.min(600_000, Math.floor(v)));
}

/**
 * Openings that mean the model answered the wrong question.
 *
 * A refusal or a preamble stored as a description is worse than the extractive text, because it reads as
 * content. Matched at the START only — a document that genuinely discusses an AI assistant must not be
 * refused its description.
 */
const NON_ANSWER = /^(?:i'?m sorry|i cannot|i can'?t|as an ai|here'?s|here is|certainly|of course|okay|understood|sure)(?=[\s,!.:;]|$)/i;

/**
 * Clean up what a chat model returns so it can be stored as prose.
 *
 * Models wrap answers in quotes, prefix them with `Description:`, or emit a Markdown heading despite being
 * told not to. Returns undefined when nothing usable survives — the caller then keeps the extractive text.
 */
export function sanitiseDescription(raw: string): string | undefined {
  let s = (raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '')   // fenced block
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                        // heading markers
    .replace(/^\s*(description|summary)\s*:\s*/i, '')          // label the prompt asked it not to write
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”'']+|["'“”'']+$/g, '')                     // wrapping quotes
    .trim();
  if (!s) return undefined;
  if (NON_ANSWER.test(s)) return undefined;
  // No letters means no sentence — a model that answered with punctuation or an empty list.
  if (!/[a-zA-Z]/.test(s)) return undefined;
  if (s.length > MAX_DESCRIPTION_CHARS) {
    const cut = s.slice(0, MAX_DESCRIPTION_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    // Prefer ending on a sentence; failing that a word. A description ending mid-word looks like corruption.
    s = lastStop > MAX_DESCRIPTION_CHARS * 0.5
      ? cut.slice(0, lastStop + 1)
      : `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
  }
  return s;
}

/**
 * The endpoint a description may be sent to, or null when there is none.
 *
 * Exported because "which host, and was it acknowledged" is the whole security-relevant decision here, and
 * it is worth testing on its own rather than only through a call that needs a live model.
 */
export function describeTarget(): { baseUrl: string; model: string; wire?: 'ollama' | 'openai' | 'anthropic'; external?: boolean; apiKey?: string; slot: 'docRepair' | 'assist'; which?: AssistEndpoint['which'] } | null {
  // The assist model as `assistBackend('repair')` resolves it (`F-33`): its DOCUMENTS consent re-checked here rather
  // than trusted from save time — config.json could have been hand-edited — and its budget and fallback applied.
  const assist = assistBackend('repair');
  if (assist) {
    return { baseUrl: assist.baseUrl, model: assist.model, wire: assist.api, external: !isLocalModelEndpoint(assist.baseUrl),
      ...(assist.apiKey ? { apiKey: assist.apiKey } : {}), slot: 'assist', which: assist.which };
  }
  const local = resolveVlmEndpoint('repair');
  if (!vlmSlotUsable(local)) return null;
  return { ...local, slot: 'docRepair' };
}

/**
 * Describe a converted document: generated prose when a model is available, its own opening text otherwise.
 *
 * Never throws. A description is a nicety on the ingest path — a model that is down, slow or babbling must
 * degrade to the extractive text, not fail the upload.
 */
export async function describeDocument(
  markdown: string | null,
  chunks: Chunk[] = [],
): Promise<DocumentDescription> {
  const excerpt = summariseMarkdown(markdown, chunks);
  const body = (markdown && markdown.trim())
    ? markdown
    : chunks.map(c => [c.headingText, c.content].filter(Boolean).join('. ')).join('\n\n');
  if (!body.trim()) return {};

  const target = describeTarget();
  if (!target) {
    // No model anywhere. The extractive head beats nothing — it just must not be called generated.
    return excerpt ? { text: excerpt, source: 'extracted', excerpt } : {};
  }

  try {
    const text = body.slice(0, MAX_INPUT_CHARS);
    const once = (t: typeof target) => describeDocumentText({
      ...t,
      text,
      // HARD, not a default: this budget is deliberately tight because a description is a nicety on the
      // ingest path with an extractive fallback always available, and it is settable in its own right
      // through config, env and the admin API. Falling back to the repair slot's budget would hand a
      // one-paragraph summary the deadline of a job that reconciles a whole document.
      hardTimeoutMs: describeTimeoutMs(getDocumentProcessingConfig()),
    });
    // On the assist model: charged to its budget, and written by the fallback when the primary cannot answer now.
    const r = target.slot === 'assist' && target.which
      ? await viaAssist('repair', { which: target.which, baseUrl: target.baseUrl, model: target.model, api: target.wire === 'anthropic' ? 'anthropic' : 'openai', ...(target.apiKey ? { apiKey: target.apiKey } : {}) },
          async ep => {
            const v = await once({ ...target, ...ep, wire: ep.api, external: !isLocalModelEndpoint(ep.baseUrl) });
            return { value: v, ...(v.usage ? { usage: v.usage } : {}), chars: text.length + v.text.length };
          })
      : await once(target);
    const described = sanitiseDescription(r.text);
    if (described) return { text: described, source: 'generated', excerpt };
    log.debug('Describe: the model returned nothing usable — keeping the document\'s own opening text');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A timeout here is far more often a budget that does not fit this host than a broken model, and the two
    // read identically in a log. Name the setting on the line, so the next person does not have to guess
    // whether their model is wrong or their deadline is.
    const timedOut = /abort|timeout|timed out|deadline/i.test(message);
    log.warn(`Describe: ${message} — keeping the document's own opening text.`
      + (timedOut
        ? ` The budget was ${describeTimeoutMs(getDocumentProcessingConfig())} ms`
          + ` (documentProcessing.describeTimeoutMs / DOC_DESCRIBE_TIMEOUT_MS). A backend that swaps models`
          + ` per request spends part of it loading one — raise it if every document reports this.`
        : ''));
  }
  return excerpt ? { text: excerpt, source: 'extracted', excerpt } : { excerpt };
}
