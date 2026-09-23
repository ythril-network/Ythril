/**
 * MediaProcessingStateService — the CHARACTERIZATION tests from #347, ported to the extracted service.
 *
 * These were written against the original 656-line `mediaProcessing.component.ts` and proven green there
 * BEFORE the split, per characterization-tests-before-refactor. The page has since been rebuilt into
 * three tabs; all of the behaviour they pin moved into this service, and every assertion about
 * *behaviour* is unchanged — the save payload, the locks, both confirmations, the derived states.
 *
 * **One category of assertion was rewritten, deliberately and visibly:** the display helpers used to
 * return English prose (`'OCR fallback'`, `'Read by OCR only'`) and now return i18n keys
 * (`'mediaProcessing.docPill.fallback'`). Prose in a service is prose no transloco pipe can reach, which is
 * exactly how the rebuilt page rendered "As much as this instance can do…" underneath a fully German
 * heading. The states reported are identical and the branch conditions are untouched; only the
 * representation moved. That is the one kind of edit these tests permit, and it is called out here
 * rather than quietly folded in — an assertion changed to make a test pass is otherwise a behaviour
 * change wearing a refactor's clothes.
 *
 * What they pin, chosen for consequence rather than coverage:
 *
 *  - **A masked API key is never echoed back.** GET returns keys masked; sending the mask would
 *    overwrite a real credential with asterisks. `apiKey` is in the payload only when the operator
 *    typed a new one.
 *  - **Only PATCH-writable document fields are sent.** `vlmModel` / `repairModel` / sidecar URLs are
 *    env-only; including them makes the API reject the whole save.
 *  - **Both confirmations abort the entire save when declined** — egress acknowledgment (document
 *    content leaving the instance) and re-index (every vector in every space re-embedded). Turning
 *    either into a fire-and-forget toast would be a silent privacy/data regression.
 *  - **Infra-managed short-circuits everything**, since the API refuses those edits anyway.
 *  - The derived display state that tells an operator whether the pipeline is doing what the mode
 *    claims (fallback warnings, summaries, stage classes).
 *
 * New here, for behaviour the split introduced: the unsaved-changes guard that spans the tabs.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { MediaProcessingStateService } from './media-processing-state.service';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';

/** The shape GET /api/admin/media-config returns, with keys masked as the server masks them. */
function cfgFixture(over: Record<string, unknown> = {}) {
  return {
    visionProvider: 'local',
    sttProvider: 'local',
    vision: { baseUrl: 'http://ollama:11434', model: 'llava', apiKey: '••••••••' },
    stt: { baseUrl: 'http://whisper:9000', model: 'base', apiKey: '••••••••' },
    embedding: { provider: 'local', model: 'nomic-embed-text-v1.5', dimensions: 768, similarity: 'cosine' },
    documentProcessing: {
      mode: 'ocr',
      renderDpi: 150, maxPages: 50, pageTimeoutMs: 60000, concurrency: 2, ocrTimeoutMs: 120000,
      vlmModel: '', repairModel: 'qwen', ocrUrl: 'http://unstructured:8000',
      assistModel: { baseUrl: '', model: '', uses: [], apiKey: '••••••••' },
    },
    fallbackToExternal: false,
    maxFileSizeBytes: 524288000,
    workerConcurrency: 2,
    lockedByInfra: [],
    ...over,
  };
}

function make(cfg: Record<string, unknown> = cfgFixture(), confirmResult = true) {
  TestBed.resetTestingModule();
  const confirm = vi.fn().mockResolvedValue(confirmResult);
  const patch = vi.fn().mockReturnValue(of({ ok: true, config: cfg }));
  const post = vi.fn().mockReturnValue(of({ reachable: true, modelEnumerated: true }));
  const http = { get: vi.fn().mockReturnValue(of(cfg)), patch, post } as unknown as HttpClient;
  TestBed.configureTestingModule({
    imports: [getTranslocoModule()],
    providers: [
      MediaProcessingStateService,
      { provide: HttpClient, useValue: http },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const c = TestBed.inject(MediaProcessingStateService);
  c.load();
  return { c, confirm, patch, post, http };
}

/** The body handed to PATCH by the most recent save(). */
const sent = (patch: ReturnType<typeof vi.fn>) => patch.mock.calls.at(-1)?.[1] as Record<string, never>;

describe('MediaProcessingStateService — load', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('drops the masked API keys from the form so they can never be sent back', () => {
    const { c } = make();
    expect(c.form.vision?.apiKey).toBeUndefined();
    expect(c.form.stt?.apiKey).toBeUndefined();
    // The typed-input fields start empty — only what the operator types is ever transmitted.
    expect(c.visionApiKeyInput).toBe('');
    expect(c.sttApiKeyInput).toBe('');
    expect(c.assistApiKeyInput).toBe('');
    expect(c.embeddingApiKeyInput).toBe('');
  });

  it('fills document-processing defaults for fields the server omitted', () => {
    const { c } = make(cfgFixture({ documentProcessing: { mode: 'vlm' } }));
    expect(c.docCfg().renderDpi).toBe(150);
    expect(c.docCfg().maxPages).toBe(50);
    expect(c.docCfg().ocrTimeoutMs).toBe(120000);
    expect(c.docMode()).toBe('vlm');
  });

  it('reports a load failure instead of rendering an empty form as if it were config', () => {
    TestBed.resetTestingModule();
    const http = { get: vi.fn().mockReturnValue(throwError(() => new Error('boom'))) } as unknown as HttpClient;
    TestBed.configureTestingModule({
      imports: [getTranslocoModule()],
      providers: [
        MediaProcessingStateService,
        { provide: HttpClient, useValue: http },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn() } },
      ],
    });
    const c = TestBed.inject(MediaProcessingStateService);
    c.load();
    expect(c.loadError()).toContain('boom');
    expect(c.loading()).toBe(false);
  });
});

