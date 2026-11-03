/**
 * The Pipelines tab's steps say what they will do, in words and for every reader (Q-64).
 *
 * The Validate step of the document pipeline has `health: null`, which the dot draws as "unknown": a grey bead that says "we could not tell" about a step
 * that has no endpoint to ask and nothing to be unwell. It is in-process arithmetic, exactly like the video splitter and the text chunker, which say `ok`.
 * `ok` on those steps means "needs no endpoint", and the docblock above `documentSteps` says so too. And a step the chosen mode does not run is only
 * DIMMED (opacity .42), which a screen reader and a reader with low contrast never see: a dimmed step carries its own text, "will not run".
 *
 * Rendered over the REAL state service and the shipped dictionaries, so what is asserted is what the page says, in en, de and pl.
 *
 *  - Validate reports `ok` in every mode, as the splitter and the chunker do;
 *  - every dimmed step (document and media pipelines alike) has a screen-reader text saying it will not run, and a running step has none;
 *  - Validate follows the VLM steps: when the mode needs a vision model and none is set, `stageClass('validate')` warns with `render`, `vlm` and `repair`;
 *  - the actors that were English literals in the component ('in-process', 'text chunker') are words of the language.
 */
import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { dictionary } from '../../../testing/i18n-dictionary';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';
import { PipelinesTabComponent } from './pipelines-tab.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';

function cfg(documentProcessing: Record<string, unknown>, levels?: Record<string, string>) {
  return {
    visionProvider: 'local', sttProvider: 'local',
    vision: { baseUrl: 'http://ollama:11434', model: 'llava', apiKey: '' },
    stt: { baseUrl: 'http://whisper:9000', model: 'base', apiKey: '' },
    embedding: { provider: 'local', model: 'nomic-embed-text-v1.5', dimensions: 768, similarity: 'cosine' },
    documentProcessing: { renderDpi: 150, maxPages: 50, pageTimeoutMs: 60000, concurrency: 2, ocrTimeoutMs: 120000, repairModel: '', ocrUrl: 'http://unstructured:8000', assistModel: { baseUrl: '', model: '', uses: [], apiKey: '' }, ...documentProcessing },
    fallbackToExternal: false, maxFileSizeBytes: 524288000, workerConcurrency: 2, lockedByInfra: [],
    ...(levels ? { levels } : {}),
  };
}

const status = {
  status: () => null, error: () => null, loading: () => false,
  modelState: () => 'ok', modelDetail: () => null, sidecarState: () => 'ok', sidecarDetail: () => null,
};

function mount(config: Record<string, unknown>, language: 'en' | 'de' | 'pl' = 'en') {
  TestBed.resetTestingModule();
  const http = { get: vi.fn().mockReturnValue(of(config)), patch: vi.fn(), post: vi.fn() } as unknown as HttpClient;
  TestBed.configureTestingModule({
    imports: [PipelinesTabComponent, getTranslocoModule({ translation: { en: dictionary(language) } })],
    providers: [
      MediaProcessingStateService,
      { provide: HttpClient, useValue: http },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      { provide: PipelineStatusService, useValue: status },
    ],
  });
  TestBed.inject(MediaProcessingStateService).load();
  const fixture = TestBed.createComponent(PipelinesTabComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const step = (nameKey: string) => [...el.querySelectorAll<HTMLElement>('.step')].find(s => s.querySelector('.nm')?.textContent?.trim().startsWith(dictionary(language)[nameKey]!));
  return { fixture, el, c: fixture.componentInstance, s: TestBed.inject(MediaProcessingStateService), step };
}

const MODES = ['off', 'ocr', 'vlm', 'repair', 'auto'] as const;

/** The Documents pipeline's card (the page draws Text first, then Documents, then the other media), found by its heading in English. */
function documentsCard(el: HTMLElement): HTMLElement {
  const heading = dictionary('en')['mediaProcessing.pipelines.documents']!;
  const card = [...el.querySelectorAll<HTMLElement>('.pipe-card')].find(c => c.querySelector('h3')?.textContent?.trim() === heading);
  if (!card) throw new Error('the Documents pipeline card was not found by its heading');
  return card;
}

describe('Validate reports `ok`: it needs no endpoint, like the splitter and the chunker (Q-64)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the step is `ok` in every mode, not `null` (drawn "unknown")', () => {
    for (const mode of MODES) {
      const { c } = mount(cfg({ mode, vlmModel: 'llava' }));
      expect(c.documentSteps().find(s => s.key === 'validate')?.health, mode).toBe('ok');
    }
  });

  it('its dot reads "ok" to a screen reader, not "unknown"', () => {
    const { step } = mount(cfg({ mode: 'vlm', vlmModel: 'llava' }));
    const dot = step('mediaProcessing.step.validate')!.querySelector('app-health-dot .dot')!;
    expect(dot.getAttribute('aria-label')).toBe(`${dictionary('en')['mediaProcessing.step.validate']}: ${dictionary('en')['mediaProcessing.health.ok']}`);
  });

  it('the docblock says what `ok` means for a step with no endpoint (the stale "no dot to report" comment is gone)', () => {
    const src = readFileSync('src/app/pages/settings/media-processing/pipelines-tab.component.ts', 'utf8');
    expect(src, 'validate no longer has `health: null`').not.toMatch(/key: 'validate'[^}]*health: null/);
    expect(src, 'the old claim that validate has no dot').not.toMatch(/so it has no\s+\/\/ endpoint and therefore no dot to report/);
  });
});

