/**
 * Q-914 — an env-pinned document-processing knob is locked on the Pipelines tab and never sent.
 *
 * The defect: one env pin on renderDpi, maxPages, pageTimeoutMs, concurrency or ocrTimeoutMs left its input
 * editable (the tab disabled them only for an infra-managed instance) and the save still named the field, so
 * the server's `blockedByInfra` answered 403 to EVERY save on the page, with nothing on the page saying why.
 *
 * Driven through the real state service and the rendered tab, so the lock the page reads is the one the server
 * reports in `lockedByInfra`: each knob is pinned in turn, and the input, its lock pill and the PATCH body of
 * both saves (the tab's own Save and the page bar's) are asserted.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { PipelinesTabComponent } from './pipelines-tab.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';

const KNOBS = [
  { key: 'renderDpi', input: 'dp-dpi', value: 150 },
  { key: 'maxPages', input: 'dp-maxpages', value: 50 },
  { key: 'pageTimeoutMs', input: 'dp-pagetimeout', value: 60000 },
  { key: 'concurrency', input: 'dp-concurrency', value: 2 },
  { key: 'ocrTimeoutMs', input: 'dp-ocrtimeout', value: 120000 },
] as const;

const cfg = (lockedByInfra: string[]) => ({
  visionProvider: 'local', sttProvider: 'local',
  vision: { baseUrl: 'http://ollama:11434', model: 'llava' },
  stt: { baseUrl: 'http://whisper:9000', model: 'base' },
  embedding: { provider: 'local', model: 'nomic-embed-text-v1.5', dimensions: 768, similarity: 'cosine' },
  documentProcessing: {
    mode: 'ocr', renderDpi: 150, maxPages: 50, pageTimeoutMs: 60000, concurrency: 2, ocrTimeoutMs: 120000,
    assistModel: { baseUrl: '', model: '' },
  },
  lockedByInfra,
});

async function render(lockedByInfra: string[]) {
  TestBed.resetTestingModule();
  const config = cfg(lockedByInfra);
  const patch = vi.fn().mockReturnValue(of({ ok: true, config }));
  const http = { get: vi.fn().mockReturnValue(of(config)), patch, post: vi.fn() } as unknown as HttpClient;
  TestBed.configureTestingModule({
    imports: [PipelinesTabComponent, getTranslocoModule()],
    providers: [
      MediaProcessingStateService,
      { provide: HttpClient, useValue: http },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      { provide: PipelineStatusService, useValue: {
        status: () => null, error: () => null, bySidecarKey: () => new Map(),
        modelState: () => 'ok', sidecarState: () => 'ok', modelDetail: () => null, sidecarDetail: () => null,
      } },
    ],
  });
  const state = TestBed.inject(MediaProcessingStateService);
  state.load();
  const fixture = TestBed.createComponent(PipelinesTabComponent);
  fixture.detectChanges();
  // ngModel applies `[disabled]` to its control in a microtask, so the DOM is only final once the fixture is stable.
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const input = (id: string) => el.querySelector(`#${id}`) as HTMLInputElement;
  const field = (id: string) => input(id).closest('.field') as HTMLElement;
  return { state, patch, input, field };
}

const body = (patch: ReturnType<typeof vi.fn>) =>
  (patch.mock.calls.at(-1)?.[1] as { documentProcessing: Record<string, unknown> }).documentProcessing;

describe('Pipelines tab — a document-processing knob an env var pins (Q-914)', () => {
  for (const pinned of KNOBS) {
    describe(`documentProcessing.${pinned.key} pinned`, () => {
      const others = KNOBS.filter(k => k.key !== pinned.key);

      it('its input is disabled and carries the env lock; the other four stay editable and unmarked', async () => {
        const { input, field } = await render([`documentProcessing.${pinned.key}`]);
        expect(input(pinned.input).disabled, 'pinned input disabled').toBe(true);
        expect(field(pinned.input).textContent, 'pinned input shows the env pill').toContain('mediaProcessing.pill.env');
        for (const o of others) {
          expect(input(o.input).disabled, `${o.key} stays editable`).toBe(false);
          expect(field(o.input).textContent, `${o.key} shows no pill`).not.toContain('mediaProcessing.pill.env');
        }
      });

      it('the tab\'s own Save leaves the field out of the PATCH and still sends the other four', async () => {
        const { state, patch } = await render([`documentProcessing.${pinned.key}`]);
        await state.savePipe('pipe-documents');
        const dp = body(patch);
        expect(dp).not.toHaveProperty(pinned.key);
        for (const o of others) expect(dp[o.key], `${o.key} still sent`).toBe(o.value);
      });

      it('the page-bar Save leaves the field out of the PATCH and still sends the other four', async () => {
        const { state, patch } = await render([`documentProcessing.${pinned.key}`]);
        await state.save();
        const dp = body(patch);
        expect(dp).not.toHaveProperty(pinned.key);
        for (const o of others) expect(dp[o.key], `${o.key} still sent`).toBe(o.value);
      });
    });
  }

  it('with none pinned every input is editable, unmarked, and all five are sent', async () => {
    const { state, patch, input, field } = await render([]);
    for (const k of KNOBS) {
      expect(input(k.input).disabled, k.key).toBe(false);
      expect(field(k.input).textContent, k.key).not.toContain('mediaProcessing.pill.env');
    }
    await state.savePipe('pipe-documents');
    for (const k of KNOBS) expect(body(patch)[k.key], k.key).toBe(k.value);
  });

  it('a pinned extraction mode is left out of the PATCH too (the same refusal)', async () => {
    const { state, patch } = await render(['documentProcessing.mode']);
    await state.savePipe('pipe-documents');
    expect(body(patch)).not.toHaveProperty('mode');
    expect(body(patch)['renderDpi']).toBe(150);
  });
});