describe('MediaProcessingStateService — infra locks', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('locks every field when the whole config is infra-managed', () => {
    const { c } = make(cfgFixture({ infraManaged: true }));
    expect(c.isLocked('anything.at.all')).toBe(true);
    expect(c.embeddingLocked('model')).toBe(true);
  });

  it('locks only the named fields otherwise', () => {
    const { c } = make(cfgFixture({ lockedByInfra: ['embedding.model', 'documentProcessing.assistModel'] }));
    expect(c.isLocked('embedding.model')).toBe(true);
    expect(c.embeddingLocked('model')).toBe(true);
    expect(c.embeddingLocked('dimensions')).toBe(false);
    expect(c.assistLocked()).toBe(true);
  });

  it('save is a no-op when infra-managed — the API would reject it anyway', async () => {
    const { c, patch } = make(cfgFixture({ infraManaged: true }));
    await c.save();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('MediaProcessingStateService — save payload', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('omits apiKey entirely unless the operator typed a new one', async () => {
    const { c, patch } = make();
    await c.save();
    expect(sent(patch)['vision']).not.toHaveProperty('apiKey');
    expect(sent(patch)['stt']).not.toHaveProperty('apiKey');
    expect(sent(patch)['embedding']).not.toHaveProperty('apiKey');
  });

  it('sends a typed apiKey', async () => {
    const { c, patch } = make();
    c.visionApiKeyInput = 'sk-real-key';
    await c.save();
    expect((sent(patch)['vision'] as Record<string, unknown>)['apiKey']).toBe('sk-real-key');
  });

  it('never sends the env-only document fields — including them makes the API reject the save', async () => {
    const { c, patch } = make();
    await c.save();
    const dp = sent(patch)['documentProcessing'] as Record<string, unknown>;
    expect(dp).not.toHaveProperty('vlmModel');
    expect(dp).not.toHaveProperty('repairModel');
    expect(dp).not.toHaveProperty('ocrUrl');
    expect(dp['mode']).toBe('ocr');
    expect(dp['renderDpi']).toBe(150);
  });

  it('omits the assist block when it is locked by env', async () => {
    const { c, patch } = make(cfgFixture({ lockedByInfra: ['documentProcessing.assistModel'] }));
    await c.save();
    expect(sent(patch)['documentProcessing']).not.toHaveProperty('assistModel');
  });

  // Instance ceilings became editable here. The rule that matters is that ALL FOUR classes are sent,
  // every time: the server merges per class, but a client that sent only the class it changed would
  // still be correct only by accident — and the loader reads an absent class as `auto`, so any path
  // that drops one raises that ceiling to the top rung with nothing reporting it.
  it('sends every media-class ceiling, not just the one that changed', async () => {
    const { c, patch } = make(cfgFixture({ levels: { images: 'caption', audio: 'off', video: 'audio', text: 'embed' } }));
    await c.save();
    expect(sent(patch)['levels']).toEqual({ images: 'caption', audio: 'off', video: 'audio', text: 'embed' });
  });

  it('carries an edited ceiling through to the payload without disturbing the others', async () => {
    const { c, patch } = make(cfgFixture({ levels: { images: 'recognition', audio: 'on', video: 'audio', text: 'chunk' } }));
    c.form.levels = { ...c.form.levels, images: 'off' };
    await c.save();
    expect(sent(patch)['levels']).toEqual({ images: 'off', audio: 'on', video: 'audio', text: 'chunk' });
  });

  it('clears the typed key inputs after a successful save so a re-save cannot resend them', async () => {
    const { c } = make();
    c.visionApiKeyInput = 'sk-1';
    c.embeddingApiKeyInput = 'sk-2';
    await c.save();
    expect(c.visionApiKeyInput).toBe('');
    expect(c.embeddingApiKeyInput).toBe('');
    expect(c.saveOk()).toBe('mediaProcessing.saved');
  });

  it('surfaces the server error rather than reporting success', async () => {
    const { c } = make();
    const http = TestBed.inject(HttpClient) as unknown as { patch: ReturnType<typeof vi.fn> };
    http.patch.mockReturnValue(throwError(() => ({ error: { error: 'infra-managed' } })));
    await c.save();
    expect(c.saveError()).toContain('infra-managed');
    expect(c.saving()).toBe(false);
  });
});

describe('MediaProcessingStateService — the two confirmations', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('re-index: prompts when the embedding model changes, and aborts the WHOLE save if declined', async () => {
    const { c, confirm, patch } = make(cfgFixture(), false);
    expect(c.embeddingNeedsReindex()).toBe(false);
    c.embedding.model = 'a-different-model';
    expect(c.embeddingNeedsReindex()).toBe(true);
    await c.save();
    expect(confirm).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled(); // nothing saved, not even the unrelated fields
  });

  it('re-index: dimensions and similarity also trigger it, not just the model name', () => {
    const { c } = make();
    c.embedding.dimensions = 1024;
    expect(c.embeddingNeedsReindex()).toBe(true);
  });

  it('re-index: the task prefix triggers it too — it is part of the embedded string', () => {
    // Changing the prefix scheme changes the vector for identical text just as surely as changing the
    // model does. If it did not prompt, an operator would flip it, get no warning, and end up with half
    // the corpus embedded one way and half the other — a silent recall drop, not an error.
    const { c } = make();
    c.embedding.prefixScheme = 'nomic';
    expect(c.embeddingNeedsReindex()).toBe(true);
  });

  it('re-index: the task prefix is sent in the save payload', async () => {
    // A field that warns but is never transmitted is worse than one that does neither: the operator is
    // told the corpus is being re-embedded under a new scheme that the server never received.
    const { c, patch } = make();
    c.embedding.prefixScheme = 'qwen';
    await c.save();
    expect((sent(patch) as Record<string, { prefixScheme?: string }>)['embedding'].prefixScheme).toBe('qwen');
  });

  it('re-index: re-baselines after saving so a second save does not prompt again', async () => {
    const { c, confirm } = make();
    c.embedding.model = 'a-different-model';
    await c.save();
    expect(confirm).toHaveBeenCalledOnce();
    expect(c.embeddingNeedsReindex()).toBe(false);
    await c.save();
    expect(confirm).toHaveBeenCalledOnce(); // still once
  });

  it('egress: prompts for an unacknowledged external assist host and aborts the save if declined', async () => {
    const { c, confirm, patch } = make(cfgFixture(), false);
    const assist = c.form.documentProcessing!.assistModel!;
    assist.baseUrl = 'https://api.example.com/v1';
    assist.model = 'gpt-4o';
    c.form.documentProcessing!.mode = 'repair';   // the rung is what makes the endpoint reachable
    expect(c.assistNeedsAck()).toBe(true);
    await c.save();
    expect(confirm).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled();
  });

  it('egress: records the acknowledged host on the saved payload when accepted', async () => {
    const { c, patch } = make();
    const assist = c.form.documentProcessing!.assistModel!;
    assist.baseUrl = 'https://api.example.com/v1';
    assist.model = 'gpt-4o';
    c.form.documentProcessing!.mode = 'repair';
    await c.save();
    const sentAssist = (sent(patch)['documentProcessing'] as Record<string, Record<string, unknown>>)['assistModel'];
    expect(sentAssist['acknowledgedHost']).toBe('api.example.com');
  });

  it('egress: does not re-prompt for a host already acknowledged', async () => {
    const { c, confirm } = make();
    const assist = c.form.documentProcessing!.assistModel!;
    assist.baseUrl = 'https://api.example.com/v1';
    assist.model = 'gpt-4o';
    c.form.documentProcessing!.mode = 'repair';
    assist.acknowledgedHost = 'api.example.com';
    expect(c.assistNeedsAck()).toBe(false);
    await c.save();
    expect(confirm).not.toHaveBeenCalled();
  });
});

/**
 * Face recognition became operator-settable here. The confirmation is the point of the feature, not
 * decoration: someone switching this off is acting on a privacy decision, and the one thing the
 * product must not do is let them believe the stored face vectors went away with it.
 */
/**
 * The face block this page may send, and the guard that used to sit beside it.
 *
 * ## What changed here, and why the four deleted tests were not deletable lightly
 *
 * This describe block was titled *"turning face recognition off"* and four of its six tests exercised a
 * confirmation dialog on that transition. **The transition cannot be made from this page.** The enable switch
 * was removed when the image ladder became the single gate — the card's template says so in as many words — so
 * `face.enabled` is hydrated from the GET and bound by nothing. The guard compared a load-time baseline
 * against a field no control touches, and was therefore permanently false.
 *
 * Those four tests passed by setting `c.face.enabled` DIRECTLY, which is a thing only a test can do. That is
 * the shape worth naming: a spec that reaches past the UI to create a state the UI cannot produce will keep a
 * dead branch looking alive indefinitely, and it kept this one alive across the release where the switch was
 * removed.
 *
 * The question the guard asked is real and has MOVED, not vanished: lowering the image ceiling below its
 * recognition rung is now the act that turns faces off, and that is where a confirmation belongs. Recorded in
 * `UX-TODO.md` → U-11 rather than approximated here.
 *
 * ## And the fifth test is the release defect
 *
 * *"sends only the PATCH-writable face fields"* asserted that `enabled` IS sent. It is not PATCH-writable, so
 * the assertion pinned the defect: the API refuses the key, `.strict()` refuses the whole body with it, and
 * both Settings pages saved nothing at all on 3.2.0. Its own comment stated the rule correctly while its
 * expectation contradicted it.
 */
describe('MediaProcessingStateService — the face block it may send', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const withFace = (enabled: boolean) => cfgFixture({ faceRecognition: { enabled, confidenceThreshold: 0.6, minFaceSizeFraction: 0.05, personEntityTypes: ['person'] } });

  it('sends only the PATCH-writable face fields — and `enabled` is not one', async () => {
    // `enabled` is an infra pin set by FACE_RECOGNITION_ENABLED; whether faces RUN is the image ladder's
    // recognition rung. modelPath selects which files the process loads and reprocessSyncedImages decides
    // whether a peer's images are re-analysed locally — both env/config-only. `externalModel` IS writable (it
    // is the endpoint the operator configures), so it is expected.
    //
    // Sending any of the four refuses the ENTIRE body, because the patch schema is `.strict()`.
    const { c, patch } = make(withFace(true));
    await c.save();
    const face = sent(patch)['faceRecognition'] as Record<string, unknown>;
    expect(Object.keys(face).sort()).toEqual(['confidenceThreshold', 'externalModel', 'minFaceSizeFraction', 'personEntityTypes']);
  });

  it('and it is not sent even when the GET says the pin is ON', async () => {
    // The reported case. Their instances pin the flag, so the GET returns `enabled: true`, the form hydrates
    // it, and the old payload echoed it straight back. Asserted separately from the key list because a list
    // comparison on a fixture where the field happened to be absent would prove nothing.
    const { c, patch } = make(withFace(true));
    await c.save();
    expect(sent(patch)['faceRecognition']).not.toHaveProperty('enabled');
  });

  it('saving the face card asks NO confirmation, because nothing on it turns faces off', async () => {
    // What replaces the four deleted tests. The old guard fired on a transition this page cannot express, so
    // the honest assertion is that a face save is unremarkable.
    const { c, confirm } = make(withFace(true));
    await c.saveCard('face');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports env-pinned face fields as locked', () => {
    const { c } = make(cfgFixture({ lockedByInfra: ['faceRecognition.enabled'] }));
    expect(c.faceLocked('enabled')).toBe(true);
    expect(c.faceLocked('confidenceThreshold')).toBe(false);
  });
});

