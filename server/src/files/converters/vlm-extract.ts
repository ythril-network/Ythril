/**
 * VLM document extractor (F11) — composes the capability pipeline for `vlm`/`auto`/`max` modes.
 *
 * Blueprint Path 2, adapted to Markdown output: run OCR (the unstructured sidecar) for both grounding
 * *evidence* and the fallback floor; render the pages; transcribe each with the VLM; then let the
 * validator (OCR-evidence coverage) decide whether to accept the VLM output or fall back to OCR — so the
 * result is never worse than plain OCR. If a capability is missing it degrades: no render/VLM → OCR; OCR
 * down but VLM up → ungrounded VLM; nothing available → the usual ConversionUnavailableError propagates.
 *
 * `max` mode adds one bounded **repair** pass: when the VLM output fails OCR-evidence validation, a single
 * text-only reconciliation call (reusing the VLM, or a wired-in `repairModel`) tries to restore the dropped
 * content before falling back to OCR. Consensus (`verify`) and the external hosted-VLM egress path
 * (with ssrfSafeFetch) are later phases.
 */
import { log } from '../../util/log.js';
import { assistBackend, viaAssist } from '../../config/assist-backend.js';
import { getDocumentProcessingConfig, getMediaEmbeddingConfig } from '../../config/loader.js';
import type { DocExtractionMode } from '../../config/types.js';
import { UnstructuredConverter, type UnstructuredResult } from './unstructured.js';
import { renderDocumentPages, isRenderAvailableFor } from './renderer.js';
import { renderWindowTimeoutMs } from './render-budget.js';
import { transcribePageImage, repairMarkdown, repairMarkdownExternal, reconcileConsensus } from './vlm-client.js';
import type { StepProgress } from './types.js';
import { decideRoute, validateExtraction, bestByEvidence } from './extraction-policy.js';
import { resolveVlmEndpoint, vlmSlotUsable, type VlmEndpoint } from './vlm-endpoint.js';

/**
 * Say WHICH gate closed, and what was found there.
 *
 * `decideRoute`'s reason names the missing capability ("needs vlm"); it cannot name the setting, because
 * it never saw one. A reporter spent a hunt through nine configured model endpoints discovering a tenth
 * they had never set, because the log stated a verdict and withheld its evidence. Everything here is
 * config-shape, never a URL or a key.
 */
function explainMissing(vlm: VlmEndpoint, verify: VlmEndpoint, render: boolean): string {
  const missing: string[] = [];
  if (!vlm.model) missing.push('documentProcessing.vlmModel is empty (set DOC_VLM_MODEL)');
  else if (!vlm.baseUrl) missing.push('no VLM endpoint resolved — set DOC_VLM_URL, or configure the vision provider it falls back to');
  if (!render) missing.push('the page renderer is unavailable (RENDER_SIDECAR_URL)');
  if (verify.model && !verify.baseUrl) missing.push('documentProcessing.verifyModel is set but no endpoint resolved');
  return missing.length > 0 ? ` — ${missing.join('; ')}` : '';
}

/**
 * Pages read from one document across all render windows, when unconfigured.
 *
 * 200 rather than "no limit": every page is a VLM call, so the budget is the cost ceiling for a single
 * upload. Four times the old effective limit of 50, which was never a budget at all — it was one render
 * call's fact bound doing double duty as the document's reading limit.
 */
const DEFAULT_MAX_TOTAL_PAGES = 200;

const TRANSCRIBE_PROMPT =
  'Transcribe this document page to GitHub-Flavored Markdown, verbatim. Preserve headings, lists, and ' +
  'tables (use Markdown tables; use minimal HTML only if a table is too complex for Markdown). Do NOT ' +
  'summarize, translate, reorder, or invent content. Output only the transcription — no preamble, no commentary.';

export interface VlmExtractResult extends UnstructuredResult {
  /** Audit trail of which path produced the result: `ocr`, `ocr+vlm`, `ocr+vlm→ocr`, `vlm`, … */
  extractionPath: string;
}

/** Run the configured extraction mode for a document. `mode: 'ocr'` never calls this — the pipeline uses
 *  the plain OCR converter directly. `modeOverride` (F11-c) is the per-space override; when absent the
 *  instance-wide `documentProcessing.mode` applies. */
