/**
 * All the state and behaviour behind Settings → Models & Pipelines, with no template attached.
 *
 * This is the load-bearing half of the page rebuild. It was extracted from `mediaProcessing.component.ts`
 * essentially verbatim, because `mediaProcessing.component.spec.ts` (the characterization tests written in
 * #347, before any of this moved) pins its behaviour: masked keys never being echoed back, env-only
 * document fields never being sent, and both confirmations aborting the WHOLE save when declined.
 * Those tests now drive this service directly — the same assertions through a new seam. An assertion
 * that had to change to keep passing would be a behaviour change, not a refactor.
 *
 * It is provided by the page component rather than in root, so leaving and re-entering the page
 * starts from the server's state instead of a previous visit's half-finished edits.
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslocoService } from '@jsverse/transloco';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';
import { StatusVariant } from '../../../shared/status-pill.component';
import {
  MediaCfg, MediaClass, DocProcCfg, DocAssistCfg, DocMode, EmbeddingCfg,
  TestResult, TestTarget, VerifyResult, VerifyTarget, FaceRecognitionCfg, MODE_STAGES, FaceExternalCfg, RerankCfg, NliCfg,
  CARD_SLOT, type SlotTuningCfg, type DecisionModelCfg,
} from './media-processing.types';
import { assistExtrasPatch, fallbackNeedsAck, hostOf } from './assist-extras';

/**
 * The Models tab's cards that own editable config and therefore get their own Save button.
 *
 * `doc-render` and `unstructured` are deliberately absent: neither has a single `ngModel` — they report
 * env-only infrastructure, so a Save button on them would be a control that cannot do anything.
 *
 * **The three document cards were absent for the same reason and it was the wrong reason.** Their model and
 * endpoint are env-only, which is what `[infra]` says; their per-slot budget and reasoning effort are
 * neither, and there is deliberately no environment variable for those at all. One flag was answering two
 * questions, so the only door to three of the ten slot budgets did not exist.
 */
export type ModelCardId =
  | 'embedding' | 'rerank' | 'nli' | 'vision' | 'stt' | 'assist' | 'face'
  | 'doc-vlm' | 'doc-repair' | 'doc-verify' | 'decision';
export const MODEL_CARDS: readonly ModelCardId[] =
  ['embedding', 'rerank', 'nli', 'vision', 'stt', 'assist', 'face', 'doc-vlm', 'doc-repair', 'doc-verify', 'decision'];

/**
 * One pipeline on the Pipelines tab.
 *
 * These used to be pooled into a single `rest` section saved by one bar at the bottom of the page —
 * the same shape the Models tab had before per-card saves, and wrong for the same reason: a Save whose
 * scope is "everything on this tab" makes an operator who changed one ceiling wonder what else is going
 * out with it. Owner, 2026-07-30: "save button per pipe like on models, not one at the bottom."
 *
 * Splitting is safe because the server merges both of these PER KEY: `levels` through
 * `mergeLevelCeilings` (which exists precisely so one class can be patched alone) and
 * `documentProcessing` through the one-level deep merge the assist card already relies on.
 */
export type PipeId = 'pipe-text' | 'pipe-images' | 'pipe-audio' | 'pipe-video' | 'pipe-documents';
export const PIPE_SECTIONS: readonly PipeId[] =
  ['pipe-text', 'pipe-images', 'pipe-audio', 'pipe-video', 'pipe-documents'];

/** The media class each pipeline owns. `pipe-documents` owns `documentProcessing` instead. */
export const PIPE_CLASS: Record<Exclude<PipeId, 'pipe-documents'>, MediaClass> = {
  'pipe-text': 'text', 'pipe-images': 'images', 'pipe-audio': 'audio', 'pipe-video': 'video',
};

/** A card, a pipeline, or the leftovers neither owns. */
export type CfgSection = ModelCardId | PipeId | 'rest';
export const ALL_SECTIONS: readonly CfgSection[] = [...MODEL_CARDS, ...PIPE_SECTIONS, 'rest'];

@Injectable()
export class MediaProcessingStateService {
  private readonly http = inject(HttpClient);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly transloco = inject(TranslocoService);

  /** Button order: Auto first (it is the default), then the rungs ascending in capability. */
  readonly MODES: DocMode[] = ['auto', 'off', 'ocr', 'vlm', 'repair'];

  loading = signal(true);
  loadError = signal<string | null>(null);
  saving = signal(false);
  saveError = signal('');
  saveOk = signal('');

  form: MediaCfg = { vision: {}, stt: {}, documentProcessing: {} };
  lockedByInfra: string[] = [];
  /**
   * Entries of `YTHRIL_PINNED_FIELDS` that name nothing, so they pinned NOTHING.
   *
   * Rendered as a notice rather than kept for the log, because the failure that variable exists to prevent is a
   * control that looks fixed and is not — and this screen is where an operator checks whether their pin worked.
   */
  pinnedUnknown: string[] = [];
  visionApiKeyInput = '';
  sttApiKeyInput = '';
  assistApiKeyInput = '';
  /** `F-33`: the fallback's key, typed; and whether the server holds one (the GET returns only a mask). */
  assistFallbackApiKeyInput = '';
  assistFallbackKeySet = false;
  decisionApiKeyInput = '';
  embeddingApiKeyInput = '';

  /** Serialized model|dimensions|similarity at load — changing any of these re-indexes every vector. */
  private embeddingReindexBaseline = '';
  /**
   * The saved payload PER SECTION, as it stood at the last save of that section.
   *
   * One snapshot for the whole config used to be enough, because one button saved everything. With
   * per-card saves it is actively wrong: saving the vision card would re-baseline the entire config and
   * mark an edited embedding card clean, so the operator's unsaved change would stop warning them and
   * then be lost on navigate. Each section re-baselines only itself.
   */
  private savedSnapshots: Partial<Record<CfgSection, string>> = {};
  /** Flipped by a delegated input/change listener on the page. See `isDirty`. */
  touched = signal(false);

  /**
   * One-shot cross-tab focus request: a pipeline step actor was clicked, naming the Models-tab card
   * that configures it. The page reacts by switching to the Models tab and scrolling that card into
   * view, then clears this back to null. Holds the card id (matching `#model-card-<id>`), never a tab.
   */
  readonly focusCard = signal<string | null>(null);
  requestFocusCard(cardId: string): void { this.focusCard.set(cardId); }