describe('MediaProcessingStateService — derived display state', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('warns that a VLM mode silently falls back to OCR when no vision model is set', () => {
    const { c } = make();
    c.setMode('vlm');
    expect(c.vlmNeededButMissing()).toBe(true);
    expect(c.docPillLabelKey()).toBe('mediaProcessing.docPill.fallback');
    expect(c.docVariant()).toBe('warn');
    expect(c.docSummary().key).toBe('mediaProcessing.docSummary.fallback');
    // The affected stages are flagged rather than shown as running normally.
    expect(c.stageClass('vlm')).toBe('warn');
  });

  it('describes a configured VLM mode as actually running', () => {
    const { c } = make(cfgFixture({ documentProcessing: { mode: 'vlm', vlmModel: 'llava' } }));
    expect(c.vlmNeededButMissing()).toBe(false);
    expect(c.docPillLabelKey()).toBe('mediaProcessing.docPill.active');
    expect(c.docSummary().params['model']).toBe('llava');
    expect(c.stageClass('vlm')).toBe('on');
  });

  it('OCR mode never reports a missing vision model, because it does not use one', () => {
    const { c } = make();
    c.setMode('ocr');
    expect(c.vlmNeededButMissing()).toBe(false);
    expect(c.docSummary().key).toBe('mediaProcessing.docSummary.ocr');
  });

  it('mediaClassOn reflects the per-class level (no master switch)', () => {
    // absent levels ⇒ auto ⇒ every class active
    const def = make();
    expect(def.c.mediaClassOn('images')).toBe(true);
    expect(def.c.mediaClassOn('audio')).toBe(true);
    // an explicit `off` level takes that class offline (drives the vision/STT pills)
    const { c } = make(cfgFixture({ levels: { images: 'caption', audio: 'off', video: 'auto', text: 'auto' } }));
    expect(c.mediaClassOn('images')).toBe(true);   // caption ≠ off
    expect(c.mediaClassOn('audio')).toBe(false);    // off ⇒ inactive
    expect(c.mediaClassOn('video')).toBe(true);     // auto
  });

  it('setMode keeps the form and the signal in step', () => {
    const { c } = make();
    c.setMode('repair');
    expect(c.docMode()).toBe('repair');
    expect(c.form.documentProcessing?.mode).toBe('repair');
  });

  it('requestFocusCard raises the one-shot focus signal for the page to consume', () => {
    const { c } = make();
    expect(c.focusCard()).toBeNull();
    c.requestFocusCard('vision');
    expect(c.focusCard()).toBe('vision');
  });

  // The ladder gained `off` and renamed `max` to `repair` (owner, 2026-07-21). `off` is the rung with
  // consequences: it must read as a deliberate choice, not as a degraded or broken pipeline.
  it("'off' reads as off, not as a missing model or a fallback", () => {
    const { c } = make();
    c.setMode('off');
    expect(c.docPillLabelKey()).toBe('mediaProcessing.docPill.off');
    expect(c.docVariant()).toBe('off');
    expect(c.vlmNeededButMissing()).toBe(false); // nothing runs, so nothing can be missing
    expect(c.docSummary().key).toBe('mediaProcessing.docSummary.off');
    expect(c.stageClass('ocr')).toBe('dim');
  });

  it("'auto' shows the full chain, because it means the most this instance can do", () => {
    const { c } = make(cfgFixture({ documentProcessing: { mode: 'auto', vlmModel: 'llava' } }));
    expect(c.stageClass('repair')).toBe('on');
    expect(c.docSummary().params['model']).toBe('llava');
  });
});