describe('a step that will not run says so in words (Q-64)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const willNotRun = (language: 'en' | 'de' | 'pl') => ({
    en: /will not run/i, de: /(?:wird )?nicht ausgeführt|läuft nicht/i, pl: /nie (?:zostanie )?uruchomion|nie działa|nie będzie/i,
  })[language];

  /** What a screen reader reads of a step beyond its name: sr-only text and the description. */
  const spoken = (step: HTMLElement): string => [
    ...[...step.querySelectorAll('.sr-only')].map(e => e.textContent ?? ''),
    step.getAttribute('aria-description') ?? '',
    ...[...step.querySelectorAll('[aria-description]')].map(e => e.getAttribute('aria-description') ?? ''),
  ].join(' ').trim();

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: every dimmed document step carries the words "will not run", and a running step carries none`, () => {
      const { el } = mount(cfg({ mode: 'ocr' }), language);
      const dimmed = [...el.querySelectorAll<HTMLElement>('.chain .step.dim')];
      const running = [...el.querySelectorAll<HTMLElement>('.chain .step:not(.dim)')];
      expect(dimmed.length, 'OCR mode dims render, vision, validate, repair and verify').toBeGreaterThanOrEqual(4);
      for (const s of dimmed) expect(spoken(s), s.textContent ?? '').toMatch(willNotRun(language));
      for (const s of running) expect(spoken(s), s.textContent ?? '').not.toMatch(willNotRun(language));
    });
  }

  it('the whole pipeline off: every document step says it will not run, with no raw key among the words', () => {
    const { el } = mount(cfg({ mode: 'off' }));
    const steps = [...documentsCard(el).querySelectorAll<HTMLElement>('.chain .step')];
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (const s of steps) {
      expect(spoken(s)).toMatch(/will not run/i);
      expect(spoken(s)).not.toMatch(/mediaProcessing\./);
    }
  });

  it('a dimmed MEDIA step does too (the fix is for every dimmed step, not only Validate)', () => {
    const { el } = mount(cfg({ mode: 'auto', vlmModel: 'llava' }, { images: 'off', audio: 'off', video: 'off', text: 'embed' }));
    const documents = documentsCard(el);
    const media = [...el.querySelectorAll<HTMLElement>('.step.dim')].filter(s => !documents.contains(s));
    expect(media.length, 'images, audio and video at `off` dim their steps').toBeGreaterThanOrEqual(4);
    for (const s of media) expect(spoken(s), s.textContent ?? '').toMatch(/will not run/i);
  });
});

describe('Validate follows the VLM steps when the vision model is missing (Q-64)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('vlm / repair / auto without a vision model: validate warns with render, vlm and repair', () => {
    for (const mode of ['vlm', 'repair', 'auto'] as const) {
      const { s } = mount(cfg({ mode, vlmModel: '' }));
      expect(s.vlmNeededButMissing(), mode).toBe(true);
      // `repair` is warned only in the modes that run it; in `vlm` the mode dims it (the one rule `stageClass` already has).
      for (const key of mode === 'vlm' ? ['render', 'vlm', 'validate'] : ['render', 'vlm', 'repair', 'validate']) {
        expect(s.stageClass(key), `${mode}: ${key}`).toBe('warn');
      }
    }
  });

  it('with the vision model set, validate is on, as the VLM steps are', () => {
    const { s } = mount(cfg({ mode: 'vlm', vlmModel: 'llava' }));
    expect(s.vlmNeededButMissing()).toBe(false);
    expect(s.stageClass('validate')).toBe('on');
  });

  it('where the mode does not run validate (ocr, off) it stays dim, with or without a model', () => {
    for (const mode of ['ocr', 'off'] as const) {
      expect(mount(cfg({ mode, vlmModel: '' })).s.stageClass('validate'), mode).toBe('dim');
    }
  });
});

describe('the actors the component spelled in English are words of the language (Q-64)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const actorOf = (step: HTMLElement | undefined): string => (step?.querySelector('.actor')?.textContent ?? '').trim();

  it('de and pl: Validate and Chunk do not say "in-process" and "text chunker"', () => {
    for (const language of ['de', 'pl'] as const) {
      const page = mount(cfg({ mode: 'vlm', vlmModel: 'llava' }), language);
      const validate = actorOf(page.step('mediaProcessing.step.validate'));
      const chunk = actorOf(page.step('mediaProcessing.step.chunk'));
      expect(validate, `${language} validate actor`).not.toBe('');
      expect(validate, `${language} validate actor`).not.toBe('in-process');
      expect(validate, `${language} validate actor`).not.toMatch(/mediaProcessing\./);
      expect(chunk, `${language} chunk actor`).not.toBe('');
      expect(chunk, `${language} chunk actor`).not.toBe('text chunker');
      expect(chunk, `${language} chunk actor`).not.toMatch(/mediaProcessing\./);
    }
  });

  it('en says them, from the dictionary', () => {
    const page = mount(cfg({ mode: 'vlm', vlmModel: 'llava' }));
    expect(actorOf(page.step('mediaProcessing.step.validate'))).toMatch(/in-process/i);
    expect(actorOf(page.step('mediaProcessing.step.chunk'))).toMatch(/chunker/i);
  });
});