  // ── Face recognition ──
  /** Live handle to the editable face block, lazily initialised so the template can bind fields. */
  get face(): FaceRecognitionCfg { return (this.form.faceRecognition ??= {}); }
  faceLocked(field: string): boolean { return this.isLocked(`faceRecognition.${field}`); }
  /*
   * THE DISABLE CONFIRMATION IS GONE, because the transition it guarded cannot be made here.
   *
   * `faceBeingDisabled()` compared a load-time baseline against `face.enabled`, and no control on this page
   * binds that field — the enable switch was removed when the image ladder became the single gate, and the
   * card's template says so. So the guard was permanently false: a consent dialog that could not fire,
   * feeding a payload field that could not be accepted, for a switch that was no longer there.
   *
   * Three artefacts of one removed control, and the middle one is what broke every save on the page. Left in
   * place with a comment they would have gone on looking like working safeguards; a guard that cannot fire
   * protects nothing, and this repo has paid before for an unreachable component making four other things
   * wrong around it.
   *
   * **The question it was asking is real and has moved, not vanished.** Lowering the IMAGE ceiling below its
   * recognition rung is now the act that turns faces off, so that is where a confirmation belongs. Recorded
   * in `UX-TODO.md` → U-11 rather than approximated here on a field nobody can reach.
   */

  // ── external face model (biometric egress) ──
  /** Live handle to the editable endpoint block, lazily created so the template can bind its fields. */
  get faceExternal(): FaceExternalCfg { return (this.face.externalModel ??= {}); }
  faceExternalLocked(): boolean { return this.isLocked('faceRecognition.externalModel'); }
  faceExternalHost(): string { try { return this.faceExternal.baseUrl ? new URL(this.faceExternal.baseUrl).host : ''; } catch { return ''; } }
  /** Configured at all — a base URL is the only thing that makes the endpoint reachable. */
  faceExternalConfigured(): boolean { return !!this.faceExternal.baseUrl?.trim(); }
  /** Read-only state the server reports about the STORED config. Never sent back — see `load()`. */
  private serverFlags: Record<string, boolean> = {};

  /**
   * Is a stored face endpoint configured but not consented to — so stored and NOT IN USE?
   *
   * Read from the server, never derived here. The server computes it from the same predicate the send site
   * uses, and a second derivation in the client could disagree with the thing that actually decides. Absent
   * on an older server, which reads as false — the state simply was not reachable there.
   *
   * NOT the same question as `faceExternalNeedsAck()`. That one is about the form in front of the operator
   * and drives the dialog; this one is about what is stored and drives a notice.
   */
  faceAwaitingAcknowledgment(): boolean {
    return this.serverFlags['faceEndpointAwaitingAcknowledgment'] === true;
  }

  // ── F-31: the extractors' decision model ──
  /** Live handle to the editable block. Holds only what the PATCH accepts — see `DecisionModelCfg`. */
  get decision(): DecisionModelCfg { return (this.form.decisionModel ??= {}); }
  /** Pinned by `YTHRIL_PINNED_FIELDS=decisionModel`, or by a `DECISION_*` env var — both reported by the server. */
  decisionLocked(): boolean { return this.isLocked('decisionModel') || this.serverFlags['decisionLocked'] === true; }
  decisionKeySet(): boolean { return this.serverFlags['decisionKeySet'] === true; }
  decisionHost(): string { try { return this.decision.baseUrl ? new URL(this.decision.baseUrl).host : ''; } catch { return ''; } }
  /** In use once its host is consented to. There is no rung to sit behind, so consent is the whole switch. */
  decisionInUse(): boolean { return !!this.decisionHost() && this.decision.acknowledgedHost === this.decisionHost(); }
  /**
   * Is a save of this card about to set up an endpoint nobody has consented to? The endpoint is sent only
   * when something about it changed (see `cardBlock`), so a card saved for its budget alone asks nothing.
   */
  decisionNeedsAck(): boolean {
    return this.decisionEndpointChanged() && !!this.decisionHost() && !this.decisionInUse();
  }
  /** The endpoint fields as loaded, to tell a budget-only save from an endpoint change. */
  private decisionLoaded = '';
  private decisionEndpoint(): DecisionModelCfg {
    const d = this.decision;
    return { baseUrl: d.baseUrl || undefined, model: d.model || undefined, acknowledgedHost: d.acknowledgedHost };
  }
  private decisionEndpointChanged(): boolean {
    return !!this.decisionApiKeyInput || JSON.stringify(this.decisionEndpoint()) !== this.decisionLoaded;
  }

  /**
   * Consent is due whenever a host is set and not yet acknowledged.
   *
   * ## Why this does NOT also require the recognition rung, though the server's refusal does
   *
   * I changed it to require the rung, mirroring the server, and three specs went red — correctly. The client
   * and the server are answering different questions, and conflating them is a UX regression dressed as
   * consistency:
   *
   *   the SERVER refuses when consent is REQUIRED and missing — endpoint reachable, and this patch caused it
   *   the CLIENT asks when consent CAN BE RECORDED and is not — which is a wider, earlier window
   *
   * The server stores an acknowledgement happily at any rung. So asking while the operator is configuring
   * the endpoint front-loads the decision: they are right there, they have just typed the host, and raising
   * the rung later is then frictionless rather than a second interruption. Deferring the question to the rung
   * raise would be correct and worse.
   *
   * What must never happen is asking MORE often than consent can be recorded — that trains an operator to
   * click through a biometric dialog. This is bounded by "a host is set and unacknowledged", which is
   * exactly once per host.
   *
   * Re-pointing the URL revokes consent by construction, since the acknowledgment is host-scoped.
   */
  faceExternalNeedsAck(): boolean {
    const host = this.faceExternalHost();
    return !!host && this.faceExternal.acknowledgedHost !== host;
  }
  faceApiKeyInput = '';

  // ── Text embedding ──
  get embedding(): EmbeddingCfg { return (this.form.embedding ??= {}); }
  embeddingLocked(field: string): boolean { return this.isLocked(`embedding.${field}`); }
  // prefixScheme belongs here with the rest: the prefix is part of the string that gets embedded, so
  // changing it changes the vector for identical text just as surely as changing the model does.
  private reindexKey(): string { return `${this.embedding.model ?? ''}|${this.embedding.dimensions ?? ''}|${this.embedding.similarity ?? ''}|${this.embedding.prefixScheme ?? ''}`; }
  /** True when a reindex-triggering field (model/dimensions/similarity/prefixScheme) differs from load. */
  embeddingNeedsReindex(): boolean { return this.reindexKey() !== this.embeddingReindexBaseline; }