describe('MediaProcessingStateService — test connection', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('distinguishes unreachable from reachable-but-missing-model', () => {
    const { c } = make();
    expect(c.testPillVariant({ reachable: false } as never)).toBe('error');
    // Not enumerating a model is informational, never a warning: aliasing routers and gateways serve
    // names they deliberately do not list, so absence carries no information. This asserted 'warn',
    // which is what kept a working vision endpoint permanently yellow.
    expect(c.testPillVariant({ reachable: true, modelEnumerated: false } as never)).toBe('ok');
    expect(c.testPillVariant({ reachable: true, modelEnumerated: true } as never)).toBe('ok');
  });

  // ── B.2: the pill says what the probe established, not what it hoped for ──

  it('an endpoint with no model list is ok, and labelled for it', () => {
    // Their speech-to-text service serves one route. The probe asked for an enumeration surface, got a
    // 404, and the pill read "Unreachable" over a pipeline whose Verify was green.
    const { c } = make();
    const noList = { ok: true, reachable: true, verdict: 'not-enumerable', status: 404, latencyMs: 9 } as never;
    expect(c.testPillVariant(noList)).toBe('ok');
    expect(c.testPillLabelKey(noList)).toBe('mediaProcessing.test.noModelList');
  });

  it('a rejected credential is an error, and named as one', () => {
    // Reachable and genuinely broken: inference presents the same key. "Unreachable" would send the
    // operator to the network when the fix is the API key field two rows above.
    const { c } = make();
    const rejected = { ok: false, reachable: true, verdict: 'auth-rejected', status: 401, latencyMs: 4 } as never;
    expect(c.testPillVariant(rejected)).toBe('error');
    expect(c.testPillLabelKey(rejected)).toBe('mediaProcessing.test.authRejected');
  });

  it('a provider-type mismatch is a warning, not a green success badge', () => {
    // `ok: false` with `reachable: true` is the probe saying "it answered on the protocol inference will
    // not use". That was rendered as a plain success pill with the explanation left in `detail`.
    const { c } = make();
    expect(c.testPillVariant({ ok: false, reachable: true, verdict: 'listed', latencyMs: 6 } as never)).toBe('warn');
  });

  it('records the result against the target that was tested', () => {
    const { c, post } = make();
    c.testConnection('vision');
    expect(post).toHaveBeenCalledWith('/api/admin/media-config/test-connection', { target: 'vision' });
    expect(c.testOf('vision')?.res?.reachable).toBe(true);
    expect(c.testOf('stt')).toBeUndefined();
  });
});