export async function vlmExtractDocument(
  fileBytes: Buffer,
  fileName: string,
  modeOverride?: DocExtractionMode,
  onProgress?: (p: StepProgress) => void,
): Promise<VlmExtractResult> {
  const cfg = getDocumentProcessingConfig();
  const mode = modeOverride ?? cfg.mode;
  const render = await isRenderAvailableFor(fileName);
  // `repair` reuses the VLM (or a wired-in repairModel), so it's available whenever the VLM is; decideRoute
  // only actually schedules the repair stage for `max` mode.
  // Resolved once, here: every downstream call uses THESE endpoints, so the route decision and the calls
  // it authorises can never be about different servers.
  const vlmEp = resolveVlmEndpoint('vlm');
  const repairEp = resolveVlmEndpoint('repair');
  const verifyEp = resolveVlmEndpoint('verify');
  const route = decideRoute(mode, {
    ocr: true, render,
    vlm: vlmSlotUsable(vlmEp), repair: vlmSlotUsable(repairEp), verify: vlmSlotUsable(verifyEp),
  });
  // The sections of the bar: this document's actual route, so nothing is drawn that will not run.
  const steps = route.stages as string[];

  // OCR is evidence + fallback. Tolerate it being down IF the VLM path can still run (ungrounded).
  let ocr: UnstructuredResult | null = null;
  try {
    ocr = await new UnstructuredConverter().convertRich(fileBytes, fileName);
  } catch (err) {
    if (route.ocrOnly) throw err; // no VLM path to fall through to — surface the OCR error as today
    log.warn(`VLM extract: OCR evidence unavailable (${err instanceof Error ? err.message : err}) — VLM will run ungrounded`);
  }

  if (route.ocrOnly) {
    // Name the evidence, not just the verdict. "mode 'vlm' needs vlm; fell back to OCR" cost a reporter a
    // hunt through nine configured endpoints to discover a tenth they had never set — the message knew
    // which gate closed and did not say. Now it names the setting and what was found there.
    if (route.fallbackReason) log.info(`VLM extract: ${route.fallbackReason}${explainMissing(vlmEp, verifyEp, render)}`);
    return { ...(ocr as UnstructuredResult), extractionPath: 'ocr' };
  }

  // ── VLM path ────────────────────────────────────────────────────────────────
  const baseUrl = vlmEp.baseUrl;
  try {
    // ── Segmented render + transcribe ─────────────────────────────────────────────────────────────
    //
    // A long document used to become its first `maxPages` pages, full stop. `maxPages` bounds ONE render
    // call — fact and latency per call — which is a real constraint and is kept; what it should never
    // have been is the limit on how much of the document is read. The sidecars now take a `startPage`, so
    // the work is walked in windows of `maxPages` instead.
    //
    // `maxTotalPages` is the separate, deliberate limit on the whole job, and it is not the same knob:
    // every extra page is a VLM call, so an unbounded loop over a 600-page scan is 600 model calls and —
    // on an external endpoint — 600 pages of content leaving the instance, triggered by an upload with
    // nobody watching. When a document exceeds the budget we do exactly what today's code does, but
    // honestly: extract what the budget allows and say plainly that the rest was skipped.
    const pageBudget = Math.max(1, cfg.maxTotalPages ?? DEFAULT_MAX_TOTAL_PAGES);
    const windowSize = Math.max(1, cfg.maxPages);
    const parts: string[] = [];
    let pagesRead = 0;
    let totalPages = 0;
    let moreAfterBudget = false;
    let pagesDone = 0;
    let segmented = false;
    // Kept ONLY for the single-window case, so the consensus pass below can re-read the same images.
    // Holding every window's buffers would defeat the per-call fact bound that `maxPages` exists for.
    let firstWindowPages: Buffer[] = [];

    for (let startPage = 0; pagesRead < pageBudget; startPage += windowSize) {
      const take = Math.min(windowSize, pageBudget - pagesRead);
      // One beat BEFORE the render, so the stall clock starts when this step does rather than partway through
      // the one before it — the same reason the describe pass gets one. It does not make the step visible
      // (nothing reports from inside a single fetch), which is why the stall FLOOR has to know this budget too:
      // see `render-budget.ts`, where the number now lives so the detector and the call site cannot disagree.
      onProgress?.({ step: 'render', steps, done: pagesRead, total: Math.min(totalPages, pageBudget) });
      const window = await renderDocumentPages(fileBytes, {
        fileName,
        dpi: cfg.renderDpi,
        maxPages: take,
        startPage,
        timeoutMs: renderWindowTimeoutMs(cfg.pageTimeoutMs, take),
      });
      totalPages = window.total;
      if (window.pages.length === 0) {
        // Only an error on the FIRST window: a later empty window just means we reached the end, which
        // `truncated: false` would normally have told us already.
        if (startPage === 0) throw new Error('render produced no pages');
        break;
      }
      if (startPage === 0) firstWindowPages = window.pages; else { segmented = true; firstWindowPages = []; }
      pagesRead += window.pages.length;
      onProgress?.({ step: 'render', steps, done: pagesRead, total: Math.min(totalPages, pageBudget) });

      const windowParts = await mapLimit(window.pages, cfg.concurrency, async (img) => {
        const t = await transcribePageImage(img, {
          ...vlmEp, prompt: TRANSCRIBE_PROMPT, defaultTimeoutMs: cfg.pageTimeoutMs,
        });
        // A finished page is the smallest honest unit of progress on this path — it is what makes a
        // long document slow rather than wedged. Counting completions rather than using the map index
        // keeps the number monotonic: pages run concurrently, so index order is not completion order
        // and a bar driven by it would jump backwards. Across windows the count keeps rising, so the
        // bar does not restart at each segment.
        onProgress?.({ step: 'vlm', steps, done: ++pagesDone, total: Math.min(totalPages, pageBudget) });
        return t.text.trim();
      });
      parts.push(...windowParts);

      if (!window.truncated) break;          // no pages after this window — done
      if (pagesRead >= pageBudget) { moreAfterBudget = true; break; }
    }

    let markdown = parts.filter(Boolean).join('\n\n---\n\n').trim();
    if (moreAfterBudget) {
      // Truncation used to leave ONLY this HTML comment buried in the converted markdown: not
      // logged, not stored, and the file still reported success. A 400-page document silently
      // became its first 50 pages, and recall then answered confidently from a tenth of it. It is now
      // reached far less often — the cap is the whole-job budget, not one render — but when it IS hit it
      // must still be loud.
      markdown += `\n\n<!-- document truncated to ${pagesRead} of ${totalPages} pages -->`;
      log.warn(
        `VLM extract: '${fileName}' truncated — read ${pagesRead} of ${totalPages} pages ` +
        `(documentProcessing.maxTotalPages = ${pageBudget}). The rest was NOT indexed.`,
      );
    }

    // Validate against OCR evidence when we have it; otherwise just require non-empty output.
    const evidence = ocr?.markdown ?? '';
    const ranLabel = ocr ? 'ocr+vlm' : 'vlm';   // audit label for what the VLM path actually produced
    const v = validateExtraction(markdown, evidence);
    if (v.ok) {
      // ── F11-d max-mode consensus: an independent second-VLM pass + reconcile, kept only if it covers the
      // OCR evidence at least as well as the primary (never worse). Precision step on an ALREADY-accepted
      // draft; failure-gated to `max` (route has the verify stage) and to a configured verify model.
      // Skipped for a SEGMENTED document, deliberately. `runConsensus` re-transcribes every page with a
      // second model, so on a walked document it would double the page cost the budget exists to bound and
      // require every window's buffers alive at once. Not a regression either: before segmentation a long
      // document was truncated to one window, so consensus never saw more than this anyway.
      if (segmented && route.stages.includes('verify') && cfg.verifyModel) {
        log.info(`VLM extract: '${fileName}' was read in segments — skipping the consensus pass (it would re-transcribe all ${pagesRead} pages).`);
      }
      if (!segmented && route.stages.includes('verify') && cfg.verifyModel && evidence.trim()) {
        const consensus = await runConsensus(firstWindowPages, markdown, evidence, cfg, verifyEp, repairEp).catch(err => {
          log.warn(`VLM extract: consensus pass errored (${err instanceof Error ? err.message : err}) — keeping primary`);
          return null;
        });
        if (consensus && consensus.text !== markdown) {
          log.debug(`VLM extract: accepted ${ranLabel}+verify (coverage ${(consensus.coverage * 100).toFixed(0)}%)`);
          return { markdown: consensus.text, extractedImages: ocr?.extractedImages ?? [], extractionPath: `${ranLabel}+verify` };
        }
      }
      log.debug(`VLM extract: accepted ${ranLabel} (${pagesRead} pages, coverage ${(v.coverage * 100).toFixed(0)}%)`);
      return { markdown, extractedImages: ocr?.extractedImages ?? [], extractionPath: ranLabel };
    }

    // ── max-mode repair: ONE bounded reconciliation pass against the OCR evidence before giving up ──
    // Only for `max` (route has the repair stage) and only when we have OCR evidence to reconcile against.
    // Repair can only turn a fallback into an acceptance — it never degrades a result that already passed.
    onProgress?.({ step: 'validate', steps });
    if (route.stages.includes('repair') && ocr && evidence.trim()) {
      onProgress?.({ step: 'repair', steps });
      // F11-b — route repair to the external assist model when it is configured AND its egress host has
      // been acknowledged. The ACK is the gate: it is re-checked HERE, not just at save time, so document
      // content never leaves the instance without recorded consent even if config.json were hand-edited.
      // (There used to be a separate `uses: ['repair']` tick as well. It was a second switch for the only
      // thing an assist model does, so it went; the consent record is the meaningful gate.)
      // F-33: which assist endpoint, if any — its DOCUMENTS consent, its budget and its fallback — is
      // `assistBackend('repair')`'s decision; none means the local repair model, as before there was one.
      const assist = assistBackend('repair');
      const repairModel = assist ? assist.model : (cfg.repairModel || cfg.vlmModel);
      try {
        log.info(`VLM extract: validation failed (${v.issues.join('; ')}) — repairing with ${assist ? `the assist model's ${assist.which} ` : ''}${repairModel}`);
        const r = assist
          ? await viaAssist('repair', assist, async ep => {
              const out = await repairMarkdownExternal({
                baseUrl: ep.baseUrl, model: ep.model, ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
                draft: markdown, evidence, issues: v.issues, defaultTimeoutMs: cfg.pageTimeoutMs,
              });
              return { value: out, ...(out.usage ? { usage: out.usage } : {}), chars: markdown.length + evidence.length + out.text.length };
            })
          : await repairMarkdown({
              ...repairEp, model: repairModel, draft: markdown, evidence, issues: v.issues,
              defaultTimeoutMs: cfg.pageTimeoutMs,
            });
        const repaired = r.text.trim();
        const rv = validateExtraction(repaired, evidence, { finishReason: r.truncated ? 'length' : undefined });
        if (rv.ok) {
          log.debug(`VLM extract: accepted ${ranLabel}+repair (coverage ${(rv.coverage * 100).toFixed(0)}%)`);
          return { markdown: repaired, extractedImages: ocr.extractedImages ?? [], extractionPath: `${ranLabel}+repair` };
        }
        log.info(`VLM extract: repair still below threshold (${rv.issues.join('; ')}) — falling back to OCR`);
      } catch (err) {
        log.warn(`VLM extract: repair errored (${err instanceof Error ? err.message : err}) — falling back to OCR`);
      }
    }

    if (ocr) {
      if (!route.stages.includes('repair')) log.info(`VLM extract: validation failed (${v.issues.join('; ')}) — falling back to OCR`);
      return { ...ocr, extractionPath: `${ranLabel}→ocr` };
    }
    throw new Error(`VLM output rejected and no OCR evidence to fall back to: ${v.issues.join('; ')}`);
  } catch (err) {
    if (ocr) {
      log.warn(`VLM extract failed (${err instanceof Error ? err.message : err}) — falling back to OCR`);
      return { ...ocr, extractionPath: `${route.label}→ocr` };
    }
    throw err; // nothing produced a result — let the pipeline surface the failure as today
  }
}

/**
 * F11-d — one bounded consensus pass. A second VLM (`verifyModel`) independently transcribes the pages; its
 * draft is reconciled with the primary against the OCR evidence; the highest-OCR-coverage of the three
 * (primary, second draft, reconciled) is returned. The primary is listed FIRST so ties keep it — consensus
 * can only match or beat the primary's coverage, never regress it.
 */
async function runConsensus(
  pages: Buffer[],
  primary: string,
  evidence: string,
  cfg: ReturnType<typeof getDocumentProcessingConfig>,
  // Resolved by the caller so every stage of one extraction talks to the endpoints the route was decided
  // against. Re-deriving them here is how the two halves came to disagree in the first place.
  verifyEp: VlmEndpoint,
  repairEp: VlmEndpoint,
): Promise<{ text: string; coverage: number }> {
  const parts = await mapLimit(pages, cfg.concurrency, async (img) => {
    // `docVerify`, not `docVlm`: this is the second-opinion model, on its own endpoint, and the slot it is
    // charged to decides its budget, its egress permission and how hard it is asked to think.
    const t = await transcribePageImage(img, {
      ...verifyEp, slot: 'docVerify', prompt: TRANSCRIBE_PROMPT, defaultTimeoutMs: cfg.pageTimeoutMs,
    });
    return t.text.trim();
  });
  const second = parts.filter(Boolean).join('\n\n---\n\n').trim();

  const candidates: { text: string; label: string }[] = [{ text: primary, label: 'primary' }];
  if (second) candidates.push({ text: second, label: 'verify' });

  // Reconcile the two drafts (text-only) via the repair/vlm model; add as a third candidate when non-empty.
  if (second) {
    try {
      const r = await reconcileConsensus({
        ...repairEp,
        draftA: primary, draftB: second, evidence, defaultTimeoutMs: cfg.pageTimeoutMs,
      });
      const reconciled = r.text.trim();
      if (reconciled) candidates.push({ text: reconciled, label: 'consensus' });
    } catch (err) {
      log.warn(`VLM extract: consensus reconcile errored (${err instanceof Error ? err.message : err}) — arbitrating on the drafts`);
    }
  }

  const best = bestByEvidence(candidates, evidence);
  return { text: best.candidate.text, coverage: best.coverage };
}

/** Bounded-concurrency map — at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