  // ── Reranker ──
  /** Live handle to the editable rerank block, lazily created so the template can bind its fields. */
  get rerank(): RerankCfg { return (this.form.rerank ??= {}); }
  rerankLocked(field: string): boolean { return this.isLocked(`rerank.${field}`); }
  rerankApiKeyInput = '';
  /**
   * Configured = on. There is no master toggle, matching the server: the feature is gated on having an
   * endpoint AND a model, so clearing either is how an operator turns reranking off.
   */
  rerankConfigured(): boolean { return !!this.rerank.baseUrl?.trim() && !!this.rerank.model?.trim(); }
  /**
   * True when the configured endpoint is NOT a loopback/sidecar host — i.e. every search would send the
   * query AND the passages it matched off this instance. Mirrors `isLocalModelEndpoint` on the server;
   * the warning is the point, so an approximation that is wrong in the safe direction is not acceptable
   * — a hostname with a dot is treated as remote.
   */
  /** Live handle to the editable NLI block, lazily created so the template can bind its fields. */
  get nli(): NliCfg { return (this.form.nli ??= {}); }
  nliLocked(field: string): boolean { return this.isLocked(`nli.${field}`); }
  nliApiKeyInput = '';
  /** Configured = on, exactly as for the reranker: no master toggle, so clearing the endpoint is off. */
  nliConfigured(): boolean { return !!this.nli.baseUrl?.trim() && !!this.nli.model?.trim(); }
  /** Same loopback test as the reranker, and it matters more here: the judge is sent PAIRS OF RECORD
   *  TEXTS, not a query. Wrong in the safe direction — a hostname with a dot counts as remote. */
  nliIsExternal(): boolean {
    const raw = this.nli.baseUrl?.trim();
    if (!raw) return false;
    try {
      const h = new URL(raw).hostname;
      return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || !h.includes('.'));
    } catch {
      return false;
    }
  }

  rerankIsExternal(): boolean {
    const raw = this.rerank.baseUrl?.trim();
    if (!raw) return false;
    try {
      const h = new URL(raw).hostname;
      return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || !h.includes('.'));
    } catch {
      return false;
    }
  }

  // ── F11-PR5b: test connection ──
  testState = signal<Partial<Record<TestTarget, { loading?: boolean; res?: TestResult }>>>({});
  testOf(t: TestTarget): { loading?: boolean; res?: TestResult } | undefined { return this.testState()[t]; }
  testConnection(t: TestTarget): void {
    this.testState.update(s => ({ ...s, [t]: { loading: true } }));
    // `assist-fallback` is the assist target's fallback (`F-33`), one server target with a flag.
    const body = t === 'assist-fallback' ? { target: 'assist', fallback: true } : { target: t };
    this.http.post<TestResult>('/api/admin/media-config/test-connection', body).subscribe({
      next: res => this.testState.update(s => ({ ...s, [t]: { res } })),
      error: err => this.testState.update(s => ({ ...s, [t]: { res: {
        ok: false, reachable: false, verdict: 'unreachable' as const,
        detail: err?.error?.error ?? err?.message ?? 'Test failed', latencyMs: 0,
      } } })),
    });
  }
  // ── Verify: one REAL request against the configured model ──
  //
  // `testConnection` lists models — cheap, content-free, and unable to answer "does my model work". A
  // vision endpoint was listed, reachable, and failing on every image; and an aliasing router does not
  // enumerate the names it serves at all. Only a real call settles it.
  //
  // Deliberately a separate action with its own button: it costs latency and, on a metered endpoint,
  // money. A cold model load has been measured at ~35s in the field, so there is no client-side timeout
  // here — the server owns the budget and reports `still-loading` rather than calling a swapping backend
  // broken.
  verifyState = signal<Partial<Record<VerifyTarget, { loading?: boolean; res?: VerifyResult }>>>({});
  verifyOf(t: VerifyTarget): { loading?: boolean; res?: VerifyResult } | undefined { return this.verifyState()[t]; }
  verifyModel(t: VerifyTarget): void {
    this.verifyState.update(s => ({ ...s, [t]: { loading: true } }));
    const body = t === 'assist-fallback' ? { target: 'assist', fallback: true } : { target: t };
    this.http.post<VerifyResult>('/api/admin/media-config/verify', body).subscribe({
      next: res => this.verifyState.update(s => ({ ...s, [t]: { res } })),
      error: err => this.verifyState.update(s => ({ ...s, [t]: { res: {
        target: t, outcome: 'failed' as const,
        detail: err?.error?.error ?? err?.message ?? 'Verification failed', latencyMs: 0,
      } } })),
    });
  }
  /** Pill colour per outcome. `still-loading` is INFORMATIONAL — a cold start is not a fault. */
  verifyPillVariant(r: VerifyResult): StatusVariant {
    return r.outcome === 'ok' ? 'ok' : r.outcome === 'failed' ? 'error' : 'warn';
  }
  verifyPillLabelKey(r: VerifyResult): string {
    return `mediaProcessing.verify.${r.outcome === 'still-loading' ? 'stillLoading' : r.outcome}`;
  }

  /**
   * Not enumerating a model is NOT a warning.
   *
   * This returned `warn` for `modelEnumerated === false`, which made a working endpoint permanently
   * yellow: aliasing routers (llama-swap roles), gateways and Azure deployments deliberately do not list
   * the names they serve, so absence from the list carries no information at all.
   *
   * A fault is what the probe actually established — nothing answered, the credential was rejected, or the
   * endpoint answered on a protocol inference will not use. An endpoint that simply has no model-list route
   * is none of those; it is the normal shape of a single-route inference server, and calling it unreachable
   * put a red pill on a speech-to-text service that was transcribing correctly. Verify is what answers
   * "does the model work".
   */
  testPillVariant(r: TestResult): StatusVariant {
    if (!r.reachable || r.verdict === 'auth-rejected') return 'error';
    // Reachable and NOT ok is the one case the server can prove will fail anyway: the endpoint answered on
    // the other wire, so inference will speak the protocol it did not answer. A green pill here was a
    // success badge over a pipeline that cannot work, with the explanation sitting unread in `detail`.
    return r.ok === false ? 'warn' : 'ok';
  }
  testPillLabelKey(r: TestResult): string {
    if (r.verdict === 'auth-rejected') return 'mediaProcessing.test.authRejected';
    if (!r.reachable) return 'mediaProcessing.test.unreachable';
    // The endpoint answered and has no model list. Said plainly, because "reachable" beside a 404 in the
    // hint reads like a contradiction — and this is the normal state of a single-route inference server.
    if (r.verdict === 'not-enumerable') return 'mediaProcessing.test.noModelList';
    if (r.modelEnumerated === false) return 'mediaProcessing.test.modelNotEnumerated';
    if (r.modelEnumerated === true) return 'mediaProcessing.test.modelFound';
    return 'mediaProcessing.test.reachable';
  }

  // ── F11-b: external assist model ──
  /** Live handle to the editable assist-model block (lazily initialised so templates can bind fields). */
  get assist(): DocAssistCfg { return (this.form.documentProcessing ??= {}).assistModel ??= {}; }
  assistLocked(): boolean { return this.isLocked('documentProcessing.assistModel'); }

  /** True when the external assist model is actually configured — a base URL AND a model to call.
   *  Without both there is no endpoint, so nothing it is "used" for can run. */
  assistConfigured(): boolean { return !!this.assist.baseUrl?.trim() && !!this.assist.model?.trim(); }
  /** The assist model is live when it is configured AND the extraction rung that uses it is reachable. */
  assistInUse(): boolean { return this.assistConfigured() && this.repairReachable(); }
  /** `repair` uses the assist model outright; `auto` resolves to repair when a repair capability exists. */
  repairReachable(): boolean {
    const m = this.form.documentProcessing?.mode;
    return m === 'repair' || m === 'auto';
  }
  /** The endpoint host (for the egress acknowledgment), or '' when the URL is empty/invalid. */
  assistHost(): string { try { return this.assist.baseUrl ? new URL(this.assist.baseUrl).host : ''; } catch { return ''; } }
  /** True when the pipeline could actually reach an endpoint whose host has not been acknowledged — the
   *  save prompts for consent. Keyed off the extraction RUNG (repair/auto), not a separate tick: the
   *  assist model exists to serve the repair pass, so consent is due exactly when repair becomes
   *  reachable — whether by configuring the endpoint or by raising the mode. */
  assistNeedsAck(): boolean {
    const host = this.assistHost();
    return !!host && this.repairReachable() && this.assist.acknowledgedHost !== host;
  }
  /** `F-35`: consented for CONVERSATIONS (ingest) — its own acknowledgement, matching the current host. */
  assistConversationsConsented(): boolean {
    const host = this.assistHost();
    return !!host && this.assist.acknowledgedHostForConversations === host;
  }
  /**
   * Allow or withdraw conversations. Allowing asks first, in a dialog that names what conversations send — a
   * documents acknowledgement never covers them. Takes effect with the card's next save, like every field on it.
   */
  async setAssistConversations(on: boolean): Promise<void> {
    if (!on) { this.assist.acknowledgedHostForConversations = null; return; }
    const host = this.assistHost();
    if (!host) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('mediaProcessing.confirm.conversationEgressTitle'),
      message: this.transloco.translate('mediaProcessing.confirm.conversationEgressMessage', { host }),
      confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
      cancelLabel: this.transloco.translate('common.cancel'),
      danger: true,
    });
    if (ok) this.assist.acknowledgedHostForConversations = host;
  }

  /** The loaded doc-processing config (read-only fields like vlmModel live here). */
  /**
   * Per-slot tuning, as the operator is editing it.
   *
   * Kept flat and keyed BY SLOT rather than nested inside each card's own block, for the reason the server's
   * own module gives: a card's block is replaced wholesale by the PATCH, and burying a slot inside one would
   * make the slot's fate depend on which card happened to be saved.
   */
  modelSlots: Record<string, SlotTuningCfg | undefined> = {};

  private docCfgSig = signal<DocProcCfg>({});
  docCfg = computed(() => this.docCfgSig());
  docMode = signal<DocMode>('ocr');

  load(): void {
    this.http.get<MediaCfg>('/api/admin/media-config').subscribe({
      next: cfg => {
        this.lockedByInfra = cfg.lockedByInfra ?? [];
        // Cloned, not aliased: `form` is what the operator edits, and editing the response object
        // in place makes a discarded edit survive a reload.
        this.modelSlots = JSON.parse(JSON.stringify(cfg.modelSlots ?? {})) as Record<string, SlotTuningCfg | undefined>;
        this.pinnedUnknown = cfg.pinnedUnknown ?? [];
        /*
         * Read-only STATE the server reports, kept apart from `form`.
         *
         * `form` is what the operator edits and what gets sent back; these are facts about the stored config
         * that no control owns. Keeping them out of `form` is the same rule that made the media-config save
         * break in the first place — a server-owned field sitting in the editable object is one echo away
         * from a 400.
         */
        // The decision block's server-owned fields go to the flags, and only its editable ones to `form`.
        const { locked: decisionLocked, inUse: _inUse, apiKey: decisionKey, ...decisionModel } =
          ((cfg as Record<string, unknown>)['decisionModel'] ?? {}) as DecisionModelCfg & { locked?: boolean; inUse?: boolean };
        this.serverFlags = {
          faceEndpointAwaitingAcknowledgment:
            (cfg as Record<string, unknown>)['faceEndpointAwaitingAcknowledgment'] === true,
          decisionLocked: decisionLocked === true,
          decisionKeySet: !!decisionKey,
        };
        const dp: DocProcCfg = { mode: 'auto', renderDpi: 150, maxPages: 50, pageTimeoutMs: 60000, concurrency: 2, ocrTimeoutMs: 120000, ...cfg.documentProcessing };
        // F11-b — the masked apiKey stays
        // only so the UI can show "key set" — it is never sent back (assistApiKeyInput carries changes).
        dp.assistModel = { ...cfg.documentProcessing?.assistModel };
        // `F-33`: the fallback's masked key must not sit in the form, one save away from being echoed back.
        this.assistFallbackKeySet = !!dp.assistModel.fallback?.apiKey;
        if (dp.assistModel.fallback) dp.assistModel.fallback = { ...dp.assistModel.fallback, apiKey: undefined };
        this.assistFallbackApiKeyInput = '';
        this.form = { vision: {}, stt: {}, ...cfg, documentProcessing: dp, decisionModel };
        this.decisionLoaded = JSON.stringify(this.decisionEndpoint());
        this.decisionApiKeyInput = '';
        this.form.vision = { ...cfg.vision, apiKey: undefined };
        this.form.stt = { ...cfg.stt, apiKey: undefined };
        this.form.embedding = { provider: 'local', ...cfg.embedding };
        this.form.rerank = { ...cfg.rerank, apiKey: undefined };
        this.form.nli = { ...cfg.nli, apiKey: undefined };
        // Strip the masked key on the way in, like vision/stt: a mask sitting in `form` is one edit away
        // from being echoed back and overwriting a real credential with asterisks.
        this.form.faceRecognition = {
          ...cfg.faceRecognition,
          ...(cfg.faceRecognition?.externalModel
            ? { externalModel: { ...cfg.faceRecognition.externalModel, apiKey: undefined } }
            : {}),
        };
        this.embeddingReindexBaseline = this.reindexKey();
        this.assistApiKeyInput = '';
        this.embeddingApiKeyInput = '';
        this.rerankApiKeyInput = '';
        this.nliApiKeyInput = '';
        this.docCfgSig.set(dp);
        this.docMode.set(dp.mode ?? 'ocr');
        this.loading.set(false);   // before rebaseline: sectionSnapshot is inert while loading
        this.rebaseline(ALL_SECTIONS);
        this.touched.set(false);
      },
      error: err => { this.loadError.set(`Failed to load configuration: ${err?.message ?? 'Unknown error'}`); this.loading.set(false); },
    });
  }

  /** True when the whole media config is infra-managed (read-only, edits refused by the API). */
  get managed(): boolean { return !!this.form.infraManaged; }
  // When infra-managed, EVERY field is locked (the API refuses edits) — so isLocked() short-circuits.
  isLocked(field: string): boolean { return this.managed || this.lockedByInfra.includes(field); }

  // ── per-card sections ──

  /**
   * The complete PATCH block a single card owns.
   *
   * Each block is sent WHOLE. `media-config.ts` shallow-merges top-level keys, so omitting a key leaves
   * it untouched (which is what makes a per-card save safe) but a key that IS sent replaces its previous
   * value outright — send `vision: { model }` without `baseUrl` and the base URL is erased.
   *
   * `assist` is the exception that proves it: it lives under `documentProcessing`, which the handler
   * DEEP-merges one level precisely so a patch naming only `assistModel` keeps `mode`/`renderDpi`/the
   * rest. That is why the assist card can be saved on its own at all.
   */
  private cardBlock(card: ModelCardId): MediaCfg {
    const base = this.payload();
    /*
     * ONE SLOT, the card's own.
     *
     * `mergeModelSlots` on the server merges slot by slot, so a card that sent the whole `modelSlots` object
     * would be fine today and wrong the moment two cards are saved from two tabs — the second would carry a
     * stale copy of the first's slot. Sending only this card's slot makes a per-card Save mean what it says.
     */
    const tuning = CARD_SLOT[card];
    const slots: MediaCfg['modelSlots'] | undefined = tuning
      ? { [tuning.slot]: this.modelSlots[tuning.slot] ?? {} }
      : undefined;
    const withSlot = (block: MediaCfg): MediaCfg => (slots ? { ...block, modelSlots: slots } : block);
    switch (card) {
      case 'embedding': return withSlot({ embedding: base.embedding });
      case 'rerank': return withSlot({ rerank: base.rerank });
      case 'nli': return withSlot({ nli: base.nli });
      case 'vision': return withSlot({ visionProvider: this.form.visionProvider, vision: base.vision });
      case 'stt': return withSlot({ sttProvider: this.form.sttProvider, stt: base.stt });
      case 'face': return withSlot({ faceRecognition: base.faceRecognition });
      case 'assist': {
        const a = this.assist;
        return withSlot({ documentProcessing: { assistModel: {
          baseUrl: a.baseUrl || undefined, model: a.model || undefined, acknowledgedHost: a.acknowledgedHost,
          // Always sent: the server replaces this block whole, so leaving it out would withdraw the consent.
          acknowledgedHostForConversations: a.acknowledgedHostForConversations ?? null,
          // `F-33`/`F-33.1`: always sent too, `null` when cleared (see assist-extras.ts).
          ...assistExtrasPatch(a, this.assistFallbackApiKeyInput),
        } } });
      }
      // The three document cards own their SLOT and nothing else — the model and the endpoint really are
      // env-only. `withSlot` on an empty block sends `modelSlots` alone, which is the whole patch: the
      // server merges slot by slot, so this cannot disturb another card's tuning or any document setting.
      case 'doc-vlm':
      case 'doc-repair':
      case 'doc-verify':
        return withSlot({});
      // The endpoint only when it changed: it is reachable the moment it is set, so sending it unchanged
      // would have a budget-only save ask for consent to a transfer the operator did not touch.
      case 'decision':
        return withSlot(this.decisionEndpointChanged() ? { decisionModel: this.decisionEndpoint() } : {});
    }
  }

  /** Everything the cards do NOT own — the Pipelines knobs, ceilings and limits. Saved by the page bar. */
  private restBlock(): Record<string, unknown> {
    const b = this.payload();
    const dp = { ...b.documentProcessing };
    return { levels: b.levels, documentProcessing: dp, fallbackToExternal: b.fallbackToExternal,
      maxFileSizeBytes: b.maxFileSizeBytes, workerConcurrency: b.workerConcurrency };
  }

  /**
   * The PATCH block one pipeline owns.
   *
   * A media pipeline sends ONLY its own class inside `levels`. The server merges class by class, so a
   * patch naming `images` cannot disturb `audio` — which is the property that makes a per-pipeline
   * Save honest rather than a relabelled Save-everything.
   */
  private pipeBlock(id: PipeId): Record<string, unknown> {
    if (id === 'pipe-documents') {
      const dp = { ...this.payload().documentProcessing };
      // The assist model belongs to its own card on the Models tab; sending it from here would let the
      // Documents pipeline's Save quietly rewrite a credentialled endpoint it does not own.
      delete (dp as Record<string, unknown>)['assistModel'];
      return { documentProcessing: dp };
    }
    const cls = PIPE_CLASS[id];
    const block: Record<string, unknown> = { levels: { [cls]: (this.form.levels ?? {})[cls] ?? 'auto' } };
    /*
     * The acknowledgement travels WITH the level that needs it.
     *
     * Two patches would be two chances to fail between them: the level applied and the consent lost, or the
     * consent stored against a level that never landed. One request is atomic on the server, so the operator
     * either switched faces on with consent recorded or changed nothing.
     *
     * Only the host, never the endpoint: this Save owns the image ceiling, not the Models card's URL. Sending
     * `baseUrl` from here would let the Images pipeline quietly rewrite a credentialled endpoint it does not
     * own — the same reason the Documents pipeline deletes `assistModel` from its own block.
     */
    /*
     * The condition is "we HAVE an acknowledgement for the configured host", not "we still need one".
     *
     * The first version read `faceExternalNeedsAck()` and sent nothing: `confirmEgressForPipe` sets
     * `acknowledgedHost` before this runs, which makes `needsAck` false — so the guard excluded the very
     * value it had just obtained. Caught by its own spec, which is why that spec asserts the BODY rather
     * than that the dialog appeared.
     */
    const ack = this.faceExternal.acknowledgedHost;
    if (id === 'pipe-images' && !!ack && ack === this.faceExternalHost()) {
      block['faceRecognition'] = { externalModel: { acknowledgedHost: ack } };
    }
    return block;
  }

  /**
   * Ask for egress consent when THIS pipeline's save is what activates an endpoint.
   *
   * Returns false when the operator declined, in which case nothing is sent — the level stays unsaved rather
   * than being applied with the endpoint left unconsented, because a half-applied privacy decision is the
   * worst of the three outcomes.
   *
   * Mirrors the server's rule rather than approximating it: the endpoint must be set, unacknowledged, and
   * behind a rung that this form has ON. Asking more often than the server refuses would train an operator
   * to click through a biometric consent dialog, which is worse than not asking.
   */
  private async confirmEgressForPipe(id: PipeId): Promise<boolean> {
    if (id === 'pipe-images' && !this.faceExternalLocked() && this.faceExternalNeedsAck()) {
      const host = this.faceExternalHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.faceEgressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.faceEgressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.faceEgressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return false;
      this.faceExternal.acknowledgedHost = host;
    }
    if (id === 'pipe-documents' && !this.assistLocked() && this.assistNeedsAck()) {
      const host = this.assistHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.egressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.egressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return false;
      this.assist.acknowledgedHost = host;
    }
    return true;
  }

  private sectionSnapshot(section: CfgSection): string {
    if (section === 'rest') return JSON.stringify(this.restBlock());
    if ((PIPE_SECTIONS as readonly string[]).includes(section)) {
      return JSON.stringify(this.pipeBlock(section as PipeId));
    }
    return JSON.stringify(this.cardBlock(section as ModelCardId));
  }

  /** Whether this pipeline alone has an unsaved change — what its own Save button keys off. */
  pipeDirty(id: PipeId): boolean {
    if (this.loading() || this.managed) return false;
    return this.touched() && this.sectionSnapshot(id) !== (this.savedSnapshots[id] ?? '');
  }

  /**
   * Save one pipeline's block, leaving every other pipeline and card untouched.
   *
   * ## Why this asks for consent, when it used to just send
   *
   * This is the path an operator takes to switch faces on, and it was the one path with no dialog. Their
   * sequence, reported 2026-08-20:
   *
   *     Settings -> Media Processing -> set images to "Caption + face recognition" -> Save
   *     -> nothing saves, and eventually a raw API object appears.
   *
   * The Models card asked, and the page-bar Save asked. The per-pipeline Save — the button next to the
   * control they had just changed — sent the PATCH straight out and rendered whatever came back. So the
   * refusal was correct, arrived at the right moment, and reached the user as machine output on a page that
   * never mentioned the endpoint it was about. Their owner's summary: *"not even i understand it"*.
   *
   * Raising the image ceiling to a recognition rung IS an act of switching faces on, so it is a place to
   * GIVE consent rather than a place to be refused for lacking it — owner's ruling P-12 (C), 2026-08-20. The
   * server accepts the acknowledgement from this patch; this is the half that offers it.
   */
  async savePipe(id: PipeId): Promise<void> {
    if (this.managed || this.saving()) return;

    // BEFORE the request. The server would refuse this exact patch, so asking here turns a refusal the
    // operator cannot act on into the decision they are already making.
    if (!(await this.confirmEgressForPipe(id))) return;

    this.saving.set(true);
    this.saveOk.set('');
    this.saveError.set('');
    const body = JSON.parse(JSON.stringify(this.pipeBlock(id)));
    this.http.patch<{ ok: boolean; config: MediaCfg }>('/api/admin/media-config', body).subscribe({
      next: () => {
        this.saveOk.set(this.transloco.translate('mediaProcessing.saved'));
        this.rebaseline([id]);
        this.saving.set(false);
        setTimeout(() => this.saveOk.set(''), 3000);
      },
      error: err => {
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed');
        this.saving.set(false);
      },
    });
  }

  private rebaseline(sections: readonly CfgSection[]): void {
    for (const sec of sections) this.savedSnapshots[sec] = this.sectionSnapshot(sec);
  }

  /** The typed-but-unsaved API key belonging to this card, if it has one. */
  private cardKeyInput(card: ModelCardId): string {
    return card === 'vision' ? this.visionApiKeyInput
      : card === 'stt' ? this.sttApiKeyInput
      : card === 'assist' ? this.assistApiKeyInput
      : card === 'embedding' ? this.embeddingApiKeyInput
      : card === 'face' ? this.faceApiKeyInput
      : card === 'rerank' ? this.rerankApiKeyInput
      : card === 'nli' ? this.nliApiKeyInput
      : card === 'decision' ? this.decisionApiKeyInput
      : '';
  }

  /**
   * True when THIS card has something a save would change — what its own Save button keys off.
   *
   * Same two-part rule as the global guard: a typed API key counts even though it is absent from the
   * snapshot (it is deliberately not in `payload()`), and otherwise it is a real diff, not merely a
   * keystroke that was undone.
   */
  cardDirty(card: ModelCardId): boolean {
    if (this.managed || this.loading()) return false;
    if (this.cardKeyInput(card)) return true;
    return this.touched() && this.sectionSnapshot(card) !== (this.savedSnapshots[card] ?? '');
  }

  // ── unsaved-changes guard ──

  /**
   * True when there is something a save would actually change.
   *
   * `touched` alone would prompt after a keystroke that was undone; the snapshot comparison alone
   * would miss a typed API key, which is deliberately absent from the payload until save. Both
   * together give a prompt that fires when — and only when — leaving would lose something.
   */
  isDirty(): boolean {
    if (this.managed || this.loading()) return false;
    if (this.visionApiKeyInput || this.sttApiKeyInput || this.assistApiKeyInput || this.embeddingApiKeyInput || this.faceApiKeyInput || this.rerankApiKeyInput || this.decisionApiKeyInput) return true;
    if (!this.touched()) return false;
    // Derived from the sections rather than one whole-config snapshot, so that saving one card leaves the
    // guard still warning about the others. A single snapshot would have gone clean for all of them.
    return ALL_SECTIONS.some(sec => this.sectionSnapshot(sec) !== (this.savedSnapshots[sec] ?? ''));
  }

  // ── document extraction helpers ──
  //
  // These return i18n KEYS rather than prose. They used to return English sentences, which is how the
  // page ended up rendering "As much as this instance can do…" underneath a fully German heading — the
  // strings lived in a service, so the template's transloco pipe never saw them. The characterization
  // tests assert on these keys now: same states reported, different representation.
  /**
   * Set the document extraction mode.
   *
   * `touched.set(true)` is load-bearing, and its absence was a BLOCKER. The mode is a segmented control — a row
   * of `<button>`s — and a button click fires neither `input` nor `change`, so the page's single delegated
   * `(input)/(change)` listener never saw it. The form mutated, `touched()` stayed false,
   * `pipeDirty('pipe-documents')` therefore stayed false, and **the Documents pipeline's Save button was never
   * rendered at all.** A reporting operator had `DOC_VERIFY_MODEL` configured and resident with no way to raise
   * the level its consensus pass needs: a feature fully provisioned and unreachable, and nothing errored.
   *
   * `setCeiling` already did this, and `models-tab` carries the same note verbatim ("programmatic change — the
   * page's input listener won't see it"). The trap was known in two places and missed here.
   */
  setMode(m: DocMode): void {
    this.docMode.set(m);
    if (this.form.documentProcessing) this.form.documentProcessing.mode = m;
    this.touched.set(true);
  }
  private vlmConfigured(): boolean { return !!this.docCfg().vlmModel; }
  // 'off' runs nothing, so a missing vision model is not a problem it can have.
  vlmNeededButMissing(): boolean { return this.docMode() !== 'ocr' && this.docMode() !== 'off' && !this.vlmConfigured(); }
  modeDescKey(): string { return `mediaProcessing.modeDesc.${this.docMode()}`; }
  stageClass(key: string): string {
    if (!MODE_STAGES[this.docMode()].has(key)) return 'dim';
    if (this.vlmNeededButMissing() && (key === 'render' || key === 'vlm' || key === 'repair')) return 'warn';
    return 'on';
  }
  /** Key plus the interpolation params, so the sentence can be re-ordered per language. */
  docSummary(): { key: string; params: Record<string, string> } {
    const m = this.docMode();
    const params = { mode: m.toUpperCase(), model: this.docCfg().vlmModel ?? '' };
    if (m === 'off') return { key: 'mediaProcessing.docSummary.off', params };
    if (m === 'ocr') return { key: 'mediaProcessing.docSummary.ocr', params };
    if (this.vlmNeededButMissing()) return { key: 'mediaProcessing.docSummary.fallback', params };
    return { key: m === 'repair' || m === 'auto' ? 'mediaProcessing.docSummary.repaired' : 'mediaProcessing.docSummary.vlm', params };
  }
  docPillLabelKey(): string {
    if (this.docMode() === 'off') return 'mediaProcessing.docPill.off';
    return this.vlmNeededButMissing() ? 'mediaProcessing.docPill.fallback' : 'mediaProcessing.docPill.active';
  }
  docVariant(): StatusVariant {
    if (this.docMode() === 'off') return 'off';
    return this.vlmNeededButMissing() ? 'warn' : 'active';
  }

  // ── per-class on/off (media embedding is always on; each class is gated by its level) ──
  /** A media class is active unless its instance level is `off` (absent ⇒ `auto` ⇒ active). Drives the
   *  vision (images) / STT (audio) "active/off" pills now that the master switch is gone. */
  mediaClassOn(cls: MediaClass): boolean { return (this.form.levels?.[cls] ?? 'auto') !== 'off'; }

  /**
   * The PATCH body. Split out of `save()` so the dirty check can compare against it — the set of
   * fields that are actually persisted is exactly the set worth prompting about.
   *
   * API keys are deliberately absent: the values held on `form` are the server's masks, and echoing a
   * mask back would overwrite a real credential with asterisks. Only a key the operator typed is
   * added, in `save()`.
   */
  private payload(): MediaCfg {
    const dp = this.form.documentProcessing ?? {};
    const levels = this.form.levels ?? {};
    return {
      // Instance ceilings, sent per class. The server merges class by class for the same reason this
      // sends all four: a partial block would let the classes it omits default back up to `auto`.
      levels: { images: levels.images, audio: levels.audio, video: levels.video, text: levels.text },
      visionProvider: this.form.visionProvider,
      sttProvider: this.form.sttProvider,
      vision: { baseUrl: this.form.vision?.baseUrl, model: this.form.vision?.model },
      stt: { baseUrl: this.form.stt?.baseUrl, model: this.form.stt?.model },
      embedding: {
        provider: this.embedding.provider,
        baseUrl: this.embedding.baseUrl || null,
        model: this.embedding.model,
        dimensions: this.embedding.dimensions,
        similarity: this.embedding.similarity,
        prefixScheme: this.embedding.prefixScheme,
      },
      // Reranker, minus `apiKey` (same mask rule as everywhere else). `|| null` on the endpoint and
      // model so CLEARING either reaches the server as an explicit delete — that is how reranking gets
      // switched off, and an empty string would be stored as a configured-but-blank endpoint.
      rerank: {
        baseUrl: this.rerank.baseUrl || null,
        model: this.rerank.model || null,
        candidateMultiplier: this.rerank.candidateMultiplier,
      },
      // NLI, same rule: `|| null` so CLEARING reaches the server as an explicit delete rather than a
      // configured-but-blank endpoint, which is how the judge gets switched back off.
      nli: {
        baseUrl: this.nli.baseUrl || null,
        model: this.nli.model || null,
      },
      // Only the PATCH-writable doc fields (vlmModel/repairModel/URLs are env-only, never sent).
      documentProcessing: {
        mode: dp.mode, renderDpi: dp.renderDpi, maxPages: dp.maxPages, pageTimeoutMs: dp.pageTimeoutMs,
        concurrency: dp.concurrency, ocrTimeoutMs: dp.ocrTimeoutMs,
      },
      /*
       * Only the PATCH-writable face fields.
       *
       * `enabled` IS NOT ONE, and sending it broke every save on this page — the whole body, not just the
       * face block, because the PATCH schema is `.strict()`:
       *
       *     {"error":"Invalid request body","details":[{"code":"unrecognized_keys","keys":["enabled"],
       *       "path":["faceRecognition"],"message":"Unrecognized key: \"enabled\""}]}
       *
       * Reported by the canary operator 2026-08-20 after their owner spent an afternoon behind it. The comment
       * above this list was already correct and the list did not match it: `enabled` became an infra/env pin
       * when the face switch was removed, `modelPath` and `reprocessSyncedImages` were correctly dropped from
       * here at the same time, and this one was left behind. The card's own template says so in as many words —
       * *"No enable switch... deliberately not editable here"* — so nothing in the UI could even change it.
       * It was pure echo of the GET, and it cost the page.
       */
      faceRecognition: {
        confidenceThreshold: this.face.confidenceThreshold,
        minFaceSizeFraction: this.face.minFaceSizeFraction,
        personEntityTypes: this.face.personEntityTypes,
        // Endpoint block, minus `apiKey` — `form` holds the server's MASK, and echoing it back would
        // overwrite a real credential with asterisks. A typed key is grafted on at save.
        ...(this.faceExternalLocked() ? {} : { externalModel: {
          baseUrl: this.faceExternal.baseUrl || undefined,
          model: this.faceExternal.model || undefined,
          acknowledgedHost: this.faceExternal.acknowledgedHost,
        } }),
      },
      fallbackToExternal: this.form.fallbackToExternal,
      maxFileSizeBytes: this.form.maxFileSizeBytes,
      workerConcurrency: this.form.workerConcurrency,
    };
  }

  /**
   * Save ONE card.
   *
   * Only that card's block is sent, and only its confirmation gate runs. Both halves matter: each gate in
   * the global `save()` belongs to exactly one card (egress consent to assist, the face-off warning to
   * face, the re-embed warning to embedding), so running all three from a card would ask about re-indexing
   * every vector because someone edited a speech-to-text URL.
   *
   * On success only this card is re-baselined and only its API-key box is cleared — an edit sitting in
   * another card must keep reporting itself as unsaved.
   */
  async saveCard(card: ModelCardId): Promise<void> {
    if (this.managed || this.saving()) return;

    if (card === 'assist' && !this.assistLocked() && this.assistNeedsAck()) {
      const host = this.assistHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.egressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.egressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      this.assist.acknowledgedHost = host;
    }
    // `F-33`: an external fallback is egress like the primary, consented for its own host.
    if (card === 'assist' && !this.assistLocked() && fallbackNeedsAck(this.assist, this.repairReachable())) {
      const host = hostOf(this.assist.fallback?.baseUrl);
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.egressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.egressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      this.assist.fallback = { ...this.assist.fallback, acknowledgedHost: host };
    }
    if (card === 'face' && !this.faceExternalLocked() && this.faceExternalNeedsAck()) {
      const host = this.faceExternalHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.faceEgressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.faceEgressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.faceEgressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      this.faceExternal.acknowledgedHost = host;
    }
    if (card === 'decision' && !this.decisionLocked() && this.decisionNeedsAck()) {
      const host = this.decisionHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.decisionEgressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.decisionEgressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      this.decision.acknowledgedHost = host;
    }
    if (card === 'embedding' && this.embeddingNeedsReindex()) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.reindexTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.reindexMessage'),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.reindexConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }

    this.saving.set(true);
    this.saveError.set('');
    this.saveOk.set('');

    // The typed key is grafted on here for the same reason the global save does it: `payload()` holds the
    // server's MASK, and echoing a mask back would overwrite a real credential with asterisks.
    const key = this.cardKeyInput(card);
    const block = this.cardBlock(card);
    if (key) {
      if (card === 'vision') block.vision = { ...block.vision, apiKey: key };
      else if (card === 'stt') block.stt = { ...block.stt, apiKey: key };
      else if (card === 'embedding') block.embedding = { ...block.embedding, apiKey: key };
      else if (card === 'rerank') block.rerank = { ...block.rerank, apiKey: key };
      else if (card === 'nli') block.nli = { ...block.nli, apiKey: key };
      else if (card === 'assist') {
        block.documentProcessing = { assistModel: { ...block.documentProcessing?.assistModel, apiKey: key } };
      }
      else if (card === 'face') {
        block.faceRecognition = { ...block.faceRecognition, externalModel: { ...block.faceRecognition?.externalModel, apiKey: key } };
      }
      else if (card === 'decision') block.decisionModel = { ...this.decisionEndpoint(), apiKey: key };
    }

    const body = JSON.parse(JSON.stringify(block)) as MediaCfg;
    this.http.patch<{ ok: boolean; config: MediaCfg }>('/api/admin/media-config', body).subscribe({
      next: () => {
        this.saveOk.set(this.transloco.translate('mediaProcessing.saved'));
        if (card === 'vision') this.visionApiKeyInput = '';
        else if (card === 'stt') this.sttApiKeyInput = '';
        else if (card === 'assist') {
          this.assistApiKeyInput = '';
          if (this.assistFallbackApiKeyInput) this.assistFallbackKeySet = true;
          this.assistFallbackApiKeyInput = '';
        }
        else if (card === 'embedding') { this.embeddingApiKeyInput = ''; this.embeddingReindexBaseline = this.reindexKey(); }
        else if (card === 'rerank') { this.rerankApiKeyInput = ''; }
        else if (card === 'nli') { this.nliApiKeyInput = ''; }
        if (card === 'face') { this.faceApiKeyInput = ''; }
        if (card === 'decision') {
          if (key) this.serverFlags['decisionKeySet'] = true;
          this.decisionApiKeyInput = '';
          this.decisionLoaded = JSON.stringify(this.decisionEndpoint());
        }
        this.rebaseline([card]);
        this.saving.set(false);
        setTimeout(() => this.saveOk.set(''), 3000);
      },
      error: err => { this.saveError.set(`Save failed: ${err?.error?.error ?? err?.message ?? 'Unknown error'}`); this.saving.set(false); },
    });
  }

  async save(): Promise<void> {
    if (this.managed) return; // infra-managed: the API would reject it anyway
    const dp = this.form.documentProcessing ?? {};
    const assist = dp.assistModel ?? {};
    const host = this.assistHost();

    // F11-b — egress acknowledgment: making an external endpoint REACHABLE by the repair pass, without its
    // host already acknowledged, requires an explicit confirmation that document content leaves the box.
    if (!this.assistLocked() && this.assistNeedsAck()) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.egressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.egressMessage', { host }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.egressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;              // not acknowledged → abort the whole save
      assist.acknowledgedHost = host;
    }

    // Turning face recognition OFF stops new faces being detected — it does NOT remove the face
    // vectors and person links already stored. An operator disabling this is usually acting on a
    // privacy decision, so letting them believe the existing data went away would be the worst kind
    // of quiet failure: they would have been told the opposite of what happened.
    if (!this.faceExternalLocked() && this.faceExternalNeedsAck()) {
      const fHost = this.faceExternalHost();
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.faceEgressTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.faceEgressMessage', { host: fHost }),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.faceEgressConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      this.faceExternal.acknowledgedHost = fHost;
    }

    // Reindex confirmation: changing the embedding model / dimensions / similarity re-embeds EVERY
    // vector in every space. Make the operator acknowledge it — and that it takes a while.
    if (this.embeddingNeedsReindex()) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.reindexTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.reindexMessage'),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.reindexConfirm'),
        cancelLabel: this.transloco.translate('common.cancel'),
        danger: true,
      });
      if (!ok) return;
    }

    this.saving.set(true);
    this.saveError.set('');
    this.saveOk.set('');
    // Assist block: send baseUrl/model/acknowledgedHost (+ apiKey only when the operator typed a
    // new one — the masked value from GET is never echoed back). Omitted when locked by env.
    const assistPayload: DocAssistCfg | undefined = this.assistLocked() ? undefined : {
      baseUrl: assist.baseUrl || undefined,
      model: assist.model || undefined,
      acknowledgedHost: assist.acknowledgedHost,
      acknowledgedHostForConversations: assist.acknowledgedHostForConversations ?? null,
      ...(this.assistApiKeyInput ? { apiKey: this.assistApiKeyInput } : {}),
    };
    const base = this.payload();
    const payload: MediaCfg = {
      ...base,
      vision: { ...base.vision, ...(this.visionApiKeyInput ? { apiKey: this.visionApiKeyInput } : {}) },
      stt: { ...base.stt, ...(this.sttApiKeyInput ? { apiKey: this.sttApiKeyInput } : {}) },
      embedding: { ...base.embedding, ...(this.embeddingApiKeyInput ? { apiKey: this.embeddingApiKeyInput } : {}) },
      rerank: { ...base.rerank, ...(this.rerankApiKeyInput ? { apiKey: this.rerankApiKeyInput } : {}) },
      nli: { ...base.nli, ...(this.nliApiKeyInput ? { apiKey: this.nliApiKeyInput } : {}) },
      documentProcessing: { ...base.documentProcessing, ...(assistPayload ? { assistModel: assistPayload } : {}) },
    };
    const body = JSON.parse(JSON.stringify(payload)) as MediaCfg;
    this.http.patch<{ ok: boolean; config: MediaCfg }>('/api/admin/media-config', body).subscribe({
      next: () => {
        this.saveOk.set(this.transloco.translate('mediaProcessing.saved'));
        this.visionApiKeyInput = '';
        this.sttApiKeyInput = '';
        this.assistApiKeyInput = '';
        this.embeddingApiKeyInput = '';
        this.faceApiKeyInput = '';
        this.embeddingReindexBaseline = this.reindexKey(); // re-baseline so a second save won't re-prompt
        this.rebaseline(ALL_SECTIONS);
        this.touched.set(false);
        this.saving.set(false);
        setTimeout(() => this.saveOk.set(''), 3000);
      },
      error: err => { this.saveError.set(`Save failed: ${err?.error?.error ?? err?.message ?? 'Unknown error'}`); this.saving.set(false); },
    });
  }
}