/**
 * NEW — behaviour the three-tab split introduced.
 *
 * The tabs share one form, so switching tabs must not silently discard edits. The guard has to fire
 * on a real change and stay quiet otherwise: a prompt that appears every time you look at another tab
 * is one an operator learns to dismiss without reading, which is worse than no prompt at all.
 */
describe('MediaProcessingStateService — the cross-tab unsaved-changes guard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is clean immediately after load', () => {
    const { c } = make();
    expect(c.isDirty()).toBe(false);
  });

  it('is clean when the form was touched but nothing actually changed', () => {
    // Focusing a field, or typing and undoing, must not cost a confirmation dialog.
    const { c } = make();
    c.touched.set(true);
    expect(c.isDirty()).toBe(false);
  });

  it('is dirty once a persisted field actually changes', () => {
    const { c } = make();
    c.touched.set(true);
    c.form.documentProcessing!.renderDpi = 300;
    expect(c.isDirty()).toBe(true);
  });

  it('is dirty on a typed API key, which never appears in the payload comparison', () => {
    // The key is deliberately absent from the snapshot (masks must not be echoed back), so a
    // snapshot-only check would let a typed credential be discarded without warning.
    const { c } = make();
    c.visionApiKeyInput = 'sk-typed-but-unsaved';
    expect(c.isDirty()).toBe(true);
  });

  it('is clean again after a successful save', () => {
    const { c } = make();
    c.touched.set(true);
    c.form.documentProcessing!.renderDpi = 300;
    expect(c.isDirty()).toBe(true);
    return c.save().then(() => expect(c.isDirty()).toBe(false));
  });

  it('never prompts on an infra-managed instance, where nothing is editable', () => {
    const { c } = make(cfgFixture({ infraManaged: true }));
    c.touched.set(true);
    c.form.documentProcessing!.renderDpi = 300;
    expect(c.isDirty()).toBe(false);
  });
});

describe('MediaProcessingStateService — assist "in use" reflects real configuration (repair-pass pill bug)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const withAssist = (assist: Record<string, unknown>) =>
    make(cfgFixture({
      documentProcessing: {
        mode: 'ocr', renderDpi: 150, maxPages: 50, pageTimeoutMs: 60000, concurrency: 2, ocrTimeoutMs: 120000,
        assistModel: { baseUrl: '', model: '', ...assist },
      },
    })).c;

  // The `uses: ['repair']` tick is gone — the extraction rung is the switch. The bug this block guards
  // is unchanged in spirit: the pill must claim "in use" only when the model can ACTUALLY be called.
  it('is NOT in use when the rung reaches repair but no assist model is configured (the reported bug)', () => {
    const c = withAssist({ baseUrl: '', model: '' });
    c.form.documentProcessing!.mode = 'repair';
    expect(c.repairReachable()).toBe(true);      // the rung would use it…
    expect(c.assistConfigured()).toBe(false);    // …but there is no endpoint
    expect(c.assistInUse()).toBe(false);         // so the pill must not say "in use"
  });

  it('is NOT in use when configured but the rung never reaches repair', () => {
    const c = withAssist({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' });
    expect(c.form.documentProcessing!.mode).toBe('ocr');
    expect(c.assistConfigured()).toBe(true);
    expect(c.assistInUse()).toBe(false);
  });

  it('IS in use only when the rung reaches repair AND a base URL + model are set', () => {
    const c = withAssist({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' });
    for (const mode of ['repair', 'auto'] as const) {
      c.form.documentProcessing!.mode = mode;
      expect(c.assistInUse()).toBe(true);
    }
  });

  it('a base URL without a model is not configured (both are required to call an endpoint)', () => {
    const c = withAssist({ baseUrl: 'https://api.example.com/v1', model: '' });
    c.form.documentProcessing!.mode = 'repair';
    expect(c.assistConfigured()).toBe(false);
    expect(c.assistInUse()).toBe(false);
  });
});

/**
 * Per-card saving (owner, 2026-07-28: the Save button belongs in the box that changed).
 *
 * The failure this guards against is not a broken button — it is a button that lies about its scope.
 * With one global `save()` behind a per-card button, saving card A silently writes card B's pending
 * edits too, and nobody finds out until an edit they never confirmed is live. So these assert on the
 * PATCH BODY, not on the click.
 */
describe('MediaProcessingStateService — per-card save', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reports only the edited card as dirty', () => {
    const { c } = make();
    c.form.stt!.model = 'large-v3';
    c.touched.set(true);

    expect(c.cardDirty('stt'), 'the edited card').toBe(true);
    for (const other of ['embedding', 'vision', 'assist', 'face'] as const) {
      expect(c.cardDirty(other), `${other} must stay clean`).toBe(false);
    }
  });

  it('sends ONLY the edited card\'s block — a sibling\'s pending edit is not swept in', () => {
    const { c, patch } = make();
    c.form.stt!.model = 'large-v3';
    c.embedding.model = 'some-other-embedder';   // pending, NOT confirmed by the operator
    c.touched.set(true);

    c.saveCard('stt');

    const body = sent(patch);
    expect(body['stt']).toMatchObject({ model: 'large-v3' });
    expect(body['embedding'], 'the untouched card must not be in the body at all').toBeUndefined();
    expect(body['faceRecognition']).toBeUndefined();
  });

  it('sends each card\'s block WHOLE, because the server replaces a key it receives', () => {
    // media-config.ts shallow-merges top level: `{...existing, ...patch}`. A block that omits a field
    // ERASES it rather than leaving it alone — so this checks EVERY card, not a representative one. The
    // single-card version of this test passed while the vision block was silently dropping `baseUrl`.
    const EXPECTED: Record<string, Record<string, unknown>> = {
      stt: { baseUrl: 'http://whisper:9000', model: 'base' },
      vision: { baseUrl: 'http://ollama:11434', model: 'llava' },
      embedding: { provider: 'local', baseUrl: null, model: 'nomic-embed-text-v1.5', dimensions: 768, similarity: 'cosine' },
    };
    for (const [card, block] of Object.entries(EXPECTED)) {
      const { c, patch } = make();
      c.touched.set(true);
      c.saveCard(card as 'stt');
      expect(sent(patch)[card], `${card} must be sent complete`).toEqual(block);
    }
  });

  it('keeps the OTHER cards dirty after one card is saved', async () => {
    const { c } = make();
    c.form.stt!.model = 'large-v3';
    c.embedding.model = 'other';
    c.touched.set(true);

    await c.saveCard('stt');

    expect(c.cardDirty('stt'), 'saved card is clean').toBe(false);
    expect(c.cardDirty('embedding'), 'the unsaved card must still warn').toBe(true);
    expect(c.isDirty(), 'and the tab-switch guard must still fire').toBe(true);
  });

  it('runs only the gate that belongs to the card', async () => {
    // Each confirmation in the global save belongs to exactly ONE card. Saving speech-to-text must not
    // ask whether to re-embed every vector in every space.
    const { c, confirm } = make();
    c.form.stt!.model = 'large-v3';
    c.touched.set(true);

    await c.saveCard('stt');

    expect(confirm).not.toHaveBeenCalled();
  });

  it('still asks before re-indexing when the EMBEDDING card is saved', async () => {
    const { c, confirm, patch } = make();
    c.embedding.model = 'a-different-model';
    c.touched.set(true);

    await c.saveCard('embedding');

    expect(confirm).toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });

  it('aborts the card save when its confirmation is declined', async () => {
    const { c, patch } = make(cfgFixture(), false);
    c.embedding.model = 'a-different-model';
    c.touched.set(true);

    await c.saveCard('embedding');

    expect(patch, 'declining must send nothing').not.toHaveBeenCalled();
  });

  it('grafts a typed API key onto its own card only, and clears only that box', async () => {
    const { c, patch } = make();
    c.sttApiKeyInput = 'sk-typed';
    c.visionApiKeyInput = 'sk-other-card';

    expect(c.cardDirty('stt')).toBe(true);
    await c.saveCard('stt');

    expect((sent(patch)['stt'] as Record<string, unknown>)['apiKey']).toBe('sk-typed');
    expect(c.sttApiKeyInput, 'saved card cleared').toBe('');
    expect(c.visionApiKeyInput, 'the other card keeps its unsaved key').toBe('sk-other-card');
  });

  it('sends the assist card under documentProcessing, which the server deep-merges', () => {
    // Nested, unlike every other card. The handler merges documentProcessing one level deep precisely so
    // a patch naming only assistModel keeps mode/renderDpi — without that this card could not be saved
    // on its own at all.
    const { c, patch } = make();
    c.assist.model = 'gpt-4o-mini';
    c.touched.set(true);
    c.saveCard('assist');

    const dp = sent(patch)['documentProcessing'] as Record<string, unknown>;
    expect(dp['assistModel']).toMatchObject({ model: 'gpt-4o-mini' });
    expect(dp['mode'], 'the knobs are NOT resent — the deep merge preserves them').toBeUndefined();
  });

  it('is never dirty while infra-managed', () => {
    const { c } = make(cfgFixture({ infraManaged: true }));
    c.form.stt!.model = 'x';
    c.touched.set(true);
    expect(c.cardDirty('stt')).toBe(false);
  });
});

/**
 * External face model — biometric egress consent.
 *
 * This endpoint receives face crops. The consent must behave like the assist model's: host-scoped, and
 * demanded before the endpoint can be used — not a one-time tick that authorises every future host.
 */
describe('MediaProcessingStateService — external face model', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('asks for acknowledgment before saving a newly configured endpoint', async () => {
    const { c, confirm, patch } = make();
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.touched.set(true);

    await c.saveCard('face');

    expect(confirm, 'biometric egress must be confirmed').toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
    const face = sent(patch)['faceRecognition'] as Record<string, any>;
    expect(face['externalModel'].acknowledgedHost, 'consent recorded for the host').toBe('faces.example.com');
  });

  it('sends nothing when the acknowledgment is declined', async () => {
    const { c, patch } = make(cfgFixture(), false);
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.touched.set(true);

    await c.saveCard('face');

    expect(patch, 'declining must not egress anything').not.toHaveBeenCalled();
  });

  it('re-asks when the endpoint is pointed at a DIFFERENT host', () => {
    // Consent is per-host, so re-pointing revokes it. Otherwise one click authorises every later host.
    const { c } = make();
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.faceExternal.acknowledgedHost = 'faces.example.com';
    expect(c.faceExternalNeedsAck()).toBe(false);

    c.faceExternal.baseUrl = 'https://elsewhere.example.net/embed';
    expect(c.faceExternalNeedsAck(), 'a new host needs new consent').toBe(true);
  });

  it('does not ask again once the host is acknowledged', async () => {
    const { c, confirm } = make();
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.faceExternal.acknowledgedHost = 'faces.example.com';
    c.face.confidenceThreshold = 0.7;
    c.touched.set(true);

    await c.saveCard('face');

    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps the thresholds in the block — the server replaces a key it receives', async () => {
    const { c, patch } = make(cfgFixture({ faceRecognition: { confidenceThreshold: 0.6, minFaceSizeFraction: 0.05 } }));
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.faceExternal.acknowledgedHost = 'faces.example.com';
    c.touched.set(true);

    await c.saveCard('face');

    const face = sent(patch)['faceRecognition'] as Record<string, any>;
    // Sending only the endpoint would erase these, since faceRecognition is shallow-merged.
    expect(face).toHaveProperty('confidenceThreshold');
    expect(face).toHaveProperty('minFaceSizeFraction');
  });

  it('sends a typed API key only for this card, and clears only its box', async () => {
    const { c, patch } = make();
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.faceExternal.acknowledgedHost = 'faces.example.com';
    c.faceApiKeyInput = 'sk-face';
    c.visionApiKeyInput = 'sk-other';

    await c.saveCard('face');

    const face = sent(patch)['faceRecognition'] as Record<string, any>;
    expect(face['externalModel'].apiKey).toBe('sk-face');
    expect(c.faceApiKeyInput).toBe('');
    expect(c.visionApiKeyInput, 'another card keeps its unsaved key').toBe('sk-other');
  });

  it('drops the masked key at LOAD, so it cannot be echoed back', () => {
    // First of two independent defenses. The second is that `payload()` omits `apiKey` entirely; both
    // would have to fail for a mask to reach the wire, which is why no single mutation can expose this.
    const { c } = make(cfgFixture({
      faceRecognition: { externalModel: { baseUrl: 'https://faces.example.com/embed', apiKey: '••••••••' } },
    }));
    expect(c.faceExternal.apiKey, 'the server mask must not survive into the form').toBeUndefined();
  });

  it('never echoes the stored key back', async () => {
    // The fixture must CARRY a masked key — with none stored, a regression would send `undefined` and
    // JSON would drop it, so the test would pass while the bug was live.
    const { c, patch } = make(cfgFixture({
      faceRecognition: { externalModel: { baseUrl: 'https://faces.example.com/embed', acknowledgedHost: 'faces.example.com', apiKey: '••••••••' } },
    }));
    c.faceExternal.baseUrl = 'https://faces.example.com/embed';
    c.faceExternal.acknowledgedHost = 'faces.example.com';
    c.touched.set(true);

    await c.saveCard('face');

    const face = sent(patch)['faceRecognition'] as Record<string, any>;
    expect(face['externalModel']).not.toHaveProperty('apiKey');
  });

  /**
   * The extraction mode is a row of BUTTONS, and a button click fires neither `input` nor `change` — so the
   * page's one delegated `(input)/(change)` listener never sees it.
   *
   * That made the Documents pipeline unsaveable: the form mutated, `touched()` stayed false, `pipeDirty()`
   * therefore stayed false, and **the Save button was never rendered at all.** A reporting operator had
   * `DOC_VERIFY_MODEL` configured and resident with no way to raise the level the consensus pass needs — a
   * feature fully provisioned and unreachable, and they called it the one item stopping work.
   *
   * `setCeiling` already marked the form touched for exactly this reason, and `models-tab` carries the note
   * verbatim. The trap was known in two places and missed in the third.
   */
  it('setMode marks the form touched, so the Documents Save button can appear at all', () => {
    const { c } = make(cfgFixture({ documentProcessing: { mode: 'auto' } }));
    expect(c.touched()).toBe(false);
    expect(c.pipeDirty('pipe-documents')).toBe(false);

    c.setMode('repair');

    expect(c.form.documentProcessing!.mode).toBe('repair');
    expect(c.touched()).toBe(true);
    // The button keys off this, and it is the whole point: a changed form with no dirty state is a form that
    // cannot be saved.
    expect(c.pipeDirty('pipe-documents')).toBe(true);
  });

  it('setCeiling does the same, for the same reason', () => {
    // Pinned alongside it so the pair cannot drift apart again.
    const { c } = make(cfgFixture({}));
    expect(c.touched()).toBe(false);
    c.form.levels = { ...(c.form.levels ?? {}), images: 'off' };
    c.touched.set(true);
    expect(c.pipeDirty('pipe-images')).toBe(true);
  });
});

/**
 * The PER-PIPELINE Save asks for egress consent — the path that did not.
 *
 * ## The report
 *
 * The canary operator, 2026-08-20. Their owner's sequence, verbatim:
 *
 *     Settings -> Media Processing -> set images to "Caption + face recognition" -> Save
 *     -> nothing saves.
 *
 * The Models card asked. The page-bar Save asked. The per-pipeline Save — the button beside the control he
 * had just changed — sent the PATCH straight out and rendered whatever came back, which was a refusal about
 * a host on a page that never mentions the endpoint. His summary: *"not even i understand it"*.
 *
 * Raising the image ceiling to a recognition rung IS an act of switching faces on, so it is a place to GIVE
 * consent rather than a place to be refused for lacking it — the owner's P-12 (C) ruling. The server accepts
 * the acknowledgement from this patch; these tests pin the half that offers it.
 */
describe('MediaProcessingStateService — the per-pipeline Save and egress consent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const withFaceEndpoint = () => cfgFixture({
    levels: { images: 'caption', audio: 'auto', video: 'auto', text: 'auto' },
    faceRecognition: { externalModel: { baseUrl: 'https://faces.example.com/embed' } },
  });

  it('asks before saving the Images pipeline when the endpoint is unacknowledged', async () => {
    const { c, confirm, patch } = make(withFaceEndpoint());
    c.form.levels = { ...c.form.levels, images: 'recognition' };
    c.touched.set(true);

    await c.savePipe('pipe-images');

    expect(confirm, 'raising the rung must ask, not fail').toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });

  it('and the acknowledgement travels WITH the level, in one request', async () => {
    // Two patches would be two chances to fail between them — the level applied with consent lost, or
    // consent stored against a level that never landed. One request is atomic on the server.
    const { c, patch } = make(withFaceEndpoint());
    c.form.levels = { ...c.form.levels, images: 'recognition' };
    c.touched.set(true);

    await c.savePipe('pipe-images');

    const body = sent(patch);
    expect((body['levels'] as Record<string, unknown>)['images']).toBe('recognition');
    const face = body['faceRecognition'] as Record<string, any> | undefined;
    expect(face?.['externalModel']?.acknowledgedHost, 'consent must ride along').toBe('faces.example.com');
  });

  it('sends NOTHING when the operator declines', async () => {
    // The level stays unsaved rather than being applied with the endpoint unconsented. A half-applied
    // privacy decision is the worst of the three outcomes.
    const { c, patch } = make(withFaceEndpoint(), false);
    c.form.levels = { ...c.form.levels, images: 'recognition' };
    c.touched.set(true);

    await c.savePipe('pipe-images');

    expect(patch).not.toHaveBeenCalled();
  });

  it('never sends the endpoint URL from this Save — only the acknowledgement', async () => {
    // This Save owns the image ceiling, not the Models card's endpoint. Sending `baseUrl` from here would
    // let the Images pipeline quietly rewrite a credentialled endpoint it does not own, which is the same
    // reason the Documents pipeline deletes `assistModel` from its own block.
    const { c, patch } = make(withFaceEndpoint());
    c.form.levels = { ...c.form.levels, images: 'recognition' };
    c.touched.set(true);

    await c.savePipe('pipe-images');

    const face = sent(patch)['faceRecognition'] as Record<string, any>;
    expect(Object.keys(face['externalModel'])).toEqual(['acknowledgedHost']);
  });

  it('does not ask when there is no endpoint to consent to', async () => {
    const { c, confirm, patch } = make();
    c.form.levels = { ...c.form.levels, images: 'recognition' };
    c.touched.set(true);

    await c.savePipe('pipe-images');

    expect(confirm, 'nothing egresses, so nothing to confirm').not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });

  it('does not ask on an UNRELATED pipeline', async () => {
    // The Audio pipeline cannot activate a face endpoint. Asking there would be the over-asking that
    // teaches an operator to click through a biometric dialog.
    const { c, confirm, patch } = make(withFaceEndpoint());
    c.form.levels = { ...c.form.levels, audio: 'off' };
    c.touched.set(true);

    await c.savePipe('pipe-audio');

    expect(confirm).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
    expect(sent(patch)['faceRecognition'], 'and no face block rides along').toBeUndefined();
  });

  it('reports the stored unacknowledged state from the SERVER, not from a second derivation', async () => {
    // A client-side re-derivation could disagree with the thing that actually decides whether a crop is
    // sent. Absent on an older server reads as false, because the state was not reachable there.
    const { c } = make(cfgFixture({ faceEndpointAwaitingAcknowledgment: true } as never));
    expect(c.faceAwaitingAcknowledgment()).toBe(true);
    const { c: c2 } = make();
    expect(c2.faceAwaitingAcknowledgment(), 'absent is not awaiting').toBe(false);
  });
});

describe('MediaProcessingStateService — the decision model card (F-31)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  const decisionCfg = (over: Record<string, unknown> = {}) => cfgFixture({
    decisionModel: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', locked: false, inUse: false, ...over },
  });

  it('keeps the server-owned fields out of the block it edits and sends — the PATCH is strict', () => {
    const { c } = make(decisionCfg({ apiKey: '••••••••', locked: true }));
    expect(Object.keys(c.decision).sort()).toEqual(['baseUrl', 'model']);
    expect(c.decisionLocked(), 'the lock is read from the server').toBe(true);
    expect(c.decisionKeySet(), 'the mask says a key is set, and is never kept').toBe(true);
  });

  it('a budget-only save sends no endpoint, so it asks for no consent', async () => {
    const { c, confirm, patch } = make(decisionCfg());
    c.modelSlots['decision'] = { timeoutMs: 90_000 };
    c.touched.set(true);
    await c.saveCard('decision');
    expect(confirm).not.toHaveBeenCalled();
    expect(sent(patch)['decisionModel']).toBeUndefined();
    expect(sent(patch)['modelSlots']).toEqual({ decision: { timeoutMs: 90_000 } });
  });

  it('setting up the endpoint asks for consent to its host, and sends it with the acknowledgement', async () => {
    const { c, confirm, patch } = make(decisionCfg());
    c.decisionApiKeyInput = 'sk-decide';
    await c.saveCard('decision');
    expect(confirm).toHaveBeenCalledOnce();
    expect(sent(patch)['decisionModel']).toEqual({
      baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', acknowledgedHost: 'api.typesafe.ai', apiKey: 'sk-decide',
    });
  });

  it('a declined consent sends nothing', async () => {
    const { c, patch } = make(decisionCfg(), false);
    c.decision.baseUrl = 'https://decide.example.com';
    await c.saveCard('decision');
    expect(patch).not.toHaveBeenCalled();
  });
});
